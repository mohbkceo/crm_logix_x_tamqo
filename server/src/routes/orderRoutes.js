import { Router } from "express";
import { z } from "zod";
import { Order, OrderEvent, Shipment } from "../models/index.js";
import {
  createOrder,
  editOrder,
  transition,
  transaction,
} from "../services/orderService.js";
import {
  orderFilter,
  pagination,
  objectId,
  escapeRegex,
} from "../services/filters.js";
import { assert } from "../errors.js";

import { canTransition } from "../domain/order.js";
import { STATUSES } from "../constants.js";
import {
  P,
  can,
  orderBusinesses,
  requireBusinesses,
  requireOwnOrAll,
  orderScope,
} from "../authorization.js";
import { deliveryService } from "../services/delivery/deliveryService.js";
import { DeliveryAgency } from "../models/delivery.js";
const router = Router();
router.use(async (req, _res, next) => {
  const parts = req.path.split("/").filter(Boolean),
    id = parts[0];
  if (!id) {
    if (req.method === "POST") {
      assert(can(req.user, P.orders.create), "Order creation denied", 403);
      requireBusinesses(req.user, [
        ...new Set((req.body.items || []).map((item) => item.business)),
      ]);
    } else
      assert(
        can(req.user, P.orders.viewOwn) || can(req.user, P.orders.viewAll),
        "Order view denied",
        403,
      );
  } else {
    const order = await Order.findById(objectId(id));
    assert(order, "Order not found", 404);
    if (req.method === "GET")
      requireOwnOrAll(req.user, order, P.orders.viewOwn, P.orders.viewAll);
    else {
      requireBusinesses(req.user, orderBusinesses(order));
      const action = parts[1];
      const permission =
        action === "confirm"
          ? P.orders.confirm
          : action === "cancel"
            ? P.orders.cancel
            : action === "status"
              ? req.body.status === "CONFIRMED"
                ? P.orders.confirm
                : P.orders.prepare
              : action === "shipment"
                ? parts[2] === "ready"
                  ? P.orders.markReady
                  : parts[2] === "refresh" || parts[2] === "reconcile"
                    ? P.orders.refreshTracking
                    : P.orders.createShipment
                : null;
      if (permission)
        assert(can(req.user, permission), "Order action denied", 403);
      else requireOwnOrAll(req.user, order);
      if (req.method === "PATCH")
        requireBusinesses(req.user, [
          ...new Set((req.body.items || []).map((item) => item.business)),
        ]);
    }
  }
  next();
});
router.post("/", async (req, res) => {
  const order = await createOrder(req.body, req.actor);
  const delivery = await deliveryService.createAutomatically(order, req.actor);
  // Reload revision/status changed by shipment synchronization, with the committed
  // order as fallback if the database becomes unavailable after creation.
  const current = await Order.findById(order._id)
    .lean()
    .catch(() => null);
  res.status(201).json({ ...(current || order.toObject()), ...delivery });
});
router.get("/", async (req, res) => {
  const filter = {
      $and: [
        orderFilter(req.query),
        orderScope(req.user, !can(req.user, P.orders.viewAll)),
      ],
    },
    p = pagination(req.query);
  if (req.query.tracking) {
    const ids = await Shipment.find({
      tracking: { $regex: escapeRegex(req.query.tracking), $options: "i" },
    }).distinct("orderId");
    filter._id = { $in: ids };
  }
  const [items, total] = await Promise.all([
    Order.find(filter)
      .select("-originalData -statusHistory")
      .sort({ createdAt: -1, _id: -1 })
      .skip(p.skip)
      .limit(p.limit)
      .lean(),
    Order.countDocuments(filter),
  ]);
  const shipments = await Shipment.find({
    orderId: { $in: items.map((o) => o._id) },
  })
    .select("orderId tracking syncStatus")
    .lean();
  res.json({
    items: items.map((o) => ({
      ...o,
      shipment:
        shipments.find((s) => String(s.orderId) === String(o._id)) || null,
    })),
    total,
    page: p.page,
    limit: p.limit,
  });
});
router.param("id", (req, _res, next, id) => {
  objectId(id);
  next();
});
router.get("/:id", async (req, res) => {
  const [order, shipment] = await Promise.all([
    Order.findById(req.params.id).select("-originalData").lean(),
    Shipment.findOne({ orderId: req.params.id })
      .select("-sanitizedProviderData")
      .lean(),
  ]);
  assert(order, "Order not found", 404);
  const deliveryAgency = await DeliveryAgency.findById(order.delivery.agencyId)
    .select("integrationType capabilities")
    .lean();
  res.json({
    ...order,
    shipment,
    deliveryAgency,
    allowedStatuses: STATUSES.filter((s) =>
      canTransition(order.status, s, order.businessType),
    ),
  });
});
router.patch("/:id", async (req, res) =>
  res.json(await editOrder(req.params.id, req.body, req.actor)),
);
router.get("/:id/timeline", async (req, res) =>
  res.json(
    await OrderEvent.find({ orderId: req.params.id })
      .select("-data")
      .sort({ createdAt: 1, _id: 1 })
      .lean(),
  ),
);
router.post("/:id/confirm", async (req, res) =>
  res.json(await transition(req.params.id, "CONFIRMED", req.actor)),
);
router.post("/:id/cancel", async (req, res) => {
  const confirmed = z
    .boolean()
    .optional()
    .parse(req.body.providerCancellationConfirmed);
  res.json(
    await transaction(async (session) => {
      const shipment = await Shipment.findOne({
        orderId: req.params.id,
      }).session(session);
      assert(
        !shipment?.lockUntil || shipment.lockUntil < new Date(),
        "A courier request is in progress. Wait and reconcile before cancelling.",
        409,
      );
      assert(
        !shipment?.creationAttemptedAt || confirmed,
        "Resolve cancellation with the provider and confirm it before cancelling this order.",
        409,
      );
      const order = await transition(
        req.params.id,
        "CANCELLED",
        req.actor,
        session,
      );
      if (shipment?.creationAttemptedAt)
        await OrderEvent.create(
          [
            {
              orderId: order._id,
              kind: "SHIPMENT",
              type: "SHIPMENT_CANCELLATION_CONFIRMED",
              actor: req.actor,
              message:
                "Admin confirmed the courier parcel was cancelled outside this workspace.",
            },
          ],
          { session },
        );
      return order;
    }),
  );
});
router.post("/:id/status", async (req, res) => {
  const status = z.enum(STATUSES).parse(req.body.status);
  assert(
    !["READY_TO_SHIP", "CANCELLED"].includes(status),
    "Use the dedicated ready or cancel action.",
  );
  res.json(await transition(req.params.id, status, req.actor));
});
router.post("/:id/activate", async (req, res) =>
  res.json(
    await transaction(async (session) => {
      const order = await Order.findById(req.params.id).session(session);
      assert(order, "Order not found", 404);
      assert(
        order.items.some((i) => i.business === "TAMQO") &&
          !["NEW", "CANCELLED", "RETURNED", "RETURNING"].includes(order.status),
        "Confirm an eligible Tamqo order first.",
        409,
      );
      if (!order.tamqoActivatedAt) {
        order.tamqoActivatedAt = new Date();
        order.lastUpdatedBy = req.actor;
        order.revision++;
        await order.save({ session });
        await OrderEvent.create(
          [
            {
              orderId: order._id,
              kind: "ACTIVATED",
              type: "TAMQO_ACTIVATED",
              actor: req.actor,
              message: "Tamqo subscription activated",
            },
          ],
          { session },
        );
      }
      return order;
    }),
  ),
);
router.post("/:id/payment", async (req, res) =>
  res.json(
    await transaction(async (session) => {
      const amount = z
        .number()
        .finite()
        .min(0)
        .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.0001)
        .parse(req.body.amountCollected);
      const order = await Order.findById(req.params.id).session(session);
      assert(order, "Order not found", 404);
      assert(
        !["CANCELLED", "RETURNED"].includes(order.status),
        "Cannot collect on a cancelled or returned order.",
        409,
      );
      assert(
        amount <= order.payment.amountToCollect,
        "Collection cannot exceed the courier balance.",
      );
      const before = order.payment.amountCollected;
      order.payment.amountCollected = amount;
      order.revision++;
      await order.save({ session });
      await OrderEvent.create(
        [
          {
            orderId: order._id,
            kind: "PAYMENT",
            type: "PAYMENT_UPDATED",
            actor: req.actor,
            message: `Courier collection updated to ${amount} DA`,
            data: { before, after: amount },
          },
        ],
        { session },
      );
      return order;
    }),
  ),
);
router.post("/:id/shipment", async (req, res) =>
  res.json(await deliveryService.create(req.params.id, req.actor, req.body)),
);
router.post("/:id/shipment/ready", async (req, res) =>
  res.json(await deliveryService.ready(req.params.id, req.actor)),
);
router.post("/:id/shipment/refresh", async (req, res) =>
  res.json(await deliveryService.refresh(req.params.id, req.actor)),
);
router.post("/:id/shipment/reconcile", async (req, res) => {
  const body = z
    .object({
      tracking: z.string().optional(),
      absentConfirmed: z.boolean().optional(),
    })
    .parse(req.body);
  res.json(
    await deliveryService.reconcile(
      req.params.id,
      body.tracking,
      body.absentConfirmed,
      req.actor,
    ),
  );
});
export default router;
