import { abexAssert, abexError } from "./abexErrors.js";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const id = (value) =>
  typeof value === "string" && uuid.test(value) ? value.toLowerCase() : undefined;
const text = (value) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;

// Maps a SupplierHubResponse to the fields the CRM needs. Returns null for a
// hub that cannot receive pickup-point parcels: not flagged isPickupPoint,
// hidden (isVisible false), or without a usable address territory.
export function pickupHub(row) {
  const hubId = id(row?.id);
  const cityTerritoryId = id(row?.address?.cityTerritoryId);
  const districtTerritoryId = id(row?.address?.districtTerritoryId);
  if (
    !hubId ||
    row.isPickupPoint !== true ||
    row.isVisible === false ||
    !cityTerritoryId ||
    !districtTerritoryId
  )
    return null;
  const district = text(row.address.district);
  return {
    id: hubId,
    name: text(row.name) || district || "ABEX office",
    type: text(row.type),
    cityTerritoryId,
    districtTerritoryId,
    city: text(row.address.city),
    district,
    street: text(row.address.street),
    openingHours: text(row.openingHours),
    // Parcels handed to an external carrier can have provider-side limits.
    externalCarrier: Boolean(row.externalCarrierKey),
  };
}

export function pickupHubCandidates(hubs, destination) {
  const city = id(destination?.cityTerritoryId);
  const district = id(destination?.districtTerritoryId);
  const wilayaHubs = city
    ? hubs.filter((hub) => hub.cityTerritoryId === city)
    : [];
  return {
    wilayaHubs,
    communeHubs: wilayaHubs.filter((hub) => hub.districtTerritoryId === district),
  };
}

// Picks the pickup hub for a pickup-point parcel. Precedence:
//   1. the office chosen on the order,
//   2. the administrator's mapping for the commune,
//   3. the only pickup office located in the destination commune.
// Explicit choices are still checked against the live ABEX hub list, and a hub
// from another wilaya is never accepted. Anything ambiguous is returned to the
// user as a choice. No hub is ever guessed.
export function choosePickupHub({
  hubs,
  destination,
  selectedHubId,
  configuredHubId,
}) {
  const { wilayaHubs, communeHubs } = pickupHubCandidates(hubs, destination);
  if (selectedHubId) {
    const hub = wilayaHubs.find((entry) => entry.id === id(selectedHubId));
    abexAssert(hub, "ABEX_HUB_INVALID");
    return { hub, source: "ORDER" };
  }
  if (configuredHubId) {
    const hub = wilayaHubs.find((entry) => entry.id === id(configuredHubId));
    abexAssert(hub, "ABEX_HUB_MAPPING_STALE");
    return { hub, source: "MAPPING" };
  }
  if (communeHubs.length === 1) return { hub: communeHubs[0], source: "COMMUNE" };
  abexAssert(wilayaHubs.length > 0, "ABEX_HUB_REQUIRED", {
    alternative: "HOME",
  });
  throw abexError(
    "ABEX_HUB_SELECTION_REQUIRED",
    communeHubs.length
      ? {}
      : {
          message:
            "ABEX has no pickup office inside this commune. Choose one of the offices in the wilaya on the order, or switch to home delivery.",
          messageAr:
            "لا يوجد مكتب ABEX داخل هذه البلدية. اختر أحد مكاتب الولاية في الطلب أو غيّر إلى التوصيل للمنزل.",
          alternative: "HOME",
        },
  );
}

// Shape returned to the order form and the mapping screen.
export function describePickupHubs({ hubs, destination, configuredHubId }) {
  const { wilayaHubs, communeHubs } = pickupHubCandidates(hubs, destination);
  const configured = configuredHubId
    ? wilayaHubs.find((hub) => hub.id === id(configuredHubId))
    : undefined;
  const suggested =
    configured || (communeHubs.length === 1 ? communeHubs[0] : undefined);
  const inCommune = new Set(communeHubs.map((hub) => hub.id));
  return {
    resolution: suggested
      ? configured
        ? "MAPPED"
        : "UNIQUE"
      : wilayaHubs.length
        ? "CHOICE_REQUIRED"
        : "NONE",
    suggestedHubId: suggested?.id ?? null,
    mappingStale: Boolean(configuredHubId && !configured),
    hubs: wilayaHubs
      .map((hub) => ({
        id: hub.id,
        name: hub.name,
        district: hub.district,
        street: hub.street,
        openingHours: hub.openingHours,
        inCommune: inCommune.has(hub.id),
      }))
      .sort(
        (a, b) =>
          Number(b.inCommune) - Number(a.inCommune) ||
          a.name.localeCompare(b.name, "fr"),
      ),
  };
}
