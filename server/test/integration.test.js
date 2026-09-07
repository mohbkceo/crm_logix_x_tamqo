import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import supertest from "supertest";
import { app } from "../src/app.js";
import { seed } from "../src/seed.js";
import {
  Order,
  OrderEvent,
  Shipment,
  Customer,
  TamqoPlan,
  LogixProduct,
  OrderSource,
  Wilaya,
  Expense,
  ExpenseCategory,
} from "../src/models/index.js";
import { createOrder, transition } from "../src/services/orderService.js";
import { DeliverySyncService } from "../src/services/delivery/deliverySyncService.js";
import { AppError } from "../src/errors.js";
import bcrypt from "bcryptjs";
import {
  AuditLog,
  RegistrationSetting,
  Session,
  User,
} from "../src/models/security.js";
import { DeliveryAgency, DeliveryRate } from "../src/models/delivery.js";
import { migrate } from "../src/migrate.js";
import { P } from "../../shared/permissions.js";
import { createServer } from "node:http";
import { encryptCredentials } from "../src/services/delivery/credentials.js";
import { providerFor } from "../src/services/delivery/deliveryProviderFactory.js";
let replica, plan, product, source, wilaya, apiAgent;
const request = () => apiAgent;
before(
  async () => {
    // Automatic order shipping must never use a developer's live credentials.
    delete process.env.DELIVERY_API_TOKEN;
    delete process.env.DELIVERY_API_KEY;
    replica = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replica.getUri("test_workspace"));
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
    await seed();
    // Production seed now owns only Wilaya rates. Domain fixtures belong here.
    await TamqoPlan.create([
      { name: "3 Months", price: 4000, durationDays: 90 },
      { name: "6 Months", price: 7000, durationDays: 180 },
    ]);
    await LogixProduct.create({ name: "20cm Plaque", price: 3500 });
    await OrderSource.create({ name: "Messages", isDefault: true });
    await ExpenseCategory.create([
      { business: "LOGIX", name: "Materials" },
      { business: "TAMQO", name: "Software" },
    ]);
    await migrate();
    const abex = await DeliveryAgency.findOne({ code: "ABEX" });
    const testWilaya = await Wilaya.findOne({ agencyId: "16" });
    await DeliveryRate.updateOne(
      { agencyId: abex._id, wilayaId: testWilaya._id },
      { homePrice: 500, deskPrice: 300 },
    );
    const passwordHash = await bcrypt.hash("test-only-password", 4);
    await User.create({
      name: "Test Super Admin",
      email: "qa@example.com",
      passwordHash,
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      businessAccess: ["LOGIX", "TAMQO"],
      permissions: [],
    });
    apiAgent = supertest.agent(app);
    expectOk(
      await apiAgent
        .post("/api/auth/login")
        .send({ email: "qa@example.com", password: "test-only-password" }),
    );
    plan = await TamqoPlan.findOne({ name: "3 Months" });
    product = await LogixProduct.findOne({ name: "20cm Plaque" });
    source = await OrderSource.findOne({ isDefault: true });
    wilaya = await Wilaya.findOne({ agencyId: "16" });
  },
  { timeout: 300000 },
);
after(async () => {
  await mongoose.disconnect();
  await replica?.stop();
});
beforeEach(async () => {
  for (const Model of [Order, OrderEvent, Shipment, Customer, Expense])
    await Model.deleteMany({});
});
function input(kind = "PARTNERSHIP", overrides = {}) {
  return {
    customer: { name: "Test Customer", phoneA: "0550123456", phoneB: "" },
    location: {
      wilayaId: String(wilaya._id),
      commune: "Alger Centre",
      address: "12 Test Street",
    },
    sourceId: String(source._id),
    items: [
      ...(kind !== "LOGIX_ONLY"
        ? [{ business: "TAMQO", catalogItemId: String(plan._id), quantity: 1 }]
        : []),
      ...(kind !== "TAMQO_ONLY"
        ? [
            {
              business: "LOGIX",
              catalogItemId: String(product._id),
              quantity: 2,
            },
          ]
        : []),
    ],
    delivery: { type: "HOME", exchange: false },
    payment: { method: "COD", amountPaidOnline: 0 },
    note: "Test order",
    ...overrides,
  };
}
const expectOk = (r) => {
  assert.ok(r.status < 300, JSON.stringify(r.body));
  return r.body;
};
test("seeds 58 Wilayas and fixtures provide one active default", async () => {
  assert.equal(await Wilaya.countDocuments(), 58);
  assert.equal(
    await OrderSource.countDocuments({ active: true, isDefault: true }),
    1,
  );
});
test("Tamqo-only, Logix-only and partnership use server catalog prices", async () => {
  for (const kind of ["TAMQO_ONLY", "LOGIX_ONLY", "PARTNERSHIP"]) {
    const r = expectOk(
      await request(app)
        .post("/api/orders")
        .send({ ...input(kind), productRevenue: 1, businessType: "WRONG" }),
    );
    assert.equal(r.businessType, kind);
    assert.equal(r.deliveryCharged, 500);
    assert.equal(
      r.productRevenue,
      kind === "TAMQO_ONLY" ? 4000 : kind === "LOGIX_ONLY" ? 7000 : 11000,
    );
    assert.match(r.orderNumber, /^ORD-\d{4}-\d{6}$/);
  }
});
test("manual prices, quantities, delivery overrides and stop desk defaults", async () => {
  const data = input();
  data.items[0].unitPrice = 3000;
  data.items[0].quantity = 2;
  data.deliveryCharged = 123.5;
  const r = expectOk(await request(app).post("/api/orders").send(data));
  assert.equal(r.tamqoRevenue, 6000);
  assert.equal(r.totalOrderValue, 13123.5);
  const desk = expectOk(
    await request(app)
      .post("/api/orders")
      .send(
        input("LOGIX_ONLY", {
          delivery: { type: "STOP_DESK", exchange: true },
        }),
      ),
  );
  assert.equal(desk.deliveryCharged, 300);
});
test("online and mixed orders preserve internal revenue", async () => {
  for (const [method, paid, collect] of [
    ["ONLINE", 11500, 0],
    ["MIXED", 11000, 500],
  ]) {
    const r = expectOk(
      await request(app)
        .post("/api/orders")
        .send(
          input("PARTNERSHIP", { payment: { method, amountPaidOnline: paid } }),
        ),
    );
    assert.equal(r.productRevenue, 11000);
    assert.equal(r.payment.amountToCollect, collect);
  }
});
test("invalid order data never writes orders or customer records", async () => {
  const data = input();
  data.items[0].quantity = 0;
  assert.equal((await request(app).post("/api/orders").send(data)).status, 400);
  assert.equal(await Order.countDocuments(), 0);
  assert.equal(await Customer.countDocuments(), 0);
  assert.equal(
    (
      await request(app)
        .post("/api/orders")
        .send(
          input("PARTNERSHIP", {
            payment: { method: "MIXED", amountPaidOnline: 50000 },
          }),
        )
    ).status,
    400,
  );
  assert.equal(await Customer.countDocuments(), 0);
});
test("normalized phone identity joins formatted repeat purchases", async () => {
  await createOrder(input());
  await createOrder(
    input("TAMQO_ONLY", {
      customer: { name: "Same Customer", phoneA: "+213550123456" },
    }),
  );
  assert.equal(await Customer.countDocuments(), 1);
  const customers = expectOk(await request(app).get("/api/customers"));
  assert.equal(customers.items[0].orders, 2);
});
test("catalog renames and price changes do not mutate order snapshots", async () => {
  const order = await createOrder(input());
  expectOk(
    await request(app)
      .patch("/api/config/plans/" + plan._id)
      .send({ price: 4500, name: "Quarterly plan" }),
  );
  const saved = await Order.findById(order._id);
  assert.equal(saved.items[0].name, "3 Months");
  assert.equal(saved.items[0].unitPrice, 4000);
  const edited = input();
  edited.revision = 0;
  edited.items[0].unitPrice = 4000;
  const result = expectOk(
    await request(app)
      .patch("/api/orders/" + order._id)
      .send(edited),
  );
  assert.equal(result.items[0].name, "3 Months");
  await TamqoPlan.updateOne(
    { _id: plan._id },
    { $set: { price: 4000, name: "3 Months" } },
  );
});
test("source switching maintains exactly one active default", async () => {
  const second = expectOk(
    await request(app)
      .post("/api/config/sources")
      .send({ name: "Website", active: true, isDefault: false, sortOrder: 1 }),
  );
  expectOk(
    await request(app)
      .patch("/api/config/sources/" + second._id)
      .send({ isDefault: true }),
  );
  assert.equal(
    await OrderSource.countDocuments({ active: true, isDefault: true }),
    1,
  );
  assert.equal(
    (await request(app).delete("/api/config/sources/" + second._id)).status,
    400,
  );
  expectOk(
    await request(app)
      .patch("/api/config/sources/" + source._id)
      .send({ isDefault: true }),
  );
});
test("configuration ordering persists atomically", async () => {
  const plans = await TamqoPlan.find().sort({ sortOrder: 1 });
  expectOk(
    await request(app)
      .post("/api/config/plans/reorder")
      .send({ ids: plans.map((p) => String(p._id)).reverse() }),
  );
  const after = await TamqoPlan.find().sort({ sortOrder: 1 });
  assert.equal(String(after[0]._id), String(plans.at(-1)._id));
  assert.equal(
    (
      await request(app)
        .post("/api/config/plans/reorder")
        .send({ ids: [String(plan._id)] })
    ).status,
    400,
  );
});
test("concurrent numbers are unique, immutable and status history is not duplicated", async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      createOrder(
        input("TAMQO_ONLY", {
          customer: { name: "Customer " + i, phoneA: "055012345" + i },
        }),
      ),
    ),
  );
  assert.equal(new Set(results.map((o) => o.orderNumber)).size, 5);
  const id = results[0]._id;
  await transition(id, "CONFIRMED");
  await transition(id, "CONFIRMED");
  assert.equal(
    await OrderEvent.countDocuments({ orderId: id, kind: "STATUS" }),
    1,
  );
  assert.equal(
    (
      await request(app)
        .post(`/api/orders/${id}/status`)
        .send({ status: "SHIPPED" })
    ).status,
    409,
  );
});
test("optimistic revisions reject stale editing and edits are audited", async () => {
  const order = await createOrder(input());
  const data = { ...input(), note: "Edited", revision: 0 };
  expectOk(
    await request(app)
      .patch("/api/orders/" + order._id)
      .send(data),
  );
  assert.equal(
    (
      await request(app)
        .patch("/api/orders/" + order._id)
        .send(data)
    ).status,
    409,
  );
  assert.equal(
    await OrderEvent.countDocuments({ orderId: order._id, kind: "EDITED" }),
    1,
  );
  assert.equal(
    (await Order.findById(order._id)).originalData.note,
    "Test order",
  );
});
test("courier failure preserves the order and retries with lire only", async () => {
  const o = await createOrder(input());
  await transition(o._id, "CONFIRMED");
  let calls = 0;
  const service = new DeliverySyncService({
    ensureConfigured() {},
    async createPackages() {
      calls++;
      throw new AppError("Courier timed out.", 502);
    },
  });
  await assert.rejects(service.create(o._id));
  assert.ok(await Order.findById(o._id));
  const s = await Shipment.findOne({ orderId: o._id });
  assert.equal(s.syncStatus, "ERROR");
  assert.equal(s.uncertain, true);
  const retry = await service.create(o._id);
  assert.equal(retry.syncStatus, "PENDING");
  assert.equal(retry.uncertain, true);
  assert.equal(calls, 1);
});
test("missing credentials allow safe retry without an external creation attempt", async () => {
  const o = await createOrder(input());
  await transition(o._id, "CONFIRMED");
  const service = new DeliverySyncService({
    ensureConfigured() {
      throw new AppError("Not configured", 503);
    },
  });
  await assert.rejects(service.create(o._id));
  const s = await Shipment.findOne({ orderId: o._id });
  assert.equal(s.syncStatus, "ERROR");
  assert.equal(s.creationAttemptedAt, undefined);
});
test("shipment tracking refresh updates mapped status once and retains unknown values", async () => {
  const o = await createOrder(input());
  await transition(o._id, "CONFIRMED");
  await transition(o._id, "PREPARING");
  let providerStatus = "ready-code",
    calls = 0;
  process.env.DELIVERY_STATUS_MAP = JSON.stringify({
    "ready-code": "READY_TO_SHIP",
    "shipped-code": "SHIPPED",
  });
  const client = {
    ensureConfigured() {},
    async createPackages() {
      calls++;
      return {
        Colis: [
          { MessageRetour: "Good", Tracking: "AAA001", Statut: providerStatus },
        ],
      };
    },
    async readPackages() {
      return {
        Colis: [
          { MessageRetour: "Good", Tracking: "AAA001", Statut: providerStatus },
        ],
      };
    },
  };
  const service = new DeliverySyncService(client);
  await service.create(o._id);
  await service.create(o._id);
  assert.equal(calls, 1);
  await service.refresh(o._id);
  assert.equal((await Order.findById(o._id)).status, "READY_TO_SHIP");
  assert.equal(
    await OrderEvent.countDocuments({
      orderId: o._id,
      toStatus: "READY_TO_SHIP",
    }),
    1,
  );
  providerStatus = "shipped-code";
  await service.refresh(o._id);
  assert.equal((await Order.findById(o._id)).status, "SHIPPED");
  providerStatus = "undocumented";
  await service.refresh(o._id);
  assert.equal((await Order.findById(o._id)).status, "SHIPPED");
  assert.equal(
    (await Shipment.findOne({ orderId: o._id })).providerStatus,
    "undocumented",
  );
  delete process.env.DELIVERY_STATUS_MAP;
});
test("pagination and detailed filters are enforced server-side", async () => {
  await createOrder(input("TAMQO_ONLY"));
  await createOrder(input("LOGIX_ONLY"));
  await createOrder(input());
  const p = expectOk(await request(app).get("/api/orders?limit=1&page=2"));
  assert.equal(p.items.length, 1);
  assert.equal(p.total, 3);
  assert.equal(p.page, 2);
  for (const query of [
    "business=PARTNERSHIP",
    "commune=Alger&payment=COD",
    "source=" + source._id,
    "wilaya=" + wilaya._id,
    "catalog=" + plan._id,
    "phone=0550",
    "customer=Test",
    "search=ORD-",
  ]) {
    const r = expectOk(await request(app).get("/api/orders?" + query));
    assert.ok(r.total > 0, query);
  }
  assert.equal(
    (await request(app).get("/api/orders?business=invalid")).status,
    400,
  );
});
test("business analytics use scoped realized revenue and partnership-only orders", async () => {
  const partnership = await createOrder(input());
  for (const status of [
    "CONFIRMED",
    "PREPARING",
    "READY_TO_SHIP",
    "SHIPPED",
    "DELIVERED",
  ])
    await transition(partnership._id, status);
  const tamqo = await createOrder(input("TAMQO_ONLY"));
  await transition(tamqo._id, "CONFIRMED");
  await transition(tamqo._id, "DELIVERED");
  for (const [scope, revenue, orders] of [
    ["tamqo", 8000, 2],
    ["logix", 7000, 1],
    ["partnership", 11000, 1],
  ]) {
    const r = expectOk(
      await request(app).get(`/api/analytics/${scope}?period=today`),
    );
    assert.equal(r.metrics.netSales, revenue);
    assert.equal(r.metrics.totalOrders, orders);
  }
  const p = expectOk(
    await request(app).get("/api/analytics/partnership?period=today"),
  );
  assert.equal(p.metrics.tamqoRevenueShare, 36.36);
  assert.equal(p.metrics.logixRevenueShare, 63.64);
});
test("expense CRUD, filters, pagination and business isolation leave revenue untouched", async () => {
  const o = await createOrder(input());
  const category = await ExpenseCategory.findOne({ business: "TAMQO" }),
    logixCategory = await ExpenseCategory.findOne({ business: "LOGIX" });
  const date = new Date(Date.now() + 3600000).toISOString().slice(0, 10);
  const body = {
    business: "TAMQO",
    title: "Hosting expense",
    categoryId: String(category._id),
    amount: 500,
    expenseDate: date,
    paymentMethod: "BANK",
    note: "test",
  };
  const expense = expectOk(await request(app).post("/api/expenses").send(body));
  expectOk(
    await request(app)
      .post("/api/expenses")
      .send({
        ...body,
        business: "LOGIX",
        categoryId: String(logixCategory._id),
        amount: 1000,
      }),
  );
  const filtered = expectOk(
    await request(app).get(
      `/api/expenses?business=TAMQO&period=today&category=${category._id}&search=Hosting&paymentMethod=BANK&limit=1`,
    ),
  );
  assert.equal(filtered.total, 1);
  assert.equal(filtered.summary.totalExpenses, 500);
  assert.equal((await Order.findById(o._id)).productRevenue, 11000);
  expectOk(
    await request(app)
      .patch("/api/expenses/" + expense._id)
      .send({ ...body, amount: 600 }),
  );
  assert.equal(
    (
      await request(app)
        .post("/api/expenses")
        .send({ ...body, business: "PARTNERSHIP" })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/expenses")
        .send({ ...body, categoryId: String(logixCategory._id) })
    ).status,
    400,
  );
  assert.equal(
    (await request(app).delete("/api/expenses/" + expense._id)).status,
    204,
  );
});
test("date-range boundaries, collection audit and customer lifetime revenue", async () => {
  const o = await createOrder(input("TAMQO_ONLY"));
  await transition(o._id, "CONFIRMED");
  await transition(o._id, "DELIVERED");
  expectOk(
    await request(app)
      .post(`/api/orders/${o._id}/payment`)
      .send({ amountCollected: 4500 }),
  );
  const c = expectOk(await request(app).get("/api/customers"));
  assert.equal(c.items[0].lifetimeRevenue, 4000);
  const today = new Date(Date.now() + 3600000).toISOString().slice(0, 10);
  const r = expectOk(
    await request(app).get(
      `/api/analytics/tamqo?period=custom&start=${today}&end=${today}`,
    ),
  );
  assert.equal(r.metrics.totalOrders, 1);
  assert.equal(r.metrics.amountOutstanding, 0);
  const old = expectOk(
    await request(app).get(
      "/api/analytics/tamqo?period=custom&start=2020-01-01&end=2020-01-01",
    ),
  );
  assert.equal(old.metrics.totalOrders, 0);
});
test("secrets never appear in integration status, errors, or shipment response data", async () => {
  process.env.DELIVERY_API_TOKEN = "test-token-secret";
  process.env.DELIVERY_API_KEY = "test-key-secret";
  const r = expectOk(await request(app).get("/api/delivery/status"));
  assert.equal(JSON.stringify(r).includes("test-token-secret"), false);
  const response = await request(app)
    .post("/api/orders")
    .set("Origin", "https://hostile.example")
    .send(input());
  assert.equal(response.status, 403);
  delete process.env.DELIVERY_API_TOKEN;
  delete process.env.DELIVERY_API_KEY;
});
test("administrator authentication protects records and rejects cross-origin writes", async () => {
  const raw = supertest(app);
  assert.equal((await raw.get("/api/orders")).status, 401);
  assert.equal(
    (
      await raw
        .post("/api/auth/login")
        .send({ email: "qa@example.com", password: "incorrect" })
    ).status,
    401,
  );
  const agent = supertest.agent(app);
  expectOk(
    await agent
      .post("/api/auth/login")
      .send({ email: "qa@example.com", password: "test-only-password" }),
  );
  expectOk(await agent.get("/api/orders"));
  assert.equal(
    (
      await agent
        .post("/api/orders")
        .set("Origin", "https://other.example")
        .send(input())
    ).status,
    403,
  );
  assert.equal((await agent.post("/api/auth/logout")).status, 204);
  assert.equal((await agent.get("/api/orders")).status, 401);
});
test("concurrent shipment creation sends exactly one external request", async () => {
  const order = await createOrder(input());
  await transition(order._id, "CONFIRMED");
  let calls = 0;
  const service = new DeliverySyncService({
    ensureConfigured() {},
    async createPackages() {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { Colis: [{ MessageRetour: "Good", Tracking: "CONCURRENT-1" }] };
    },
  });
  await Promise.allSettled([
    service.create(order._id),
    service.create(order._id),
  ]);
  assert.equal(calls, 1);
  assert.equal(await Shipment.countDocuments({ orderId: order._id }), 1);
});
test("provider forward jumps record only observed statuses and cannot reopen a terminal order", async () => {
  const order = await createOrder(input());
  await transition(order._id, "CONFIRMED");
  process.env.DELIVERY_STATUS_MAP = JSON.stringify({
    delivered: "DELIVERED",
    shipped: "SHIPPED",
  });
  let status = "delivered";
  try {
    const service = new DeliverySyncService({
      ensureConfigured() {},
      async createPackages() {
        return {
          Colis: [
            { MessageRetour: "Good", Tracking: "FORWARD-1", Statut: status },
          ],
        };
      },
      async readPackages() {
        return {
          Colis: [
            { MessageRetour: "Good", Tracking: "FORWARD-1", Statut: status },
          ],
        };
      },
    });
    await service.create(order._id);
    const saved = await Order.findById(order._id);
    assert.equal(saved.status, "DELIVERED");
    assert.deepEqual(
      saved.statusHistory.map((h) => h.status),
      ["NEW", "CONFIRMED", "DELIVERED"],
    );
    status = "shipped";
    await service.refresh(order._id);
    assert.equal((await Order.findById(order._id)).status, "DELIVERED");
    assert.equal(
      (await Shipment.findOne({ orderId: order._id })).syncStatus,
      "ERROR",
    );
  } finally {
    delete process.env.DELIVERY_STATUS_MAP;
  }
});
test("ready calls only pret and transitions the prepared order", async () => {
  const order = await createOrder(input());
  await transition(order._id, "CONFIRMED");
  await transition(order._id, "PREPARING");
  let readyCalls = 0,
    providerStatus = "preparing",
    readCalls = 0;
  process.env.DELIVERY_STATUS_MAP = JSON.stringify({
    preparing: "PREPARING",
    ready: "READY_TO_SHIP",
  });
  try {
    const service = new DeliverySyncService({
      ensureConfigured() {},
      async createPackages() {
        return {
          Colis: [
            {
              MessageRetour: "Good",
              Tracking: "READY-1",
              Statut: providerStatus,
            },
          ],
        };
      },
      async readPackages() {
        readCalls++;
        return {
          Colis: [
            {
              MessageRetour: "Good",
              Tracking: "READY-1",
              Statut: providerStatus,
            },
          ],
        };
      },
      async readyPackages() {
        readyCalls++;
        providerStatus = "ready";
        return { Colis: [{ Tracking: "READY-1", MessageRetour: "Good" }] };
      },
    });
    await service.create(order._id);
    await service.ready(order._id);
    assert.equal(readyCalls, 1);
    assert.equal(readCalls, 0);
    assert.equal((await Order.findById(order._id)).status, "READY_TO_SHIP");
  } finally {
    delete process.env.DELIVERY_STATUS_MAP;
  }
});
test("calendar rollovers and fractional catalog cents are rejected", async () => {
  assert.equal(
    (
      await request(app).get(
        "/api/analytics/tamqo?period=custom&start=2026-02-30&end=2026-03-05",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(app)
        .patch("/api/config/plans/" + plan._id)
        .send({ price: 0.001 })
    ).status,
    400,
  );
});

test("registration key is backend-only and creates an unprivileged employee", async () => {
  const key = "registration-key-for-tests";
  const settings = expectOk(
    await apiAgent.patch("/api/settings/registration").send({
      registrationKey: key,
      registrationEnabled: true,
    }),
  );
  assert.equal("registrationKeyHash" in settings, false);
  assert.equal(JSON.stringify(settings).includes(key), false);

  assert.equal(
    (
      await supertest(app).post("/api/auth/register").send({
        name: "Wrong Key",
        email: "wrong-key@example.com",
        password: "employee-password",
        registrationKey: "incorrect-registration-key",
      })
    ).status,
    403,
  );

  const employeeAgent = supertest.agent(app);
  const registration = expectOk(
    await employeeAgent.post("/api/auth/register").send({
      name: "Registered Employee",
      email: "registered@example.com",
      password: "employee-password",
      registrationKey: key,
      role: "SUPER_ADMIN",
      businessAccess: ["LOGIX", "TAMQO"],
      permissions: [P.orders.viewAll],
    }),
  );
  assert.equal(registration.user.role, "EMPLOYEE");
  assert.deepEqual(registration.user.businessAccess, []);
  assert.deepEqual(registration.user.permissions, []);
  assert.equal((await employeeAgent.get("/api/orders")).status, 403);
  assert.equal(
    JSON.stringify(await RegistrationSetting.findById("registration")).includes(
      key,
    ),
    false,
  );
});

test("order creator is derived from session and own scope cannot be bypassed", async () => {
  const employee = expectOk(
    await apiAgent.post("/api/users").send({
      name: "Order Employee",
      email: "orders@example.com",
      password: "employee-password",
      role: "EMPLOYEE",
      businessAccess: ["TAMQO"],
      permissions: [P.orders.create, P.orders.viewOwn, P.analytics.viewOwn],
    }),
  );
  const employeeAgent = supertest.agent(app);
  expectOk(
    await employeeAgent.post("/api/auth/login").send({
      email: employee.email,
      password: "employee-password",
    }),
  );
  await createOrder(input("TAMQO_ONLY"), {
    userId: (await User.findOne({ email: "qa@example.com" }))._id,
    name: "Test Super Admin",
  });
  const created = expectOk(
    await employeeAgent.post("/api/orders").send({
      ...input("TAMQO_ONLY"),
      createdBy: { userId: new mongoose.Types.ObjectId(), name: "Impostor" },
    }),
  );
  assert.equal(created.createdBy.userId, employee._id);
  assert.equal(created.createdBy.name, employee.name);
  const list = expectOk(await employeeAgent.get("/api/orders"));
  assert.equal(list.total, 1);
  assert.equal(list.items[0]._id, created._id);
  const report = expectOk(
    await employeeAgent.get("/api/analytics/all?period=today"),
  );
  assert.equal(report.metrics.totalOrders, 1);
});

test("business access blocks direct expense API calls", async () => {
  const employee = expectOk(
    await apiAgent.post("/api/users").send({
      name: "Logix Expense Employee",
      email: "logix-expenses@example.com",
      password: "employee-password",
      businessAccess: ["LOGIX"],
      permissions: [P.expenses.create, P.expenses.view],
    }),
  );
  const employeeAgent = supertest.agent(app);
  expectOk(
    await employeeAgent.post("/api/auth/login").send({
      email: employee.email,
      password: "employee-password",
    }),
  );
  assert.equal(
    (
      await employeeAgent.post("/api/expenses").send({
        business: "TAMQO",
        title: "Forbidden expense",
        amount: 100,
      })
    ).status,
    403,
  );
  const created = expectOk(
    await employeeAgent.post("/api/expenses").send({
      business: "LOGIX",
      title: "Allowed expense",
      amount: 100,
    }),
  );
  assert.equal(created.createdBy.userId, employee._id);
  assert.equal(created.business, "LOGIX");
});

test("admins cannot escalate privileges or modify a Super Admin", async () => {
  const admin = expectOk(
    await apiAgent.post("/api/users").send({
      name: "Restricted Admin",
      email: "restricted-admin@example.com",
      password: "employee-password",
      role: "ADMIN",
      businessAccess: ["LOGIX"],
      permissions: [
        P.users.view,
        P.users.create,
        P.users.update,
        P.users.disable,
        P.users.permissions,
      ],
    }),
  );
  const adminAgent = supertest.agent(app);
  expectOk(
    await adminAgent.post("/api/auth/login").send({
      email: admin.email,
      password: "employee-password",
    }),
  );
  assert.equal(
    (
      await adminAgent.post("/api/users").send({
        name: "Escalated User",
        email: "escalated@example.com",
        password: "employee-password",
        role: "SUPER_ADMIN",
        businessAccess: ["LOGIX"],
        permissions: [],
      })
    ).status,
    403,
  );
  const superAdmin = await User.findOne({ email: "qa@example.com" });
  assert.equal(
    (
      await adminAgent.patch(`/api/users/${superAdmin._id}`).send({
        status: "DISABLED",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await apiAgent.patch(`/api/users/${superAdmin._id}`).send({
        permissions: [],
      })
    ).status,
    403,
  );
  assert.equal((await User.findById(superAdmin._id)).status, "ACTIVE");
});

test("revoked and disabled sessions stop authorizing immediately", async () => {
  const employee = expectOk(
    await apiAgent.post("/api/users").send({
      name: "Session Employee",
      email: "sessions@example.com",
      password: "employee-password",
      businessAccess: [],
      permissions: [P.sessions.viewOwn, P.sessions.revokeOwn],
    }),
  );
  const employeeAgent = supertest.agent(app);
  expectOk(
    await employeeAgent.post("/api/auth/login").send({
      email: employee.email,
      password: "employee-password",
    }),
  );
  const sessions = expectOk(await employeeAgent.get("/api/auth/sessions"));
  assert.equal(sessions.length, 1);
  assert.equal("tokenHash" in sessions[0], false);
  assert.equal(
    (await employeeAgent.delete(`/api/auth/sessions/${sessions[0]._id}`))
      .status,
    204,
  );
  assert.equal((await employeeAgent.get("/api/auth/me")).status, 401);

  const disabledAgent = supertest.agent(app);
  expectOk(
    await disabledAgent.post("/api/auth/login").send({
      email: employee.email,
      password: "employee-password",
    }),
  );
  expectOk(
    await apiAgent
      .patch(`/api/users/${employee._id}`)
      .send({ status: "DISABLED" }),
  );
  assert.equal((await disabledAgent.get("/api/auth/me")).status, 401);
  assert.equal(
    await Session.countDocuments({ userId: employee._id, revokedAt: null }),
    0,
  );
});

test("migration creates one ABEX agency and per-Wilaya rates idempotently", async () => {
  await migrate();
  await migrate();
  const agencies = await DeliveryAgency.find({ code: "ABEX" });
  assert.equal(agencies.length, 1);
  assert.deepEqual([...agencies[0].businesses].sort(), ["LOGIX", "TAMQO"]);
  assert.equal(
    await DeliveryRate.countDocuments({ agencyId: agencies[0]._id }),
    await Wilaya.countDocuments(),
  );
  assert.ok(await AuditLog.exists({ action: "USER_CREATED" }));
});

test("agency assignment, rates, manual shipments, snapshots and credentials are safe", async () => {
  const manual = expectOk(
    await apiAgent.post("/api/delivery-agencies").send({
      name: "Logix Manual Courier",
      code: "LOGIX_MANUAL",
      businesses: ["LOGIX"],
      integrationType: "MANUAL",
    }),
  );
  expectOk(
    await apiAgent.post(`/api/delivery-agencies/${manual._id}/rates`).send({
      wilayaId: String(wilaya._id),
      homePrice: 777,
      deskPrice: 555,
      active: true,
    }),
  );
  const logixAgencies = expectOk(
    await apiAgent.get("/api/delivery-agencies?business=LOGIX"),
  );
  assert.ok(logixAgencies.some((agency) => agency._id === manual._id));
  const tamqoAgencies = expectOk(
    await apiAgent.get("/api/delivery-agencies?business=TAMQO"),
  );
  assert.equal(
    tamqoAgencies.some((agency) => agency._id === manual._id),
    false,
  );
  const partnershipAgencies = expectOk(
    await apiAgent.get("/api/delivery-agencies?business=PARTNERSHIP"),
  );
  assert.equal(
    partnershipAgencies.every(
      (agency) =>
        agency.businesses.includes("LOGIX") &&
        agency.businesses.includes("TAMQO"),
    ),
    true,
  );

  const order = expectOk(
    await apiAgent.post("/api/orders").send({
      ...input("LOGIX_ONLY"),
      delivery: {
        type: "HOME",
        exchange: false,
        agencyId: manual._id,
      },
    }),
  );
  assert.equal(order.deliveryCharged, 777);
  assert.equal(order.delivery.agencyName, manual.name);
  expectOk(await apiAgent.post(`/api/orders/${order._id}/confirm`));
  const shipment = expectOk(
    await apiAgent
      .post(`/api/orders/${order._id}/shipment`)
      .send({ tracking: "MANUAL-TRACKING-1" }),
  );
  assert.equal(shipment.provider, "MANUAL");
  assert.equal(shipment.agencyName, manual.name);
  assert.equal(
    (await apiAgent.delete(`/api/delivery-agencies/${manual._id}`)).status,
    409,
  );
  const disabled = expectOk(
    await apiAgent
      .patch(`/api/delivery-agencies/${manual._id}`)
      .send({ active: false }),
  );
  assert.equal(disabled.active, false);
  assert.equal(
    (await Order.findById(order._id)).delivery.agencyName,
    manual.name,
  );
  const connection = expectOk(
    await apiAgent.post(`/api/delivery-agencies/${manual._id}/test`),
  );
  assert.equal(connection.success, true);

  const previousKey = process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY;
  process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY =
    "7062cd732174631a214045d0843c9a767114180397e4a67c9a242e7b894d759f";
  try {
    const apiAgency = expectOk(
      await apiAgent.post("/api/delivery-agencies").send({
        name: "API Courier",
        code: "API_COURIER",
        businesses: ["LOGIX", "TAMQO"],
        integrationType: "API",
        apiProvider: "PROCOLIS",
        config: { baseUrl: "https://procolis.com/api_v1" },
        credentials: {
          token: "provider-token-secret",
          key: "provider-key-secret",
        },
      }),
    );
    const responseText = JSON.stringify(apiAgency);
    assert.equal(responseText.includes("provider-token-secret"), false);
    assert.equal(responseText.includes("provider-key-secret"), false);
    assert.equal(apiAgency.credentialsConfigured, true);
    const stored = await DeliveryAgency.findById(apiAgency._id).select(
      "+encryptedCredentials",
    );
    assert.ok(stored.encryptedCredentials);
    assert.equal(
      stored.encryptedCredentials.includes("provider-token-secret"),
      false,
    );
    assert.equal(
      JSON.stringify(
        await AuditLog.find({ resourceId: String(apiAgency._id) }),
      ).includes("provider-token-secret"),
      false,
    );
  } finally {
    if (previousKey === undefined)
      delete process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY = previousKey;
  }
});

test("customer updates require permission and preserve order snapshots", async () => {
  const order = expectOk(
    await apiAgent.post("/api/orders").send(input("TAMQO_ONLY")),
  );
  const customer = expectOk(
    await apiAgent.get(`/api/customers/${order.customerId}`),
  );
  const updated = expectOk(
    await apiAgent.patch(`/api/customers/${customer._id}`).send({
      name: "Updated Customer",
      phoneA: "0660123456",
      phoneB: "",
    }),
  );
  assert.equal(updated.name, "Updated Customer");
  assert.equal(updated.normalizedPhone, "+213660123456");
  const historical = await Order.findById(order._id);
  assert.equal(historical.customer.name, "Test Customer");
  assert.equal(historical.customer.normalizedPhone, "+213550123456");
});

// Real HTTP boundary with per-agency encrypted credentials, never live ABEX.
async function courierFixture(
  t,
  reply,
  { manual = false, enabled = true, timeout = 1000 } = {},
) {
  const previousKey = process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY;
  const previousTimeout = process.env.DELIVERY_TIMEOUT_MS;
  process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY = "a1".repeat(32);
  process.env.DELIVERY_TIMEOUT_MS = String(timeout);
  const calls = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const committed = body?.Colis?.[0]?.id_Externe
      ? await Order.findOne({ orderNumber: body.Colis[0].id_Externe }).lean()
      : null;
    calls.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
      committed,
    });
    reply(req, res, calls.length, body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agency = await DeliveryAgency.create({
    name: "HTTP test courier",
    code: "HTTP_TEST",
    businesses: ["LOGIX", "TAMQO"],
    integrationType: manual ? "MANUAL" : "API",
    apiProvider: manual ? "MANUAL" : "PROCOLIS",
    capabilities: {
      createShipment: enabled,
      tracking: true,
      readyToShip: true,
      pricing: true,
    },
    config: { baseUrl: `http://127.0.0.1:${server.address().port}` },
    encryptedCredentials: manual
      ? undefined
      : encryptCredentials({
          token: "agency-token-private",
          key: "agency-key-private",
        }),
    credentialsConfigured: !manual,
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await DeliveryAgency.deleteOne({ _id: agency._id });
    if (previousKey === undefined)
      delete process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY = previousKey;
    if (previousTimeout === undefined) delete process.env.DELIVERY_TIMEOUT_MS;
    else process.env.DELIVERY_TIMEOUT_MS = previousTimeout;
  });
  return {
    agency,
    calls,
    input: input("LOGIX_ONLY", {
      delivery: { agencyId: String(agency._id), type: "HOME", exchange: false },
      deliveryCharged: 500,
    }),
  };
}
function jsonReply(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

test("API order automatically creates one unconfirmed parcel after local commit", async (t) => {
  const f = await courierFixture(t, (_req, res) =>
    jsonReply(res, 200, {
      Colis: [{ Tracking: "AUTO-001", MessageRetour: "Good" }],
      metadata: { token: "private" },
    }),
  );
  const response = await apiAgent.post("/api/orders").send(f.input);
  assert.equal(response.status, 201);
  const o = response.body,
    s = await Shipment.findOne({ orderId: o._id });
  assert.equal(o.status, "NEW");
  assert.equal(o.shipment.tracking, "AUTO-001");
  assert.equal(o.shipmentSync.success, true);
  assert.equal(s.syncStatus, "SYNCED");
  assert.equal(s.uncertain, false);
  assert.equal(s.providerAccepted, true);
  assert.deepEqual(s.sanitizedProviderData, {
    Colis: [{ Tracking: "AUTO-001", MessageRetour: "Good" }],
    metadata: {},
  });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0],
    parcel = call.body.Colis[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, "/add_colis");
  assert.equal(call.headers.token, "agency-token-private");
  assert.equal(call.headers.key, "agency-key-private");
  assert.match(call.headers["content-type"], /^application\/json/);
  assert.equal(String(call.committed._id), o._id);
  assert.equal(call.committed.status, "NEW");
  assert.equal(parcel.Confrimee, "0");
  assert.equal(parcel.IDWilaya, "16");
  assert.equal(parcel.Total, "7500");
  assert.equal(parcel.id_Externe, o.orderNumber);
  assert.equal(parcel.Tracking, o.orderNumber);
  assert.equal(call.headers.authorization, undefined);
  assert.equal("Package" in call.body, false);
  assert.equal(o.revision, (await Order.findById(o._id)).revision);
  expectOk(await apiAgent.post(`/api/orders/${o._id}/shipment`));
  assert.equal(f.calls.length, 1);
  assert.equal(
    (
      await apiAgent
        .patch(`/api/orders/${o._id}`)
        .send({ ...f.input, revision: o.revision })
    ).status,
    409,
  );
  assert.equal(
    (await apiAgent.post(`/api/orders/${o._id}/cancel`).send({})).status,
    409,
  );
});

test("manual and capability-disabled agencies do not automatically send parcels", async (t) => {
  const f = await courierFixture(t, (_req, res) => jsonReply(res, 500, {}), {
    manual: true,
  });
  let o = expectOk(await apiAgent.post("/api/orders").send(f.input));
  assert.equal(o.shipment, null);
  assert.equal(o.shipmentSync.attempted, false);
  assert.equal(await (await providerFor(f.agency._id)).testCredentials(), true);
  expectOk(await apiAgent.post(`/api/orders/${o._id}/confirm`));
  assert.equal(
    expectOk(await apiAgent.post(`/api/orders/${o._id}/shipment`).send({}))
      .provider,
    "MANUAL",
  );
  await DeliveryAgency.updateOne(
    { _id: f.agency._id },
    {
      integrationType: "API",
      apiProvider: "PROCOLIS",
      "capabilities.createShipment": false,
    },
  );
  o = expectOk(await apiAgent.post("/api/orders").send(f.input));
  assert.equal(o.shipment, null);
  assert.equal(f.calls.length, 0);
});

test("unknown success is pending and retries only read deterministic tracking", async (t) => {
  const f = await courierFixture(t, (req, res, _n, body) =>
    jsonReply(
      res,
      200,
      req.url === "/add_colis"
        ? { result: "received agency-token-private" }
        : { Colis: [{ Tracking: body.Colis[0].Tracking, Statut: "unknown" }] },
    ),
  );
  const o = expectOk(await apiAgent.post("/api/orders").send(f.input));
  assert.equal(o.shipment.syncStatus, "PENDING");
  assert.equal(o.shipment.providerAccepted, false);
  const linked = expectOk(
    await apiAgent.post("/api/orders/" + o._id + "/shipment"),
  );
  assert.equal(linked.tracking, o.orderNumber);
  assert.equal(linked.uncertain, false);
  assert.equal(linked.syncStatus, "SYNCED");
  assert.deepEqual(
    f.calls.map((c) => c.url),
    ["/add_colis", "/lire"],
  );
  assert.deepEqual(f.calls[1].body, { Colis: [{ Tracking: o.orderNumber }] });
  assert.equal(await Order.countDocuments(), 1);
});

for (const status of [400, 401, 500])
  test(`HTTP ${status} preserves order and sanitized provider diagnostics`, async (t) => {
    const f = await courierFixture(t, (_req, res) =>
      jsonReply(res, status, {
        message: "Invalid parcel agency-token-private agency-key-private",
        token: "secret",
        cookies: "secret",
      }),
    );
    const response = await apiAgent.post("/api/orders").send(f.input);
    assert.equal(response.status, 201);
    const o = response.body,
      s = await Shipment.findOne({ orderId: o._id });
    assert.equal(await Order.countDocuments(), 1);
    assert.equal(o.shipmentSync.success, false);
    assert.equal(s.syncStatus, "ERROR");
    assert.equal(s.providerAccepted, false);
    assert.match(s.lastError, /Invalid parcel/);
    assert.equal(s.sanitizedProviderData.status, status);
    assert.equal(s.sanitizedProviderData.endpoint, "/add_colis");
    assert.equal(JSON.stringify(s).includes("private"), false);
    assert.equal(JSON.stringify(s).includes("secret"), false);
    assert.equal(
      (await apiAgent.post(`/api/orders/${o._id}/shipment`)).status,
      200,
    );
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].url, "/lire");
  });

test("HTTP timeout keeps one recoverable order and retries with lire", async (t) => {
  const f = await courierFixture(t, () => {}, { timeout: 100 });
  const response = await apiAgent.post("/api/orders").send(f.input);
  assert.equal(response.status, 201);
  const o = response.body;
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(o.shipment.syncStatus, "ERROR");
  assert.equal(o.shipment.uncertain, true);
  assert.match(o.shipment.lastError, /timed out/);
  assert.equal(
    (await apiAgent.post(`/api/orders/${o._id}/shipment`)).status,
    200,
  );
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].url, "/lire");
});

test("credential test uses GET token with agency headers and validates activated Statut", async (t) => {
  const f = await courierFixture(t, (_req, res) =>
    jsonReply(res, 200, { Statut: "Acc\u00e8s activ\u00e9" }),
  );
  expectOk(await apiAgent.post(`/api/delivery-agencies/${f.agency._id}/test`));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "GET");
  assert.equal(f.calls[0].url, "/token");
  assert.equal(f.calls[0].headers.token, "agency-token-private");
  assert.equal(f.calls[0].headers.key, "agency-key-private");
});

test("credential test rejects an explicit non-activated HTTP 200 response", async (t) => {
  const f = await courierFixture(t, (_req, res) =>
    jsonReply(res, 200, { Statut: "Acc\u00e8s refus\u00e9" }),
  );
  const response = await apiAgent.post(
    `/api/delivery-agencies/${f.agency._id}/test`,
  );
  assert.equal(response.status, 422);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "/token");
});

test("Double Tracking reconciles with lire and never repeats add_colis", async (t) => {
  const f = await courierFixture(t, (req, res, _n, body) =>
    jsonReply(
      res,
      200,
      req.url === "/add_colis"
        ? {
            Colis: [
              {
                Tracking: body.Colis[0].Tracking,
                MessageRetour: "Double Tracking",
              },
            ],
          }
        : {
            Colis: [
              {
                Tracking: body.Colis[0].Tracking,
                Statut: "existing",
              },
            ],
          },
    ),
  );
  const order = expectOk(await apiAgent.post("/api/orders").send(f.input));
  assert.equal(order.shipment.syncStatus, "SYNCED");
  assert.equal(order.shipment.uncertain, false);
  assert.equal(order.shipment.tracking, order.orderNumber);
  assert.equal(order.shipment.messageRetour, "Double Tracking");
  assert.deepEqual(
    f.calls.map((call) => call.url),
    ["/add_colis", "/lire"],
  );
  assert.equal(f.calls.filter((call) => call.url === "/add_colis").length, 1);
  assert.deepEqual(f.calls[1].body, {
    Colis: [{ Tracking: order.orderNumber }],
  });
});

test("explicit provider rejection on HTTP success remains a recoverable error", async (t) => {
  const f = await courierFixture(t, (_req, res) =>
    jsonReply(res, 200, {
      Colis: [{ MessageRetour: "Some provider error" }],
    }),
  );
  const o = expectOk(await apiAgent.post("/api/orders").send(f.input));
  const shipment = await Shipment.findOne({ orderId: o._id }).lean();
  assert.equal(shipment.syncStatus, "ERROR");
  assert.equal(shipment.providerAccepted, false);
  assert.equal(shipment.lastError, "Some provider error");
  assert.equal(shipment.sanitizedProviderData.status, 200);
  assert.equal(shipment.sanitizedProviderData.statusText, "OK");
  assert.equal(
    shipment.sanitizedProviderData.body.Colis[0].MessageRetour,
    "Some provider error",
  );
  assert.equal(
    (await apiAgent.post(`/api/orders/${o._id}/shipment`)).status,
    409,
  );
  assert.equal(f.calls.length, 1);
});

test("uncertain parcel can be linked with documented tracking lookup and then refreshed", async (t) => {
  let externalId;
  const f = await courierFixture(t, (req, res) =>
    jsonReply(
      res,
      200,
      req.url === "/add_colis"
        ? { received: true }
        : { Colis: [{ Tracking: "LINK-001", id_Externe: externalId }] },
    ),
  );
  const o = expectOk(await apiAgent.post("/api/orders").send(f.input));
  externalId = "WRONG-ORDER";
  assert.equal(
    (
      await apiAgent
        .post(`/api/orders/${o._id}/shipment/reconcile`)
        .send({ tracking: "LINK-001" })
    ).status,
    409,
  );
  externalId = o.orderNumber;
  const linked = expectOk(
    await apiAgent
      .post(`/api/orders/${o._id}/shipment/reconcile`)
      .send({ tracking: "LINK-001" }),
  );
  assert.equal(linked.tracking, "LINK-001");
  assert.equal(linked.uncertain, false);
  assert.equal(linked.syncStatus, "SYNCED");
  expectOk(await apiAgent.post(`/api/orders/${o._id}/shipment/refresh`));
  assert.equal(f.calls.filter((c) => c.url === "/add_colis").length, 1);
  assert.ok(f.calls.slice(1).every((c) => c.url === "/lire"));
});

test("stale tracking reconciliation cannot replace a new in-flight reservation", async () => {
  const o = await createOrder(input());
  let releaseLookup,
    lookupStarted,
    releaseCreate,
    createStarted,
    calls = 0;
  const lookupReady = new Promise((resolve) => {
    lookupStarted = resolve;
  });
  const createReady = new Promise((resolve) => {
    createStarted = resolve;
  });
  const service = new DeliverySyncService({
    ensureConfigured() {},
    async createPackages() {
      calls++;
      if (calls === 1) return {};
      createStarted();
      return new Promise((resolve) => {
        releaseCreate = resolve;
      });
    },
    async readPackages() {
      lookupStarted();
      return new Promise((resolve) => {
        releaseLookup = resolve;
      });
    },
  });
  await service.create(o._id);
  const lookup = service.reconcile(o._id, "OLD-TRACKING");
  await lookupReady;
  await service.reconcile(o._id, undefined, true);
  const retry = service.create(o._id);
  await createReady;
  releaseLookup({ Tracking: "OLD-TRACKING" });
  await assert.rejects(lookup, /Shipment changed/);
  await assert.rejects(
    service.reconcile(o._id, undefined, true),
    /still in progress/,
  );
  releaseCreate({ Tracking: "CURRENT-TRACKING", MessageRetour: "Good" });
  assert.equal((await retry).tracking, "CURRENT-TRACKING");
  assert.equal(calls, 2);
});
