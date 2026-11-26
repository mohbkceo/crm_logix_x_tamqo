import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { cloudinaryStorage, MAX_IMAGE_BYTES } from "../../cloudinaryStorage.js";
import { mediaPath } from "../../mediaStorage.js";

const MAX_IMAGES = 6;

async function streamToBuffer(stream, limit = MAX_IMAGE_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) {
      stream.destroy?.();
      throw new Error("Image too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Read through the same server-side storage paths as the authenticated media
// route: signed Cloudinary URLs are generated, used and discarded here and are
// never sent to Telegram. Legacy/migrating files fall back to local disk.
async function readOriginal(image) {
  if (image.public_id) {
    try {
      const remote = await cloudinaryStorage.read(image, {
        accept: "image/jpeg,image/webp",
      });
      return await streamToBuffer(remote.data);
    } catch (error) {
      if (!image.key) throw error;
    }
  }
  return readFile(mediaPath(image.key));
}

// Telegram photos are uploaded as multipart JPEG bytes (WebP is not a reliable
// photo format across Telegram clients).
export async function loadOrderPhotos(order, { read = readOriginal } = {}) {
  const images = (order.images || []).slice(0, MAX_IMAGES);
  const photos = [];
  let failed = 0;
  for (const [index, image] of images.entries()) {
    try {
      const original = await read(image);
      const buffer = await sharp(original, {
        limitInputPixels: 25000000,
        animated: false,
      })
        .rotate()
        .resize({
          width: 1600,
          height: 1600,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85 })
        .toBuffer();
      photos.push({
        buffer,
        mime: "image/jpeg",
        filename: `order-${index + 1}.jpg`,
      });
    } catch {
      failed++;
    }
  }
  return { photos, failed, total: images.length };
}
