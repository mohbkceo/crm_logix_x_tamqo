import { DeliverySyncSettings } from "../../models/delivery.js";

export const DELIVERY_SYNC_SETTINGS_ID = "delivery-sync";
export const DEFAULT_DELIVERY_SYNC_INTERVAL_MS = 900000;
export const MIN_DELIVERY_SYNC_INTERVAL_MINUTES = 1;
export const MAX_DELIVERY_SYNC_INTERVAL_MINUTES = 1440;
const disabledValues = new Set(["0", "false", "off", "disabled"]);

// Environment values are only the starting point: once the settings are saved
// from Settings / Delivery sync logs, the database copy wins.
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

export function defaultDeliverySyncSettings(env = process.env) {
  const defaults = deliverySyncSettings(env);
  return {
    cronEnabled: defaults.enabled,
    intervalMinutes: Math.min(
      MAX_DELIVERY_SYNC_INTERVAL_MINUTES,
      Math.max(
        MIN_DELIVERY_SYNC_INTERVAL_MINUTES,
        Math.round(defaults.intervalMs / 60000),
      ),
    ),
    loggingEnabled: true,
  };
}

export async function loadDeliverySyncSettings() {
  const defaults = defaultDeliverySyncSettings(),
    saved = await DeliverySyncSettings.findById(
      DELIVERY_SYNC_SETTINGS_ID,
    ).lean();
  return {
    cronEnabled: saved?.cronEnabled ?? defaults.cronEnabled,
    intervalMinutes: saved?.intervalMinutes ?? defaults.intervalMinutes,
    loggingEnabled: saved?.loggingEnabled ?? defaults.loggingEnabled,
  };
}

export async function saveDeliverySyncSettings(changes, actor) {
  const before = await loadDeliverySyncSettings(),
    after = { ...before };
  for (const key of ["cronEnabled", "intervalMinutes", "loggingEnabled"])
    if (changes[key] !== undefined) after[key] = changes[key];
  await DeliverySyncSettings.findOneAndUpdate(
    { _id: DELIVERY_SYNC_SETTINGS_ID },
    { $set: { ...after, updatedBy: actor } },
    { upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );
  return { before, after };
}
