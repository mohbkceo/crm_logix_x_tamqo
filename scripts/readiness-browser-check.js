import { chromium, expect } from "@playwright/test";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.CLIENT_URL = "http://127.0.0.1:4026";
const replica = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
});
let browser, server;
try {
  await mongoose.connect(replica.getUri("readiness_browser_isolated"));
  const { app } = await import("../server/src/app.js");
  const { User } = await import("../server/src/models/security.js");
  const { LogixProduct, OrderSource, Wilaya, Order, Shipment } =
    await import("../server/src/models/index.js");
  const { DeliveryAgency, DeliveryRate } =
    await import("../server/src/models/delivery.js");
  const { createOrder } =
    await import("../server/src/services/orderService.js");
  const { migrateTracking } =
    await import("../server/src/services/trackingMigration.js");
  const { DeliveryClient } =
    await import("../server/src/services/delivery/deliveryClient.js");
  const { DeliverySyncService } =
    await import("../server/src/services/delivery/deliverySyncService.js");
  const { P } = await import("../shared/permissions.js");
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init()),
  );
  await migrateTracking();
  const employee = await User.create({
    name: "Production QA",
    email: "readiness@example.test",
    passwordHash: await bcrypt.hash("readiness-browser-password", 4),
    role: "EMPLOYEE",
    businessAccess: ["LOGIX"],
    operationalRoles: ["PRODUCTION"],
    permissions: [
      P.tracking.view,
      P.tracking.viewAll,
      P.tracking.markReady,
      P.tracking.revertReady,
    ],
  });
  const product = await LogixProduct.create({
    name: "Readiness fixture",
    price: 1000,
  });
  const source = await OrderSource.create({ name: "QA", isDefault: true });
  const wilaya = await Wilaya.create({
    name: "Alger",
    agencyId: "16",
    homeShippingPrice: 400,
    deskShippingPrice: 300,
  });
  const agency = await DeliveryAgency.create({
    code: "ABEX",
    name: "ABEX",
    integrationType: "API",
    apiProvider: "PROCOLIS",
    businesses: ["LOGIX"],
    capabilities: { createShipment: true, tracking: true, readyToShip: true },
  });
  await DeliveryRate.create({
    agencyId: agency._id,
    wilayaId: wilaya._id,
    homePrice: 400,
    deskPrice: 300,
  });
  const o = await createOrder(
    {
      customer: { name: "عميل اختبار الجاهزية", phoneA: "0550123456" },
      location: {
        wilayaId: String(wilaya._id),
        commune: "Alger",
        address: "12 Test Avenue",
      },
      items: [
        { business: "LOGIX", catalogItemId: String(product._id), quantity: 1 },
      ],
      sourceId: String(source._id),
      delivery: { agencyId: String(agency._id), type: "HOME" },
      payment: { method: "COD" },
    },
    { userId: employee._id, name: employee.name },
  );
  await Order.updateOne({ _id: o._id }, { "tracking.stage": "AT_PRODUCTION" });
  const shipment = await Shipment.create({
    orderId: o._id,
    agencyId: agency._id,
    tracking: "READINESS-BROWSER",
    status: "PREPARING",
    providerStatus: "En Préparation",
    syncStatus: "ERROR",
    lastError: "Test-only diagnostics",
  });
  let providerStatus = "En Préparation",
    readyCalls = 0;
  DeliveryClient.prototype.request = async () => {
    throw new Error("Real courier requests are forbidden in browser fixtures");
  };
  DeliveryClient.prototype.readyPackages = async (trackings) => {
    assert.deepEqual(trackings, [shipment.tracking]);
    readyCalls++;
    providerStatus = "En Traitement - Prêt à Expédie";
    return { Colis: [{ MessageRetour: "Good" }] }; // Actual symptom: no Tracking in /pret acknowledgement.
  };
  DeliveryClient.prototype.readPackages = async (trackings) => {
    assert.deepEqual(trackings, [shipment.tracking]);
    return {
      Colis: [
        {
          Tracking: shipment.tracking,
          Situation: providerStatus,
          id_Externe: o.orderNumber,
        },
      ],
    };
  };
  server = await new Promise((resolve) => {
    const handle = app.listen(4026, "127.0.0.1", () => resolve(handle));
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.CLIENT_URL + "/tracking");
  await page.getByLabel("Email", { exact: true }).fill(employee.email);
  await page
    .getByLabel("Password", { exact: true })
    .fill("readiness-browser-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "الطلبات", exact: true }).waitFor();
  await page.getByLabel("تصفية الطلبات", { exact: true }).click();
  await page.getByRole("button", { name: "مسح الفلاتر", exact: true }).click();
  await page.getByLabel("تصفية الطلبات", { exact: true }).click();
  const row = page.getByRole("article", { name: o.orderNumber, exact: true });
  await row.waitFor();

  const readyButton = row.getByRole("button", {
    name: "نقل طلب " + o.customer.name + " إلى جاهز للشحن",
    exact: true,
  });
  await expect(readyButton).toBeVisible();
  await expect(row.getByRole("checkbox")).toHaveCount(0);
  await expect(
    page.getByText("لم يُعيّن موظف داخلي", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("مزامنة شركة التوصيل تحتاج إلى متابعة", { exact: true }),
  ).toHaveCount(0);
  const output = path.resolve(".local/qa/readiness");
  await mkdir(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, "desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const box = await page.locator(".sidebar").boundingBox();
      return box.x + box.width;
    })
    .toBeLessThanOrEqual(0);
  await expect(row.locator(".tracking-stage-current")).toBeVisible();
  assert.equal(
    await row
      .locator(".tracking-stage")
      .evaluate((el) => getComputedStyle(el, "::before").content),
    "none",
  );
  await page.screenshot({
    path: path.join(output, "mobile.png"),
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await readyButton.click();
  await expect
    .poll(async () => (await Order.findById(o._id)).status)
    .toBe("READY_TO_SHIP");
  await expect(readyButton).toHaveCount(0);
  await row.getByLabel("الحالة الحالية: جاهز للشحن", { exact: true }).waitFor();
  const reversal = await page.evaluate(
    async ({ id, revision }) =>
      (
        await fetch("/api/tracking/" + id + "/readiness", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false, expectedRevision: revision }),
        })
      ).status,
    { id: String(o._id), revision: (await Order.findById(o._id)).revision },
  );
  assert.equal(reversal, 409);
  await new DeliverySyncService({}).apply(o._id, {
    tracking: shipment.tracking,
    providerStatus: "En Livraison",
    raw: {},
  });
  await page.getByRole("button", { name: "تحديث التتبع", exact: true }).click();
  await row
    .getByLabel("الحالة الحالية: قيد التوصيل", { exact: true })
    .waitFor();
  providerStatus = "Supprimée";
  const { deliveryService } =
    await import("../server/src/services/delivery/deliveryService.js");
  const run = await deliveryService.syncBatch({ trigger: "MANUAL" });
  assert.equal(run.failed, 0);
  await expect
    .poll(async () => Boolean((await Order.findById(o._id)).deletedAt))
    .toBe(true);
  await page.getByRole("button", { name: "تحديث التتبع", exact: true }).click();
  await row.getByLabel("الحالة الحالية: محذوف", { exact: true }).waitFor();
  await expect(readyButton).toHaveCount(0);
  await expect(row.getByRole("checkbox")).toHaveCount(0);
  await page.screenshot({
    path: path.join(output, "mobile-deleted.png"),
    fullPage: true,
  });
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await Shipment.countDocuments(), 1);
  assert.equal(
    (await Shipment.findById(shipment._id)).tracking,
    shipment.tracking,
  );
  assert.equal(readyCalls, 1);
  assert.deepEqual(errors, []);
  console.log(
    "Readiness browser passed: one-way Ready button, strict agency preflight, automatic Supprimée sync, protected API, mobile label visibility and no real courier calls.",
  );
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await replica.stop();
}
