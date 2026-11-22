import mongoose from "mongoose";

// One row per credential scope, shared by every API process. No credentials
// are stored here; the key is a one-way digest computed inside providerFor.
export const AbexApiTraffic = mongoose.model(
  "AbexApiTraffic",
  new mongoose.Schema(
    {
      _id: String,
      foregroundUntil: Date,
      nextBackgroundAt: Date,
      cooldownUntil: Date,
      lastRateLimitAt: Date,
    },
    { bufferCommands: false, writeConcern: { w: "majority", wtimeout: 5000 } },
  ),
);
