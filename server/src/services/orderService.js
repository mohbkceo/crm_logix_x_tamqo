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
  Expense,
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
import { ensureReturnExpense, reverseReturnExpense } from "./delivery/deliveryFinancialService.js";
import { providerFor } from "./delivery/deliveryProviderFactory.js";
import { mapOrderToPackage, sanitizeProviderData } from "./delivery/deliveryMapper.js";
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
export async function materialize(input, session, existing, { persistCustomer = true } = {}) {
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
  const person = persistCustomer ? await Customer.findOneAndUpdate(
    { normalizedPhone: phone },
    { $set: customer },
    { upsert: true, new: true, session, runValidators: true },
  ) : await Customer.findOne({ normalizedPhone: phone }).session(session);
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
    customerId: person?._id || existing?.customerId,
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
const editable = (order) => {
  assert(order, "Order not found", 404);
  assert(!order.deletedAt && ["NEW", "CONFIRMED", "PREPARING", "READY_TO_SHIP",
    "SHIPPED", "OUT_FOR_DELIVERY", "FAILED_DELIVERY"].includes(order.status),
    "This order can no longer be edited.", 409);
};
const parcelOptions = (order) => ({ confirmed: ["READY_TO_SHIP", "SHIPPED", "OUT_FOR_DELIVERY", "FAILED_DELIVERY"].includes(order.status) });
const sameParcel = (before, after) => JSON.stringify(mapOrderToPackage(before, parcelOptions(before))) ===
  JSON.stringify(mapOrderToPackage(after, parcelOptions(after)));
const safeFailure = (error) => sanitizeProviderData(error instanceof Error ? error.message : "Courier synchronization failed");
async function syncFailure(id, shipment, actor, action, error) {
  const message = safeFailure(error);
  await transaction(async (session) => {
    await Shipment.updateOne({ _id: shipment._id }, { $set: { syncStatus: "ERROR", lastError: message, lockUntil: null } }, { session });
    await OrderEvent.create([{ orderId: id, kind: "SHIPMENT", type: action, actor,
      message: `Courier synchronization failed: ${message}` }], { session });
    await audit(actor, action, "Order", id, undefined, { error: message }, session);
  });
}
const shipmentBusy = (s) => !s?.lockUntil || s.lockUntil < new Date();
const moneyCents = (n) => Math.round(Number(n || 0) * 100);
async function reserveProviderAction(id, revision, shipment) {
  await transaction(async (session) => {
    const order = await Order.findById(id).session(session);
    assert(order && !order.deletedAt && order.revision === revision,
      "This order changed. Reload before synchronizing the courier.", 409);
    const reserved = await Shipment.findOneAndUpdate({ _id: shipment._id,
      $or: [{ lockUntil: null }, { lockUntil: { $lte: new Date() } }] },
      { $set: { lockUntil: new Date(Date.now() + 60000), syncStatus: "PENDING", lastError: "" } },
      { session, new: true });
    assert(reserved, "A courier request is in progress. Reload later.", 409);
  });
}
export async function editOrder(id, input, actor = "admin") {
  const order = await Order.findById(id);
  editable(order);
  assert(input.revision === order.revision, "This order changed. Reload before saving.", 409);
  const shipment = await Shipment.findOne({ orderId: id });
  assert(shipmentBusy(shipment), "A courier request is in progress. Reload later.", 409);
  const preview = await materialize(input, null, order, { persistCustomer: false });
  assert(moneyCents(order.payment.amountCollected) <= moneyCents(preview.payment.amountToCollect),
    "Courier collection exceeds the edited balance.", 409);
  assert(moneyCents(order.refundedAmount) <= moneyCents(preview.payment.amountPaidOnline) + moneyCents(order.payment.amountCollected),
    "Edited payments cannot be less than the amount already refunded.", 409);
  for (const refund of order.refunds || [])
    for (const business of ["LOGIX", "TAMQO"])
      assert(!refund.allocations?.[business] || preview.items.some((item) => item.business === business),
        "An item business with allocated refunds cannot be removed.", 409);
  const oldAgency = shipment && await DeliveryAgency.findById(shipment.agencyId);
  const agencyChanged = Boolean(shipment && String(shipment.agencyId) !== String(preview.delivery.agencyId));
  const parcelChanged = Boolean(shipment && !sameParcel(order, { ...order.toObject(), ...preview }));
  const remote = Boolean(shipment && oldAgency?.integrationType === "API" && (shipment.creationAttemptedAt || shipment.tracking || shipment.providerAccepted));
  let providerAction = "LOCAL";
  if (agencyChanged) {
    if (remote && oldAgency?.capabilities?.deleteShipment) providerAction = "DELETE";
    else {
      assert(input.providerDeletionConfirmed === true,
        "Delete or cancel the old courier parcel first, then confirm provider deletion.", 409);
      providerAction = "MANUAL_DELETE_CONFIRMED";
    }
    const newAgency = await DeliveryAgency.findById(preview.delivery.agencyId);
    assert(newAgency?.integrationType === "MANUAL" || newAgency?.capabilities?.createShipment,
      "The new agency cannot create a shipment.", 409);
    if (newAgency?.integrationType === "API")
      assert(["NEW", "CONFIRMED", "PREPARING"].includes(order.status),
        "A new API shipment cannot be created in this delivery state.", 409);
  } else if (remote && parcelChanged) {
    if (oldAgency?.capabilities?.updateShipment) providerAction = "UPDATE";
    else {
      assert(input.providerUpdateConfirmed === true,
        "Update the courier parcel first, then confirm provider synchronization.", 409);
      providerAction = "MANUAL_UPDATE_CONFIRMED";
    }
  } else if (shipment && oldAgency?.integrationType === "MANUAL" && parcelChanged) {
    providerAction = "MANUAL_UPDATE";
  }
  if (providerAction === "UPDATE" || providerAction === "DELETE") {
    await reserveProviderAction(id, input.revision, shipment);
    try {
      const provider = await providerFor(oldAgency._id, providerAction === "UPDATE" ? "updateShipment" : "deleteShipment");
      const method = providerAction === "UPDATE" ? "updateShipment" : "deleteShipment";
      assert(typeof provider[method] === "function",
        `${oldAgency.name} has no documented ${method} integration. Confirm the change manually.`, 409);
      const result = await provider[method](shipment, providerAction === "UPDATE" ? mapOrderToPackage({ ...order.toObject(), ...preview }, parcelOptions(order)) : undefined);
      assert(result?.success === true, "Courier did not confirm parcel synchronization.", 502);
    } catch (error) {
      await syncFailure(id, shipment, actor, `SHIPMENT_${providerAction}_FAILED`, error);
      throw error;
    }
  }
  let saved;
  try {
    saved = await transaction(async (session) => {
      const current = await Order.findById(id).session(session);
      editable(current);
      assert(input.revision === current.revision, "This order changed. Reload before saving.", 409);
      const currentShipment = shipment && await Shipment.findById(shipment._id).session(session);
      assert(!shipment || currentShipment, "Shipment changed. Reload before saving.", 409);
      const data = await materialize(input, session, current);
      const collected = current.payment.amountCollected || 0;
      assert(moneyCents(collected) <= moneyCents(data.payment.amountToCollect), "Courier collection exceeds the edited balance.", 409);
      assert(moneyCents(current.refundedAmount) <= moneyCents(data.payment.amountPaidOnline) + moneyCents(collected),
        "Edited payments cannot be less than the amount already refunded.", 409);
      for (const refund of current.refunds || [])
        for (const business of ["LOGIX", "TAMQO"])
          assert(!refund.allocations?.[business] || data.items.some((item) => item.business === business),
            "An item business with allocated refunds cannot be removed.", 409);
      data.payment.amountCollected = collected;
      const before = current.toObject();
      Object.assign(current, data);
      current.lastUpdatedBy = typeof actor === "object" ? actor : current.lastUpdatedBy;
      current.revision++;
      await current.save({ session });
      if (currentShipment) {
        if (agencyChanged) {
          const nextAgency = await DeliveryAgency.findById(data.delivery.agencyId).session(session);
          currentShipment.agencyId = nextAgency._id;
          currentShipment.agencyName = nextAgency.name;
          currentShipment.provider = nextAgency.integrationType === "MANUAL" ? "MANUAL" : nextAgency.apiProvider;
          currentShipment.status = current.status;
          currentShipment.tracking = undefined;
          currentShipment.trackingKey = undefined;
          currentShipment.providerStatus = undefined;
          currentShipment.providerSituationId = undefined;
          currentShipment.messageRetour = undefined;
          currentShipment.providerCreatedAt = undefined;
          currentShipment.providerUpdatedAt = undefined;
          currentShipment.creationAttemptedAt = undefined;
          currentShipment.providerAccepted = false;
          currentShipment.uncertain = false;
          currentShipment.lockUntil = null;
          currentShipment.sanitizedProviderData = undefined;
          currentShipment.syncStatus = nextAgency.integrationType === "MANUAL" ? "SYNCED" : "PENDING";
          currentShipment.lastError = "";
          currentShipment.lastSyncedAt = nextAgency.integrationType === "MANUAL" ? new Date() : undefined;
        } else if (providerAction !== "LOCAL") {
          currentShipment.syncStatus = "SYNCED";
          currentShipment.lastError = "";
          currentShipment.lastSyncedAt = new Date();
          currentShipment.lockUntil = null;
        }
        await currentShipment.save({ session });
      }
      await OrderEvent.create([{ orderId: id, kind: "EDITED", type: "ORDER_UPDATED", actor,
        message: "Order details updated", data: { before, after: data, providerAction } }], { session });
      if (shipment && providerAction !== "LOCAL")
        await OrderEvent.create([{ orderId: id, kind: "SHIPMENT", type: `SHIPMENT_${providerAction}`, actor,
          message: `Courier parcel synchronization: ${providerAction}`, data: { oldAgencyId: String(shipment.agencyId), newAgencyId: String(data.delivery.agencyId) } }], { session });
      await audit(actor, "ORDER_UPDATED", "Order", id, current.businessType, { providerAction }, session);
      if (shipment && providerAction !== "LOCAL")
        await audit(actor, `SHIPMENT_${providerAction}`, "Order", id, current.businessType, {}, session);
      return current;
    });
  } catch (error) {
    if (providerAction === "UPDATE" || providerAction === "DELETE")
      await syncFailure(id, shipment, actor, "SHIPMENT_LOCAL_COMMIT_FAILED", error);
    throw error;
  }
  if (agencyChanged && (await DeliveryAgency.findById(saved.delivery.agencyId))?.integrationType === "API") {
    // Creation is a second provider operation after the old parcel was removed.
    const { deliveryService } = await import("./delivery/deliveryService.js");
    const result = await deliveryService.createAutomatically(saved, actor);
    saved = await Order.findById(id);
    return { ...saved.toObject(), shipmentSync: result.shipmentSync };
  }
  return saved;
}
export async function deleteOrder(id, input, actor = "admin") {
  const order = await Order.findById(id);
  assert(order, "Order not found", 404);
  assert(!order.deletedAt, "Order is already deleted.", 409);
  assert(input.revision === order.revision, "This order changed. Reload before deleting.", 409);
  const shipment = await Shipment.findOne({ orderId: id });
  let providerAction = "NONE";
  if (shipment) {
    assert(shipmentBusy(shipment), "A courier request is in progress. Reload later.", 409);
    const agency = await DeliveryAgency.findById(shipment.agencyId);
    if (agency?.integrationType === "API" && agency.capabilities?.deleteShipment) {
      providerAction = "DELETE";
      await reserveProviderAction(id, input.revision, shipment);
      try {
        const provider = await providerFor(agency._id, "deleteShipment");
        assert(typeof provider.deleteShipment === "function",
          `${agency.name} has no documented deleteShipment integration. Confirm deletion manually.`, 409);
        const result = await provider.deleteShipment(shipment);
        assert(result?.success === true, "Courier did not confirm parcel deletion.", 502);
      } catch (error) {
        await syncFailure(id, shipment, actor, "SHIPMENT_DELETE_FAILED", error);
        throw error;
      }
    } else {
      assert(input.providerDeletionConfirmed === true,
        "Mark the parcel Supprimée at the delivery agency, then confirm provider deletion.", 409);
      providerAction = "MANUAL_DELETE_CONFIRMED";
    }
  }
  try {
    return await transaction(async (session) => {
      const current = await Order.findById(id).session(session);
      assert(current && !current.deletedAt, "Order is already deleted.", 409);
      assert(input.revision === current.revision, "This order changed. Reload before deleting.", 409);
      current.deletedAt = new Date();
      current.deletedBy = typeof actor === "object" ? actor : undefined;
      current.deleteReason = input.reason || "";
      current.lastUpdatedBy = typeof actor === "object" ? actor : current.lastUpdatedBy;
      current.revision++;
      await current.save({ session });
      await Expense.updateMany({ sourceOrderId: id, systemGenerated: true },
        { $set: { sourceOrderDeletedAt: current.deletedAt } }, { session });
      if (shipment) {
        const s = await Shipment.findById(shipment._id).session(session);
        assert(s, "Shipment changed. Reload before deleting.", 409);
        if (providerAction === "DELETE") {
          s.lockUntil = null;
          s.syncStatus = "SYNCED";
          s.lastError = "";
          s.lastSyncedAt = new Date();
          await s.save({ session });
        }
      }
      await OrderEvent.create([{ orderId: id, kind: "DELETED", type: "ORDER_DELETED", actor,
        message: input.reason ? `Order deleted: ${input.reason}` : "Order deleted from CRM",
        data: { providerAction, reason: input.reason || "" } }], { session });
      await audit(actor, "ORDER_DELETED", "Order", id, current.businessType,
        { providerAction, reason: input.reason || "" }, session);
      return current;
    });
  } catch (error) {
    if (providerAction === "DELETE") await syncFailure(id, shipment, actor, "SHIPMENT_LOCAL_COMMIT_FAILED", error);
    throw error;
  }
}
export async function refundOrder(id, input, actor = "admin") {
  const cents = (n) => Math.round(n * 100);
  assert(Number.isFinite(input.amount) && input.amount > 0 &&
    Math.abs(input.amount * 100 - cents(input.amount)) < 0.0001,
    "Refund amount must be positive with at most two decimal places.");
  return transaction(async (session) => {
    const order = await Order.findById(id).session(session);
    assert(order, "Order not found", 404);
    assert(!order.deletedAt, "Deleted orders cannot be refunded.", 409);
    assert(input.revision === order.revision, "This order changed. Reload before refunding.", 409);
    const paid = cents(order.payment.amountPaidOnline || 0) + cents(order.payment.amountCollected || 0);
    const previous = cents(order.refundedAmount || 0);
    const amount = cents(input.amount);
    assert(amount <= paid - previous, "Refund cannot exceed received money after previous refunds.", 409);
    const allocation = input.allocation || (order.businessType === "PARTNERSHIP" ? null : order.businessType.replace("_ONLY", ""));
    assert(["LOGIX", "TAMQO", "WHOLE"].includes(allocation), "Choose a refund allocation.");
    assert(allocation === "WHOLE" || order.items.some((i) => i.business === allocation),
      "Refund allocation must belong to this order.");
    const logixShare = order.productRevenue > 0 ? order.logixRevenue / order.productRevenue :
      order.items.filter((i) => i.business === "LOGIX").length / order.items.length;
    const logixCents = allocation === "LOGIX" ? amount : allocation === "TAMQO" ? 0 :
      Math.round(amount * logixShare);
    const allocations = { LOGIX: (logixCents / 100), TAMQO: ((amount - logixCents) / 100) };
    order.refunds.push({ amount: amount / 100, allocations, note: input.note || "",
      createdAt: new Date(), createdBy: typeof actor === "object" ? actor : undefined });
    order.refundedAmount = (previous + amount) / 100;
    order.lastUpdatedBy = typeof actor === "object" ? actor : order.lastUpdatedBy;
    order.revision++;
    await order.save({ session });
    await OrderEvent.create([{ orderId: id, kind: "REFUND", type: "ORDER_REFUND", actor,
      message: `Refunded ${round(input.amount)} DA`,
      data: { amount: amount / 100, allocations, note: input.note || "" } }], { session });
    await audit(actor, "ORDER_REFUND", "Order", id, order.businessType,
      { amount: amount / 100, allocations, note: input.note || "" }, session);
    return order;
  });
}
export async function transition(id, to, actor = "admin", sessionOverride) {
  const run = async (session) => {
    const order = await Order.findById(id).session(session);
    assert(order, "Order not found", 404);
    assert(!order.deletedAt, "Deleted orders cannot change status.", 409);
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
    if (actor !== "courier") {
      if (["RETURNING", "RETURNED"].includes(to)) {
        const shipment = await Shipment.findOne({ orderId: id }).session(session);
        await ensureReturnExpense(order, { session, actor, tracking: shipment?.tracking, source: "INTERNAL" });
      } else if (to === "DELIVERED") {
        await reverseReturnExpense(order, { session, actor, source: "INTERNAL" });
      }
    }
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
