import { STATUSES } from "../../constants.js";
export function normalizeProviderStatus(value) {
  return [...String(value ?? "").normalize("NFKC")]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en");
}
export function deliveryStatusMapping() {
  let raw;
  try {
    raw = JSON.parse(process.env.DELIVERY_STATUS_MAP || "{}");
  } catch {
    return {
      configured: false,
      mapping: new Map(),
      error: "DELIVERY_STATUS_MAP is not valid JSON.",
    };
  }
  if (!raw || Array.isArray(raw) || typeof raw !== "object")
    return {
      configured: false,
      mapping: new Map(),
      error: "DELIVERY_STATUS_MAP must be a JSON object.",
    };
  const mapping = new Map();
  let invalidEntries = 0;
  for (const [providerStatus, internalStatus] of Object.entries(raw)) {
    const key = normalizeProviderStatus(providerStatus);
    if (!key || !STATUSES.includes(internalStatus)) {
      invalidEntries++;
      continue;
    }
    mapping.set(key, internalStatus);
  }
  return {
    configured: mapping.size > 0,
    mapping,
    invalidEntries,
    error:
      invalidEntries > 0
        ? `${invalidEntries} delivery status mapping entries are invalid.`
        : null,
  };
}
export function mapProviderStatus(value) {
  return (
    deliveryStatusMapping().mapping.get(normalizeProviderStatus(value)) || null
  );
}
