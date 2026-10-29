import { v2 as cloudinary } from "cloudinary";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import axios from "axios";
import { assert, AppError } from "../errors.js";
import { MediaCleanup } from "../models/media.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
// Authenticated assets cannot create derived images on demand. Upload and
// delivery must use exactly the same eager transformation chain and format.
export const deliveryTransformation = (size) => [
  { width: size, height: size, crop: "limit" },
  { quality: "auto" },
];
export const managedPublicId = (id) =>
  /^logix-crm\/(orders|issues)\/[a-f0-9-]{36}$/.test(id || "");
export const checksum = (buffer) =>
  createHash("sha256").update(buffer).digest("hex");
export function configuredCloudinary() {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } =
    process.env;
  assert(
    CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET,
    "Image storage is not configured. Contact an administrator.",
    503,
    "MEDIA_UNAVAILABLE",
  );
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
  return cloudinary;
}
export async function prepareImage(file) {
  assert(
    file && IMAGE_TYPES.includes(file.mimetype),
    "Upload a JPEG, PNG or WebP image",
  );
  assert(
    Buffer.isBuffer(file.buffer) &&
      file.buffer.length > 0 &&
      file.buffer.length <= MAX_IMAGE_BYTES,
    "Images must be 5 MB or smaller",
  );
  try {
    const input = sharp(file.buffer, {
      limitInputPixels: 25000000,
      animated: false,
    });
    const metadata = await input.metadata();
    assert(
      { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[
        metadata.format
      ] === file.mimetype,
      "Image content does not match its MIME type",
    );
    return await input
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
    throw new AppError(
      "Invalid image. Use a JPEG, PNG or WebP up to 25 megapixels.",
      400,
      "INVALID_UPLOAD",
    );
  }
}
export const cloudinaryStorage = {
  async put(file, folder) {
    assert(["orders", "issues"].includes(folder), "Invalid media folder");
    const output = await prepareImage(file);
    const sdk = configuredCloudinary();
    const public_id = `logix-crm/${folder}/${randomUUID()}`;
    // A timeout/crash can leave a remote asset even if upload never returned.
    // Record its server-generated ID first; the reaper can safely recover it.
    await MediaCleanup.create({
      public_id,
      notBefore: new Date(Date.now() + 86400000),
    });
    try {
      const result = await new Promise((resolve, reject) => {
        const stream = sdk.uploader.upload_stream(
          {
            public_id,
            asset_folder: `logix-crm/${folder}`,
            resource_type: "image",
            type: "authenticated",
            overwrite: false,
            format: "webp",
            eager: [320, 1600].map((size) => ({
              transformation: deliveryTransformation(size),
              format: "webp",
            })),
            eager_async: false,
            timeout: 60000,
          },
          (error, response) => (error ? reject(error) : resolve(response)),
        );
        stream.on("error", reject);
        stream.end(output.data);
      });
      assert(
        result.public_id === public_id &&
          result.secure_url?.startsWith("https://res.cloudinary.com/"),
        "Unexpected storage response",
        502,
      );
      assert(
        result.eager?.length === 2 &&
          result.eager.every((item) => item.secure_url && !item.error),
        "Preview generation failed",
        502,
      );
      return {
        public_id,
        // Store the canonical unsigned URL, never a reusable provider signature.
        secure_url: sdk.url(public_id, {
          secure: true,
          sign_url: false,
          resource_type: "image",
          type: "authenticated",
          version: result.version,
          format: "webp",
        }),
        resource_type: "image",
        type: "authenticated",
        version: result.version,
        format: "webp",
        mime: "image/webp",
        size: output.data.length,
        width: output.info.width,
        height: output.info.height,
        sha256: checksum(output.data),
      };
    } catch {
      throw new AppError(
        "Image upload failed. Your existing images are unchanged. Please retry.",
        502,
        "MEDIA_UPLOAD_FAILED",
      );
    }
  },
  async remove(public_id) {
    assert(managedPublicId(public_id), "Invalid media reference");
    const response = await configuredCloudinary().uploader.destroy(public_id, {
      resource_type: "image",
      type: "authenticated",
      invalidate: true,
    });
    assert(
      ["ok", "not found"].includes(response.result),
      "Image cleanup failed",
      502,
    );
  },
  async read(
    image,
    { original = false, thumbnail = false, accept = "image/webp" } = {},
  ) {
    assert(managedPublicId(image.public_id), "Invalid media reference");
    const url = configuredCloudinary().url(image.public_id, {
      secure: true,
      sign_url: true,
      resource_type: "image",
      type: "authenticated",
      version: image.version,
      format: image.format || "webp",
      ...(original
        ? {}
        : {
            transformation: deliveryTransformation(thumbnail ? 320 : 1600),
          }),
    });
    // Never fetch a URL supplied by a client or stored in Mongo; signed URLs are
    // generated here and are never returned to the browser (scope remains live).
    return axios.get(url, {
      responseType: "stream",
      timeout: 15000,
      maxRedirects: 0,
      headers: { Accept: accept },
      maxContentLength: MAX_IMAGE_BYTES,
    });
  },
};
