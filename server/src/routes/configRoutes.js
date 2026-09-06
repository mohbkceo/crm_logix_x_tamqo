import { Router } from "express";
import { z } from "zod";
import { configModels, OrderSource, SettingLock } from "../models/index.js";
import { transaction } from "../services/orderService.js";
import { assert } from "../errors.js";
import { objectId } from "../services/filters.js";
import { P, can, hasBusinessAccess } from "../authorization.js";
import { audit } from "../models/security.js";
const router = Router();
const resources = {
  plans: [P.tamqoPlans.view, P.tamqoPlans.manage, "TAMQO"],
  products: [P.logixProducts.view, P.logixProducts.manage, "LOGIX"],
  sources: [P.sources.view, P.sources.manage],
  wilayas: [P.wilayas.view, P.wilayas.manage],
  "expense-categories": [P.expenses.view, P.settings.manage],
};
function allowed(user, key, write = false) {
  const [view, manage, business] = resources[key] || [];
  return (
    (!business || hasBusinessAccess(user, business)) &&
    (write
      ? can(user, manage)
      : can(user, view) ||
        can(user, manage) ||
        can(user, P.orders.create) ||
        can(user, P.orders.updateOwn) ||
        can(user, P.orders.updateAll))
  );
}
const scopeFilter = (user, key) =>
  key === "expense-categories" && user.role !== "SUPER_ADMIN"
    ? { business: { $in: user.businessAccess } }
    : {};
router.use(async (req, _res, next) => {
  const key = req.path.split("/").filter(Boolean)[0];
  if (key) {
    assert(resources[key], "Unknown configuration resource", 404);
    assert(
      allowed(req.user, key, req.method !== "GET"),
      "Configuration permission denied",
      403,
    );
    if (key === "expense-categories" && req.method !== "GET") {
      if (req.body.business)
        assert(
          hasBusinessAccess(req.user, req.body.business),
          "Business access denied",
          403,
        );
      const id = req.path.split("/")[2];
      if (id && id !== "reorder") {
        const row = await configModels[key].findById(objectId(id));
        assert(
          row && hasBusinessAccess(req.user, row.business),
          "Business access denied",
          403,
        );
      }
      if (id === "reorder")
        assert(
          req.user.role === "SUPER_ADMIN",
          "Global reorder requires Super Admin",
          403,
        );
    }
  }
  next();
});
const name = z.string().trim().min(1).max(100),
  price = z
    .number()
    .finite()
    .min(0)
    .max(1e9)
    .refine(
      (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.0001,
      "Use at most two decimal places",
    ),
  sortOrder = z.number().int().min(0).max(10000).default(0);
const schemas = {
  plans: z.object({
    name,
    price,
    durationDays: z.number().int().min(1).max(36500),
    active: z.boolean().default(true),
    sortOrder,
  }),
  products: z.object({
    name,
    price,
    active: z.boolean().default(true),
    sortOrder,
  }),
  sources: z.object({
    name,
    active: z.boolean().default(true),
    isDefault: z.boolean().default(false),
    sortOrder,
  }),
  wilayas: z.object({
    name,
    agencyId: z
      .string()
      .trim()
      .regex(/^\d{1,3}$/),
    homeShippingPrice: price,
    deskShippingPrice: price,
    active: z.boolean().default(true),
  }),
  "expense-categories": z.object({
    name,
    business: z.enum(["TAMQO", "LOGIX"]),
    active: z.boolean().default(true),
    sortOrder,
  }),
};
router.get("/", async (req, res) => {
  const entries = await Promise.all(
    Object.entries(configModels).map(async ([key, Model]) => [
      key,
      allowed(req.user, key)
        ? await Model.find(scopeFilter(req.user, key))
            .sort({ sortOrder: 1, name: 1 })
            .lean()
        : [],
    ]),
  );
  res.json(Object.fromEntries(entries));
});
router.param("resource", (req, _res, next, value) => {
  assert(configModels[value], "Unknown configuration resource", 404);
  req.Model = configModels[value];
  next();
});
router.get("/:resource", async (req, res) =>
  res.json(
    await req.Model.find(scopeFilter(req.user, req.params.resource))
      .sort({ sortOrder: 1, name: 1 })
      .lean(),
  ),
);
router.post("/:resource/reorder", async (req, res) => {
  const ids = z.array(z.string()).min(1).parse(req.body.ids);
  assert(new Set(ids).size === ids.length, "Duplicate IDs in reorder");
  const result = await transaction(async (session) => {
    const all = await req.Model.find().session(session);
    assert(
      all.length === ids.length &&
        all.every((r) => ids.includes(String(r._id))),
      "Reorder must contain every item exactly once.",
    );
    for (const [sortOrder, id] of ids.entries())
      await req.Model.updateOne(
        { _id: objectId(id) },
        { $set: { sortOrder } },
        { session },
      );
    return { updated: ids.length };
  });
  res.json(result);
});
async function saveConfig(req, id) {
  const resource = req.params.resource;
  return transaction(async (session) => {
    if (resource === "sources")
      await SettingLock.findOneAndUpdate(
        { _id: "default-source" },
        { $inc: { version: 1 } },
        { upsert: true, session },
      );
    const existing = id
      ? await req.Model.findById(objectId(id)).session(session)
      : null;
    assert(!id || existing, "Configuration not found", 404);
    const data = schemas[resource].parse({
      ...existing?.toObject(),
      ...req.body,
    });
    if (resource === "expense-categories" && existing)
      assert(
        data.business === existing.business,
        "An expense category cannot be moved to another business.",
      );
    if (resource === "sources") {
      assert(
        !data.isDefault || data.active,
        "The default source must be active.",
      );
      if (existing?.isDefault && !data.isDefault)
        assert(
          false,
          "Choose another default source before disabling this one.",
          409,
        );
      if (data.isDefault)
        await OrderSource.updateMany(
          { _id: { $ne: existing?._id }, isDefault: true },
          { $set: { isDefault: false } },
          { session },
        );
    }
    let item;
    if (existing) {
      Object.assign(existing, data);
      item = await existing.save({ session });
    } else [item] = await req.Model.create([data], { session });
    if (resource === "sources")
      assert(
        (await OrderSource.countDocuments({
          active: true,
          isDefault: true,
        }).session(session)) === 1,
        "Exactly one active default source is required.",
        409,
      );
    const label = {
      plans: "TAMQO_PLAN",
      products: "LOGIX_PRODUCT",
      sources: "SOURCE",
      wilayas: "WILAYA",
      "expense-categories": "EXPENSE_CATEGORY",
    }[resource];
    await audit(
      req.actor,
      `${label}_${existing ? "UPDATED" : "CREATED"}`,
      resource,
      item._id,
      resources[resource][2],
      {},
      session,
    );
    return item;
  });
}
router.post("/:resource", async (req, res) =>
  res.status(201).json(await saveConfig(req)),
);
router.patch("/:resource/:id", async (req, res) =>
  res.json(await saveConfig(req, req.params.id)),
);
// Soft deletion preserves references and snapshots; inactive rows remain manageable in Settings.
router.delete("/:resource/:id", async (req, res) => {
  req.body = { active: false };
  res.json(await saveConfig(req, req.params.id));
});
export default router;
