import { chromium, expect } from "@playwright/test";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import axios from "axios";

// Isolated browser regression: never contacts a live courier or database.
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = "http://127.0.0.1:4021";
process.env.BOOTSTRAP_SUPER_ADMIN_NAME = "Delivery QA";
process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL = "delivery-qa@example.test";
process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD = "delivery-test-password";
process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY = "b1".repeat(32);
process.env.ABEX_WRITES_ENABLED = "true";
const replica = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
});
let browser, server, courier;
const createClient = axios.create;
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
  await LogixProduct.create({
    name: "Test product",
    price: 1000,
  });
  const { migrate } = await import("../server/src/migrate.js");
  await migrate();
  const workflowId = "f0e00000-0000-4000-8000-000000000005";
  const preparingId = "f0e00000-0000-4000-8000-000000000006";
  const readyId = "f0e00000-0000-4000-8000-000000000007";
  const cityTerritoryId = "f0e00000-0000-4000-8000-000000000002";
  const districtTerritoryId = "f0e00000-0000-4000-8000-000000000003";
  let mode = "success",
    calls = 0,
    readinessCalls = 0,
    parcel;
  courier = createServer(async (req, res) => {
    assert.equal(req.headers["x-api-key"], "browser-abex-key");
    assert.equal(req.headers["x-tenant"], "browser-abex-tenant");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/v1/territories/search") {
      assert.equal(req.method, "POST");
      const filter = data.advancedFilter;
      assert.equal(filter.operator, "eq");
      if (filter.field === "code") assert.equal(filter.value, 16);
      else
        assert.deepEqual(filter, {
          field: "parentId",
          operator: "eq",
          value: cityTerritoryId,
        });
      const row =
        filter.field === "code"
          ? { id: cityTerritoryId, level: "wilaya", code: 16, name: "Alger" }
          : {
              id: districtTerritoryId,
              level: "commune",
              name: "Alger Centre",
              parentId: cityTerritoryId,
              delivery: { hasHomeDelivery: true },
            };
      return reply(200, {
        pageNumber: data.pageNumber,
        pageSize: data.pageSize,
        totalCount: 1,
        hasNext: false,
        items: [row],
      });
    }
    if (req.url === "/api/v1/workflows/search") {
      assert.equal(req.method, "POST");
      return reply(200, {
        pageNumber: data.pageNumber,
        pageSize: data.pageSize,
        totalCount: 1,
        hasNext: false,
        items: [
          {
            id: workflowId,
            states: [
              {
                id: preparingId,
                transitions: [{ fromStateId: preparingId, toStateId: readyId }],
              },
              { id: readyId, requirements: [] },
            ],
          },
        ],
      });
    }
    if (req.method === "GET" && req.url === "/api/v1/parcels/BROWSER-1")
      return reply(200, parcel);
    if (req.method === "PATCH") {
      assert.equal(req.url, `/api/v1/parcels/${parcel.id}/state`);
      assert.deepEqual(data, { parcelId: parcel.id, newStateId: readyId });
      readinessCalls++;
      parcel.state = { id: readyId, name: "Test ready" };
      parcel.lastStateUpdateAt = "2026-10-01T10:01:00Z";
      return reply(200, data);
    }
    assert.equal(req.url, "/api/v1/parcels");
    assert.equal(req.method, "POST");
    assert.equal(data.deliveryAddress.cityTerritoryId, cityTerritoryId);
    assert.equal(data.deliveryAddress.districtTerritoryId, districtTerritoryId);
    assert.equal(data.customer.phone.number1, "+213550123456");
    assert.deepEqual(data.orderedProducts, [
      { productName: "Test product", quantity: 1, unitPrice: 0, stockType: "none" },
    ]);
    assert.equal(data.description, "--");
    calls++;
    const parcelId = `f0e00000-0000-4000-8000-${String(calls).padStart(12, "0")}`;
    if (mode === "error")
      return reply(422, { message: "Invalid courier parcel" });
    const created = {
      id: parcelId,
      externalId: data.externalId,
      trackingNumber: mode === "success" ? `BROWSER-${calls}` : null,
    };
    if (mode === "success")
      parcel = {
        ...created,
        state: { id: preparingId, name: "Test preparation" },
        lastStateUpdateAt: "2026-10-01T10:00:00Z",
      };
    return reply(201, created);
  });
  await new Promise((resolve) => courier.listen(0, "127.0.0.1", resolve));
  axios.create = (options) =>
    createClient(
      options.baseURL === "https://app.abex.clawdyatms.app"
        ? { ...options, baseURL: `http://127.0.0.1:${courier.address().port}` }
        : options,
    );
  await DeliveryAgency.updateOne(
    { code: "ABEX" },
    {
      "config.abex": {
        states: [
          { workflowId, stateId: preparingId, status: "PREPARING" },
          { workflowId, stateId: readyId, status: "READY_TO_SHIP" },
        ],
      },
      encryptedCredentials: encryptCredentials({
        apiKey: "browser-abex-key",
        tenantId: "browser-abex-tenant",
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
    } else {
      await expect(
        page.getByRole("combobox", { name: "Commune *", exact: true }),
      ).toHaveValue("Alger Centre");
      await expect(
        page.getByText(
          /Saving this order automatically creates a courier parcel/,
        ),
      ).toBeVisible();
    }
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
      const order = await Order.findOne({
        "customer.name": "Delivery success",
      });
      await Order.updateOne(
        { _id: order._id },
        { "tracking.stage": "AT_PRODUCTION" },
      );
      await page
        .getByRole("button", { name: "Refresh tracking", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Mark ready to ship", exact: true })
        .click();
      await expect
        .poll(async () => (await Order.findById(order._id)).tracking.stage)
        .toBe("READY_TO_SHIP");
      assert.equal(readinessCalls, 1);
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
            ? "Shipment awaiting verification"
            : "Shipment synchronization failed",
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
    "Delivery browser checks passed: ABEX creation, confirmed readiness, pending and rejected parcels, and manual delivery.",
  );
} finally {
  axios.create = createClient;
  await browser?.close();
  for (const http of [server, courier])
    if (http) {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    }
  await mongoose.disconnect();
  await replica.stop();
}
