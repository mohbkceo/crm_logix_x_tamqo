// ABEX integration layer tests. No database and no network: every ABEX call
// goes through a mocked axios instance, so no real parcel can be created.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import {
  AbexClient,
  clearAbexCatalogCache,
} from "../src/services/delivery/abexClient.js";
import {
  ABEX_PAYLOAD_META,
  abexOrderSnapshot,
  mapAbexOrder,
  parseAbexBulkResult,
} from "../src/services/delivery/abexMapper.js";
import {
  abexErrorCodes,
  abexError,
  publicErrorDetails,
  shipmentErrorInfo,
} from "../src/services/delivery/abexErrors.js";
import { choosePickupHub, pickupHub } from "../src/services/delivery/abexHubs.js";
import { abexSituationObservation } from "./fixtures/abexWebhooks.js";

const uuid = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = {
  alger: uuid(1),
  oran: uuid(2),
  centre: uuid(11),
  babElOued: uuid(12),
  hydra: uuid(13),
  kouba: uuid(14),
  oranCentre: uuid(21),
  foreignParent: uuid(90),
  hubCentre: uuid(101),
  hubHydraA: uuid(102),
  hubHydraB: uuid(103),
  hubNotPickup: uuid(104),
  hubHidden: uuid(105),
  parcel: uuid(500),
  parcel2: uuid(501),
};
const credentials = { apiKey: "unit-abex-key", tenantId: "unit-abex-tenant" };
const wilayaAlger = { _id: "64a000000000000000000016", agencyId: "16", name: "Alger" };
const wilayaOran = { _id: "64a000000000000000000031", agencyId: "31", name: "Oran" };

const page = (items, criteria) => ({
  status: 200,
  data: {
    items,
    pageNumber: criteria.pageNumber,
    pageSize: criteria.pageSize,
    totalCount: items.length,
    totalPages: 1,
    hasPrevious: false,
    hasNext: false,
  },
});
const httpError = (status, data = { detail: credentials.apiKey }) =>
  Object.assign(new Error(credentials.apiKey), { response: { status, data } });
const networkError = (code) => Object.assign(new Error(credentials.apiKey), { code });

const commune = (id, name, parentId, delivery) => ({
  id,
  code: 1600 + Number(id.slice(-2)),
  name,
  level: "commune",
  parentId,
  delivery,
});
const territories = {
  16: {
    wilaya: { id: ids.alger, code: 16, name: "Alger", level: "wilaya", parentId: null },
    communes: [
      commune(ids.centre, "Alger Centre", ids.alger, {
        hasHomeDelivery: true,
        hasPickupPoint: true,
        canSend: true,
      }),
      commune(ids.babElOued, "Bab El Oued", ids.alger, {
        hasHomeDelivery: true,
        hasPickupPoint: false,
        canSend: true,
      }),
      commune(ids.hydra, "Hydra", ids.alger, {
        hasHomeDelivery: false,
        hasPickupPoint: true,
        canSend: false,
      }),
      commune(ids.kouba, "Kouba", ids.alger, {
        hasHomeDelivery: true,
        hasPickupPoint: true,
        canSend: true,
      }),
      // Returned by a careless filter: belongs to another parent.
      commune(uuid(91), "Foreign commune", ids.foreignParent, {
        hasHomeDelivery: true,
        hasPickupPoint: true,
      }),
    ],
  },
  31: {
    wilaya: { id: ids.oran, code: 31, name: "Oran", level: "wilaya", parentId: null },
    communes: [
      commune(ids.oranCentre, "Oran", ids.oran, {
        hasHomeDelivery: true,
        hasPickupPoint: true,
        canSend: true,
      }),
    ],
  },
};
const hub = (id, name, cityTerritoryId, districtTerritoryId, extra = {}) => ({
  id,
  name,
  type: "agency",
  isPickupPoint: true,
  isVisible: true,
  isReturnCenter: false,
  address: { cityTerritoryId, districtTerritoryId, city: "Alger", district: name },
  ...extra,
});
const defaultHubs = () => [
  hub(ids.hubCentre, "Agence Alger Centre", ids.alger, ids.centre),
  hub(ids.hubHydraA, "Agence Hydra A", ids.alger, ids.hydra),
  hub(ids.hubHydraB, "Agence Hydra B", ids.alger, ids.hydra),
  hub(ids.hubNotPickup, "Centre de tri", ids.alger, ids.centre, {
    isPickupPoint: false,
  }),
  hub(ids.hubHidden, "Agence fermée", ids.alger, ids.centre, {
    isVisible: false,
  }),
];

// Installs a fake ABEX behind axios.create and returns its controls.
function fakeAbex(t, { settings = {}, agencyVersion, creds = credentials } = {}) {
  const previous = process.env.ABEX_WRITES_ENABLED;
  process.env.ABEX_WRITES_ENABLED = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.ABEX_WRITES_ENABLED;
    else process.env.ABEX_WRITES_ENABLED = previous;
  });
  const abex = { requests: [], hubs: defaultHubs(), handlers: {} };
  const urls = () => abex.requests.map((req) => `${req.method} ${req.url}`);
  t.mock.method(axios, "create", (config) => ({
    defaults: config,
    request: async (req) => {
      abex.requests.push(req);
      assert.equal(config.baseURL, "https://app.abex.clawdyatms.app");
      assert.equal(req.headers["X-Api-Key"], creds.apiKey);
      assert.equal(req.headers["X-Tenant"], creds.tenantId);
      const custom = abex.handlers[`${req.method} ${req.url}`];
      if (custom) return custom(req);
      if (req.url === "/api/v1/territories/search") {
        const filter = req.data.advancedFilter;
        assert.equal(filter.operator, "eq");
        if (filter.field === "code") {
          const entry = territories[filter.value];
          return page(entry ? [entry.wilaya] : [], req.data);
        }
        assert.equal(filter.field, "parentId");
        const entry = Object.values(territories).find(
          ({ wilaya }) => wilaya.id === filter.value,
        );
        return page(entry.communes, req.data);
      }
      if (req.url === "/api/v1/hubs/search") return page(abex.hubs, req.data);
      if (req.url === "/api/v1/parcels" && req.method === "POST")
        return {
          status: 200,
          data: {
            id: ids.parcel,
            trackingNumber: "ABX-UNIT-1",
            externalId: req.data.externalId,
            amount: req.data.amount,
          },
        };
      throw new Error(`Unexpected ABEX request ${req.method} ${req.url}`);
    },
  }));
  const client = new AbexClient({ credentials: creds, settings, agencyVersion });
  return { abex, client, urls };
}

const order = (overrides = {}) => ({
  orderNumber: "ORD-2026-000777",
  revision: 0,
  status: "NEW",
  note: "",
  customer: { name: "Amine Test", phoneA: "0550 12 34 56", phoneB: "" },
  payment: { amountToCollect: 3000 },
  items: [
    {
      type: "PRODUCT",
      business: "LOGIX",
      catalogItemId: "64b000000000000000000001",
      name: "Plaque 15cm",
      unitPrice: 2500,
      quantity: 1,
      specifications: "",
    },
  ],
  ...overrides,
  location: {
    wilayaId: wilayaAlger._id,
    wilayaName: "Alger",
    agencyId: "16",
    commune: "Alger Centre",
    address: "12 Rue Didouche Mourad",
    ...overrides.location,
  },
  delivery: { type: "HOME", exchange: false, ...overrides.delivery },
});
const desk = (commune, delivery = {}) =>
  order({ location: { commune }, delivery: { type: "STOP_DESK", ...delivery } });

async function rejection(promise, code) {
  const error = await promise.then(
    () => assert.fail(`Expected ${code}`),
    (failure) => failure,
  );
  assert.equal(error.code, code, error.message);
  assert.equal(
    JSON.stringify([error.message, error.details, error.providerData]).includes(
      credentials.apiKey,
    ),
    false,
    "provider secrets must never reach an error",
  );
  return error;
}

beforeEach(() => clearAbexCatalogCache());

test("home delivery builds a home parcel and never looks up or requires a pickup hub", async (t) => {
  const { abex, client, urls } = fakeAbex(t);
  // A broken hub catalog must not affect home delivery.
  abex.handlers["POST /api/v1/hubs/search"] = () => {
    throw httpError(500);
  };
  const payload = await client.prepareShipment(order());
  assert.equal(payload.deliveryType, "home");
  assert.equal("hubId" in payload, false);
  assert.equal(payload[ABEX_PAYLOAD_META], undefined);
  assert.deepEqual(payload.deliveryAddress, {
    cityTerritoryId: ids.alger,
    districtTerritoryId: ids.centre,
    street: "12 Rue Didouche Mourad",
  });
  assert.equal(payload.externalId, "ORD-2026-000777");
  assert.equal(payload.customer.phone.number1, "+213550123456");
  assert.equal(payload.amount, 3000);
  assert.deepEqual(urls(), [
    "POST /api/v1/territories/search",
    "POST /api/v1/territories/search",
  ]);
  // Home delivery to a commune without any pickup office also works.
  const second = await client.prepareShipment(
    order({ location: { commune: "Bab El Oued" } }),
  );
  assert.equal(second.deliveryAddress.districtTerritoryId, ids.babElOued);
  assert.equal(urls().includes("POST /api/v1/hubs/search"), false);
});

test("pickup-point delivery sends the verified ABEX hub UUID of the only office in the commune", async (t) => {
  const { client, urls } = fakeAbex(t);
  const payload = await client.prepareShipment(desk("Alger Centre"));
  assert.equal(payload.deliveryType, "pickup-point");
  assert.equal(payload.hubId, ids.hubCentre);
  assert.equal(payload.deliveryAddress.cityTerritoryId, ids.alger);
  assert.equal(payload.deliveryAddress.districtTerritoryId, ids.centre);
  assert.deepEqual(payload[ABEX_PAYLOAD_META], {
    hubId: ids.hubCentre,
    hubName: "Agence Alger Centre",
    hubSource: "COMMUNE",
  });
  // The internal details never travel to ABEX.
  assert.equal(JSON.stringify(payload).includes("hubName"), false);
  assert.deepEqual(urls(), [
    "POST /api/v1/territories/search",
    "POST /api/v1/territories/search",
    "POST /api/v1/hubs/search",
  ]);
});

test("a missing pickup hub is reported with an actionable, structured error", async (t) => {
  const { client } = fakeAbex(t);
  // Oran offers pickup-point delivery but has no pickup office.
  const error = await rejection(
    client.prepareShipment(
      order({
        location: { wilayaId: wilayaOran._id, wilayaName: "Oran", agencyId: "31", commune: "Oran" },
        delivery: { type: "STOP_DESK" },
      }),
    ),
    "ABEX_HUB_REQUIRED",
  );
  assert.equal(error.status, 409);
  assert.equal(error.details.field, "pickupHubId");
  assert.equal(error.details.retryable, false);
  assert.equal(error.details.alternative, "HOME");
  assert.match(error.details.messageAr, /ABEX/);
  assert.match(error.message, /Choose an available office or change the delivery method/);
});

test("multiple eligible hubs require a choice and the chosen office is used", async (t) => {
  const { client } = fakeAbex(t);
  const error = await rejection(
    client.prepareShipment(desk("Hydra")),
    "ABEX_HUB_SELECTION_REQUIRED",
  );
  assert.equal(error.details.action, "CHOOSE_PICKUP_HUB");
  assert.equal(error.details.field, "pickupHubId");

  const chosen = await client.prepareShipment(
    desk("Hydra", { pickupHubId: ids.hubHydraB.toUpperCase() }),
  );
  assert.equal(chosen.hubId, ids.hubHydraB);
  assert.equal(chosen[ABEX_PAYLOAD_META].hubSource, "ORDER");

  // No office inside Kouba: an office elsewhere in the wilaya is offered,
  // never selected silently.
  const outside = await rejection(
    client.prepareShipment(desk("Kouba")),
    "ABEX_HUB_SELECTION_REQUIRED",
  );
  assert.match(outside.message, /no pickup office inside this commune/);
  assert.equal(outside.details.alternative, "HOME");

  const options = await client.pickupHubOptions(wilayaAlger, "Hydra");
  assert.equal(options.resolution, "CHOICE_REQUIRED");
  assert.equal(options.suggestedHubId, null);
  assert.deepEqual(
    options.hubs.map(({ id, inCommune }) => [id, inCommune]),
    [
      [ids.hubHydraA, true],
      [ids.hubHydraB, true],
      [ids.hubCentre, false],
    ],
  );
  const unique = await client.pickupHubOptions(wilayaAlger, "Alger Centre");
  assert.equal(unique.resolution, "UNIQUE");
  assert.equal(unique.suggestedHubId, ids.hubCentre);
  assert.equal(
    (await client.pickupHubOptions(wilayaAlger, "Bab El Oued")).resolution,
    "UNSUPPORTED",
  );
  assert.equal(
    (await client.pickupHubOptions(wilayaAlger, "Nowhere")).resolution,
    "TERRITORY_UNRESOLVED",
  );
});

test("invalid, hidden, foreign and stale pickup hubs are rejected before any parcel request", async (t) => {
  const mapped = {
    destinations: [
      {
        wilayaId: wilayaAlger._id,
        commune: "Alger Centre",
        cityTerritoryId: ids.alger,
        districtTerritoryId: ids.centre,
        hubId: ids.hubCentre,
      },
    ],
  };
  const { abex, client, urls } = fakeAbex(t, { settings: mapped });
  // A verified mapping is used, with no territory lookup.
  const payload = await client.prepareShipment(desk("Alger Centre"));
  assert.equal(payload.hubId, ids.hubCentre);
  assert.equal(payload[ABEX_PAYLOAD_META].hubSource, "MAPPING");
  assert.deepEqual(urls(), ["POST /api/v1/hubs/search"]);

  for (const pickupHubId of [ids.hubNotPickup, ids.hubHidden, uuid(999)])
    await rejection(
      client.prepareShipment(desk("Alger Centre", { pickupHubId })),
      "ABEX_HUB_INVALID",
    );
  // A pickup office of another wilaya cannot be attached to this destination.
  abex.hubs.push(hub(uuid(150), "Agence Oran", ids.oran, ids.oranCentre));
  await rejection(
    client.prepareShipment(desk("Alger Centre", { pickupHubId: uuid(150) })),
    "ABEX_HUB_INVALID",
  );
  // The mapped office was closed at ABEX: the mapping is reported as stale.
  abex.hubs = abex.hubs.filter((entry) => entry.id !== ids.hubCentre);
  const stale = await rejection(
    client.prepareShipment(desk("Alger Centre")),
    "ABEX_HUB_MAPPING_STALE",
  );
  assert.equal(stale.details.action, "UPDATE_HUB_MAPPING");
  assert.equal(urls().includes("POST /api/v1/parcels"), false);
});

test("unsupported wilayas, communes and delivery modes are rejected with the right code", async (t) => {
  const { client, urls } = fakeAbex(t);
  const unknownWilaya = await rejection(
    client.prepareShipment(
      order({ location: { agencyId: "99", wilayaName: "Nowhere" } }),
    ),
    "ABEX_TERRITORY_REQUIRED",
  );
  assert.match(unknownWilaya.message, /could not verify "Alger Centre" in Nowhere/);
  assert.equal(unknownWilaya.details.field, "commune");
  // A commune that belongs to another parent territory is never accepted.
  await rejection(
    client.prepareShipment(order({ location: { commune: "Foreign commune" } })),
    "ABEX_TERRITORY_REQUIRED",
  );
  await rejection(
    client.prepareShipment(order({ location: { agencyId: "sixteen" } })),
    "ABEX_TERRITORY_REQUIRED",
  );
  const noHome = await rejection(
    client.prepareShipment(order({ location: { commune: "Hydra" } })),
    "ABEX_DELIVERY_UNSUPPORTED",
  );
  assert.equal(noHome.details.alternative, "STOP_DESK");
  assert.equal(noHome.details.field, "deliveryType");
  assert.match(noHome.details.messageAr, /خدمة التوصيل/);
  const noDesk = await rejection(
    client.prepareShipment(desk("Bab El Oued")),
    "ABEX_DELIVERY_UNSUPPORTED",
  );
  assert.equal(noDesk.details.alternative, "HOME");
  await rejection(
    client.prepareShipment(order({ delivery: { type: "LOCKER" } })),
    "ABEX_DELIVERY_UNSUPPORTED",
  );
  await rejection(
    client.prepareShipment(order({ delivery: { exchange: true } })),
    "ABEX_EXCHANGE_UNSUPPORTED",
  );
  assert.equal(urls().includes("POST /api/v1/parcels"), false);
});

test("territory mappings are resolved from the live catalog and cross-wilaya mappings are refused", async (t) => {
  const settings = {
    destinations: [
      {
        wilayaId: wilayaAlger._id,
        commune: "Alger Centre",
        cityTerritoryId: ids.alger,
        districtTerritoryId: ids.centre,
        hubId: ids.hubCentre,
      },
      {
        // Commune of Oran stored under Alger.
        wilayaId: wilayaAlger._id,
        commune: "Wrong parent",
        cityTerritoryId: ids.alger,
        districtTerritoryId: ids.oranCentre,
      },
      {
        // Stored against the wrong ABEX wilaya, with a hub that left ABEX.
        wilayaId: wilayaOran._id,
        commune: "Oran",
        cityTerritoryId: ids.alger,
        districtTerritoryId: ids.oranCentre,
        hubId: uuid(777),
      },
    ],
  };
  const { client } = fakeAbex(t, { settings });
  const report = await client.verifyDestinations([wilayaAlger, wilayaOran]);
  assert.deepEqual(
    report.map(({ commune, status, issues }) => [commune, status, issues]),
    [
      ["Alger Centre", "OK", []],
      ["Wrong parent", "STALE", ["COMMUNE_NOT_IN_WILAYA"]],
      ["Oran", "STALE", ["CITY_MISMATCH", "HUB_UNAVAILABLE"]],
    ],
  );
  assert.equal(report[0].hubName, "Agence Alger Centre");
  assert.equal(report[0].canSend, true);

  // Saving a mapping: UUIDs come from ABEX, not from the caller.
  assert.deepEqual(
    await client.resolveDestinationMapping(wilayaAlger, {
      commune: "alger centre",
      hubId: ids.hubCentre,
    }),
    {
      wilayaId: wilayaAlger._id,
      commune: "alger centre",
      cityTerritoryId: ids.alger,
      districtTerritoryId: ids.centre,
      hubId: ids.hubCentre,
    },
  );
  // An alias for a CRM spelling, pointed at an ABEX commune of the same wilaya.
  const alias = await client.resolveDestinationMapping(wilayaAlger, {
    commune: "BEO",
    districtTerritoryId: ids.babElOued,
  });
  assert.equal(alias.districtTerritoryId, ids.babElOued);
  assert.equal("hubId" in alias, false);
  for (const [input, field] of [
    [{ commune: "Oran" }, "commune"],
    [{ commune: "X", districtTerritoryId: ids.oranCentre }, "commune"],
    [{ commune: "Alger Centre", hubId: ids.hubNotPickup }, "hubId"],
  ]) {
    const error = await rejection(
      client.resolveDestinationMapping(wilayaAlger, input),
      "ABEX_MAPPING_INVALID",
    );
    assert.equal(error.details.field, field);
  }
  const error = await rejection(
    client.resolveDestinationMapping(
      { _id: "64a000000000000000000099", agencyId: "99", name: "Nowhere" },
      { commune: "Anything" },
    ),
    "ABEX_MAPPING_INVALID",
  );
  assert.equal(error.details.field, "wilayaId");
});

test("invalid customer and parcel data is rejected locally with the field to fix", async (t) => {
  const { client, urls } = fakeAbex(t);
  for (const [overrides, field] of [
    [{ customer: { name: " ", phoneA: "0550123456" } }, "customerName"],
    [{ customer: { name: "Amine", phoneA: "" } }, "phoneA"],
    [{ customer: { name: "Amine", phoneA: "021 12 34 56" } }, "phoneA"],
    [{ customer: { name: "Amine", phoneA: "0550123456", phoneB: "123" } }, "phoneB"],
    [{ location: { address: "   " } }, "address"],
    [{ payment: { amountToCollect: -1 } }, "amount"],
    [{ payment: { amountToCollect: Number.NaN } }, "amount"],
    [{ items: [{ type: "PRODUCT", name: "Plaque", unitPrice: 10, quantity: 0 }] }, "items"],
    [{ items: [{ type: "PRODUCT", name: "Plaque", unitPrice: 10, quantity: 1.5 }] }, "items"],
    [{ items: [{ type: "PRODUCT", name: "", unitPrice: 10, quantity: 1 }] }, "items"],
    [{ orderNumber: "" }, "orderNumber"],
  ]) {
    const error = await rejection(
      client.prepareShipment(order(overrides)),
      "ABEX_ORDER_INVALID",
    );
    assert.equal(error.details.field, field);
    assert.equal(error.details.action, "EDIT_ORDER");
  }
  // Nothing reached ABEX.
  assert.deepEqual(urls(), []);
  // A stop-desk parcel does not need a street address.
  const pickup = await client.prepareShipment(
    order({ location: { address: "" }, delivery: { type: "STOP_DESK" } }),
  );
  assert.equal("street" in pickup.deliveryAddress, false);
});

test("payloads follow the documented ABEX contract", () => {
  const destination = { cityTerritoryId: ids.alger.toUpperCase(), districtTerritoryId: ids.centre };
  const mappedProduct = uuid(300);
  const base = order({ customer: { name: " Amine Test ", phoneA: "+213 550 12 34 56", phoneB: "0661 00 11 22" } });
  const manual = mapAbexOrder(base, {}, destination);
  assert.deepEqual(Object.keys(manual).sort(), [
    "amount",
    "customer",
    "deliveryAddress",
    "deliveryType",
    "description",
    "externalId",
    "orderedProducts",
  ]);
  assert.deepEqual(manual.customer, {
    name: "Amine Test",
    phone: { number1: "+213550123456", number2: "+213661001122" },
  });
  assert.equal(manual.deliveryAddress.cityTerritoryId, ids.alger);
  assert.deepEqual(manual.orderedProducts, [
    { productName: "Plaque 15cm", unitPrice: 0, quantity: 1, stockType: "none" },
  ]);
  const stocked = mapAbexOrder(
    base,
    { products: { "64b000000000000000000001": mappedProduct } },
    destination,
  );
  // One stock mode per parcel: all "local" or all "none", never "warehouse".
  assert.deepEqual(stocked.orderedProducts, [
    {
      productId: mappedProduct,
      productName: "Plaque 15cm",
      unitPrice: 2500,
      quantity: 1,
      stockType: "local",
    },
  ]);
  assert.equal("hubStockId" in stocked, false);
  // Local numeric wilaya or commune codes are never sent as identifiers.
  assert.throws(
    () => mapAbexOrder(base, {}, { cityTerritoryId: "16", districtTerritoryId: "1601" }),
    { code: "ABEX_TERRITORY_REQUIRED" },
  );
  assert.throws(
    () => mapAbexOrder(desk("Alger Centre"), {}, destination),
    { code: "ABEX_HUB_REQUIRED" },
  );
  assert.throws(
    () => mapAbexOrder(desk("Alger Centre"), {}, { ...destination, hubId: "12" }),
    { code: "ABEX_HUB_REQUIRED" },
  );
  // Changing the pickup office changes the parcel; it is ignored for home delivery.
  const snapshot = (delivery) => JSON.stringify(abexOrderSnapshot(order({ delivery })));
  assert.notEqual(
    snapshot({ type: "STOP_DESK", pickupHubId: ids.hubHydraA }),
    snapshot({ type: "STOP_DESK", pickupHubId: ids.hubHydraB }),
  );
  assert.equal(
    snapshot({ type: "HOME", pickupHubId: ids.hubHydraA }),
    snapshot({ type: "HOME" }),
  );
});

test("parcel creation accepts the documented 200 and the observed 201, once", async (t) => {
  for (const status of [200, 201]) {
    const { abex, client, urls } = fakeAbex(t);
    const payload = await client.prepareShipment(order());
    abex.handlers["POST /api/v1/parcels"] = (req) => ({
      status,
      data: {
        id: ids.parcel,
        trackingNumber: "ABX-UNIT-1",
        externalId: req.data.externalId,
        deliveryPrice: 400,
        returnPrice: 0,
        amount: req.data.amount,
      },
    });
    const parcel = await client.createShipment(payload);
    assert.equal(parcel.parcelId, ids.parcel);
    assert.equal(parcel.tracking, "ABX-UNIT-1");
    assert.equal(parcel.externalId, payload.externalId);
    assert.equal(urls().filter((url) => url === "POST /api/v1/parcels").length, 1);
    t.mock.restoreAll();
  }
});

test("every provider failure maps to a stable code with retry guidance and no secrets", async (t) => {
  const { abex, client, urls } = fakeAbex(t);
  const payload = await client.prepareShipment(order());
  const creates = () => urls().filter((url) => url === "POST /api/v1/parcels").length;
  for (const [fail, code, status, expected] of [
    [() => httpError(400), "ABEX_VALIDATION", 422, { retryable: false, reconcile: false }],
    [() => httpError(422), "ABEX_VALIDATION", 422, { retryable: false, reconcile: false }],
    [() => httpError(401), "ABEX_AUTHENTICATION", 502, { action: "CHECK_CREDENTIALS" }],
    [() => httpError(403), "ABEX_PERMISSION", 502, { action: "CHECK_CREDENTIALS" }],
    [() => httpError(404), "ABEX_NOT_FOUND", 404, { retryable: false }],
    // Documented: external reference reused within 12 hours.
    [() => httpError(409), "ABEX_CONFLICT", 409, { reconcile: true, retryable: false }],
    [() => httpError(500), "ABEX_UNAVAILABLE", 502, { reconcile: true, retryable: false }],
    [() => httpError(503), "ABEX_UNAVAILABLE", 502, { reconcile: true, retryable: false }],
    [() => networkError("ECONNABORTED"), "ABEX_TIMEOUT", 504, { reconcile: true, retryable: false }],
    [() => networkError("ETIMEDOUT"), "ABEX_TIMEOUT", 504, { reconcile: true, retryable: false }],
    [() => networkError("ECONNRESET"), "ABEX_UNAVAILABLE", 502, { reconcile: true, action: "VERIFY_SHIPMENT" }],
    [() => networkError("ENOTFOUND"), "ABEX_UNAVAILABLE", 502, { reconcile: true }],
  ]) {
    const before = creates();
    abex.handlers["POST /api/v1/parcels"] = () => {
      throw fail();
    };
    const error = await rejection(client.createShipment(payload), code);
    assert.equal(error.status, status);
    for (const [key, value] of Object.entries(expected))
      assert.equal(error.details[key], value, `${code}.${key}`);
    assert.ok(error.details.messageAr, `${code} needs an Arabic message`);
    assert.equal(error.providerData.code, code);
    // A parcel write is sent exactly once, whatever the failure.
    assert.equal(creates(), before + 1, `${code} must not be retried`);
  }
});

test("validation rejections name the fields without echoing provider text", async (t) => {
  const { abex, client } = fakeAbex(t);
  const payload = await client.prepareShipment(desk("Alger Centre"));
  abex.handlers["POST /api/v1/parcels"] = () => {
    throw httpError(400, {
      title: "One or more validation errors occurred.",
      traceId: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
      errors: [
        { propertyName: "hubId", description: `Hub not allowed for ${credentials.apiKey}` },
        { propertyName: "$.customer.phone.number1", description: "0550123456 is invalid" },
      ],
    });
  };
  const error = await rejection(client.createShipment(payload), "ABEX_VALIDATION");
  assert.match(error.message, /Review pickup hub, primary phone\.$/);
  assert.deepEqual(error.details.fields, ["pickup hub", "primary phone"]);
  assert.equal(error.details.field, "pickupHubId");
  assert.deepEqual(error.providerData, {
    status: 400,
    code: "ABEX_VALIDATION",
    fields: ["pickup hub", "primary phone"],
    traceId: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
  });
  assert.equal(JSON.stringify(error.providerData).includes("0550123456"), false);
});

test("rate limits pause further calls and reads are retried at most once", async (t) => {
  const { abex, client, urls } = fakeAbex(t);
  const payload = await client.prepareShipment(order());
  abex.handlers["POST /api/v1/parcels"] = () => {
    throw Object.assign(httpError(429), {
      response: { status: 429, headers: { "retry-after": "120" }, data: {} },
    });
  };
  const limited = await rejection(client.createShipment(payload), "ABEX_RATE_LIMIT");
  assert.equal(limited.status, 503);
  assert.equal(limited.details.retryable, true);
  const sent = urls().length;
  // The next call is refused locally until the quota resets.
  await rejection(client.createShipment(payload), "ABEX_RATE_LIMIT");
  assert.equal(urls().length, sent);

  const second = fakeAbex(t);
  let attempts = 0;
  second.abex.handlers["POST /api/v1/hubs/search"] = (req) => {
    attempts++;
    if (attempts === 1) throw networkError("ECONNABORTED");
    return page(second.abex.hubs, req.data);
  };
  assert.equal(
    (await second.client.prepareShipment(desk("Alger Centre"))).hubId,
    ids.hubCentre,
  );
  assert.equal(attempts, 2);
  second.abex.handlers["POST /api/v1/hubs/search"] = () => {
    attempts++;
    throw networkError("ECONNABORTED");
  };
  const timeout = await rejection(
    second.client.prepareShipment(desk("Alger Centre")),
    "ABEX_TIMEOUT",
  );
  // A failed read created nothing, so it is simply retryable.
  assert.equal(timeout.details.retryable, true);
  assert.equal(timeout.details.reconcile, false);
  assert.equal(attempts, 4);
});

test("unexpected response payloads are rejected instead of being trusted", async (t) => {
  const { abex, client } = fakeAbex(t);
  const payload = await client.prepareShipment(order());
  for (const data of [
    null,
    "<html>gateway</html>",
    { trackingNumber: "ABX-UNIT-1" },
    { id: "not-a-uuid", trackingNumber: "ABX-UNIT-1" },
    { id: ids.parcel, trackingNumber: "ABX-UNIT-1", externalId: "ORD-OTHER" },
    { id: ids.parcel, trackingNumber: "ABX-UNIT-1", externalId: payload.externalId, amount: 1 },
    { id: ids.parcel, trackingNumber: "bad/../tracking", externalId: payload.externalId },
  ]) {
    abex.handlers["POST /api/v1/parcels"] = () => ({ status: 200, data });
    const error = await rejection(client.createShipment(payload), "ABEX_INVALID_RESPONSE");
    assert.deepEqual(error.providerData, { status: 200, code: "ABEX_INVALID_RESPONSE" });
  }
  // An undocumented success status is not treated as a created parcel.
  abex.handlers["POST /api/v1/parcels"] = (req) => ({
    status: 202,
    data: { id: ids.parcel, externalId: req.data.externalId },
  });
  await rejection(client.createShipment(payload), "ABEX_INVALID_RESPONSE");

  for (const data of [
    { items: "none" },
    { items: [], pageNumber: 1, pageSize: 100, totalCount: -1, hasNext: false },
    { items: [{ id: "broken" }], pageNumber: 1, pageSize: 100, totalCount: 1, hasNext: false },
  ]) {
    abex.handlers["POST /api/v1/hubs/search"] = () => ({ status: 200, data });
    await rejection(
      client.prepareShipment(desk("Alger Centre")),
      "ABEX_INVALID_RESPONSE",
    );
  }
});

test("parcel snapshots with distinct situation UUIDs use the explicit workflow situation and still validate each identifier", async (t) => {
  const situation = abexSituationObservation();
  const workflowId = uuid(701),
    stateId = uuid(702);
  const { abex, client } = fakeAbex(t, {
    settings: {
      states: [
        { workflowId, stateId, status: "OUT_FOR_DELIVERY" },
        {
          workflowId,
          stateId,
          situationId: situation.lastStateSituationId,
          status: "FAILED_DELIVERY",
        },
        {
          workflowId,
          stateId,
          situationId: situation.situation.id,
          status: "RETURNED",
        },
      ],
    },
  });
  let data = {
    id: ids.parcel,
    trackingNumber: "ABX-UNIT-1",
    externalId: "ORD-FIXTURE",
    state: { id: stateId, name: "Fixture out for delivery" },
    lastStateUpdateAt: "2026-01-02T00:00:00Z",
    ...situation,
  };
  abex.handlers["GET /api/v1/parcels/ABX-UNIT-1"] = () => ({
    status: 200,
    data,
  });
  abex.handlers["POST /api/v1/workflows/search"] = (req) =>
    page(
      [
        {
          id: workflowId,
          states: [
            {
              id: stateId,
              situations: [
                { id: situation.lastStateSituationId },
                { id: situation.situation.id },
              ],
            },
          ],
        },
      ],
      req.data,
    );
  const reference = {
    tracking: "ABX-UNIT-1",
    externalId: "ORD-FIXTURE",
    providerParcelId: ids.parcel,
  };
  const parcel = await client.getShipment(reference);
  assert.equal(parcel.providerSituationId, situation.lastStateSituationId);
  assert.equal(parcel.normalizedStatus, "FAILED_DELIVERY");
  assert.equal(
    parcel.providerUpdatedAt.toISOString(),
    "2026-01-03T00:00:00.123Z",
  );
  const original = data;
  for (const invalid of [
    { situation: { id: "invalid" } },
    { lastStateSituationId: "invalid" },
    { situation: { id: { $ne: null } } },
    { lastSituationUpdateAt: "invalid" },
  ]) {
    data = { ...original, ...invalid };
    await rejection(client.getShipment(reference), "ABEX_INVALID_RESPONSE");
  }
});

test("standard ABEX state names map without per-agency UUID mappings and explicit mappings still win", async (t) => {
  const stateId = uuid(711);
  const reference = {
    tracking: "ABX-UNIT-2",
    externalId: "ORD-FIXTURE",
    providerParcelId: ids.parcel,
  };
  const parcelWith = (name) => ({
    id: ids.parcel,
    trackingNumber: "ABX-UNIT-2",
    externalId: "ORD-FIXTURE",
    state: { id: stateId, name },
    lastStateUpdateAt: "2026-01-02T00:00:00Z",
  });
  const { abex, client, urls } = fakeAbex(t);
  let data;
  abex.handlers["GET /api/v1/parcels/ABX-UNIT-2"] = () => ({ status: 200, data });
  for (const [name, status] of [
    ["sortie_en_livraison", "OUT_FOR_DELIVERY"],
    ["en_livraison", "SHIPPED"],
    ["dispatch", "SHIPPED"],
    ["livre", "DELIVERED"],
    ["encaisse", "DELIVERED"],
    ["recupere_par_fournisseur", "RETURNED"],
  ]) {
    data = parcelWith(name);
    const parcel = await client.getShipment(reference);
    assert.equal(parcel.normalizedStatus, status, name);
    assert.equal(parcel.statusAcknowledged, true);
  }
  data = parcelWith("commande_recue");
  const received = await client.getShipment(reference);
  assert.equal(received.normalizedStatus, undefined);
  assert.equal(received.statusAcknowledged, true);
  data = parcelWith("unlisted_state");
  const unknown = await client.getShipment(reference);
  assert.equal(unknown.normalizedStatus, undefined);
  assert.equal(unknown.statusAcknowledged, undefined);
  // No workflow catalog read is needed for the built-in fallback.
  assert.ok(urls().every((url) => !url.includes("workflows")));

  const workflowId = uuid(712);
  const explicit = fakeAbex(t, {
    settings: { states: [{ workflowId, stateId, status: "FAILED_DELIVERY" }] },
  });
  explicit.abex.handlers["GET /api/v1/parcels/ABX-UNIT-2"] = () => ({
    status: 200,
    data: parcelWith("livre"),
  });
  explicit.abex.handlers["POST /api/v1/workflows/search"] = (req) =>
    page([{ id: workflowId, states: [{ id: stateId }] }], req.data);
  const mapped = await explicit.client.getShipment(reference);
  assert.equal(mapped.normalizedStatus, "FAILED_DELIVERY");
  assert.equal(mapped.statusAcknowledged, undefined);
});

test("authentication and tenant configuration problems stop before or at the first request", async (t) => {
  const missing = fakeAbex(t, { creds: {} });
  const notConfigured = await rejection(
    missing.client.prepareShipment(order()),
    "DELIVERY_NOT_CONFIGURED",
  );
  assert.equal(notConfigured.status, 503);
  assert.deepEqual(missing.urls(), []);
  await rejection(
    fakeAbex(t, { creds: { apiKey: "key with spaces", tenantId: "tenant" } }).client.testCredentials(),
    "DELIVERY_NOT_CONFIGURED",
  );

  const { abex, client } = fakeAbex(t);
  abex.handlers["POST /api/v1/territories/search"] = () => {
    throw httpError(401);
  };
  const rejected = await rejection(client.prepareShipment(order()), "ABEX_AUTHENTICATION");
  assert.equal(rejected.details.action, "CHECK_CREDENTIALS");
  abex.handlers["POST /api/v1/territories/search"] = () => {
    throw httpError(403);
  };
  await rejection(client.prepareShipment(order()), "ABEX_PERMISSION");

  process.env.ABEX_WRITES_ENABLED = "false";
  const paused = await rejection(client.prepareShipment(order()), "DELIVERY_NOT_CONFIGURED");
  assert.match(paused.message, /writes are disabled/);
  assert.equal(paused.details.action, "CONTACT_ADMIN");
});

test("a missing delivery price assignment is reported as such", async (t) => {
  const { abex, client } = fakeAbex(t);
  abex.handlers[`GET /api/v1/delivery-pricing/rates/${ids.alger}`] = () => {
    throw httpError(404, { title: "Not Found", status: 404 });
  };
  const error = await rejection(
    client.getRates({ toTerritoryId: ids.alger }),
    "ABEX_PRICING_NOT_FOUND",
  );
  assert.equal(error.status, 404);
  assert.deepEqual(error.providerData, { status: 404, code: "ABEX_NOT_FOUND" });
  abex.handlers[`GET /api/v1/delivery-pricing/rates/${ids.alger}`] = () => ({
    status: 200,
    data: {
      toTerritoryId: ids.alger,
      toTerritoryName: "Alger",
      deliveryPrices: [
        { deliveryType: "home", price: 600 },
        { deliveryType: "pickup-point", price: 400 },
      ],
    },
  });
  const [rate] = await client.getRates({ toTerritoryId: ids.alger });
  assert.deepEqual(
    rate.prices.map(({ deliveryType, price }) => [deliveryType, price]),
    [
      ["home", 600],
      ["pickup-point", 400],
    ],
  );
  await assert.rejects(client.getRates({ toTerritoryId: "16" }), /UUID/);
});

test("the hub catalog is cached per agency version and isolated between agencies", async (t) => {
  const first = fakeAbex(t, { agencyVersion: "agency-a:1" });
  await first.client.prepareShipment(desk("Alger Centre"));
  await first.client.prepareShipment(desk("Alger Centre"));
  const hubCalls = (urls) => urls().filter((url) => url === "POST /api/v1/hubs/search").length;
  assert.equal(hubCalls(first.urls), 1);
  t.mock.restoreAll();

  // Another agency (another ABEX tenant) never reuses that hub list.
  const other = fakeAbex(t, {
    agencyVersion: "agency-b:1",
    creds: { apiKey: "other-key", tenantId: "other-tenant" },
  });
  other.abex.hubs = [];
  await rejection(
    other.client.prepareShipment(desk("Alger Centre")),
    "ABEX_HUB_REQUIRED",
  );
  assert.equal(hubCalls(other.urls), 1);
  t.mock.restoreAll();

  // Saving the agency changes its version, which drops the cached catalog.
  const updated = fakeAbex(t, { agencyVersion: "agency-a:2" });
  await updated.client.prepareShipment(desk("Alger Centre"));
  assert.equal(hubCalls(updated.urls), 1);
});

test("bulk creation reports every parcel individually for 200, 207 and 400", async (t) => {
  const { abex, client, urls } = fakeAbex(t);
  const payloads = [];
  for (const [index, commune] of ["Alger Centre", "Kouba", "Bab El Oued"].entries())
    payloads.push(
      await client.prepareShipment(
        order({ orderNumber: `ORD-2026-00090${index}`, location: { commune } }),
      ),
    );
  const success = (index) => ({
    index,
    parcelId: uuid(600 + index),
    trackingNumber: `ABX-BULK-${index}`,
    externalId: payloads[index].externalId,
    amount: payloads[index].amount,
  });
  const failure = (index) => ({
    index,
    errorCode: "Parcel_InvalidTerritory",
    errorMessage: `Rejected for ${credentials.apiKey}`,
    externalId: payloads[index].externalId,
  });
  const respond = (status, data) => {
    abex.handlers["POST /api/v1/parcels/bulk"] = (req) => {
      assert.deepEqual(req.data, { parcels: payloads });
      return { status, data };
    };
  };

  respond(200, { totalRequested: 3, successCount: 3, failureCount: 0, successes: [0, 1, 2].map(success), failures: [] });
  const complete = await client.createShipmentsBulk(payloads);
  assert.equal(complete.status, "COMPLETE");
  assert.deepEqual(complete.results.map((row) => row.outcome), ["CREATED", "CREATED", "CREATED"]);
  assert.equal(complete.results[2].tracking, "ABX-BULK-2");

  respond(207, { totalRequested: 3, successCount: 2, failureCount: 1, successes: [success(0), success(2)], failures: [failure(1)] });
  const partial = await client.createShipmentsBulk(payloads);
  assert.equal(partial.status, "PARTIAL");
  assert.deepEqual(partial.results.map((row) => row.outcome), ["CREATED", "FAILED", "CREATED"]);
  assert.equal(partial.results[0].parcelId, uuid(600));
  assert.equal(partial.results[1].errorCode, "Parcel_InvalidTerritory");
  assert.equal(JSON.stringify(partial).includes(credentials.apiKey), false);

  respond(400, { totalRequested: 3, successCount: 0, failureCount: 3, successes: [], failures: [0, 1, 2].map(failure) });
  const failed = await client.createShipmentsBulk(payloads);
  assert.equal(failed.status, "FAILED");
  assert.ok(failed.results.every((row) => row.outcome === "FAILED"));

  // A plain 400 problem response: the request was refused as a whole.
  respond(400, { title: "Bad Request", status: 400 });
  assert.equal((await client.createShipmentsBulk(payloads)).status, "FAILED");

  // "200" that does not account for every parcel is not a complete batch.
  respond(200, { successes: [success(0)], failures: [] });
  const missing = await client.createShipmentsBulk(payloads);
  assert.equal(missing.status, "RECONCILE");
  assert.deepEqual(missing.results.map((row) => row.outcome), ["CREATED", "UNKNOWN", "UNKNOWN"]);
  // "207" whose entries are all successes contradicts itself.
  respond(207, { successes: [0, 1, 2].map(success), failures: [] });
  assert.equal((await client.createShipmentsBulk(payloads)).status, "RECONCILE");

  for (const data of [
    null,
    { successes: [{ ...success(0), index: 7 }], failures: [] },
    { successes: [success(0), success(0)], failures: [] },
    { successes: [{ ...success(0), externalId: "ORD-OTHER" }], failures: [] },
    { successes: [{ ...success(0), parcelId: "nope" }], failures: [] },
    { successes: [{ ...success(0), amount: 1 }], failures: [] },
    { successes: [success(0)], failures: [failure(0)] },
  ]) {
    respond(200, data);
    await rejection(client.createShipmentsBulk(payloads), "ABEX_INVALID_RESPONSE");
  }
  // A lost bulk response leaves every parcel to be reconciled; nothing is re-sent.
  const before = urls().length;
  abex.handlers["POST /api/v1/parcels/bulk"] = () => {
    throw networkError("ECONNABORTED");
  };
  const timeout = await rejection(client.createShipmentsBulk(payloads), "ABEX_TIMEOUT");
  assert.equal(timeout.details.reconcile, true);
  assert.equal(urls().length, before + 1);

  await assert.rejects(client.createShipmentsBulk([]), /1 to 100 parcels/);
  await assert.rejects(client.createShipmentsBulk(Array(101).fill(payloads[0])), /1 to 100 parcels/);
  await assert.rejects(client.createShipmentsBulk([payloads[0], payloads[0]]), /own order reference/);
  assert.equal(
    parseAbexBulkResult(207, { successes: [success(1)], failures: [failure(0), failure(2)] }, payloads).status,
    "PARTIAL",
  );
});

test("hub selection is deterministic and never guesses", () => {
  const hubs = defaultHubs().map(pickupHub).filter(Boolean);
  assert.deepEqual(
    hubs.map((entry) => entry.id),
    [ids.hubCentre, ids.hubHydraA, ids.hubHydraB],
  );
  assert.equal(pickupHub({ id: ids.hubCentre, isPickupPoint: true, address: {} }), null);
  assert.equal(pickupHub({ id: "x", isPickupPoint: true }), null);
  const centre = { cityTerritoryId: ids.alger, districtTerritoryId: ids.centre };
  assert.equal(choosePickupHub({ hubs, destination: centre }).hub.id, ids.hubCentre);
  // The order's choice wins over the mapping, and both are verified.
  assert.equal(
    choosePickupHub({
      hubs,
      destination: centre,
      selectedHubId: ids.hubHydraA,
      configuredHubId: ids.hubCentre,
    }).hub.id,
    ids.hubHydraA,
  );
  assert.throws(
    () => choosePickupHub({ hubs, destination: { cityTerritoryId: ids.oran, districtTerritoryId: ids.oranCentre } }),
    { code: "ABEX_HUB_REQUIRED" },
  );
  assert.throws(
    () => choosePickupHub({ hubs: [], destination: centre, configuredHubId: ids.hubCentre }),
    { code: "ABEX_HUB_MAPPING_STALE" },
  );
});

test("structured errors expose only allowlisted, client-safe details", () => {
  for (const code of abexErrorCodes) {
    const error = abexError(code);
    assert.ok(error.message && error.status >= 400, code);
    assert.ok(error.details.messageAr, `${code} needs Arabic text`);
    assert.equal(typeof error.details.retryable, "boolean");
    assert.ok(error.details.action, `${code} needs a next step`);
  }
  const error = abexError("ABEX_HUB_REQUIRED");
  error.details.internal = { apiKey: credentials.apiKey };
  assert.deepEqual(Object.keys(publicErrorDetails(error)).sort(), [
    "action",
    "field",
    "messageAr",
    "reconcile",
    "retryable",
  ]);
  assert.deepEqual(shipmentErrorInfo(error, "stored text"), {
    code: "ABEX_HUB_REQUIRED",
    message: "stored text",
    ...publicErrorDetails(error),
  });
  assert.equal(shipmentErrorInfo(new Error("boom")), undefined);
  assert.deepEqual(publicErrorDetails(new Error("boom")), {});
});
