import { STATUSES } from "../../constants.js";
export function mapProviderStatus(value) {
  let mapping;
  try {
    mapping = JSON.parse(process.env.DELIVERY_STATUS_MAP || "{}");
  } catch {
    return null;
  }
  const mapped = mapping[String(value)];
  return STATUSES.includes(mapped) ? mapped : null;
}
