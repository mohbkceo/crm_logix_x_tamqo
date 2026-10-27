import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { Order } from "../models/index.js";
import { can, P, requireOwnOrAll } from "../authorization.js";
import { objectId } from "../services/filters.js";
import { assert, AppError } from "../errors.js";
import { accessibleOrder } from "../services/trackingService.js";
import { transaction } from "../services/orderService.js";
import { audit } from "../models/security.js";
import { mediaStorage, mediaPath } from "../services/mediaStorage.js";
const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, parts: 3 },
}).single("image");
async function writable(user, id, session = null) {
  const order = await Order.findById(objectId(id)).session(session);
  assert(order && !order.deletedAt, "Order unavailable", 404);
  // The original creator may attach optional images immediately after creation.
  if (!(
    can(user, P.orders.create) &&
    String(order.createdBy?.userId) === String(user._id) &&
    Date.now() - order.createdAt.getTime() < 300000
  ))
    requireOwnOrAll(user, order);
  else requireOwnOrAll(user, order, P.orders.create, P.orders.updateAll);
  return order;
}
router.post(
  "/:orderId",
  async (req, _res, next) => {
    await writable(req.user, req.params.orderId);
    next();
  },
  (req, res, next) =>
    upload(req, res, (error) => {
      if (error)
        error = new AppError(
          "Upload one JPEG, PNG or WebP image, up to 5 MB.",
          400,
          "INVALID_UPLOAD",
        );
      next(error);
    }),
  async (req, res) => {
    const revision = z.coerce
      .number()
      .int()
      .min(0)
      .parse(req.body.expectedRevision);
    const image = await mediaStorage.put(req.file);
    try {
      const result = await transaction(async (session) => {
        const order = await writable(req.user, req.params.orderId, session);
        assert(
          order.revision === revision,
          "Order changed. Reload before attaching an image.",
          409,
        );
        assert(order.images.length < 6, "An order supports up to six images");
        order.images.push({
          ...image,
          uploadedBy: req.actor,
          uploadedAt: new Date(),
        });
        order.revision++;
        await order.save({ session });
        await audit(
          req.actor,
          "ORDER_IMAGE_ADDED",
          "Order",
          order._id,
          order.businessType,
          {},
          session,
        );
        return {
          revision: order.revision,
          images: order.images.map((i) => ({
            _id: i._id,
            url: `/api/order-media/${order._id}/${i._id}`,
          })),
        };
      });
      res.status(201).json(result);
    } catch (error) {
      await mediaStorage.remove(image.key).catch(() => {});
      throw error;
    }
  },
);
router.get("/:orderId/:imageId", async (req, res) => {
  const order = await Order.findById(objectId(req.params.orderId));
  assert(order && !order.deletedAt, "Order unavailable", 404);
  if (
    can(req.user, P.orders.viewAll) ||
    (can(req.user, P.orders.viewOwn) &&
      String(order.createdBy?.userId) === String(req.user._id))
  )
    requireOwnOrAll(req.user, order, P.orders.viewOwn, P.orders.viewAll);
  else await accessibleOrder(req.user, req.params.orderId);
  const image = order.images.id(objectId(req.params.imageId));
  assert(image, "Image unavailable", 404);
  res.set({
    "Content-Type": "image/webp",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.sendFile(mediaPath(image.key));
});
export default router;
