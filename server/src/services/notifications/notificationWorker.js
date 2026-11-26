import { claimJob, releaseStaleWaiting } from "./notificationOutboxService.js";
import { processOrderCreatedJob } from "./telegram/telegramOrderNotifier.js";
import { runUpdateBatch } from "./telegram/telegramWebhook.js";

const POLL_MS = Math.max(
  1000,
  Number(process.env.NOTIFICATION_WORKER_INTERVAL_MS) || 3000,
);
// Future events (ORDER_CONFIRMED, SHIPMENT_FAILED, ...) register a processor here.
const PROCESSORS = { ORDER_CREATED: processOrderCreatedJob };

export async function runNotificationBatch({
  limit = 10,
  now = new Date(),
} = {}) {
  await releaseStaleWaiting(now);
  let processed = 0;
  for (; processed < limit; processed++) {
    const job = await claimJob(new Date());
    if (!job) break;
    const processor = PROCESSORS[job.eventType];
    if (processor) await processor(job);
  }
  return processed;
}

// One in-process loop for outbound notifications and inbound webhook updates.
// Atomic claims and leases make multiple app instances safe without Redis.
export function startNotificationWorker() {
  let timer,
    stopped = false,
    busy = false,
    again = false,
    running = Promise.resolve();
  const schedule = (ms) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = tick();
    }, ms);
    timer.unref();
  };
  const tick = async () => {
    busy = true;
    try {
      await runUpdateBatch();
      await runNotificationBatch();
    } catch {
      // Never log Telegram request objects: their URL contains the bot token.
      console.error("[TELEGRAM] Notification worker dependency unavailable.");
    } finally {
      busy = false;
      const immediate = again;
      again = false;
      schedule(immediate ? 0 : POLL_MS);
    }
  };
  running = tick();
  return {
    // Webhook acceptance nudges the loop so commands respond promptly.
    wake() {
      if (stopped) return;
      if (busy) again = true;
      else schedule(0);
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
