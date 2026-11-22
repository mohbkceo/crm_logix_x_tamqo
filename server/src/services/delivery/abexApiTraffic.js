import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AbexApiTraffic } from "../../models/abexApiTraffic.js";
import { abexError } from "./abexErrors.js";

export const backgroundIntervalMs = (env = process.env) => {
  const seconds = Number(env.ABEX_WEBHOOK_REQUEST_INTERVAL_SECONDS || 15);
  return (
    (Number.isInteger(seconds) && seconds >= 5 && seconds <= 30
      ? seconds
      : 15) * 1000
  );
};

export function retryAfterDate(value, now = Date.now()) {
  const seconds =
    typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  const parsed =
    Number.isFinite(seconds) && seconds >= 0
      ? now + seconds * 1000
      : Date.parse(value);
  return new Date(
    Math.max(
      now + 1000,
      Number.isFinite(parsed)
        ? Math.min(parsed, now + 7 * 86400000)
        : now + 60000,
    ),
  );
}

function deferred(until) {
  const error = new Error("Background ABEX read deferred.");
  error.code = "ABEX_BACKGROUND_DEFERRED";
  error.retryAt = until;
  return error;
}

export function abexTrafficPolicy(credentials, { background = false } = {}) {
  const key = createHash("sha256")
    .update(JSON.stringify([credentials.tenantId, credentials.apiKey]))
    .digest("hex");
  const ready = async () => {
    await AbexApiTraffic.updateOne(
      { _id: key },
      {
        $setOnInsert: {
          foregroundUntil: new Date(0),
          nextBackgroundAt: new Date(0),
          cooldownUntil: new Date(0),
        },
      },
      { upsert: true },
    ).catch((error) => {
      if (error.code !== 11000) throw error;
    });
  };
  return {
    background,
    async beforeRequest() {
      await ready();
      // Allow short spacing waits within one refresh, but never wait through
      // active order intake or a provider cooldown. Those go back to the inbox.
      const deadline = Date.now() + Math.min(backgroundIntervalMs(), 30000);
      while (true) {
        const now = new Date();
        if (!background) {
          const row = await AbexApiTraffic.findOneAndUpdate(
            { _id: key },
            {
              $max: { foregroundUntil: new Date(+now + 30000) },
            },
            { new: true },
          ).lean();
          if (row.cooldownUntil > now) {
            const error = abexError("ABEX_RATE_LIMIT");
            error.retryAt = row.cooldownUntil;
            throw error;
          }
          return;
        }
        const slot = await AbexApiTraffic.findOneAndUpdate(
          {
            _id: key,
            foregroundUntil: { $lte: now },
            cooldownUntil: { $lte: now },
            nextBackgroundAt: { $lte: now },
          },
          {
            $set: { nextBackgroundAt: new Date(+now + backgroundIntervalMs()) },
          },
          { new: true },
        ).lean();
        if (slot) return;
        const row = await AbexApiTraffic.findById(key).lean();
        const next = Math.max(
          +row.foregroundUntil,
          +row.cooldownUntil,
          +row.nextBackgroundAt,
          Date.now() + 50,
        );
        if (
          row.foregroundUntil > now ||
          row.cooldownUntil > now ||
          next > deadline
        )
          throw deferred(new Date(next));
        await delay(Math.max(1, next - Date.now()));
      }
    },
    async rateLimited(until) {
      await ready();
      await AbexApiTraffic.updateOne(
        { _id: key },
        {
          $max: { cooldownUntil: until },
          $set: { lastRateLimitAt: new Date() },
        },
      );
    },
  };
}
