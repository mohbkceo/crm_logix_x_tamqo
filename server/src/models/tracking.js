import mongoose from "mongoose";
import { actorSchema } from "./security.js";
import {
  OPERATIONAL_ROLES,
  SEVERITIES,
  PRODUCTION_STAGES,
} from "../../../shared/tracking.js";
const { Schema } = mongoose;
export const trackingSchema = new Schema(
  {
    stage: {
      type: String,
      enum: [...PRODUCTION_STAGES, "LEGACY_UNINITIALIZED"],
      required: true,
    },
    stageEnteredAt: Date,
    initializedAt: Date,
    courierOwned: { type: Boolean, default: false },
    designerId: { type: Schema.Types.ObjectId, ref: "User" },
    productionId: { type: Schema.Types.ObjectId, ref: "User" },
    openIssues: { type: Number, default: 0 },
    blockingIssues: { type: Number, default: 0 },
    criticalIssues: { type: Number, default: 0 },
    important: { type: Boolean, default: false },
    importantUpdatedBy: actorSchema,
    importantUpdatedAt: Date,
  },
  { _id: false },
);
export const imageSchema = new Schema({
  // Retained for historical files and migration rollback; new uploads have no key.
  key: String,
  public_id: String,
  secure_url: String,
  resource_type: { type: String, enum: ["image"] },
  type: { type: String, enum: ["authenticated"] },
  version: Number,
  format: String,
  sha256: String,
  migratedAt: Date,
  mime: String,
  size: Number,
  width: Number,
  height: Number,
  uploadedBy: actorSchema,
  uploadedAt: Date,
});
const typeFields = {
  label: { type: String, required: true, maxlength: 100 },
  description: { type: String, default: "", maxlength: 500 },
  defaultSeverity: { type: String, enum: SEVERITIES, default: "INFO" },
  blocksProduction: { type: Boolean, default: false },
  responsibleTeam: {
    type: String,
    enum: [...OPERATIONAL_ROLES, ""],
    default: "",
  },
  indicator: {
    type: String,
    enum: ["INFO", "FLAG", "ATTENTION"],
    default: "INFO",
  },
};
export const IssueType = mongoose.model(
  "TrackingIssueType",
  new Schema(
    {
      ...typeFields,
      code: { type: String, unique: true, sparse: true },
      enabled: { type: Boolean, default: true },
      sortOrder: { type: Number, default: 0 },
    },
    { timestamps: true, optimisticConcurrency: true },
  ),
);
const issueSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    typeId: {
      type: Schema.Types.ObjectId,
      ref: "TrackingIssueType",
      required: true,
    },
    typeSnapshot: new Schema(typeFields, { _id: false }),
    severity: { type: String, enum: SEVERITIES, required: true },
    blocking: { type: Boolean, required: true },
    description: { type: String, maxlength: 2000, default: "" },
    attachments: { type: [imageSchema], default: [] },
    reporter: { type: actorSchema, required: true },
    reporterRoles: [{ type: String, enum: OPERATIONAL_ROLES }],
    status: { type: String, enum: ["OPEN", "RESOLVED"], default: "OPEN" },
    resolvedBy: actorSchema,
    resolvedAt: Date,
    requestId: { type: String, required: true },
  },
  { timestamps: true, optimisticConcurrency: true },
);
issueSchema.index({ orderId: 1, requestId: 1 }, { unique: true });
issueSchema.index({ orderId: 1, status: 1, createdAt: -1 });
issueSchema.index({ "attachments.public_id": 1 }, { sparse: true });
export const TrackingIssue = mongoose.model("TrackingIssue", issueSchema);
const eventSchema = new Schema({
  orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
  kind: { type: String, required: true },
  previousStage: String,
  newStage: String,
  actor: actorSchema,
  at: { type: Date, default: Date.now },
  source: { type: String, default: "TRACKING" },
  revision: { type: Number, required: true },
  data: Schema.Types.Mixed,
});
eventSchema.index({ orderId: 1, revision: 1 }, { unique: true });
export const TrackingEvent = mongoose.model("TrackingEvent", eventSchema);
export const TrackingSetting = mongoose.model(
  "TrackingSetting",
  new Schema(
    {
      _id: { type: String, default: "tracking" },
      requireWhatsApp: { type: Boolean, default: false },
      fallbackContactId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      operationalRoles: {
        type: [
          new Schema(
            {
              code: { type: String, enum: OPERATIONAL_ROLES },
              label: String,
              enabled: Boolean,
            },
            { _id: false },
          ),
        ],
        default: () =>
          OPERATIONAL_ROLES.map((code) => ({
            code,
            label: code.replaceAll("_", " "),
            enabled: true,
          })),
      },
    },
    { timestamps: true, optimisticConcurrency: true },
  ),
);
