import { Router } from "express";
import { z } from "zod";
import { DeliverySyncItem, DeliverySyncRun } from "../models/delivery.js";
import { P, requirePermission } from "../authorization.js";
import { pagination, objectId } from "../services/filters.js";
import { deliveryService } from "../services/delivery/deliveryService.js";
import {
  applyDeliverySyncSettings,
  getDeliverySchedulerState,
} from "../services/delivery/deliveryScheduler.js";
import {
  DELIVERY_SYNC_SETTINGS_ID,
  MAX_DELIVERY_SYNC_INTERVAL_MINUTES,
  MIN_DELIVERY_SYNC_INTERVAL_MINUTES,
  loadDeliverySyncSettings,
  saveDeliverySyncSettings,
} from "../services/delivery/deliverySyncSettings.js";
import { audit } from "../models/security.js";
import { assert } from "../errors.js";
import { deliveryWebhookAdminRoutes } from "./deliveryWebhookAdminRoutes.js";

export const deliverySyncRoutes = Router();
deliverySyncRoutes.use("/webhooks", deliveryWebhookAdminRoutes);

const settingsSchema = z
  .object({
    cronEnabled: z.boolean().optional(),
    intervalMinutes: z
      .number()
      .int()
      .min(MIN_DELIVERY_SYNC_INTERVAL_MINUTES)
      .max(MAX_DELIVERY_SYNC_INTERVAL_MINUTES)
      .optional(),
    loggingEnabled: z.boolean().optional(),
  })
  .strict();

// The saved settings are authoritative; the scheduler only contributes the
// time of its next tick.
async function syncStatus() {
  const [settings, lastRun] = await Promise.all([
      loadDeliverySyncSettings(),
      DeliverySyncRun.findOne().sort({ startedAt: -1, _id: -1 }).lean(),
    ]),
    scheduler = getDeliverySchedulerState();
  return {
    ...settings,
    enabled: settings.cronEnabled,
    intervalMs: settings.intervalMinutes * 60000,
    nextRunAt: settings.cronEnabled ? scheduler.nextRunAt : null,
    startedAt: scheduler.startedAt,
    lastRun,
  };
}

deliverySyncRoutes.get(
  "/status",
  requirePermission(P.deliverySync.view),
  async (_req, res) => {
    res.json(await syncStatus());
  },
);

deliverySyncRoutes.put(
  "/settings",
  requirePermission(P.deliverySync.configure),
  async (req, res) => {
    const changes = settingsSchema.parse(req.body),
      { before, after } = await saveDeliverySyncSettings(changes, req.actor);
    await audit(
      req.actor,
      "DELIVERY_SYNC_SETTINGS_CHANGED",
      "DeliverySyncSettings",
      DELIVERY_SYNC_SETTINGS_ID,
      undefined,
      { before, after },
    );
    await applyDeliverySyncSettings();
    res.json(await syncStatus());
  },
);

deliverySyncRoutes.get(
  "/runs",
  requirePermission(P.deliverySync.view),
  async (req, res) => {
    const p = pagination(req.query),
      [items, total] = await Promise.all([
        DeliverySyncRun.find()
          .sort({ startedAt: -1, _id: -1 })
          .skip(p.skip)
          .limit(p.limit)
          .lean(),
        DeliverySyncRun.countDocuments(),
      ]);
    res.json({ items, total, page: p.page, limit: p.limit });
  },
);

deliverySyncRoutes.get(
  "/runs/:id",
  requirePermission(P.deliverySync.view),
  async (req, res) => {
    const runId = objectId(req.params.id),
      [run, items] = await Promise.all([
        DeliverySyncRun.findById(runId).lean(),
        DeliverySyncItem.find({ runId }).sort({ createdAt: 1, _id: 1 }).lean(),
      ]);
    assert(run, "Sync run not found", 404);
    res.json({ run, items });
  },
);

deliverySyncRoutes.post(
  "/run",
  requirePermission(P.deliverySync.run),
  async (req, res) => {
    const result = await deliveryService.syncBatch({ trigger: "MANUAL" });
    await audit(
      req.actor,
      "DELIVERY_SYNC_RUN",
      "DeliverySyncRun",
      result.runId,
      undefined,
      { status: result.status },
    );
    res.json(result);
  },
);
