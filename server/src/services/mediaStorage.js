import path from "node:path";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { assert } from "../errors.js";
// Local disk needs no external credentials. Mount MEDIA_STORAGE_DIR on durable storage.
export const mediaRoot = () =>
  path.resolve(
    process.env.MEDIA_STORAGE_DIR ||
      path.join(import.meta.dirname, "../../storage/order-images"),
  );
export function mediaPath(key) {
  assert(/^[a-f0-9-]{36}\.webp$/.test(key), "Invalid media reference", 400);
  return path.join(mediaRoot(), key);
}
export const mediaStorage = {
  async put(file) {
    assert(
      file && ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype),
      "Upload a JPEG, PNG or WebP image",
    );
    assert(file.size <= 5 * 1024 * 1024, "Images must be 5 MB or smaller");
    let metadata, output;
    try {
      const input = sharp(file.buffer, {
        limitInputPixels: 25000000,
        animated: false,
      });
      metadata = await input.metadata();
      assert(
        { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[
          metadata.format
        ] === file.mimetype,
        "Image content does not match its MIME type",
      );
      output = await input
        .rotate()
        .resize({
          width: 1600,
          height: 1600,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 85 })
        .toBuffer({ resolveWithObject: true });
    } catch {
      assert(
        false,
        "Invalid image. Use a JPEG, PNG or WebP up to 25 megapixels.",
      );
    }
    const key = `${randomUUID()}.webp`;
    await mkdir(mediaRoot(), { recursive: true });
    await writeFile(mediaPath(key), output.data, { flag: "wx" });
    return {
      key,
      mime: "image/webp",
      size: output.data.length,
      width: output.info.width,
      height: output.info.height,
    };
  },
  remove: (key) => unlink(mediaPath(key)),
};
