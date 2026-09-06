import { z } from "zod";
import { assert } from "../errors.js";
import {
  BUSINESS,
  PAYMENT_METHODS,
  DELIVERY_TYPES,
  TRANSITIONS,
} from "../constants.js";
export const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export function normalizePhone(raw) {
  let n = String(raw || "").replace(/[\s().-]/g, "");
  if (n.startsWith("00213")) n = n.slice(2);
  if (n.startsWith("+")) n = n.slice(1);
  if (/^0[5-7]\d{8}$/.test(n)) n = "213" + n.slice(1);
  assert(
    /^213[5-7]\d{8}$/.test(n),
    "Enter a valid Algerian mobile number (05, 06 or 07; 10 digits).",
  );
  return "+" + n;
}
const id = z.string().regex(/^[a-f\d]{24}$/i, "Invalid record ID");
const amount = z
  .number()
  .finite()
  .min(0)
  .max(1e10)
  .refine(
    (v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.0001,
    "Use at most two decimal places",
  );
export const orderInput = z.object({
  customer: z.object({
    name: z.string().trim().min(2).max(150),
    phoneA: z.string().min(1).max(30),
    phoneB: z.string().max(30).optional().default(""),
  }),
  location: z.object({
    wilayaId: id,
    commune: z.string().trim().min(1).max(150),
    address: z.string().trim().min(3).max(500),
  }),
  note: z.string().max(2000).optional().default(""),
  sourceId: id.optional(),
  items: z
    .array(
      z.object({
        business: z.enum(BUSINESS),
        catalogItemId: id,
        unitPrice: amount.optional(),
        quantity: z.number().int().min(1).max(10000),
        isRenewal: z.boolean().optional().default(false),
      }),
    )
    .min(1)
    .max(50),
  delivery: z.object({
    agencyId: id.optional(),
    type: z.enum(DELIVERY_TYPES),
    exchange: z.boolean().default(false),
  }),
  deliveryCharged: amount.optional(),
  payment: z.object({
    method: z.enum(PAYMENT_METHODS),
    amountPaidOnline: amount.optional().default(0),
  }),
  revision: z.number().int().min(0).optional(),
});
export function calculateFinancials(items, deliveryCharged, payment) {
  const tamqoRevenue = round(
    items
      .filter((x) => x.business === "TAMQO")
      .reduce((s, x) => s + x.subtotal, 0),
  );
  const logixRevenue = round(
    items
      .filter((x) => x.business === "LOGIX")
      .reduce((s, x) => s + x.subtotal, 0),
  );
  const productRevenue = round(tamqoRevenue + logixRevenue),
    totalOrderValue = round(productRevenue + deliveryCharged);
  assert(
    Number.isSafeInteger(Math.round(totalOrderValue * 100)) &&
      totalOrderValue <= 1e10,
    "Order total exceeds the supported monetary limit.",
  );
  const paid = payment.amountPaidOnline;
  assert(paid <= totalOrderValue, "Online payment cannot exceed order total.");
  assert(
    payment.method !== "COD" || paid === 0,
    "COD orders cannot contain an online payment.",
  );
  assert(
    payment.method !== "ONLINE" || paid === totalOrderValue,
    "ONLINE requires the entire order to be prepaid. Use MIXED for unpaid delivery.",
  );
  assert(
    payment.method !== "MIXED" || (paid > 0 && paid < totalOrderValue),
    "MIXED requires a partial payment.",
  );
  const businesses = new Set(items.map((x) => x.business));
  return {
    tamqoRevenue,
    logixRevenue,
    productRevenue,
    deliveryCharged,
    totalOrderValue,
    businessType:
      businesses.size === 2
        ? "PARTNERSHIP"
        : businesses.has("TAMQO")
          ? "TAMQO_ONLY"
          : "LOGIX_ONLY",
    payment: {
      ...payment,
      amountToCollect: round(totalOrderValue - paid),
      amountCollected: 0,
    },
  };
}
export function canTransition(from, to, businessType) {
  return (
    TRANSITIONS[from]?.includes(to) ||
    (businessType === "TAMQO_ONLY" &&
      ["CONFIRMED", "PREPARING"].includes(from) &&
      to === "DELIVERED")
  );
}
export function canProviderTransition(from, to) {
  // Polling can miss intermediate provider states. Record only the observed transition,
  // never invent timestamps for the stages that were not observed.
  const seen = new Set([from]),
    queue = [from];
  while (queue.length) {
    for (const next of TRANSITIONS[queue.shift()] || []) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
