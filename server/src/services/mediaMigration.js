import { readFile } from "node:fs/promises";
import { Order } from "../models/index.js";
import { TrackingIssue } from "../models/tracking.js";
import { MediaCleanup } from "../models/media.js";
import { transaction } from "./orderService.js";
import { mediaPath } from "./mediaStorage.js";
import {
  cloudinaryStorage,
  prepareImage,
  checksum,
  MAX_IMAGE_BYTES,
} from "./cloudinaryStorage.js";
import { assert } from "../errors.js";

async function verifyImage(image) {
  const response = await cloudinaryStorage.read(image, { original: true });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.data) {
    bytes += chunk.length;
    if (bytes > MAX_IMAGE_BYTES) {
      response.data.destroy();
      throw new Error("Image exceeds size limit");
    }
    chunks.push(chunk);
  }
  assert(
    image.sha256 && checksum(Buffer.concat(chunks)) === image.sha256,
    "Cloudinary checksum mismatch",
  );
}

// Dry-run by default. Includes archived orders/resolved reports, preserves IDs,
// never unlinks local files, and rechecks the exact original reference on commit.
export async function migrateMedia({
  apply = false,
  verify = false,
  onRecord = () => {},
} = {}) {
  assert(!(apply && verify), "Choose apply or verify, not both");
  const result = { legacy: 0, migrated: 0, verified: 0, skipped: 0, failed: 0 };
  for (const [Model, field, folder] of [
    [Order, "images", "orders"],
    [TrackingIssue, "attachments", "issues"],
  ]) {
    for await (const doc of Model.find({
      [`${field}.0`]: { $exists: true },
    }).cursor()) {
      for (const image of doc[field]) {
        const record = {
          model: Model.modelName,
          documentId: String(doc._id),
          imageId: String(image._id),
        };
        try {
          if (image.public_id) {
            if (verify) {
              await verifyImage(image);
              result.verified++;
              onRecord({ ...record, status: "verified" });
            } else result.skipped++;
            continue;
          }
          result.legacy++;
          assert(image.key, "Legacy image has no file reference");
          const buffer = await readFile(mediaPath(image.key));
          const file = { buffer, mimetype: "image/webp", size: buffer.length };
          await prepareImage(file);
          if (verify) throw new Error("Legacy reference is not migrated");
          if (!apply) {
            onRecord({ ...record, status: "ready", key: image.key });
            continue;
          }
          const uploaded = await cloudinaryStorage.put(file, folder);
          // Verify actual remote bytes BEFORE replacing the database reference.
          await verifyImage(uploaded);
          await transaction(async (session) => {
            const current = await Model.findById(doc._id).session(session);
            const existing = current?.[field].id(image._id);
            assert(
              existing && !existing.public_id && existing.key === image.key,
              "Image changed during migration",
              409,
            );
            Object.assign(existing, uploaded, { migratedAt: new Date() });
            if (Model === Order) current.revision++;
            else {
              // Coordinate with issue uploads/resolution through the order revision.
              const order = await Order.findById(current.orderId).session(
                session,
              );
              assert(order, "Report order is missing");
              order.revision++;
              await order.save({ session });
            }
            await current.save({ session });
            await MediaCleanup.deleteOne({
              public_id: uploaded.public_id,
            }).session(session);
          });
          result.migrated++;
          onRecord({
            ...record,
            status: "migrated",
            key: image.key,
            public_id: uploaded.public_id,
          });
        } catch (error) {
          result.failed++;
          // Do not serialize provider errors (they may contain signed URLs).
          onRecord({
            ...record,
            status: "failed",
            reason:
              error.code === "ENOENT"
                ? "Legacy file missing"
                : "Validation, upload, verification or concurrent edit failed; original reference retained",
          });
        }
      }
    }
  }
  return result;
}
