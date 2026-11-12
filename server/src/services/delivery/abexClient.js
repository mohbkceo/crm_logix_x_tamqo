import axios from "axios";
import { setTimeout as delay } from "node:timers/promises";
import { AppError, assert } from "../../errors.js";
import { sanitizeProviderData, validTracking } from "./deliveryMapper.js";
import { findAbexCommune } from "../../../../shared/abexTerritories.js";
import {
  ABEX_CREATE_PATH,
  ABEX_HOST,
  abexParcel,
  abexResponseError,
  abexState,
  isAbexId,
  mapAbexOrder,
  requireAbexIdentity,
  requireAbexWrites,
} from "./abexMapper.js";

const root = "/api/v1";
const failures = {
  400: [422, "ABEX_VALIDATION", "ABEX rejected the parcel data."],
  401: [
    502,
    "ABEX_AUTHENTICATION",
    "ABEX rejected the credentials. Check or rotate the API credentials.",
  ],
  403: [
    502,
    "ABEX_PERMISSION",
    "ABEX denied access. Check the tenant and supplier role.",
  ],
  404: [404, "ABEX_NOT_FOUND", "ABEX could not find the requested record."],
  409: [
    409,
    "ABEX_CONFLICT",
    "ABEX reported a conflict. Verify the parcel in the courier portal.",
  ],
  422: [422, "ABEX_VALIDATION", "ABEX rejected the parcel data."],
  429: [
    503,
    "ABEX_RATE_LIMIT",
    "ABEX rate limit reached. Try again after the quota resets.",
  ],
};
const httpStatus = (error) => error.response?.status;
const validationLabels = [
  [/\b(?:stock\s*type|stock\s*mode|type de stock)\b/i, "stock type"],
  [/\bproduct\s*id\b/i, "ABEX product ID"],
  [
    /\b(?:ordered\s*products|product\s*name|products?\s*description|parcel contents)\b/i,
    "parcel contents",
  ],
  [/\b(?:number1|primary phone)\b/i, "primary phone"],
  [/\b(?:number2|secondary phone)\b/i, "secondary phone"],
  [/\b(?:phone(?:\s*number)?|mobile|téléphone)\b/i, "customer phone"],
  [
    /\b(?:delivery\s*address|city\s*territory\s*id|district\s*territory\s*id|wilaya|commune|postal\s*code|street)\b/i,
    "delivery address",
  ],
  [/\b(?:hub\s*id|pickup point)\b/i, "pickup hub"],
  [/\b(?:delivery\s*type)\b/i, "delivery type"],
  [
    /\b(?:amount|collection\s*amount|montant)\b|^ExternalCarrier_AmountAboveCarrierLimit$/i,
    "collection amount",
  ],
  [/\b(?:weight|dimensional\s*weight|poids)\b/i, "parcel weight"],
  [/\b(?:external\s*id|external reference)\b/i, "order reference"],
  [/\b(?:state\s*id|initial state)\b/i, "initial parcel state"],
  [/\bcustomer\b/i, "customer details"],
];

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
const territoryCacheMs = 10 * 60 * 1000;

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
    { data, params, status = 200, read = true } = {},
  ) {
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
      this.http.request({ method, url, headers, data, params });
    const rememberRateLimit = (error) => {
      if (httpStatus(error) !== 429) return;
      const seconds = Number(error.response?.headers?.["retry-after"] ?? 60);
      this.#retryAt =
        Date.now() +
        (Number.isFinite(seconds) && seconds >= 0 ? seconds : 60) * 1000;
    };
    if (Date.now() < this.#retryAt)
      throw new AppError(failures[429][2], failures[429][0], failures[429][1]);

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
            ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET"].includes(error.code)
          )
        )
          throw error;
        await delay(retryDelay);
        response = await send();
      }
    } catch (error) {
      rememberRateLimit(error);
      this.lastResponseStatus = httpStatus(error);
      const [status, code, message] =
        failures[this.lastResponseStatus] ||
        (["ECONNABORTED", "ETIMEDOUT"].includes(error.code)
          ? [
              504,
              "ABEX_TIMEOUT",
              "ABEX did not respond in time. Verify any pending parcel operation before retrying.",
            ]
          : [502, "ABEX_UNAVAILABLE", "ABEX could not complete the request."]);
      const fields =
        code === "ABEX_VALIDATION"
          ? validationFields(error.response?.data)
          : [];
      const failure = new AppError(
        fields.length ? `${message} Review ${fields.join(", ")}.` : message,
        status,
        code,
      );
      // Provider bodies may echo parcel data or credentials. Store only the
      // status, our error code, and labels from the allowlist.
      failure.providerData = {
        status: this.lastResponseStatus,
        code,
        ...(fields.length ? { fields } : {}),
      };
      throw failure;
    }
    this.lastResponseStatus = response.status;
    if (response.status !== status) throw abexResponseError();
    return response.data;
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
          }),
        );
    };
    if (!this.#agencyVersion) return load();
    const key = `${this.#agencyVersion}:${code}`;
    const existing = territoryCache.get(key);
    if (existing?.expiresAt > Date.now()) return existing.result;
    if (territoryCache.size >= 500)
      territoryCache.delete(territoryCache.keys().next().value);
    const entry = { expiresAt: Date.now() + territoryCacheMs, result: load() };
    territoryCache.set(key, entry);
    try {
      const territories = await entry.result;
      if (!territories.length && territoryCache.get(key) === entry)
        territoryCache.delete(key);
      return territories;
    } catch (error) {
      if (territoryCache.get(key) === entry) territoryCache.delete(key);
      throw error;
    }
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

  async prepareShipment(order) {
    requireAbexWrites();
    const { wilayaId, agencyId, commune } = order.location;
    const configured = findAbexCommune(
      this.#configuredDestinations(wilayaId),
      commune,
    );
    const destination =
      configured ||
      findAbexCommune(
        (await this.#territories(agencyId)).filter((row) =>
          order.delivery.type === "HOME" ? row.home : row.pickup,
        ),
        commune,
      );
    return mapAbexOrder(order, this.#settings, destination);
  }

  async createShipment(payload) {
    let parcel;
    try {
      const data = await this.#request("POST", ABEX_CREATE_PATH, {
        data: payload,
        status: 201,
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
    const result = await this.#request(
      "GET",
      `${root}/delivery-pricing/rates${toTerritoryId ? "/" + toTerritoryId : ""}`,
      {
        params: { fromTerritoryId, hubStockId },
      },
    );
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
