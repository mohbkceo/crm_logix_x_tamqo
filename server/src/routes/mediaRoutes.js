import { Router } from "express";
import { pipeline } from "node:stream/promises";
import multer from "multer";
import { z } from "zod";
import { Order } from "../models/index.js";
import { TrackingIssue } from "../models/tracking.js";
import { MediaCleanup } from "../models/media.js";
import { can, P, requireOwnOrAll } from "../authorization.js";
import { objectId } from "../services/filters.js";
import { assert, AppError } from "../errors.js";
import { accessibleOrder } from "../services/trackingService.js";
import { transaction } from "../services/orderService.js";
import { audit } from "../models/security.js";
import { mediaPath } from "../services/mediaStorage.js";
import {
  cloudinaryStorage,
  MAX_IMAGE_BYTES,
  IMAGE_TYPES,
} from "../services/cloudinaryStorage.js";
import { queueMediaCleanup } from "../services/mediaCleanup.js";
import { canManageIssueMedia } from "../services/mediaAccess.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 1, parts: 3 },
  fileFilter: (_req, file, cb) => cb(null, IMAGE_TYPES.includes(file.mimetype)),
}).single("image");
const multipart = (req, res, next) =>
  upload(req, res, (error) =>
    next(
      error
        ? new AppError(
            "Upload one JPEG, PNG or WebP image, up to 5 MB.",
            400,
            "INVALID_UPLOAD",
          )
        : null,
    ),
  );

async function orderAccess(req, writing, session, creating = false) {
  const order = await Order.findById(objectId(req.params.orderId)).session(
    session,
  );
  assert(order && !order.deletedAt, "Order unavailable", 404);
  if (writing) {
    // Preserve the existing optional-upload allowance immediately after creation.
    const justCreated =
      creating &&
      can(req.user, P.orders.create) &&
      String(order.createdBy?.userId) === String(req.user._id) &&
      Date.now() - order.createdAt.getTime() < 300000;
    requireOwnOrAll(
      req.user,
      order,
      justCreated ? P.orders.create : P.orders.updateOwn,
      P.orders.updateAll,
    );
  } else if (
    can(req.user, P.orders.viewAll) ||
    (can(req.user, P.orders.viewOwn) &&
      String(order.createdBy?.userId) === String(req.user._id))
  ) {
    requireOwnOrAll(req.user, order, P.orders.viewOwn, P.orders.viewAll);
  } else await accessibleOrder(req.user, req.params.orderId, session);
  return { order, document: order, field: "images" };
}
async function issueAccess(req, writing, session) {
  const order = await accessibleOrder(req.user, req.params.orderId, session);
  const issue = await TrackingIssue.findOne({
    _id: objectId(req.params.issueId),
    orderId: order._id,
  }).session(session);
  assert(issue, "Report unavailable", 404);
  assert(
    writing
      ? canManageIssueMedia(req.user, issue)
      : can(req.user, P["tracking.issue"].view),
    "Report attachment access denied",
    403,
  );
  return { order, document: issue, field: "attachments" };
}
function present({ order, document, field }, base) {
  return {
    revision: order.revision,
    images: document[field].map((i) => ({
      _id: i._id,
      url: `/api/${base}/${order._id}${field === "attachments" ? "/" + document._id : ""}/${i._id}`,
      width: i.width,
      height: i.height,
      size: i.size,
    })),
  };
}
function revision(req, context) {
  const expected = z.coerce
    .number()
    .int()
    .min(0)
    .parse(req.body?.expectedRevision);
  assert(
    req.body?.expectedRevision !== "" && req.body?.expectedRevision != null,
    "Expected revision is required",
  );
  assert(
    context.order.revision === expected,
    "Order changed. Reload before changing images.",
    409,
  );
}
function target(req, context) {
  if (!req.params.imageId) return null;
  const image = context.document[context.field].id(
    objectId(req.params.imageId),
  );
  assert(image, "Image unavailable", 404);
  return image;
}
function mediaRouter({ access, base, folder, route }) {
  const router = Router();
  router.get(route, async (req, res) =>
    res.json(present(await access(req, false, null), base)),
  );
  router.get(route + "/:imageId", async (req, res) => {
    const context = await access(req, false, null),
      image = target(req, context);
    res.set({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (!image.public_id) {
      res.type("image/webp").sendFile(mediaPath(image.key));
      return;
    }
    try {
      const remote = await cloudinaryStorage.read(image, {
        thumbnail: req.query.thumbnail === "true",
        accept: req.get("accept") || "image/webp",
      });
      const mime = String(remote.headers["content-type"] || "").split(";")[0];
      if (![...IMAGE_TYPES, "image/avif"].includes(mime)) {
        remote.data.destroy();
        throw new Error("Invalid image response");
      }
      res.type(mime);
      await pipeline(remote.data, res);
    } catch {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      // A migration retains its original file until verification/retirement.
      if (image.key) {
        res.type("image/webp").sendFile(mediaPath(image.key));
        return;
      }
      throw new AppError(
        "Image temporarily unavailable. Please retry.",
        502,
        "MEDIA_UNAVAILABLE",
      );
    }
  });
  for (const method of ["post", "put", "delete"]) {
    const creating = method === "post",
      removing = method === "delete";
    router[method](
      route + (creating ? "" : "/:imageId"),
      async (req, _res, next) => {
        const context = await access(req, true, null, creating);
        target(req, context); // Scope and ID checks precede reading upload bytes.
        if (creating)
          assert(
            context.document[context.field].length < 6,
            "Up to six images are supported",
          );
        next();
      },
      ...(removing ? [] : [multipart]),
      async (req, res) => {
        const context = await access(req, true, null, creating);
        revision(req, context);
        target(req, context);
        const uploaded = removing
          ? null
          : await cloudinaryStorage.put(req.file, folder);
        // Orphan cleanup survives failed/ambiguous DB commits. Never delete an
        // upload in a catch block: a commit may actually have succeeded.
        const result = await transaction(async (session) => {
          const current = await access(req, true, session, creating);
          revision(req, current);
          const old = target(req, current);
          const position = old
            ? current.document[current.field].indexOf(old)
            : current.document[current.field].length;
          if (creating)
            assert(
              current.document[current.field].length < 6,
              "Up to six images are supported",
            );
          if (old) {
            await queueMediaCleanup(old, session);
            old.deleteOne();
          }
          if (uploaded) {
            current.document[current.field].splice(position, 0, {
              ...uploaded,
              ...(old ? { _id: old._id } : {}),
              uploadedBy: req.actor,
              uploadedAt: new Date(),
            });
            await MediaCleanup.deleteOne({
              public_id: uploaded.public_id,
            }).session(session);
          }
          current.order.revision++;
          if (current.document !== current.order)
            await current.document.save({ session });
          await current.order.save({ session });
          await audit(
            req.actor,
            `${folder === "orders" ? "ORDER_IMAGE" : "ISSUE_ATTACHMENT"}_${creating ? "ADDED" : removing ? "REMOVED" : "REPLACED"}`,
            folder === "orders" ? "Order" : "TrackingIssue",
            current.document._id,
            current.order.businessType,
            {},
            session,
          );
          return present(current, base);
        });
        res.status(creating ? 201 : 200).json(result);
      },
    );
  }
  return router;
}
export const issueMediaRouter = mediaRouter({
  access: issueAccess,
  base: "issue-media",
  folder: "issues",
  route: "/:orderId/:issueId",
});
export default mediaRouter({
  access: orderAccess,
  base: "order-media",
  folder: "orders",
  route: "/:orderId",
});
