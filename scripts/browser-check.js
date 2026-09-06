import { chromium } from "@playwright/test";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = "http://127.0.0.1:4019";
process.env.BOOTSTRAP_SUPER_ADMIN_NAME = "Browser Test Admin";
process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL = "browser-admin@example.test";
process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD = "browser-test-password";
process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY =
  "62872aa67a9089f1a034a87c56fd5db94ab6e16a7fe2a2db3ac206b2860344ad";
const replica = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
});
await mongoose.connect(replica.getUri("browser_check"));
const { seed } = await import("../server/src/seed.js");
await seed();
const { migrate } = await import("../server/src/migrate.js");
await migrate();
const { app } = await import("../server/src/app.js");
const server = await new Promise((resolve) => {
  const s = app.listen(4019, "127.0.0.1", () => resolve(s));
});
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }),
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(15000);
const output = path.resolve(".local/qa");
await mkdir(output, { recursive: true });
async function goto(route) {
  await page.goto("http://127.0.0.1:4019" + route);
  await page.locator("h1").waitFor();
  await page.getByText("Loading workspace data…").waitFor({ state: "hidden" });
}
try {
  await page.goto("http://127.0.0.1:4019/");
  await page.getByLabel("Email").fill(process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL);
  await page
    .getByLabel("Password")
    .fill(process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("Connected workspace").waitFor();
  for (const [route, heading] of [
    ["/settings/users", "Users"],
    ["/settings/agencies", "Delivery agencies"],
    ["/settings/registration", "Registration security"],
    ["/settings/audit", "Audit log"],
    ["/team", "Employee performance"],
  ]) {
    await goto(route);
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
  }
  await goto("/");
  await page.getByText("Your sales story starts here").waitFor();
  await page.screenshot({
    path: path.join(output, "overview-empty.png"),
    fullPage: true,
  });
  await goto("/orders/new");
  await page.getByLabel("Customer name *").fill("Browser QA Customer");
  await page.getByLabel("Phone A *").fill("0550 12 34 56");
  await page.getByLabel("Wilaya *").selectOption({ label: "Alger" });
  await page.getByLabel("Commune *").fill("Alger Centre");
  await page.getByLabel("Address *").fill("12 Test Avenue");
  await page.locator(".business-selection input").nth(0).check();
  await page
    .getByLabel("Plan", { exact: true })
    .selectOption({ label: "3 Months" });
  await page.locator(".business-selection input").nth(1).check();
  await page.getByLabel("Delivery agency").selectOption({ label: "ABEX" });
  await page.getByLabel("Quantity", { exact: true }).nth(1).fill("2");
  await page
    .getByLabel("Payment method", { exact: true })
    .selectOption("MIXED");
  await page.getByLabel("Amount paid online (DA)").fill("11000");
  assert.equal(
    await page.locator(".order-summary .summary-total b").innerText(),
    "11,500 DA",
  );
  assert.equal(
    await page.locator(".order-summary .collection b").innerText(),
    "500 DA",
  );
  await page.screenshot({
    path: path.join(output, "partnership-form.png"),
    fullPage: true,
  });
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/orders") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create order", exact: true }).click();
  const order = await (await saved).json();
  assert.equal(order.businessType, "PARTNERSHIP");
  assert.equal(order.productRevenue, 11000);
  assert.equal(order.payment.amountToCollect, 500);
  await page.waitForURL("**/orders/" + order._id);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("button", { name: "Prepare", exact: true }).waitFor();
  await page.getByRole("button", { name: "Prepare", exact: true }).click();
  await page
    .getByRole("button", { name: "Mark ready to ship", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Mark ready to ship", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Mark Shipped", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Mark Shipped", exact: true }).click();
  await page
    .getByRole("button", { name: "Mark Delivered", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Mark Delivered", exact: true })
    .click();
  await page.getByText("SHIPPED → DELIVERED", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Record courier collection", exact: true })
    .click();
  await page.getByLabel("Total collected by courier (DA)").fill("500");
  await page
    .getByRole("button", { name: "Save collection", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.screenshot({
    path: path.join(output, "order-details.png"),
    fullPage: true,
  });
  await goto("/tamqo");
  await page.getByRole("button", { name: "Customers", exact: true }).click();
  await page.getByText("Browser QA Customer", { exact: true }).waitFor();
  for (const tab of [
    "Order performance",
    "Products & plans",
    "Sources",
    "Geography",
    "Payments",
    "Delivery",
    "Timing",
  ]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    assert.equal(await page.locator(".error").count(), 0, tab);
  }
  await goto("/tamqo/expenses");
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("QA Hosting");
  await page.getByLabel("Amount (DA)", { exact: true }).fill("500");
  await page.getByRole("button", { name: "Save expense", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("QA Hosting", { exact: true }).waitFor();
  await page.getByTitle("Edit expense", { exact: true }).click();
  await page.getByLabel("Amount (DA)", { exact: true }).fill("750");
  await page.getByRole("button", { name: "Save expense", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("750 DA", { exact: true }).first().waitFor();
  await page.getByLabel("Search expenses").fill("unmatched");
  await page.getByText("No records match this view.").first().waitFor();
  await page.getByLabel("Search expenses").fill("");
  await page.getByText("QA Hosting", { exact: true }).waitFor();
  await goto("/logix/expenses");
  assert.equal(await page.getByText("QA Hosting", { exact: true }).count(), 0);
  await goto("/settings");
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("QA Annual");
  await page.getByLabel("Price (DA)", { exact: true }).fill("9000");
  await page.getByLabel("Duration Days", { exact: true }).fill("365");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("QA Annual", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Order sources", exact: true })
    .click();
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("QA Website");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Make default", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: "QA Website" })
    .getByText("Default", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Wilayas & shipping", exact: true })
    .click();
  await page
    .getByRole("row")
    .filter({ hasText: "Alger" })
    .getByTitle("Edit configuration")
    .click();
  await page
    .getByLabel("Home Shipping Price (DA)", { exact: true })
    .fill("550");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("550 DA", { exact: true }).waitFor();
  await goto("/customers");
  await page.getByRole("button", { name: "View orders", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByText(order.orderNumber, { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await goto("/orders");
  await page.getByLabel("Business filter").selectOption("PARTNERSHIP");
  await page.getByText(order.orderNumber, { exact: true }).waitFor();
  await page.getByRole("button", { name: "More filters", exact: true }).click();
  await page.getByLabel("Commune", { exact: true }).fill("unmatched");
  await page.getByText("No records match this view.").first().waitFor();
  await goto("/partnership");
  await page.screenshot({
    path: path.join(output, "partnership-analytics.png"),
    fullPage: true,
  });
  await goto("/");
  await page.screenshot({
    path: path.join(output, "overview-populated.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await goto("/");
  await page.screenshot({
    path: path.join(output, "mobile-overview.png"),
    fullPage: true,
  });
  const width = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    main: document.querySelector(".main-shell").getBoundingClientRect().width,
    metric: document.querySelector(".metric").getBoundingClientRect().width,
  }));
  assert.ok(width.document <= width.viewport + 1, JSON.stringify(width));
  assert.ok(width.main >= 380 && width.metric >= 160, JSON.stringify(width));
  assert.deepEqual(errors, []);
  console.log(
    "Browser verification passed: order creation, fulfillment, collection, analytics tabs, expense CRUD/filtering, business isolation, catalog/source/shipping configuration, customer history, order filters, mobile layout.",
  );
  console.log("Screenshots: " + output);
} catch (error) {
  await page.screenshot({
    path: path.join(output, "failure.png"),
    fullPage: true,
  });
  console.error((await page.locator("body").innerText()).slice(-5000));
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await replica.stop();
}
