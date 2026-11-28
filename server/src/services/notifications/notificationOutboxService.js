import { randomUUID } from "node:crypto";
import {
  NotificationOutbox,
  TelegramSetting,
  terminalOutboxExpiry,
} from "../../models/telegram.js";
import { Order } from "../../models/index.js";

export const CRASH_RECOVERY_MS = 10 * 60000; // creation flow never released the job
export const IMAGE_GRACE_MS = 2 * 60000; // optional uploads after order creation
export const LOCK_MS = 3 * 60000;
export const MAX_ATTEMPTS = 8;

export const orderCreatedKey = (orderId) => `ORDER_CREATED:${orderId}`;

// Called inside the order creation transaction: the job exists only if the
// order commits, and the unique eventKey prevents duplicates.
export async function enqueueOrderCreated(
  order,
  session,
  { expectedImages = 0 } = {},
) {
  const setting = await TelegramSetting.findById("telegram")
    .select("enabled events")
    .session(session)
    .lean();
  if (!setting?.enabled || setting.events?.ORDER_CREATED === false) return null;
  const [job] = await NotificationOutbox.create(
    [
      {
        eventKey: orderCreatedKey(order._id),
        eventType: "ORDER_CREATED",
        orderId: order._id,
        orderNumber: order.orderNumber,
        status: "WAITING",
        expectedImages: Math.max(0, Math.min(6, Number(expectedImages) || 0)),
        waitUntil: new Date(Date.now() + CRASH_RECOVERY_MS),
      },
    ],
    { session },
  );
  return job;
}

// Called after courier synchronization in the creation request. Never throws:
// a notification problem must not affect the committed order response.
export async function releaseOrderCreated(orderId) {
  try {
    const job = await NotificationOutbox.findOne({
      eventKey: orderCreatedKey(orderId),
      status: "WAITING",
    }).lean();
    if (!job) return;
    const now = new Date();
    const imagesReady =
      job.expectedImages === 0 ||
      (await imageCount(orderId)) >= job.expectedImages;
    await NotificationOutbox.updateOne(
      { _id: job._id, status: "WAITING" },
      imagesReady
        ? {
            $set: {
              status: "PENDING",
              creationSettledAt: now,
              nextAttemptAt: now,
            },
            $unset: { waitUntil: 1 },
          }
        : {
            $set: {
              creationSettledAt: now,
              waitUntil: new Date(+now + IMAGE_GRACE_MS),
            },
          },
    );
  } catch {
    /* The worker releases stale WAITING jobs. */
  }
}

async function imageCount(orderId) {
  const order = await Order.findById(orderId).select("images._id").lean();
  return order?.images?.length || 0;
}

// Called after an image upload commits. Releases as soon as the expected
// uploads have arrived, so the album is complete without waiting for grace.
export async function orderImagesChanged(orderId) {
  try {
    const job = await NotificationOutbox.findOne({
      eventKey: orderCreatedKey(orderId),
      status: "WAITING",
      creationSettledAt: { $exists: true },
    }).lean();
    if (!job) return;
    if ((await imageCount(orderId)) < job.expectedImages) {
      // Uploads are still arriving: keep waiting while progress is made so a
      // slow connection does not send a partial album.
      await NotificationOutbox.updateOne(
        { _id: job._id, status: "WAITING" },
        { $set: { waitUntil: new Date(Date.now() + IMAGE_GRACE_MS) } },
      );
      return;
    }
    await NotificationOutbox.updateOne(
      { _id: job._id, status: "WAITING" },
      {
        $set: { status: "PENDING", nextAttemptAt: new Date() },
        $unset: { waitUntil: 1 },
      },
    );
  } catch {
    /* Grace expiry releases the job. */
  }
}

// Called when the client finished its post-creation upload sequence with some
// failures: the announced count will never be reached, so the job is sent now
// with every image that was saved instead of waiting for the grace period.
// Only releases after creation settled (courier synchronization finished).
export async function orderUploadsComplete(orderId) {
  try {
    await NotificationOutbox.updateOne(
      {
        eventKey: orderCreatedKey(orderId),
        status: "WAITING",
        creationSettledAt: { $exists: true },
      },
      {
        $set: { status: "PENDING", nextAttemptAt: new Date() },
        $unset: { waitUntil: 1 },
      },
    );
  } catch {
    /* Grace expiry releases the job. */
  }
}

export async function releaseStaleWaiting(now = new Date()) {
  return NotificationOutbox.updateMany(
    { status: "WAITING", waitUntil: { $lte: now } },
    {
      $set: { status: "PENDING", nextAttemptAt: new Date() },
      $unset: { waitUntil: 1 },
    },
  );
}

// Atomic claim with a fenced lease. PROCESSING jobs whose lease expired (crash)
// are reclaimed.
export async function claimJob(now = new Date()) {
  const lockToken = randomUUID();
  return NotificationOutbox.findOneAndUpdate(
    {
      $or: [
        { status: "PENDING", nextAttemptAt: { $lte: now } },
        { status: "PROCESSING", lockedUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        status: "PROCESSING",
        lockToken,
        lockedUntil: new Date(+now + LOCK_MS),
      },
      $inc: { attempts: 1 },
    },
    { sort: { nextAttemptAt: 1 }, new: true },
  );
}

export const fence = (job) => ({
  _id: job._id,
  lockToken: job.lockToken,
  status: "PROCESSING",
});

export async function finishJob(job, values) {
  const terminal = ["SENT", "SKIPPED"].includes(values.status);
  return NotificationOutbox.updateOne(fence(job), {
    $set: {
      ...values,
      ...(terminal || values.status === "FAILED"
        ? { completedAt: new Date() }
        : {}),
      ...(terminal ? { expiresAt: terminalOutboxExpiry() } : {}),
    },
    $unset: { lockToken: 1, lockedUntil: 1 },
  });
}

// Administrator retry: re-opens permanently failed destinations as well.
export async function retryJob(id) {
  const job = await NotificationOutbox.findOne({
    _id: id,
    status: { $in: ["FAILED", "SKIPPED"] },
  });
  if (!job) return null;
  for (const delivery of job.deliveries)
    if (delivery.status === "FAILED") {
      delivery.status = "PENDING";
      delivery.attempts = 0;
    }
  job.status = "PENDING";
  job.attempts = 0;
  job.nextAttemptAt = new Date();
  job.lastError = undefined;
  job.skipReason = undefined;
  job.expiresAt = undefined;
  if (
    !job.deliveries.length ||
    job.deliveries.every((d) => d.status === "SENT")
  )
    job.deliveries = [];
  await job.save();
  return job;
}
