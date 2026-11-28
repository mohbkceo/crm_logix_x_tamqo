import { Order, Shipment } from "../../../models/index.js";
import { DeliveryAgency } from "../../../models/delivery.js";
import { NotificationOutbox } from "../../../models/telegram.js";
import { audit } from "../../../models/security.js";
import {
  P,
  can,
  hasBusinessAccess,
  orderBusinesses,
} from "../../../authorization.js";
import { canTransition } from "../../../domain/order.js";
import { transition, cancelOrder } from "../../orderService.js";
import {
  eligible,
  moveStage,
  stageTargets,
  trackingScope,
} from "../../trackingService.js";
import { supportsReadiness } from "../../delivery/deliveryProviderFactory.js";
import { AppError } from "../../../errors.js";
import { cb, orderSummary, summaryKeyboard } from "./telegramOrderFormatter.js";
import { loadCreatorContact } from "./telegramOrderCreator.js";

// Every Telegram action maps onto an existing CRM workflow. Statuses with
// dedicated, provider-facing flows (READY_TO_SHIP for non-production orders,
// courier statuses, cancelling a parcel already sent to a courier) are not
// exposed here and stay in the CRM.
export const ACTIONS = {
  C: { label: "🔵 Confirm order", status: "CONFIRMED" },
  P: { label: "🟠 Mark Preparing", status: "PREPARING" },
  X: { label: "🔴 Cancel order…" },
  Y: { label: "🔴 Yes, cancel this order", cancel: true },
  G1: { label: "🏭 Move to Production", stage: "AT_PRODUCTION" },
  G0: { label: "↩️ Back to Preparing stage", stage: "PREPARING" },
  GR: { label: "🟣 Ready to Ship", stage: "READY_TO_SHIP" },
};
const STAGE_CODE = {
  AT_PRODUCTION: "G1",
  PREPARING: "G0",
  READY_TO_SHIP: "GR",
};
export const actor = (user) => ({ userId: user._id, name: user.name });

async function productionTargets(user, order, shipment) {
  if (!eligible(order) || !order.tracking || !can(user, P.tracking.view))
    return [];
  if (
    !(await Order.exists({
      ...trackingScope(user),
      _id: order._id,
      deletedAt: { $exists: false },
    }))
  )
    return [];
  let targets = stageTargets(user, order, shipment);
  if (targets.includes("READY_TO_SHIP")) {
    // Same readiness gate as the CRM order page.
    const agency = await DeliveryAgency.findById(order.delivery?.agencyId)
      .select("integrationType apiProvider capabilities")
      .lean();
    const ready =
      supportsReadiness(agency, shipment) &&
      shipment?.tracking &&
      String(shipment.agencyId) === String(order.delivery?.agencyId);
    if (!ready) targets = targets.filter((t) => t !== "READY_TO_SHIP");
  }
  return targets.map((t) => STAGE_CODE[t]).filter(Boolean);
}

export async function availableActions(user, order, shipment) {
  if (!user || order.deletedAt) return [];
  if (!orderBusinesses(order).every((b) => hasBusinessAccess(user, b)))
    return [];
  const codes = [];
  if (
    can(user, P.orders.confirm) &&
    canTransition(order.status, "CONFIRMED", order.businessType)
  )
    codes.push("C");
  if (
    can(user, P.orders.prepare) &&
    canTransition(order.status, "PREPARING", order.businessType)
  )
    codes.push("P");
  codes.push(...(await productionTargets(user, order, shipment)));
  if (
    can(user, P.orders.cancel) &&
    canTransition(order.status, "CANCELLED", order.businessType) &&
    !shipment?.creationAttemptedAt &&
    !(shipment?.lockUntil > new Date())
  )
    codes.push("X");
  return codes;
}

export function statusMenuKeyboard(order, codes) {
  return [
    ...codes.map((code) => [
      { text: ACTIONS[code].label, callback_data: cb.action(order, code) },
    ]),
    [{ text: "« Back", callback_data: cb.back(order) }],
  ];
}
export const cancelConfirmKeyboard = (order) => [
  [{ text: ACTIONS.Y.label, callback_data: cb.action(order, "Y") }],
  [{ text: "« Keep order", callback_data: cb.statusMenu(order) }],
];

export async function loadOrder(orderId) {
  const [order, shipment] = await Promise.all([
    Order.findById(orderId).select("-originalData -statusHistory").lean(),
    Shipment.findOne({ orderId })
      .select(
        "tracking agencyId provider providerStatus status syncStatus creationAttemptedAt lockUntil uncertain pendingReadinessStateId providerStateId providerStatusMapped",
      )
      .lean(),
  ]);
  return { order, shipment, contact: await loadCreatorContact(order) };
}

export class StaleActionError extends AppError {
  constructor() {
    super(
      "This order changed since this message was sent. The latest status is shown now.",
      409,
      "TELEGRAM_STALE",
    );
  }
}

// Validates identity-derived permissions, the order revision and the
// requested transition again on every callback, then runs CRM business logic
// as the linked employee.
export async function executeAction(user, orderId, revision, code) {
  const { order, shipment } = await loadOrder(orderId);
  if (!order || order.deletedAt)
    throw new AppError(
      "This order is no longer available.",
      404,
      "TELEGRAM_ORDER_UNAVAILABLE",
    );
  if (order.revision !== revision) throw new StaleActionError();
  const allowed = await availableActions(user, order, shipment);
  const permitted =
    code === "Y"
      ? allowed.includes("X")
      : code !== "X" && allowed.includes(code);
  if (!permitted)
    throw new AppError(
      "This action is not available for you on this order.",
      403,
      "TELEGRAM_ACTION_DENIED",
    );
  const action = ACTIONS[code];
  const who = actor(user);
  const from = order.status;
  if (action.status) await transition(order._id, action.status, who);
  else if (action.cancel)
    await cancelOrder(order._id, who, { providerCancellationConfirmed: false });
  else if (action.stage)
    await moveStage(user, String(order._id), {
      targetStage: action.stage,
      expectedRevision: revision,
    });
  await audit(
    who,
    "TELEGRAM_ORDER_ACTION",
    "Order",
    order._id,
    order.businessType,
    {
      action:
        action.status ||
        (action.cancel ? "CANCELLED" : `STAGE_${action.stage}`),
      fromStatus: from,
      via: "TELEGRAM",
    },
  ).catch(() => {});
  return loadOrder(order._id);
}

// Keep every recorded summary for this order current (best effort).
export async function refreshOrderMessages(
  client,
  order,
  shipment,
  { except } = {},
) {
  const jobs = await NotificationOutbox.find({
    orderId: order._id,
    "deliveries.summaryMessageId": { $exists: true },
  })
    .select("deliveries.chatId deliveries.summaryMessageId")
    .lean();
  const text = orderSummary(order, shipment);
  const keyboard = summaryKeyboard(
    order,
    shipment,
    await loadCreatorContact(order),
  );
  for (const job of jobs)
    for (const d of job.deliveries) {
      if (!d.summaryMessageId) continue;
      if (
        except &&
        String(except.chatId) === String(d.chatId) &&
        except.messageId === d.summaryMessageId
      )
        continue;
      await client
        .editMessageText({
          chatId: d.chatId,
          messageId: d.summaryMessageId,
          text,
          keyboard,
        })
        .catch(() => {});
    }
}
