import { before, after, beforeEach, test, mock } from "node:test";
import { fakeCloudinary } from "./fixtures/cloudinary.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import sharp from "sharp";
import supertest from "supertest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { app } from "../src/app.js";
import {
  Order,
  Shipment,
  OrderEvent,
  Customer,
  LogixProduct,
  TamqoPlan,
  OrderSource,
  Wilaya,
  Expense,
} from "../src/models/index.js";
import { User, RegistrationSetting, AuditLog } from "../src/models/security.js";
import { DeliveryAgency, DeliveryRate } from "../src/models/delivery.js";
import {
  IssueType,
  TrackingIssue,
  TrackingEvent,
  TrackingSetting,
} from "../src/models/tracking.js";
import { createOrder } from "../src/services/orderService.js";
import { DeliverySyncService } from "../src/services/delivery/deliverySyncService.js";
import {
  moveStage,
  listTracking,
  presentOrders,
  createIssue,
  resolveIssue,
  assignTracking,
  markImportant,
} from "../src/services/trackingService.js";
import { migrateTracking } from "../src/services/trackingMigration.js";
import { normalizeWhatsApp } from "../src/domain/whatsapp.js";
import { P } from "../../shared/permissions.js";
import { defaultTrackingFilters } from "../../shared/trackingFilters.js";

let replica,
  agency,
  product,
  plan,
  source,
  wilaya,
  admin,
  designer,
  production,
  sales,
  outsider,
  tmp;
const password = "tracking-test-password";
const basePermissions = [
  P.tracking.view,
  P.tracking.viewAll,
  P["tracking.issue"].view,
  P["tracking.issue"].create,
  P["tracking.issue"].resolve,
];
before(
  async () => {
    fakeCloudinary(mock);
    delete process.env.DELIVERY_API_TOKEN;
    delete process.env.DELIVERY_API_KEY;
    replica = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replica.getUri("isolated_tracking_tests"));
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
    tmp = await mkdtemp(path.join(os.tmpdir(), "crm-tracking-media-"));
    process.env.MEDIA_STORAGE_DIR = tmp;
    agency = await DeliveryAgency.create({
      name: "ABEX",
      code: "ABEX",
      active: true,
      integrationType: "API",
      apiProvider: "PROCOLIS",
      businesses: ["LOGIX", "TAMQO"],
      capabilities: { tracking: true, readyToShip: true, createShipment: true },
    });
    product = await LogixProduct.create({ name: "Plaque", price: 1500 });
    plan = await TamqoPlan.create({
      name: "Plan",
      price: 500,
      durationDays: 30,
    });
    source = await OrderSource.create({ name: "Phone", isDefault: true });
    wilaya = await Wilaya.create({
      name: "Alger",
      agencyId: "16",
      homeShippingPrice: 500,
      deskShippingPrice: 300,
    });
    await DeliveryRate.create({
      agencyId: agency._id,
      wilayaId: wilaya._id,
      homePrice: 500,
      deskPrice: 300,
    });
    const passwordHash = await bcrypt.hash(password, 4);
    async function employee(name, operationalRoles, permissions, extra = {}) {
      const user = await User.create({
        name,
        email: `${name}@test.invalid`,
        passwordHash,
        businessAccess: ["LOGIX", "TAMQO"],
        operationalRoles,
        permissions,
        whatsappPhone: "+213770987654",
        ...extra,
      });
      const api = supertest.agent(app);
      const login = await api
        .post("/api/auth/login")
        .send({ email: user.email, password });
      assert.equal(login.status, 200);
      return { user, api };
    }
    admin = await employee("admin", [], [], { role: "SUPER_ADMIN" });
    designer = await employee(
      "designer",
      ["DESIGNER"],
      [
        ...basePermissions,
        P.tracking.moveToProduction,
        P.tracking.moveToPreparing,
        P["tracking.contacts"].view,
      ],
    );
    production = await employee(
      "production",
      ["PRODUCTION"],
      [
        ...basePermissions,
        P.tracking.markReady,
        P.tracking.revertReady,
        P.tracking.bulkUpdate,
      ],
    );
    sales = await employee(
      "sales",
      ["SALES_CONFIRMATION"],
      [...basePermissions, P.orders.create, P.orders.viewOwn],
    );
    outsider = await employee("outsider", [], [], {
      businessAccess: ["TAMQO"],
    });
  },
  { timeout: 300000 },
);
after(async () => {
  await mongoose.disconnect();
  await replica?.stop();
  if (tmp?.startsWith(path.join(os.tmpdir(), "crm-tracking-media-")))
    await rm(tmp, { recursive: true, force: true });
  delete process.env.MEDIA_STORAGE_DIR;
});
beforeEach(async () => {
  for (const model of [
    Order,
    Shipment,
    OrderEvent,
    Customer,
    Expense,
    TrackingIssue,
    TrackingEvent,
    AuditLog,
    IssueType,
    TrackingSetting,
  ])
    await model.deleteMany({});
  await migrateTracking();
});
function input(business = "LOGIX_ONLY") {
  return {
    customer: { name: "Tracking Customer", phoneA: "0550123456" },
    location: {
      wilayaId: String(wilaya._id),
      commune: "Centre",
      address: "Test address",
    },
    sourceId: String(source._id),
    items: [
      ...(business !== "TAMQO_ONLY"
        ? [
            {
              business: "LOGIX",
              catalogItemId: String(product._id),
              quantity: 2,
              specifications: "Blue 20cm",
            },
          ]
        : []),
      ...(business !== "LOGIX_ONLY"
        ? [{ business: "TAMQO", catalogItemId: String(plan._id), quantity: 1 }]
        : []),
    ],
    delivery: { agencyId: String(agency._id), type: "HOME" },
    payment: { method: "COD" },
    note: "Original order note",
  };
}
const order = (business) =>
  createOrder(input(business), {
    userId: sales.user._id,
    name: sales.user.name,
  });
const stage = (targetStage, expectedRevision = 0) => ({
  targetStage,
  expectedRevision,
});
async function parcel(o, status = "PREPARING") {
  return Shipment.create({
    orderId: o._id,
    agencyId: agency._id,
    tracking: `T-${o._id}`,
    status,
    providerStatus: "En Préparation",
    syncStatus: "SYNCED",
  });
}
const snapshot = (value) => JSON.parse(JSON.stringify(value));
const sync = new DeliverySyncService({});
async function updateCourier(o, status, timestamp) {
  return sync.applyWithResult(o._id, {
    tracking: `T-${o._id}`,
    providerStatus: status,
    ...(timestamp ? { providerUpdatedAt: new Date(timestamp) } : {}),
    raw: { status },
  });
}
async function report(o, extra = {}, actor = designer.user) {
  const type = await IssueType.findOne({ code: "OTHER" });
  return createIssue(actor, String(o._id), {
    expectedRevision: o.revision,
    requestId: randomUUID(),
    typeId: String(type._id),
    severity: "INFO",
    ...extra,
  });
}

test("new physical orders initialize independently; TAMQO stays outside Tracking", async () => {
  const o = await order();
  assert.equal(o.status, "NEW");
  assert.equal(o.tracking.stage, "PREPARING");
  assert.ok(o.tracking.stageEnteredAt);
  assert.equal(o.items[0].specifications, "Blue 20cm");
  const tamqo = await order("TAMQO_ONLY");
  assert.equal(tamqo.tracking, undefined);
  const result = await listTracking(admin.user, {});
  assert.equal(result.total, 1);
  assert.equal(result.items[0].note, "Original order note");
  assert.equal(result.items[0].totalOrderValue, undefined);
});
test("designer directly toggles Preparing and At Production; production toggles Ready both ways without courier writes", async () => {
  const o = await order(),
    s = await parcel(o),
    beforeShipment = snapshot(s),
    payment = snapshot(o.payment);
  for (const [user, to, revision] of [
    [designer.user, "AT_PRODUCTION", 0],
    [designer.user, "PREPARING", 1],
    [designer.user, "AT_PRODUCTION", 2],
    [production.user, "READY_TO_SHIP", 3],
    [production.user, "AT_PRODUCTION", 4],
  ])
    await moveStage(user, String(o._id), stage(to, revision));
  const current = await Order.findById(o._id);
  assert.equal(current.status, "NEW");
  assert.deepEqual(snapshot(current.payment), payment);
  assert.deepEqual(snapshot(await Shipment.findById(s._id)), beforeShipment);
  assert.equal(await TrackingEvent.countDocuments({ orderId: o._id }), 5);
  const event = await TrackingEvent.findOne({ revision: 1 });
  assert.equal(event.previousStage, "PREPARING");
  assert.equal(event.newStage, "AT_PRODUCTION");
  assert.equal(String(event.actor.userId), String(designer.user._id));
  assert.ok(event.at);
  assert.equal(event.source, "TRACKING");
});
test("unauthorized role actions and production financial edits are rejected on server", async () => {
  const o = await order();
  assert.equal(
    (
      await outsider.api
        .patch(`/api/tracking/${o._id}/stage`)
        .send(stage("AT_PRODUCTION"))
    ).status,
    403,
  );
  assert.equal(
    (
      await sales.api
        .patch(`/api/tracking/${o._id}/stage`)
        .send(stage("AT_PRODUCTION"))
    ).status,
    403,
  );
  await moveStage(designer.user, String(o._id), stage("AT_PRODUCTION"));
  // Even a mistakenly granted permission cannot make Designer a Production employee.
  await User.updateOne(
    { _id: designer.user._id },
    { $addToSet: { permissions: P.tracking.markReady } },
  );
  assert.equal(
    (
      await designer.api
        .patch(`/api/tracking/${o._id}/stage`)
        .send(stage("READY_TO_SHIP", 1))
    ).status,
    403,
  );
  await User.updateOne(
    { _id: designer.user._id },
    { $pull: { permissions: P.tracking.markReady } },
  );
  assert.equal(
    (
      await production.api
        .patch(`/api/orders/${o._id}`)
        .send({ ...input(), revision: 1, deliveryCharged: 0 })
    ).status,
    403,
  );
});
test("concurrent employees and duplicate retries produce one atomic stage event", async () => {
  const o = await order(),
    id = String(o._id);
  const results = await Promise.allSettled([
    moveStage(designer.user, id, stage("AT_PRODUCTION")),
    moveStage(designer.user, id, stage("AT_PRODUCTION")),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  await assert.rejects(moveStage(designer.user, id, stage("AT_PRODUCTION")), {
    status: 409,
  });
  assert.equal(await TrackingEvent.countDocuments({ orderId: id }), 1);
});
test("issue creation uses session identity, preserves snapshot and resolves immediately exactly once", async () => {
  const o = await order(),
    s = await parcel(o),
    before = snapshot(s);
  await report(o, { description: "Check artwork" });
  const issue = await TrackingIssue.findOne({ orderId: o._id });
  assert.equal(issue.reporter.name, "designer");
  assert.deepEqual([...issue.reporterRoles], ["DESIGNER"]);
  await IssueType.updateOne({ _id: issue.typeId }, { label: "Renamed" });
  assert.equal(
    (await TrackingIssue.findById(issue._id)).typeSnapshot.label,
    "Other",
  );
  await resolveIssue(production.user, String(o._id), String(issue._id), {
    expectedRevision: 1,
  });
  const resolved = await TrackingIssue.findById(issue._id);
  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.resolvedBy.name, "production");
  assert.ok(resolved.resolvedAt);
  await assert.rejects(
    resolveIssue(production.user, String(o._id), String(issue._id), {
      expectedRevision: 2,
    }),
    { status: 409 },
  );
  assert.deepEqual(snapshot(await Shipment.findById(s._id)), before);
  assert.equal((await Order.findById(o._id)).status, "NEW");
  assert.equal(await OrderEvent.countDocuments({ orderId: o._id }), 1);
  assert.equal(
    await TrackingEvent.countDocuments({ kind: "TRACKING_ISSUE_RESOLVED" }),
    1,
  );
});
test("disabled/invalid issue types, invalid severity, identity spoofing and duplicate reports fail", async () => {
  const o = await order(),
    type = await IssueType.findOne();
  const payload = {
    expectedRevision: 0,
    typeId: String(type._id),
    severity: "INFO",
    requestId: randomUUID(),
  };
  const endpoint = `/api/tracking/${o._id}/issues`;
  for (const body of [
    { ...payload, severity: "Translated label" },
    { ...payload, typeId: String(new mongoose.Types.ObjectId()) },
    { ...payload, reporter: { name: "Admin" } },
  ])
    assert.equal((await designer.api.post(endpoint).send(body)).status, 400);
  await IssueType.updateOne({ _id: type._id }, { enabled: false });
  assert.equal((await designer.api.post(endpoint).send(payload)).status, 400);
  await IssueType.updateOne({ _id: type._id }, { enabled: true });
  assert.equal((await designer.api.post(endpoint).send(payload)).status, 201);
  assert.equal(
    (
      await designer.api
        .post(endpoint)
        .send({ ...payload, expectedRevision: 1 })
    ).status,
    409,
  );
  assert.equal(await TrackingIssue.countDocuments(), 1);
});
test("blocking reports and critical reports lock production until resolution", async () => {
  const o = await order();
  await report(o, { severity: "CRITICAL" });
  await assert.rejects(
    moveStage(designer.user, String(o._id), stage("AT_PRODUCTION", 1)),
    { status: 409 },
  );
  const issue = await TrackingIssue.findOne();
  await resolveIssue(designer.user, String(o._id), String(issue._id), {
    expectedRevision: 1,
  });
  await moveStage(designer.user, String(o._id), stage("AT_PRODUCTION", 2));
  const type = await IssueType.findOne();
  type.blocksProduction = true;
  await type.save();
  await report(await Order.findById(o._id), { severity: "WARNING" });
  await assert.rejects(
    moveStage(production.user, String(o._id), stage("READY_TO_SHIP", 4)),
    { status: 409 },
  );
});
test("bulk updates give per-order results with no partial individual writes", async () => {
  const good = await order(),
    bad = await order();
  await moveStage(designer.user, String(good._id), stage("AT_PRODUCTION"));
  const response = await production.api.post("/api/tracking/bulk-stage").send({
    orders: [
      { orderId: String(good._id), ...stage("READY_TO_SHIP", 1) },
      { orderId: String(bad._id), ...stage("READY_TO_SHIP") },
    ],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.results.map((r) => r.success),
    [true, false],
  );
  assert.equal((await Order.findById(bad._id)).revision, 0);
  assert.equal(
    (await designer.api.post("/api/tracking/bulk-stage").send({ orders: [] }))
      .status,
    403,
  );
});
test("migration repeated twice preserves historical courier statuses, finances, notes and tracking IDs", async () => {
  const originals = [];
  for (const status of ["OUT_FOR_DELIVERY", "DELIVERED", "RETURNED", "NEW"]) {
    const o = await order();
    await parcel(o, status);
    await Order.updateOne(
      { _id: o._id },
      { $set: { status }, $unset: { tracking: "" } },
    );
    originals.push(await Order.findById(o._id).lean());
  }
  const shipments = snapshot(await Shipment.find().sort({ _id: 1 }));
  await migrateTracking();
  await migrateTracking();
  for (const original of originals) {
    const current = await Order.findById(original._id).lean();
    const { tracking, ...rest } = current;
    assert.deepEqual(snapshot(rest), snapshot(original));
    assert.equal(tracking.stage, "LEGACY_UNINITIALIZED");
    assert.equal(tracking.stageEnteredAt, undefined);
    assert.equal(tracking.designerId, undefined);
  }
  assert.deepEqual(snapshot(await Shipment.find().sort({ _id: 1 })), shipments);
  assert.equal(await TrackingEvent.countDocuments(), 0);
  const delivered = originals.find((o) => o.status === "DELIVERED");
  await assert.rejects(
    moveStage(admin.user, String(delivered._id), stage("PREPARING")),
    { status: 403 },
  );
});
test("valid newer courier transitions control commercial state and prevent internal regression", async () => {
  const o = await order();
  await parcel(o);
  await updateCourier(o, "En Préparation", "2026-10-01T12:00:00Z");
  let current = await Order.findById(o._id);
  assert.equal(current.status, "PREPARING");
  assert.equal(current.tracking.courierOwned, false);
  await moveStage(
    designer.user,
    String(o._id),
    stage("AT_PRODUCTION", current.revision),
  );
  await updateCourier(o, "En Livraison", "2026-10-02T12:00:00Z");
  current = await Order.findById(o._id);
  assert.equal(current.status, "OUT_FOR_DELIVERY");
  assert.equal(current.tracking.stage, "AT_PRODUCTION");
  assert.equal(current.tracking.courierOwned, true);
  await assert.rejects(
    moveStage(
      production.user,
      String(o._id),
      stage("READY_TO_SHIP", current.revision),
    ),
    { status: 409 },
  );
});
test("courier takeover racing an internal transition is never lost", async () => {
  const o = await order();
  await parcel(o);
  const results = await Promise.allSettled([
    updateCourier(o, "En Livraison", "2026-10-02T12:00:00Z"),
    moveStage(designer.user, String(o._id), stage("AT_PRODUCTION")),
  ]);
  assert.equal(results[0].status, "fulfilled");
  const current = await Order.findById(o._id);
  assert.equal(current.status, "OUT_FOR_DELIVERY");
  assert.equal(current.tracking.courierOwned, true);
  assert.deepEqual(
    (await presentOrders(admin.user, [current.toObject()]))[0].allowedTargets,
    [],
  );
});
test("stale/contradictory provider states preserve terminal status; duplicates have no financial or event effects", async () => {
  const o = await order();
  await parcel(o);
  await updateCourier(o, "Livrée", "2026-10-02T12:00:00Z");
  const eventCount = await OrderEvent.countDocuments(),
    payment = snapshot((await Order.findById(o._id)).payment);
  await updateCourier(o, "Livrée", "2026-10-02T12:00:00Z");
  const result = await updateCourier(
    o,
    "En Préparation",
    "2026-10-01T12:00:00Z",
  );
  assert.equal(result.outcome.result, "ERROR");
  assert.equal((await Order.findById(o._id)).status, "DELIVERED");
  assert.equal((await Shipment.findOne()).providerStatus, "Livrée");
  assert.equal(await OrderEvent.countDocuments(), eventCount);
  assert.deepEqual(snapshot((await Order.findById(o._id)).payment), payment);
  assert.equal(await Expense.countDocuments(), 0);
});
test("stale nonterminal updates cannot regress; unknown states remain diagnostic", async () => {
  const o = await order();
  await parcel(o);
  await updateCourier(o, "Retour livreur", "2026-10-03T12:00:00Z");
  await updateCourier(o, "En Livraison", "2026-10-02T12:00:00Z");
  assert.equal((await Order.findById(o._id)).status, "RETURNING");
  const response = await updateCourier(o, "Undocumented");
  assert.equal(response.outcome.result, "UNKNOWN_STATUS");
  assert.equal((await Order.findById(o._id)).status, "RETURNING");
  assert.equal(
    (await Shipment.findOne()).lastObservation.providerStatus,
    "Undocumented",
  );
});
test("reports still work after courier takeover without altering any shipment or financial data", async () => {
  const o = await order();
  await parcel(o);
  await updateCourier(o, "Retour stock", "2026-10-03T12:00:00Z");
  const shipmentBefore = snapshot(await Shipment.findOne()),
    expensesBefore = snapshot(await Expense.find());
  await report(await Order.findById(o._id));
  const issue = await TrackingIssue.findOne();
  await resolveIssue(designer.user, String(o._id), String(issue._id), {
    expectedRevision: (await Order.findById(o._id)).revision,
  });
  assert.deepEqual(snapshot(await Shipment.findOne()), shipmentBefore);
  assert.deepEqual(snapshot(await Expense.find()), expensesBefore);
  assert.equal((await Order.findById(o._id)).status, "RETURNED");
});
test("deleted orders reject every tracking mutation and private images", async () => {
  const o = await order();
  await Order.updateOne({ _id: o._id }, { deletedAt: new Date() });
  for (const [method, suffix, body] of [
    ["patch", "stage", stage("AT_PRODUCTION")],
    ["post", "issues", {}],
    [
      "patch",
      "assign",
      { expectedRevision: 0, designerId: null, productionId: null },
    ],
  ]) {
    const result = await admin.api[method](
      `/api/tracking/${o._id}/${suffix}`,
    ).send(body);
    assert.ok([400, 404].includes(result.status));
  }
  assert.equal(
    (
      await admin.api.get(
        `/api/order-media/${o._id}/${new mongoose.Types.ObjectId()}`,
      )
    ).status,
    404,
  );
});
test("Logix-only business access never leaks partnership or TAMQO records via filters or IDs", async () => {
  const logix = await order(),
    partnership = await order("PARTNERSHIP");
  await order("TAMQO_ONLY");
  const scoped = { ...designer.user.toObject(), businessAccess: ["LOGIX"] };
  assert.equal((await listTracking(scoped, {})).total, 1);
  assert.equal(
    (await listTracking(scoped, { business: "PARTNERSHIP" })).total,
    0,
  );
  await assert.rejects(
    moveStage(scoped, String(partnership._id), stage("AT_PRODUCTION")),
    { status: 404 },
  );
  await parcel(logix);
  assert.equal(
    (await listTracking(scoped, { search: `T-${logix._id}` })).items[0]
      .orderNumber,
    logix.orderNumber,
  );
});
test("contact information is permission-protected; creator and reporter use persisted identities", async () => {
  const o = await order();
  await parcel(o);
  await report(o);
  const allowed = await designer.api.get(`/api/tracking/${o._id}`),
    denied = await production.api.get(`/api/tracking/${o._id}`);
  assert.equal(allowed.body.creatorContact.url, "https://wa.me/213770987654");
  assert.equal(denied.body.creatorContact.url, null);
  assert.ok(!JSON.stringify(denied.body).includes("213770987654"));
  assert.equal(
    allowed.body.shipment.url,
    `https://abex-dz.com/ABEX-DZ_WEB/FR/liste.awp?P1=x&P2=Tracking&P3=T-${o._id}`,
  );
  const reports = await production.api.get(`/api/tracking/${o._id}/issues`);
  assert.equal(reports.body.items[0].reporter.name, "designer");
  assert.equal(reports.body.items[0].reporterContact.url, null);
  await User.updateOne({ _id: sales.user._id }, { status: "DISABLED" });
  assert.equal(
    (await designer.api.get(`/api/tracking/${o._id}`)).body.creatorContact.url,
    null,
  );
  await User.updateOne({ _id: sales.user._id }, { status: "ACTIVE" });
});
test("manual agencies get no ABEX link or invented integration operations", async () => {
  const manual = await DeliveryAgency.create({
    code: randomUUID(),
    name: "Manual agency",
    integrationType: "MANUAL",
    apiProvider: "MANUAL",
    businesses: ["LOGIX"],
  });
  const o = await order();
  await Order.updateOne({ _id: o._id }, { "delivery.agencyId": manual._id });
  const s = await parcel(o);
  s.agencyId = manual._id;
  s.provider = "MANUAL";
  await s.save();
  const response = await designer.api.get(`/api/tracking/${o._id}`);
  assert.equal(response.body.shipment.url, null);
  await moveStage(designer.user, String(o._id), stage("AT_PRODUCTION"));
  assert.equal((await Shipment.findById(s._id)).provider, "MANUAL");
});
test("WhatsApp validation, requirement and safe profile completion retain existing authentication", async () => {
  assert.equal(normalizeWhatsApp("0550 12 34 56"), "+213550123456");
  assert.equal(normalizeWhatsApp("00213 550 123456"), "+213550123456");
  assert.equal(normalizeWhatsApp("+44 7700 900123"), "+447700900123");
  for (const bad of ["abc", "055012", "+21312345678", "+0000000000"])
    assert.throws(() => normalizeWhatsApp(bad));
  await TrackingSetting.updateOne(
    { _id: "tracking" },
    { requireWhatsApp: true },
  );
  await User.updateOne({ _id: production.user._id }, { whatsappPhone: "" });
  assert.equal((await production.api.get("/api/auth/session")).status, 200);
  assert.equal(
    (
      await production.api
        .patch("/api/auth/profile")
        .send({ whatsappPhone: "", expectedRevision: production.user.__v })
    ).status,
    400,
  );
  const self = await production.api.get("/api/auth/me");
  assert.equal(
    (
      await production.api.patch("/api/auth/profile").send({
        whatsappPhone: "+213770123456",
        expectedRevision: self.body.user.__v,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await production.api.patch("/api/auth/profile").send({
        whatsappPhone: "0550123456",
        expectedRevision: self.body.user.__v,
        permissions: [P.tracking.viewAll],
      })
    ).status,
    400,
  );
});
test("self-registration may request a role but never assigns access or privileged permissions", async () => {
  const key = "tracking-registration-key";
  await RegistrationSetting.findOneAndUpdate(
    { _id: "registration" },
    {
      registrationEnabled: true,
      registrationKeyHash: await bcrypt.hash(key, 4),
    },
    { upsert: true },
  );
  await TrackingSetting.updateOne(
    { _id: "tracking" },
    { requireWhatsApp: true },
  );
  const body = {
    name: "New employee",
    email: `${randomUUID()}@test.invalid`,
    password,
    registrationKey: key,
    role: "SUPER_ADMIN",
    operationalRoles: ["PRODUCTION_MANAGER"],
    requestedOperationalRole: "DESIGNER",
    permissions: [P.tracking.viewAll],
    businessAccess: ["LOGIX"],
  };
  assert.equal(
    (await supertest(app).post("/api/auth/register").send(body)).status,
    400,
  );
  const registered = await supertest(app)
    .post("/api/auth/register")
    .send({ ...body, whatsappPhone: "0550123456" });
  assert.equal(registered.status, 200);
  assert.equal(registered.body.user.role, "EMPLOYEE");
  assert.deepEqual(registered.body.user.operationalRoles, []);
  assert.deepEqual(registered.body.user.permissions, []);
  assert.equal(registered.body.user.requestedOperationalRole, "DESIGNER");
});
test("admins cannot delegate unheld permissions or elevated security roles", async () => {
  const restricted = await User.create({
    name: "Restricted admin",
    email: `${randomUUID()}@test.invalid`,
    passwordHash: await bcrypt.hash(password, 4),
    role: "ADMIN",
    businessAccess: ["LOGIX"],
    permissions: [P.users.create, P.users.permissions],
  });
  const api = supertest.agent(app);
  await api.post("/api/auth/login").send({ email: restricted.email, password });
  const body = {
    name: "Employee",
    email: `${randomUUID()}@test.invalid`,
    password,
    operationalRoles: ["PRODUCTION"],
    businessAccess: ["LOGIX"],
    permissions: [P.tracking.markReady],
  };
  assert.equal((await api.post("/api/users").send(body)).status, 403);
  assert.equal(
    (
      await api
        .post("/api/users")
        .send({ ...body, permissions: [], role: "SUPER_ADMIN" })
    ).status,
    403,
  );
});
test("optional images validate actual content, remain private, and failure leaves the order intact", async () => {
  const o = await order(),
    endpoint = `/api/order-media/${o._id}`;
  const invalid = await sales.api
    .post(endpoint)
    .field("expectedRevision", "0")
    .attach("image", Buffer.from('<svg onload="alert(1)"/>'), {
      filename: "../../evil.png",
      contentType: "image/png",
    });
  assert.equal(invalid.status, 400);
  assert.ok(await Order.exists({ _id: o._id }));
  const buffer = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#4080d0" },
  })
    .png()
    .toBuffer();
  const response = await sales.api
    .post(endpoint)
    .field("expectedRevision", "0")
    .attach("image", buffer, {
      filename: "design.png",
      contentType: "image/png",
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const url = response.body.images[0].url;
  assert.equal((await designer.api.get(url)).status, 200);
  assert.ok([403, 404].includes((await outsider.api.get(url)).status));
  const saved = await Order.findById(o._id);
  assert.equal(saved.status, "NEW");
  assert.equal(saved.images[0].mime, "image/webp");
  assert.equal(saved.totalOrderValue, o.totalOrderValue);
  assert.equal(
    (
      await production.api
        .post(endpoint)
        .field("expectedRevision", "1")
        .attach("image", buffer, {
          filename: "design.png",
          contentType: "image/png",
        })
    ).status,
    403,
  );
});
test("courier failure is visible and never loses order or production data", async () => {
  const o = await order();
  await parcel(o);
  const failing = new DeliverySyncService({
    readPackages: async () => {
      throw new Error("network failure");
    },
  });
  await assert.rejects(failing.refresh(o._id));
  assert.equal((await Shipment.findOne()).syncStatus, "ERROR");
  assert.equal((await Order.findById(o._id)).tracking.stage, "PREPARING");
});
test("courier reservations and verified readiness lock production without changing its stage", async () => {
  const o = await order(),
    s = await parcel(o);
  await Shipment.updateOne(
    { _id: s._id },
    { lockUntil: new Date(Date.now() + 60000) },
  );
  await assert.rejects(
    moveStage(designer.user, String(o._id), stage("AT_PRODUCTION")),
    { status: 409 },
  );
  await Shipment.updateOne({ _id: s._id }, { lockUntil: null });
  await updateCourier(o, "En traitement - prêt à expédié");
  const current = await Order.findById(o._id);
  assert.equal(current.tracking.stage, "PREPARING");
  assert.equal(current.tracking.courierOwned, true);
  await assert.rejects(
    moveStage(
      designer.user,
      String(o._id),
      stage("AT_PRODUCTION", current.revision),
    ),
    { status: 409 },
  );
});
test("assignment validates operational teams and business scope, protects revisions, and resolves responsible contact", async () => {
  const o = await order();
  await assert.rejects(
    assignTracking(designer.user, String(o._id), {
      expectedRevision: 0,
      designerId: String(designer.user._id),
      productionId: null,
    }),
    { status: 403 },
  );
  await assert.rejects(
    assignTracking(admin.user, String(o._id), {
      expectedRevision: 0,
      designerId: String(production.user._id),
      productionId: null,
    }),
    { status: 400 },
  );
  await assignTracking(admin.user, String(o._id), {
    expectedRevision: 0,
    designerId: String(designer.user._id),
    productionId: String(production.user._id),
  });
  const view = (
    await presentOrders(designer.user, [
      (await Order.findById(o._id)).toObject(),
    ])
  )[0];
  assert.equal(view.responsible.name, "designer");
  assert.ok(view.responsible.url);
  await assert.rejects(
    assignTracking(admin.user, String(o._id), {
      expectedRevision: 0,
      designerId: null,
      productionId: null,
    }),
    { status: 409 },
  );
});
test("issue-type and settings administration require admin permissions and revision checks", async () => {
  const data = {
    label: "Artwork",
    description: "Check design",
    defaultSeverity: "WARNING",
    blocksProduction: true,
    responsibleTeam: "DESIGNER",
    enabled: true,
    sortOrder: 5,
    indicator: "FLAG",
  };
  assert.equal(
    (await designer.api.post("/api/tracking/issue-types").send(data)).status,
    403,
  );
  const type = await admin.api.post("/api/tracking/issue-types").send(data);
  assert.equal(type.status, 201);
  const updated = await admin.api
    .patch("/api/tracking/issue-types/" + type.body._id)
    .send({ ...data, label: "New label", expectedRevision: 0 });
  assert.equal(updated.status, 200);
  assert.equal(
    (
      await admin.api
        .patch("/api/tracking/issue-types/" + type.body._id)
        .send({ ...data, expectedRevision: 0 })
    ).status,
    409,
  );
  const settings = await admin.api.get("/api/tracking/settings");
  const body = {
    expectedRevision: settings.body.__v,
    requireWhatsApp: true,
    fallbackContactId: null,
    operationalRoles: settings.body.operationalRoles,
  };
  assert.equal(
    (await production.api.patch("/api/tracking/settings").send(body)).status,
    403,
  );
  assert.equal(
    (await admin.api.patch("/api/tracking/settings").send(body)).status,
    200,
  );
  assert.equal(
    (await admin.api.patch("/api/tracking/settings").send(body)).status,
    409,
  );
});
test("a concurrent blocking report and stage request cannot both commit using the same revision", async () => {
  const o = await order();
  const results = await Promise.allSettled([
    report(o, { severity: "CRITICAL" }),
    moveStage(designer.user, String(o._id), stage("AT_PRODUCTION")),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await Order.findById(o._id)).revision, 1);
  assert.equal(await TrackingEvent.countDocuments({ orderId: o._id }), 1);
});
test("tracking pagination is stable and query validation rejects invalid filters", async () => {
  const first = await order(),
    second = await order();
  await Order.updateMany({}, { createdAt: new Date("2026-10-01T12:00:00Z") });
  const a = await listTracking(admin.user, {
      limit: 1,
      page: 1,
      sort: "oldest",
    }),
    b = await listTracking(admin.user, { limit: 1, page: 2, sort: "oldest" });
  assert.equal(a.total, 2);
  assert.equal(String(a.items[0]._id), String(first._id));
  assert.equal(String(b.items[0]._id), String(second._id));
  assert.equal(
    (await admin.api.get("/api/tracking?stage=AT_COURIER")).status,
    400,
  );
  assert.equal(
    (await admin.api.get("/api/tracking?from=not-a-date")).status,
    400,
  );
});

const filterNow = new Date("2026-10-28T23:30:00Z");
async function datedOrder(createdAt, fields = {}, business) {
  const o = await order(business);
  await Order.collection.updateOne(
    { _id: o._id },
    { $set: { createdAt: new Date(createdAt), ...fields } },
  );
  return Order.findById(o._id);
}
const filterIds = (result) => result.items.map((o) => String(o._id));
test("operational defaults apply even with viewAll; security admins retain the complete view", async () => {
  assert.equal(defaultTrackingFilters(designer.user).stage, "PREPARING");
  assert.equal(defaultTrackingFilters(production.user).stage, "AT_PRODUCTION");
  assert.equal(defaultTrackingFilters(sales.user).sort, "issuesFirst");
  assert.equal(
    defaultTrackingFilters({
      ...admin.user.toObject(),
      operationalRoles: ["DESIGNER"],
    }).stage,
    undefined,
  );
  const oldest = await datedOrder("2026-10-20T10:00:00Z");
  const newer = await datedOrder("2026-10-21T10:00:00Z");
  const atProduction = await datedOrder("2026-10-22T10:00:00Z", {
    "tracking.stage": "AT_PRODUCTION",
  });
  await datedOrder("2026-10-23T10:00:00Z", { status: "DELIVERED" });
  await datedOrder("2026-10-24T10:00:00Z", { "tracking.courierOwned": true });
  assert.deepEqual(filterIds(await listTracking(designer.user, {})), [
    String(oldest._id),
    String(newer._id),
  ]);
  assert.deepEqual(filterIds(await listTracking(production.user, {})), [
    String(atProduction._id),
  ]);
  assert.equal((await listTracking(admin.user, {})).total, 5);
  assert.equal(
    (await listTracking(designer.user, { view: "custom" })).total,
    5,
  );
  const response = await production.api.get("/api/tracking");
  assert.equal(response.status, 200);
  assert.equal(response.body.items[0]._id, String(atProduction._id));
});
test("Sales sees all active orders, unresolved reports first, Sales intervention next, then oldest within groups", async () => {
  const oldest = await datedOrder("2026-10-20T10:00:00Z");
  const genericOlder = await datedOrder("2026-10-21T10:00:00Z");
  const salesOlder = await datedOrder("2026-10-22T10:00:00Z");
  const salesNewer = await datedOrder("2026-10-23T10:00:00Z");
  const genericNewer = await datedOrder("2026-10-24T10:00:00Z");
  await report(genericOlder);
  await report(genericNewer);
  await IssueType.updateOne(
    { code: "OTHER" },
    { responsibleTeam: "SALES_CONFIRMATION" },
  );
  await report(salesOlder);
  await report(salesNewer);
  for (const status of ["DELIVERED", "RETURNED", "CANCELLED"])
    await datedOrder("2026-10-19T10:00:00Z", { status });
  const result = await listTracking(sales.user, {});
  assert.deepEqual(
    filterIds(result),
    [salesOlder, salesNewer, genericOlder, genericNewer, oldest].map((o) =>
      String(o._id),
    ),
  );
  assert.equal(
    (await listTracking(sales.user, { lifecycle: "COMPLETED" })).total,
    3,
  );
  assert.equal(
    (await listTracking(sales.user, { view: "custom", sort: "oldest" })).total,
    8,
  );
  const issue = await TrackingIssue.findOne({ orderId: salesOlder._id });
  await resolveIssue(sales.user, String(salesOlder._id), String(issue._id), {
    expectedRevision: 1,
  });
  assert.deepEqual(
    filterIds(await listTracking(sales.user, {})).slice(0, 3),
    [salesNewer, genericOlder, genericNewer].map((o) => String(o._id)),
  );
});
test("Important is authorized, persisted, audited, revision-protected and independent of courier/production data", async () => {
  const o = await order(),
    s = await parcel(o),
    shipmentBefore = snapshot(s);
  const endpoint = `/api/tracking/${o._id}/important`;
  assert.equal(
    (
      await production.api
        .patch(endpoint)
        .send({ important: true, expectedRevision: 0 })
    ).status,
    403,
  );
  assert.equal(
    (
      await admin.api
        .patch(endpoint)
        .send({ important: true, expectedRevision: 0 })
    ).status,
    200,
  );
  assert.equal(
    (
      await admin.api
        .patch(endpoint)
        .send({ important: false, expectedRevision: 0 })
    ).status,
    409,
  );
  const current = await Order.findById(o._id);
  assert.equal(current.tracking.important, true);
  assert.equal(current.tracking.importantUpdatedBy.name, "admin");
  assert.ok(current.tracking.importantUpdatedAt);
  assert.equal(current.tracking.stage, o.tracking.stage);
  assert.equal(current.status, o.status);
  assert.deepEqual(snapshot(current.payment), snapshot(o.payment));
  assert.deepEqual(snapshot(await Shipment.findById(s._id)), shipmentBefore);
  assert.equal(
    (await listTracking(admin.user, { tags: "IMPORTANT" })).total,
    1,
  );
  const event = await TrackingEvent.findOne({ orderId: o._id });
  assert.equal(event.kind, "TRACKING_PRIORITY_CHANGED");
  assert.deepEqual(event.data, { important: true });
  assert.equal(
    (await production.api.get(`/api/tracking/${o._id}`)).body.canMarkImportant,
    false,
  );
  await markImportant(admin.user, String(o._id), {
    important: true,
    expectedRevision: 1,
  });
  assert.equal(await TrackingEvent.countDocuments(), 1);
  await markImportant(admin.user, String(o._id), {
    important: false,
    expectedRevision: 1,
  });
  assert.equal(
    (await listTracking(admin.user, { tags: "IMPORTANT" })).total,
    0,
  );
});
test("age tags honor exact 24-hour/four-day boundaries and Today uses Algeria midnight", async () => {
  const today = await datedOrder("2026-10-28T23:00:00Z");
  const beforeToday = await datedOrder("2026-10-28T22:59:59.999Z");
  const dayBoundary = await datedOrder(new Date(+filterNow - 86400000));
  const beforeDay = await datedOrder(new Date(+filterNow - 86400001));
  const fourBoundary = await datedOrder(new Date(+filterNow - 4 * 86400000));
  const underFour = await datedOrder(new Date(+filterNow - 4 * 86400000 + 1));
  const future = await datedOrder("2026-10-30T00:00:00Z");
  const get = (tags) =>
    listTracking(admin.user, { tags, sort: "oldest" }, filterNow);
  assert.deepEqual(filterIds(await get("TODAY")), [String(today._id)]);
  assert.deepEqual(
    new Set(filterIds(await get("NEW"))),
    new Set([today, beforeToday, dayBoundary].map((o) => String(o._id))),
  );
  assert.deepEqual(filterIds(await get("GTE4D")), [String(fourBoundary._id)]);
  const less = filterIds(await get("LT4D"));
  assert.ok(less.includes(String(underFour._id)));
  assert.ok(less.includes(String(beforeDay._id)));
  assert.ok(!less.includes(String(fourBoundary._id)));
  assert.ok(!less.includes(String(future._id)));
  assert.equal((await get("LT4D,GTE4D")).total, 6);
});
test("quick tags combine OR within categories and AND across categories; My Orders uses assignments only", async () => {
  const assigned = await datedOrder("2026-10-28T20:00:00Z", {
    "tracking.designerId": sales.user._id,
    "tracking.important": true,
  });
  const creatorOnly = await datedOrder("2026-10-20T20:00:00Z", {
    "tracking.important": true,
  });
  const blocked = await datedOrder("2026-10-28T20:00:00Z");
  await report(blocked, { severity: "CRITICAL" });
  const warning = await datedOrder("2026-10-28T20:00:00Z");
  await report(warning);
  const q = {
    view: "custom",
    tags: "MY_ORDERS,IMPORTANT,LT4D,GTE4D,ISSUES,NO_ISSUES",
  };
  assert.deepEqual(filterIds(await listTracking(sales.user, q, filterNow)), [
    String(assigned._id),
  ]);
  assert.equal(
    (
      await listTracking(
        sales.user,
        { view: "custom", tags: "MY_ORDERS" },
        filterNow,
      )
    ).total,
    1,
  );
  assert.equal(
    (await listTracking(admin.user, { tags: "ISSUES,BLOCKED" }, filterNow))
      .total,
    2,
  );
  assert.equal(
    (
      await listTracking(
        admin.user,
        { issue: "NONE", tags: "ISSUES" },
        filterNow,
      )
    ).total,
    4,
  );
  assert.deepEqual(
    filterIds(await listTracking(admin.user, { tags: "BLOCKED" }, filterNow)),
    [String(blocked._id)],
  );
  assert.equal(
    (await listTracking(admin.user, { tags: "NO_ISSUES" }, filterNow)).total,
    2,
  );
  assert.ok(
    !filterIds(await listTracking(sales.user, q, filterNow)).includes(
      String(creatorOnly._id),
    ),
  );
});
test("combined tags preserve search, stage, date, business scope, stable pagination and contextual counts", async () => {
  const matching = [];
  for (let n = 0; n < 3; n++)
    matching.push(
      await datedOrder("2026-10-28T20:00:00Z", {
        "tracking.stage": "AT_PRODUCTION",
        "tracking.important": true,
      }),
    );
  await datedOrder("2026-10-28T20:00:00Z", { "tracking.important": true });
  await datedOrder(
    "2026-10-28T20:00:00Z",
    { "tracking.stage": "AT_PRODUCTION", "tracking.important": true },
    "PARTNERSHIP",
  );
  await datedOrder("2026-10-28T20:00:00Z", {}, "TAMQO_ONLY");
  const scoped = { ...designer.user.toObject(), businessAccess: ["LOGIX"] };
  const q = {
    view: "custom",
    search: "Plaque",
    stage: "AT_PRODUCTION",
    tags: "IMPORTANT,LT4D,NO_ISSUES",
    from: "2026-10-28",
    to: "2026-10-28",
    sort: "oldest",
    limit: 1,
  };
  const first = await listTracking(scoped, { ...q, page: 1 }, filterNow),
    second = await listTracking(scoped, { ...q, page: 2 }, filterNow);
  assert.equal(first.total, 3);
  assert.equal(second.total, 3);
  assert.equal(first.items[0]._id.toString(), matching[0]._id.toString());
  assert.equal(second.items[0]._id.toString(), matching[1]._id.toString());
  assert.equal(first.tagCounts.IMPORTANT, 3);
  assert.equal(first.tagCounts.NO_ISSUES, 3);
  assert.equal(first.tagCounts.BLOCKED, 0);
  assert.equal(first.tagCounts.GTE4D, 0);
  assert.equal(
    (await listTracking(scoped, { ...q, search: "no match" }, filterNow))
      .tagCounts.IMPORTANT,
    0,
  );
  assert.equal(
    (await outsider.api.get("/api/tracking?tags=IMPORTANT")).status,
    403,
  );
  const forbidden = await datedOrder("2026-10-28T20:00:00Z", {}, "PARTNERSHIP");
  const limitedAdmin = {
    ...admin.user.toObject(),
    role: "ADMIN",
    businessAccess: ["LOGIX"],
    permissions: [P.tracking.view, P.tracking.viewAll, P.tracking.assign],
  };
  await assert.rejects(
    markImportant(limitedAdmin, String(forbidden._id), {
      important: true,
      expectedRevision: 0,
    }),
    { status: 404 },
  );
});
test("quick filter payload validation rejects unknown/duplicate tags and malformed filters", async () => {
  for (const query of [
    "tags=UNKNOWN",
    "tags=NEW,NEW",
    "sort=unsafe",
    "lifecycle=unknown",
    "from=2026-10-29&to=2026-10-28",
  ]) {
    assert.equal((await admin.api.get("/api/tracking?" + query)).status, 400);
  }
});
