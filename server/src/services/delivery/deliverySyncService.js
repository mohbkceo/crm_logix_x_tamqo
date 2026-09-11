import { Order, Shipment, OrderEvent } from "../../models/index.js";
import { transaction, transition } from "../orderService.js";
import { canProviderTransition } from "../../domain/order.js";
import { assert, AppError } from "../../errors.js";
import { deliveryClient } from "./deliveryClient.js";
import {
  mapOrderToPackage,
  parsePackages,
  parseCreationResult,
  sanitizeProviderData,
} from "./deliveryMapper.js";
import { mapProviderStatus } from "./deliveryStatusMapper.js";
export class DeliverySyncService {
  constructor(client = deliveryClient) {
    this.client = client;
  }
  sanitize(value) {
    return this.client.sanitize
      ? this.client.sanitize(value)
      : sanitizeProviderData(value);
  }
  async creationEvent(order, shipment, type, message, actor, extra = {}) {
    await OrderEvent.create({
      orderId: order._id,
      kind: "SHIPMENT",
      type,
      actor: actor || null,
      source: "INTERNAL",
      message,
      data: this.sanitize({
        orderNumber: order.orderNumber,
        agencyId: String(shipment.agencyId),
        agencyName: shipment.agencyName,
        provider: shipment.provider,
        endpoint: "/add_colis",
        shipmentId: String(shipment._id),
        tracking: shipment.tracking,
        syncStatus: shipment.syncStatus,
        uncertain: shipment.uncertain,
        httpStatus: this.client.lastResponseStatus,
        ...extra,
      }),
    });
  }
  async create(orderId, options = {}) {
    // Persist the reservation with the order write: concurrent edits/cancellation
    // conflict with this transaction. The HTTP request starts only after commit.
    let configurationError;
    try {
      this.client.ensureConfigured();
    } catch (error) {
      configurationError = error;
    }
    const { order, shipment, verifyOnly } = await transaction(
      async (session) => {
        const order = await Order.findById(orderId).session(session);
        assert(order, "Order not found", 404);
        let s = await Shipment.findOne({ orderId }).session(session);
        if (s?.tracking) return { order, shipment: s };
        assert(
          ["NEW", "CONFIRMED", "PREPARING", "READY_TO_SHIP"].includes(
            order.status,
          ),
          "This order cannot create a shipment.",
          409,
        );
        if (s?.creationAttemptedAt && s.uncertain) {
          assert(
            !s.lockUntil || s.lockUntil < new Date(),
            "Shipment request is still in progress.",
            409,
          );
          s.lockUntil = new Date(Date.now() + 60000);
          await s.save({ session });
          return { order, shipment: s, verifyOnly: true };
        }
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
                status: order.status,
              },
            ],
            { session },
          );
        if (configurationError) {
          s.syncStatus = "ERROR";
          s.lastError = this.sanitize(configurationError.message);
        } else {
          s.creationAttemptedAt = new Date();
          s.uncertain = true;
          s.providerAccepted = false;
          s.syncStatus = "PENDING";
          s.lastError = "";
          s.lockUntil = new Date(
            Date.now() +
              Math.max(
                60000,
                Number(this.client.http?.defaults.timeout || 0) + 30000,
              ),
          );
        }
        await s.save({ session });
        order.revision++;
        await order.save({ session });
        return { order, shipment: s };
      },
    );
    if (shipment.tracking) return shipment;
    if (verifyOnly) return this.verifyCreation(order, shipment, options.actor);
    if (configurationError) throw configurationError;
    let accepted = false;
    try {
      await this.creationEvent(
        order,
        shipment,
        "SHIPMENT_CREATION_STARTED",
        "Creating courier parcel without confirming readiness.",
        options.actor,
      );
      const raw = this.sanitize(
        await this.client.createPackages(
          mapOrderToPackage(order, { ...options, confirmed: false }),
        ),
      );
      const result = parseCreationResult(raw, order.orderNumber);
      accepted = result.providerAccepted;
      await Shipment.updateOne(
        { _id: shipment._id },
        {
          $set: {
            sanitizedProviderData: raw,
            providerAccepted: accepted,
            messageRetour: result.messageRetour,
          },
        },
      );
      if (result.duplicate) {
        await this.creationEvent(
          order,
          shipment,
          "SHIPMENT_DUPLICATE_TRACKING",
          "Duplicate tracking found — reconciling",
          options.actor,
        );
        return await this.verifyCreation(order, shipment, options.actor, raw);
      }
      if (result.messageRetour && !accepted) {
        const rejected = await Shipment.findByIdAndUpdate(
          shipment._id,
          {
            $set: {
              syncStatus: "ERROR",
              uncertain: false,
              lockUntil: null,
              lastError: result.messageRetour,
              sanitizedProviderData: this.client.lastResponse || raw,
            },
          },
          { new: true },
        );
        await this.creationEvent(
          order,
          rejected,
          "SHIPMENT_CREATION_FAILED",
          "Procolis rejected parcel: " + result.messageRetour,
          options.actor,
          { providerData: this.client.lastResponse },
        );
        return rejected;
      }
      if (!result.trackingFound) {
        const pending = await Shipment.findByIdAndUpdate(
          shipment._id,
          {
            $set: {
              uncertain: true,
              syncStatus: "PENDING",
              lockUntil: null,
              lastError:
                "Shipment awaiting verification. Read the order tracking before another creation attempt.",
            },
          },
          { new: true },
        );
        await this.creationEvent(
          order,
          pending,
          "SHIPMENT_TRACKING_UNVERIFIED",
          pending.lastError,
          options.actor,
        );
        return pending;
      }
      await Shipment.updateOne(
        { _id: shipment._id },
        {
          $set: {
            tracking: result.parcel.tracking,
            trackingKey: result.parcel.tracking.toUpperCase(),
            uncertain: false,
            lockUntil: null,
          },
        },
      );
      const linked = await this.apply(orderId, { ...result.parcel, raw });
      await this.creationEvent(
        order,
        linked,
        "SHIPMENT_CREATED",
        `Shipment linked: ${linked.tracking}`,
        options.actor,
      );
      return linked;
    } catch (error) {
      const lastError = accepted
        ? "Courier accepted the request, but local processing is incomplete. Reconcile before retrying."
        : this.sanitize(
            error instanceof AppError
              ? error.message
              : "Courier request failed. Reconcile before retrying.",
          );
      const failed = await Shipment.findByIdAndUpdate(
        shipment._id,
        {
          $set: {
            syncStatus: accepted ? "PENDING" : "ERROR",
            lastError,
            lockUntil: null,
            ...(error.providerData
              ? { sanitizedProviderData: this.sanitize(error.providerData) }
              : {}),
          },
        },
        { new: true },
      );
      await this.creationEvent(
        order,
        failed,
        accepted ? "SHIPMENT_TRACKING_UNVERIFIED" : "SHIPMENT_CREATION_FAILED",
        lastError,
        options.actor,
        { httpStatus: error.providerData?.status },
      );
      if (accepted) return failed;
      throw new AppError(lastError, 502, "DELIVERY_ERROR");
    }
  }
  async verifyCreation(order, shipment, actor, creationData) {
    const original =
      creationData ||
      (await Shipment.findById(shipment._id))?.sanitizedProviderData;
    let diagnostics;
    try {
      const raw = this.sanitize(
        await this.client.readPackages([order.orderNumber]),
      );
      diagnostics = { creation: original, reconciliation: raw };
      const parcel = parsePackages(raw).find(
        (p) =>
          p.tracking === order.orderNumber &&
          (!p.externalId || p.externalId === order.orderNumber),
      );
      if (parcel) {
        const linked = await this.apply(order._id, {
          ...parcel,
          raw: diagnostics,
        });
        await this.creationEvent(
          order,
          linked,
          "SHIPMENT_RECONCILED",
          "Existing Procolis parcel verified using order tracking.",
          actor,
        );
        return linked;
      }
    } catch (error) {
      diagnostics = {
        creation: original,
        reconciliation: this.sanitize(
          error.providerData || {
            message:
              error instanceof AppError
                ? error.message
                : "Tracking verification failed.",
          },
        ),
      };
    }
    return Shipment.findByIdAndUpdate(
      shipment._id,
      {
        $set: {
          syncStatus: "PENDING",
          uncertain: true,
          lockUntil: null,
          lastError:
            "Shipment awaiting verification. Procolis parcel existence could not be confirmed.",
          sanitizedProviderData: diagnostics,
        },
      },
      { new: true },
    );
  }
  async apply(orderId, parcel) {
    return (await this.applyWithResult(orderId, parcel)).shipment;
  }
  async applyWithResult(orderId, parcel, options = {}) {
    return transaction(async (session) => {
      const s = await Shipment.findOne({ orderId }).session(session),
        order = await Order.findById(orderId).session(session);
      assert(s && order, "Shipment not found", 404);
      const status = mapProviderStatus(parcel.providerStatus);
      const beforeProviderStatus = s.providerStatus || null,
        beforeOrderStatus = order.status;
      s.tracking = parcel.tracking;
      s.trackingKey = parcel.tracking.toUpperCase();
      s.uncertain = false;
      s.lockUntil = null;
      s.providerAccepted = true;
      if (parcel.messageRetour) s.messageRetour = parcel.messageRetour;
      s.providerStatus = parcel.providerStatus;
      s.providerSituationId = parcel.providerSituationId;
      s.providerUpdatedAt = parcel.providerUpdatedAt;
      s.sanitizedProviderData = parcel.raw;
      s.lastSyncedAt = new Date();
      s.lastError = "";
      s.syncStatus = "SYNCED";
      let afterOrderStatus = order.status,
        result;
      if (status && status !== order.status) {
        if (canProviderTransition(order.status, status)) {
          const changedOrder = await transition(
            orderId,
            status,
            "courier",
            session,
          );
          afterOrderStatus = changedOrder.status;
        } else {
          s.lastError = `Provider reports ${status}; internal state is ${order.status}. Review the skipped or conflicting transition.`;
          s.syncStatus = "ERROR";
          result = "ERROR";
        }
      } else if (!status && (options.requireStatus || parcel.providerStatus)) {
        result = "UNKNOWN_STATUS";
      }
      // Unknown provider values are retained without guessing a normalized order status.
      s.status = status || null;
      await s.save({ session });
      const changed =
          beforeProviderStatus !== (s.providerStatus || null) ||
          beforeOrderStatus !== afterOrderStatus,
        terminalReached =
          !["DELIVERED", "RETURNED", "CANCELLED"].includes(beforeOrderStatus) &&
          ["DELIVERED", "RETURNED", "CANCELLED"].includes(afterOrderStatus);
      return {
        shipment: s,
        outcome: {
          beforeProviderStatus,
          afterProviderStatus: s.providerStatus || null,
          beforeOrderStatus,
          afterOrderStatus,
          changed,
          terminalReached,
          result: result || (changed ? "SUCCESS" : "UNCHANGED"),
          error: s.lastError || null,
        },
      };
    });
  }
  async refresh(orderId) {
    const s = await Shipment.findOne({ orderId });
    assert(
      s?.origin !== "EXCEL_IMPORT",
      "Excel-imported shipments cannot call a delivery provider.",
      409,
    );
    if (s?.creationAttemptedAt && s.uncertain && !s.tracking)
      return this.create(orderId);
    assert(s?.tracking, "No tracking number is linked to this order.", 409);
    try {
      const raw = this.sanitize(await this.client.readPackages([s.tracking]));
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
            ...(error.providerData
              ? { sanitizedProviderData: this.sanitize(error.providerData) }
              : {}),
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
      s?.origin !== "EXCEL_IMPORT",
      "Excel-imported shipments cannot call a delivery provider.",
      409,
    );
    assert(
      o.status === "PREPARING" || o.status === "READY_TO_SHIP",
      "Prepare this order first.",
      409,
    );
    assert(
      !s?.creationAttemptedAt || s.tracking,
      "Reconcile the courier parcel before marking ready.",
      409,
    );
    if (!s?.tracking) return transition(orderId, "READY_TO_SHIP", actor);
    try {
      const raw = this.sanitize(await this.client.readyPackages([s.tracking]));
      const messageRetour = Array.isArray(raw?.Colis)
        ? raw.Colis[0]?.MessageRetour
        : null;
      if (messageRetour && messageRetour !== "Good") {
        const error = new AppError(
          `Procolis rejected ready request: ${messageRetour}`,
          502,
          "DELIVERY_ERROR",
        );
        error.providerData = this.client.lastResponse || { body: raw };
        throw error;
      }
      return transaction(async (session) => {
        await transition(orderId, "READY_TO_SHIP", actor, session);
        const shipment = await Shipment.findOne({ orderId }).session(session);
        shipment.status = "READY_TO_SHIP";
        shipment.syncStatus = "SYNCED";
        shipment.lastError = "";
        shipment.lastSyncedAt = new Date();
        shipment.sanitizedProviderData = raw;
        if (messageRetour) shipment.messageRetour = messageRetour;
        await shipment.save({ session });
        return shipment;
      });
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
            ...(error.providerData
              ? { sanitizedProviderData: this.sanitize(error.providerData) }
              : {}),
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
      s.origin !== "EXCEL_IMPORT",
      "Excel-imported shipments cannot call a delivery provider.",
      409,
    );
    assert(
      !s.lockUntil || s.lockUntil < new Date(),
      "Shipment request is still in progress.",
      409,
    );
    // Compare the observed reservation as well as the version: a stale portal
    // confirmation must not unlock a newer create attempt or replace its tracking.
    const reservation = {
      _id: s._id,
      __v: s.__v,
      creationAttemptedAt: s.creationAttemptedAt || null,
      lockUntil: s.lockUntil || null,
      tracking: s.tracking || null,
    };
    if (absentConfirmed) {
      assert(!s.tracking, "A linked shipment cannot be retried.", 409);
      const result = await Shipment.updateOne(reservation, {
        $inc: { __v: 1 },
        $unset: { creationAttemptedAt: 1 },
        $set: {
          uncertain: false,
          providerAccepted: false,
          lockUntil: null,
          lastError: "Admin confirmed no parcel exists at provider.",
          syncStatus: "ERROR",
        },
      });
      assert(
        result.modifiedCount === 1,
        "Shipment changed. Reload before reconciling.",
        409,
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
    const raw = this.sanitize(
      await this.client.readPackages([tracking.trim()]),
    );
    const parcel = parsePackages(raw).find(
      (p) => p.tracking === tracking.trim(),
    );
    assert(parcel, "Tracking not found in the provider response.", 400);
    assert(
      !parcel.externalId || parcel.externalId === s.externalId,
      "Tracking belongs to a different external order reference.",
      409,
    );
    const result = await Shipment.updateOne(reservation, {
      $inc: { __v: 1 },
      $set: {
        tracking: tracking.trim(),
        trackingKey: tracking.trim().toUpperCase(),
        uncertain: false,
        providerAccepted: true,
      },
    });
    assert(
      result.modifiedCount === 1,
      "Shipment changed. Reload before reconciling.",
      409,
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
}
export const deliverySyncService = new DeliverySyncService();
