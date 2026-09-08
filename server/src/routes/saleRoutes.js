import { Router } from "express";
import { z } from "zod";
import { Sale } from "../models/index.js";
import { assert } from "../errors.js";
import { escapeRegex, objectId, pagination } from "../services/filters.js";
import { dateKey, reportingRange } from "../domain/period.js";
import {
  P,
  can,
  ownOrAllScope,
  requireBusinesses,
  requireOwnOrAll,
} from "../authorization.js";
import { audit } from "../models/security.js";
import { transaction } from "../services/orderService.js";
import { resolveCatalogItem } from "../services/catalogService.js";

const router = Router();
const money = z
  .number()
  .finite()
  .min(0)
  .max(1e10)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.0001,
    "Use at most two decimal places",
  );
const schema = z.object({
  fullName: z.string().trim().min(1).max(150),
  phoneNumber: z.string().trim().min(1).max(30),
  address: z.string().trim().max(500).default(""),
  amount: money,
  quantity: z.number().int().min(1).max(100000).default(1),
  business: z.enum(["LOGIX", "TAMQO"]),
  catalogItemId: z.string().min(1),
  saleDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .default(() => dateKey(new Date())),
});

function authorizeRecord(user, sale, own, all) {
  requireOwnOrAll(user, sale, own, all, [sale.business], "Sale access denied");
}

async function findSale(id) {
  const sale = await Sale.findById(objectId(id));
  assert(sale, "Sale not found", 404);
  return sale;
}

async function dataFor(input, user, existing) {
  const data = schema.parse(input);
  requireBusinesses(user, [data.business]);
  const catalogId = objectId(data.catalogItemId);
  const sameCatalog =
    existing &&
    existing.business === data.business &&
    String(existing.catalogItemId) === data.catalogItemId;
  const catalogItem = await resolveCatalogItem(data.business, catalogId, {
    allowInactive: Boolean(sameCatalog),
    message: `Select an active ${data.business === "LOGIX" ? "Logix product" : "Tamqo plan"}.`,
  });
  const saleDate = new Date(data.saleDate + "T00:00:00+01:00");
  assert(
    Number.isFinite(+saleDate) && dateKey(saleDate) === data.saleDate,
    "Invalid calendar date",
  );
  return {
    ...data,
    catalogItemId: catalogId,
    itemName: sameCatalog ? existing.itemName : catalogItem.name,
    saleDate,
  };
}

router.get("/", async (req, res) => {
  const business = String(req.query.business || "").toUpperCase();
  assert(["LOGIX", "TAMQO"].includes(business), "Choose Tamqo or Logix sales.");
  requireBusinesses(req.user, [business]);
  const access = ownOrAllScope(
      req.user,
      P.sales.viewOwn,
      P.sales.viewAll,
      "Sale view denied",
    ),
    range = reportingRange(req.query),
    filter = {
      ...access,
      business,
      saleDate: { $gte: range.start, $lt: range.end },
    },
    p = pagination(req.query);
  if (req.query.addedBy) {
    const addedBy = objectId(req.query.addedBy);
    if (
      access["createdBy.userId"] &&
      String(access["createdBy.userId"]) !== String(addedBy)
    )
      filter._id = { $exists: false };
    else filter["createdBy.userId"] = addedBy;
  }
  if (req.query.search) {
    assert(String(req.query.search).length <= 200, "Search is too long");
    const regex = {
      $regex: escapeRegex(req.query.search),
      $options: "i",
    };
    filter.$or = [
      { fullName: regex },
      { phoneNumber: regex },
      { address: regex },
      { itemName: regex },
    ];
  }
  const fields = ["saleDate", "amount", "quantity", "fullName", "createdAt"];
  const sort = fields.includes(req.query.sort) ? req.query.sort : "saleDate";
  const [items, total] = await Promise.all([
    Sale.find(filter)
      .sort({ [sort]: req.query.direction === "asc" ? 1 : -1, _id: -1 })
      .skip(p.skip)
      .limit(p.limit)
      .lean(),
    Sale.countDocuments(filter),
  ]);
  res.json({ items, total, page: p.page, limit: p.limit, range });
});

router.get("/:id", async (req, res) => {
  const sale = await findSale(req.params.id);
  authorizeRecord(req.user, sale, P.sales.viewOwn, P.sales.viewAll);
  res.json(sale);
});

router.post("/", async (req, res) => {
  assert(can(req.user, P.sales.create), "Sale creation denied", 403);
  const data = await dataFor(req.body, req.user);
  const item = await transaction(async (session) => {
    const [created] = await Sale.create(
      [{ ...data, createdBy: req.actor, updatedBy: req.actor }],
      { session },
    );
    await audit(
      req.actor,
      "SALE_CREATED",
      "Sale",
      created._id,
      created.business,
      {},
      session,
    );
    return created;
  });
  res.status(201).json(item);
});

router.patch("/:id", async (req, res) => {
  const item = await findSale(req.params.id);
  authorizeRecord(req.user, item, P.sales.updateOwn, P.sales.updateAll);
  const data = await dataFor(
    {
      ...item.toObject(),
      catalogItemId: String(item.catalogItemId),
      saleDate: dateKey(item.saleDate),
      ...req.body,
    },
    req.user,
    item,
  );
  Object.assign(item, data, { updatedBy: req.actor });
  await transaction(async (session) => {
    await item.save({ session });
    await audit(
      req.actor,
      "SALE_UPDATED",
      "Sale",
      item._id,
      item.business,
      {},
      session,
    );
  });
  res.json(item);
});

router.delete("/:id", async (req, res) => {
  const sale = await findSale(req.params.id);
  authorizeRecord(req.user, sale, P.sales.deleteOwn, P.sales.deleteAll);
  await transaction(async (session) => {
    const item = await Sale.findByIdAndDelete(sale._id, { session });
    assert(item, "Sale not found", 404);
    await audit(
      req.actor,
      "SALE_DELETED",
      "Sale",
      item._id,
      item.business,
      { itemName: item.itemName, amount: item.amount, quantity: item.quantity },
      session,
    );
  });
  res.status(204).end();
});

export default router;
