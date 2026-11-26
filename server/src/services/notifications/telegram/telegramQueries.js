import { Order, Shipment } from "../../../models/index.js";
import { P, can, orderScope } from "../../../authorization.js";
import { trackingScope } from "../../trackingService.js";
import { dayStart, dateKey, reportingRange } from "../../../domain/period.js";
import { escapeRegex } from "../../filters.js";
import { STATUSES, BUSINESS_TYPES } from "../../../constants.js";
import { AppError } from "../../../errors.js";
import {
  cb,
  escapeHtml,
  formatMoney,
  humanStatus,
  orderLine,
  orderUrl,
  STATUS_EMOJI,
} from "./telegramOrderFormatter.js";

export const PAGE_SIZE = 10;
const DAY = 86400000;
const notDeleted = { deletedAt: { $exists: false } };

const canViewOrders = (user) =>
  can(user, P.orders.viewAll) || can(user, P.orders.viewOwn);
// The same visibility rules as the CRM: order permissions use orderScope;
// production lists also accept the Tracking scope.
export function readScope(user, { production = false } = {}) {
  if (production && can(user, P.tracking.view)) return trackingScope(user);
  if (canViewOrders(user))
    return orderScope(user, !can(user, P.orders.viewAll));
  throw new AppError(
    "You do not have permission to view orders.",
    403,
    "TELEGRAM_PERMISSION",
  );
}

// Paginated list definitions. Keys are the compact callback codes.
export const LISTS = {
  wp: {
    command: "week_production",
    title: "🏭 PRODUCTION · LAST 7 DAYS",
    production: true,
    filter: (now) => ({
      createdAt: { $gte: new Date(+now - 7 * DAY), $lte: now },
      "tracking.stage": "AT_PRODUCTION",
    }),
    // Longest time in the current stage first.
    sort: { "tracking.stageEnteredAt": 1, _id: 1 },
  },
  pr: {
    command: "production",
    title: "🏭 AT PRODUCTION",
    production: true,
    filter: () => ({ "tracking.stage": "AT_PRODUCTION" }),
    sort: { "tracking.stageEnteredAt": 1, _id: 1 },
  },
  pp: {
    command: "preparing",
    title: "🟠 PREPARING (PRODUCTION STAGE)",
    production: true,
    filter: () => ({ "tracking.stage": "PREPARING" }),
    sort: { "tracking.stageEnteredAt": 1, _id: 1 },
  },
  rs: {
    command: "ready_to_ship",
    title: "🟣 READY TO SHIP (PRODUCTION STAGE)",
    production: true,
    filter: () => ({ "tracking.stage": "READY_TO_SHIP" }),
    sort: { "tracking.stageEnteredAt": 1, _id: 1 },
  },
  td: {
    command: "today",
    title: "📅 CREATED TODAY",
    filter: (now) => ({ createdAt: { $gte: dayStart(now), $lte: now } }),
  },
  pc: {
    command: "pending_confirmation",
    title: "🟡 PENDING CONFIRMATION",
    filter: () => ({ status: "NEW" }),
    sort: { createdAt: 1, _id: 1 },
  },
  rc: {
    command: "recent",
    title: "🕘 LATEST ORDERS",
    filter: () => ({}),
    single: true,
  },
  sh: {
    command: "shipped",
    title: "🚚 SHIPPED",
    filter: () => ({ status: "SHIPPED" }),
  },
  fd: {
    command: "failed_delivery",
    title: "⚠️ FAILED DELIVERY (COURIER)",
    filter: () => ({ status: "FAILED_DELIVERY" }),
  },
  si: {
    command: "shipment_issues",
    title: "🛠 SHIPMENT SYNC ISSUES",
    note: "Courier synchronization errors — not delivery failures. Use /failed_delivery for courier delivery failures.",
    shipmentErrors: true,
    filter: () => ({}),
  },
};
export const LIST_BY_COMMAND = Object.fromEntries(
  Object.entries(LISTS).map(([code, list]) => [list.command, code]),
);

function navigation(code, page, pages) {
  if (pages <= 1) return [];
  const row = [];
  if (page > 1)
    row.push({ text: "◀ Prev", callback_data: cb.page(code, page - 1) });
  row.push({ text: `${page}/${pages}`, callback_data: "n" });
  if (page < pages)
    row.push({ text: "Next ▶", callback_data: cb.page(code, page + 1) });
  return [row];
}
function openButtons(orders) {
  const buttons = orders
    .map((o) => ({ o, url: orderUrl(o) }))
    .filter((x) => x.url)
    .map(({ o, url }) => ({
      text: `Open ${o.orderNumber.replace(/^ORD-\d{4}-0*/, "#")}`,
      url,
    }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2)
    rows.push(buttons.slice(i, i + 2));
  return rows;
}

export async function renderList(user, code, page = 1, now = new Date()) {
  const list = LISTS[code];
  if (!list) throw new AppError("Unknown list.", 400, "TELEGRAM_UNKNOWN");
  const filter = {
    $and: [
      readScope(user, { production: list.production }),
      notDeleted,
      list.filter(now),
    ],
  };
  let issues = new Map();
  if (list.shipmentErrors) {
    const errored = await Shipment.find({ syncStatus: "ERROR" })
      .select("orderId lastError tracking")
      .lean();
    issues = new Map(errored.map((s) => [String(s.orderId), s]));
    filter.$and.push({ _id: { $in: errored.map((s) => s.orderId) } });
  }
  const total = list.single
    ? Math.min(PAGE_SIZE, await Order.countDocuments(filter))
    : await Order.countDocuments(filter);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  page = Math.min(Math.max(1, Number(page) || 1), pages);
  const orders = await Order.find(filter)
    .select(
      "orderNumber customer.name location.wilayaName status totalOrderValue tracking.stage tracking.stageEnteredAt createdAt",
    )
    .sort(list.sort || { createdAt: -1, _id: -1 })
    .skip((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();
  const shipments = list.production
    ? []
    : await Shipment.find({ orderId: { $in: orders.map((o) => o._id) } })
        .select("orderId tracking")
        .lean();
  const lines = orders.map((o) => {
    let line = orderLine(o, {
      stage: list.production,
      now,
      shipment: shipments.find((s) => String(s.orderId) === String(o._id)),
    });
    const issue = issues.get(String(o._id));
    if (issue)
      line += `\n🛠 ${escapeHtml(String(issue.lastError || "Courier sync error").slice(0, 160))}`;
    return line;
  });
  const text = [
    `<b>${list.title}</b>`,
    ...(list.note ? [`<i>${escapeHtml(list.note)}</i>`] : []),
    "",
    `Total: ${total} ${total === 1 ? "Order" : "Orders"}`,
    "",
    lines.length ? lines.join("\n\n") : "No matching orders.",
  ].join("\n");
  return {
    text,
    keyboard: [
      ...openButtons(orders),
      ...(list.single ? [] : navigation(code, page, pages)),
    ],
  };
}

// /order accepts an order number or a courier tracking number.
export async function findOrder(user, query) {
  const q = String(query || "")
    .trim()
    .slice(0, 150);
  if (!q) return null;
  const scope = readScope(user);
  const byNumber = await Order.findOne({
    $and: [scope, notDeleted, { orderNumber: q.toUpperCase() }],
  })
    .select("_id")
    .lean();
  if (byNumber) return byNumber._id;
  const shipment =
    (await Shipment.findOne({ tracking: q }).select("orderId").lean()) ||
    (await Shipment.findOne({
      tracking: { $regex: `^${escapeRegex(q)}$`, $options: "i" },
    })
      .select("orderId")
      .lean());
  if (!shipment) return null;
  const visible = await Order.findOne({
    $and: [scope, notDeleted, { _id: shipment.orderId }],
  })
    .select("_id")
    .lean();
  return visible?._id || null;
}

// Operational counts only. Order value includes delivery and is NOT realized
// revenue (see the Reports page for recognized revenue).
export async function weekSummary(user, now = new Date()) {
  const range = reportingRange({ period: "7d" }, now);
  const match = {
    $and: [
      readScope(user),
      notDeleted,
      { createdAt: { $gte: range.start, $lt: range.end } },
    ],
  };
  const [byStatus, byBusiness] = await Promise.all([
    Order.aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$businessType",
          count: { $sum: 1 },
          value: { $sum: "$totalOrderValue" },
        },
      },
    ]),
  ]);
  const total = byStatus.reduce((s, r) => s + r.count, 0);
  const value = byBusiness.reduce((s, r) => s + r.value, 0);
  const statusLines = STATUSES.map((s) => [
    s,
    byStatus.find((r) => r._id === s)?.count || 0,
  ])
    .filter(([, n]) => n)
    .map(([s, n]) => `${STATUS_EMOJI[s]} ${escapeHtml(humanStatus(s))}: ${n}`);
  const businessLines = BUSINESS_TYPES.map((b) => [
    b,
    byBusiness.find((r) => r._id === b),
  ])
    .filter(([, r]) => r)
    .map(
      ([b, r]) =>
        `• ${escapeHtml(humanStatus(b))}: ${r.count} · ${escapeHtml(formatMoney(r.value))}`,
    );
  return [
    "<b>📊 SUMMARY · LAST 7 DAYS</b>",
    `<i>${escapeHtml(dateKey(range.start))} → today (Africa/Algiers)</i>`,
    "",
    `Total: ${total} ${total === 1 ? "Order" : "Orders"}`,
    `Order value (incl. delivery): ${escapeHtml(formatMoney(value))}`,
    "<i>Order value is not realized revenue.</i>",
    ...(statusLines.length ? ["", "<b>By status</b>", ...statusLines] : []),
    ...(businessLines.length
      ? ["", "<b>By business</b>", ...businessLines]
      : []),
  ].join("\n");
}
