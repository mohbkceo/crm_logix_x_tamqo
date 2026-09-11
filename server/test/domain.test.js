import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePhone,
  calculateFinancials,
  canTransition,
} from "../src/domain/order.js";
import { reportingRange } from "../src/domain/period.js";
import {
  mapOrderToPackage,
  sanitizeProviderData,
  parsePackages,
  parseCreationResult,
} from "../src/services/delivery/deliveryMapper.js";
import { DeliveryClient } from "../src/services/delivery/deliveryClient.js";
import {
  balanceBreakdown,
  buildReport,
  isRealized,
} from "../src/services/analyticsService.js";
import {
  deliveryStatusMapping,
  mapProviderStatus,
} from "../src/services/delivery/deliveryStatusMapper.js";
import {
  DEFAULT_DELIVERY_SYNC_INTERVAL_MS,
  deliverySyncSettings,
  startDeliverySyncScheduler,
} from "../src/services/delivery/deliveryScheduler.js";
const items = [
  {
    business: "TAMQO",
    catalogItemId: "1",
    name: "3 Months",
    unitPrice: 4000,
    quantity: 1,
    subtotal: 4000,
    durationDays: 90,
  },
  {
    business: "LOGIX",
    catalogItemId: "2",
    name: "20cm Plaque",
    unitPrice: 3500,
    quantity: 2,
    subtotal: 7000,
  },
];
function fixture(overrides = {}) {
  return {
    createdAt: new Date("2026-09-04T10:00:00Z"),
    orderNumber: "ORD-2026-000123",
    customerId: "customer",
    customer: { name: "Test Customer", phoneA: "0550123456", phoneB: "" },
    source: { name: "Messages" },
    location: {
      address: "Street 39",
      agencyId: "16",
      wilayaName: "Alger",
      commune: "Alger Centre",
    },
    items,
    delivery: { type: "HOME", exchange: false },
    ...calculateFinancials(items, 500, { method: "COD", amountPaidOnline: 0 }),
    status: "DELIVERED",
    statusHistory: [
      { status: "NEW", at: new Date("2026-09-04T10:00:00Z") },
      { status: "CONFIRMED", at: new Date("2026-09-04T11:00:00Z") },
      { status: "SHIPPED", at: new Date("2026-09-04T12:00:00Z") },
      { status: "DELIVERED", at: new Date("2026-09-04T13:00:00Z") },
    ],
    ...overrides,
  };
}
test("Algerian phone formats resolve to one primary identity", () => {
  for (const p of [
    "0550 12 34 56",
    "+213550123456",
    "00213 550 123 456",
    "213550123456",
  ])
    assert.equal(normalizePhone(p), "+213550123456");
  assert.throws(() => normalizePhone("123"));
});
test("classification derives from items and overrides remain item based", () => {
  assert.equal(
    calculateFinancials(items, 500, { method: "COD", amountPaidOnline: 0 })
      .businessType,
    "PARTNERSHIP",
  );
  assert.equal(
    calculateFinancials(items.slice(0, 1), 0, {
      method: "COD",
      amountPaidOnline: 0,
    }).businessType,
    "TAMQO_ONLY",
  );
  assert.equal(
    calculateFinancials(items.slice(1), 0, {
      method: "COD",
      amountPaidOnline: 0,
    }).businessType,
    "LOGIX_ONLY",
  );
});
test("COD, fully prepaid and mixed never alter product revenue", () => {
  for (const [method, paid, due] of [
    ["COD", 0, 11500],
    ["ONLINE", 11500, 0],
    ["MIXED", 11000, 500],
  ]) {
    const f = calculateFinancials(items, 500, {
      method,
      amountPaidOnline: paid,
    });
    assert.equal(f.productRevenue, 11000);
    assert.equal(f.payment.amountToCollect, due);
  }
  assert.throws(() =>
    calculateFinancials(items, 500, { method: "COD", amountPaidOnline: 1 }),
  );
  assert.throws(() =>
    calculateFinancials(items, 500, {
      method: "ONLINE",
      amountPaidOnline: 11000,
    }),
  );
  assert.throws(() =>
    calculateFinancials(items, 500, {
      method: "MIXED",
      amountPaidOnline: 12000,
    }),
  );
});
test("courier mapping uses exact documented fields and collection amount", () => {
  const order = fixture({
      ...calculateFinancials(items, 500, {
        method: "MIXED",
        amountPaidOnline: 11000,
      }),
    }),
    p = mapOrderToPackage(order).Colis[0];
  assert.equal(p.Total, "500");
  assert.equal(p.id_Externe, "ORD-2026-000123");
  assert.equal(p.TypeLivraison, "0");
  assert.equal(p.TypeColis, "0");
  assert.equal(p.Source, "Messages");
  assert.equal(p.Confrimee, "0");
  order.delivery = { type: "STOP_DESK", exchange: true };
  assert.equal(
    mapOrderToPackage(order, { confirmed: true }).Colis[0].TypeLivraison,
    "1",
  );
  assert.equal(
    mapOrderToPackage(order, { confirmed: true }).Colis[0].TypeColis,
    "1",
  );
  assert.equal(
    mapOrderToPackage(order, { confirmed: true }).Colis[0].Confrimee,
    "1",
  );
});
test("unknown courier response contracts are not fabricated", () => {
  assert.deepEqual(parsePackages({ ok: true }), []);
  assert.deepEqual(
    sanitizeProviderData({
      token: "secret",
      nested: { key: "secret", Tracking: "ABC" },
    }),
    { nested: { Tracking: "ABC" } },
  );
});
test("all reporting periods use half-open Algeria ranges and equivalent comparisons", () => {
  const now = new Date("2026-09-05T12:00:00Z");
  for (const period of [
    "today",
    "yesterday",
    "7d",
    "30d",
    "month",
    "lastMonth",
    "year",
    "custom",
  ]) {
    const r = reportingRange(
      { period, start: "2026-08-01", end: "2026-08-10" },
      now,
    );
    assert.equal(+r.end - r.start, +r.previousEnd - r.previousStart);
    assert.equal(+r.start, +r.previousEnd);
  }
  const r = reportingRange({ period: "today" }, now);
  assert.equal(r.start.toISOString(), "2026-09-04T23:00:00.000Z");
  assert.throws(() =>
    reportingRange(
      { period: "custom", start: "2026-09-06", end: "2026-09-01" },
      now,
    ),
  );
});
test("business revenue is allocated correctly and shares exclude delivery", () => {
  const order = fixture(),
    range = reportingRange({
      period: "custom",
      start: "2026-09-01",
      end: "2026-09-05",
    });
  assert.equal(
    buildReport([order], [], [order], "TAMQO", range).metrics.netSales,
    4000,
  );
  assert.equal(
    buildReport([order], [], [order], "LOGIX", range).metrics.netSales,
    7000,
  );
  const report = buildReport([order], [], [order], "PARTNERSHIP", range);
  assert.equal(report.metrics.netSales, 11000);
  assert.equal(report.metrics.tamqoRevenueShare, 36.36);
  assert.equal(report.metrics.logixRevenueShare, 63.64);
  assert.equal(report.metrics.averageConfirmationTime, 1);
  assert.equal(report.metrics.totalUnitsSold, 3);
  assert.equal(report.metrics.salesGrowth, null);
});
test("realization excludes cancelled, returned and returning sales", () => {
  for (const status of ["CANCELLED", "RETURNED", "RETURNING", "NEW"])
    assert.equal(isRealized(fixture({ status })), false);
  assert.equal(
    isRealized(
      fixture({
        status: "CONFIRMED",
        businessType: "TAMQO_ONLY",
        tamqoActivatedAt: new Date(),
      }),
    ),
    true,
  );
  assert.equal(
    isRealized(
      fixture({
        status: "CONFIRMED",
        businessType: "PARTNERSHIP",
        tamqoActivatedAt: new Date(),
      }),
    ),
    false,
  );
});
test("current balance uses realized scoped order revenue, direct sales once, and expenses", () => {
  const orders = [
      fixture(),
      fixture({ status: "NEW" }),
      fixture({ status: "CANCELLED" }),
      fixture({ status: "RETURNED" }),
    ],
    sales = [
      { business: "TAMQO", amount: 4000 },
      { business: "LOGIX", amount: 5000 },
    ],
    expenses = [
      { business: "TAMQO", amount: 1000 },
      { business: "LOGIX", amount: 2000 },
    ];
  assert.deepEqual(balanceBreakdown(orders, sales, expenses, "ALL"), {
    realizedOrderRevenue: 11000,
    directSalesRevenue: 9000,
    totalRevenue: 20000,
    totalExpenses: 3000,
    currentBalance: 17000,
  });
  assert.deepEqual(balanceBreakdown(orders, sales, expenses, "TAMQO"), {
    realizedOrderRevenue: 4000,
    directSalesRevenue: 4000,
    totalRevenue: 8000,
    totalExpenses: 1000,
    currentBalance: 7000,
  });
  assert.deepEqual(balanceBreakdown(orders, sales, expenses, "LOGIX"), {
    realizedOrderRevenue: 7000,
    directSalesRevenue: 5000,
    totalRevenue: 12000,
    totalExpenses: 2000,
    currentBalance: 10000,
  });
});
test("delivery status mappings normalize case and whitespace and reject empty maps", () => {
  const previous = process.env.DELIVERY_STATUS_MAP;
  try {
    process.env.DELIVERY_STATUS_MAP = "{}";
    assert.equal(deliveryStatusMapping().configured, false);
    assert.equal(mapProviderStatus("Delivered"), null);
    process.env.DELIVERY_STATUS_MAP = JSON.stringify({
      "  En   Livraison ": "OUT_FOR_DELIVERY",
    });
    assert.equal(mapProviderStatus("EN livraison"), "OUT_FOR_DELIVERY");
  } finally {
    if (previous === undefined) delete process.env.DELIVERY_STATUS_MAP;
    else process.env.DELIVERY_STATUS_MAP = previous;
  }
});
test("delivery scheduler runs once at startup and every fifteen minutes by default", async () => {
  const previousInterval = process.env.DELIVERY_SYNC_INTERVAL_MS,
    previousEnabled = process.env.DELIVERY_SYNC_ENABLED,
    triggers = [];
  let callback, scheduledInterval;
  delete process.env.DELIVERY_SYNC_INTERVAL_MS;
  delete process.env.DELIVERY_SYNC_ENABLED;
  try {
    assert.deepEqual(deliverySyncSettings(), {
      enabled: true,
      intervalMs: DEFAULT_DELIVERY_SYNC_INTERVAL_MS,
    });
    startDeliverySyncScheduler({
      sync: async (trigger) => triggers.push(trigger),
      setIntervalFn: (fn, ms) => {
        callback = fn;
        scheduledInterval = ms;
        return { fn, ms };
      },
      now: () => 0,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduledInterval, 900000);
    assert.deepEqual(triggers, ["STARTUP"]);
    callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(triggers, ["STARTUP", "CRON"]);
  } finally {
    if (previousInterval === undefined)
      delete process.env.DELIVERY_SYNC_INTERVAL_MS;
    else process.env.DELIVERY_SYNC_INTERVAL_MS = previousInterval;
    if (previousEnabled === undefined) delete process.env.DELIVERY_SYNC_ENABLED;
    else process.env.DELIVERY_SYNC_ENABLED = previousEnabled;
  }
});
test("transitions reject lifecycle regressions and allow digital completion", () => {
  assert.equal(canTransition("NEW", "DELIVERED", "LOGIX_ONLY"), false);
  assert.equal(canTransition("RETURNED", "SHIPPED", "LOGIX_ONLY"), false);
  assert.equal(canTransition("CONFIRMED", "DELIVERED", "TAMQO_ONLY"), true);
});

test("legacy Colis parser preserves status and rejects invented aliases", () => {
  const parcel = {
    Tracking: "ORD-1",
    Statut: "unknown",
    MessageRetour: "Good",
    extra: 42,
  };
  for (const raw of [{ Colis: [parcel] }, [parcel], parcel]) {
    assert.equal(parseCreationResult(raw, "ORD-1").trackingFound, true);
    assert.equal(parsePackages(raw)[0].providerStatus, "unknown");
    assert.equal(parsePackages(raw)[0].raw.extra, 42);
  }
  for (const raw of [
    null,
    "OK",
    { Package: [parcel] },
    { data: { Colis: [parcel] } },
    { Tracking: {} },
    { Tracking: 123 },
    { Tracking: " " },
    { Tracking: "X".repeat(151) },
    { Tracking: "X\nY" },
  ]) {
    assert.deepEqual(parsePackages(raw), []);
  }
  assert.equal(
    parseCreationResult({ Colis: [{ MessageRetour: "Good" }] }, "ORD-1").parcel
      .tracking,
    "ORD-1",
  );
  assert.equal(
    parseCreationResult(
      { Colis: [{ MessageRetour: "Double Tracking" }] },
      "ORD-1",
    ).duplicate,
    true,
  );
  assert.equal(
    parseCreationResult({ Colis: [{ MessageRetour: "Rejected" }] }, "ORD-1")
      .providerAccepted,
    false,
  );
  assert.deepEqual(
    parsePackages({
      Colis: [{ Tracking: "ORD-1", MessageRetour: "Not found" }],
    }),
    [],
  );
});
test("prepaid collection uses local wilaya agency ID and deterministic tracking", () => {
  const order = fixture({
    ...calculateFinancials(items, 500, {
      method: "ONLINE",
      amountPaidOnline: 11500,
    }),
  });
  const payload = mapOrderToPackage(order);
  assert.deepEqual(Object.keys(payload), ["Colis"]);
  const parcel = payload.Colis[0];
  assert.equal(parcel.Total, "0");
  assert.equal(parcel.IDWilaya, "16");
  assert.equal(parcel.Confrimee, "0");
  assert.equal(parcel.Tracking, order.orderNumber);
  assert.equal(parcel.id_Externe, order.orderNumber);
  assert.equal(parcel.Adresse, order.location.address);
  assert.equal(parcel.TProduit, "3 Months \u00d7 1, 20cm Plaque \u00d7 2");
  for (const key of ["DeliveryType", "Confirmed", "Address", "Product"])
    assert.equal(key in parcel, false);
});

test("delivery client uses only the verified legacy Procolis methods and Colis bodies", async () => {
  const client = new DeliveryClient({
    credentials: { token: "token", key: "key" },
  });
  assert.equal(client.http.defaults.baseURL, "https://procolis.com/api_v1");
  const calls = [];
  client.request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/token") return { Statut: "Acc\u00e8s activ\u00e9" };
    if (path === "/tarification")
      return [
        { IDWilaya: "31", Wilaya: "Oran", Domicile: "500", Stopdesk: "300" },
      ];
    return { Colis: [] };
  };

  assert.equal(await client.testCredentials(), true);
  await client.createPackages({ Colis: [{ Tracking: "ORD-001" }] });
  await client.readPackages(["ORD-001", "ORD-002"]);
  await client.readyPackages(["ORD-001", "ORD-002"]);
  assert.equal((await client.getPricing())[0].IDWilaya, "31");
  assert.deepEqual(calls, [
    { method: "GET", path: "/token", body: undefined },
    {
      method: "POST",
      path: "/add_colis",
      body: { Colis: [{ Tracking: "ORD-001" }] },
    },
    {
      method: "POST",
      path: "/lire",
      body: {
        Colis: [{ Tracking: "ORD-001" }, { Tracking: "ORD-002" }],
      },
    },
    {
      method: "POST",
      path: "/pret",
      body: {
        Colis: [{ Tracking: "ORD-001" }, { Tracking: "ORD-002" }],
      },
    },
    { method: "POST", path: "/tarification", body: undefined },
  ]);

  client.request = async () => ({ Statut: "Acc\u00e8s refus\u00e9" });
  assert.equal(await client.testCredentials(), false);
});

test("sanitization redacts per-agency echoes before truncating strings", () => {
  const secret = "per-agency-secret";
  const clean = sanitizeProviderData(
    {
      message: "x".repeat(4995) + secret,
      details: "Authorization: Bearer sensitive-value\nCookie: session=private",
      nested: { token: secret, message: secret },
    },
    0,
    [secret],
  );
  assert.equal(clean.message.endsWith("per-a"), false);
  assert.equal(JSON.stringify(clean).includes("sensitive-value"), false);
  assert.equal(JSON.stringify(clean).includes("private"), false);
  assert.deepEqual(clean.nested, { message: "[redacted]" });
  assert.equal(
    parseCreationResult(
      { Package: [{ Tracking: "X" }, { error: "invalid" }] },
      "ORD",
    ).trackingFound,
    false,
  );
});
