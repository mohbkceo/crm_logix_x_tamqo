import { DeliveryAgency } from "../../models/delivery.js";
import { decryptCredentials } from "./credentials.js";
import { DeliveryClient } from "./deliveryClient.js";
import { assert } from "../../errors.js";
export async function providerFor(id, capability) {
  const agency = await DeliveryAgency.findById(id).select(
    "+encryptedCredentials",
  );
  assert(agency, "Delivery agency not found", 404);
  if (capability)
    assert(
      agency.capabilities?.[capability],
      `Agency does not support ${capability}`,
      409,
    );
  if (agency.integrationType === "MANUAL")
    return {
      async testCredentials() {
        const response = await fetch(`${this.baseUrl}/token`, {
          method: "GET",
          headers: {
            token: this.credentials.token,
            key: this.credentials.key,
            Accept: "application/json",
          },
        });

        assert(
          response.ok,
          `Procolis authentication failed (${response.status})`,
          502,
        );

        return true;
      },
    };
  assert(agency.apiProvider === "PROCOLIS", "Unsupported provider", 409);
  const credentials = agency.encryptedCredentials
    ? decryptCredentials(agency.encryptedCredentials)
    : agency.code === "ABEX"
      ? {
          token: process.env.DELIVERY_API_TOKEN,
          key: process.env.DELIVERY_API_KEY,
        }
      : {};
  return new DeliveryClient({ baseUrl: agency.config?.baseUrl, credentials });
}
