import { chromium, expect } from "@playwright/test";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createServer } from "node:http";
import assert from "node:assert/strict";

// Isolated browser regression: never contacts a live courier or database.
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = "http://127.0.0.1:4021";
process.env.BOOTSTRAP_SUPER_ADMIN_NAME = "Delivery QA";
process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL = "delivery-qa@example.test";
process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD = "delivery-test-password";
process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY = "b1".repeat(32);
const replica = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
});
let browser, server, courier;
try {
  await mongoose.connect(replica.getUri("delivery_browser_check"));
  const { seed } = await import("../server/src/seed.js");
  const { OrderSource, LogixProduct, Order, Shipment } =
    await import("../server/src/models/index.js");
  const { DeliveryAgency } = await import("../server/src/models/delivery.js");
  const { encryptCredentials } =
    await import("../server/src/services/delivery/credentials.js");
  await seed();
  await OrderSource.create({ name: "Messages", isDefault: true });
  await LogixProduct.create({ name: "Test product", price: 1000 });
  const { migrate } = await import("../server/src/migrate.js");
  await migrate();
  let mode = "success",
    calls = 0;
  courier = createServer((req, res) => {
    req.resume();
    calls++;
    res.writeHead(mode === "error" ? 400 : 200, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify(
        mode === "success"
          ? { Tracking: `BROWSER-${calls}` }
          : mode === "error"
            ? { message: "Invalid courier parcel" }
            : { received: true },
      ),
    );
  });
  await new Promise((resolve) => courier.listen(0, "127.0.0.1", resolve));
  await DeliveryAgency.updateOne(
    { code: "ABEX" },
    {
      "config.baseUrl": `http://127.0.0.1:${courier.address().port}`,
      encryptedCredentials: encryptCredentials({
        token: "browser-token",
        key: "browser-key",
      }),
      credentialsConfigured: true,
    },
  );
  await DeliveryAgency.create({
    name: "Manual QA",
    code: "MANUAL_QA",
    businesses: ["LOGIX"],
    integrationType: "MANUAL",
    apiProvider: "MANUAL",
    capabilities: { createShipment: true, tracking: true },
  });
  const { app } = await import("../server/src/app.js");
  server = await new Promise((resolve) => {
    const s = app.listen(4021, "127.0.0.1", () => resolve(s));
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.CLIENT_URL);
  await page.getByLabel("Email").fill(process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL);
  await page
    .getByLabel("Password")
    .fill(process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("Connected workspace").waitFor();
  for (const outcome of ["success", "pending", "error", "manual"]) {
    mode = outcome;
    await page.goto(process.env.CLIENT_URL + "/orders/new");
    await page.getByLabel("Customer name *").fill(`Delivery ${outcome}`);
    await page.getByLabel("Phone A *").fill("0550123456");
    await page.getByLabel("Wilaya *").selectOption({ label: "Alger" });
    await page.getByLabel("Commune *").fill("Alger Centre");
    await page.getByLabel("Address *").fill("12 Test Street");
    await page.locator(".business-selection input").last().check();
    await page
      .getByLabel("Delivery agency", { exact: true })
      .selectOption({ label: outcome === "manual" ? "Manual QA" : "ABEX" });
    if (outcome === "manual") {
      // Agency without rates needs the existing delivery override field.
      await page.getByLabel("Delivery cost (DA)", { exact: true }).fill("500");
      await expect(
        page.getByText("Save this order, then handle its shipment manually."),
      ).toBeVisible();
    } else
      await expect(
        page.getByText(
          /Saving this order automatically creates a courier parcel/,
        ),
      ).toBeVisible();
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/orders") && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Create order", exact: true })
      .click();
    assert.equal((await response).status(), 201);
    await page.waitForURL(/\/orders\/[a-f0-9]{24}$/);
    if (outcome === "success") {
      await expect(
        page.getByText("Shipment synchronized", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "BROWSER-1" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Create shipment|Retry shipment/ }),
      ).toHaveCount(0);
    } else if (outcome === "manual") {
      await expect(
        page.getByText("No shipment has been created for this order."),
      ).toBeVisible();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await page
        .getByRole("button", { name: "Create shipment", exact: true })
        .click();
      await expect(
        page.getByText("Shipment synchronized", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Reconcile shipment", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "I verified that no parcel exists" }),
      ).toHaveCount(0);
      await page.getByLabel("Verified tracking number").fill("MANUAL-BROWSER");
      await page
        .getByRole("button", { name: "Link verified tracking" })
        .click();
      await expect(
        page.getByRole("heading", { name: "MANUAL-BROWSER" }),
      ).toBeVisible();
    } else {
      await expect(
        page.getByText(
          outcome === "pending"
            ? "Courier parcel awaiting verification"
            : "Courier synchronization failed",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Reconcile shipment", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Create shipment|Retry shipment/ }),
      ).toHaveCount(0);
    }
  }
  assert.equal(calls, 3);
  assert.equal(await Order.countDocuments(), 4);
  assert.equal(await Shipment.countDocuments(), 4);
  assert.deepEqual(errors, []);
  console.log(
    "Delivery browser checks passed: automatic success, pending, error, manual workflow, navigation and duplicate-prevention controls.",
  );
} finally {
  await browser?.close();
  for (const http of [server, courier])
    if (http) {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    }
  await mongoose.disconnect();
  await replica.stop();
}
