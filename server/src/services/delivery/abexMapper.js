import { assert } from "../../errors.js";
import { normalizePhone } from "../../domain/order.js";
import { validTracking, sanitizeProviderStatus } from "./deliveryMapper.js";
import { abexAssert, abexError, abexErrorDetails } from "./abexErrors.js";

export const ABEX_HOST = "https://app.abex.clawdyatms.app";
export const ABEX_CREATE_PATH = "/api/v1/parcels";
export const ABEX_BULK_CREATE_PATH = "/api/v1/parcels/bulk";
// POST /parcels/bulk accepts at most 100 parcels per request.
export const ABEX_BULK_LIMIT = 100;
// deliveryType values accepted by POST /parcels.
export const ABEX_DELIVERY_TYPES = { HOME: "home", STOP_DESK: "pickup-point" };
// Non-serialized details about a prepared payload (resolved hub name).
export const ABEX_PAYLOAD_META = Symbol("abexPayloadMeta");
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
    abexErrorDetails("DELIVERY_NOT_CONFIGURED"),
  );
}

const invalidOrder = (field, message) =>
  abexError("ABEX_ORDER_INVALID", { field, message });

// Checks performed on CRM data before any ABEX request is sent. These are CRM
// rules (the order form applies the same ones); ABEX may still reject a parcel
// for reasons its public specification does not describe.
export function validateAbexOrder(order) {
  abexAssert(
    Object.hasOwn(ABEX_DELIVERY_TYPES, order.delivery?.type),
    "ABEX_DELIVERY_UNSUPPORTED",
  );
  abexAssert(!order.delivery.exchange, "ABEX_EXCHANGE_UNSUPPORTED");
  if (
    typeof order.orderNumber !== "string" ||
    !order.orderNumber.trim() ||
    order.orderNumber.length > 100
  )
    throw invalidOrder("orderNumber", "The order has no usable reference.");
  if (
    typeof order.customer?.name !== "string" ||
    order.customer.name.trim().length < 2
  )
    throw invalidOrder(
      "customerName",
      "Enter the customer's full name before creating the parcel.",
    );
  for (const [field, value, required] of [
    ["phoneA", order.customer.phoneA, true],
    ["phoneB", order.customer.phoneB?.trim(), false],
  ]) {
    if (!value && !required) continue;
    try {
      normalizePhone(value);
    } catch {
      throw invalidOrder(
        field,
        field === "phoneA"
          ? "The customer's phone number is missing or is not a valid Algerian mobile number."
          : "The customer's second phone number is not a valid Algerian mobile number.",
      );
    }
  }
  if (
    order.delivery.type === "HOME" &&
    (typeof order.location?.address !== "string" ||
      !order.location.address.trim())
  )
    throw invalidOrder(
      "address",
      "Enter the delivery address before creating a home-delivery parcel.",
    );
  const amount = order.payment?.amountToCollect;
  if (!Number.isFinite(amount) || amount < 0)
    throw invalidOrder("amount", "Invalid courier collection amount.");
  for (const item of order.items || []) {
    if (item.type !== "PRODUCT") continue;
    if (
      typeof item.name !== "string" ||
      !item.name.trim() ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      !Number.isFinite(item.unitPrice) ||
      item.unitPrice < 0
    )
      throw invalidOrder(
        "items",
        "Every product needs a name, a whole quantity of at least 1 and a valid price.",
      );
  }
}

export function mapAbexOrder(order, settings = {}, destination) {
  validateAbexOrder(order);
  abexAssert(
    isAbexId(destination?.cityTerritoryId) &&
      isAbexId(destination?.districtTerritoryId),
    "ABEX_TERRITORY_REQUIRED",
    {
      message: `ABEX could not verify "${order.location.commune}" in ${order.location.wilayaName}. Edit the order and select a commune for the correct wilaya.`,
    },
  );
  const desk = order.delivery.type === "STOP_DESK";
  // The hub is resolved and verified by AbexClient before this point. A
  // pickup-point parcel is never built without one.
  abexAssert(!desk || isAbexId(destination.hubId), "ABEX_HUB_REQUIRED", {
    alternative: "HOME",
  });
  const amount = order.payment.amountToCollect;
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
  const street = order.location.address?.trim();
  return {
    externalId: order.orderNumber,
    customer: {
      name: order.customer.name.trim(),
      phone: {
        number1: normalizePhone(order.customer.phoneA),
        ...(secondaryPhone ? { number2: normalizePhone(secondaryPhone) } : {}),
      },
    },
    deliveryAddress: {
      cityTerritoryId: destination.cityTerritoryId.toLowerCase(),
      districtTerritoryId: destination.districtTerritoryId.toLowerCase(),
      ...(street ? { street } : {}),
    },
    ...(desk ? { hubId: destination.hubId.toLowerCase() } : {}),
    ...(orderedProducts.length ? { orderedProducts } : {}),
    deliveryType: ABEX_DELIVERY_TYPES[order.delivery.type],
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
    delivery: [
      order.delivery.type,
      Boolean(order.delivery.exchange),
      order.delivery.type === "STOP_DESK"
        ? String(order.delivery.pickupHubId || "").toLowerCase()
        : "",
    ],
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
  return abexError("ABEX_INVALID_RESPONSE");
}

// Interprets CreateBulkParcelsResponse for POST /parcels/bulk.
//   200: every parcel was created, 207: some were, 400: none were.
// Each submitted parcel gets exactly one result. A parcel that the response
// does not account for is reported as UNKNOWN and must be reconciled by its
// external reference before any new attempt. A batch is never reported as
// complete unless every parcel has a verified success entry.
export function parseAbexBulkResult(httpStatus, data, payloads, sanitize) {
  const clean = (value) =>
    sanitizeProviderStatus(sanitize ? sanitize(value) : value);
  const results = payloads.map((payload, index) => ({
    index,
    externalId: payload.externalId,
    outcome: "UNKNOWN",
  }));
  const rows = (list) => (Array.isArray(list) ? list : []);
  const bulkShape =
    data &&
    typeof data === "object" &&
    (Array.isArray(data.successes) || Array.isArray(data.failures));
  // A 400 without the bulk body is a rejected request: nothing was created.
  if (httpStatus === 400 && !bulkShape)
    return {
      status: "FAILED",
      results: results.map((result) => ({
        ...result,
        outcome: "FAILED",
        errorCode: "ABEX_VALIDATION",
      })),
    };
  if (![200, 207, 400].includes(httpStatus) || !bulkShape)
    throw abexResponseError();
  const seen = new Set();
  const claim = (row) => {
    const result = Number.isInteger(row?.index) ? results[row.index] : undefined;
    if (
      !result ||
      seen.has(row.index) ||
      (row.externalId != null && row.externalId !== result.externalId)
    )
      throw abexResponseError();
    seen.add(row.index);
    return result;
  };
  for (const row of rows(data.successes)) {
    const result = claim(row);
    if (
      !isAbexId(row.parcelId) ||
      (row.trackingNumber != null && !validTracking(row.trackingNumber)) ||
      (row.amount != null && row.amount !== payloads[row.index].amount)
    )
      throw abexResponseError();
    result.outcome = "CREATED";
    result.parcelId = row.parcelId.toLowerCase();
    result.tracking = row.trackingNumber?.trim() || undefined;
  }
  for (const row of rows(data.failures)) {
    const result = claim(row);
    result.outcome = "FAILED";
    result.errorCode = clean(row.errorCode) || "ABEX_VALIDATION";
    result.errorMessage = clean(row.errorMessage) || undefined;
  }
  const created = results.filter((result) => result.outcome === "CREATED");
  const failed = results.filter((result) => result.outcome === "FAILED");
  // The status code must agree with the per-parcel entries. If it does not,
  // the entries are kept and the batch is reported as needing reconciliation.
  const consistent =
    (httpStatus === 200 && created.length === results.length) ||
    (httpStatus === 207 && created.length > 0 && failed.length > 0) ||
    (httpStatus === 400 && created.length === 0);
  const complete = created.length + failed.length === results.length;
  return {
    status:
      !consistent || !complete
        ? "RECONCILE"
        : created.length === results.length
          ? "COMPLETE"
          : created.length
            ? "PARTIAL"
            : "FAILED",
    results,
  };
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
