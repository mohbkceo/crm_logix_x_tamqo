import mongoose from "mongoose";

// Durable outbox: created before the remote upload, or in the same transaction
// that removes its last known reference. Never use a TTL index for this queue.
export const MediaCleanup = mongoose.model(
  "MediaCleanup",
  new mongoose.Schema(
    {
      public_id: { type: String, required: true, unique: true },
      notBefore: { type: Date, required: true, index: true },
      lockedUntil: Date,
      attempts: { type: Number, default: 0 },
    },
    { timestamps: true },
  ),
);
