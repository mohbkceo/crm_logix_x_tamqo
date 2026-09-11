import mongoose from "mongoose";
import { DeliveryAgency, DeliveryRate } from "../models/delivery.js";
import { audit } from "../models/security.js";
import {
  Order,
  OrderEvent,
  Customer,
  Counter,
  OrderSource,
  Wilaya,
  Shipment,
} from "../models/index.js";
import {
  orderInput,
  normalizePhone,
  round,
  calculateFinancials,
  canTransition,
  canProviderTransition,
} from "../domain/order.js";
import { assert } from "../errors.js";
import { resolveCatalogItem } from "./catalogService.js";
export const transaction = (fn) => mongoose.connection.transaction(fn);
export async function allocateOrderNumber() {
  // Allocate outside order transactions so rolled-back numbers are never reused.
  const year = new Date().getUTCFullYear();
  const counter = await Counter.findOneAndUpdate(
    { _id: `orders-${year}` },
    { $inc: { value: 1 } },
    { upsert: true, new: true },
  );
  return `ORD-${year}-${String(counter.value).padStart(6, "0")}`;
}
export async function materialize(input, session, existing) {
  const p = orderInput.parse(input),
    phone = normalizePhone(p.customer.phoneA);
  const wilaya = await Wilaya.findById(p.location.wilayaId).session(session);
  assert(
    wilaya &&
      (wilaya.active ||
        String(existing?.location.wilayaId) === p.location.wilayaId),
    "Select an active Wilaya.",
  );
  const source = await (
    p.sourceId
      ? OrderSource.findById(p.sourceId)
      : OrderSource.findOne({ active: true, isDefault: true })
  ).session(session);
  assert(
    source && (source.active || String(existing?.source.id) === p.sourceId),
    "Select an active source.",
  );
  const items = [];
  for (const item of p.items) {
    const old = existing?.items.find(
      (x) =>
        String(x.catalogItemId) === item.catalogItemId &&
        x.business === item.business,
    );
    const catalog = await resolveCatalogItem(
      item.business,
      item.catalogItemId,
      {
        session,
        allowInactive: Boolean(old),
      },
    );
    const price = item.unitPrice ?? old?.unitPrice ?? catalog.price;
    items.push({
      ...item,
      type: item.business === "TAMQO" ? "PLAN" : "PRODUCT",
      name: old?.name ?? catalog.name,
      unitPrice: price,
      subtotal: round(price * item.quantity),
      durationDays: old?.durationDays ?? catalog.durationDays,
      isRenewal: item.business === "TAMQO" && item.isRenewal,
    });
  }
  const customer = {
    ...p.customer,
    normalizedPhone: phone,
    normalizedPhoneB: p.customer.phoneB
      ? normalizePhone(p.customer.phoneB)
      : "",
  };
  const person = await Customer.findOneAndUpdate(
    { normalizedPhone: phone },
    { $set: customer },
    { upsert: true, new: true, session, runValidators: true },
  );
  const agency = await (
    p.delivery.agencyId
      ? DeliveryAgency.findById(p.delivery.agencyId)
      : DeliveryAgency.findOne({ code: "ABEX" })
  ).session(session);
  assert(
    agency &&
      (agency.active ||
        String(existing?.delivery.agencyId) === String(agency._id)),
    "Select an active delivery agency",
  );
  assert(
    items.every((i) => agency.businesses.includes(i.business)),
    "Delivery agency must serve every order business",
  );
  const rate = await DeliveryRate.findOne({
    agencyId: agency._id,
    wilayaId: wilaya._id,
    active: true,
  }).session(session);
  assert(
    p.deliveryCharged !== undefined || rate,
    "No active agency rate. Enter a delivery cost override.",
  );
  const deliveryCharged =
    p.deliveryCharged ??
    (p.delivery.type === "HOME" ? rate.homePrice : rate.deskPrice);
  return {
    customerId: person._id,
    customer,
    location: {
      ...p.location,
      wilayaName:
        existing && String(existing.location.wilayaId) === p.location.wilayaId
          ? existing.location.wilayaName
          : wilaya.name,
      agencyId: wilaya.agencyId,
    },
    source: {
      id: source._id,
      name:
        existing && String(existing.source.id) === String(source._id)
          ? existing.source.name
          : source.name,
    },
    items,
    note: p.note,
    delivery: {
      ...p.delivery,
      agencyId: agency._id,
      agencyName:
        String(existing?.delivery.agencyId) === String(agency._id)
          ? existing.delivery.agencyName
          : agency.name,
      charged: deliveryCharged,
    },
    ...calculateFinancials(items, deliveryCharged, p.payment),
  };
}
export async function createOrder(input, actor = "admin") {
  const orderNumber = await allocateOrderNumber();
  return transaction(async (session) => {
    const data = await materialize(input, session);
    const [order] = await Order.create(
      [
        {
          ...data,
          orderNumber,
          createdBy: typeof actor === "object" ? actor : undefined,
          lastUpdatedBy: typeof actor === "object" ? actor : undefined,
          originalData: data,
          statusHistory: [{ status: "NEW", at: new Date(), actor }],
        },
      ],
      { session },
    );
    await OrderEvent.create(
      [
        {
          orderId: order._id,
          kind: "CREATED",
          type: "ORDER_CREATED",
          actor,
          toStatus: "NEW",
          message: "Order created",
        },
      ],
      { session },
    );
    await audit(
      actor,
      "ORDER_CREATED",
      "Order",
      order._id,
      order.businessType,
      {},
      session,
    );
    return order;
  });
}
export async function editOrder(id, input, actor = "admin") {
  return transaction(async (session) => {
    const order = await Order.findById(id).session(session);
    assert(order, "Order not found", 404);
    assert(
      ["NEW", "CONFIRMED", "PREPARING"].includes(order.status),
      "This order can no longer be edited.",
      409,
    );
    assert(
      !(await Shipment.exists({ orderId: id }).session(session)),
      "An order with a shipment cannot be edited; its parcel data must remain consistent.",
      409,
    );
    assert(
      input.revision === order.revision,
      "This order changed. Reload before saving.",
      409,
    );
    const data = await materialize(input, session, order);
    await OrderEvent.create(
      [
        {
          orderId: id,
          kind: "EDITED",
          type: "ORDER_UPDATED",
          actor,
          message: "Order details updated",
          data: { before: order.toObject(), after: data },
        },
      ],
      { session },
    );
    Object.assign(order, data);
    order.lastUpdatedBy =
      typeof actor === "object" ? actor : order.lastUpdatedBy;
    await audit(
      actor,
      "ORDER_UPDATED",
      "Order",
      order._id,
      order.businessType,
      {},
      session,
    );
    order.revision++;
    await order.save({ session });
    return order;
  });
}
export async function transition(id, to, actor = "admin", sessionOverride) {
  const run = async (session) => {
    const order = await Order.findById(id).session(session);
    assert(order, "Order not found", 404);
    if (order.status === to) return order;
    assert(
      actor === "courier"
        ? canProviderTransition(order.status, to)
        : canTransition(order.status, to, order.businessType),
      `Cannot change ${order.status} to ${to}.`,
      409,
    );
    const from = order.status;
    if (typeof actor === "object") order.lastUpdatedBy = actor;
    await audit(
      actor,
      `ORDER_${to}`,
      "Order",
      order._id,
      order.businessType,
      {},
      session,
    );
    order.status = to;
    order.statusHistory.push({ status: to, at: new Date(), actor });
    order.revision++;
    await order.save({ session });
    await OrderEvent.create(
      [
        {
          orderId: id,
          kind: "STATUS",
          type: `ORDER_${to}`,
          source: actor === "courier" ? "DELIVERY_PROVIDER" : "INTERNAL",
          fromStatus: from,
          toStatus: to,
          actor,
          message: `${from} → ${to}`,
        },
      ],
      { session },
    );
    return order;
  };
  return sessionOverride ? run(sessionOverride) : transaction(run);
}
