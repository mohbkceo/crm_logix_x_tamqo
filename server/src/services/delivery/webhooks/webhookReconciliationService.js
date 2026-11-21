import { DeliveryAgency } from "../../../models/delivery.js";
import { Shipment, Order } from "../../../models/index.js";
import { providerFor } from "../deliveryProviderFactory.js";
import { DeliverySyncService } from "../deliverySyncService.js";
import { notificationSchema } from "./abexWebhookAdapter.js";

export class WebhookProcessingError extends Error {
  constructor(code, retryable = false) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

export async function prepareWebhookRefresh(
  event,
  config,
  getProvider = providerFor,
) {
  const parsed = notificationSchema.safeParse(
    event.notification?.toObject?.() || event.notification,
  );
  if (!parsed.success)
    throw new WebhookProcessingError("WEBHOOK_SCHEMA_INVALID");
  if (
    !config.agencyId ||
    String(event.agencyId) !== config.agencyId ||
    event.destinationId !== config.destinationId
  )
    throw new WebhookProcessingError("WEBHOOK_AGENCY_UNCONFIGURED");
  const agency = await DeliveryAgency.findById(config.agencyId).lean();
  if (
    !agency ||
    agency.apiProvider !== "ABEX" ||
    agency.integrationType !== "API" ||
    !agency.capabilities?.tracking
  )
    throw new WebhookProcessingError("WEBHOOK_AGENCY_MISMATCH");
  // Resolve only an existing ABEX parcel in the server-configured agency.
  // Never link/create via payload order IDs, external references or agency IDs.
  const shipment = await Shipment.findOne({
    agencyId: agency._id,
    provider: "ABEX",
    providerParcelId: parsed.data.parcelId,
  }).lean();
  if (!shipment?.tracking)
    throw new WebhookProcessingError("WEBHOOK_SHIPMENT_NOT_LINKED", true);
  if (
    parsed.data.trackingNumber &&
    shipment.tracking !== parsed.data.trackingNumber
  )
    throw new WebhookProcessingError("ABEX_IDENTITY_MISMATCH");
  const order = await Order.findById(shipment.orderId).lean();
  if (
    !order ||
    order.deletedAt ||
    String(order.delivery.agencyId) !== String(agency._id) ||
    order.items.some((item) => !agency.businesses.includes(item.business))
  )
    throw new WebhookProcessingError("WEBHOOK_AGENCY_MISMATCH");
  const client = await getProvider(agency._id, "tracking", shipment);
  if (client.provider !== "ABEX")
    throw new WebhookProcessingError("WEBHOOK_AGENCY_MISMATCH");
  // No creation, reconciliation search, readiness PATCH, or bulk sync here.
  // The authenticated client verifies returned tenant, parcel, tracking and
  // external reference, and uses the agency's existing workflow UUID mappings.
  const parcel = await client.getShipment({
    ...shipment,
    externalId: order.orderNumber,
  });
  return {
    shipment,
    service: new DeliverySyncService(client, agency._id),
    parcel,
    reservation: {
      _id: shipment._id,
      agencyId: agency._id,
      provider: "ABEX",
      providerParcelId: shipment.providerParcelId,
      tracking: shipment.tracking,
    },
  };
}
