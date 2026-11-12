import { AppError, assert } from "../../errors.js";
import { normalizePhone } from "../../domain/order.js";
import { validTracking, sanitizeProviderStatus } from "./deliveryMapper.js";

export const ABEX_HOST = "https://app.abex.clawdyatms.app";
export const ABEX_CREATE_PATH = "/api/v1/parcels";
export const isAbexId = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
export const abexWritesEnabled = () =>
  process.env.ABEX_WRITES_ENABLED === "true";
export const isAbexDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
    value,
  ) &&
  Number.isFinite(Date.parse(value));

export function requireAbexWrites() {
  assert(
    abexWritesEnabled(),
    "ABEX parcel writes are disabled. Contact your administrator.",
    503,
    "DELIVERY_NOT_CONFIGURED",
  );
}

export function mapAbexOrder(order, settings, destination) {
  assert(
    isAbexId(destination?.cityTerritoryId) &&
      isAbexId(destination?.districtTerritoryId),
    `ABEX could not verify "${order.location.commune}" in ${order.location.wilayaName}. Edit the order and select a commune for the correct wilaya.`,
    409,
    "ABEX_TERRITORY_REQUIRED",
  );
  const desk = order.delivery.type === "STOP_DESK";
  assert(
    !desk || isAbexId(destination.hubId),
    "Configure an ABEX pickup hub for this wilaya and commune.",
    409,
    "ABEX_HUB_REQUIRED",
  );
  assert(
    !order.delivery.exchange,
    "ABEX exchanges require an existing provider parcel and must be arranged in the courier portal.",
    409,
    "ABEX_EXCHANGE_UNSUPPORTED",
  );
  const amount = order.payment.amountToCollect;
  assert(
    Number.isFinite(amount) && amount >= 0,
    "Invalid courier collection amount.",
    409,
  );
  const physicalItems = order.items.filter((item) => item.type === "PRODUCT");
  const lines = physicalItems.map((item) => ({
    item,
    productId: settings.products?.[String(item.catalogItemId)],
  }));
  // The supplier portal uses one stock mode for the entire parcel. Its
  // manual mode sends named lines without catalog IDs or line prices.
  const useCatalogStock = lines.every(({ productId }) => isAbexId(productId));
  const orderedProducts = lines.map(({ item, productId }) => ({
    ...(useCatalogStock ? { productId } : {}),
    productName: item.name,
    unitPrice: useCatalogStock ? item.unitPrice : 0,
    quantity: item.quantity,
    stockType: useCatalogStock ? "local" : "none",
  }));
  const description =
    [
      order.note,
      ...physicalItems.map(
        (item) =>
          item.specifications && `${item.name} · ${item.specifications}`,
      ),
    ]
      .filter(Boolean)
      .join("\n") || (useCatalogStock ? "" : "--");
  const secondaryPhone = order.customer.phoneB?.trim();
  return {
    externalId: order.orderNumber,
    customer: {
      name: order.customer.name,
      phone: {
        number1: normalizePhone(order.customer.phoneA),
        ...(secondaryPhone ? { number2: normalizePhone(secondaryPhone) } : {}),
      },
    },
    deliveryAddress: {
      cityTerritoryId: destination.cityTerritoryId,
      districtTerritoryId: destination.districtTerritoryId,
      street: order.location.address,
    },
    ...(desk ? { hubId: destination.hubId } : {}),
    ...(orderedProducts.length ? { orderedProducts } : {}),
    deliveryType: desk ? "pickup-point" : "home",
    amount,
    ...(description ? { description } : {}),
  };
}

export function abexOrderSnapshot(order) {
  return {
    customer: [
      order.customer.name,
      order.customer.phoneA,
      order.customer.phoneB,
    ],
    destination: [
      String(order.location.wilayaId),
      order.location.commune,
      order.location.address,
    ],
    delivery: [order.delivery.type, Boolean(order.delivery.exchange)],
    amount: order.payment.amountToCollect,
    note: order.note || "",
    products: order.items
      .filter((item) => item.type === "PRODUCT")
      .map((item) => [
        String(item.catalogItemId),
        item.name,
        item.unitPrice,
        item.quantity,
        item.specifications || "",
      ]),
  };
}

export function abexResponseError() {
  return new AppError(
    "ABEX returned an invalid or incomplete response.",
    502,
    "ABEX_INVALID_RESPONSE",
  );
}

// Keep only the identifiers and status fields needed by the CRM.
export function abexParcel(data, sanitize) {
  if (
    !isAbexId(data?.id) ||
    (data.trackingNumber != null && !validTracking(data.trackingNumber)) ||
    (data.externalId != null && typeof data.externalId !== "string") ||
    (data.state != null && !isAbexId(data.state.id)) ||
    (data.situation != null && !isAbexId(data.situation.id)) ||
    (data.lastStateSituationId != null && !isAbexId(data.lastStateSituationId))
  )
    throw abexResponseError();
  if (
    [
      data.id,
      data.trackingNumber,
      data.externalId,
      data.state?.id,
      data.situation?.id,
      data.lastStateSituationId,
    ].some((id) => id && sanitize(id) !== id)
  )
    throw abexResponseError();
  if (
    data.situation?.id &&
    data.lastStateSituationId &&
    data.situation.id.toLowerCase() !== data.lastStateSituationId.toLowerCase()
  )
    throw abexResponseError();

  const times = [
    data.lastStateUpdateAt,
    data.lastSituationUpdateAt,
    data.lastStateHistoryAt,
  ].filter((value) => value != null);
  if (
    times.some((value) => !isAbexDate(value)) ||
    (data.createdAt != null && !isAbexDate(data.createdAt))
  )
    throw abexResponseError();

  const tracking = data.trackingNumber?.trim();
  const externalId = data.externalId;
  const parcelId = data.id.toLowerCase();
  const stateId = data.state?.id.toLowerCase();
  const providerSituationId = (
    data.lastStateSituationId || data.situation?.id
  )?.toLowerCase();
  const stateName = sanitizeProviderStatus(sanitize(data.state?.name));
  const situationName = sanitizeProviderStatus(sanitize(data.situation?.name));
  const providerUpdatedAt = times.length
    ? new Date(Math.max(...times.map(Date.parse)))
    : undefined;
  return {
    tracking,
    externalId,
    parcelId,
    stateId,
    stateLocked:
      data.state?.isLocked === true || data.state?.isBlocking === true,
    providerSituationId,
    providerStatus: situationName || stateName || stateId,
    providerUpdatedAt,
    providerCreatedAt: data.createdAt ? new Date(data.createdAt) : undefined,
    raw: sanitize({
      id: parcelId,
      trackingNumber: tracking,
      externalId,
      stateId,
      stateName,
      situationId: providerSituationId,
      situationName,
      lastStateUpdateAt: data.lastStateUpdateAt,
      lastSituationUpdateAt: data.lastSituationUpdateAt,
      lastStateHistoryAt: data.lastStateHistoryAt,
    }),
  };
}

export function requireAbexIdentity(
  parcel,
  { tracking, externalId, providerParcelId },
) {
  assert(
    parcel?.tracking &&
      parcel.externalId &&
      parcel.externalId === externalId &&
      (!tracking || parcel.tracking === tracking) &&
      (!providerParcelId || parcel.parcelId === providerParcelId),
    "ABEX parcel identity does not match the linked order. Review it in the courier portal.",
    409,
    "ABEX_IDENTITY_MISMATCH",
  );
}

export function abexState(settings, workflows, parcel) {
  const matches = workflows.flatMap((workflow) =>
    workflow.states
      .filter((state) => state.id === parcel.stateId)
      .map((state) => ({ workflow, state })),
  );
  if (matches.length !== 1) return {};
  const { workflow, state } = matches[0];
  const configured =
    settings.states?.filter(
      (entry) => entry.workflowId === workflow.id && entry.stateId === state.id,
    ) || [];
  const situation = state.situations?.find(
    (item) => item.id === parcel.providerSituationId,
  );
  const mapped =
    (situation &&
      configured.find((entry) => entry.situationId === situation.id)) ||
    configured.find((entry) => !entry.situationId);
  return { workflow, state, normalizedStatus: mapped?.status };
}
