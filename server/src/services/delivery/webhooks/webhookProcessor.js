import {
  DeliveryWebhookEvent,
  DeliveryWebhookWorker,
} from "../../../models/deliveryWebhook.js";
import { transaction } from "../../orderService.js";
import { abexWebhookAdapter } from "./abexWebhookAdapter.js";
import {
  claimWebhook,
  claimFilter,
  terminalExpiry,
} from "./webhookInboxService.js";
import { webhookConfig } from "./webhookConfig.js";
import {
  prepareWebhookRefresh,
  WebhookProcessingError,
} from "./webhookReconciliationService.js";

const retryableCodes = new Set([
  "ABEX_TIMEOUT",
  "ABEX_UNAVAILABLE",
  "ABEX_NETWORK",
  "ABEX_RATE_LIMIT",
  "ABEX_NOT_FOUND",
  "DELIVERY_NOT_CONFIGURED",
  "DELIVERY_OPERATION_BUSY",
  "CONFLICT",
]);
const messages = {
  ABEX_AUTHENTICATION: "Provider credentials require administrator review.",
  ABEX_PERMISSION: "Provider permissions require administrator review.",
  ABEX_INVALID_RESPONSE: "Provider response could not be validated.",
  ABEX_INVALID_TRACKING: "Linked tracking number could not be validated.",
  ABEX_CONTRACT_UNVERIFIED:
    "ABEX event contract is unverified. No shipment changes were attempted.",
  WEBHOOK_UNKNOWN_EVENT: "Event topic has no supported parcel notification.",
  WEBHOOK_SCHEMA_INVALID: "Provider event schema requires review.",
  WEBHOOK_SHIPMENT_NOT_LINKED:
    "No linked ABEX shipment in the configured agency; resolution will be retried.",
  WEBHOOK_AGENCY_UNCONFIGURED:
    "Bind the destination to its CRM agency before processing supported notifications.",
  WEBHOOK_AGENCY_MISMATCH:
    "The shipment or agency identity did not match; no order changes were applied.",
  ABEX_IDENTITY_MISMATCH:
    "Provider parcel identity did not match the linked shipment.",
  DELIVERY_STALE_OBSERVATION:
    "Older or conflicting provider timestamp; last accepted state preserved.",
  DELIVERY_PRODUCTION_BLOCKED:
    "CRM production readiness has not been confirmed.",
  DELIVERY_READINESS_UNVERIFIED:
    "An existing courier readiness operation requires reconciliation.",
  DELIVERY_TRANSITION_REJECTED:
    "Existing CRM transition rules rejected this observation.",
  WEBHOOK_UNMAPPED_STATUS:
    "Provider status has no verified CRM mapping; review agency workflow mappings.",
  WEBHOOK_CONTRACT_CHANGED:
    "Saved notification contract differs from the active adapter; review required.",
};

function safeFailure(error) {
  const known =
    error instanceof WebhookProcessingError ||
    retryableCodes.has(error.code) ||
    Object.hasOwn(messages, error.code);
  const retryable =
    error.retryable === true ||
    retryableCodes.has(error.code) ||
    (!known && !(error.status >= 400 && error.status < 500));
  return {
    code: known
      ? error.code
      : retryable
        ? "WEBHOOK_PROCESSING_UNAVAILABLE"
        : "WEBHOOK_PROCESSING_REJECTED",
    message:
      messages[error.code] ||
      (retryable
        ? "A processing dependency is unavailable; retry scheduled."
        : "Provider processing requires administrator review."),
    retryable,
  };
}

async function finish(event, config, values, session) {
  const result = await DeliveryWebhookEvent.updateOne(
    claimFilter(event),
    {
      $set: {
        ...values,
        processedAt: new Date(),
        expiresAt: terminalExpiry(config, values.processingStatus === "FAILED"),
      },
      $unset: { lockToken: 1, lockedUntil: 1, nextRetryAt: 1 },
    },
    { session },
  );
  if (result.modifiedCount !== 1)
    throw new WebhookProcessingError("WEBHOOK_LEASE_LOST", true);
}

export async function processWebhookClaim(
  event,
  config,
  { adapter = abexWebhookAdapter, prepare = prepareWebhookRefresh } = {},
) {
  try {
    if (!event.notification) {
      const code = [
        "ABEX_CONTRACT_UNVERIFIED",
        "WEBHOOK_SCHEMA_INVALID",
      ].includes(event.resultCode)
        ? event.resultCode
        : "WEBHOOK_UNKNOWN_EVENT";
      await finish(event, config, {
        processingStatus:
          code === "WEBHOOK_SCHEMA_INVALID" ? "FAILED" : "IGNORED",
        resultCode: code,
        lastErrorCode: code,
        lastErrorMessage: messages[code],
      });
      return;
    }
    if (
      !adapter.contractVerified ||
      adapter.contractVersion !== event.contractVersion
    )
      throw new WebhookProcessingError("WEBHOOK_CONTRACT_CHANGED");
    const refresh = await prepare(event, config);
    await transaction(async (session) => {
      // Touch the fenced inbox row first: a reclaimed/expired lease cannot
      // commit any business effect, even if the old network request completes.
      const owned = await DeliveryWebhookEvent.updateOne(
        claimFilter(event),
        {
          $set: { lastAttemptAt: new Date() },
        },
        { session },
      );
      if (owned.matchedCount !== 1)
        throw new WebhookProcessingError("WEBHOOK_LEASE_LOST", true);
      const { outcome } = await refresh.service.applyWithResult(
        refresh.shipment.orderId,
        refresh.parcel,
        {
          session,
          reservation: refresh.reservation,
          requireStatus: true,
        },
      );
      if (outcome.result === "SKIPPED")
        throw new WebhookProcessingError(
          outcome.code || "DELIVERY_OPERATION_BUSY",
          true,
        );
      const stale = outcome.code === "DELIVERY_STALE_OBSERVATION";
      const code =
        outcome.result === "UNKNOWN_STATUS"
          ? "WEBHOOK_UNMAPPED_STATUS"
          : outcome.code || outcome.result;
      await finish(
        event,
        config,
        {
          processingStatus: stale
            ? "IGNORED"
            : ["ERROR", "UNKNOWN_STATUS"].includes(outcome.result)
              ? "FAILED"
              : "PROCESSED",
          resultCode: code,
          lastErrorCode: messages[code] ? code : "",
          lastErrorMessage: messages[code] || "",
          orderId: refresh.shipment.orderId,
          orderNumber: refresh.shipment.externalId,
          shipmentId: refresh.shipment._id,
          trackingNumber: refresh.shipment.tracking,
        },
        session,
      );
    });
  } catch (error) {
    const failure = safeFailure(error);
    const retry = failure.retryable && event.retryCount < config.maxAttempts;
    await DeliveryWebhookEvent.updateOne(claimFilter(event), {
      $set: {
        processingStatus: retry ? "RETRY_PENDING" : "FAILED",
        lastErrorCode: failure.code,
        lastErrorMessage: failure.message,
        ...(!retry ? { expiresAt: terminalExpiry(config, true) } : {}),
        ...(retry
          ? {
              nextRetryAt: new Date(
                Date.now() +
                  Math.min(3600000, 15000 * 2 ** (event.retryCount - 1)),
              ),
            }
          : {}),
      },
      $unset: { lockToken: 1, lockedUntil: 1 },
    });
  }
}

export async function runWebhookBatch(
  config = webhookConfig(),
  dependencies = {},
) {
  if (!config.processingEnabled || !config.configured) return;
  await DeliveryWebhookWorker.updateOne(
    { _id: config.destinationId },
    { $set: { lastTickAt: new Date() } },
    { upsert: true },
  );
  for (let i = 0; i < 20; i++) {
    const event = await claimWebhook(config);
    if (!event) break;
    await processWebhookClaim(event, config, dependencies);
  }
  await DeliveryWebhookWorker.updateOne(
    { _id: config.destinationId },
    { $set: { lastSuccessAt: new Date(), lastErrorCode: "" } },
  );
}

export function startWebhookProcessor() {
  let timer,
    stopped = false,
    running = Promise.resolve();
  const tick = async () => {
    const config = webhookConfig();
    try {
      await runWebhookBatch(config);
    } catch {
      // Never log request bodies, credentials, or arbitrary error messages.
      console.error("[ABEX WEBHOOK] Inbox worker dependency unavailable.");
      await DeliveryWebhookWorker.updateOne(
        { _id: config.destinationId },
        {
          $set: {
            lastErrorAt: new Date(),
            lastErrorCode: "WEBHOOK_DEPENDENCY_UNAVAILABLE",
          },
        },
        { upsert: true },
      ).catch(() => {});
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          running = tick();
        }, config.pollMs);
        timer.unref();
      }
    }
  };
  running = tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
