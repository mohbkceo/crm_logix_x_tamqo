import { randomUUID } from "node:crypto";
import { Order, Shipment, OrderEvent } from "../../models/index.js";
import {
  DeliveryAgency,
  DeliverySyncItem,
  DeliverySyncLock,
  DeliverySyncRun,
} from "../../models/delivery.js";
import { audit } from "../../models/security.js";
import { providerFor } from "./deliveryProviderFactory.js";
import { DeliverySyncService } from "./deliverySyncService.js";
import { transaction, transition } from "../orderService.js";
import { assert, AppError } from "../../errors.js";
import {
  parsePackages,
  sanitizeProviderData,
  validTracking,
} from "./deliveryMapper.js";
import { TERMINAL } from "../../constants.js";
const SYNC_LOCK_ID = "delivery-status-sync";
const SYNC_BATCH_SIZE = 20;
const lockDuration = () =>
  Math.max(
    30 * 60 * 1000,
    Number(process.env.DELIVERY_SYNC_INTERVAL_MS || 900000) * 2,
  );
const safeError = (error) =>
  sanitizeProviderData(
    error instanceof Error ? error.message : "Delivery synchronization failed.",
  );
async function acquireSyncLock(runId) {
  const owner = randomUUID(),
    now = new Date();
  try {
    const lock = await DeliverySyncLock.findOneAndUpdate(
      {
        _id: SYNC_LOCK_ID,
        $or: [{ expiresAt: { $lte: now } }, { owner }],
      },
      {
        $set: {
          owner,
          runId,
          expiresAt: new Date(Date.now() + lockDuration()),
        },
      },
      { upsert: true, new: true },
    );
    return lock?.owner === owner ? owner : null;
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
}
const releaseSyncLock = (owner) =>
  owner
    ? DeliverySyncLock.deleteOne({ _id: SYNC_LOCK_ID, owner })
    : Promise.resolve();
const extendSyncLock = (owner) =>
  DeliverySyncLock.updateOne(
    { _id: SYNC_LOCK_ID, owner },
    { $set: { expiresAt: new Date(Date.now() + lockDuration()) } },
  );
function syncSummary(run) {
  console.log(
    `[DELIVERY SYNC] trigger=${run.trigger} run=${run._id} scanned=${run.scanned} eligible=${run.eligible} attempted=${run.attempted} changed=${run.changed} unchanged=${run.unchanged} terminal=${run.terminalReached} unknown=${run.unknownStatuses} failed=${run.failed} duration=${run.durationMs}ms`,
  );
}
function publicRun(run) {
  const value = run?.toObject ? run.toObject() : run;
  return {
    ...value,
    runId: String(value._id),
    synced: value.successful,
    errors: value.failed,
  };
}
async function context(id, capability, creating = false) {
  const order = await Order.findById(id);
  assert(order, "Order not found", 404);
  const agency = await DeliveryAgency.findById(order.delivery.agencyId);
  assert(agency, "Order delivery agency is missing. Run the migration.", 409);
  if (creating) {
    assert(agency.active, "Agency is disabled", 409);
    assert(
      order.items.every((i) => agency.businesses.includes(i.business)),
      "Agency does not serve this order",
      409,
    );
  }
  assert(
    agency.capabilities?.[capability],
    `Agency does not support ${capability}`,
    409,
  );
  return {
    order,
    agency,
    service:
      agency.integrationType === "API"
        ? new DeliverySyncService(await providerFor(agency._id, capability))
        : null,
  };
}
async function event(id, actor, message) {
  await OrderEvent.create({
    orderId: id,
    kind: "SHIPMENT",
    type: "SHIPMENT_UPDATED",
    actor,
    source: "INTERNAL",
    message,
  });
  await audit(actor, "ORDER_SHIPMENT_UPDATED", "Order", id);
}
export const deliveryService = {
  // Called only after createOrder's transaction has committed. Courier failure
  // is a shipment outcome, never an unsuccessful local order creation.
  async createAutomatically(order, actor) {
    let shipment = null;
    let shipmentSync = { attempted: false, success: null };
    try {
      const agency = await DeliveryAgency.findById(order.delivery.agencyId);
      if (
        agency?.integrationType !== "API" ||
        !agency.capabilities?.createShipment
      )
        return { shipment, shipmentSync };
      shipmentSync.attempted = true;
      shipment = await this.create(order._id, actor);
      shipmentSync = {
        attempted: true,
        success: shipment.syncStatus === "SYNCED",
        providerAccepted: shipment.providerAccepted,
        trackingFound: Boolean(shipment.tracking),
        error: shipment.lastError || null,
      };
    } catch (error) {
      shipmentSync.success = false;
      shipmentSync.error = sanitizeProviderData(
        error instanceof AppError
          ? error.message
          : "Courier synchronization failed. Inspect the shipment before retrying.",
      );
      // Configuration/factory failures may happen before the sync service creates
      // its record. Never overwrite an existing attempt or unlock its reservation.
      try {
        shipment = await Shipment.findOneAndUpdate(
          { orderId: order._id },
          {
            $setOnInsert: {
              agencyId: order.delivery.agencyId,
              agencyName: order.delivery.agencyName,
              provider: "PROCOLIS",
              externalId: order.orderNumber,
              status: order.status,
              syncStatus: "ERROR",
              lastError: shipmentSync.error,
            },
          },
          { upsert: true, new: true },
        );
      } catch {
        /* Preserve the committed order response even if diagnostics cannot be saved. */
      }
    }
    const publicShipment = shipment?.toObject ? shipment.toObject() : shipment;
    if (publicShipment) delete publicShipment.sanitizedProviderData;
    return { shipment: publicShipment, shipmentSync };
  },
  async create(id, actor, input = {}) {
    const { order, agency, service } = await context(
      id,
      "createShipment",
      true,
    );
    let result;
    if (service) result = await service.create(id, { actor });
    else
      result = await transaction(async (session) => {
        const o = await Order.findById(id).session(session);
        assert(
          ["CONFIRMED", "PREPARING", "READY_TO_SHIP"].includes(o.status),
          "Confirm the order first",
          409,
        );
        let shipment = await Shipment.findOne({ orderId: id }).session(session);
        if (shipment) return shipment;
        const tracking =
          typeof input.tracking === "string" ? input.tracking.trim() : "";
        assert(tracking.length <= 150, "Tracking is too long");
        [shipment] = await Shipment.create(
          [
            {
              orderId: id,
              agencyId: agency._id,
              agencyName: agency.name,
              provider: "MANUAL",
              externalId: order.orderNumber,
              ...(tracking
                ? { tracking, trackingKey: tracking.toUpperCase() }
                : {}),
              status: o.status,
              syncStatus: "SYNCED",
              lastSyncedAt: new Date(),
            },
          ],
          { session },
        );
        o.revision++;
        o.lastUpdatedBy = actor;
        await o.save({ session });
        return shipment;
      });
    await event(
      id,
      actor,
      result.syncStatus === "SYNCED"
        ? "Shipment created or linked"
        : "Shipment synchronization requires attention",
    );
    return result;
  },
  async ready(id, actor) {
    const { service } = await context(id, "readyToShip");
    const result = service
      ? await service.ready(id, actor)
      : await transition(id, "READY_TO_SHIP", actor);
    await event(id, actor, "Marked ready");
    return result;
  },
  async refresh(id, actor) {
    const { service } = await context(id, "tracking");
    const result = service
      ? await service.refresh(id)
      : await Shipment.findOne({ orderId: id });
    assert(result, "No shipment exists", 404);
    if (actor) await event(id, actor, "Tracking refreshed");
    return result;
  },
  async reconcile(id, tracking, absent, actor) {
    const { service, order } = await context(id, "tracking");
    if (service) return service.reconcile(id, tracking, absent, actor);
    assert(
      typeof tracking === "string" &&
        tracking.trim().length > 0 &&
        tracking.length <= 150,
      "Enter a tracking number",
    );
    const result = await Shipment.findOneAndUpdate(
      { orderId: id },
      {
        tracking: tracking.trim(),
        trackingKey: tracking.trim().toUpperCase(),
        status: order.status,
        lastSyncedAt: new Date(),
      },
      { new: true },
    );
    assert(result, "Create a shipment first", 409);
    await event(id, actor, "Manual tracking updated");
    return result;
  },
  async syncBatch({ trigger = "MANUAL" } = {}) {
    const started = Date.now(),
      run = await DeliverySyncRun.create({
        trigger,
        startedAt: new Date(started),
        status: "RUNNING",
      });
    let lockOwner;
    const counters = {
      scanned: 0,
      eligible: 0,
      attempted: 0,
      successful: 0,
      failed: 0,
      changed: 0,
      unchanged: 0,
      skipped: 0,
      terminalReached: 0,
      unknownStatuses: 0,
      skipReasons: {
        noShipment: 0,
        noTracking: 0,
        missingAgency: 0,
        manualAgency: 0,
        trackingDisabled: 0,
      },
    };
    const finish = async (status) => {
      const finishedAt = new Date(),
        durationMs = Math.max(0, Date.now() - started);
      Object.assign(run, counters, { status, finishedAt, durationMs });
      await run.save();
      syncSummary(run);
      return publicRun(run);
    };
    const persistError = async (entry, error) => {
      const message = safeError(error),
        began = Date.now();
      await Shipment.updateOne(
        { _id: entry.shipment._id },
        { $set: { syncStatus: "ERROR", lastError: message } },
      );
      await DeliverySyncItem.create({
        runId: run._id,
        orderId: entry.order._id,
        orderNumber: entry.order.orderNumber,
        shipmentId: entry.shipment._id,
        tracking: entry.shipment.tracking,
        agencyId: entry.agency._id,
        agencyName: entry.agency.name,
        beforeProviderStatus: entry.shipment.providerStatus || null,
        afterProviderStatus: entry.shipment.providerStatus || null,
        beforeOrderStatus: entry.order.status,
        afterOrderStatus: entry.order.status,
        changed: false,
        terminalReached: false,
        result: "ERROR",
        error: message,
        durationMs: Math.max(0, Date.now() - began),
      });
      counters.failed++;
      counters.unchanged++;
    };
    try {
      lockOwner = await acquireSyncLock(run._id);
      if (!lockOwner) {
        return await finish("COMPLETED");
      }
      const orders = await Order.find({ status: { $nin: TERMINAL } })
          .sort({ createdAt: 1, _id: 1 })
          .lean(),
        orderIds = orders.map((order) => order._id),
        shipments = await Shipment.find({ orderId: { $in: orderIds } })
          .sort({ lastSyncedAt: 1, _id: 1 })
          .lean(),
        shipmentsByOrderId = new Map(
          shipments.map((shipment) => [String(shipment.orderId), shipment]),
        ),
        agencyIds = [
          ...shipments.map((shipment) => shipment.agencyId),
          ...orders.map((order) => order.delivery?.agencyId),
        ].filter(Boolean),
        agencies = await DeliveryAgency.find({
          _id: { $in: agencyIds },
        }).lean(),
        agenciesById = new Map(
          agencies.map((agency) => [String(agency._id), agency]),
        );
      counters.scanned = orders.length;
      const eligible = [];
      for (const order of orders) {
        const shipment = shipmentsByOrderId.get(String(order._id));
        if (!shipment) {
          counters.skipReasons.noShipment++;
          continue;
        }
        if (!validTracking(shipment.tracking)) {
          counters.skipReasons.noTracking++;
          continue;
        }
        const agency =
          agenciesById.get(String(shipment.agencyId || "")) ||
          agenciesById.get(String(order.delivery?.agencyId || ""));
        if (!agency) {
          counters.skipReasons.missingAgency++;
          continue;
        }
        if (agency.integrationType !== "API") {
          counters.skipReasons.manualAgency++;
          continue;
        }
        if (!agency.capabilities?.tracking) {
          counters.skipReasons.trackingDisabled++;
          continue;
        }
        eligible.push({ shipment, order, agency });
      }
      eligible.sort(
        (a, b) =>
          (a.shipment.lastSyncedAt?.getTime() || 0) -
          (b.shipment.lastSyncedAt?.getTime() || 0),
      );
      counters.eligible = eligible.length;
      counters.skipped = counters.scanned - counters.eligible;
      const byAgency = new Map();
      for (const entry of eligible) {
        const key = String(entry.agency._id);
        if (!byAgency.has(key)) byAgency.set(key, []);
        byAgency.get(key).push(entry);
      }
      for (const entries of byAgency.values()) {
        await extendSyncLock(lockOwner);
        let service;
        try {
          service = new DeliverySyncService(
            await providerFor(entries[0].agency._id, "tracking"),
          );
        } catch (error) {
          for (const entry of entries) await persistError(entry, error);
          continue;
        }
        for (let index = 0; index < entries.length; index += SYNC_BATCH_SIZE) {
          await extendSyncLock(lockOwner);
          const batch = entries.slice(index, index + SYNC_BATCH_SIZE);
          let parcels;
          try {
            counters.attempted += batch.length;
            parcels = parsePackages(
              await service.client.readPackages(
                batch.map((entry) => entry.shipment.tracking),
              ),
            );
          } catch (error) {
            for (const entry of batch) await persistError(entry, error);
            continue;
          }
          const parcelsByTracking = new Map(
            parcels.map((parcel) => [parcel.tracking.toUpperCase(), parcel]),
          );
          for (const entry of batch) {
            const began = Date.now(),
              parcel = parcelsByTracking.get(
                entry.shipment.tracking.trim().toUpperCase(),
              );
            if (!parcel) {
              await persistError(
                entry,
                new AppError("Tracking absent from batch response.", 502),
              );
              continue;
            }
            try {
              const { outcome } = await service.applyWithResult(
                entry.order._id,
                parcel,
                { requireStatus: true },
              );
              await DeliverySyncItem.create({
                runId: run._id,
                orderId: entry.order._id,
                orderNumber: entry.order.orderNumber,
                shipmentId: entry.shipment._id,
                tracking: entry.shipment.tracking,
                agencyId: entry.agency._id,
                agencyName: entry.agency.name,
                ...outcome,
                durationMs: Math.max(0, Date.now() - began),
              });
              if (outcome.result === "UNKNOWN_STATUS") {
                counters.unknownStatuses++;
                counters.successful++;
              } else if (outcome.result === "ERROR") counters.failed++;
              else counters.successful++;
              if (outcome.changed) counters.changed++;
              else counters.unchanged++;
              if (outcome.terminalReached) counters.terminalReached++;
            } catch (error) {
              await persistError(entry, error);
            }
          }
        }
      }
      return await finish(counters.failed ? "PARTIAL" : "COMPLETED");
    } catch {
      counters.failed = Math.max(counters.failed, counters.attempted || 1);
      return await finish("FAILED");
    } finally {
      await releaseSyncLock(lockOwner);
    }
  },
};
