import { Router } from "express";
import { z } from "zod";
import { Expense, ExpenseCategory } from "../models/index.js";
import { assert } from "../errors.js";
import { pagination, escapeRegex, objectId } from "../services/filters.js";
import { reportingRange, dateKey } from "../domain/period.js";
import { expenseSummary } from "../services/analyticsService.js";
import { P, can, requireBusinesses } from "../authorization.js";
import { audit } from "../models/security.js";
import { transaction } from "../services/orderService.js";
const router = Router();
router.use(async (req, _res, next) => {
  const permission =
    req.method === "GET"
      ? P.expenses.view
      : req.method === "POST"
        ? P.expenses.create
        : req.method === "PATCH"
          ? P.expenses.update
          : P.expenses.delete;
  assert(can(req.user, permission), "Expense permission denied", 403);
  const id = req.path.split("/").filter(Boolean)[0];
  if (id) {
    const expense = await Expense.findById(objectId(id));
    assert(expense, "Expense not found", 404);
    requireBusinesses(req.user, [expense.business]);
  } else {
    const business =
      req.method === "GET" ? req.query.business : req.body.business;
    assert(
      ["TAMQO", "LOGIX"].includes(business),
      "Choose Tamqo or Logix expenses.",
    );
    requireBusinesses(req.user, [business]);
  }
  next();
});
const schema = z.object({
  business: z.enum(["TAMQO", "LOGIX"]),
  title: z.string().trim().min(1).max(200),
  categoryId: z.string().optional(),
  description: z.string().max(2000).default(""),
  amount: z
    .number()
    .finite()
    .min(0)
    .max(1e10)
    .refine(
      (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.0001,
      "Use two decimal places",
    ),
  expenseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .default(() => dateKey(new Date())),
  paymentMethod: z.enum(["CASH", "BANK", "CARD", "ONLINE"]).default("CASH"),
  note: z.string().max(2000).default(""),
});
function filters(q) {
  assert(
    ["TAMQO", "LOGIX"].includes(q.business),
    "Choose Tamqo or Logix expenses.",
  );
  const f = { business: q.business };
  if (q.search) f.title = { $regex: escapeRegex(q.search), $options: "i" };
  if (q.addedBy) f["createdBy.userId"] = objectId(q.addedBy);
  if (q.category) f.categoryId = objectId(q.category);
  if (q.paymentMethod) f.paymentMethod = q.paymentMethod;
  return f;
}
router.get("/", async (req, res) => {
  const range = reportingRange(req.query),
    f = {
      ...filters(req.query),
      expenseDate: { $gte: range.start, $lt: range.end },
    },
    p = pagination(req.query);
  const fields = ["expenseDate", "amount", "title", "createdAt"];
  const sort = fields.includes(req.query.sort) ? req.query.sort : "expenseDate";
  const [items, total, summary] = await Promise.all([
    Expense.find(f)
      .sort({ [sort]: req.query.direction === "asc" ? 1 : -1, _id: -1 })
      .skip(p.skip)
      .limit(p.limit)
      .lean(),
    Expense.countDocuments(f),
    expenseSummary(f, range),
  ]);
  res.json({ items, total, page: p.page, limit: p.limit, summary, range });
});
router.get("/:id", async (req, res) => {
  const item = await Expense.findById(objectId(req.params.id));
  assert(item, "Expense not found", 404);
  res.json(item);
});
async function dataFor(input, existing) {
  const data = schema.parse({
    ...input,
    expenseDate: input.date || input.expenseDate,
    description: input.description ?? input.note ?? "",
  });
  const category = data.categoryId
    ? await ExpenseCategory.findById(objectId(data.categoryId))
    : null;
  assert(
    !data.categoryId ||
      (category &&
        category.business === data.business &&
        (category.active || String(existing?.categoryId) === data.categoryId)),
    "Select an active category for this business.",
  );
  assert(
    !existing || existing.business === data.business,
    "An expense cannot be moved between businesses.",
  );
  const date = new Date(data.expenseDate + "T00:00:00+01:00");
  assert(
    Number.isFinite(+date) && dateKey(date) === data.expenseDate,
    "Invalid calendar date",
  );
  return {
    ...data,
    expenseDate: date,
    date,
    category:
      existing && String(existing.categoryId) === data.categoryId
        ? existing.category
        : category?.name,
  };
}
router.post("/", async (req, res) =>
  res.status(201).json(
    await transaction(async (session) => {
      const [item] = await Expense.create(
        [
          {
            ...(await dataFor(req.body)),
            createdBy: req.actor,
            updatedBy: req.actor,
          },
        ],
        { session },
      );
      await audit(
        req.actor,
        "EXPENSE_CREATED",
        "Expense",
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
  const item = await Expense.findById(objectId(req.params.id));
  assert(item, "Expense not found", 404);
  Object.assign(
    item,
    await dataFor({ ...item.toObject(), date: undefined, ...req.body }, item),
    { updatedBy: req.actor },
  );
  await transaction(async (session) => {
    await item.save({ session });
    await audit(
      req.actor,
      "EXPENSE_UPDATED",
      "Expense",
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
    const item = await Expense.findByIdAndDelete(objectId(req.params.id), {
      session,
    });
    assert(item, "Expense not found", 404);
    await audit(
      req.actor,
      "EXPENSE_DELETED",
      "Expense",
      item._id,
      item.business,
      { title: item.title, amount: item.amount },
      session,
    );
  });
  res.status(204).end();
});
export default router;
