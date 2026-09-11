import { deliveryService } from "./deliveryService.js";

export const DEFAULT_DELIVERY_SYNC_INTERVAL_MS = 900000;
const disabledValues = new Set(["0", "false", "off", "disabled"]);
const state = {
  enabled: true,
  intervalMs: DEFAULT_DELIVERY_SYNC_INTERVAL_MS,
  nextRunAt: null,
  startedAt: null,
};

export function deliverySyncSettings(env = process.env) {
  const configured = Number(env.DELIVERY_SYNC_INTERVAL_MS),
    intervalMs =
      Number.isFinite(configured) && configured >= 60000
        ? configured
        : DEFAULT_DELIVERY_SYNC_INTERVAL_MS,
    enabled = !disabledValues.has(
      String(env.DELIVERY_SYNC_ENABLED ?? "true")
        .trim()
        .toLowerCase(),
    );
  return { enabled, intervalMs };
}

export function getDeliverySchedulerState() {
  const settings = deliverySyncSettings();
  return {
    ...settings,
    ...state,
    enabled: settings.enabled,
    intervalMs: settings.intervalMs,
  };
}

export function startDeliverySyncScheduler({
  sync = (trigger) => deliveryService.syncBatch({ trigger }),
  setIntervalFn = setInterval,
  now = () => Date.now(),
} = {}) {
  const settings = deliverySyncSettings();
  Object.assign(state, settings, {
    startedAt: new Date(now()),
    nextRunAt: null,
  });
  if (!settings.enabled) return null;
  const run = async (trigger) => {
    if (trigger === "CRON")
      state.nextRunAt = new Date(now() + settings.intervalMs);
    try {
      return await sync(trigger);
    } catch {
      // The core runner persists and summarizes failures. This guard only keeps
      // an unexpected scheduler-level exception from stopping future ticks.
      return null;
    }
  };
  void run("STARTUP");
  state.nextRunAt = new Date(now() + settings.intervalMs);
  return setIntervalFn(() => void run("CRON"), settings.intervalMs);
}
