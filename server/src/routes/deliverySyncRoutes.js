import { Router } from "express";
import { DeliverySyncItem, DeliverySyncRun } from "../models/delivery.js";
import { P, requirePermission } from "../authorization.js";
import { pagination, objectId } from "../services/filters.js";
import { deliveryService } from "../services/delivery/deliveryService.js";
import { getDeliverySchedulerState } from "../services/delivery/deliveryScheduler.js";
import { audit } from "../models/security.js";
import { assert } from "../errors.js";

export const deliverySyncRoutes = Router();

deliverySyncRoutes.get(
  "/status",
  requirePermission(P.deliverySync.view),
  async (_req, res) => {
    const lastRun = await DeliverySyncRun.findOne()
      .sort({ startedAt: -1, _id: -1 })
      .lean();
    res.json({ ...getDeliverySchedulerState(), lastRun });
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
