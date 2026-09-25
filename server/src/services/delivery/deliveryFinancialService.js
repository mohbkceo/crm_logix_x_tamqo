import { Expense, OrderEvent } from "../../models/index.js";
import { round } from "../../domain/order.js";
import { audit } from "../../models/security.js";

export const RETURN_FEE = 150;
const SOURCE_TYPE = "DELIVERY_FAILURE_FEE";

export async function ensureReturnExpense(order, { session, actor, tracking, date, importBatchId, sourceKey, sourceLabel, source } = {}) {
  if (!["RETURNING", "RETURNED"].includes(order.status)) return { created: false, amount: 0 };
  const filter = { systemGenerated: true, sourceType: SOURCE_TYPE, sourceOrderId: order._id };
  if (await Expense.exists(filter).session(session)) return { created: false, amount: 0 };

  const totals = new Map();
  for (const item of order.items) totals.set(item.business, round((totals.get(item.business) || 0) + item.subtotal));
  const businesses = [...totals.keys()];
  const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
  const baseKey = sourceKey || `${SOURCE_TYPE}:${order._id}`;
  let assigned = 0;
  let createdAmount = 0;
  for (const [index, business] of businesses.entries()) {
    const amount = index === businesses.length - 1
      ? round(RETURN_FEE - assigned)
      : round(RETURN_FEE * (total ? totals.get(business) / total : 1 / businesses.length));
    assigned = round(assigned + amount);
    if (amount <= 0) continue;
    const key = businesses.length === 1 ? baseKey : `${baseKey}:${business}`;
    const result = await Expense.updateOne(
      { sourceType: SOURCE_TYPE, sourceOrderId: order._id, business, systemGenerated: true },
      { $setOnInsert: {
        business, title: "Delivery Return Fee",
        description: [`Tracking: ${tracking || "Unavailable"}`, sourceLabel].filter(Boolean).join("\n"),
        amount, date: date || new Date(), expenseDate: date || new Date(),
        paymentMethod: "CASH", note: "System generated delivery return fee",
        ...(typeof actor === "object" && actor ? { createdBy: actor, updatedBy: actor } : {}),
        systemGenerated: true,
        sourceType: SOURCE_TYPE, sourceOrderId: order._id,
        sourceTracking: tracking || undefined, sourceKey: key, sourceGroupKey: baseKey,
        importBatchId,
      } },
      { upsert: true, session, runValidators: true },
    );
    if (result.upsertedCount) {
      createdAmount = round(createdAmount + amount);
      await audit(actor, "DELIVERY_RETURN_FEE_CREATED", "Expense", result.upsertedId,
        business, { orderId: order._id, amount, sourceKey: key }, session);
    }
  }
  if (createdAmount > 0) await OrderEvent.create([{
    orderId: order._id, kind: "STATUS", type: "DELIVERY_RETURN_FEE_CREATED",
    source: source || "DELIVERY_PROVIDER", actor,
    message: "Return fee recorded after the parcel entered the return process.",
    data: { amount: createdAmount, tracking },
  }], { session });
  return { created: createdAmount > 0, amount: createdAmount };
}

export async function reverseReturnExpense(order, { session, actor, source } = {}) {
  if (order.status !== "DELIVERED") return { reversed: false, amount: 0 };
  const filter = { systemGenerated: true, sourceType: SOURCE_TYPE, sourceOrderId: order._id };
  const expenses = await Expense.find(filter).session(session);
  if (!expenses.length) return { reversed: false, amount: 0 };
  const amount = round(expenses.reduce((sum, expense) => sum + expense.amount, 0));
  await Expense.deleteMany({ ...filter, _id: { $in: expenses.map((expense) => expense._id) } }).session(session);
  for (const expense of expenses) await audit(actor, "DELIVERY_RETURN_FEE_REVERSED", "Expense",
    expense._id, expense.business, { orderId: order._id, amount: expense.amount }, session);
  await OrderEvent.create([{
    orderId: order._id, kind: "STATUS", type: "DELIVERY_RETURN_FEE_REVERSED",
    source: source || "DELIVERY_PROVIDER", actor,
    message: "Return fee reversed because the parcel was recovered and delivered.",
    data: { amount, expenseIds: expenses.map((expense) => expense._id) },
  }], { session });
  return { reversed: true, amount };
}
