import mongoose from "mongoose";
const { Schema } = mongoose;

export const WEBHOOK_STATUSES = [
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "RETRY_PENDING",
  "IGNORED",
  "FAILED",
];
const schema = new Schema(
  {
    provider: { type: String, enum: ["ABEX"], required: true },
    destinationId: { type: String, required: true },
    eventId: { type: String, required: true, maxlength: 200 },
    eventType: { type: String, required: true, maxlength: 100 },
    contractVersion: { type: String, required: true, maxlength: 100 },
    receivedAt: { type: Date, required: true },
    // Signed transport timestamp; not claimed to be the parcel's update time.
    providerTimestamp: { type: Date, required: true },
    // Signed event occurrence time for inspection; parcel ordering still uses
    // the freshly fetched providerUpdatedAt, never this notification timestamp.
    eventOccurredAt: Date,
    processingStatus: {
      type: String,
      enum: WEBHOOK_STATUSES,
      default: "RECEIVED",
      required: true,
    },
    processedAt: Date,
    lastAttemptAt: Date,
    attemptCount: { type: Number, default: 0 },
    retryCount: { type: Number, default: 0 },
    recoveryCount: { type: Number, default: 0 },
    nextRetryAt: Date,
    lockedUntil: Date,
    lockToken: { type: String, select: false },
    lastErrorCode: { type: String, maxlength: 100 },
    lastErrorMessage: { type: String, maxlength: 500 },
    resultCode: { type: String, maxlength: 100 },
    agencyId: { type: Schema.Types.ObjectId, ref: "DeliveryAgency" },
    // Preserve the reception scope if an agency is later reassigned.
    agencyBusinesses: [{ type: String, enum: ["LOGIX", "TAMQO"] }],
    orderId: { type: Schema.Types.ObjectId, ref: "Order" },
    orderNumber: { type: String, maxlength: 100 },
    shipmentId: { type: Schema.Types.ObjectId, ref: "Shipment" },
    trackingNumber: { type: String, maxlength: 150 },
    // Only validated identifiers from a verified contract. No raw payload/PII.
    notification: new Schema(
      { parcelId: String, trackingNumber: String },
      { _id: false },
    ),
    payloadMetadata: { byteLength: Number, topLevelFieldCount: Number },
    payloadHash: { type: String, required: true, minlength: 64, maxlength: 64 },
    // Terminal rows expire; active/retry rows are kept until processed/reviewed.
    expiresAt: Date,
  },
  { timestamps: true, bufferCommands: false },
);
schema.index({ provider: 1, destinationId: 1, eventId: 1 }, { unique: true });
schema.index({
  destinationId: 1,
  processingStatus: 1,
  nextRetryAt: 1,
  lockedUntil: 1,
});
schema.index({ receivedAt: -1, _id: -1 });
schema.index({ agencyId: 1, receivedAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const DeliveryWebhookEvent = mongoose.model(
  "DeliveryWebhookEvent",
  schema,
);

export const DeliveryWebhookWorker = mongoose.model(
  "DeliveryWebhookWorker",
  new Schema(
    {
      _id: String,
      lastTickAt: Date,
      lastSuccessAt: Date,
      lastErrorAt: Date,
      lastErrorCode: String,
    },
    { bufferCommands: false },
  ),
);

export async function ensureWebhookIndexes() {
  // Explicitly await unique/TTL indexes before opening the public listener,
  // including deployments with Mongoose autoIndex disabled.
  await DeliveryWebhookEvent.createIndexes();
}
