import { Order, Shipment, OrderEvent } from "../../models/index.js";
import { transaction, transition } from "../orderService.js";
import { canProviderTransition } from "../../domain/order.js";
import { assert, AppError } from "../../errors.js";
import { deliveryClient } from "./deliveryClient.js";
import {
  mapOrderToPackage,
  parsePackages,
  sanitizeProviderData,
} from "./deliveryMapper.js";
import { mapProviderStatus } from "./deliveryStatusMapper.js";
export class DeliverySyncService {
  constructor(client = deliveryClient) {
    this.client = client;
  }
  async create(orderId, options = {}) {
    const shipment = await transaction(async (session) => {
      const order = await Order.findById(orderId).session(session);
      assert(order, "Order not found", 404);
      assert(
        ["CONFIRMED", "PREPARING", "READY_TO_SHIP"].includes(order.status),
        "Confirm the order before creating a shipment.",
        409,
      );
      let s = await Shipment.findOne({ orderId }).session(session);
      if (s?.tracking) return s;
      assert(
        !s?.creationAttemptedAt,
        "A parcel creation was already attempted. Reconcile tracking before another attempt.",
        409,
        "RECONCILIATION_REQUIRED",
      );
      if (!s)
        [s] = await Shipment.create(
          [
            {
              orderId,
              externalId: order.orderNumber,
              agencyId: order.delivery.agencyId,
              agencyName: order.delivery.agencyName,
              provider: "PROCOLIS",
            },
          ],
          { session },
        );
      // A write to the same order serializes shipment creation against order edits/cancellation.
      order.revision++;
      await order.save({ session });
      return s;
    });
    if (shipment.tracking) return shipment;
    try {
      this.client.ensureConfigured();
    } catch (error) {
      await Shipment.updateOne(
        { _id: shipment._id },
        { $set: { syncStatus: "ERROR", lastError: error.message } },
      );
      throw error;
    }
    const locked = await Shipment.findOneAndUpdate(
      { _id: shipment._id, creationAttemptedAt: null },
      {
        $set: {
          creationAttemptedAt: new Date(),
          uncertain: true,
          syncStatus: "PENDING",
          lockUntil: new Date(Date.now() + 60000),
        },
      },
      { new: true },
    );
    assert(
      locked,
      "A shipment attempt is already in progress. Reconcile before retrying.",
      409,
    );
    try {
      const order = await Order.findById(orderId);
      assert(
        ["CONFIRMED", "PREPARING", "READY_TO_SHIP"].includes(order.status),
        "Order state changed; shipment needs reconciliation.",
        409,
      );
      const raw = await this.client.createPackages(
        mapOrderToPackage(order, { ...options, confirmed: false }),
      );
      const parcels = parsePackages(raw);
      await Shipment.updateOne(
        { _id: locked._id },
        { $set: { sanitizedProviderData: sanitizeProviderData(raw) } },
      );
      assert(
        parcels.length === 1,
        "Courier response could not be verified. Reconcile using the order number in the courier portal.",
        502,
        "RECONCILIATION_REQUIRED",
      );
      await Shipment.updateOne(
        { _id: locked._id },
        {
          $set: {
            tracking: parcels[0].tracking,
            uncertain: false,
            lockUntil: null,
          },
        },
      );
      await this.apply(orderId, parcels[0]);
      await OrderEvent.create({
        orderId,
        kind: "SHIPMENT",
        type: "SHIPMENT_CREATED",
        actor: options.actor || null,
        source: "INTERNAL",
        message: `Shipment linked: ${parcels[0].tracking}`,
      });
      return Shipment.findOne({ orderId });
    } catch (error) {
      await Shipment.updateOne(
        { _id: locked._id },
        {
          $set: {
            syncStatus: "ERROR",
            lastError:
              error instanceof AppError
                ? error.message
                : "Courier response could not be processed. Reconcile before retrying.",
            lockUntil: null,
          },
        },
      );
      throw error instanceof AppError
        ? error
        : new AppError(
            "Courier response could not be processed. Reconcile before retrying.",
            502,
          );
    }
  }
  async apply(orderId, parcel) {
    return transaction(async (session) => {
      const s = await Shipment.findOne({ orderId }).session(session),
        order = await Order.findById(orderId).session(session);
      assert(s && order, "Shipment not found", 404);
      const status = mapProviderStatus(parcel.providerStatus);
      s.providerStatus = parcel.providerStatus;
      s.sanitizedProviderData = parcel.raw;
      s.lastSyncedAt = new Date();
      s.lastError = "";
      s.syncStatus = "SYNCED";
      if (status && status !== order.status) {
        if (canProviderTransition(order.status, status))
          await transition(orderId, status, "courier", session);
        else {
          s.lastError = `Provider reports ${status}; internal state is ${order.status}. Review the skipped or conflicting transition.`;
          s.syncStatus = "ERROR";
        }
      }
      // Unknown provider values are retained without guessing a normalized order status.
      s.status = status || order.status;
      await s.save({ session });
      return s;
    });
  }
  async refresh(orderId) {
    const s = await Shipment.findOne({ orderId });
    assert(s?.tracking, "No tracking number is linked to this order.", 409);
    try {
      const raw = await this.client.readPackages([s.tracking]);
      const parcel = parsePackages(raw).find((p) => p.tracking === s.tracking);
      if (!parcel) {
        await Shipment.updateOne(
          { _id: s._id },
          { $set: { sanitizedProviderData: sanitizeProviderData(raw) } },
        );
        throw new AppError(
          "Tracking was not present in the configured response format.",
          502,
        );
      }
      return await this.apply(orderId, parcel);
    } catch (error) {
      await Shipment.updateOne(
        { _id: s._id },
        {
          $set: {
            syncStatus: "ERROR",
            lastError:
              error instanceof AppError
                ? error.message
                : "Tracking synchronization failed.",
          },
        },
      );
      throw error;
    }
  }
  async ready(orderId, actor) {
    const s = await Shipment.findOne({ orderId }),
      o = await Order.findById(orderId);
    assert(o, "Order not found", 404);
    assert(
      o.status === "PREPARING" || o.status === "READY_TO_SHIP",
      "Prepare this order first.",
      409,
    );
    if (!s?.tracking) return transition(orderId, "READY_TO_SHIP", actor);
    try {
      await this.client.readyPackages([s.tracking]);
      const updated = await this.refresh(orderId);
      assert(
        updated.status === "READY_TO_SHIP" && updated.syncStatus === "SYNCED",
        "Ready request sent, but provider readiness is unverified. Configure the verified status mapping and refresh.",
        502,
      );
      return updated;
    } catch (error) {
      await Shipment.updateOne(
        { _id: s._id },
        {
          $set: {
            syncStatus: "ERROR",
            lastError:
              error instanceof AppError
                ? error.message
                : "Ready request could not be verified.",
          },
        },
      );
      throw error;
    }
  }
  async reconcile(orderId, tracking, absentConfirmed = false, actor) {
    const s = await Shipment.findOne({ orderId });
    assert(s, "No shipment attempt to reconcile", 404);
    assert(
      !s.lockUntil || s.lockUntil < new Date(),
      "Shipment request is still in progress.",
      409,
    );
    if (absentConfirmed) {
      assert(!s.tracking, "A linked shipment cannot be retried.", 409);
      await Shipment.updateOne(
        { _id: s._id },
        {
          $unset: { creationAttemptedAt: 1 },
          $set: {
            uncertain: false,
            lastError: "Admin confirmed no parcel exists at provider.",
            syncStatus: "ERROR",
          },
        },
      );
      await OrderEvent.create({
        orderId,
        kind: "SHIPMENT",
        type: "SHIPMENT_RETRY_UNLOCKED",
        actor,
        message: "Admin verified parcel absence; creation retry unlocked.",
      });
      return Shipment.findById(s._id);
    }
    assert(
      typeof tracking === "string" &&
        tracking.trim().length > 0 &&
        tracking.length < 150,
      "Provide a tracking number.",
    );
    const raw = await this.client.readPackages([tracking.trim()]);
    const parcel = parsePackages(raw).find(
      (p) => p.tracking === tracking.trim(),
    );
    assert(parcel, "Tracking not found in the provider response.", 400);
    await Shipment.updateOne(
      { _id: s._id },
      { $set: { tracking: tracking.trim(), uncertain: false } },
    );
    await OrderEvent.create({
      orderId,
      kind: "SHIPMENT",
      type: "SHIPMENT_RECONCILED",
      actor,
      message: `Admin reconciled ${tracking.trim()} using external order number.`,
    });
    return this.apply(orderId, parcel);
  }
  async syncBatch(limit = 100) {
    const shipments = await Shipment.find({
      tracking: { $type: "string" },
      status: { $nin: ["DELIVERED", "RETURNED", "CANCELLED"] },
    })
      .sort({ lastSyncedAt: 1 })
      .limit(limit)
      .lean();
    if (!shipments.length) return { synced: 0, errors: 0 };
    let synced = 0,
      errors = 0;
    for (let i = 0; i < shipments.length; i += 20) {
      const batch = shipments.slice(i, i + 20);
      try {
        const parcels = parsePackages(
          await this.client.readPackages(batch.map((s) => s.tracking)),
        );
        for (const s of batch) {
          const p = parcels.find((p) => p.tracking === s.tracking);
          if (p) {
            await this.apply(s.orderId, p);
            synced++;
          } else {
            errors++;
            await Shipment.updateOne(
              { _id: s._id },
              {
                $set: {
                  syncStatus: "ERROR",
                  lastError: "Tracking absent from batch response.",
                },
              },
            );
          }
        }
      } catch {
        errors += batch.length;
        await Shipment.updateMany(
          { _id: { $in: batch.map((s) => s._id) } },
          {
            $set: {
              syncStatus: "ERROR",
              lastError: "Batch synchronization failed.",
            },
          },
        );
      }
    }
    return { synced, errors };
  }
}
export const deliverySyncService = new DeliverySyncService();
