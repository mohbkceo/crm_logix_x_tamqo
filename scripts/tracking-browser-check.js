import { chromium, expect } from "@playwright/test";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import sharp from "sharp";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = "http://127.0.0.1:4023";
const media = await mkdtemp(path.join(os.tmpdir(), "crm-tracking-browser-"));
process.env.MEDIA_STORAGE_DIR = media;
const replica = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
});
await mongoose.connect(replica.getUri("tracking_browser_only"));
const { app } = await import("../server/src/app.js");
const { User } = await import("../server/src/models/security.js");
const { Order, LogixProduct, OrderSource, Wilaya, Shipment } =
  await import("../server/src/models/index.js");
const { DeliveryAgency, DeliveryRate } =
  await import("../server/src/models/delivery.js");
const { TrackingIssue, TrackingSetting } =
  await import("../server/src/models/tracking.js");
const { migrateTracking } =
  await import("../server/src/services/trackingMigration.js");
const { P } = await import("../shared/permissions.js");
await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
await migrateTracking();
await LogixProduct.create({ name: "20cm Plaque", price: 3500 });
await OrderSource.create({ name: "Messages", isDefault: true });
const wilaya = await Wilaya.create({
  name: "Alger",
  agencyId: "16",
  homeShippingPrice: 500,
  deskShippingPrice: 300,
});
const agency = await DeliveryAgency.create({
  code: "BROWSER_MANUAL",
  name: "Local delivery",
  integrationType: "MANUAL",
  apiProvider: "MANUAL",
  businesses: ["LOGIX"],
  capabilities: { createShipment: true },
});
await DeliveryRate.create({
  agencyId: agency._id,
  wilayaId: wilaya._id,
  homePrice: 500,
  deskPrice: 300,
});
const password = "tracking-browser-password",
  passwordHash = await bcrypt.hash(password, 4);
const reportPermissions = [
  P.tracking.view,
  P["tracking.issue"].view,
  P["tracking.issue"].create,
  P["tracking.issue"].resolve,
];
for (const [name, role, operationalRoles, permissions] of [
  ["admin", "SUPER_ADMIN", [], []],
  [
    "sales",
    "EMPLOYEE",
    ["SALES_CONFIRMATION"],
    [
      ...reportPermissions,
      P.orders.create,
      P.orders.viewOwn,
      P.orders.updateOwn,
    ],
  ],
  [
    "designer",
    "EMPLOYEE",
    ["DESIGNER"],
    [
      ...reportPermissions,
      P.tracking.moveToProduction,
      P.tracking.moveToPreparing,
      P["tracking.contacts"].view,
    ],
  ],
  [
    "production",
    "EMPLOYEE",
    ["PRODUCTION"],
    [
      ...reportPermissions,
      P.tracking.markReady,
      P.tracking.revertReady,
      P.tracking.bulkUpdate,
    ],
  ],
])
  await User.create({
    name,
    email: `${name}@tracking.test`,
    role,
    operationalRoles,
    permissions,
    businessAccess: ["LOGIX"],
    whatsappPhone: "+213770987654",
    passwordHash,
  });
const server = await new Promise((resolve) => {
  const s = app.listen(4023, "127.0.0.1", () => resolve(s));
});
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage(),
  errors = [],
  failedRequests = [],
  courierCalls = [];
page.setDefaultTimeout(15000);
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("response", (r) => {
  if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
});
page.on("request", (r) => {
  if (/\/shipment\/(ready|refresh)|\/pret|\/add_colis/.test(r.url()))
    courierCalls.push(r.url());
});
const output = path.resolve(".local/qa/tracking");
await mkdir(output, { recursive: true });
async function goto(route) {
  await page.goto("http://127.0.0.1:4023" + route);
  await page.locator("h1").waitFor();
  await page.getByText("Loading workspace data…").waitFor({ state: "hidden" });
}
async function login(name) {
  await context.clearCookies();
  await goto("/tracking");
  await page.getByLabel("Email", { exact: true }).fill(`${name}@tracking.test`);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Tracking", exact: true }).waitFor();
  await page.getByText("Loading workspace data…").waitFor({ state: "hidden" });
}
try {
  await login("sales");
  await page.getByRole("link", { name: "Tracking", exact: true }).waitFor();
  await goto("/orders/new");
  await page.getByLabel("Customer name *").fill("Browser Tracking Customer");
  await page.getByLabel("Phone A *").fill("0550123456");
  await page.getByLabel("Wilaya *").selectOption({ label: "Alger" });
  await page.getByLabel("Commune *").fill("Alger Centre");
  await page.getByLabel("Address *").fill("12 Test Avenue");
  await page.locator(".business-selection input").check();
  await page
    .getByLabel("Delivery agency", { exact: true })
    .selectOption({ label: "Local delivery" });
  await page
    .getByLabel("Specifications", { exact: true })
    .fill("Blue 20cm, engraved name");
  const image = await sharp({
    create: { width: 80, height: 80, channels: 3, background: "#dceefa" },
  })
    .png()
    .toBuffer();
  await page
    .getByLabel("Order images (optional)")
    .setInputFiles({
      name: "design.png",
      mimeType: "image/png",
      buffer: image,
    });
  await page.getByRole("button", { name: "Create order", exact: true }).click();
  await page.waitForURL(/\/orders\/[a-f0-9]{24}$/);
  const saved = await Order.findOne({
    "customer.name": "Browser Tracking Customer",
  });
  assert.equal(saved.images.length, 1);
  assert.equal(saved.status, "NEW");
  assert.equal(saved.tracking.stage, "PREPARING");
  await goto("/tracking");
  const row = page.getByRole("article", {
    name: saved.orderNumber,
    exact: true,
  });
  await row.waitFor();
  await expect(
    row.getByRole("button", {
      name: `${saved.orderNumber}: Preparing`,
      exact: true,
    }),
  ).toBeDisabled();
  await login("designer");
  const moveToProduction = `${saved.orderNumber}: Preparing → At Production`;
  await page
    .getByRole("button", { name: moveToProduction, exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Moved to At Production" })
    .waitFor();
  await page
    .getByLabel("Production stage", { exact: true })
    .selectOption("AT_PRODUCTION");
  await page
    .getByRole("button", {
      name: `${saved.orderNumber}: At Production → Preparing`,
      exact: true,
    })
    .click();
  await page
    .getByLabel("Production stage", { exact: true })
    .selectOption("PREPARING");
  await page
    .getByRole("button", { name: moveToProduction, exact: true })
    .waitFor();
  await row.getByRole("button", { name: "Report", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Issue Type", { exact: true })
    .selectOption({ label: "Other" });
  assert.equal(await dialog.getByRole("radio").count(), 3);
  await dialog.getByLabel("Information", { exact: true }).check();
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await row.getByRole("button", { name: /1 open report/ }).click();
  await dialog.getByText(/Reported by designer/).waitFor();
  await expect(
    dialog.getByRole("link", { name: "Contact Reporter" }),
  ).toHaveAttribute("href", "https://wa.me/213770987654");
  await dialog.getByRole("button", { name: "Resolve", exact: true }).click();
  await dialog.getByText(/Resolved by designer/).waitFor();
  assert.equal(await dialog.getByRole("textbox").count(), 0);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: moveToProduction, exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Moved to At Production" })
    .waitFor();
  await login("production");
  await row.waitFor();
  await page
    .getByRole("button", {
      name: `${saved.orderNumber}: At Production → Ready to Ship`,
      exact: true,
    })
    .click();
  await page
    .getByLabel("Production stage", { exact: true })
    .selectOption("READY_TO_SHIP");
  await page
    .getByRole("checkbox", { name: `Select ${saved.orderNumber}`, exact: true })
    .check();
  await page
    .getByRole("button", { name: "Return to production", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Bulk operation completed" })
    .waitFor();
  await page
    .getByLabel("Production stage", { exact: true })
    .selectOption("AT_PRODUCTION");
  await row.waitFor();
  await page.screenshot({
    path: path.join(output, "desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await row.waitFor();
  await expect
    .poll(
      async () =>
        (await page.locator(".sidebar").boundingBox()).x +
        (await page.locator(".sidebar").boundingBox()).width,
    )
    .toBeLessThanOrEqual(0);
  await page.screenshot({
    path: path.join(output, "mobile.png"),
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Tracking must not overflow mobile viewport",
  );
  assert.equal(
    await row
      .getByRole("button", { name: /At Production → Preparing/ })
      .count(),
    0,
  );
  await row.getByLabel(`More actions for ${saved.orderNumber}`).click();
  await expect(
    row.getByText("Contact permission required").first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login("admin");
  await goto("/settings");
  await page.getByRole("link", { name: "Tracking · Issue Types" }).click();
  await page
    .getByRole("heading", { name: "Tracking settings", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Create issue type", exact: true })
    .click();
  await dialog.getByLabel("Label", { exact: true }).fill("Artwork correction");
  await dialog.getByLabel("Blocks production until resolved").check();
  await dialog
    .getByRole("button", { name: "Save issue type", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByText("Artwork correction", { exact: true }).waitFor();
  await page
    .getByLabel("Require WhatsApp on registration and profile completion")
    .check();
  await page
    .getByRole("button", { name: "Save tracking settings", exact: true })
    .click();
  await expect
    .poll(
      async () => (await TrackingSetting.findById("tracking")).requireWhatsApp,
    )
    .toBe(true);
  await goto("/settings/profile");
  await page
    .getByRole("button", { name: "Save profile", exact: true })
    .waitFor();
  assert.equal((await TrackingIssue.findOne()).status, "RESOLVED");
  assert.equal((await Order.findById(saved._id)).status, "NEW");
  assert.equal(await Shipment.countDocuments(), 0);
  assert.deepEqual(courierCalls, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(failedRequests, []);
  console.log(
    "Tracking browser passed: sales creation with image; Designer toggle; unified report and one-click resolve; Production single and bulk; role visibility; desktop/mobile; settings and profile; no console/API errors or courier requests.",
  );
  console.log(`Screenshots: ${output}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await replica.stop();
  if (media.startsWith(path.join(os.tmpdir(), "crm-tracking-browser-")))
    await rm(media, { recursive: true, force: true });
}
