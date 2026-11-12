import { DeliveryAgency } from "../../models/delivery.js";
import { decryptCredentials } from "./credentials.js";
import { DeliveryClient } from "./deliveryClient.js";
import { AbexClient } from "./abexClient.js";
import { abexWritesEnabled } from "./abexMapper.js";
import { AppError, assert } from "../../errors.js";

export const abexCapabilities = {
  createShipment: true,
  updateShipment: false,
  deleteShipment: false,
  tracking: true,
  readyToShip: true,
  pricing: true,
};

export function shipmentProvider(agency, shipment) {
  if (shipment?.provider === "EXCEL_IMPORT")
    return agency.apiProvider === "PROCOLIS" || agency.legacyTracking
      ? "PROCOLIS"
      : "EXCEL_IMPORT";
  return shipment?.provider || agency.apiProvider;
}

export function supportsReadiness(agency, shipment) {
  return (
    agency?.integrationType === "API" &&
    agency.capabilities?.tracking &&
    agency.capabilities?.readyToShip &&
    shipment &&
    agency.apiProvider === shipmentProvider(agency, shipment) &&
    (agency.apiProvider === "PROCOLIS" ||
      (agency.apiProvider === "ABEX" &&
        (abexWritesEnabled() || shipment.pendingReadinessStateId) &&
        agency.config?.abex?.states?.some(
          (entry) => entry.status === "READY_TO_SHIP" && !entry.situationId,
        )))
  );
}

function readCredentials(encrypted) {
  if (!encrypted) return {};
  try {
    return decryptCredentials(encrypted);
  } catch {
    throw new AppError(
      "Delivery credentials could not be decrypted. Verify the server key or rotate the credentials.",
      503,
      "DELIVERY_NOT_CONFIGURED",
    );
  }
}

export async function providerFor(id, capability, shipment) {
  const agency = await DeliveryAgency.findById(id).select(
    "+encryptedCredentials +encryptedLegacyCredentials +legacyBaseUrl",
  );
  assert(agency, "Delivery agency not found", 404);
  const provider = shipmentProvider(agency, shipment);
  const historical = provider === "PROCOLIS" && agency.apiProvider === "ABEX";
  if (historical)
    assert(
      capability === "tracking" && agency.legacyTracking,
      "This parcel was created through Procolis. Only historical tracking is available after ABEX cutover.",
      409,
      "LEGACY_SHIPMENT",
    );
  if (capability)
    assert(
      agency.capabilities?.[capability],
      `Agency does not support ${capability}`,
      409,
    );
  if (agency.integrationType === "MANUAL")
    return {
      async testCredentials() {
        return true;
      },
    };
  if (provider === "ABEX" && agency.apiProvider === "ABEX")
    return new AbexClient({
      credentials: readCredentials(agency.encryptedCredentials),
      settings: agency.config?.abex,
      agencyVersion: `${agency._id}:${+agency.updatedAt}`,
    });
  assert(
    provider === "PROCOLIS" && (historical || agency.apiProvider === provider),
    "This shipment has no supported courier lookup contract.",
    409,
    "DELIVERY_PROVIDER_UNSUPPORTED",
  );
  const encrypted = historical
    ? agency.encryptedLegacyCredentials
    : agency.encryptedCredentials;
  const credentials = encrypted
    ? readCredentials(encrypted)
    : agency.code === "ABEX"
      ? {
          token: process.env.DELIVERY_API_TOKEN,
          key: process.env.DELIVERY_API_KEY,
        }
      : {};
  return new DeliveryClient({
    readOnly: historical,
    baseUrl: historical ? agency.legacyBaseUrl : agency.config?.baseUrl,
    credentials,
  });
}
