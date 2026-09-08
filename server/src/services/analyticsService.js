import { P, can, analyticsScope, saleScope } from "../authorization.js";
import { Order, Expense, Sale } from "../models/index.js";
import { round } from "../domain/order.js";
import { dateKey, reportingRange, dayStart } from "../domain/period.js";
import { objectId, orderFilter } from "./filters.js";
export const ratio = (a, b) => (b ? round((a / b) * 100) : 0);
export const average = (values) =>
  values.length ? round(values.reduce((s, x) => s + x, 0) / values.length) : 0;
export const growth = (current, previous) =>
  previous
    ? round(((current - previous) / previous) * 100)
    : current
      ? null
      : 0;
export const scopedItems = (o, scope) =>
  o.items.filter(
    (i) => !["TAMQO", "LOGIX"].includes(scope) || i.business === scope,
  );
export const scopedRevenue = (o, scope) =>
  round(scopedItems(o, scope).reduce((s, i) => s + i.subtotal, 0));
export const isConfirmed = (o) =>
  o.statusHistory.some((h) => h.status === "CONFIRMED");
export const isRealized = (o) =>
  Boolean(
    !["NEW", "CANCELLED", "RETURNED", "RETURNING"].includes(o.status) &&
    (o.status === "DELIVERED" ||
      (o.businessType === "TAMQO_ONLY" &&
        (o.tamqoActivatedAt ||
          o.payment.amountPaidOnline >= o.productRevenue))),
  );
const countStatus = (orders, status) =>
  orders.filter((o) => o.status === status).length;
const sum = (orders, fn) => round(orders.reduce((s, o) => s + fn(o), 0));
const terminal = ["DELIVERED", "CANCELLED", "RETURNED"];
function timing(orders, from, to) {
  return average(
    orders.flatMap((o) => {
      const a =
        from === "CREATED"
          ? o.createdAt
          : o.statusHistory.find((h) => h.status === from)?.at;
      const b =
        to === "TERMINAL"
          ? o.statusHistory.find((h) => terminal.includes(h.status))?.at
          : o.statusHistory.find((h) => h.status === to)?.at;
      return a && b && new Date(b) >= new Date(a)
        ? [(new Date(b) - new Date(a)) / 3600000]
        : [];
    }),
  );
}
export function summarize(orders, scope) {
  const n = orders.length,
    confirmed = orders.filter(isConfirmed),
    grossOrders = confirmed.filter((o) => o.status !== "CANCELLED"),
    realized = orders.filter(isRealized),
    pending = orders.filter(
      (o) =>
        !isRealized(o) &&
        !["CANCELLED", "RETURNED", "RETURNING"].includes(o.status),
    );
  const values = orders
      .map((o) => scopedRevenue(o, scope))
      .sort((a, b) => a - b),
    units = (o) => scopedItems(o, scope).reduce((s, i) => s + i.quantity, 0);
  const grossSales = sum(grossOrders, (o) => scopedRevenue(o, scope)),
    netSales = sum(realized, (o) => scopedRevenue(o, scope));
  const delivered = countStatus(orders, "DELIVERED"),
    cancelled = countStatus(orders, "CANCELLED"),
    returned = countStatus(orders, "RETURNED"),
    failed = countStatus(orders, "FAILED_DELIVERY"),
    prepaid = orders.filter((o) => o.payment.amountPaidOnline > 0);
  const revenueForStatus = (status) =>
    sum(
      orders.filter((o) => o.status === status),
      (o) => scopedRevenue(o, scope),
    );
  const newOrders = countStatus(orders, "NEW"),
    shipped = orders.filter((o) =>
      o.statusHistory.some((h) => h.status === "SHIPPED"),
    ).length;
  const renewals = realized.filter((o) =>
    scopedItems(o, scope).some((i) => i.business === "TAMQO" && i.isRenewal),
  );
  const subscriptionItems = realized.flatMap((o) =>
    scopedItems(o, scope).filter((i) => i.business === "TAMQO"),
  );
  return {
    totalOrders: n,
    confirmedOrders: confirmed.length,
    deliveredOrders: delivered,
    cancelledOrders: cancelled,
    returnedOrders: returned,
    pendingOrders: pending.length,
    failedDeliveryOrders: failed,
    totalUnitsSold: sum(realized, units),
    totalUnitsOrdered: sum(orders, units),
    grossSales,
    netSales,
    revenue: netSales,
    averageOrderValue: n
      ? round(sum(orders, (o) => scopedRevenue(o, scope)) / n)
      : 0,
    averageUnitsPerOrder: n ? round(sum(orders, units) / n) : 0,
    averageQuantityPerOrder: n ? round(sum(orders, units) / n) : 0,
    highestOrderValue: values.at(-1) || 0,
    lowestOrderValue: values[0] || 0,
    medianOrderValue: n
      ? round(
          n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2,
        )
      : 0,
    pendingSalesValue: sum(pending, (o) => scopedRevenue(o, scope)),
    cancelledOrderValue: revenueForStatus("CANCELLED"),
    returnedOrderValue: revenueForStatus("RETURNED"),
    failedDeliveryOrderValue: revenueForStatus("FAILED_DELIVERY"),
    confirmationRate: ratio(confirmed.length, n),
    deliverySuccessRate: ratio(delivered, Math.max(shipped, delivered)),
    cancellationRate: ratio(cancelled, n),
    returnRate: ratio(returned, n),
    failedDeliveryRate: ratio(failed, n),
    orderCompletionRate: ratio(realized.length, n),
    pendingRate: ratio(pending.length, n),
    averageConfirmationTime: timing(orders, "CREATED", "CONFIRMED"),
    averageFulfillmentTime: timing(orders, "CONFIRMED", "READY_TO_SHIP"),
    averageDeliveryTime: timing(orders, "SHIPPED", "DELIVERED"),
    averageOrderLifecycle: timing(orders, "CREATED", "TERMINAL"),
    ordersCreatedToday: orders.filter(
      (o) => dateKey(o.createdAt) === dateKey(new Date()),
    ).length,
    ordersAwaitingConfirmation: newOrders,
    ordersAwaitingFulfillment: orders.filter(
      (o) => ["CONFIRMED", "PREPARING"].includes(o.status) && !isRealized(o),
    ).length,
    ordersAwaitingDelivery: orders.filter((o) =>
      [
        "READY_TO_SHIP",
        "SHIPPED",
        "OUT_FOR_DELIVERY",
        "FAILED_DELIVERY",
      ].includes(o.status),
    ).length,
    totalCustomers: new Set(orders.map((o) => String(o.customerId))).size,
    codOrders: orders.filter((o) => o.payment.method === "COD").length,
    codRevenue: sum(
      realized.filter((o) => o.payment.method === "COD"),
      (o) => scopedRevenue(o, scope),
    ),
    prepaidOrders: prepaid.length,
    prepaidRevenue: sum(prepaid.filter(isRealized), (o) =>
      scopedRevenue(o, scope),
    ),
    prepaymentRate: ratio(prepaid.length, n),
    paymentSuccessRate: ratio(
      orders.filter(
        (o) =>
          o.payment.amountPaidOnline + o.payment.amountCollected >=
          o.totalOrderValue,
      ).length,
      n,
    ),
    amountCollected: sum(
      orders,
      (o) => o.payment.amountPaidOnline + o.payment.amountCollected,
    ),
    amountOutstanding: sum(
      orders.filter((o) => !["CANCELLED", "RETURNED"].includes(o.status)),
      (o) => Math.max(0, o.payment.amountToCollect - o.payment.amountCollected),
    ),
    outstandingPayments: orders.filter(
      (o) =>
        !["CANCELLED", "RETURNED"].includes(o.status) &&
        o.payment.amountToCollect > o.payment.amountCollected,
    ).length,
    homeDeliveryOrders: orders.filter((o) => o.delivery.type === "HOME").length,
    deskDeliveryOrders: orders.filter((o) => o.delivery.type === "STOP_DESK")
      .length,
    homeDeliveryRate: ratio(
      orders.filter((o) => o.delivery.type === "HOME").length,
      n,
    ),
    deskDeliveryRate: ratio(
      orders.filter((o) => o.delivery.type === "STOP_DESK").length,
      n,
    ),
    totalDeliveryCharged: sum(orders, (o) => o.deliveryCharged),
    deliveryRevenue: sum(realized, (o) => o.deliveryCharged),
    averageDeliveryCharge: average(orders.map((o) => o.deliveryCharged)),
    freeDeliveryOrders: orders.filter((o) => o.deliveryCharged === 0).length,
    renewals: renewals.length,
    renewalRate: ratio(
      renewals.length,
      realized.filter((o) =>
        scopedItems(o, scope).some((i) => i.business === "TAMQO"),
      ).length,
    ),
    renewalRevenue: sum(realized, (o) =>
      scopedItems(o, scope)
        .filter((i) => i.isRenewal)
        .reduce((s, i) => s + i.subtotal, 0),
    ),
    averageSubscriptionDuration: subscriptionItems.length
      ? round(
          subscriptionItems.reduce(
            (s, i) => s + (i.durationDays || 0) * i.quantity,
            0,
          ) / subscriptionItems.reduce((s, i) => s + i.quantity, 0),
        )
      : 0,
    multiUnitOrderRate: ratio(orders.filter((o) => units(o) > 1).length, n),
    tamqoUnitsSoldThroughPartnership: sum(
      realized.filter((o) => o.businessType === "PARTNERSHIP"),
      (o) =>
        o.items
          .filter((i) => i.business === "TAMQO")
          .reduce((s, i) => s + i.quantity, 0),
    ),
    logixUnitsSoldThroughPartnership: sum(
      realized.filter((o) => o.businessType === "PARTNERSHIP"),
      (o) =>
        o.items
          .filter((i) => i.business === "LOGIX")
          .reduce((s, i) => s + i.quantity, 0),
    ),
  };
}
const scopedSales = (sales, scope) =>
  scope === "PARTNERSHIP"
    ? []
    : sales.filter(
        (sale) =>
          !["TAMQO", "LOGIX"].includes(scope) || sale.business === scope,
      );
function addDirectSales(metrics, sales, scope) {
  const rows = scopedSales(sales, scope),
    revenue = sum(rows, (sale) => sale.amount),
    units = sum(rows, (sale) => sale.quantity);
  Object.assign(metrics, {
    directSalesCount: rows.length,
    directSalesRevenue: revenue,
    directSalesUnits: units,
    grossSales: round(metrics.grossSales + revenue),
    netSales: round(metrics.netSales + revenue),
    revenue: round(metrics.revenue + revenue),
    totalUnitsSold: metrics.totalUnitsSold + units,
  });
  return metrics;
}
export const summarizePerformance = (orders, sales, scope) =>
  addDirectSales(summarize(orders, scope), sales, scope);
function group(orders, scope, key) {
  const groups = new Map();
  for (const o of orders) {
    const name = key(o);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(o);
  }
  return [...groups]
    .map(([name, rows]) => ({ name, ...summarize(rows, scope) }))
    .sort((a, b) => b.netSales - a.netSales || b.totalOrders - a.totalOrders);
}
function performanceGroup(orders, sales, scope, orderKey, saleKey = orderKey) {
  const groups = new Map();
  for (const order of orders) {
    const name = orderKey(order),
      row = groups.get(name) || { orders: [], sales: [] };
    row.orders.push(order);
    groups.set(name, row);
  }
  for (const sale of scopedSales(sales, scope)) {
    const name = saleKey(sale),
      row = groups.get(name) || { orders: [], sales: [] };
    row.sales.push(sale);
    groups.set(name, row);
  }
  return [...groups]
    .map(([name, rows]) => ({
      name,
      ...summarizePerformance(rows.orders, rows.sales, scope),
    }))
    .sort(
      (a, b) =>
        b.netSales - a.netSales ||
        b.totalOrders - a.totalOrders ||
        b.directSalesCount - a.directSalesCount,
    );
}
export function buildReport(
  orders,
  previous,
  history,
  scope,
  range,
  sales = [],
  previousSales = [],
) {
  const metrics = summarizePerformance(orders, sales, scope),
    prior = summarizePerformance(previous, previousSales, scope),
    orderMetrics = summarize(orders, scope);
  const customerGroups = new Map(),
    selectedCustomers = new Map();
  for (const order of orders) {
    const key = String(order.customerId);
    if (!selectedCustomers.has(key)) selectedCustomers.set(key, []);
    selectedCustomers.get(key).push(order);
  }
  for (const o of history) {
    const key = String(o.customerId);
    if (!customerGroups.has(key)) customerGroups.set(key, []);
    customerGroups.get(key).push(o);
  }
  let returning = 0,
    newCustomers = 0,
    repeatCustomers = 0,
    recurringCustomerRevenue = 0;
  const intervals = [],
    topCustomers = [];
  for (const [id, list] of customerGroups) {
    list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const selected = selectedCustomers.get(id) || [];
    if (!selected.length) continue;
    if (new Date(list[0].createdAt) < range.start) returning++;
    else newCustomers++;
    if (list.length > 1) repeatCustomers++;
    for (let i = 1; i < list.length; i++)
      intervals.push(
        (new Date(list[i].createdAt) - new Date(list[i - 1].createdAt)) /
          86400000,
      );
    const customerLifetimeRevenue = sum(list.filter(isRealized), (o) =>
      scopedRevenue(o, scope),
    );
    const revenue = sum(selected.filter(isRealized), (o) =>
      scopedRevenue(o, scope),
    );
    if (list.length > 1) recurringCustomerRevenue += revenue;
    topCustomers.push({
      id,
      name: list.at(-1).customer.name,
      phone: list.at(-1).customer.phoneA,
      totalOrders: selected.length,
      lifetimeOrders: list.length,
      revenue,
      customerLifetimeRevenue,
    });
  }
  Object.assign(metrics, {
    salesGrowth: growth(metrics.grossSales, prior.grossSales),
    newCustomers,
    returningCustomers: returning,
    repeatPurchaseRate: ratio(repeatCustomers, metrics.totalCustomers),
    ordersPerCustomer: metrics.totalCustomers
      ? round(metrics.totalOrders / metrics.totalCustomers)
      : 0,
    revenuePerCustomer: metrics.totalCustomers
      ? round(orderMetrics.netSales / metrics.totalCustomers)
      : 0,
    customerLifetimeRevenue: round(
      topCustomers.reduce((s, c) => s + c.customerLifetimeRevenue, 0),
    ),
    repeatOrderInterval: average(intervals),
    recurringCustomerRevenue: round(recurringCustomerRevenue),
  });
  const partnership = orders.filter(
      (o) => o.businessType === "PARTNERSHIP" && isRealized(o),
    ),
    tamqo = sum(partnership, (o) => o.tamqoRevenue),
    logix = sum(partnership, (o) => o.logixRevenue);
  Object.assign(metrics, {
    tamqoRevenueThroughPartnership: tamqo,
    logixRevenueThroughPartnership: logix,
    tamqoRevenueShare: ratio(tamqo, tamqo + logix),
    logixRevenueShare: ratio(logix, tamqo + logix),
  });
  const products = new Map();
  for (const o of orders.filter(isRealized))
    for (const i of scopedItems(o, scope)) {
      const key = String(i.catalogItemId) + "|" + i.name;
      const p = products.get(key) || {
        name: i.name,
        business: i.business,
        revenue: 0,
        units: 0,
      };
      p.revenue = round(p.revenue + i.subtotal);
      p.units += i.quantity;
      products.set(key, p);
    }
  for (const sale of scopedSales(sales, scope)) {
    const key = String(sale.catalogItemId) + "|" + sale.itemName;
    const product = products.get(key) || {
      name: sale.itemName,
      business: sale.business,
      revenue: 0,
      units: 0,
    };
    product.revenue = round(product.revenue + sale.amount);
    product.units += sale.quantity;
    products.set(key, product);
  }
  const productRows = [...products.values()]
    .map((p) => ({
      ...p,
      averageSellingPrice: p.units ? round(p.revenue / p.units) : 0,
      revenueShare: ratio(p.revenue, metrics.netSales),
      unitShare: ratio(p.units, metrics.totalUnitsSold),
    }))
    .sort((a, b) => b.revenue - a.revenue);
  const sources = group(orders, scope, (o) => o.source.name),
    wilayas = group(orders, scope, (o) => o.location.wilayaName),
    communes = group(
      orders,
      scope,
      (o) => `${o.location.wilayaName} / ${o.location.commune}`,
    );
  const best = (rows, field) =>
    [...rows].sort((a, b) => b[field] - a[field])[0]?.name || "—";
  Object.assign(metrics, {
    mostPopularPlan: best(
      productRows.filter((p) => p.business === "TAMQO"),
      "units",
    ),
    highestRevenuePlan: best(
      productRows.filter((p) => p.business === "TAMQO"),
      "revenue",
    ),
    mostSoldProduct: best(
      productRows.filter((p) => p.business === "LOGIX"),
      "units",
    ),
    highestRevenueProduct: best(
      productRows.filter((p) => p.business === "LOGIX"),
      "revenue",
    ),
    bestSourceByRevenue: best(sources, "netSales"),
    bestSourceByDeliveryRate: best(sources, "deliverySuccessRate"),
    bestSourceByConfirmationRate: best(sources, "confirmationRate"),
    topWilaya: best(wilayas, "netSales"),
    worstWilayaByFailedDeliveries: best(wilayas, "failedDeliveryOrders"),
  });
  return {
    scope,
    range,
    metrics,
    previousMetrics: prior,
    trend: performanceGroup(
      orders,
      sales,
      scope,
      (order) => dateKey(order.createdAt),
      (sale) => dateKey(sale.saleDate),
    ).sort((a, b) => a.name.localeCompare(b.name)),
    sources,
    wilayas,
    communes,
    products: productRows,
    employees: performanceGroup(
      orders,
      sales,
      scope,
      (order) => String(order.createdBy?.userId || "legacy"),
      (sale) => String(sale.createdBy?.userId || "legacy"),
    ).map((row) => ({
      ...row,
      userId: row.name,
      name:
        orders.find((o) => String(o.createdBy?.userId || "legacy") === row.name)
          ?.createdBy?.name ||
        sales.find(
          (sale) => String(sale.createdBy?.userId || "legacy") === row.name,
        )?.createdBy?.name ||
        "Legacy / Unknown",
    })),
    agencies: group(orders, scope, (o) =>
      String(o.delivery.agencyId || "legacy"),
    ).map((row) => ({
      ...row,
      agencyId: row.name,
      name:
        orders.find((o) => String(o.delivery.agencyId || "legacy") === row.name)
          ?.delivery.agencyName || "Legacy / Unknown",
    })),
    payments: group(orders, scope, (o) => o.payment.method),
    delivery: group(orders, scope, (o) => o.delivery.type),
    topCustomers: topCustomers
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 20),
    definitions: {
      currency: "DZD",
      timeZone: "Africa/Algiers",
      grossSales:
        "Product value of orders that reached CONFIRMED, excluding cancelled orders, plus direct sales. Returns remain in gross sales.",
      netSales:
        "Realized order product revenue plus direct sales. Cancelled, returning and returned orders are excluded.",
      averageOrderValue:
        "Product value of all selected orders / selected order count.",
      totalUnitsSold: "Units on realized orders plus direct-sale quantities.",
      deliverySuccessRate:
        "Delivered orders / orders that reached SHIPPED (at least the delivered count).",
      customerLifetimeRevenue:
        "Realized scoped revenue through the end of the reporting period for customers present in the period.",
      paymentAndDelivery:
        "Whole-order cash collection and shipping context; non-additive across Tamqo and Logix.",
      growth:
        "Gross sales versus the immediately preceding range of equal duration; null when the previous value is zero.",
      cohort:
        "Orders selected by creation date; current order state determines realization.",
      partnershipShares:
        "Realized partnership product revenue, excluding shipping.",
    },
  };
}
export function directSaleFilter(query, scope, user) {
  const ownAnalytics =
      user &&
      !can(user, P.analytics.viewBusiness) &&
      !can(user, P.analytics.viewGlobal),
    filter = user ? saleScope(user, ownAnalytics) : {};
  if (["TAMQO", "LOGIX"].includes(scope)) filter.business = scope;
  if (scope === "PARTNERSHIP") filter._id = { $exists: false };
  if (query.employee) {
    const employeeId = objectId(query.employee);
    if (
      filter["createdBy.userId"] &&
      String(filter["createdBy.userId"]) !== String(employeeId)
    )
      filter._id = { $exists: false };
    else filter["createdBy.userId"] = employeeId;
  }
  if (query.catalog) filter.catalogItemId = objectId(query.catalog);
  if (
    [
      "business",
      "status",
      "payment",
      "deliveryType",
      "source",
      "wilaya",
      "commune",
      "phone",
      "customer",
      "customerId",
      "search",
    ].some((key) => query[key])
  )
    filter._id = { $exists: false };
  return filter;
}
export async function analytics(query, scope = "ALL", user) {
  const range = reportingRange(query),
    filter = orderFilter({ ...query, period: undefined });
  if (scope === "PARTNERSHIP") filter.businessType = "PARTNERSHIP";
  else if (["TAMQO", "LOGIX"].includes(scope)) filter["items.business"] = scope;
  if (user) filter.$and = [...(filter.$and || []), analyticsScope(user, scope)];
  const projection = { originalData: 0, __v: 0, note: 0 },
    directFilter = directSaleFilter(query, scope, user);
  const [orders, previous, sales, previousSales] = await Promise.all([
    Order.find(
      { ...filter, createdAt: { $gte: range.start, $lt: range.end } },
      projection,
    ).lean(),
    Order.find(
      {
        ...filter,
        createdAt: { $gte: range.previousStart, $lt: range.previousEnd },
      },
      projection,
    ).lean(),
    Sale.find({
      ...directFilter,
      saleDate: { $gte: range.start, $lt: range.end },
    }).lean(),
    Sale.find({
      ...directFilter,
      saleDate: { $gte: range.previousStart, $lt: range.previousEnd },
    }).lean(),
  ]);
  const ids = [...new Set(orders.map((o) => String(o.customerId)))];
  const history = ids.length
    ? await Order.find(
        {
          ...filter,
          customerId: { $in: ids },
          createdAt: { $lt: range.end },
          ...(scope === "PARTNERSHIP"
            ? { businessType: "PARTNERSHIP" }
            : ["TAMQO", "LOGIX"].includes(scope)
              ? { "items.business": scope }
              : {}),
        },
        projection,
      ).lean()
    : [];
  const result = buildReport(
    orders,
    previous,
    history,
    scope,
    range,
    sales,
    previousSales,
  );
  if (
    ["TAMQO", "LOGIX"].includes(scope) &&
    (!user ||
      (can(user, P.expenses.view) &&
        (can(user, P.analytics.viewBusiness) ||
          can(user, P.analytics.viewGlobal))))
  ) {
    const exp = await Expense.aggregate([
      {
        $match: {
          business: scope,
          expenseDate: { $gte: range.start, $lt: range.end },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    result.metrics.totalExpenses = exp[0]?.total || 0;
  }
  return result;
}
export async function expenseSummary(filter, range) {
  const [rows, previous] = await Promise.all([
    Expense.find(filter).lean(),
    Expense.aggregate([
      {
        $match: {
          ...filter,
          expenseDate: { $gte: range.previousStart, $lt: range.previousEnd },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
  ]);
  const amounts = rows.map((e) => e.amount),
    total = round(amounts.reduce((s, x) => s + x, 0)),
    today = dayStart(),
    now = dateKey(new Date());
  const groupExpenses = (key) => {
    const map = new Map();
    for (const e of rows) {
      const name = key(e);
      map.set(name, round((map.get(name) || 0) + e.amount));
    }
    return [...map]
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };
  return {
    totalExpenses: total,
    expensesToday: sum(
      rows.filter(
        (e) =>
          new Date(e.expenseDate) >= today &&
          new Date(e.expenseDate) < new Date(+today + 86400000),
      ),
      (e) => e.amount,
    ),
    expensesThisMonth: sum(
      rows.filter(
        (e) => dateKey(e.expenseDate).slice(0, 7) === now.slice(0, 7),
      ),
      (e) => e.amount,
    ),
    expensesThisYear: sum(
      rows.filter(
        (e) => dateKey(e.expenseDate).slice(0, 4) === now.slice(0, 4),
      ),
      (e) => e.amount,
    ),
    averageExpense: average(amounts),
    highestExpense: amounts.reduce((max, amount) => Math.max(max, amount), 0),
    expenseCount: rows.length,
    expenseGrowth: growth(total, previous[0]?.total || 0),
    byEmployee: groupExpenses((e) => e.createdBy?.name || "Legacy / Unknown"),
    expensesThisWeek: sum(
      rows.filter(
        (e) =>
          new Date(e.expenseDate) >= reportingRange({ period: "week" }).start,
      ),
      (e) => e.amount,
    ),
    byCategory: groupExpenses((e) => e.category || "Uncategorized"),
    byMonth: groupExpenses((e) => dateKey(e.expenseDate).slice(0, 7)),
  };
}
