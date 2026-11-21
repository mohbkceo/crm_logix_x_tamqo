import { createHash, randomUUID } from "node:crypto";
import { DeliveryWebhookEvent } from "../../../models/deliveryWebhook.js";
import { DeliveryAgency } from "../../../models/delivery.js";
import { AppError } from "../../../errors.js";
import {
  abexWebhookAdapter,
  notificationSchema,
} from "./abexWebhookAdapter.js";

export async function acceptWebhook({
  body,
  verified,
  config,
  adapter = abexWebhookAdapter,
}) {
  const payloadHash = createHash("sha256").update(body).digest("hex");
  let parsed;
  try {
    parsed = adapter.parse(verified.payload);
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(parsed.eventType)) throw new Error();
    if (parsed.notification) {
      if (!adapter.contractVerified) throw new Error();
      parsed.notification = notificationSchema.parse(parsed.notification);
    }
  } catch {
    // Preserve authenticated but unsupported/malformed provider events for
    // review with a hash and shape counts, never arbitrary body contents.
    parsed = {
      eventType: "INVALID_SCHEMA",
      notification: null,
      resultCode: "WEBHOOK_SCHEMA_INVALID",
    };
  }
  const key = {
    provider: "ABEX",
    destinationId: config.destinationId,
    eventId: verified.eventId,
  };
  // Do not buffer an acknowledgement path during a database outage.
  if (DeliveryWebhookEvent.db.readyState !== 1)
    throw new Error("Webhook storage unavailable");
  const agency = config.agencyId
    ? await DeliveryAgency.findById(config.agencyId).select("businesses").lean()
    : null;
  try {
    const [event] = await DeliveryWebhookEvent.create(
      [
        {
          ...key,
          eventType: parsed.eventType,
          contractVersion: adapter.contractVersion,
          receivedAt: new Date(),
          providerTimestamp: verified.providerTimestamp,
          agencyId: config.agencyId,
          agencyBusinesses: agency?.businesses || [],
          notification: parsed.notification || undefined,
          resultCode: parsed.resultCode,
          payloadHash,
          payloadMetadata: {
            byteLength: body.length,
            topLevelFieldCount: Object.keys(verified.payload).length,
          },
        },
      ],
      { writeConcern: { w: "majority", wtimeout: 5000 } },
    );
    return { event, duplicate: false };
  } catch (error) {
    if (error.code !== 11000) throw error;
    const event = await DeliveryWebhookEvent.findOne(key)
      .read("primary")
      .readConcern("majority")
      .maxTimeMS(5000);
    if (!event) throw error;
    if (event.payloadHash !== payloadHash)
      throw new AppError(
        "Webhook identifier conflicts with a previous delivery.",
        409,
        "WEBHOOK_REPLAY_CONFLICT",
      );
    return { event, duplicate: true };
  }
}

export async function claimWebhook(config, now = new Date()) {
  // A claim token fences out a worker that resumes after another worker
  // reclaimed its expired lease. Crashes count toward the same retry budget.
  await DeliveryWebhookEvent.updateMany(
    {
      destinationId: config.destinationId,
      retryCount: { $gte: config.maxAttempts },
      $or: [
        { processingStatus: "PROCESSING", lockedUntil: { $lte: now } },
        { processingStatus: { $in: ["RECEIVED", "RETRY_PENDING"] } },
      ],
    },
    {
      $set: {
        processingStatus: "FAILED",
        expiresAt: terminalExpiry(config, true),
        lastErrorCode: "WEBHOOK_ATTEMPTS_EXHAUSTED",
        lastErrorMessage:
          "Retry budget exhausted; administrator review required.",
      },
      $unset: { lockToken: 1, lockedUntil: 1, nextRetryAt: 1 },
    },
  );
  return DeliveryWebhookEvent.findOneAndUpdate(
    {
      provider: "ABEX",
      destinationId: config.destinationId,
      retryCount: { $lt: config.maxAttempts },
      $or: [
        { processingStatus: "RECEIVED" },
        { processingStatus: "RETRY_PENDING", nextRetryAt: { $lte: now } },
        { processingStatus: "PROCESSING", lockedUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        processingStatus: "PROCESSING",
        lastAttemptAt: now,
        lockedUntil: new Date(+now + config.leaseMs),
        lockToken: randomUUID(),
      },
      $inc: { attemptCount: 1, retryCount: 1 },
      $unset: { expiresAt: 1, nextRetryAt: 1 },
    },
    { new: true, sort: { receivedAt: 1, _id: 1 } },
  ).select("+lockToken");
}

export const claimFilter = (event) => ({
  _id: event._id,
  processingStatus: "PROCESSING",
  lockToken: event.lockToken,
  lockedUntil: { $gt: new Date() },
});

export const terminalExpiry = (config, failed = false) =>
  new Date(
    Date.now() +
      (failed ? config.failedRetentionDays : config.retentionDays) * 86400000,
  );
