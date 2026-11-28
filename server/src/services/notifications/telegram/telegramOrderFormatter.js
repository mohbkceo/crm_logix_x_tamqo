import { config } from "../../../config.js";
import { STAGE_LABELS } from "../../../../../shared/tracking.js";

export const STATUS_EMOJI = Object.freeze({
  NEW: "🟡",
  CONFIRMED: "🔵",
  PREPARING: "🟠",
  READY_TO_SHIP: "🟣",
  SHIPPED: "🚚",
  OUT_FOR_DELIVERY: "🚛",
  DELIVERED: "🟢",
  FAILED_DELIVERY: "⚠️",
  RETURNING: "↩️",
  RETURNED: "❌",
  CANCELLED: "🔴",
});
const DAY = 86400000;

// Telegram HTML parse mode only requires &, < and > to be escaped; quotes are
// escaped too so values remain safe inside attributes.
export const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
// Same convention as the CRM client (`money` in client/src/api.js).
export const formatMoney = (n) =>
  new Intl.NumberFormat("en-DZ", { maximumFractionDigits: 2 }).format(n || 0) +
  " DA";
export const humanStatus = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
export const statusLine = (status) =>
  `${STATUS_EMOJI[status] || "⚪"} ${escapeHtml(String(status || "").replace(/_/g, " "))}`;
export const totalQuantity = (order) =>
  (order.items || []).reduce(
    (sum, item) => sum + (Number(item.quantity) || 0),
    0,
  );

// Open Order is a URL button; Telegram rejects non-HTTPS/localhost URLs, so the
// button is only included for a public HTTPS application origin.
// The CRM frontend route /orders/:id on the configured public application URL.
export function orderUrl(order) {
  const base = String(config.clientUrl || "").replace(/\/+$/, "");
  return /^https:\/\//i.test(base) ? `${base}/orders/${order._id}` : "";
}

export function orderSummary(order, shipment, { title = "🆕 ORDER" } = {}) {
  const tracking = shipment?.tracking;
  const quantity = totalQuantity(order);
  return [
    `<b>${title} · #${escapeHtml(order.orderNumber)}</b>`,
    "",
    // Employee who submitted the order (historical name stored on the order).
    ...(order.createdBy?.name
      ? [`👤 By: ${escapeHtml(order.createdBy.name)}`, ""]
      : []),
    `<b>${statusLine(order.status)}</b>`,
    "",
    `📦 Tracking: ${tracking ? `<code>${escapeHtml(tracking)}</code>` : "Pending"}`,
    "",
    `💰 ${escapeHtml(formatMoney(order.totalOrderValue))} | ${quantity} ${quantity === 1 ? "Unit" : "Units"}`,
    "",
    `👤 ${escapeHtml(order.customer?.name || "—")} | ${escapeHtml(order.location?.wilayaName || "—")}`,
    `📞 <code>${escapeHtml(order.customer?.phoneA || "—")}</code>`,
  ].join("\n");
}

// Callback data: compact, non-sensitive, <= 64 bytes. Order revision guards
// against stale buttons.
export const cb = {
  statusMenu: (order) => `s:${order._id}:${order.revision}`,
  back: (order) => `b:${order._id}:${order.revision}`,
  action: (order, code) => `t:${order._id}:${order.revision}:${code}`,
  page: (command, page) => `p:${command}:${page}`,
};

// Telegram only accepts http(s)/tg URL buttons; anything else is dropped so a
// malformed contact never breaks the whole keyboard.
const contactButton = (contact) =>
  contact?.name && /^https:\/\/wa\.me\/[1-9]\d{7,14}$/.test(contact.url || "")
    ? [{ text: `Contact ${String(contact.name).slice(0, 40)}`, url: contact.url }]
    : [];

// `contact` is the order creator's WhatsApp link from loadCreatorContact().
export function summaryKeyboard(order, shipment, contact = null) {
  const url = orderUrl(order);
  const first = [
    ...(url ? [{ text: "Open Order", url }] : []),
    { text: "Update Status", callback_data: cb.statusMenu(order) },
  ];
  const second = [
    ...contactButton(contact),
    ...(order.customer?.phoneA
      ? [
          {
            text: "Copy Phone",
            copy_text: { text: String(order.customer.phoneA).slice(0, 256) },
          },
        ]
      : []),
  ];
  return [first, ...(second.length ? [second] : [])];
}

export const daysSince = (date, now = new Date()) =>
  date ? Math.max(0, Math.floor((now - new Date(date)) / DAY)) : null;
const ago = (days) =>
  days == null
    ? ""
    : days === 0
      ? "today"
      : days === 1
        ? "1 day"
        : `${days} days`;

export function orderLine(
  order,
  { stage = false, shipment, now = new Date() } = {},
) {
  const head = `<b>#${escapeHtml(order.orderNumber)}</b>`;
  const who = `${escapeHtml(order.customer?.name || "—")} | ${escapeHtml(order.location?.wilayaName || "—")}`;
  let detail;
  if (stage && order.tracking?.stage) {
    detail = `${escapeHtml(STAGE_LABELS[order.tracking.stage] || order.tracking.stage)} · ${ago(daysSince(order.tracking.stageEnteredAt, now))}`;
  } else {
    detail = `${statusLine(order.status)} · ${escapeHtml(formatMoney(order.totalOrderValue))}`;
    if (shipment?.tracking)
      detail += ` · <code>${escapeHtml(shipment.tracking)}</code>`;
  }
  return `${head}\n${who}\n${detail}`;
}
