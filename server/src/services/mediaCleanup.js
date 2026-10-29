import { Order } from "../models/index.js";
import { TrackingIssue } from "../models/tracking.js";
import { MediaCleanup } from "../models/media.js";
import { cloudinaryStorage } from "./cloudinaryStorage.js";

export async function queueMediaCleanup(image, session) {
  if (!image?.public_id) return; // Legacy files remain available for rollback.
  await MediaCleanup.updateOne(
    { public_id: image.public_id },
    { $setOnInsert: { notBefore: new Date() } },
    { upsert: true, session },
  );
}
export async function hasMediaReference(public_id) {
  // Deliberately includes soft-deleted orders and resolved/historical reports.
  return Boolean(
    (await Order.exists({ "images.public_id": public_id })) ||
    (await TrackingIssue.exists({ "attachments.public_id": public_id })),
  );
}
export async function cleanupMedia({ limit = 50, now = new Date() } = {}) {
  const result = { deleted: 0, referenced: 0, failed: 0 };
  for (let i = 0; i < limit; i++) {
    const job = await MediaCleanup.findOneAndUpdate(
      {
        notBefore: { $lte: now },
        $or: [
          { lockedUntil: { $exists: false } },
          { lockedUntil: { $lte: now } },
        ],
      },
      { $set: { lockedUntil: new Date(Date.now() + 300000) } },
      { new: true, sort: { notBefore: 1 } },
    );
    if (!job) break;
    try {
      if (await hasMediaReference(job.public_id)) {
        result.referenced++;
        // Keep shared-asset jobs until all references are removed.
        await MediaCleanup.updateOne(
          { _id: job._id },
          {
            $set: { notBefore: new Date(Date.now() + 86400000) },
            $unset: { lockedUntil: 1 },
          },
        );
      } else {
        await cloudinaryStorage.remove(job.public_id);
        await MediaCleanup.deleteOne({ _id: job._id });
        result.deleted++;
      }
    } catch {
      result.failed++;
      await MediaCleanup.updateOne(
        { _id: job._id },
        {
          $inc: { attempts: 1 },
          $set: { notBefore: new Date(Date.now() + 3600000) },
          $unset: { lockedUntil: 1 },
        },
      );
    }
  }
  return result;
}
export function startMediaCleanupScheduler() {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await cleanupMedia();
      if (result.failed)
        console.warn(
          `Image cleanup: ${result.failed} asset(s) deferred for retry.`,
        );
    } catch {
      console.warn("Image cleanup unavailable; pending work retained.");
    } finally {
      busy = false;
    }
  }, 60000);
  timer.unref();
  return timer;
}
