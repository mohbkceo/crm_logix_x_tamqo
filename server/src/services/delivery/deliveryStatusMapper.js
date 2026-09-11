import { STATUSES } from "../../constants.js";

const KNOWN_PROVIDER_STATUSES = {
  "en preparation": "PREPARING",
  "en traitement - pret a expedie": "READY_TO_SHIP",
  dispatcher: "SHIPPED",
  "en livraison": "OUT_FOR_DELIVERY",
  "en livraison ( 1528 )": "OUT_FOR_DELIVERY",
  "au bureau": "SHIPPED",
  reporté: "FAILED_DELIVERY",
  reporte: "FAILED_DELIVERY",
  "a relancé": "FAILED_DELIVERY",
  "a relance": "FAILED_DELIVERY",
  "appel sans réponse 1": "FAILED_DELIVERY",
  "appel sans réponse 2": "FAILED_DELIVERY",
  "appel sans réponse 3": "FAILED_DELIVERY",
  "sd - appel sans réponse 1": "FAILED_DELIVERY",
  "sd - appel sans réponse 2": "FAILED_DELIVERY",
  "sd - appel sans réponse 3": "FAILED_DELIVERY",
  "sd - en attente du client": "FAILED_DELIVERY",
  "sd - reporté": "FAILED_DELIVERY",
  livrée: "DELIVERED",
  livree: "DELIVERED",
  "colis livrée": "DELIVERED",
  "colis livree": "DELIVERED",
  "livrée [ encaisser ]": "DELIVERED",
  "livree [ encaisser ]": "DELIVERED",
  "livrée [ recouvert ]": "DELIVERED",
  "livree [ recouvert ]": "DELIVERED",
  "livrée [encaisser]": "DELIVERED",
  "livree [encaisser]": "DELIVERED",
  "livrée [recouvert]": "DELIVERED",
  "livree [recouvert]": "DELIVERED",
  "annuler par le client": "CANCELLED",
  "sd - annuler par le client": "CANCELLED",
  "sd - annuler 3x": "CANCELLED",
  "retour de dispatche": "RETURNING",
  "retour livreur": "RETURNING",
  "retour navette": "RETURNING",
  "retour stock": "RETURNED",
};

export function normalizeProviderStatus(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function knownStatusMapping() {
  return new Map(
    Object.entries(KNOWN_PROVIDER_STATUSES).map(
      ([providerStatus, internalStatus]) => [
        normalizeProviderStatus(providerStatus),
        internalStatus,
      ],
    ),
  );
}

export function deliveryStatusMapping() {
  const mapping = knownStatusMapping();
  let raw;
  try {
    raw = JSON.parse(process.env.DELIVERY_STATUS_MAP || "{}");
  } catch {
    return {
      configured: true,
      mapping,
      error: "DELIVERY_STATUS_MAP is not valid JSON.",
    };
  }
  if (!raw || Array.isArray(raw) || typeof raw !== "object")
    return {
      configured: true,
      mapping,
      error: "DELIVERY_STATUS_MAP must be a JSON object.",
    };
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
