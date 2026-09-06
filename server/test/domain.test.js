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
} from "../src/services/delivery/deliveryMapper.js";
import { buildReport, isRealized } from "../src/services/analyticsService.js";
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
    p = mapOrderToPackage(order).Package[0];
  assert.equal(p.Total, "500");
  assert.equal(p.id_Externe, "ORD-2026-000123");
  assert.equal(p.DeliveryType, "0");
  assert.equal(p.TypeColis, "0");
  assert.equal(p.Source, "Messages");
  assert.equal(p.Confirmed, "");
  order.delivery = { type: "STOP_DESK", exchange: true };
  assert.equal(
    mapOrderToPackage(order, { confirmed: true }).Package[0].DeliveryType,
    "1",
  );
  assert.equal(
    mapOrderToPackage(order, { confirmed: true }).Package[0].TypeColis,
    "1",
  );
  assert.equal(
    mapOrderToPackage(order, { confirmed: true }).Package[0].Confirmed,
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
test("transitions reject lifecycle regressions and allow digital completion", () => {
  assert.equal(canTransition("NEW", "DELIVERED", "LOGIX_ONLY"), false);
  assert.equal(canTransition("RETURNED", "SHIPPED", "LOGIX_ONLY"), false);
  assert.equal(canTransition("CONFIRMED", "DELIVERED", "TAMQO_ONLY"), true);
});
