import mongoose from "mongoose";
import { actorSchema } from "./security.js";
const { Schema } = mongoose;
export const DeliveryAgency = mongoose.model(
  "DeliveryAgency",
  new Schema(
    {
      name: { type: String, required: true },
      code: { type: String, required: true, unique: true },
      active: { type: Boolean, default: true, index: true },
      businesses: {
        type: [{ type: String, enum: ["LOGIX", "TAMQO"] }],
        validate: (v) => v.length > 0,
        index: true,
      },
      integrationType: {
        type: String,
        enum: ["API", "MANUAL"],
        required: true,
      },
      apiProvider: { type: String, enum: ["PROCOLIS", "MANUAL"], index: true },
      config: { baseUrl: String, notes: String },
      encryptedCredentials: { type: String, select: false },
      credentialsConfigured: { type: Boolean, default: false },
      capabilities: {
        createShipment: Boolean,
        tracking: Boolean,
        readyToShip: Boolean,
        pricing: Boolean,
      },
      createdBy: actorSchema,
    },
    { timestamps: true, optimisticConcurrency: true },
  ),
);
const rate = new Schema(
  {
    agencyId: {
      type: Schema.Types.ObjectId,
      ref: "DeliveryAgency",
      required: true,
    },
    wilayaId: { type: Schema.Types.ObjectId, ref: "Wilaya", required: true },
    homePrice: { type: Number, min: 0, required: true },
    deskPrice: { type: Number, min: 0, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
rate.index({ agencyId: 1, wilayaId: 1 }, { unique: true });
export const DeliveryRate = mongoose.model("DeliveryRate", rate);

const syncCounters = {
  scanned: { type: Number, default: 0, min: 0 },
  eligible: { type: Number, default: 0, min: 0 },
  attempted: { type: Number, default: 0, min: 0 },
  successful: { type: Number, default: 0, min: 0 },
  failed: { type: Number, default: 0, min: 0 },
  changed: { type: Number, default: 0, min: 0 },
  unchanged: { type: Number, default: 0, min: 0 },
  skipped: { type: Number, default: 0, min: 0 },
  terminalReached: { type: Number, default: 0, min: 0 },
  unknownStatuses: { type: Number, default: 0, min: 0 },
};
const syncRunSchema = new Schema(
  {
    trigger: {
      type: String,
      enum: ["CRON", "MANUAL", "STARTUP"],
      required: true,
      index: true,
    },
    startedAt: { type: Date, required: true, index: true },
    finishedAt: Date,
    durationMs: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ["RUNNING", "COMPLETED", "PARTIAL", "FAILED"],
      default: "RUNNING",
      index: true,
    },
    ...syncCounters,
  },
  { timestamps: true },
);
syncRunSchema.index({ startedAt: -1, _id: -1 });
export const DeliverySyncRun = mongoose.model("DeliverySyncRun", syncRunSchema);

const syncItemSchema = new Schema(
  {
    runId: {
      type: Schema.Types.ObjectId,
      ref: "DeliverySyncRun",
      required: true,
      index: true,
    },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    orderNumber: String,
    shipmentId: {
      type: Schema.Types.ObjectId,
      ref: "Shipment",
      required: true,
    },
    tracking: { type: String, maxlength: 150 },
    agencyId: { type: Schema.Types.ObjectId, ref: "DeliveryAgency" },
    agencyName: String,
    beforeProviderStatus: String,
    afterProviderStatus: String,
    beforeOrderStatus: String,
    afterOrderStatus: String,
    changed: { type: Boolean, default: false },
    terminalReached: { type: Boolean, default: false },
    result: {
      type: String,
      enum: ["SUCCESS", "UNCHANGED", "ERROR", "UNKNOWN_STATUS", "SKIPPED"],
      required: true,
      index: true,
    },
    error: { type: String, maxlength: 5000 },
    durationMs: { type: Number, default: 0, min: 0 },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false },
);
syncItemSchema.index({ runId: 1, createdAt: 1 });
syncItemSchema.index({ orderId: 1, createdAt: -1 });
export const DeliverySyncItem = mongoose.model(
  "DeliverySyncItem",
  syncItemSchema,
);

export const DeliverySyncLock = mongoose.model(
  "DeliverySyncLock",
  new Schema(
    {
      _id: { type: String, default: "delivery-status-sync" },
      owner: { type: String, required: true },
      runId: { type: Schema.Types.ObjectId, ref: "DeliverySyncRun" },
      expiresAt: { type: Date, required: true, index: true },
    },
    { timestamps: true },
  ),
);
