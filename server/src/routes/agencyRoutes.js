import { Router } from "express";
import { z } from "zod";
import { DeliveryAgency, DeliveryRate } from "../models/delivery.js";
import { Order, Shipment, Wilaya } from "../models/index.js";
import { audit } from "../models/security.js";
import {
  P,
  can,
  requirePermission,
  requireBusinesses,
  requireAnyBusiness,
} from "../authorization.js";
import { assert } from "../errors.js";
import { objectId } from "../services/filters.js";
import {
  decryptCredentials,
  encryptCredentials,
} from "../services/delivery/credentials.js";
import { providerFor } from "../services/delivery/deliveryProviderFactory.js";
import { transaction } from "../services/orderService.js";
import { STATUSES } from "../constants.js";
import { ABEX_HOST, isAbexId } from "../services/delivery/abexMapper.js";
import { abexCatalogs } from "../services/delivery/abexClient.js";
export const agencyRoutes = Router();
const r = agencyRoutes;
const abexId = z
  .string()
  .refine(isAbexId, "Expected an ABEX UUID")
  .transform((v) => v.toLowerCase());
const crmId = z.string().regex(/^[a-f0-9]{24}$/);
const header = z
  .string()
  .trim()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/, "Invalid header value");
const abexSettings = z
  .object({
    destinations: z
      .array(
        z.object({
          wilayaId: crmId,
          commune: z.string().trim().min(1).max(200),
          cityTerritoryId: abexId,
          districtTerritoryId: abexId,
          hubId: abexId.optional(),
        }),
      )
      .max(2000)
      .optional(),
    products: z.record(crmId, abexId).optional(),
    states: z
      .array(
        z.object({
          workflowId: abexId,
          stateId: abexId,
          situationId: abexId.optional(),
          status: z.enum(STATUSES),
        }),
      )
      .max(500)
      .optional(),
  })
  .superRefine(({ destinations = [], states = [] }, context) => {
    const destinationKeys = destinations.map(
      (row) => `${row.wilayaId}:${row.commune.normalize("NFC").toLowerCase()}`,
    );
    const stateKeys = states.map(
      (row) => `${row.workflowId}:${row.stateId}:${row.situationId || ""}`,
    );
    if (new Set(destinationKeys).size !== destinationKeys.length)
      context.addIssue({
        code: "custom",
        path: ["destinations"],
        message: "Duplicate wilaya and commune mapping",
      });
    if (new Set(stateKeys).size !== stateKeys.length)
      context.addIssue({
        code: "custom",
        path: ["states"],
        message: "Duplicate workflow state mapping",
      });
  });
const schema = z.object({
  name: z.string().trim().min(1).max(100),
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_-]{2,30}$/),
  active: z.boolean().default(true),
  businesses: z
    .array(z.enum(["LOGIX", "TAMQO"]))
    .min(1)
    .max(2),
  integrationType: z.enum(["API", "MANUAL"]),
  apiProvider: z.enum(["ABEX", "PROCOLIS", "MANUAL"]).optional(),
  config: z
    .object({
      baseUrl: z.string().url().optional(),
      notes: z.string().max(2000).optional(),
      abex: abexSettings.optional(),
    })
    .default({}),
  capabilities: z
    .object({
      createShipment: z.boolean(),
      updateShipment: z.boolean().optional().default(false),
      deleteShipment: z.boolean().optional().default(false),
      tracking: z.boolean(),
      readyToShip: z.boolean(),
      pricing: z.boolean(),
    })
    .default({
      createShipment: true,
      updateShipment: false,
      deleteShipment: false,
      tracking: true,
      readyToShip: true,
      pricing: true,
    }),
});
r.get(
  "/",
  requirePermission(
    P.deliveryAgencies.view,
    P.orders.create,
    P.orders.updateOwn,
    P.orders.updateAll,
  ),
  async (req, res) => {
    const f = {};
    if (req.user.role !== "SUPER_ADMIN")
      f.businesses = { $in: req.user.businessAccess };
    if (req.query.business) {
      const businesses =
        req.query.business === "PARTNERSHIP"
          ? ["LOGIX", "TAMQO"]
          : [req.query.business];
      requireBusinesses(req.user, businesses);
      f.$and = [{ businesses: { $all: businesses } }];
      f.active = true;
    }
    res.json(await DeliveryAgency.find(f).sort({ name: 1 }));
  },
);
r.param("id", async (req, _res, next, id) => {
  req.agency = await DeliveryAgency.findById(objectId(id));
  assert(req.agency, "Agency not found", 404);
  requireAnyBusiness(req.user, req.agency.businesses);
  next();
});
r.get("/:id", requirePermission(P.deliveryAgencies.view), (req, res) =>
  res.json(req.agency),
);
async function save(req, existing) {
  const data = schema.parse({ ...existing?.toObject(), ...req.body });
  const businessesChanged =
    !existing ||
    data.businesses.length !== existing.businesses.length ||
    data.businesses.some((business) => !existing.businesses.includes(business));
  if (businessesChanged) {
    requireBusinesses(
      req.user,
      existing
        ? [...new Set([...existing.businesses, ...data.businesses])]
        : data.businesses,
    );
    assert(
      can(req.user, P.deliveryAgencies.assignBusinesses),
      "Business assignment permission required",
      403,
    );
  }
  if (existing && data.active !== existing.active)
    assert(
      can(req.user, P.deliveryAgencies.disable),
      "Agency status permission required",
      403,
    );
  if (data.integrationType === "API") {
    data.apiProvider ??= "ABEX";
    assert(
      ["ABEX", "PROCOLIS"].includes(data.apiProvider),
      "Unsupported API provider",
    );
    const host =
      data.apiProvider === "ABEX" ? ABEX_HOST : "https://procolis.com/api_v1";
    assert(
      !data.config.baseUrl || data.config.baseUrl === host,
      "Only the documented provider base URL is supported",
    );
    if (data.apiProvider === "ABEX") {
      data.capabilities.updateShipment = false;
      data.capabilities.deleteShipment = false;
    }
  } else data.apiProvider = "MANUAL";
  const providerChanged = Boolean(
    existing &&
    (existing.integrationType !== data.integrationType ||
      existing.apiProvider !== data.apiProvider),
  );
  if (providerChanged)
    assert(
      !(await Shipment.exists({ agencyId: existing._id })),
      "Cannot change provider on an agency with shipments",
      409,
    );
  if (providerChanged) {
    data.encryptedCredentials = undefined;
    data.credentialsConfigured = false;
  }
  if (req.body.credentials !== undefined) {
    assert(
      can(req.user, P.deliveryAgencies.manageCredentials),
      "Credential permission required",
      403,
    );
    assert(
      data.integrationType === "API",
      "Manual agencies do not need credentials",
    );
    const credentials = (
      data.apiProvider === "ABEX"
        ? z
            .object({
              apiKey: header,
              tenantId: header.max(255),
              bearerToken: header.optional(),
            })
            .strict()
        : z.object({ token: header.max(1000), key: header.max(1000) }).strict()
    ).parse(req.body.credentials);
    if (
      data.apiProvider === "ABEX" &&
      existing &&
      !providerChanged &&
      (await Shipment.exists({
        agencyId: existing._id,
        provider: "ABEX",
        $or: [
          { creationAttemptedAt: { $ne: null } },
          { providerParcelId: { $ne: null } },
          { tracking: { $ne: null } },
        ],
      }))
    ) {
      const stored = await DeliveryAgency.findById(existing._id).select(
        "+encryptedCredentials",
      );
      let previousTenant;
      try {
        if (stored.encryptedCredentials)
          previousTenant = decryptCredentials(
            stored.encryptedCredentials,
          ).tenantId;
      } catch {
        assert(
          false,
          "Restore the delivery encryption key before rotating credentials on this agency.",
          409,
        );
      }
      assert(
        previousTenant === credentials.tenantId,
        "Keep the same ABEX tenant when rotating credentials on an agency with parcels.",
        409,
      );
    }
    data.encryptedCredentials = encryptCredentials(credentials);
    data.credentialsConfigured = true;
  }
  return transaction(async (session) => {
    const item = existing || new DeliveryAgency({ createdBy: req.actor });
    Object.assign(item, data);
    await item.save({ session });
    await audit(
      req.actor,
      existing ? "DELIVERY_AGENCY_UPDATED" : "DELIVERY_AGENCY_CREATED",
      "DeliveryAgency",
      item._id,
      undefined,
      {},
      session,
    );
    for (const [condition, action] of [
      [
        req.body.credentials !== undefined,
        "DELIVERY_AGENCY_CREDENTIALS_CHANGED",
      ],
      [
        req.body.businesses !== undefined,
        "DELIVERY_AGENCY_BUSINESS_ASSIGNMENT_CHANGED",
      ],
      [data.active === false, "DELIVERY_AGENCY_DISABLED"],
    ])
      if (condition)
        await audit(
          req.actor,
          action,
          "DeliveryAgency",
          item._id,
          undefined,
          {},
          session,
        );
    return DeliveryAgency.findById(item._id).session(session);
  });
}
r.post("/", requirePermission(P.deliveryAgencies.create), async (req, res) =>
  res.status(201).json(await save(req)),
);
r.patch("/:id", async (req, res) => {
  const keys = Object.keys(req.body);
  const specific = keys.every((k) =>
    ["credentials", "businesses", "active"].includes(k),
  );
  if (!specific)
    assert(
      can(req.user, P.deliveryAgencies.update),
      "Agency update denied",
      403,
    );
  res.json(await save(req, req.agency));
});
r.delete(
  "/:id",
  requirePermission(P.deliveryAgencies.delete),
  async (req, res) => {
    assert(
      !(await Order.exists({ "delivery.agencyId": req.agency._id })) &&
        !(await Shipment.exists({ agencyId: req.agency._id })),
      "Referenced agencies must be disabled",
      409,
    );
    await transaction(async (session) => {
      await DeliveryRate.deleteMany({ agencyId: req.agency._id }, { session });
      await DeliveryAgency.deleteOne({ _id: req.agency._id }, { session });
      await audit(
        req.actor,
        "DELIVERY_AGENCY_DELETED",
        "DeliveryAgency",
        req.agency._id,
        undefined,
        {},
        session,
      );
    });
    res.status(204).end();
  },
);
r.get(
  "/:id/rates",
  requirePermission(
    P.deliveryAgencies.view,
    P.deliveryAgencies.manageRates,
    P.orders.create,
    P.orders.updateOwn,
    P.orders.updateAll,
  ),
  async (req, res) =>
    res.json(await DeliveryRate.find({ agencyId: req.agency._id })),
);
r.get(
  "/:id/communes",
  requirePermission(
    P.deliveryAgencies.view,
    P.orders.create,
    P.orders.updateOwn,
    P.orders.updateAll,
  ),
  async (req, res) => {
    assert(
      req.agency.apiProvider === "ABEX",
      "Commune lookup requires an ABEX agency.",
      409,
    );
    const { wilayaId, deliveryType } = z
      .object({
        wilayaId: crmId,
        deliveryType: z.enum(["HOME", "STOP_DESK"]),
      })
      .strict()
      .parse(req.query);
    const wilaya = await Wilaya.findById(wilayaId).select("agencyId").lean();
    assert(wilaya, "Wilaya not found.", 404);
    const provider = await providerFor(req.agency._id);
    res.json({
      agencyId: String(req.agency._id),
      wilayaId,
      deliveryType,
      communes: await provider.communeOptions(wilaya, deliveryType),
    });
  },
);
const rateSchema = z.object({
  wilayaId: z.string(),
  homePrice: z.number().finite().min(0).max(1e8),
  deskPrice: z.number().finite().min(0).max(1e8),
  active: z.boolean().default(true),
});
async function saveRate(req, res) {
  const existing = req.params.rateId
    ? await DeliveryRate.findOne({
        _id: objectId(req.params.rateId),
        agencyId: req.agency._id,
      })
    : null;
  assert(!req.params.rateId || existing, "Rate not found", 404);
  const d = rateSchema.parse({
    ...existing?.toObject(),
    wilayaId: existing?.wilayaId?.toString(),
    ...req.body,
  });
  assert(
    await Wilaya.exists({ _id: objectId(d.wilayaId) }),
    "Wilaya not found",
    404,
  );
  const row = await transaction(async (session) => {
    const item = await DeliveryRate.findOneAndUpdate(
      existing
        ? { _id: existing._id }
        : { agencyId: req.agency._id, wilayaId: d.wilayaId },
      { $set: { ...d, agencyId: req.agency._id } },
      { upsert: !existing, new: true, runValidators: true, session },
    );
    await audit(
      req.actor,
      "DELIVERY_AGENCY_RATE_CHANGED",
      "DeliveryRate",
      item._id,
      undefined,
      {},
      session,
    );
    return item;
  });
  res.json(row);
}
r.post(
  "/:id/rates",
  requirePermission(P.deliveryAgencies.manageRates),
  saveRate,
);
r.patch(
  "/:id/rates/:rateId",
  requirePermission(P.deliveryAgencies.manageRates),
  saveRate,
);
r.get(
  "/:id/provider-rates",
  requirePermission(P.deliveryAgencies.manageRates),
  async (req, res) => {
    assert(
      req.agency.apiProvider === "ABEX",
      "Provider rates are available for ABEX agencies.",
      409,
    );
    const query = z
      .object({
        toTerritoryId: abexId.optional(),
        fromTerritoryId: abexId.optional(),
        hubStockId: abexId.optional(),
      })
      .strict()
      .parse(req.query);
    assert(
      !(query.fromTerritoryId && query.hubStockId) &&
        !(query.toTerritoryId && (query.fromTerritoryId || query.hubStockId)),
      "Choose a destination, origin territory, or stock for the rates lookup.",
    );
    const provider = await providerFor(req.agency._id, "pricing");
    res.json(await provider.getRates(query));
  },
);
r.get(
  "/:id/provider-catalog/:catalog",
  requirePermission(P.deliveryAgencies.update),
  async (req, res) => {
    assert(
      req.agency.apiProvider === "ABEX",
      "Catalogs are available for ABEX agencies.",
      409,
    );
    const catalog = z.enum(abexCatalogs).parse(req.params.catalog);
    const criteria = z
      .object({
        pageNumber: z.coerce.number().int().min(1).max(10000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
        keyword: z.string().trim().max(150).optional(),
      })
      .strict()
      .parse(req.query);
    const provider = await providerFor(req.agency._id);
    res.json(await provider.getCatalog(catalog, criteria));
  },
);
export async function verifyAgencyConnection(agency) {
  const provider = await providerFor(agency._id);
  assert(
    await provider.testCredentials(),
    "Delivery provider credentials are not active.",
    422,
  );
  return {
    success: true,
    integrationType: "API",
    provider: agency.apiProvider,
    message: `${agency.apiProvider === "ABEX" ? "ABEX TMS" : "Procolis"} connection verified.`,
  };
}
r.post(
  "/:id/test",
  requirePermission(P.deliveryAgencies.testConnection),
  async (req, res) => {
    // Manual agencies do not have an external API connection.
    if (req.agency.integrationType === "MANUAL") {
      return res.json({
        success: true,
        integrationType: "MANUAL",
        message: "Manual agency requires no API connection.",
      });
    }

    res.json(await verifyAgencyConnection(req.agency));
  },
);
