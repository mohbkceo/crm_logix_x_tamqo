import { deliveryService } from "./deliveryService.js";
import {
  DEFAULT_DELIVERY_SYNC_INTERVAL_MS,
  defaultDeliverySyncSettings,
  deliverySyncSettings,
  loadDeliverySyncSettings,
} from "./deliverySyncSettings.js";

export { DEFAULT_DELIVERY_SYNC_INTERVAL_MS, deliverySyncSettings };

// While the cron is switched off the scheduler still wakes up at this pace to
// notice that it was switched back on from another API worker.
const DISABLED_POLL_MS = 60000;
const state = {
  enabled: true,
  intervalMs: DEFAULT_DELIVERY_SYNC_INTERVAL_MS,
  nextRunAt: null,
  startedAt: null,
};
let timer = null,
  deps = null;

export function getDeliverySchedulerState() {
  return { ...state };
}

function configure(settings) {
  if (timer) deps.clearIntervalFn(timer);
  state.enabled = settings.cronEnabled;
  state.intervalMs = settings.intervalMinutes * 60000;
  state.nextRunAt = state.enabled
    ? new Date(deps.now() + state.intervalMs)
    : null;
  timer = deps.setIntervalFn(
    () => void tick(),
    state.enabled ? state.intervalMs : DISABLED_POLL_MS,
  );
  return timer;
}

async function currentSettings() {
  try {
    return await deps.loadSettings();
  } catch {
    // Keep the schedule already in memory when the database is unreachable.
    return {
      cronEnabled: state.enabled,
      intervalMinutes: state.intervalMs / 60000,
    };
  }
}

async function run(trigger) {
  try {
    return await deps.sync(trigger);
  } catch {
    // The core runner persists and summarizes failures. This guard only keeps
    // an unexpected scheduler-level exception from stopping future ticks.
    return null;
  }
}

async function tick() {
  if (!deps) return null;
  const settings = await currentSettings();
  if (!deps) return null;
  if (
    settings.cronEnabled !== state.enabled ||
    settings.intervalMinutes * 60000 !== state.intervalMs
  )
    configure(settings);
  else if (state.enabled)
    state.nextRunAt = new Date(deps.now() + state.intervalMs);
  return settings.cronEnabled ? run("CRON") : null;
}

// Re-reads the saved settings and restarts the timer. Called after the
// settings are changed so the new schedule applies without a server restart.
export async function applyDeliverySyncSettings() {
  if (!deps) return null;
  const settings = await currentSettings();
  if (!deps) return null;
  return configure(settings);
}

export async function startDeliverySyncScheduler({
  sync = (trigger) => deliveryService.syncBatch({ trigger }),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = () => Date.now(),
  loadSettings = loadDeliverySyncSettings,
} = {}) {
  stopDeliverySyncScheduler();
  deps = { sync, setIntervalFn, clearIntervalFn, now, loadSettings };
  state.startedAt = new Date(now());
  let settings;
  try {
    settings = await loadSettings();
  } catch {
    settings = defaultDeliverySyncSettings();
  }
  if (!deps) return null;
  if (settings.cronEnabled) void run("STARTUP");
  return configure(settings);
}

export function stopDeliverySyncScheduler() {
  if (timer && deps) deps.clearIntervalFn(timer);
  timer = null;
  deps = null;
  state.nextRunAt = null;
}
