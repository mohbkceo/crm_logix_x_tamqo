import mongoose from "mongoose";
import { actorSchema } from "./security.js";
import { BUSINESS_TYPES } from "../constants.js";
const { Schema } = mongoose;

export const NOTIFICATION_EVENTS = ["ORDER_CREATED"];
const DAY = 86400000;

const destinationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    // Telegram chat IDs exceed 2^53 for some supergroups; never store as Number.
    chatId: { type: String, required: true, maxlength: 32 },
    messageThreadId: { type: Number, default: null },
    businessTypes: [{ type: String, enum: BUSINESS_TYPES }],
    enabled: { type: Boolean, default: true },
    chatTitle: { type: String, maxlength: 255 },
    lastTestAt: Date,
    lastTestOk: Boolean,
    lastError: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);

// Singleton. The bot token and webhook secret never leave the server: the token
// is AES-256-GCM encrypted with the delivery credential key and the webhook
// secret is stored only as a SHA-256 digest.
export const TelegramSetting = mongoose.model(
  "TelegramSetting",
  new Schema(
    {
      _id: { type: String, default: "telegram" },
      enabled: { type: Boolean, default: false },
      encryptedToken: { type: String, select: false },
      webhookSecretHash: { type: String, select: false },
      botId: String,
      botUsername: String,
      botName: String,
      connectedAt: Date,
      webhookUrl: String,
      webhookConfiguredAt: Date,
      webhookError: { type: String, maxlength: 500 },
      lastConnectionTestAt: Date,
      lastConnectionTestOk: Boolean,
      lastNotificationError: {
        at: Date,
        message: { type: String, maxlength: 500 },
        destinationName: String,
        orderNumber: String,
      },
      events: {
        ORDER_CREATED: { type: Boolean, default: true },
      },
      destinations: { type: [destinationSchema], default: [] },
      updatedBy: actorSchema,
    },
    { timestamps: true, optimisticConcurrency: true },
  ),
);

const deliverySchema = new Schema(
  {
    destinationId: { type: String, required: true },
    destinationName: String,
    chatId: { type: String, required: true },
    messageThreadId: { type: Number, default: null },
    // PENDING -> SENT, or FAILED for permanent destination errors.
    status: {
      type: String,
      enum: ["PENDING", "SENT", "FAILED"],
      default: "PENDING",
    },
    photosDone: { type: Boolean, default: false },
    photoMessageIds: [Number],
    summaryMessageId: Number,
    attempts: { type: Number, default: 0 },
    lastError: { type: String, maxlength: 500 },
    lastErrorCode: String,
    sentAt: Date,
  },
  { _id: false },
);

// Durable notification outbox. Jobs are created in the order transaction and
// start WAITING until the creation flow has finished courier synchronization
// (and optional image uploads); a stale WAITING job is released by the worker.
const outboxSchema = new Schema(
  {
    eventKey: { type: String, required: true, unique: true },
    eventType: { type: String, enum: NOTIFICATION_EVENTS, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    orderNumber: String,
    status: {
      type: String,
      enum: ["WAITING", "PENDING", "PROCESSING", "SENT", "FAILED", "SKIPPED"],
      default: "WAITING",
    },
    waitUntil: Date,
    expectedImages: { type: Number, default: 0, min: 0, max: 6 },
    creationSettledAt: Date,
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lockedUntil: Date,
    lockToken: String,
    deliveries: { type: [deliverySchema], default: [] },
    lastError: { type: String, maxlength: 500 },
    skipReason: String,
    completedAt: Date,
    // Only terminal successes expire. Failed jobs stay for inspection/retry.
    expiresAt: Date,
  },
  { timestamps: true },
);
outboxSchema.index({ status: 1, nextAttemptAt: 1 });
outboxSchema.index({ status: 1, waitUntil: 1 });
outboxSchema.index({ orderId: 1 });
outboxSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const NotificationOutbox = mongoose.model(
  "NotificationOutbox",
  outboxSchema,
);
export const terminalOutboxExpiry = () => new Date(Date.now() + 30 * DAY);

// Webhook inbox: Telegram is acknowledged immediately; processing happens in
// the worker. update_id uniqueness deduplicates redeliveries.
const updateSchema = new Schema(
  {
    updateId: { type: Number, required: true, unique: true },
    kind: { type: String, enum: ["message", "callback_query", "other"] },
    payload: Schema.Types.Mixed,
    status: {
      type: String,
      enum: ["RECEIVED", "PROCESSING", "DONE", "FAILED"],
      default: "RECEIVED",
    },
    attempts: { type: Number, default: 0 },
    lockedUntil: Date,
    lastErrorCode: String,
    processedAt: Date,
    expiresAt: { type: Date, default: () => new Date(Date.now() + 7 * DAY) },
  },
  { timestamps: true },
);
updateSchema.index({ status: 1, createdAt: 1 });
updateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const TelegramUpdate = mongoose.model("TelegramUpdate", updateSchema);

// Single-use account link codes; only a SHA-256 digest of the code is stored.
const linkSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    codeHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);
linkSchema.index({ userId: 1 });
// Keep expired rows briefly for audit clarity, then let MongoDB remove them.
linkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
export const TelegramLinkCode = mongoose.model("TelegramLinkCode", linkSchema);
