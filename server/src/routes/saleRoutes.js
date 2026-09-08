import { Router } from "express";
import { z } from "zod";
import { Sale } from "../models/index.js";
import { assert } from "../errors.js";
import { pagination, escapeRegex, objectId } from "../services/filters.js";
import { reportingRange, dateKey } from "../domain/period.js";
import {
  P,
  can,
  requireBusinesses,
  requireSaleOwnOrAll,
  saleScope,
} from "../authorization.js";
import { audit } from "../models/security.js";
import { transaction } from "../services/orderService.js";
import { resolveCatalogItem } from "../services/catalog.js";

const router = Router();
const businesses = ["TAMQO", "LOGIX"];

router.use(async (req, _res, next) => {
  const id = req.path.split("/").filter(Boolean)[0];
  if (req.method === "GET") {
    assert(
      can(req.user, P.sales.viewOwn) || can(req.user, P.sales.viewAll),
      "Sale view permission denied",
      403,
    );
    if (id) {
      req.sale = await Sale.findById(objectId(id));
      assert(req.sale, "Sale not found", 404);
      requireSaleOwnOrAll(req.user, req.sale, P.sales.viewOwn, P.sales.viewAll);
    } else if (req.query.business) {
      assert(businesses.includes(req.query.business), "Invalid sale business");
      requireBusinesses(req.user, [req.query.business]);
    }
  } else if (req.method === "POST") {
    assert(can(req.user, P.sales.create), "Sale create permission denied", 403);
  } else {
    req.sale = await Sale.findById(objectId(id));
    assert(req.sale, "Sale not found", 404);
    requireSaleOwnOrAll(
      req.user,
      req.sale,
      req.method === "PATCH" ? P.sales.updateOwn : P.sales.deleteOwn,
      req.method === "PATCH" ? P.sales.updateAll : P.sales.deleteAll,
    );
  }
  next();
});

const schema = z.object({
  fullName: z.string().trim().min(1).max(150),
  phoneNumber: z.string().trim().min(1).max(30),
  address: z.string().trim().max(500).default(""),
  amount: z
    .number()
    .finite()
    .min(0)
    .max(1e10)
    .refine(
      (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.0001,
      "Use two decimal places",
    ),
  quantity: z.number().int().min(1).max(1e6).default(1),
  business: z.enum(["TAMQO", "LOGIX"]),
  catalogItemId: z.string().min(1),
  saleDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .default(() => dateKey(new Date())),
});

function filters(query, user) {
  const filter = { ...saleScope(user) };
  if (query.business) filter.business = query.business;
  if (query.addedBy) {
    const addedBy = objectId(query.addedBy);
    if (filter["createdBy.userId"])
      filter.$and = [{ "createdBy.userId": addedBy }];
    else filter["createdBy.userId"] = addedBy;
  }
  if (query.catalog) filter.catalogItemId = objectId(query.catalog);
  if (query.search) {
    assert(String(query.search).length <= 200, "Search is too long");
    const value = { $regex: escapeRegex(query.search), $options: "i" };
    filter.$or = [
      { fullName: value },
      { phoneNumber: value },
      { address: value },
      { itemName: value },
    ];
  }
  return filter;
}

router.get("/", async (req, res) => {
  const range = reportingRange(req.query);
  const filter = {
    ...filters(req.query, req.user),
    saleDate: { $gte: range.start, $lt: range.end },
  };
  const p = pagination(req.query);
  const fields = [
    "saleDate",
    "amount",
    "quantity",
    "fullName",
    "itemName",
    "createdAt",
  ];
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

router.get("/:id", async (req, res) => res.json(req.sale));

async function dataFor(input, existing, user, session) {
  const data = schema.parse({
    ...input,
    catalogItemId: String(input.catalogItemId || ""),
    saleDate: input.date || input.saleDate,
  });
  requireBusinesses(user, [data.business]);
  const sameCatalogItem =
    existing &&
    existing.business === data.business &&
    String(existing.catalogItemId) === data.catalogItemId;
  const catalogItem = await resolveCatalogItem(
    data.business,
    objectId(data.catalogItemId),
    { session, allowInactive: Boolean(sameCatalogItem) },
  );
  const saleDate = new Date(data.saleDate + "T00:00:00+01:00");
  assert(
    Number.isFinite(+saleDate) && dateKey(saleDate) === data.saleDate,
    "Invalid calendar date",
  );
  return {
    ...data,
    saleDate,
    itemName: sameCatalogItem ? existing.itemName : catalogItem.name,
  };
}

router.post("/", async (req, res) =>
  res.status(201).json(
    await transaction(async (session) => {
      const [item] = await Sale.create(
        [
          {
            ...(await dataFor(req.body, null, req.user, session)),
            createdBy: req.actor,
            updatedBy: req.actor,
          },
        ],
        { session },
      );
      await audit(
        req.actor,
        "SALE_CREATED",
        "Sale",
        item._id,
        item.business,
        {},
        session,
      );
      return item;
    }),
  ),
);

router.patch("/:id", async (req, res) => {
  const item = req.sale;
  const existingDate = dateKey(item.saleDate);
  Object.assign(
    item,
    await dataFor(
      {
        ...item.toObject(),
        ...req.body,
        saleDate: req.body.saleDate || req.body.date || existingDate,
      },
      item,
      req.user,
    ),
    { updatedBy: req.actor },
  );
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
  await transaction(async (session) => {
    const item = await Sale.findByIdAndDelete(req.sale._id, { session });
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
