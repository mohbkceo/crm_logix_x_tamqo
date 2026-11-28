import {
  NotificationOutbox,
  TelegramSetting,
} from "../../../models/telegram.js";
import { Order, Shipment } from "../../../models/index.js";
import { orderSummary, summaryKeyboard } from "./telegramOrderFormatter.js";
import { loadOrderPhotos } from "./telegramOrderMedia.js";
import { loadCreatorContact } from "./telegramOrderCreator.js";
import { classifyTelegramFailure } from "./telegramClient.js";
import { activeClient } from "./telegramSettings.js";
import {
  fence,
  finishJob,
  MAX_ATTEMPTS,
} from "../notificationOutboxService.js";

// Destinations are matched strictly by Order.businessType. A partnership order
// reaches an independent business group only if that destination lists
// PARTNERSHIP explicitly.
export const matchingDestinations = (setting, order) =>
  (setting.destinations || []).filter(
    (d) =>
      d.enabled !== false &&
      (d.businessTypes || []).includes(order.businessType),
  );

const backoff = (attempts, retryAfter = 0) =>
  new Date(
    Date.now() +
      Math.max(
        retryAfter * 1000,
        Math.min(3600000, 15000 * 2 ** Math.max(0, attempts - 1)),
      ),
  );

async function recordAdminError(message, delivery, job) {
  await TelegramSetting.updateOne(
    { _id: "telegram" },
    {
      $set: {
        lastNotificationError: {
          at: new Date(),
          message: String(message).slice(0, 500),
          destinationName: delivery?.destinationName || "",
          orderNumber: job.orderNumber || "",
        },
      },
    },
  ).catch(() => {});
}

// Persist each step under the job lease so a crash after a photo upload does
// not resend the album, and a crash after the summary does not duplicate it.
async function saveDelivery(job, index, values) {
  const $set = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [`deliveries.${index}.${k}`, v]),
  );
  const result = await NotificationOutbox.updateOne(fence(job), { $set });
  if (result.matchedCount !== 1)
    throw Object.assign(new Error("Lease lost"), { leaseLost: true });
  Object.assign(job.deliveries[index], values);
}

async function sendPhotos(client, delivery, photos) {
  const target = {
    chatId: delivery.chatId,
    threadId: delivery.messageThreadId || undefined,
  };
  if (photos.length === 1) {
    const message = await client.sendPhoto({ ...target, photo: photos[0] });
    return [message.message_id];
  }
  const messages = await client.sendMediaGroup({
    ...target,
    photos: photos.slice(0, 10),
  });
  return messages.map((m) => m.message_id);
}

export async function processOrderCreatedJob(
  job,
  {
    getClient = activeClient,
    loadPhotos = loadOrderPhotos,
    loadContact = loadCreatorContact,
  } = {},
) {
  const { setting, client } = await getClient();
  if (!setting.enabled || !client)
    return finishJob(job, {
      status: "SKIPPED",
      skipReason: "TELEGRAM_DISABLED",
    });
  const order = await Order.findById(job.orderId)
    .select("-originalData -statusHistory")
    .lean();
  if (!order || order.deletedAt)
    return finishJob(job, {
      status: "SKIPPED",
      skipReason: "ORDER_UNAVAILABLE",
    });
  if (!job.deliveries.length) {
    const destinations = matchingDestinations(setting, order);
    if (!destinations.length)
      return finishJob(job, {
        status: "SKIPPED",
        skipReason: "NO_MATCHING_DESTINATION",
      });
    job.deliveries = destinations.map((d) => ({
      destinationId: String(d._id),
      destinationName: d.name,
      chatId: d.chatId,
      messageThreadId: d.messageThreadId || null,
      status: "PENDING",
    }));
    await NotificationOutbox.updateOne(fence(job), {
      $set: { deliveries: job.deliveries },
    });
    job = await NotificationOutbox.findById(job._id);
  }
  // Latest data after courier synchronization: tracking comes from Shipment.
  const shipment = await Shipment.findOne({ orderId: order._id })
    .select("tracking syncStatus")
    .lean();
  // Current WhatsApp number of the employee who created the order.
  const contact = await loadContact(order);
  let photos = null;
  let retryAfter = 0;
  let lastError = "";
  for (const [index, delivery] of job.deliveries.entries()) {
    if (delivery.status !== "PENDING") continue;
    try {
      await saveDelivery(job, index, {
        attempts: (delivery.attempts || 0) + 1,
      });
      if (!delivery.photosDone) {
        if ((order.images || []).length) {
          photos ??= await loadPhotos(order);
          // Images that could not be read/converted are skipped; the rest are
          // still sent and the gap is reported in the diagnostics.
          const unreadable = photos.failed
            ? `${photos.failed} of ${photos.total} images could not be prepared for Telegram.`
            : "";
          if (unreadable && index === 0)
            await recordAdminError(unreadable, delivery, job);
          if (photos.photos.length) {
            try {
              const ids = await sendPhotos(client, delivery, photos.photos);
              // Recorded before the summary is sent: a retry after this point
              // never resends the album.
              await saveDelivery(job, index, {
                photosDone: true,
                photoMessageIds: ids,
                ...(unreadable ? { lastError: unreadable } : {}),
              });
            } catch (error) {
              const failure = classifyTelegramFailure(error);
              // Chat-level and transient failures stop this destination; an
              // image-only rejection must not block the order summary.
              if (failure.destination || failure.retryable) throw failure;
              await saveDelivery(job, index, {
                photosDone: true,
                lastError: "Images could not be delivered to Telegram.",
              });
              await recordAdminError(
                `Images could not be delivered to Telegram: ${failure.message}`,
                delivery,
                job,
              );
            }
          } else
            await saveDelivery(job, index, {
              photosDone: true,
              ...(unreadable ? { lastError: unreadable } : {}),
            });
        } else await saveDelivery(job, index, { photosDone: true });
      }
      const message = await client.sendMessage({
        chatId: delivery.chatId,
        threadId: delivery.messageThreadId || undefined,
        text: orderSummary(order, shipment),
        keyboard: summaryKeyboard(order, shipment, contact),
      });
      await saveDelivery(job, index, {
        status: "SENT",
        summaryMessageId: message.message_id,
        sentAt: new Date(),
        lastErrorCode: "",
      });
    } catch (error) {
      if (error.leaseLost) return;
      const failure = classifyTelegramFailure(error);
      lastError = failure.message;
      if (failure.retryable) {
        retryAfter = Math.max(retryAfter, failure.retryAfter || 0);
        await saveDelivery(job, index, {
          lastError: failure.message,
          lastErrorCode: failure.code,
        });
      } else {
        await saveDelivery(job, index, {
          status: "FAILED",
          lastError: failure.message,
          lastErrorCode: failure.code,
        });
        await recordAdminError(failure.message, delivery, job);
      }
    }
  }
  const pending = job.deliveries.some((d) => d.status === "PENDING");
  const failed = job.deliveries.some((d) => d.status === "FAILED");
  if (pending && job.attempts < MAX_ATTEMPTS)
    return finishJob(job, {
      status: "PENDING",
      nextAttemptAt: backoff(job.attempts, retryAfter),
      lastError,
    });
  if (pending || failed) {
    if (pending)
      await recordAdminError(
        lastError || "Telegram notification retries exhausted.",
        null,
        job,
      );
    return finishJob(job, {
      status: "FAILED",
      lastError: lastError || "One or more destinations failed.",
    });
  }
  return finishJob(job, { status: "SENT", lastError: "" });
}
