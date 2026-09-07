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
} from "../authorization.js";
import { assert } from "../errors.js";
import { objectId } from "../services/filters.js";
import { encryptCredentials } from "../services/delivery/credentials.js";
import { providerFor } from "../services/delivery/deliveryProviderFactory.js";
import { transaction } from "../services/orderService.js";
export const agencyRoutes = Router();
const r = agencyRoutes;
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
  apiProvider: z.enum(["PROCOLIS", "MANUAL"]).optional(),
  config: z
    .object({
      baseUrl: z.string().url().optional(),
      notes: z.string().max(2000).optional(),
    })
    .default({}),
  capabilities: z
    .object({
      createShipment: z.boolean(),
      tracking: z.boolean(),
      readyToShip: z.boolean(),
      pricing: z.boolean(),
    })
    .default({
      createShipment: true,
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
      f.businesses = {
        $not: { $elemMatch: { $nin: req.user.businessAccess } },
      };
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
  requireBusinesses(req.user, req.agency.businesses);
  next();
});
r.get("/:id", requirePermission(P.deliveryAgencies.view), (req, res) =>
  res.json(req.agency),
);
async function save(req, existing) {
  const data = schema.parse({ ...existing?.toObject(), ...req.body });
  requireBusinesses(req.user, data.businesses);
  if (
    !existing ||
    JSON.stringify(data.businesses) !== JSON.stringify(existing.businesses)
  )
    assert(
      can(req.user, P.deliveryAgencies.assignBusinesses),
      "Business assignment permission required",
      403,
    );
  if (existing && data.active !== existing.active)
    assert(
      can(req.user, P.deliveryAgencies.disable),
      "Agency status permission required",
      403,
    );
  if (data.integrationType === "API") {
    assert(data.apiProvider === "PROCOLIS", "Unsupported API provider");
    assert(
      !data.config.baseUrl ||
        data.config.baseUrl === "https://procolis.com/api_v1",
      "Only the documented Procolis base URL is supported",
    );
  } else data.apiProvider = "MANUAL";
  if (
    existing &&
    (existing.integrationType !== data.integrationType ||
      existing.apiProvider !== data.apiProvider)
  )
    assert(
      !(await Shipment.exists({ agencyId: existing._id })),
      "Cannot change provider on an agency with shipments",
      409,
    );
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
    const credentials = z
      .object({
        token: z.string().min(1).max(1000),
        key: z.string().min(1).max(1000),
      })
      .parse(req.body.credentials);
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

    assert(
      req.agency.apiProvider === "PROCOLIS",
      "Unsupported API provider",
      400,
    );

    // The provider validates per-agency credentials or the supported ABEX
    // environment fallback; credentialsConfigured alone excludes legacy setups.
    const provider = await providerFor(req.agency._id);

    assert(
      await provider.testCredentials(),
      "Procolis credentials are not activated",
      422,
    );

    res.json({
      success: true,
      integrationType: "API",
      provider: "PROCOLIS",
      message: "Procolis API connection and credentials verified successfully.",
    });
  },
);
