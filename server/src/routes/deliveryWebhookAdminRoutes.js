import { Router } from "express";
import { z } from "zod";
import {
  DeliveryWebhookEvent,
  DeliveryWebhookWorker,
  WEBHOOK_STATUSES,
} from "../models/deliveryWebhook.js";
import { DeliveryAgency } from "../models/delivery.js";
import { P, requirePermission } from "../authorization.js";
import { pagination, objectId, escapeRegex } from "../services/filters.js";
import { assert } from "../errors.js";
import { audit } from "../models/security.js";
import { transaction } from "../services/orderService.js";
import { webhookConfig } from "../services/delivery/webhooks/webhookConfig.js";
import { abexWebhookAdapter } from "../services/delivery/webhooks/abexWebhookAdapter.js";
import { backgroundIntervalMs } from "../services/delivery/abexApiTraffic.js";

export const deliveryWebhookAdminRoutes = Router();
const routes = deliveryWebhookAdminRoutes;
routes.use(requirePermission(P.deliverySync.view));

async function eventScope(user) {
  if (user.role === "SUPER_ADMIN") return {};
  // An agency can serve both businesses. Require access to every business it
  // serves before exposing unresolved parcel identifiers from its inbox.
  const agencies = await DeliveryAgency.find({ apiProvider: "ABEX" })
    .select("businesses")
    .lean();
  const ids = agencies
    .filter((a) => a.businesses.every((b) => user.businessAccess.includes(b)))
    .map((a) => a._id);
  return user.businessAccess.includes("LOGIX") &&
    user.businessAccess.includes("TAMQO")
    ? { $or: [{ agencyId: { $in: ids } }, { agencyId: { $exists: false } }] }
    : {
        agencyId: { $in: ids },
        agencyBusinesses: {
          $not: { $elemMatch: { $nin: user.businessAccess } },
        },
      };
}

const eligible = (event) =>
  Boolean(
    event.notification &&
    ["FAILED", "RETRY_PENDING"].includes(event.processingStatus) &&
    event.recoveryCount < 5,
  );
function publicEvent(event) {
  const fields = [
    "_id",
    "provider",
    "destinationId",
    "eventId",
    "eventType",
    "contractVersion",
    "receivedAt",
    "providerTimestamp",
    "eventOccurredAt",
    "processingStatus",
    "processedAt",
    "lastAttemptAt",
    "attemptCount",
    "retryCount",
    "recoveryCount",
    "nextRetryAt",
    "lockedUntil",
    "lastErrorCode",
    "lastErrorMessage",
    "resultCode",
    "agencyId",
    "orderId",
    "orderNumber",
    "shipmentId",
    "trackingNumber",
    "notification",
    "payloadMetadata",
    "payloadHash",
    "expiresAt",
  ];
  return {
    ...Object.fromEntries(fields.map((key) => [key, event[key]])),
    retryEligible: eligible(event),
  };
}

routes.get("/status", async (req, res) => {
  const config = webhookConfig(),
    scope = await eventScope(req.user);
  const [counts, lastReceived, lastProcessed, oldestPending, worker] =
    await Promise.all([
      DeliveryWebhookEvent.aggregate([
        { $match: scope },
        { $group: { _id: "$processingStatus", count: { $sum: 1 } } },
      ]),
      DeliveryWebhookEvent.findOne(scope)
        .sort({ receivedAt: -1 })
        .select("receivedAt")
        .lean(),
      DeliveryWebhookEvent.findOne({
        $and: [scope, { processingStatus: "PROCESSED" }],
      })
        .sort({ processedAt: -1 })
        .select("processedAt")
        .lean(),
      DeliveryWebhookEvent.findOne({
        $and: [
          scope,
          {
            processingStatus: {
              $in: ["RECEIVED", "RETRY_PENDING", "PROCESSING"],
            },
          },
        ],
      })
        .sort({ receivedAt: 1 })
        .select("receivedAt")
        .lean(),
      DeliveryWebhookWorker.findById(
        config.destinationId || "unconfigured",
      ).lean(),
    ]);
  const totals = Object.fromEntries(counts.map((row) => [row._id, row.count]));
  res.json({
    receiverEnabled: config.enabled,
    receiverConfigured: config.configured,
    processingEnabled: config.processingEnabled,
    agencyBound: Boolean(config.agencyId),
    backgroundRequestIntervalSeconds: backgroundIntervalMs() / 1000,
    contractVerified: abexWebhookAdapter.contractVerified,
    contractVersion: abexWebhookAdapter.contractVersion,
    supportedEventTypes: abexWebhookAdapter.supportedEventTypes,
    mutationsEnabled:
      config.configured &&
      config.processingEnabled &&
      Boolean(config.agencyId) &&
      abexWebhookAdapter.contractVerified,
    lastReceivedAt: lastReceived?.receivedAt || null,
    lastProcessedAt: lastProcessed?.processedAt || null,
    pending:
      (totals.RECEIVED || 0) +
      (totals.PROCESSING || 0) +
      (totals.RETRY_PENDING || 0),
    failed: totals.FAILED || 0,
    ignored: totals.IGNORED || 0,
    unknownOrUnmapped: await DeliveryWebhookEvent.countDocuments({
      $and: [
        scope,
        {
          resultCode: {
            $in: [
              "ABEX_CONTRACT_UNVERIFIED",
              "WEBHOOK_UNKNOWN_EVENT",
              "WEBHOOK_UNMAPPED_STATUS",
              "WEBHOOK_SCHEMA_INVALID",
            ],
          },
        },
      ],
    }),
    oldestPendingAt: oldestPending?.receivedAt || null,
    worker: worker
      ? {
          lastTickAt: worker.lastTickAt,
          lastSuccessAt: worker.lastSuccessAt,
          lastErrorAt: worker.lastErrorAt,
          lastErrorCode: worker.lastErrorCode,
        }
      : null,
    retentionDays: config.retentionDays,
  });
});

const querySchema = z.object({
  status: z.enum(WEBHOOK_STATUSES).optional(),
  eventType: z.string().max(100).optional(),
  agencyId: z
    .string()
    .regex(/^[a-f0-9]{24}$/i)
    .optional(),
  search: z.string().trim().max(150).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
routes.get("/events", async (req, res) => {
  const q = querySchema.parse(req.query),
    p = pagination(req.query);
  const clauses = [await eventScope(req.user)];
  if (q.status) clauses.push({ processingStatus: q.status });
  if (q.eventType) clauses.push({ eventType: q.eventType });
  if (q.agencyId) clauses.push({ agencyId: objectId(q.agencyId) });
  if (q.from || q.to) {
    assert(
      !q.from || !q.to || new Date(q.from) <= new Date(q.to),
      "Invalid date range",
    );
    clauses.push({
      receivedAt: {
        ...(q.from ? { $gte: new Date(q.from) } : {}),
        ...(q.to ? { $lte: new Date(q.to) } : {}),
      },
    });
  }
  if (q.search) {
    const match = { $regex: escapeRegex(q.search), $options: "i" };
    clauses.push({
      $or: [
        { orderNumber: match },
        { trackingNumber: match },
        { "notification.trackingNumber": match },
        ...(/^[a-f0-9]{24}$/i.test(q.search)
          ? [{ orderId: objectId(q.search) }]
          : []),
      ],
    });
  }
  const filter = { $and: clauses };
  const [items, total] = await Promise.all([
    DeliveryWebhookEvent.find(filter)
      .sort({ receivedAt: -1, _id: -1 })
      .skip(p.skip)
      .limit(p.limit)
      .populate("agencyId", "name")
      .lean(),
    DeliveryWebhookEvent.countDocuments(filter),
  ]);
  res.json({
    items: items.map(publicEvent),
    total,
    page: p.page,
    limit: p.limit,
  });
});

routes.get("/events/:id", async (req, res) => {
  const event = await DeliveryWebhookEvent.findOne({
    $and: [await eventScope(req.user), { _id: objectId(req.params.id) }],
  })
    .populate("agencyId", "name")
    .lean();
  assert(event, "Webhook event not found", 404);
  res.json(publicEvent(event));
});

routes.post(
  "/events/:id/retry",
  requirePermission(P.deliverySync.run),
  async (req, res) => {
    assert(
      ["ADMIN", "SUPER_ADMIN"].includes(req.user.role),
      "Administrator access required",
      403,
    );
    const id = objectId(req.params.id),
      scope = await eventScope(req.user);
    const event = await transaction(async (session) => {
      const current = await DeliveryWebhookEvent.findOne({
        $and: [scope, { _id: id }],
      }).session(session);
      assert(current, "Webhook event not found", 404);
      assert(
        eligible(current),
        "This event is not eligible for retry. Review its contract and recovery budget.",
        409,
      );
      const updated = await DeliveryWebhookEvent.findOneAndUpdate(
        {
          _id: id,
          processingStatus: current.processingStatus,
          recoveryCount: current.recoveryCount,
        },
        {
          $set: {
            processingStatus: "RETRY_PENDING",
            retryCount: 0,
            nextRetryAt: new Date(),
            lastErrorCode: "",
            lastErrorMessage: "",
          },
          $inc: { recoveryCount: 1 },
          $unset: {
            lockToken: 1,
            lockedUntil: 1,
            processedAt: 1,
            expiresAt: 1,
          },
        },
        { new: true, session },
      );
      assert(updated, "Event changed; reload before retrying.", 409);
      await audit(
        req.actor,
        "DELIVERY_WEBHOOK_RETRY",
        "DeliveryWebhookEvent",
        id,
        undefined,
        {
          previousStatus: current.processingStatus,
          recoveryCount: updated.recoveryCount,
        },
        session,
      );
      return updated.toObject();
    });
    res.json(publicEvent(event));
  },
);
