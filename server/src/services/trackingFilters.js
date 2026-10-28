import { z } from "zod";
import {
  QUICK_TAGS,
  defaultTrackingFilters,
} from "../../../shared/trackingFilters.js";
import { PRODUCTION_STAGES, COURIER_STAGES } from "../../../shared/tracking.js";
import { dayStart } from "../domain/period.js";
import { assert } from "../errors.js";
const DAY = 86400000;
export const COMPLETED_TRACKING_STATUSES = [
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
];
const tagValues = QUICK_TAGS.map((t) => t.value);
const queryInput = z
  .object({
    view: z.enum(["default", "custom"]).optional(),
    search: z.string().max(200).optional(),
    stage: z.enum([...PRODUCTION_STAGES, "LEGACY_UNINITIALIZED"]).optional(),
    courierStatus: z.string().max(100).optional(),
    issue: z.enum(["OPEN", "BLOCKING", "NONE"]).optional(),
    employee: z.string().optional(),
    business: z.enum(["LOGIX_ONLY", "PARTNERSHIP"]).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    page: z.coerce.number().optional(),
    limit: z.coerce.number().optional(),
    sort: z.enum(["oldest", "newest", "issuesFirst"]).optional(),
    lifecycle: z.enum(["ALL", "ACTIVE", "COMPLETED"]).optional(),
    attention: z.enum(["all", "internal"]).optional(),
    tags: z.string().max(150).optional().default(""),
  })
  .strict();
export function parseTrackingFilters(user, query) {
  const input = queryInput.parse(query);
  const tags = input.tags ? input.tags.split(",") : [];
  assert(
    tags.every((t) => tagValues.includes(t)) &&
      new Set(tags).size === tags.length,
    "Invalid quick filter tags",
  );
  assert(
    !input.from || !input.to || input.from <= input.to,
    "Created from must precede created through",
  );
  return {
    ...(input.view === "custom" ? {} : defaultTrackingFilters(user)),
    ...input,
  };
}
export function lifecycleFilter(q) {
  return q.lifecycle === "ACTIVE"
    ? { status: { $nin: COMPLETED_TRACKING_STATUSES } }
    : q.lifecycle === "COMPLETED"
      ? { status: { $in: COMPLETED_TRACKING_STATUSES } }
      : {};
}
export const internalQueueFilter = {
  "tracking.courierOwned": { $ne: true },
  status: { $nin: COURIER_STAGES },
  "parcel.status": { $nin: COURIER_STAGES },
};
export function quickTagFilters(user, now) {
  return {
    IMPORTANT: { "tracking.important": true },
    NEW: { createdAt: { $gte: new Date(+now - DAY), $lte: now } },
    LT4D: { createdAt: { $gt: new Date(+now - 4 * DAY), $lte: now } },
    GTE4D: { createdAt: { $lte: new Date(+now - 4 * DAY) } },
    ISSUES: { "tracking.openIssues": { $gt: 0 } },
    BLOCKED: { "tracking.blockingIssues": { $gt: 0 } },
    NO_ISSUES: {
      $or: [
        { "tracking.openIssues": 0 },
        { "tracking.openIssues": { $exists: false } },
      ],
    },
    MY_ORDERS: {
      $or: [
        { "tracking.designerId": user._id },
        { "tracking.productionId": user._id },
      ],
    },
    TODAY: {
      createdAt: { $gte: dayStart(now), $lt: new Date(+dayStart(now) + DAY) },
    },
  };
}
export function tagCategories(q) {
  const groups = {};
  for (const value of (q.tags || "").split(",").filter(Boolean)) {
    const category = QUICK_TAGS.find((t) => t.value === value).category;
    (groups[category] ||= []).push(value);
  }
  if (q.issue)
    (groups.issue ||= []).push(
      { OPEN: "ISSUES", BLOCKING: "BLOCKED", NONE: "NO_ISSUES" }[q.issue],
    );
  return groups;
}
export function matchTagCategories(groups, predicates, except) {
  const clauses = Object.entries(groups)
    .filter(([category]) => category !== except)
    .map(([, values]) => ({
      $or: [...new Set(values)].map((value) => predicates[value]),
    }));
  return clauses.length ? { $and: clauses } : {};
}
