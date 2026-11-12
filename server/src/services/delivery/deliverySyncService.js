import { randomUUID } from "node:crypto";
import { Order, Shipment, OrderEvent, Expense } from "../../models/index.js";
import { TrackingEvent } from "../../models/tracking.js";
import { audit } from "../../models/security.js";
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
import {
  mapProviderStatus,
  normalizeProviderStatus,
} from "./deliveryStatusMapper.js";
import {
  ensureReturnExpense,
  reverseReturnExpense,
} from "./deliveryFinancialService.js";
import { COURIER_STAGES } from "../../../../shared/tracking.js";
import { requireAbexIdentity } from "./abexMapper.js";
const creationStatuses = ["NEW", "CONFIRMED", "PREPARING", "READY_TO_SHIP"];
export class DeliverySyncService {
  constructor(client = deliveryClient, agencyId) {
    this.client = client;
    this.agencyId = agencyId;
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
        endpoint: this.client.creationEndpoint || "/add_colis",
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
    const provider = this.client.provider || "PROCOLIS";
    const abex = provider === "ABEX";
    let preparedOrder, payload, preflightError;
    if (abex && !configurationError) {
      const prior =
        options.shipmentSnapshot === undefined
          ? await Shipment.findOne({ orderId })
          : options.shipmentSnapshot;
      if (
        !prior?.tracking &&
        !prior?.creationAttemptedAt &&
        !prior?.providerParcelId &&
        !prior?.providerAccepted
      ) {
        preparedOrder =
          options.orderSnapshot || (await Order.findById(orderId));
        if (
          preparedOrder &&
          !preparedOrder.deletedAt &&
          creationStatuses.includes(preparedOrder.status) &&
          (!this.agencyId ||
            String(preparedOrder.delivery.agencyId) === String(this.agencyId))
        ) {
          try {
            payload = await this.client.prepareShipment(preparedOrder);
          } catch (error) {
            preflightError = error;
          }
        }
      }
    }
    const attemptError = configurationError || preflightError;
    const { order, shipment, verifyOnly } = await transaction(
      async (session) => {
        const order = await Order.findById(orderId).session(session);
        assert(order, "Order not found", 404);
        assert(
          !this.agencyId ||
            String(order.delivery.agencyId) === String(this.agencyId),
          "The order delivery agency changed. Reload before creating a shipment.",
          409,
        );
        assert(
          !order.deletedAt,
          "Deleted orders cannot create shipments.",
          409,
        );
        let s = await Shipment.findOne({ orderId }).session(session);
        if (s?.tracking) return { order, shipment: s };
        assert(
          creationStatuses.includes(order.status),
          "This order cannot create a shipment.",
          409,
        );
        if (s?.creationAttemptedAt && s.uncertain) {
          assert(
            s.provider === provider,
            "Reconcile this parcel through its original courier contract.",
            409,
          );
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
        assert(
          !abex || (!s?.providerParcelId && !s?.providerAccepted),
          "ABEX already acknowledged a parcel. Reconcile it before creating another.",
          409,
          "RECONCILIATION_REQUIRED",
        );
        assert(
          !this.client.readOnly,
          "Historical Procolis parcels support tracking only.",
          409,
          "LEGACY_SHIPMENT",
        );
        // Catalog requests run before the transaction. Recheck the snapshot
        // before reserving a write so an address edit cannot race the lookup.
        if (abex && !configurationError)
          assert(
            preparedOrder?.revision === order.revision &&
              (payload || preflightError),
            "The order changed during ABEX address validation. Reload before retrying.",
            409,
            "CONFLICT",
          );
        if (!s)
          [s] = await Shipment.create(
            [
              {
                orderId,
                externalId: order.orderNumber,
                agencyId: order.delivery.agencyId,
                agencyName: order.delivery.agencyName,
                provider,
                status: order.status,
              },
            ],
            { session },
          );
        assert(
          !s.providerAccepted || s.provider === provider,
          "This shipment belongs to a different courier contract.",
          409,
        );
        s.provider = provider;
        if (attemptError) {
          s.syncStatus = "ERROR";
          s.lastError = this.sanitize(attemptError.message);
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
    if (attemptError) throw attemptError;
    const reservation = this.creationReservation(shipment);
    let accepted = false;
    try {
      await this.creationEvent(
        order,
        shipment,
        "SHIPMENT_CREATION_STARTED",
        "Creating courier parcel without confirming readiness.",
        options.actor,
      );
      const abexParcel = abex
        ? await this.client.createShipment(payload)
        : null;
      const raw =
        abexParcel?.raw ||
        this.sanitize(
          await this.client.createPackages(
            mapOrderToPackage(order, { ...options, confirmed: false }),
          ),
        );
      const result = abexParcel
        ? {
            providerAccepted: true,
            trackingFound: Boolean(abexParcel.tracking),
            parcel: abexParcel,
          }
        : parseCreationResult(raw, order.orderNumber);
      accepted = result.providerAccepted;
      const acknowledged = await Shipment.updateOne(reservation, {
        $set: {
          sanitizedProviderData: raw,
          providerAccepted: accepted,
          messageRetour: result.messageRetour,
          ...(abexParcel ? { providerParcelId: abexParcel.parcelId } : {}),
        },
      });
      assert(
        acknowledged.matchedCount === 1,
        "Shipment changed while the provider was processing the request.",
        409,
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
        const pending = await Shipment.findOneAndUpdate(
          reservation,
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
      if (!abex)
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
      const linked = await this.apply(
        orderId,
        { ...result.parcel, raw },
        {
          allowLink: true,
          ...(abex ? { reservation } : {}),
        },
      );
      await this.creationEvent(
        order,
        linked,
        "SHIPMENT_CREATED",
        `Shipment linked: ${linked.tracking}`,
        options.actor,
      );
      return linked;
    } catch (error) {
      const invalidResponse = error.code === "ABEX_INVALID_RESPONSE";
      if (abex && (invalidResponse || error.code === "ABEX_CONFLICT")) {
        const creationData = invalidResponse
          ? error.providerData || { code: error.code }
          : undefined;
        await this.creationEvent(
          order,
          shipment,
          invalidResponse
            ? "SHIPMENT_TRACKING_UNVERIFIED"
            : "SHIPMENT_DUPLICATE_TRACKING",
          invalidResponse
            ? "ABEX returned an incomplete creation response. Checking for an existing parcel."
            : "ABEX reported a conflict. Checking for an existing parcel.",
          options.actor,
          invalidResponse ? { httpStatus: creationData.status } : undefined,
        );
        return this.verifyCreation(
          order,
          shipment,
          options.actor,
          creationData,
        );
      }
      const lastError = accepted
        ? "Courier accepted the request, but local processing is incomplete. Reconcile before retrying."
        : this.sanitize(
            error instanceof AppError
              ? error.message
              : "Courier request failed. Reconcile before retrying.",
          );
      const failed = await Shipment.findOneAndUpdate(
        reservation,
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
      if (!failed) {
        if (abex && accepted) return Shipment.findById(shipment._id);
        throw error;
      }
      await this.creationEvent(
        order,
        failed,
        accepted ? "SHIPMENT_TRACKING_UNVERIFIED" : "SHIPMENT_CREATION_FAILED",
        lastError,
        options.actor,
        { httpStatus: error.providerData?.status },
      );
      if (accepted) return failed;
      if (abex && error instanceof AppError) throw error;
      throw new AppError(lastError, 502, "DELIVERY_ERROR");
    }
  }
  creationReservation(shipment) {
    return {
      _id: shipment._id,
      ...(this.client.provider === "ABEX"
        ? {
            provider: "ABEX",
            lockUntil: shipment.lockUntil,
            creationAttemptedAt: shipment.creationAttemptedAt,
            tracking: null,
          }
        : {}),
    };
  }
  async verifyCreation(order, shipment, actor, creationData) {
    const reservation = this.creationReservation(shipment);
    const abex = this.client.provider === "ABEX";
    const saved =
      creationData ||
      (await Shipment.findById(shipment._id))?.sanitizedProviderData;
    const original = abex && saved?.reconciliation ? saved.creation : saved;
    let lastError =
      abex && original?.code === "ABEX_VALIDATION" && shipment.lastError
        ? shipment.lastError
        : "Shipment awaiting verification. Parcel existence could not be confirmed.";
    let diagnostics;
    try {
      if (abex) {
        const parcel = await this.client.findShipment(
          order.orderNumber,
          shipment.providerParcelId,
          original?.code === "ABEX_INVALID_RESPONSE"
            ? order.payment.amountToCollect
            : undefined,
        );
        if (parcel) {
          const linked = await this.apply(order._id, parcel, {
            allowLink: true,
            reservation,
          });
          await this.creationEvent(
            order,
            linked,
            "SHIPMENT_RECONCILED",
            "Existing ABEX parcel verified using the CRM order reference.",
            actor,
          );
          return linked;
        }
        diagnostics = {
          creation: original,
          reconciliation: { result: "NOT_FOUND" },
        };
      } else {
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
      }
    } catch (error) {
      if (abex && error.code === "ABEX_AMOUNT_MISMATCH")
        lastError = error.message;
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
    const pending = await Shipment.findOneAndUpdate(
      reservation,
      {
        $set: {
          syncStatus: "PENDING",
          uncertain: true,
          lockUntil: null,
          lastError,
          sanitizedProviderData: diagnostics,
        },
      },
      { new: true },
    );
    return pending || Shipment.findById(shipment._id);
  }
  async apply(orderId, parcel, options) {
    return (await this.applyWithResult(orderId, parcel, options)).shipment;
  }
  async applyWithResult(orderId, parcel, options = {}) {
    return transaction(async (session) => {
      const s = await Shipment.findOne({
          orderId,
          ...options.reservation,
        }).session(session),
        order = await Order.findById(orderId).session(session);
      assert(s && order, "Shipment not found", 404);
      const abex = s.provider === "ABEX";
      assert(
        abex === (this.client.provider === "ABEX"),
        "The shipment provider changed. Refresh tracking.",
        409,
      );
      if (abex) {
        assert(
          !this.agencyId ||
            (String(s.agencyId) === String(this.agencyId) &&
              String(order.delivery.agencyId) === String(this.agencyId)),
          "The shipment agency changed. Refresh tracking.",
          409,
        );
        requireAbexIdentity(parcel, {
          tracking: s.tracking,
          externalId: order.orderNumber,
          providerParcelId: s.providerParcelId,
        });
      }
      const deleted =
        !abex && normalizeProviderStatus(parcel.providerStatus) === "supprimee";
      const wasDeleted = Boolean(order.deletedAt);
      assert(
        !order.deletedAt ||
          (deleted &&
            s.status === "DELETED" &&
            normalizeProviderStatus(s.providerStatus) === "supprimee"),
        "Deleted orders cannot synchronize shipments.",
        409,
      );
      let status = abex
        ? parcel.normalizedStatus
        : deleted
          ? null
          : mapProviderStatus(parcel.providerStatus);
      const beforeProviderStatus = s.providerStatus || null,
        beforeOrderStatus = order.status;
      if (abex && !options.allowLink && s.lockUntil > new Date()) {
        return {
          shipment: s,
          outcome: {
            beforeProviderStatus,
            afterProviderStatus: beforeProviderStatus,
            beforeOrderStatus,
            afterOrderStatus: beforeOrderStatus,
            result: "SKIPPED",
            changed: false,
            terminalReached: false,
            error: "A courier operation is in progress.",
          },
        };
      }
      if (abex && options.allowLink) status = undefined;
      const pendingReady = abex && s.pendingReadinessStateId;
      if (
        pendingReady &&
        parcel.stateId === pendingReady &&
        status === "READY_TO_SHIP" &&
        +parcel.providerUpdatedAt > +s.pendingReadinessAt
      )
        status = undefined;
      const waitingForReadiness =
        pendingReady &&
        (parcel.stateId !== pendingReady ||
          parcel.normalizedStatus !== "READY_TO_SHIP" ||
          !(+parcel.providerUpdatedAt > +s.pendingReadinessAt));
      const productionBlocked =
        abex &&
        status &&
        COURIER_STAGES.includes(status) &&
        status !== order.status &&
        order.items.some(
          (item) => item.business === "LOGIX" && item.type === "PRODUCT",
        ) &&
        order.tracking?.stage !== "READY_TO_SHIP" &&
        !order.tracking?.courierOwned;
      s.lastObservation = {
        providerStatus: parcel.providerStatus,
        providerUpdatedAt: parcel.providerUpdatedAt,
        receivedAt: new Date(),
        raw: this.sanitize(parcel.raw),
      };
      const incomingDate = parcel.providerUpdatedAt
        ? new Date(parcel.providerUpdatedAt)
        : null;
      const stale =
        (abex && status && !incomingDate) ||
        (abex && s.providerUpdatedAt && !incomingDate) ||
        (incomingDate &&
          (!Number.isFinite(+incomingDate) ||
            (s.providerUpdatedAt &&
              (+incomingDate < +s.providerUpdatedAt ||
                (+incomingDate === +s.providerUpdatedAt &&
                  (abex
                    ? parcel.stateId !== s.providerStateId ||
                      parcel.providerSituationId !== s.providerSituationId
                    : status && status !== order.status)))) ||
            (+incomingDate === +s.providerUpdatedAt &&
              deleted &&
              !order.deletedAt)));
      const conflicting =
        (deleted &&
          ["DELIVERED", "RETURNED", "CANCELLED"].includes(order.status)) ||
        (status &&
          status !== order.status &&
          !canProviderTransition(order.status, status));
      const wrongTracking =
        s.tracking &&
        String(s.tracking).toUpperCase() !==
          String(parcel.tracking).toUpperCase();
      const wrongReference =
        parcel.externalId &&
        ![order.orderNumber, s.externalId].includes(parcel.externalId);
      if (
        stale ||
        conflicting ||
        productionBlocked ||
        waitingForReadiness ||
        wrongTracking ||
        wrongReference ||
        (deleted && !s.tracking)
      ) {
        s.lastSyncedAt = new Date();
        s.lastError = waitingForReadiness
          ? "ABEX readiness is still unverified. Review the courier parcel and refresh tracking."
          : productionBlocked
            ? "ABEX reported a courier stage before CRM production readiness was confirmed."
            : stale
              ? "Stale or invalid provider timestamp; last accepted state preserved."
              : wrongTracking || wrongReference || !s.tracking
                ? "Provider tracking mismatch; linked parcel preserved."
                : `Provider reports ${status}; internal state is ${order.status}. Review the conflicting transition.`;
        s.syncStatus = "ERROR";
        await s.save({ session });
        return {
          shipment: s,
          outcome: {
            beforeProviderStatus,
            afterProviderStatus: s.providerStatus || null,
            beforeOrderStatus,
            afterOrderStatus: order.status,
            changed: false,
            terminalReached: false,
            result: "ERROR",
            error: s.lastError,
          },
        };
      }
      s.tracking = parcel.tracking;
      s.trackingKey = parcel.tracking.toUpperCase();
      if (abex) {
        s.providerParcelId = parcel.parcelId;
        s.providerWorkflowId = parcel.workflowId;
        s.providerStateId = parcel.stateId;
        s.providerStatusMapped = Boolean(parcel.normalizedStatus);
        if (parcel.providerCreatedAt)
          s.providerCreatedAt = parcel.providerCreatedAt;
      }
      s.uncertain = false;
      // A benign preparation poll must not cancel an in-flight Ready command.
      // Real courier ownership/deletion still invalidates its reservation.
      if (!s.readinessLockToken || deleted || COURIER_STAGES.includes(status)) {
        s.lockUntil = null;
        s.readinessLockToken = undefined;
      }
      s.providerAccepted = true;
      if (parcel.messageRetour) s.messageRetour = parcel.messageRetour;
      s.providerStatus = parcel.providerStatus;
      s.providerSituationId = parcel.providerSituationId;
      if (incomingDate && (abex || status || deleted))
        s.providerUpdatedAt = incomingDate;
      s.sanitizedProviderData = parcel.raw;
      s.lastSyncedAt = new Date();
      s.lastError = "";
      s.syncStatus = "SYNCED";
      let afterOrderStatus = order.status,
        result;
      if (deleted) {
        if (!order.deletedAt) {
          order.deletedAt = new Date();
          order.deletedBy = { name: "Delivery agency" };
          order.deleteReason = "Delivery agency explicitly reported Supprimée";
          if (order.tracking) order.tracking.readinessDeleted = true;
          order.revision++;
          await order.save({ session });
          await Expense.updateMany(
            { sourceOrderId: order._id, systemGenerated: true },
            { $set: { sourceOrderDeletedAt: order.deletedAt } },
            { session },
          );
          await OrderEvent.create(
            [
              {
                orderId: order._id,
                kind: "DELETED",
                type: "ORDER_PROVIDER_DELETED",
                actor: { name: "Delivery agency" },
                source: "DELIVERY_PROVIDER",
                message:
                  "Order soft-deleted after the agency reported Supprimée",
                data: {
                  tracking: s.tracking,
                  providerStatus: parcel.providerStatus,
                },
              },
            ],
            { session },
          );
          if (order.tracking)
            await TrackingEvent.create(
              [
                {
                  orderId: order._id,
                  kind: "TRACKING_PROVIDER_DELETED",
                  previousStage: order.tracking.stage,
                  newStage: order.tracking.stage,
                  actor: { name: "Delivery agency" },
                  source: "DELIVERY_PROVIDER",
                  revision: order.revision,
                  data: {
                    tracking: s.tracking,
                    providerStatus: parcel.providerStatus,
                  },
                },
              ],
              { session },
            );
          await audit(
            { name: "Delivery agency" },
            "ORDER_PROVIDER_DELETED",
            "Order",
            order._id,
            order.businessType,
            { tracking: s.tracking },
            session,
          );
        }
      } else if (status && status !== order.status) {
        if (canProviderTransition(order.status, status)) {
          const changedOrder = await transition(
            orderId,
            status,
            "courier",
            session,
          );
          afterOrderStatus = changedOrder.status;
          if (["RETURNING", "RETURNED"].includes(afterOrderStatus)) {
            await ensureReturnExpense(changedOrder, {
              session,
              actor: "courier",
              tracking: s.tracking,
            });
          } else if (afterOrderStatus === "DELIVERED") {
            await reverseReturnExpense(changedOrder, {
              session,
              actor: "courier",
            });
          }
        } else {
          s.lastError = `Provider reports ${status}; internal state is ${order.status}. Review the skipped or conflicting transition.`;
          s.syncStatus = "ERROR";
          result = "ERROR";
        }
      } else if (
        !status &&
        !pendingReady &&
        (options.requireStatus || parcel.providerStatus)
      ) {
        result = "UNKNOWN_STATUS";
      }
      if (
        status === order.status &&
        COURIER_STAGES.includes(status) &&
        order.tracking &&
        !order.tracking.courierOwned
      ) {
        order.tracking.courierOwned = true;
        order.revision++;
        await order.save({ session });
      }
      // Unknown provider values are retained without guessing a normalized order status.
      if (!pendingReady && (!abex || status))
        s.status = deleted ? "DELETED" : status || null;
      await s.save({ session });
      const changed =
          beforeProviderStatus !== (s.providerStatus || null) ||
          beforeOrderStatus !== afterOrderStatus ||
          (deleted && !wasDeleted),
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
    if (s?.creationAttemptedAt && s.uncertain && !s.tracking)
      return this.create(orderId);
    assert(s?.tracking, "No tracking number is linked to this order.", 409);
    try {
      if (this.client.provider === "ABEX")
        return await this.apply(orderId, await this.client.getShipment(s));
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
  async confirmLegacyReadiness(
    s,
    o,
    productionOrder,
    readinessToken,
    expectedRevision,
    markSent,
  ) {
    const orderId = o._id;
    if (productionOrder) {
      const beforeRaw = this.sanitize(
        await this.client.readPackages([s.tracking]),
      );
      const before = parsePackages(beforeRaw).find(
        (p) =>
          p.tracking.toUpperCase() === s.tracking.toUpperCase() &&
          (!p.externalId || p.externalId === o.orderNumber),
      );
      assert(
        before &&
          normalizeProviderStatus(before.providerStatus) === "en preparation" &&
          (!before.providerUpdatedAt ||
            (Number.isFinite(+before.providerUpdatedAt) &&
              (!s.providerUpdatedAt ||
                +before.providerUpdatedAt >= +s.providerUpdatedAt))),
        "Ready to Ship requires the delivery agency status En préparation. Refresh tracking.",
        409,
      );
      const [liveOrder, reservedShipment] = await Promise.all([
        Order.findById(orderId),
        Shipment.findOne({
          _id: s._id,
          readinessLockToken: readinessToken,
          lockUntil: { $gt: new Date() },
        }),
      ]);
      assert(
        reservedShipment &&
          liveOrder &&
          !liveOrder.deletedAt &&
          liveOrder.revision === expectedRevision &&
          liveOrder.tracking?.stage === "AT_PRODUCTION" &&
          !liveOrder.tracking.courierOwned &&
          !liveOrder.tracking.blockingIssues,
        "Order changed during agency verification. Refresh tracking.",
        409,
      );
    }
    let raw;
    try {
      markSent();
      raw = this.sanitize(await this.client.readyPackages([s.tracking]));
    } catch (error) {
      if (error.code === "DELIVERY_NOT_CONFIGURED") throw error;
      raw = {
        readinessRequestError: this.sanitize(
          error.providerData || error.message,
        ),
      };
    }
    const rows = Array.isArray(raw?.Colis) ? raw.Colis : [];
    let confirmed = rows.find(
      (p) =>
        String(p?.Tracking || "")
          .trim()
          .toUpperCase() === s.tracking.trim().toUpperCase() &&
        p?.MessageRetour === "Good",
    );
    const matchesTracking = (p) =>
      p.tracking.toUpperCase() === s.tracking.toUpperCase();
    const verifiesReady = (p) =>
      matchesTracking(p) &&
      (!p.externalId || p.externalId === o.orderNumber) &&
      mapProviderStatus(p.providerStatus) === "READY_TO_SHIP" &&
      (!p.providerUpdatedAt ||
        (Number.isFinite(+p.providerUpdatedAt) &&
          (!s.providerUpdatedAt ||
            +p.providerUpdatedAt >= +s.providerUpdatedAt)));
    const responseParcel = parsePackages(raw).find(matchesTracking);
    let observed =
      responseParcel && verifiesReady(responseParcel)
        ? responseParcel
        : undefined;
    // An acknowledgement cannot override a contradictory situation supplied
    // alongside it. Verify the current parcel instead of assuming Ready.
    if (responseParcel?.providerStatus && !observed) confirmed = undefined;
    if (!confirmed) {
      // Some /pret responses omit Tracking/MessageRetour even though the
      // transition succeeded. /lire verifies the same persisted parcel; never
      // resend /pret or create a replacement parcel to resolve ambiguity.
      let readback;
      try {
        readback = this.sanitize(await this.client.readPackages([s.tracking]));
      } catch (error) {
        const failure = new AppError(
          "Courier readiness could not be verified. Refresh tracking before retrying.",
          502,
          "DELIVERY_ERROR",
        );
        failure.providerData = {
          readiness: raw,
          verificationError: this.sanitize(error.providerData || error.message),
        };
        throw failure;
      }
      observed = parsePackages(readback).find(verifiesReady);
      raw = { readiness: raw, verification: readback };
      if (observed)
        confirmed = { MessageRetour: observed.messageRetour || "Good" };
    }
    if (!confirmed) {
      const failure = new AppError(
        "Courier readiness was not confirmed for this tracking number. Refresh tracking before retrying.",
        502,
        "DELIVERY_ERROR",
      );
      failure.providerData = this.client.lastResponse || { body: raw };
      throw failure;
    }
    return { raw, confirmed, observed };
  }
  async ready(orderId, actor, options = {}) {
    const s = await Shipment.findOne({ orderId }),
      o = await Order.findById(orderId);
    assert(o, "Order not found", 404);
    assert(!o.deletedAt, "Deleted orders cannot synchronize shipments.", 409);
    const abex = this.client.provider === "ABEX";
    const expectedRevision = options.expectedRevision ?? o.revision;
    if (abex)
      assert(
        s?.tracking &&
          s.providerParcelId &&
          s.provider === "ABEX" &&
          String(s.agencyId) === String(o.delivery.agencyId),
        "Link a verified ABEX parcel before marking this order ready.",
        409,
      );
    const productionOrder = o.items.some(
      (i) => i.business === "LOGIX" && i.type === "PRODUCT",
    );
    if (productionOrder)
      assert(
        o.tracking?.stage === "AT_PRODUCTION" &&
          !o.tracking.blockingIssues &&
          !o.tracking.courierOwned &&
          !COURIER_STAGES.includes(o.status),
        "Ready to Ship requires In Production and is irreversible.",
        409,
      );
    if (productionOrder)
      assert(
        s?.tracking && String(s.agencyId) === String(o.delivery.agencyId),
        "A linked shipment from the order delivery agency is required.",
        409,
      );
    assert(
      (options.onConfirmed
        ? ["NEW", "CONFIRMED", "PREPARING", "READY_TO_SHIP"]
        : ["PREPARING", "READY_TO_SHIP"]
      ).includes(o.status),
      "Prepare this order first.",
      409,
    );
    if (options.expectedRevision !== undefined)
      assert(
        o.revision === options.expectedRevision,
        "This order changed. Refresh and try again.",
        409,
        "CONFLICT",
      );
    assert(
      !s?.creationAttemptedAt || s.tracking,
      "Reconcile the courier parcel before marking ready.",
      409,
    );
    if (options.onConfirmed)
      assert(
        s?.tracking && !s.uncertain,
        "A verified tracking number is required to confirm courier readiness.",
        409,
      );
    if (!s?.tracking) {
      assert(
        !productionOrder,
        "A verified agency tracking number is required.",
        409,
      );
      return transition(orderId, "READY_TO_SHIP", actor);
    }
    if (o.status === "READY_TO_SHIP" && s.status === "READY_TO_SHIP") return s;

    const readinessToken = randomUUID();
    await transaction(async (session) => {
      const current = await Order.findById(orderId).session(session);
      assert(
        current &&
          !current.deletedAt &&
          (options.onConfirmed
            ? ["NEW", "CONFIRMED", "PREPARING", "READY_TO_SHIP"]
            : ["PREPARING", "READY_TO_SHIP"]
          ).includes(current.status),
        "Order changed before courier readiness.",
        409,
      );
      if (options.expectedRevision !== undefined)
        assert(
          current.revision === options.expectedRevision,
          "This order changed. Refresh and try again.",
          409,
          "CONFLICT",
        );
      if (productionOrder)
        assert(
          current.tracking?.stage === "AT_PRODUCTION" &&
            !current.tracking.blockingIssues &&
            !current.tracking.courierOwned,
          "Production changed before readiness.",
          409,
        );
      const reserved = await Shipment.findOneAndUpdate(
        {
          _id: s._id,
          uncertain: { $ne: true },
          $or: [{ lockUntil: null }, { lockUntil: { $lte: new Date() } }],
        },
        {
          $set: {
            lockUntil: new Date(Date.now() + 120000),
            readinessLockToken: readinessToken,
          },
        },
        { session },
      );
      assert(
        reserved,
        "A courier operation is already in progress or requires reconciliation.",
        409,
      );
      current.increment();
      await current.save({ session });
    });

    let readinessSent = false;
    try {
      const { raw, confirmed, observed } = abex
        ? await this.client
            .confirmReadiness(s, async (target, beforeAt) => {
              await transaction(async (session) => {
                const current = await Order.findById(orderId).session(session);
                assert(
                  current &&
                    !current.deletedAt &&
                    current.revision === expectedRevision &&
                    (!productionOrder ||
                      (current.tracking?.stage === "AT_PRODUCTION" &&
                        !current.tracking.blockingIssues &&
                        !current.tracking.courierOwned)),
                  "Order changed during ABEX verification. Refresh tracking.",
                  409,
                );
                const reserved = await Shipment.updateOne(
                  {
                    _id: s._id,
                    provider: "ABEX",
                    readinessLockToken: readinessToken,
                    lockUntil: { $gt: new Date() },
                    tracking: s.tracking,
                    pendingReadinessStateId: { $exists: false },
                  },
                  {
                    $set: {
                      pendingReadinessStateId: target,
                      pendingReadinessAt: beforeAt,
                      uncertain: true,
                    },
                  },
                  { session },
                );
                assert(
                  reserved.modifiedCount === 1,
                  "ABEX readiness reservation expired. Refresh tracking.",
                  409,
                );
              });
              readinessSent = true;
            })
            .then((parcel) => ({ raw: parcel.raw, observed: parcel }))
        : await this.confirmLegacyReadiness(
            s,
            o,
            productionOrder,
            readinessToken,
            expectedRevision,
            () => {
              readinessSent = true;
            },
          );
      return await transaction(async (session) => {
        const current = await Order.findById(orderId).session(session);
        const shipment = await Shipment.findOne({
          orderId,
          readinessLockToken: readinessToken,
        }).session(session);
        assert(
          current &&
            shipment &&
            shipment.lockUntil > new Date() &&
            !current.deletedAt &&
            ((!abex && options.expectedRevision === undefined) ||
              current.revision === expectedRevision),
          "Order changed while courier readiness was being verified. Refresh tracking.",
          409,
        );
        if (productionOrder)
          assert(
            current.tracking?.stage === "AT_PRODUCTION" &&
              !current.tracking.blockingIssues &&
              !current.tracking.courierOwned,
            "Production changed during readiness verification.",
            409,
          );
        // Persist the commercial and production states after courier confirmation.
        const updatedOrder = await transition(
          orderId,
          "READY_TO_SHIP",
          options.onConfirmed ? "courier" : actor,
          session,
        );
        if (options.onConfirmed)
          await options.onConfirmed(updatedOrder, session);
        else if (productionOrder) {
          updatedOrder.tracking.stage = "READY_TO_SHIP";
          updatedOrder.tracking.stageEnteredAt = new Date();
          updatedOrder.revision++;
          await updatedOrder.save({ session });
          await TrackingEvent.create(
            [
              {
                orderId,
                kind: "TRACKING_STAGE_CHANGED",
                previousStage: "AT_PRODUCTION",
                newStage: "READY_TO_SHIP",
                actor,
                revision: updatedOrder.revision,
                data: { courierReadinessConfirmed: true },
              },
            ],
            { session },
          );
        }
        shipment.status = "READY_TO_SHIP";
        shipment.lockUntil = null;
        shipment.readinessLockToken = undefined;
        shipment.uncertain = false;
        shipment.syncStatus = "SYNCED";
        shipment.lastError = "";
        shipment.lastSyncedAt = new Date();
        shipment.sanitizedProviderData = raw;
        shipment.messageRetour = confirmed?.MessageRetour;
        if (abex) {
          shipment.pendingReadinessStateId = undefined;
          shipment.pendingReadinessAt = undefined;
          shipment.providerStateId = observed.stateId;
          shipment.providerWorkflowId = observed.workflowId;
          shipment.providerStatusMapped = true;
        }
        if (observed) {
          shipment.providerStatus = observed.providerStatus;
          shipment.providerSituationId = observed.providerSituationId;
          if (observed.providerUpdatedAt)
            shipment.providerUpdatedAt = observed.providerUpdatedAt;
          shipment.lastObservation = { ...observed, receivedAt: new Date() };
        } else {
          // A confirmed /pret without a situation must not keep presenting the
          // previous En Préparation value as the current courier situation.
          shipment.providerStatus = undefined;
          shipment.providerSituationId = undefined;
        }
        await shipment.save({ session });
        return shipment;
      });
    } catch (error) {
      // The request may have reached ABEX even on a timeout. Do not retry blindly.
      await Shipment.updateOne(
        { _id: s._id, readinessLockToken: readinessToken },
        {
          $set: {
            syncStatus: "ERROR",
            ...(readinessSent ? { uncertain: true } : {}),
            lastError:
              error instanceof AppError
                ? error.message
                : "Ready request could not be verified. Refresh the parcel before retrying.",
            lockUntil: null,
            ...(error.providerData
              ? { sanitizedProviderData: this.sanitize(error.providerData) }
              : {}),
          },
          $unset: { readinessLockToken: 1 },
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
      assert(
        !s.tracking && !s.providerParcelId && !s.providerAccepted,
        "A linked or accepted shipment cannot be retried.",
        409,
      );
      const result = await Shipment.updateOne(
        {
          ...reservation,
          providerParcelId: null,
          providerAccepted: { $ne: true },
        },
        {
          $inc: { __v: 1 },
          $unset: { creationAttemptedAt: 1 },
          $set: {
            uncertain: false,
            providerAccepted: false,
            lockUntil: null,
            lastError: "Admin confirmed no parcel exists at provider.",
            syncStatus: "ERROR",
          },
        },
      );
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
    if (this.client.provider === "ABEX") {
      assert(
        !s.tracking || s.tracking === tracking.trim(),
        "The tracking number is already linked.",
        409,
      );
      const parcel = await this.client.getShipment({
        tracking: tracking.trim(),
        externalId: s.externalId,
        providerParcelId: s.providerParcelId,
      });
      const { shipment, outcome } = await this.applyWithResult(
        orderId,
        parcel,
        { allowLink: !s.tracking, reservation },
      );
      assert(outcome.result !== "ERROR", outcome.error, 409);
      await OrderEvent.create({
        orderId,
        kind: "SHIPMENT",
        type: "SHIPMENT_RECONCILED",
        actor,
        message:
          "ABEX parcel ownership verified using the CRM order reference.",
      });
      return shipment;
    }
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
