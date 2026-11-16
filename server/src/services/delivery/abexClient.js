import axios from "axios";
import { setTimeout as delay } from "node:timers/promises";
import { AppError, assert } from "../../errors.js";
import { sanitizeProviderData, validTracking } from "./deliveryMapper.js";
import { findAbexCommune } from "../../../../shared/abexTerritories.js";
import {
  ABEX_BULK_CREATE_PATH,
  ABEX_BULK_LIMIT,
  ABEX_CREATE_PATH,
  ABEX_HOST,
  ABEX_PAYLOAD_META,
  abexParcel,
  abexResponseError,
  abexState,
  isAbexId,
  mapAbexOrder,
  parseAbexBulkResult,
  requireAbexIdentity,
  requireAbexWrites,
  validateAbexOrder,
} from "./abexMapper.js";
import { abexAssert, abexError } from "./abexErrors.js";
import {
  choosePickupHub,
  describePickupHubs,
  pickupHub,
  pickupHubCandidates,
} from "./abexHubs.js";

const root = "/api/v1";
// HTTP status returned by ABEX -> normalized CRM error code. The status,
// messages and retry guidance for each code live in abexErrors.js.
// 409 is the only one of these that ABEX documents for parcel creation
// (external reference reused within 12 hours). The others follow ordinary
// HTTP semantics because the public specification lists 200 responses only.
const failureCodes = {
  400: "ABEX_VALIDATION",
  401: "ABEX_AUTHENTICATION",
  403: "ABEX_PERMISSION",
  404: "ABEX_NOT_FOUND",
  409: "ABEX_CONFLICT",
  422: "ABEX_VALIDATION",
  429: "ABEX_RATE_LIMIT",
};
const timeoutCodes = ["ECONNABORTED", "ETIMEDOUT"];
const httpStatus = (error) => error.response?.status;
// [pattern in the provider's validation text, label shown to users, CRM field]
const validationLabels = [
  [/\b(?:stock\s*type|stock\s*mode|type de stock)\b/i, "stock type", "items"],
  [/\bproduct\s*id\b/i, "ABEX product ID", "items"],
  [
    /\b(?:ordered\s*products|product\s*name|products?\s*description|parcel contents)\b/i,
    "parcel contents",
    "items",
  ],
  [/\b(?:number1|primary phone)\b/i, "primary phone", "phoneA"],
  [/\b(?:number2|secondary phone)\b/i, "secondary phone", "phoneB"],
  [/\b(?:phone(?:\s*number)?|mobile|téléphone)\b/i, "customer phone", "phoneA"],
  [
    /\b(?:delivery\s*address|city\s*territory\s*id|district\s*territory\s*id|wilaya|commune|postal\s*code|street)\b/i,
    "delivery address",
    "address",
  ],
  [/\b(?:hub\s*id|pickup point)\b/i, "pickup hub", "pickupHubId"],
  [/\b(?:delivery\s*type)\b/i, "delivery type", "deliveryType"],
  [
    /\b(?:amount|collection\s*amount|montant)\b|^ExternalCarrier_AmountAboveCarrierLimit$/i,
    "collection amount",
    "amount",
  ],
  [/\b(?:weight|dimensional\s*weight|poids)\b/i, "parcel weight"],
  [/\b(?:external\s*id|external reference)\b/i, "order reference"],
  [/\b(?:state\s*id|initial state)\b/i, "initial parcel state"],
  [/\bcustomer\b/i, "customer details", "customerName"],
];
const fieldForLabel = Object.fromEntries(
  validationLabels.map(([, label, field]) => [label, field]),
);
// ASP.NET problem details usually carry a trace identifier. It is optional and
// absent from the public specification, so it is kept only when well formed.
const providerTraceId = (body) =>
  typeof body?.traceId === "string" && /^[\w:.-]{8,128}$/.test(body.traceId)
    ? body.traceId
    : undefined;

function validationFields(body) {
  const errors = body?.errors;
  const entries = Array.isArray(errors)
    ? errors
        .slice(0, 20)
        .flatMap((entry) => [
          typeof entry === "string" ? entry : entry?.description,
          entry?.field,
          entry?.propertyName,
        ])
    : Object.keys(errors && typeof errors === "object" ? errors : {}).slice(
        0,
        20,
      );
  const matches = [...entries, body?.detail, body?.title].flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const label = validationLabels.find(([pattern]) =>
      pattern.test(entry.slice(0, 1000)),
    )?.[1];
    return label ? [label] : [];
  });
  return [...new Set(matches)].slice(0, 4);
}

const headerValue = (value) =>
  typeof value === "string" && /^[\x21-\x7e]+$/.test(value);
const safeTracking = (tracking) =>
  validTracking(tracking) &&
  !/[/\\?#%]/.test(tracking) &&
  !/^\.{1,2}$/.test(tracking);
export const abexCatalogs = [
  "territories",
  "hubs",
  "products",
  "workflows",
  "stock-origins",
];
const territoryCache = new Map();
const hubCache = new Map();
const catalogCacheMs = 10 * 60 * 1000;

// Short-lived, per-agency cache for ABEX reference data. Empty and failed
// lookups are never kept, so a repaired configuration is picked up at once.
async function cachedCatalog(cache, key, load) {
  const existing = cache.get(key);
  if (existing?.expiresAt > Date.now()) return existing.result;
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  const entry = { expiresAt: Date.now() + catalogCacheMs, result: load() };
  cache.set(key, entry);
  try {
    const rows = await entry.result;
    if (!rows.length && cache.get(key) === entry) cache.delete(key);
    return rows;
  } catch (error) {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  }
}

export function clearAbexCatalogCache() {
  territoryCache.clear();
  hubCache.clear();
}

export class AbexClient {
  #credentials;
  #settings;
  #agencyVersion;
  #workflows;
  #retryAt = 0;

  constructor({ credentials = {}, settings = {}, agencyVersion } = {}) {
    this.#credentials = credentials;
    this.#settings = settings;
    this.#agencyVersion = agencyVersion;
    this.provider = "ABEX";
    this.creationEndpoint = ABEX_CREATE_PATH;
    const timeout = Number(process.env.DELIVERY_TIMEOUT_MS || 15000);
    this.http = axios.create({
      baseURL: ABEX_HOST,
      timeout:
        Number.isFinite(timeout) && timeout > 0
          ? Math.min(timeout, 20000)
          : 15000,
      maxRedirects: 0,
      maxContentLength: 2 * 1024 * 1024,
      allowAbsoluteUrls: false,
    });
  }

  ensureConfigured() {
    const { apiKey, tenantId, bearerToken } = this.#credentials;
    assert(
      headerValue(apiKey) &&
        headerValue(tenantId) &&
        (bearerToken === undefined || headerValue(bearerToken)),
      "Configure the ABEX tenant ID and API key in Delivery agencies.",
      503,
      "DELIVERY_NOT_CONFIGURED",
    );
  }

  sanitize(value) {
    return sanitizeProviderData(value, 0, Object.values(this.#credentials));
  }

  async #request(
    method,
    url,
    { data, params, status = 200, read = true, raw = false } = {},
  ) {
    const accepted = Array.isArray(status) ? status : [status];
    this.ensureConfigured();
    if (!read) requireAbexWrites();
    const { apiKey, tenantId, bearerToken } = this.#credentials;
    const headers = {
      Accept: "application/json",
      "X-Api-Key": apiKey,
      "X-Tenant": tenantId,
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    };
    const send = () =>
      this.http.request({
        method,
        url,
        headers,
        data,
        params,
        // Lets a caller read a documented non-2xx body (bulk create's 400).
        ...(raw ? { validateStatus: (code) => accepted.includes(code) } : {}),
      });
    const rememberRateLimit = (error) => {
      if (httpStatus(error) !== 429) return;
      const seconds = Number(error.response?.headers?.["retry-after"] ?? 60);
      this.#retryAt =
        Date.now() +
        (Number.isFinite(seconds) && seconds >= 0 ? seconds : 60) * 1000;
    };
    if (Date.now() < this.#retryAt) throw abexError("ABEX_RATE_LIMIT");

    let response;
    try {
      try {
        response = await send();
      } catch (error) {
        rememberRateLimit(error);
        const upstream = httpStatus(error);
        const retryDelay =
          upstream === 429 ? Math.max(0, this.#retryAt - Date.now()) : 250;
        if (
          !read ||
          retryDelay > 2000 ||
          !(
            [429, 502, 503, 504].includes(upstream) ||
            [...timeoutCodes, "ECONNRESET"].includes(error.code)
          )
        )
          throw error;
        await delay(retryDelay);
        response = await send();
      }
    } catch (error) {
      rememberRateLimit(error);
      this.lastResponseStatus = httpStatus(error);
      const code =
        failureCodes[this.lastResponseStatus] ||
        (timeoutCodes.includes(error.code)
          ? "ABEX_TIMEOUT"
          : "ABEX_UNAVAILABLE");
      const fields =
        code === "ABEX_VALIDATION"
          ? validationFields(error.response?.data)
          : [];
      // A timeout, dropped connection or 5xx says nothing about whether ABEX
      // processed the request. A read can simply be repeated. A write must be
      // verified first and is never repeated automatically.
      const unknownOutcome = ["ABEX_TIMEOUT", "ABEX_UNAVAILABLE"].includes(code);
      const base = abexError(code).message;
      const failure = abexError(code, {
        ...(fields.length
          ? {
              message: `${base} Review ${fields.join(", ")}.`,
              fields,
              field: fields.map((label) => fieldForLabel[label]).find(Boolean),
            }
          : {}),
        ...(unknownOutcome
          ? {
              retryable: read,
              reconcile: !read,
              action: read ? "RETRY_LATER" : "VERIFY_SHIPMENT",
            }
          : {}),
      });
      // Provider bodies may echo parcel data or credentials. Store only the
      // status, our error code, and labels from the allowlist.
      const traceId = providerTraceId(error.response?.data);
      failure.providerData = {
        status: this.lastResponseStatus,
        code,
        ...(fields.length ? { fields } : {}),
        ...(traceId ? { traceId } : {}),
      };
      throw failure;
    }
    this.lastResponseStatus = response.status;
    if (!accepted.includes(response.status)) throw abexResponseError();
    return raw
      ? { status: response.status, data: response.data }
      : response.data;
  }

  async #page(resource, criteria) {
    const page = await this.#request("POST", `${root}/${resource}/search`, {
      data: criteria,
    });
    if (
      !page ||
      page.pageNumber !== criteria.pageNumber ||
      page.pageSize !== criteria.pageSize ||
      !Number.isInteger(page.totalCount) ||
      page.totalCount < 0 ||
      typeof page.hasNext !== "boolean" ||
      !(
        Array.isArray(page.items) ||
        (page.items === null && page.totalCount === 0)
      ) ||
      (page.items?.length || 0) > Math.min(page.pageSize, page.totalCount) ||
      page.hasNext !== page.totalCount > page.pageNumber * page.pageSize
    )
      throw abexResponseError();
    return { items: page.items || [], hasNext: page.hasNext };
  }

  async testCredentials() {
    // This checks supplier parcel access for the configured tenant and works
    // without exposing profile data or assuming API keys can read user profiles.
    const page = await this.#page("parcels", { pageNumber: 1, pageSize: 1 });
    for (const row of page.items)
      abexParcel(row, (value) => this.sanitize(value));
    return true;
  }

  #configuredDestinations(wilayaId) {
    return (this.#settings.destinations || [])
      .filter((row) => row.wilayaId === String(wilayaId))
      .map((row) => ({ ...row, name: row.commune }));
  }

  async #territories(wilayaCode) {
    if (!/^\d{1,3}$/.test(String(wilayaCode))) return [];
    const code = Number(wilayaCode);
    const load = async () => {
      const cities = await this.#allPages("territories", {
        advancedFilter: { field: "code", operator: "eq", value: code },
      });
      const wilayas = cities.filter(
        (row) => row?.level === "wilaya" && row.code === code && !row.parentId,
      );
      if (wilayas.length !== 1) return [];
      const parent = wilayas[0];
      if (!isAbexId(parent.id)) throw abexResponseError();
      const districts = await this.#allPages("territories", {
        advancedFilter: { field: "parentId", operator: "eq", value: parent.id },
      });
      return districts
        .filter(
          (row) =>
            row?.parentId === parent.id &&
            row.level === "commune" &&
            isAbexId(row.id) &&
            typeof row.name === "string" &&
            row.name.trim(),
        )
        .map((row) =>
          this.sanitize({
            name: row.name,
            nameArabic: row.nameArabic,
            cityTerritoryId: parent.id,
            districtTerritoryId: row.id,
            home: row.delivery?.hasHomeDelivery === true,
            pickup: row.delivery?.hasPickupPoint === true,
            // DeliveryCapability.canSend is published without a description.
            // It is reported to administrators and never used to block a
            // destination, because its meaning for a destination is unverified.
            canSend: row.delivery?.canSend,
          }),
        );
    };
    if (!this.#agencyVersion) return load();
    return cachedCatalog(
      territoryCache,
      `${this.#agencyVersion}:${code}`,
      load,
    );
  }

  // Every ABEX hub that can receive pickup-point parcels right now.
  async #pickupHubs() {
    const load = async () => {
      const rows = await this.#allPages("hubs");
      if (rows.some((row) => !isAbexId(row?.id))) throw abexResponseError();
      return rows
        .map(pickupHub)
        .filter(Boolean)
        .map((hub) => this.sanitize(hub));
    };
    if (!this.#agencyVersion) return load();
    return cachedCatalog(hubCache, this.#agencyVersion, load);
  }

  // Resolves a CRM wilaya and commune to ABEX territory UUIDs. An
  // administrator's mapping wins. Otherwise the commune must match exactly one
  // child of the wilaya in the live ABEX catalog and offer the delivery type.
  async #destination({ wilayaId, agencyId, commune }, deliveryType) {
    const configured = findAbexCommune(
      this.#configuredDestinations(wilayaId),
      commune,
    );
    if (configured) return { ...configured, source: "MAPPING" };
    const rows = await this.#territories(agencyId);
    const offers = (row) => (deliveryType === "HOME" ? row.home : row.pickup);
    const match = findAbexCommune(rows.filter(offers), commune);
    if (match) return { ...match, source: "CATALOG" };
    const known = findAbexCommune(rows, commune);
    if (!known) return undefined;
    const alternative =
      deliveryType === "HOME"
        ? known.pickup && "STOP_DESK"
        : known.home && "HOME";
    throw abexError("ABEX_DELIVERY_UNSUPPORTED", {
      message: `ABEX does not offer ${
        deliveryType === "HOME" ? "home delivery" : "pickup-point delivery"
      } in "${known.name}". ${
        alternative
          ? `Switch to ${alternative === "HOME" ? "home delivery" : "stop desk"} or choose another commune.`
          : "Choose another commune."
      }`,
      ...(alternative ? { alternative } : {}),
    });
  }

  async communeOptions(wilaya, deliveryType) {
    const configured = this.#configuredDestinations(wilaya._id);
    const rows = (await this.#territories(wilaya.agencyId)).filter((row) =>
      deliveryType === "HOME" ? row.home : row.pickup,
    );
    const options = new Map();
    for (const row of rows)
      if (findAbexCommune(rows, row.name) === row)
        options.set(row.name, { name: row.name, nameArabic: row.nameArabic });
    for (const row of configured)
      if (
        !options.has(row.name) &&
        (deliveryType === "HOME" || isAbexId(row.hubId))
      )
        options.set(row.name, { name: row.name });
    return [...options.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "fr"),
    );
  }

  // Pickup offices a user may choose for a stop-desk order to this commune.
  async pickupHubOptions(wilaya, commune) {
    const none = (resolution) => ({
      resolution,
      suggestedHubId: null,
      mappingStale: false,
      hubs: [],
    });
    let destination;
    try {
      destination = await this.#destination(
        { wilayaId: wilaya._id, agencyId: wilaya.agencyId, commune },
        "STOP_DESK",
      );
    } catch (error) {
      if (error.code !== "ABEX_DELIVERY_UNSUPPORTED") throw error;
      return none("UNSUPPORTED");
    }
    if (!destination) return none("TERRITORY_UNRESOLVED");
    return describePickupHubs({
      hubs: await this.#pickupHubs(),
      destination,
      configuredHubId: destination.hubId,
    });
  }

  // Builds the POST /parcels body. Local checks run first, then the territory
  // is resolved, then (pickup-point only) the hub is verified against the
  // live ABEX hub list. Home delivery never looks up or requires a hub.
  async prepareShipment(order) {
    requireAbexWrites();
    validateAbexOrder(order);
    const { wilayaId, agencyId, commune } = order.location;
    const destination = await this.#destination(
      { wilayaId, agencyId, commune },
      order.delivery.type,
    );
    const pickup =
      destination && order.delivery.type === "STOP_DESK"
        ? choosePickupHub({
            hubs: await this.#pickupHubs(),
            destination,
            selectedHubId: order.delivery.pickupHubId,
            configuredHubId: destination.hubId,
          })
        : undefined;
    const payload = mapAbexOrder(
      order,
      this.#settings,
      destination && { ...destination, hubId: pickup?.hub.id },
    );
    if (pickup)
      Object.defineProperty(payload, ABEX_PAYLOAD_META, {
        value: {
          hubId: pickup.hub.id,
          hubName: pickup.hub.name,
          hubSource: pickup.source,
        },
      });
    return payload;
  }

  // Checks every administrator mapping against the live ABEX catalog.
  // `wilayas` are the CRM wilayas ({ _id, agencyId, name }).
  async verifyDestinations(wilayas) {
    const destinations = this.#settings.destinations || [];
    const hubs = destinations.some((row) => row.hubId)
      ? await this.#pickupHubs()
      : [];
    const results = [];
    for (const row of destinations) {
      const wilaya = wilayas.find((entry) => String(entry._id) === row.wilayaId);
      const territories = wilaya ? await this.#territories(wilaya.agencyId) : [];
      const live = territories.find(
        (entry) => entry.districtTerritoryId.toLowerCase() === row.districtTerritoryId,
      );
      const hub = row.hubId
        ? hubs.find((entry) => entry.id === row.hubId)
        : undefined;
      const issues = [];
      if (!wilaya) issues.push("WILAYA_MISSING");
      else if (!territories.length) issues.push("WILAYA_UNRESOLVED");
      else if (
        territories[0].cityTerritoryId.toLowerCase() !== row.cityTerritoryId
      )
        issues.push("CITY_MISMATCH");
      else if (!live) issues.push("COMMUNE_NOT_IN_WILAYA");
      if (row.hubId && !hub) issues.push("HUB_UNAVAILABLE");
      else if (hub && hub.cityTerritoryId !== row.cityTerritoryId)
        issues.push("HUB_OTHER_WILAYA");
      results.push({
        wilayaId: row.wilayaId,
        wilayaName: wilaya?.name,
        commune: row.commune,
        abexCommune: live?.name,
        home: live?.home,
        pickup: live?.pickup,
        canSend: live?.canSend,
        hubId: row.hubId,
        hubName: hub?.name,
        status: issues.includes("WILAYA_UNRESOLVED")
          ? "UNVERIFIED"
          : issues.length
            ? "STALE"
            : "OK",
        issues,
      });
    }
    return results;
  }

  // Turns an administrator's choice into a verified mapping row. Territory
  // UUIDs always come from the live catalog under the CRM wilaya, and the hub
  // must be an active pickup office in that same wilaya.
  async resolveDestinationMapping(wilaya, { commune, districtTerritoryId, hubId }) {
    const territories = await this.#territories(wilaya.agencyId);
    abexAssert(territories.length, "ABEX_MAPPING_INVALID", {
      field: "wilayaId",
      message: `ABEX has no wilaya with code ${wilaya.agencyId}.`,
    });
    const match = districtTerritoryId
      ? territories.find(
          (row) => row.districtTerritoryId.toLowerCase() === districtTerritoryId,
        )
      : findAbexCommune(territories, commune);
    abexAssert(match, "ABEX_MAPPING_INVALID", {
      field: "commune",
      message: `ABEX has no commune matching "${commune}" in ${wilaya.name}.`,
    });
    let hub;
    if (hubId) {
      hub = pickupHubCandidates(await this.#pickupHubs(), match).wilayaHubs.find(
        (entry) => entry.id === hubId,
      );
      abexAssert(hub, "ABEX_MAPPING_INVALID", {
        field: "hubId",
        message: `That hub is not an active ABEX pickup office in ${wilaya.name}.`,
      });
    }
    return {
      wilayaId: String(wilaya._id),
      commune,
      cityTerritoryId: match.cityTerritoryId.toLowerCase(),
      districtTerritoryId: match.districtTerritoryId.toLowerCase(),
      ...(hub ? { hubId: hub.id } : {}),
    };
  }

  async createShipment(payload) {
    let parcel;
    try {
      // The public specification documents 200 for POST /parcels. 201 is
      // accepted as well because earlier account testing observed it.
      const data = await this.#request("POST", ABEX_CREATE_PATH, {
        data: payload,
        status: [200, 201],
        read: false,
      });
      parcel = abexParcel(data, (value) => this.sanitize(value));
      if (
        (parcel.externalId && parcel.externalId !== payload.externalId) ||
        (parcel.tracking && !safeTracking(parcel.tracking)) ||
        (data.amount != null && data.amount !== payload.amount)
      )
        throw abexResponseError();
    } catch (error) {
      if (error.code === "ABEX_INVALID_RESPONSE")
        error.providerData = {
          status: this.lastResponseStatus,
          code: error.code,
        };
      throw error;
    }
    if (parcel.tracking && !parcel.externalId)
      return this.getShipment({
        tracking: parcel.tracking,
        externalId: payload.externalId,
        providerParcelId: parcel.parcelId,
      });
    return parcel;
  }

  // POST /parcels/bulk for up to 100 prepared payloads. Sent once and never
  // retried. The order workflow does not use it: it reserves and creates one
  // parcel per order. A caller must hold a durable reservation for every
  // parcel first, and must reconcile each UNKNOWN result (and every parcel
  // when this method throws) by external reference before trying again.
  async createShipmentsBulk(payloads) {
    assert(
      Array.isArray(payloads) &&
        payloads.length >= 1 &&
        payloads.length <= ABEX_BULK_LIMIT,
      `ABEX accepts 1 to ${ABEX_BULK_LIMIT} parcels per bulk request.`,
    );
    const references = payloads.map((payload) => payload?.externalId);
    assert(
      references.every((value) => typeof value === "string" && value.trim()) &&
        new Set(references).size === references.length,
      "Every bulk parcel needs its own order reference.",
    );
    const { status, data } = await this.#request("POST", ABEX_BULK_CREATE_PATH, {
      data: { parcels: payloads },
      status: [200, 207, 400],
      read: false,
      raw: true,
    });
    return parseAbexBulkResult(status, data, payloads, (value) =>
      this.sanitize(value),
    );
  }

  async #allPages(resource, criteria = {}) {
    const items = [];
    for (let pageNumber = 1; pageNumber <= 10; pageNumber++) {
      const page = await this.#page(resource, {
        ...criteria,
        pageNumber,
        pageSize: 100,
      });
      items.push(...page.items);
      if (!page.hasNext) return items;
    }
    throw new AppError(
      "ABEX lookup returned too many results. Use the courier portal to verify the record.",
      409,
      "ABEX_LOOKUP_LIMIT",
    );
  }

  async findShipment(externalId, providerParcelId, expectedAmount) {
    const rows = await this.#allPages("parcels", { keyword: externalId });
    const matches = rows.filter(
      (row) =>
        row?.externalId === externalId &&
        (!providerParcelId || row.id?.toLowerCase() === providerParcelId),
    );
    assert(
      matches.length <= 1,
      "Multiple ABEX parcels match this order. Reconcile with the courier portal.",
      409,
      "ABEX_CONFLICT",
    );
    if (!matches.length) return null;
    const parcel = abexParcel(matches[0], (value) => this.sanitize(value));
    if (!parcel.tracking) return null;
    return this.getShipment({
      tracking: parcel.tracking,
      externalId,
      providerParcelId: parcel.parcelId,
      expectedAmount,
    });
  }

  async #getWorkflows() {
    this.#workflows ??= this.#allPages("workflows")
      .then((items) =>
        items.map((workflow) => {
          if (
            !isAbexId(workflow?.id) ||
            this.sanitize(workflow.id) !== workflow.id ||
            (workflow.states != null && !Array.isArray(workflow.states)) ||
            workflow.states?.some(
              (state) =>
                !isAbexId(state?.id) ||
                (state.situations != null &&
                  !Array.isArray(state.situations)) ||
                (state.transitions != null &&
                  !Array.isArray(state.transitions)),
            )
          )
            throw abexResponseError();
          return { ...workflow, states: workflow.states || [] };
        }),
      )
      .catch((error) => {
        this.#workflows = undefined;
        throw error;
      });
    return this.#workflows;
  }

  async getShipment(reference) {
    assert(
      safeTracking(reference.tracking),
      "Invalid ABEX tracking number.",
      409,
      "ABEX_INVALID_TRACKING",
    );
    const data = await this.#request(
      "GET",
      `${root}/parcels/${encodeURIComponent(reference.tracking)}`,
    );
    const parcel = abexParcel(data, (value) => this.sanitize(value));
    requireAbexIdentity(parcel, reference);
    if (data.tenantId != null && data.tenantId !== this.#credentials.tenantId)
      throw new AppError(
        "ABEX returned a parcel from a different tenant.",
        409,
        "ABEX_IDENTITY_MISMATCH",
      );
    assert(
      reference.expectedAmount === undefined ||
        data.amount === reference.expectedAmount,
      "ABEX parcel collection amount could not be verified against the order.",
      409,
      "ABEX_AMOUNT_MISMATCH",
    );
    if (parcel.stateId && this.#settings.states?.length) {
      const { workflow, normalizedStatus } = abexState(
        this.#settings,
        await this.#getWorkflows(),
        parcel,
      );
      parcel.workflowId = workflow?.id;
      parcel.normalizedStatus = normalizedStatus;
    }
    return parcel;
  }

  async confirmReadiness(reference, reserveWrite) {
    const current = await this.getShipment(reference);
    const expectedAt =
      reference.pendingReadinessAt || reference.providerUpdatedAt;
    const fresh = (parcel) =>
      parcel.providerUpdatedAt &&
      (!expectedAt || +parcel.providerUpdatedAt >= +expectedAt);
    assert(
      fresh(current),
      "ABEX parcel state is stale or has no timestamp. Refresh before marking ready.",
      409,
    );
    if (reference.pendingReadinessStateId) {
      assert(
        current.stateId === reference.pendingReadinessStateId &&
          current.normalizedStatus === "READY_TO_SHIP" &&
          +current.providerUpdatedAt > +expectedAt,
        "ABEX readiness is still unverified. Check the courier portal and refresh tracking.",
        409,
      );
      return current;
    }
    assert(
      current.normalizedStatus === "PREPARING",
      "ABEX requires a verified preparation state before marking ready. Review the agency workflow mapping.",
      409,
    );
    assert(
      !current.stateLocked,
      "ABEX reports that the current state is locked or blocking. Review it in the courier portal.",
      409,
    );
    assert(
      +current.providerUpdatedAt !== +reference.providerUpdatedAt ||
        (current.stateId === reference.providerStateId &&
          current.providerSituationId === reference.providerSituationId),
      "ABEX reported conflicting states at the same time. Refresh tracking before marking ready.",
      409,
    );
    const { workflow, state } = abexState(
      this.#settings,
      await this.#getWorkflows(),
      current,
    );
    const targets =
      workflow?.states.filter(
        (target) =>
          this.#settings.states.some(
            (entry) =>
              entry.workflowId === workflow.id &&
              entry.stateId === target.id &&
              !entry.situationId &&
              entry.status === "READY_TO_SHIP",
          ) &&
          state.transitions?.some(
            (edge) =>
              edge.fromStateId === state.id && edge.toStateId === target.id,
          ) &&
          Array.isArray(target.requirements) &&
          target.requirements.length === 0,
      ) || [];
    assert(
      targets.length === 1,
      "ABEX does not expose a verified readiness transition for this parcel. Check the agency workflow.",
      409,
    );
    requireAbexWrites();
    const targetId = targets[0].id;
    await reserveWrite(targetId, current.providerUpdatedAt);
    // An error from PATCH can be ambiguous. Only a fresh read of the linked
    // parcel can confirm the result, and the state request is sent once.
    let updateError;
    try {
      const result = await this.#request(
        "PATCH",
        `${root}/parcels/${current.parcelId}/state`,
        {
          data: { parcelId: current.parcelId, newStateId: targetId },
          read: false,
        },
      );
      if (
        result?.parcelId !== current.parcelId ||
        result?.newStateId !== targetId ||
        (result.trackingNumber != null &&
          result.trackingNumber !== current.tracking)
      )
        updateError = abexResponseError();
    } catch (error) {
      updateError = error;
    }
    const confirmed = await this.getShipment(reference);
    if (
      confirmed.stateId !== targetId ||
      confirmed.normalizedStatus !== "READY_TO_SHIP" ||
      confirmed.workflowId !== current.workflowId ||
      !(+confirmed.providerUpdatedAt > +current.providerUpdatedAt)
    )
      throw (
        updateError ||
        new AppError(
          "ABEX readiness is unconfirmed. Refresh tracking before retrying.",
          502,
          "ABEX_READINESS_UNCONFIRMED",
        )
      );
    return confirmed;
  }

  async getRates({ toTerritoryId, fromTerritoryId, hubStockId } = {}) {
    assert(
      [toTerritoryId, fromTerritoryId, hubStockId].every(
        (id) => id === undefined || isAbexId(id),
      ),
      "Rates require ABEX territory or stock UUIDs.",
    );
    let result;
    try {
      result = await this.#request(
        "GET",
        `${root}/delivery-pricing/rates${toTerritoryId ? "/" + toTerritoryId : ""}`,
        {
          params: { fromTerritoryId, hubStockId },
        },
      );
    } catch (error) {
      // Documented: 404 when the supplier has no price assignment.
      if (error.code !== "ABEX_NOT_FOUND") throw error;
      const missing = abexError("ABEX_PRICING_NOT_FOUND");
      missing.providerData = error.providerData;
      throw missing;
    }
    const rows = toTerritoryId ? [result] : result?.rates;
    if (
      !Array.isArray(rows) ||
      rows.some(
        (row) =>
          !isAbexId(row?.toTerritoryId) ||
          !Array.isArray(row.deliveryPrices) ||
          row.deliveryPrices.some(
            (price) =>
              !Number.isFinite(price?.price) ||
              typeof price.deliveryType !== "string",
          ),
      )
    )
      throw abexResponseError();
    if (toTerritoryId && rows[0].toTerritoryId !== toTerritoryId)
      throw abexResponseError();
    return rows.map((row) =>
      this.sanitize({
        territoryId: row.toTerritoryId,
        name: row.toTerritoryName,
        prices: row.deliveryPrices.map(
          ({
            deliveryType,
            price,
            discountedPrice,
            priceTtc,
            discountedPriceTtc,
          }) => ({
            deliveryType,
            price,
            discountedPrice,
            priceTtc,
            discountedPriceTtc,
          }),
        ),
      }),
    );
  }

  async getCatalog(catalog, criteria) {
    assert(abexCatalogs.includes(catalog), "Unknown ABEX catalog.");
    if (catalog === "stock-origins") {
      const data = await this.#request(
        "GET",
        `${root}/delivery-pricing/rates/stock-origins`,
      );
      if (
        !Array.isArray(data?.origins) ||
        data.origins.some(
          (row) => !isAbexId(row?.hubStockId) || !isAbexId(row.fromTerritoryId),
        )
      )
        throw abexResponseError();
      return {
        items: data.origins.map(
          ({ hubStockId, hubStockName, fromTerritoryId }) =>
            this.sanitize({ hubStockId, hubStockName, fromTerritoryId }),
        ),
        hasNext: false,
      };
    }
    const page = await this.#page(catalog, criteria);
    if (page.items.some((row) => !isAbexId(row?.id))) throw abexResponseError();
    return {
      hasNext: page.hasNext,
      items: page.items.map((row) =>
        this.sanitize({
          id: row.id,
          name: row.name,
          ...(catalog === "territories"
            ? {
                code: row.code,
                level: row.level,
                parentId: row.parentId,
                delivery: row.delivery,
              }
            : {}),
          ...(catalog === "hubs"
            ? {
                isPickupPoint: row.isPickupPoint,
                isVisible: row.isVisible,
                cityTerritoryId: row.address?.cityTerritoryId,
                districtTerritoryId: row.address?.districtTerritoryId,
              }
            : {}),
          ...(catalog === "products" ? { sku: row.sku } : {}),
          ...(catalog === "workflows" ? { states: row.states } : {}),
        }),
      ),
    };
  }
}
