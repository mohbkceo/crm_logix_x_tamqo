import mongoose from "mongoose";
import { assert } from "../errors.js";
import {
  BUSINESS_TYPES,
  STATUSES,
  PAYMENT_METHODS,
  DELIVERY_TYPES,
} from "../constants.js";
import { reportingRange } from "../domain/period.js";
export const escapeRegex = (s) =>
  String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const objectId = (s) => {
  assert(typeof s === "string" && mongoose.isValidObjectId(s), "Invalid ID");
  return new mongoose.Types.ObjectId(s);
};
export function pagination(q) {
  const page = Math.max(1, Number(q.page) || 1),
    limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
  assert(
    Number.isInteger(page) && Number.isInteger(limit) && page <= 100000,
    "Invalid pagination",
  );
  return { page, limit, skip: (page - 1) * limit };
}
export function orderFilter(q = {}) {
  const f = {};
  for (const [key, values, path] of [
    ["business", BUSINESS_TYPES, "businessType"],
    ["status", STATUSES, "status"],
    ["payment", PAYMENT_METHODS, "payment.method"],
    ["deliveryType", DELIVERY_TYPES, "delivery.type"],
  ])
    if (q[key]) {
      assert(values.includes(q[key]), `Invalid ${key}`);
      f[path] = q[key];
    }
  for (const [key, path] of [
    ["source", "source.id"],
    ["employee", "createdBy.userId"],
    ["wilaya", "location.wilayaId"],
    ["catalog", "items.catalogItemId"],
    ["customerId", "customerId"],
  ])
    if (q[key]) f[path] = objectId(q[key]);
  if (q.commune)
    f["location.commune"] = { $regex: escapeRegex(q.commune), $options: "i" };
  if (q.phone)
    f.$and = [
      {
        $or: [
          { "customer.phoneA": { $regex: escapeRegex(q.phone) } },
          { "customer.normalizedPhone": { $regex: escapeRegex(q.phone) } },
        ],
      },
    ];
  if (q.customer)
    f["customer.name"] = { $regex: escapeRegex(q.customer), $options: "i" };
  if (q.search) {
    assert(String(q.search).length <= 200, "Search is too long");
    const r = { $regex: escapeRegex(q.search), $options: "i" };
    f.$or = [
      { orderNumber: r },
      { "customer.name": r },
      { "customer.phoneA": r },
      { "customer.normalizedPhone": r },
    ];
  }
  if (q.period) {
    const { start, end } = reportingRange(q);
    f.createdAt = { $gte: start, $lt: end };
  }
  return f;
}
