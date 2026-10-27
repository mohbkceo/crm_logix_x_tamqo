import { Order } from "../models/index.js";
import {
  IssueType,
  TrackingSetting,
  TrackingIssue,
  TrackingEvent,
} from "../models/tracking.js";
// No commercial statuses, money, shipments, notes or historical dates are changed.
export async function migrateTracking() {
  await Promise.all([
    IssueType.init(),
    TrackingSetting.init(),
    TrackingIssue.init(),
    TrackingEvent.init(),
  ]);
  await IssueType.updateOne(
    { code: "OTHER" },
    {
      $setOnInsert: {
        label: "Other",
        defaultSeverity: "INFO",
        blocksProduction: false,
        enabled: true,
        sortOrder: 100,
      },
    },
    { upsert: true },
  );
  await TrackingSetting.updateOne(
    { _id: "tracking" },
    { $setOnInsert: { requireWhatsApp: false } },
    { upsert: true },
  );
  // Unknown historical work stays neutral. No inferred completion dates or assignments.
  await Order.updateMany(
    {
      deletedAt: { $exists: false },
      items: { $elemMatch: { business: "LOGIX", type: "PRODUCT" } },
      tracking: { $exists: false },
    },
    {
      $set: {
        tracking: {
          stage: "LEGACY_UNINITIALIZED",
          openIssues: 0,
          blockingIssues: 0,
          courierOwned: false,
        },
      },
    },
    { timestamps: false },
  );
}
