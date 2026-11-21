import { before, after, beforeEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import axios from "axios";
import mongoose from "mongoose";
import supertest from "supertest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Webhook } from "standardwebhooks";
import { app } from "../src/app.js";
import {
  DeliveryAgency,
  DeliverySyncSettings,
} from "../src/models/delivery.js";
import { Order, Shipment, OrderEvent, Expense } from "../src/models/index.js";
import { TrackingEvent } from "../src/models/tracking.js";
import { AuditLog, User, Session } from "../src/models/security.js";
import {
  DeliveryWebhookEvent,
  DeliveryWebhookWorker,
  ensureWebhookIndexes,
} from "../src/models/deliveryWebhook.js";
import {
  acceptWebhook,
  claimWebhook,
} from "../src/services/delivery/webhooks/webhookInboxService.js";
import {
  webhookConfig,
  validateWebhookConfig,
} from "../src/services/delivery/webhooks/webhookConfig.js";
import { abexWebhookAdapter } from "../src/services/delivery/webhooks/abexWebhookAdapter.js";
import {
  processWebhookClaim,
  runWebhookBatch,
} from "../src/services/delivery/webhooks/webhookProcessor.js";
import { prepareWebhookRefresh } from "../src/services/delivery/webhooks/webhookReconciliationService.js";
import { createAbexWebhookRouter } from "../src/routes/abexWebhookRoutes.js";
import { AbexClient } from "../src/services/delivery/abexClient.js";
import { DeliverySyncService } from "../src/services/delivery/deliverySyncService.js";
import {
  startDeliverySyncScheduler,
  stopDeliverySyncScheduler,
} from "../src/services/delivery/deliveryScheduler.js";
import { P } from "../../shared/permissions.js";

const path = "/api/webhooks/delivery/abex";
const destination = "00c7191e-83b7-43dd-beda-9d5425cf51d3";
const uuid = (n) => `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const parcelId = uuid(1),
  workflowId = uuid(2);
const stateIds = {
  SHIPPED: uuid(3),
  DELIVERED: uuid(4),
  RETURNING: uuid(5),
  RETURNED: uuid(6),
  FAILED_DELIVERY: uuid(7),
  OUT_FOR_DELIVERY: uuid(8),
  UNKNOWN: uuid(9),
};
// SYNTHETIC INTERNAL CONTRACT ONLY. This is never installed into the real app
// and is not evidence of ABEX topic names, field paths or live behavior.
const fixtureAdapter = {
  contractVerified: true,
  contractVersion: "test-fixture-v1",
  parse(payload) {
    if (payload.fixtureTopic !== "test.parcel")
      return {
        eventType: "test.unrelated",
        notification: null,
        resultCode: "WEBHOOK_UNKNOWN_EVENT",
      };
    return {
      eventType: "test.parcel",
      notification: {
        parcelId: payload.fixtureParcelId,
        ...(payload.fixtureTracking
          ? { trackingNumber: payload.fixtureTracking }
          : {}),
      },
    };
  },
};
let replica, courier, courierUrl, agency, order, shipment, secret, config;
let currentState, updatedAt, responseOverrides, requests, timeout;

before(
  async () => {
    replica = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replica.getUri("isolated_webhooks"));
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
    await ensureWebhookIndexes();
    courier = createServer(async (req, res) => {
      requests.push({ method: req.method, url: req.url });
      assert.equal(req.headers["x-api-key"], "fixture-abex-key");
      assert.equal(req.headers["x-tenant"], "fixture-tenant");
      if (timeout) return; // Real HTTP timeout; no live provider calls.
      const data =
        req.url === "/api/v1/workflows/search"
          ? {
              items: [
                {
                  id: workflowId,
                  states: Object.entries(stateIds).map(([name, id]) => ({
                    id,
                    name,
                    situations: [],
                    transitions: [],
                  })),
                },
              ],
              pageNumber: 1,
              pageSize: 100,
              totalCount: 1,
              totalPages: 1,
              hasNext: false,
            }
          : {
              id: parcelId,
              trackingNumber: shipment.tracking,
              externalId: order.orderNumber,
              tenantId: "fixture-tenant",
              state: { id: stateIds[currentState], name: currentState },
              lastStateUpdateAt: updatedAt.toISOString(),
              ...responseOverrides,
            };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    });
    await new Promise((resolve) => courier.listen(0, "127.0.0.1", resolve));
    courierUrl = `http://127.0.0.1:${courier.address().port}`;
  },
  { timeout: 120000 },
);

after(async () => {
  stopDeliverySyncScheduler();
  courier.closeAllConnections();
  await new Promise((resolve) => courier.close(resolve));
  await mongoose.disconnect();
  await replica.stop();
});

beforeEach(async () => {
  mock.restoreAll();
  await Promise.all(
    [
      DeliveryWebhookEvent,
      DeliveryWebhookWorker,
      DeliveryAgency,
      Order,
      Shipment,
      OrderEvent,
      Expense,
      TrackingEvent,
      AuditLog,
      User,
      Session,
      DeliverySyncSettings,
    ].map((m) => m.deleteMany({})),
  );
  secret = `whsec_${randomBytes(32).toString("base64")}`;
  process.env.ABEX_WEBHOOK_ENABLED = "true";
  process.env.ABEX_WEBHOOK_PROCESSING_ENABLED = "true";
  process.env.ABEX_WEBHOOK_SECRET = secret;
  process.env.ABEX_WEBHOOK_DESTINATION_ID = destination;
  process.env.DELIVERY_SYNC_ENABLED = "false";
  process.env.ABEX_WRITES_ENABLED = "false";
  agency = await DeliveryAgency.create({
    name: "Fixture ABEX",
    code: "ABEX",
    integrationType: "API",
    apiProvider: "ABEX",
    businesses: ["LOGIX", "TAMQO"],
    capabilities: { tracking: true },
  });
  process.env.ABEX_WEBHOOK_AGENCY_ID = String(agency._id);
  config = webhookConfig();
  const id = () => new mongoose.Types.ObjectId();
  order = await Order.create({
    orderNumber: `TEST-${randomUUID()}`,
    customerId: id(),
    location: { wilayaId: id() },
    source: { id: id() },
    businessType: "LOGIX_ONLY",
    items: [
      {
        business: "LOGIX",
        type: "PRODUCT",
        catalogItemId: id(),
        name: "Fixture",
        unitPrice: 1000,
        quantity: 1,
        subtotal: 1000,
      },
    ],
    tamqoRevenue: 0,
    logixRevenue: 1000,
    productRevenue: 1000,
    totalOrderValue: 1400,
    deliveryCharged: 400,
    delivery: { agencyId: agency._id, agencyName: agency.name, type: "HOME" },
    payment: {
      method: "COD",
      amountPaidOnline: 0,
      amountToCollect: 1400,
      amountCollected: 0,
    },
    status: "SHIPPED",
    tracking: { stage: "READY_TO_SHIP", courierOwned: true },
  });
  shipment = await Shipment.create({
    orderId: order._id,
    agencyId: agency._id,
    agencyName: agency.name,
    provider: "ABEX",
    externalId: order.orderNumber,
    tracking: "FIXTURE-TRACKING",
    providerParcelId: parcelId,
    providerUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    providerStateId: stateIds.SHIPPED,
    status: "SHIPPED",
    providerStatus: "SHIPPED",
    providerAccepted: true,
  });
  currentState = "DELIVERED";
  updatedAt = new Date("2026-01-02T00:00:00Z");
  responseOverrides = {};
  requests = [];
  timeout = false;
});

function signed(
  body = "{}",
  { id = randomUUID(), date = new Date(), key = secret } = {},
) {
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(+date / 1000)),
      "webhook-signature": new Webhook(key).sign(id, date, Buffer.from(body)),
    },
  };
}
const send = (message, target = app) =>
  supertest(target).post(path).set(message.headers).send(message.body);
function fixtureApp() {
  const target = express();
  target.use(
    path,
    createAbexWebhookRouter({
      accept: (args) => acceptWebhook({ ...args, adapter: fixtureAdapter }),
    }),
  );
  target.use((error, _req, res, _next) =>
    res
      .status(error.status || 500)
      .json({ error: { code: error.code, message: error.message } }),
  );
  return target;
}
async function notify(overrides = {}) {
  const message = signed(
    JSON.stringify({
      fixtureTopic: "test.parcel",
      fixtureParcelId: parcelId,
      ...overrides,
    }),
  );
  assert.equal((await send(message, fixtureApp())).status, 200);
  return DeliveryWebhookEvent.findOne({
    eventId: message.headers["webhook-id"],
  });
}
function client() {
  const instance = new AbexClient({
    credentials: { apiKey: "fixture-abex-key", tenantId: "fixture-tenant" },
    settings: {
      states: Object.entries(stateIds)
        .filter(([status]) => status !== "UNKNOWN")
        .map(([status, stateId]) => ({ workflowId, stateId, status })),
    },
  });
  instance.http.defaults.timeout = 50;
  // Exercise the real HTTP client and mapper against a loopback courier only.
  instance.http.defaults.adapter = (args) =>
    axios({ ...args, baseURL: courierUrl, adapter: axios.getAdapter("http") });
  return instance;
}
const prepare = (event, cfg) =>
  prepareWebhookRefresh(event, cfg, async () => client());
const worker = () =>
  runWebhookBatch(config, { adapter: fixtureAdapter, prepare });
async function stored(event) {
  return DeliveryWebhookEvent.findById(event._id).lean();
}
async function adminCookie(
  role = "SUPER_ADMIN",
  permissions = [],
  businesses = ["LOGIX", "TAMQO"],
) {
  const user = await User.create({
    name: "Fixture user",
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused-fixture-hash",
    role,
    permissions,
    businessAccess: businesses,
  });
  const token = randomBytes(32).toString("hex");
  await Session.create({
    userId: user._id,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 60000),
  });
  return `workspace_session=${token}`;
}

test("real app accepts an exact-byte signed JSON body without a browser session and persists only safe metadata", async () => {
  const body =
    '{\n  "customer": "DO-NOT-STORE-PII", "type": "shipment.delivered", "data": {"status":"DELIVERED"}\n}';
  const response = await send(signed(body));
  assert.equal(response.status, 200);
  const event = await DeliveryWebhookEvent.findOne().lean();
  assert.equal(
    event.payloadHash,
    createHash("sha256").update(body).digest("hex"),
  );
  assert.equal(event.payloadMetadata.byteLength, Buffer.byteLength(body));
  assert.equal(event.eventType, "UNVERIFIED");
  assert.ok(!JSON.stringify(event).includes("DO-NOT-STORE-PII"));
  assert.equal(await OrderEvent.countDocuments(), 0);
});

for (const scenario of [
  "missing",
  "wrong key",
  "body changed",
  "expired",
  "future",
  "malformed timestamp",
  "duplicate header",
]) {
  test(`signature authentication rejects ${scenario} before persistence`, async () => {
    const message = signed("{}", {
      key:
        scenario === "wrong key"
          ? `whsec_${randomBytes(32).toString("base64")}`
          : secret,
      date: new Date(
        Date.now() +
          (scenario === "expired"
            ? -360000
            : scenario === "future"
              ? 360000
              : 0),
      ),
    });
    if (scenario === "missing") delete message.headers["webhook-signature"];
    if (scenario === "body changed") message.body = '{"changed":true}';
    if (scenario === "malformed timestamp")
      message.headers["webhook-timestamp"] += "junk";
    if (scenario === "duplicate header")
      message.headers["webhook-id"] = [message.headers["webhook-id"], "other"];
    assert.equal((await send(message)).status, 401);
    assert.equal(await DeliveryWebhookEvent.countDocuments(), 0);
  });
}

test("versioned multiple signatures support rotation while whitespace changes invalidate the body", async () => {
  const message = signed('{ "sample": true }');
  message.headers["webhook-signature"] =
    `v9,unknown v1,invalid ${message.headers["webhook-signature"]}`;
  assert.equal((await send(message)).status, 200);
  message.body = '{"sample":true}';
  assert.equal((await send(message)).status, 401);
});

for (const body of ['{"broken":', "[]", "null", '"text"']) {
  test(`authenticated malformed or unsupported JSON (${body}) fails safely`, async () => {
    const response = await send(signed(body));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "WEBHOOK_SCHEMA_INVALID");
    assert.equal(await DeliveryWebhookEvent.countDocuments(), 0);
  });
}

test("receiver rejects methods, unsupported content, compressed requests and oversized bodies", async () => {
  for (const method of ["get", "put", "patch", "delete", "options", "head"]) {
    const result = await supertest(app)[method](path);
    assert.equal(result.status, 405, method);
    assert.equal(result.headers.allow, "POST");
  }
  const wrongType = signed();
  wrongType.headers["Content-Type"] = "text/plain";
  assert.equal((await send(wrongType)).status, 415);
  const compressed = signed();
  compressed.headers["Content-Encoding"] = "gzip";
  assert.equal((await send(compressed)).status, 415);
  assert.equal(
    (await send(signed(JSON.stringify({ data: "x".repeat(160000) })))).status,
    413,
  );
});

test("missing or malformed secrets fail closed, including enabled production startup validation", async () => {
  for (const value of [
    "",
    "invalid",
    "whsec_",
    `whsec_${Buffer.from("short").toString("base64")}`,
  ]) {
    process.env.ABEX_WEBHOOK_SECRET = value;
    assert.throws(() => validateWebhookConfig());
    assert.equal((await send(signed())).status, 503);
  }
  process.env.ABEX_WEBHOOK_SECRET = secret;
  process.env.ABEX_WEBHOOK_ENABLED = "false";
  assert.equal((await send(signed())).status, 503);
  assert.equal(await DeliveryWebhookEvent.countDocuments(), 0);
});

test("concurrent duplicate IDs persist once; changed bodies under the same ID conflict", async () => {
  const message = signed('{"fixture":true}');
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => send(message)),
  );
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal(responses.filter((r) => !r.body.duplicate).length, 1);
  assert.equal(await DeliveryWebhookEvent.countDocuments(), 1);
  const conflict = signed('{"fixture":false}', {
    id: message.headers["webhook-id"],
  });
  assert.equal((await send(conflict)).status, 409);
});

test("a MongoDB insert failure returns a retryable error without exposing internal details", async () => {
  const fail = mock.method(DeliveryWebhookEvent, "create", async () => {
    throw new Error("sensitive database URL");
  });
  const response = await send(signed());
  fail.mock.restore();
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, "WEBHOOK_DEPENDENCY_UNAVAILABLE");
  assert.ok(!JSON.stringify(response.body).includes("sensitive"));
  assert.equal(await DeliveryWebhookEvent.countDocuments(), 0);
});

test("an actual disconnected MongoDB connection returns 503 without acknowledging or buffering the event", async () => {
  await mongoose.disconnect();
  try {
    const result = await send(signed());
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "WEBHOOK_DEPENDENCY_UNAVAILABLE");
  } finally {
    await mongoose.connect(replica.getUri("isolated_webhooks"));
  }
  assert.equal(await DeliveryWebhookEvent.countDocuments(), 0);
});

test("unverified live topics remain observable and never invoke a provider", async () => {
  await send(
    signed(
      '{"type":"parcel.updated","parcelId":"ignored","status":"DELIVERED"}',
    ),
  );
  await runWebhookBatch(config);
  const event = await DeliveryWebhookEvent.findOne().lean();
  assert.equal(event.processingStatus, "IGNORED");
  assert.equal(event.resultCode, "ABEX_CONTRACT_UNVERIFIED");
  assert.equal((await Order.findById(order._id)).status, "SHIPPED");
  assert.deepEqual(requests, []);
  assert.ok(event.expiresAt);
});

test("synthetic supported notification fetches one authoritative parcel and applies a permitted delivery once", async () => {
  const event = await notify();
  await worker();
  assert.equal((await stored(event)).processingStatus, "PROCESSED");
  assert.equal((await Order.findById(order._id)).status, "DELIVERED");
  assert.equal((await Order.findById(order._id)).payment.amountCollected, 0);
  assert.equal(await OrderEvent.countDocuments({ type: "ORDER_DELIVERED" }), 1);
  assert.equal(await AuditLog.countDocuments({ action: "ORDER_DELIVERED" }), 1);
  assert.deepEqual(
    requests.map((r) => r.url),
    ["/api/v1/parcels/FIXTURE-TRACKING", "/api/v1/workflows/search"],
  );
  await worker();
  assert.equal(await OrderEvent.countDocuments({ type: "ORDER_DELIVERED" }), 1);
});

test("recognized notification without a local parcel remains durable for later linking", async () => {
  const event = await notify({ fixtureParcelId: uuid(999) });
  await worker();
  const value = await stored(event);
  assert.equal(value.processingStatus, "RETRY_PENDING");
  assert.equal(value.lastErrorCode, "WEBHOOK_SHIPMENT_NOT_LINKED");
  assert.ok(value.nextRetryAt > new Date());
  assert.equal(requests.length, 0);
  assert.equal(value.expiresAt, undefined);
  await Shipment.updateOne(
    { _id: shipment._id },
    { providerParcelId: uuid(999) },
  );
  responseOverrides.id = uuid(999);
  await DeliveryWebhookEvent.updateOne(
    { _id: event._id },
    { nextRetryAt: new Date(0) },
  );
  await worker();
  assert.equal((await stored(event)).processingStatus, "PROCESSED");
  assert.equal((await Order.findById(order._id)).status, "DELIVERED");
});

for (const mismatch of [
  "event tracking",
  "provider tracking",
  "provider parcel",
  "provider reference",
  "provider tenant",
  "order agency",
  "shipment agency",
  "destination binding",
]) {
  test(`${mismatch} mismatch cannot mutate an order`, async () => {
    const event = await notify(
      mismatch === "event tracking"
        ? { fixtureTracking: "OTHER-TRACKING" }
        : {},
    );
    if (mismatch === "provider tracking")
      responseOverrides.trackingNumber = "OTHER-TRACKING";
    if (mismatch === "provider parcel") responseOverrides.id = uuid(999);
    if (mismatch === "provider reference")
      responseOverrides.externalId = "OTHER-ORDER";
    if (mismatch === "provider tenant")
      responseOverrides.tenantId = "OTHER-TENANT";
    if (mismatch === "order agency")
      await Order.updateOne(
        { _id: order._id },
        { "delivery.agencyId": new mongoose.Types.ObjectId() },
      );
    if (mismatch === "shipment agency")
      await Shipment.updateOne(
        { _id: shipment._id },
        { agencyId: new mongoose.Types.ObjectId() },
      );
    if (mismatch === "destination binding")
      config.agencyId = String(new mongoose.Types.ObjectId());
    await worker();
    assert.equal((await Order.findById(order._id)).status, "SHIPPED");
    assert.equal(await OrderEvent.countDocuments(), 0);
    assert.ok(
      ["FAILED", "RETRY_PENDING"].includes(
        (await stored(event)).processingStatus,
      ),
    );
  });
}

test("older authoritative observations cannot revert a newer accepted state", async () => {
  await notify();
  await worker();
  const old = await notify();
  currentState = "OUT_FOR_DELIVERY";
  updatedAt = new Date("2026-01-01T12:00:00Z");
  await worker();
  assert.equal((await Order.findById(order._id)).status, "DELIVERED");
  assert.equal((await stored(old)).resultCode, "DELIVERY_STALE_OBSERVATION");
  assert.equal(await OrderEvent.countDocuments({ type: "ORDER_DELIVERED" }), 1);
});

test("production and manual correction rules take precedence over provider state", async () => {
  await Order.updateOne(
    { _id: order._id },
    {
      status: "PREPARING",
      "tracking.stage": "AT_PRODUCTION",
      "tracking.courierOwned": false,
    },
  );
  const event = await notify();
  await worker();
  assert.equal((await Order.findById(order._id)).status, "PREPARING");
  assert.equal(
    (await stored(event)).lastErrorCode,
    "DELIVERY_PRODUCTION_BLOCKED",
  );
  await Order.updateOne({ _id: order._id }, { status: "CANCELLED" });
  const corrected = await notify();
  await worker();
  assert.equal((await Order.findById(order._id)).status, "CANCELLED");
  assert.equal((await stored(corrected)).processingStatus, "FAILED");
  assert.equal(await OrderEvent.countDocuments(), 0);
});

test("return completion and overlapping polling/webhooks create one expense and one transition history", async () => {
  currentState = "RETURNING";
  const event = await notify();
  const snapshot = await client().getShipment(shipment);
  await Promise.all([
    worker(),
    new DeliverySyncService(client(), agency._id).applyWithResult(
      order._id,
      snapshot,
    ),
  ]);
  assert.equal((await stored(event)).processingStatus, "PROCESSED");
  assert.equal(await Expense.countDocuments({ sourceOrderId: order._id }), 1);
  assert.equal(await OrderEvent.countDocuments({ type: "ORDER_RETURNING" }), 1);
  currentState = "RETURNED";
  updatedAt = new Date("2026-01-03T00:00:00Z");
  await Promise.all([notify(), notify()]);
  await Promise.all([worker(), worker()]);
  assert.equal((await Order.findById(order._id)).status, "RETURNED");
  assert.equal(await Expense.countDocuments({ sourceOrderId: order._id }), 1);
  assert.equal((await Expense.findOne()).amount, 150);
  assert.equal(
    await AuditLog.countDocuments({ action: "DELIVERY_RETURN_FEE_CREATED" }),
    1,
  );
  assert.equal(await OrderEvent.countDocuments({ type: "ORDER_RETURNED" }), 1);
});

test("failed delivery follows the existing transition and audit path; unknown provider states are never guessed", async () => {
  currentState = "FAILED_DELIVERY";
  const failed = await notify();
  await worker();
  assert.equal((await stored(failed)).processingStatus, "PROCESSED");
  assert.equal((await Order.findById(order._id)).status, "FAILED_DELIVERY");
  assert.equal(
    await AuditLog.countDocuments({ action: "ORDER_FAILED_DELIVERY" }),
    1,
  );
  currentState = "UNKNOWN";
  updatedAt = new Date("2026-01-03T00:00:00Z");
  const unknown = await notify();
  await worker();
  assert.equal((await Order.findById(order._id)).status, "FAILED_DELIVERY");
  assert.equal((await stored(unknown)).resultCode, "WEBHOOK_UNMAPPED_STATUS");
  assert.equal(
    (await Shipment.findById(shipment._id)).providerStatus,
    "UNKNOWN",
  );
});

test("concurrent workers atomically claim a single event and commit consistent delivery effects", async () => {
  const event = await notify();
  const claims = await Promise.all(
    Array.from({ length: 6 }, () => claimWebhook(config)),
  );
  assert.equal(claims.filter(Boolean).length, 1);
  await processWebhookClaim(claims.find(Boolean), config, {
    adapter: fixtureAdapter,
    prepare,
  });
  assert.equal((await stored(event)).attemptCount, 1);
  assert.equal(await OrderEvent.countDocuments({ type: "ORDER_DELIVERED" }), 1);
});

test("ABEX HTTP timeouts schedule durable bounded retries and never send provider writes", async () => {
  const event = await notify();
  timeout = true;
  await worker();
  let value = await stored(event);
  assert.equal(value.processingStatus, "RETRY_PENDING");
  assert.equal(value.lastErrorCode, "ABEX_TIMEOUT");
  assert.equal(requests.length, 2); // Client's one bounded read retry.
  assert.ok(requests.every((r) => r.method === "GET"));
  config.maxAttempts = 2;
  await DeliveryWebhookEvent.updateOne(
    { _id: event._id },
    { nextRetryAt: new Date(0) },
  );
  await worker();
  value = await stored(event);
  assert.equal(value.processingStatus, "FAILED");
  assert.equal(value.attemptCount, 2);
  assert.ok(value.expiresAt > new Date());
});

test("crashed worker leases are recoverable and stale claim tokens cannot commit", async () => {
  const event = await notify();
  const abandoned = await claimWebhook(config);
  await DeliveryWebhookEvent.updateOne(
    { _id: event._id },
    { lockedUntil: new Date(0) },
  );
  const recovered = await claimWebhook(config);
  assert.ok(recovered.lockToken !== abandoned.lockToken);
  await processWebhookClaim(abandoned, config, {
    adapter: fixtureAdapter,
    prepare,
  });
  assert.equal((await Order.findById(order._id)).status, "SHIPPED");
  await processWebhookClaim(recovered, config, {
    adapter: fixtureAdapter,
    prepare,
  });
  assert.equal((await stored(event)).processingStatus, "PROCESSED");
  assert.equal((await stored(event)).attemptCount, 2);
  assert.equal(await OrderEvent.countDocuments({ type: "ORDER_DELIVERED" }), 1);
});

test("repeated worker crashes exhaust the durable budget without abandoning an invisible processing row", async () => {
  const event = await notify();
  config.maxAttempts = 2;
  for (let i = 0; i < 2; i++) {
    assert.ok(await claimWebhook(config));
    await DeliveryWebhookEvent.updateOne(
      { _id: event._id },
      { lockedUntil: new Date(0) },
    );
  }
  assert.equal(await claimWebhook(config), null);
  const value = await stored(event);
  assert.equal(value.processingStatus, "FAILED");
  assert.equal(value.lastErrorCode, "WEBHOOK_ATTEMPTS_EXHAUSTED");
  assert.ok(value.expiresAt > new Date());
  assert.equal(await OrderEvent.countDocuments(), 0);
});

test("a provider readiness reservation causes a retry instead of a false successful processing result", async () => {
  const event = await notify();
  await Shipment.updateOne(
    { _id: shipment._id },
    { lockUntil: new Date(Date.now() + 60000) },
  );
  await worker();
  assert.equal((await stored(event)).processingStatus, "RETRY_PENDING");
  assert.equal((await stored(event)).lastErrorCode, "DELIVERY_OPERATION_BUSY");
  assert.equal((await Order.findById(order._id)).status, "SHIPPED");
});

test("a failure completing the inbox transaction rolls back delivery and finance effects", async () => {
  currentState = "RETURNING";
  const event = await notify();
  const original = DeliveryWebhookEvent.updateOne.bind(DeliveryWebhookEvent);
  const fail = mock.method(
    DeliveryWebhookEvent,
    "updateOne",
    (filter, update, options) => {
      if (update.$set?.processingStatus === "PROCESSED")
        throw new Error("fixture commit failure");
      return original(filter, update, options);
    },
  );
  await worker();
  fail.mock.restore();
  assert.equal((await Order.findById(order._id)).status, "SHIPPED");
  assert.equal(await Expense.countDocuments(), 0);
  assert.equal(await OrderEvent.countDocuments(), 0);
  assert.equal((await stored(event)).processingStatus, "RETRY_PENDING");
  await DeliveryWebhookEvent.updateOne(
    { _id: event._id },
    { nextRetryAt: new Date(0) },
  );
  await worker();
  assert.equal(await Expense.countDocuments(), 1);
  assert.equal((await stored(event)).processingStatus, "PROCESSED");
});

test("disabled cron makes no scheduled bulk calls while webhook processing and manual sync still work", async () => {
  let ticks,
    calls = 0;
  await DeliverySyncSettings.create({
    _id: "delivery-sync",
    cronEnabled: false,
    intervalMinutes: 1,
    loggingEnabled: true,
  });
  await startDeliverySyncScheduler({
    sync: async () => {
      calls++;
    },
    setIntervalFn: (fn) => {
      ticks = fn;
      return 1;
    },
    clearIntervalFn: () => {},
  });
  ticks();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  await notify();
  await worker();
  assert.equal((await Order.findById(order._id)).status, "DELIVERED");
  const cookie = await adminCookie();
  const manual = await supertest(app)
    .post("/api/delivery-sync/run")
    .set("Cookie", cookie);
  assert.equal(manual.status, 200); // No active eligible rows; no real provider.
  assert.equal(
    (
      await supertest(app)
        .get("/api/delivery-sync/status")
        .set("Cookie", cookie)
    ).body.cronEnabled,
    false,
  );
  stopDeliverySyncScheduler();
});

test("processing can be paused without losing authenticated events", async () => {
  const event = await notify();
  await runWebhookBatch(
    { ...config, processingEnabled: false },
    { adapter: fixtureAdapter, prepare },
  );
  assert.equal((await stored(event)).processingStatus, "RECEIVED");
  assert.equal(requests.length, 0);
  await worker();
  assert.equal((await stored(event)).processingStatus, "PROCESSED");
});

test("manual tracking refresh remains available with polling disabled and overlaps without duplicate effects", async () => {
  const event = await notify();
  await new DeliverySyncService(client(), agency._id).refresh(order._id);
  await worker();
  assert.equal((await stored(event)).processingStatus, "PROCESSED");
  assert.equal(await OrderEvent.countDocuments({ type: "ORDER_DELIVERED" }), 1);
});

test("endpoint-specific rate limiting rejects bursts without exposing another public CRM operation", async () => {
  const target = fixtureApp();
  // Missing signatures avoid database work while exercising the real limiter.
  for (let i = 0; i < 300; i++)
    assert.equal(
      (
        await supertest(target)
          .post(path)
          .set("Content-Type", "application/json")
          .send("{}")
      ).status,
      401,
    );
  const limited = await supertest(target)
    .post(path)
    .set("Content-Type", "application/json")
    .send("{}");
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "WEBHOOK_RATE_LIMIT");
  assert.equal(await DeliveryWebhookEvent.countDocuments(), 0);
});

test("an administrator retry rechecks current transition rules instead of forcing a saved result", async () => {
  const event = await notify();
  await DeliveryWebhookEvent.updateOne(
    { _id: event._id },
    { processingStatus: "FAILED" },
  );
  const cookie = await adminCookie();
  assert.equal(
    (
      await supertest(app)
        .post(`/api/delivery-sync/webhooks/events/${event._id}/retry`)
        .set("Cookie", cookie)
    ).status,
    200,
  );
  await Order.updateOne({ _id: order._id }, { status: "CANCELLED" });
  await worker();
  assert.equal((await Order.findById(order._id)).status, "CANCELLED");
  assert.equal((await stored(event)).processingStatus, "FAILED");
  assert.equal(await OrderEvent.countDocuments(), 0);
});

test("unknown synthetic topics and invalid notification identifiers are stored without dispatch", async () => {
  const ignored = await notify({ fixtureTopic: "unrelated" });
  const invalid = await notify({ fixtureParcelId: { $ne: null } });
  await worker();
  assert.equal((await stored(ignored)).processingStatus, "IGNORED");
  assert.equal((await stored(invalid)).processingStatus, "FAILED");
  assert.equal(requests.length, 0);
});

test("admin APIs require authentication, permissions, agency scope and bounded audited retries", async () => {
  const event = await notify();
  await DeliveryWebhookEvent.updateOne(
    { _id: event._id },
    { processingStatus: "FAILED", retryCount: 8 },
  );
  const route = `/api/delivery-sync/webhooks/events/${event._id}`;
  assert.equal((await supertest(app).get(route)).status, 401);
  const noPermission = await adminCookie("ADMIN");
  assert.equal(
    (await supertest(app).post(`${route}/retry`).set("Cookie", noPermission))
      .status,
    403,
  );
  const employee = await adminCookie("EMPLOYEE", [
    P.deliverySync.view,
    P.deliverySync.run,
  ]);
  assert.equal(
    (await supertest(app).post(`${route}/retry`).set("Cookie", employee))
      .status,
    403,
  );
  const outsider = await adminCookie(
    "ADMIN",
    [P.deliverySync.view, P.deliverySync.run],
    ["TAMQO"],
  );
  assert.equal(
    (await supertest(app).get(route).set("Cookie", outsider)).status,
    404,
  );
  assert.equal(
    (await supertest(app).post(`${route}/retry`).set("Cookie", outsider))
      .status,
    404,
  );
  const admin = await adminCookie("ADMIN", [
    P.deliverySync.view,
    P.deliverySync.run,
  ]);
  for (let i = 0; i < 5; i++) {
    const response = await supertest(app)
      .post(`${route}/retry`)
      .set("Cookie", admin);
    assert.equal(response.status, 200);
    assert.equal(response.body.recoveryCount, i + 1);
    assert.equal(response.body.retryCount, 0);
    assert.equal(response.body.lockToken, undefined);
  }
  assert.equal(
    (await supertest(app).post(`${route}/retry`).set("Cookie", admin)).status,
    409,
  );
  assert.equal(
    await AuditLog.countDocuments({ action: "DELIVERY_WEBHOOK_RETRY" }),
    5,
  );
});

test("agency reassignment cannot broaden access to previously received parcel identifiers", async () => {
  const event = await notify();
  await DeliveryAgency.updateOne(
    { _id: agency._id },
    { businesses: ["TAMQO"] },
  );
  const cookie = await adminCookie("ADMIN", [P.deliverySync.view], ["TAMQO"]);
  const details = await supertest(app)
    .get(`/api/delivery-sync/webhooks/events/${event._id}`)
    .set("Cookie", cookie);
  assert.equal(details.status, 404);
  const list = await supertest(app)
    .get("/api/delivery-sync/webhooks/events")
    .set("Cookie", cookie);
  assert.equal(list.body.total, 0);
});

test("event health, filters and details expose sanitized operational facts without claiming live support", async () => {
  const event = await notify();
  await worker();
  const cookie = await adminCookie();
  const health = await supertest(app)
    .get("/api/delivery-sync/webhooks/status")
    .set("Cookie", cookie);
  assert.equal(health.status, 200);
  assert.equal(health.body.contractVerified, false);
  assert.equal(health.body.mutationsEnabled, false);
  assert.ok(health.body.lastReceivedAt);
  assert.ok(!JSON.stringify(health.body).includes(secret));
  const list = await supertest(app)
    .get("/api/delivery-sync/webhooks/events")
    .query({
      status: "PROCESSED",
      eventType: "test.parcel",
      agencyId: String(agency._id),
      search: shipment.tracking,
      from: new Date(Date.now() - 60000).toISOString(),
      to: new Date().toISOString(),
      limit: 1,
    })
    .set("Cookie", cookie);
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items.length, 1);
  const detail = await supertest(app)
    .get(`/api/delivery-sync/webhooks/events/${event._id}`)
    .set("Cookie", cookie);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.lockToken, undefined);
  assert.equal(detail.body.retryEligible, false);
  assert.equal(
    (
      await supertest(app)
        .get("/api/delivery-sync/webhooks/events")
        .query({ agencyId: '{"$ne":null}' })
        .set("Cookie", cookie)
    ).status,
    400,
  );
  assert.equal(
    (
      await supertest(app)
        .get("/api/delivery-sync/webhooks/events/bad-id")
        .set("Cookie", cookie)
    ).status,
    400,
  );
  assert.equal(abexWebhookAdapter.contractVerified, false);
});

test("public webhook mount leaves browser-origin checks and every other CRM operation protected", async () => {
  assert.equal((await supertest(app).get("/api/orders")).status, 401);
  const cookie = await adminCookie();
  assert.equal(
    (
      await supertest(app)
        .put("/api/delivery-sync/settings")
        .set("Cookie", cookie)
        .set("Origin", "https://untrusted.example")
        .send({ cronEnabled: false })
    ).status,
    403,
  );
  const event = signed();
  event.headers.Origin = "https://provider.example";
  assert.equal((await send(event)).status, 200);
});
