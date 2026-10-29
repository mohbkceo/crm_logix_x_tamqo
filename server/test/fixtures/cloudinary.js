import { Writable, Readable } from "node:stream";
import { v2 as cloudinary } from "cloudinary";
import { cloudinaryStorage } from "../../src/services/cloudinaryStorage.js";

// Only the external boundary is faked; validation, Mongo transactions, access
// control, cleanup and the real SDK URL builder run in the test processes.
export function fakeCloudinary(mock) {
  process.env.CLOUDINARY_CLOUD_NAME = "crm-test";
  process.env.CLOUDINARY_API_KEY = "test-key";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  const state = {
    assets: new Map(),
    uploads: [],
    deletes: [],
    failUpload: false,
    failDelete: false,
    failEager: false,
    afterUpload: null,
  };
  mock.method(cloudinary.uploader, "upload_stream", (options, done) => {
    state.uploads.push(options);
    const chunks = [];
    return new Writable({
      write(chunk, _encoding, cb) {
        chunks.push(chunk);
        cb();
      },
      final(cb) {
        const buffer = Buffer.concat(chunks);
        state.assets.set(options.public_id, buffer);
        Promise.resolve()
          .then(() => state.afterUpload?.(options))
          .then(() => {
            if (state.failUpload) done(new Error("private provider error"));
            else
              done(null, {
                public_id: options.public_id,
                secure_url: `https://res.cloudinary.com/crm-test/image/authenticated/s--providerSignature--/v1/${options.public_id}.webp`,
                version: 1,
                eager: options.eager.map(() =>
                  state.failEager
                    ? { error: "transform failed" }
                    : {
                        secure_url:
                          "https://res.cloudinary.com/crm-test/derived.webp",
                      },
                ),
              });
            cb();
          })
          .catch(cb);
      },
    });
  });
  mock.method(cloudinary.uploader, "destroy", async (id, options) => {
    state.deletes.push({ id, options });
    if (state.failDelete) throw new Error("private provider error");
    const found = state.assets.delete(id);
    return { result: found ? "ok" : "not found" };
  });
  const originalRead = cloudinaryStorage.read;
  mock.method(cloudinaryStorage, "read", async (image) => {
    const bytes = state.assets.get(image.public_id);
    if (!bytes) throw new Error("not found");
    return {
      headers: { "content-type": "image/webp" },
      data: Readable.from([bytes]),
    };
  });
  return {
    ...state,
    originalRead,
    reset() {
      state.assets.clear();
      state.uploads.length = 0;
      state.deletes.length = 0;
      state.failUpload = false;
      state.failDelete = false;
      state.failEager = false;
      state.afterUpload = null;
    },
    state,
  };
}
