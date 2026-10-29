import { before, after, beforeEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import sharp from "sharp";
import axios from "axios";
import supertest from "supertest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { app } from "../src/app.js";
import { Order } from "../src/models/index.js";
import { TrackingIssue, IssueType } from "../src/models/tracking.js";
import { MediaCleanup } from "../src/models/media.js";
import { User, AuditLog } from "../src/models/security.js";
import {
  MAX_IMAGE_BYTES,
  deliveryTransformation,
} from "../src/services/cloudinaryStorage.js";
import { mediaStorage, mediaPath } from "../src/services/mediaStorage.js";
import { cleanupMedia } from "../src/services/mediaCleanup.js";
import { migrateMedia } from "../src/services/mediaMigration.js";
import { P } from "../../shared/permissions.js";
import { fakeCloudinary } from "./fixtures/cloudinary.js";

let replica, tmp, png, admin, owner, stranger, viewer, cloud, type;
const actor = (user) => ({ userId: user._id, name: user.name });
before(
  async () => {
    cloud = fakeCloudinary(mock);
    tmp = await mkdtemp(path.join(os.tmpdir(), "crm-cloudinary-tests-"));
    process.env.MEDIA_STORAGE_DIR = tmp;
    replica = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replica.getUri("isolated_media_tests"));
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
    png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const password = "media-test-password",
      passwordHash = await bcrypt.hash(password, 4);
    async function employee(name, permissions, extra = {}) {
      const user = await User.create({
        name,
        email: `${name}@media.invalid`,
        passwordHash,
        permissions,
        businessAccess: ["LOGIX"],
        ...extra,
      });
      const api = supertest.agent(app);
      assert.equal(
        (
          await api
            .post("/api/auth/login")
            .send({ email: user.email, password })
        ).status,
        200,
      );
      return { user, api };
    }
    admin = await employee("admin", [], { role: "SUPER_ADMIN" });
    owner = await employee("owner", [
      P.orders.create,
      P.orders.viewOwn,
      P.orders.updateOwn,
      P.tracking.view,
      P["tracking.issue"].view,
      P["tracking.issue"].create,
    ]);
    stranger = await employee("stranger", owner.user.permissions);
    viewer = await employee("viewer", [
      P.orders.viewAll,
      P.tracking.view,
      P.tracking.viewAll,
      P["tracking.issue"].view,
    ]);
    type = await IssueType.create({ label: "Other", code: "OTHER" });
  },
  { timeout: 300000 },
);
after(async () => {
  await mongoose.disconnect();
  await replica?.stop();
  mock.restoreAll();
  if (tmp?.startsWith(path.join(os.tmpdir(), "crm-cloudinary-tests-")))
    await rm(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const model of [Order, TrackingIssue, MediaCleanup, AuditLog])
    await model.deleteMany({});
  cloud.reset();
});
async function order(extra = {}) {
  return Order.create({
    orderNumber: randomUUID(),
    businessType: "LOGIX_ONLY",
    createdBy: actor(owner.user),
    customerId: new mongoose.Types.ObjectId(),
    location: { wilayaId: new mongoose.Types.ObjectId() },
    source: { id: new mongoose.Types.ObjectId() },
    tamqoRevenue: 0,
    logixRevenue: 100,
    productRevenue: 100,
    deliveryCharged: 0,
    totalOrderValue: 100,
    items: [
      {
        business: "LOGIX",
        type: "PRODUCT",
        name: "Plaque",
        quantity: 1,
        unitPrice: 100,
        subtotal: 100,
        catalogItemId: new mongoose.Types.ObjectId(),
      },
    ],
    delivery: { type: "HOME" },
    payment: { method: "COD", amountPaidOnline: 0, amountToCollect: 100 },
    tracking: { stage: "PREPARING" },
    ...extra,
  });
}
async function issue(o, reporter = owner.user) {
  return TrackingIssue.create({
    orderId: o._id,
    typeId: type._id,
    severity: "INFO",
    blocking: false,
    reporter: actor(reporter),
    requestId: randomUUID(),
  });
}
const endpoint = (o, i) =>
  i ? `/api/issue-media/${o._id}/${i._id}` : `/api/order-media/${o._id}`;
function upload(
  api,
  url,
  revision = 0,
  buffer = png,
  mime = "image/png",
  method = "post",
) {
  return api[method](url)
    .field("expectedRevision", String(revision))
    .attach("image", buffer, {
      filename: "../../design.png",
      contentType: mime,
    });
}
async function add(o, i) {
  const response = await upload(owner.api, endpoint(o, i), o.revision);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

test("signed backend upload stores only asset references/metadata and preserves order workflow", async () => {
  const o = await order(),
    saved = await add(o),
    current = await Order.findById(o._id);
  const image = current.images[0];
  assert.match(image.public_id, /^logix-crm\/orders\//);
  assert.ok(image.secure_url.startsWith("https://res.cloudinary.com/"));
  assert.ok(!image.secure_url.includes("/s--"));
  assert.equal(image.key, undefined);
  assert.equal(image.mime, "image/webp");
  assert.equal(String(image.uploadedBy.userId), String(owner.user._id));
  assert.equal(current.revision, 1);
  assert.equal(current.status, o.status);
  assert.deepEqual(current.tracking.toObject(), o.tracking.toObject());
  assert.equal(await MediaCleanup.countDocuments(), 0);
  assert.deepEqual(cloud.uploads[0], {
    public_id: image.public_id,
    asset_folder: "logix-crm/orders",
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
  });
  assert.ok(!JSON.stringify(saved).includes("test-secret"));
  const preview = await owner.api.get(saved.images[0].url);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers["cache-control"], "private, no-store");
  assert.equal((await supertest(app).get(saved.images[0].url)).status, 401);
  assert.equal((await stranger.api.get(saved.images[0].url)).status, 404);
});

test("rejects spoofed MIME, SVG, oversized bytes, missing files, extra fields and stale revisions before remote upload", async () => {
  const o = await order(),
    url = endpoint(o);
  for (const response of [
    await upload(owner.api, url, 0, Buffer.from('<svg onload="x"/>')),
    await upload(owner.api, url, 0, png, "image/jpeg"),
    await upload(owner.api, url, 0, png, "image/svg+xml"),
    await upload(owner.api, url, 0, Buffer.alloc(MAX_IMAGE_BYTES + 1)),
    await owner.api.post(url).field("expectedRevision", "0"),
    await owner.api
      .post(url)
      .field("expectedRevision", "0")
      .field("public_id", "other/id")
      .attach("image", png, "x.png"),
    await upload(owner.api, url, 2),
  ])
    assert.ok(
      [400, 409].includes(response.status),
      JSON.stringify(response.body),
    );
  assert.equal(cloud.uploads.length, 0);
  assert.equal((await Order.findById(o._id)).images.length, 0);
});

test("ownership, business scope, origin, session and existing permissions gate every mutation", async () => {
  const o = await order(),
    saved = await add(o),
    url = saved.images[0].url;
  for (const account of [stranger, viewer]) {
    assert.equal((await upload(account.api, endpoint(o), 1)).status, 403);
    assert.equal(
      (await upload(account.api, url, 1, png, "image/png", "put")).status,
      403,
    );
    assert.equal(
      (await account.api.delete(url).send({ expectedRevision: 1 })).status,
      403,
    );
  }
  assert.equal((await supertest(app).post(endpoint(o))).status, 401);
  assert.equal(
    (
      await owner.api
        .delete(url)
        .set("Origin", "https://evil.invalid")
        .send({ expectedRevision: 1 })
    ).status,
    403,
  );
  const partnership = await order({
    businessType: "PARTNERSHIP",
    items: [
      ...o.items.toObject(),
      {
        business: "TAMQO",
        type: "PLAN",
        name: "Plan",
        quantity: 1,
        unitPrice: 100,
        subtotal: 100,
        catalogItemId: new mongoose.Types.ObjectId(),
      },
    ],
  });
  assert.equal((await upload(owner.api, endpoint(partnership))).status, 403);
  assert.equal(cloud.uploads.length, 1);
});

test("replacement retains its preview ID; removed assets are deleted only by reference-aware cleanup", async () => {
  const o = await order(),
    first = await add(o);
  const old = (await Order.findById(o._id)).images[0].public_id;
  const replacement = await upload(
    owner.api,
    first.images[0].url,
    1,
    png,
    "image/png",
    "put",
  );
  assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
  assert.equal(replacement.body.images[0]._id, first.images[0]._id);
  assert.equal(cloud.deletes.length, 0);
  assert.deepEqual(await cleanupMedia(), {
    deleted: 1,
    referenced: 0,
    failed: 0,
  });
  assert.equal(cloud.deletes[0].id, old);
  assert.deepEqual(cloud.deletes[0].options, {
    resource_type: "image",
    type: "authenticated",
    invalidate: true,
  });
  assert.equal(
    (await owner.api.delete(first.images[0].url).send({ expectedRevision: 2 }))
      .status,
    200,
  );
  assert.equal((await Order.findById(o._id)).images.length, 0);
  assert.equal((await cleanupMedia()).deleted, 1);
});

test("shared assets remain protected by resolved issues and soft-deleted orders", async () => {
  const o = await order(),
    saved = await add(o);
  const image = (await Order.findById(o._id)).images[0].toObject();
  const archived = await order({ images: [image], deletedAt: new Date() });
  const i = await issue(o);
  i.attachments.push(image);
  i.status = "RESOLVED";
  await i.save();
  await owner.api.delete(saved.images[0].url).send({ expectedRevision: 1 });
  assert.equal((await cleanupMedia()).referenced, 1);
  assert.equal(cloud.deletes.length, 0);
  await Order.updateOne({ _id: archived._id }, { $set: { images: [] } });
  await MediaCleanup.updateMany({}, { notBefore: new Date(0) });
  assert.equal((await cleanupMedia()).referenced, 1);
  await TrackingIssue.updateOne({ _id: i._id }, { $set: { attachments: [] } });
  await MediaCleanup.updateMany({}, { notBefore: new Date(0) });
  assert.equal((await cleanupMedia()).deleted, 1);
});

test("upload failures and uncertain remote outcomes preserve records and leave durable orphan cleanup", async () => {
  const o = await order(),
    saved = await add(o),
    original = (await Order.findById(o._id)).toObject();
  cloud.state.failUpload = true;
  const response = await upload(
    owner.api,
    saved.images[0].url,
    1,
    png,
    "image/png",
    "put",
  );
  assert.equal(response.status, 502);
  assert.ok(!JSON.stringify(response.body).includes("private provider"));
  assert.deepEqual((await Order.findById(o._id)).toObject(), original);
  assert.equal((await cleanupMedia()).deleted, 0); // 24h protects in-flight uploads/ambiguous commits.
  await MediaCleanup.updateMany({}, { notBefore: new Date(0) });
  assert.equal((await cleanupMedia()).deleted, 1);
  assert.ok(cloud.assets.has(original.images[0].public_id));
});

test("revision races roll back attachment changes and recover uncommitted uploads", async () => {
  const o = await order();
  cloud.state.afterUpload = () =>
    Order.updateOne({ _id: o._id }, { $inc: { revision: 1 } });
  const response = await upload(owner.api, endpoint(o));
  assert.equal(response.status, 409);
  assert.equal((await Order.findById(o._id)).images.length, 0);
  assert.equal(await MediaCleanup.countDocuments(), 1);
  await MediaCleanup.updateMany({}, { notBefore: new Date(0) });
  assert.equal((await cleanupMedia()).deleted, 1);
});

test("cleanup failure retries without changing committed removals; concurrent workers do not double-delete", async () => {
  const o = await order(),
    saved = await add(o);
  await owner.api.delete(saved.images[0].url).send({ expectedRevision: 1 });
  cloud.state.failDelete = true;
  assert.equal((await cleanupMedia()).failed, 1);
  assert.equal((await MediaCleanup.findOne()).attempts, 1);
  assert.equal((await Order.findById(o._id)).images.length, 0);
  cloud.state.failDelete = false;
  await MediaCleanup.updateMany({}, { notBefore: new Date(0) });
  const results = await Promise.all([cleanupMedia(), cleanupMedia()]);
  assert.equal(
    results.reduce((sum, r) => sum + r.deleted, 0),
    1,
  );
  assert.equal(await MediaCleanup.countDocuments(), 0);
});

test("Tracking attachments use report permissions and parent scope without changing stage, counters or resolution", async () => {
  const o = await order(),
    i = await issue(o),
    saved = await add(o, i);
  const current = await Order.findById(o._id),
    report = await TrackingIssue.findById(i._id);
  assert.match(report.attachments[0].public_id, /^logix-crm\/issues\//);
  assert.equal(report.status, "OPEN");
  assert.deepEqual(current.tracking.toObject(), o.tracking.toObject());
  assert.equal((await owner.api.get(saved.images[0].url)).status, 200);
  assert.equal((await viewer.api.get(saved.images[0].url)).status, 200);
  assert.equal((await upload(viewer.api, endpoint(o, i), 1)).status, 403);
  const other = await order();
  assert.equal((await upload(admin.api, endpoint(other, i), 0)).status, 404);
  assert.equal((await stranger.api.get(saved.images[0].url)).status, 404);
  const replaced = await upload(
    owner.api,
    saved.images[0].url,
    1,
    png,
    "image/png",
    "put",
  );
  assert.equal(replaced.status, 200);
  assert.equal(
    (await admin.api.delete(saved.images[0].url).send({ expectedRevision: 2 }))
      .status,
    200,
  );
  assert.equal((await TrackingIssue.findById(i._id)).attachments.length, 0);
});

test("six-image limit, stale deletes and invalid nested IDs do not call Cloudinary", async () => {
  const o = await order();
  let saved;
  for (let n = 0; n < 6; n++)
    saved = (await upload(owner.api, endpoint(o), n)).body;
  assert.equal((await upload(owner.api, endpoint(o), 6)).status, 400);
  assert.equal(
    (await owner.api.delete(saved.images[0].url).send({ expectedRevision: 0 }))
      .status,
    409,
  );
  assert.equal(
    (
      await upload(
        owner.api,
        endpoint(o) + "/" + new mongoose.Types.ObjectId(),
        6,
        png,
        "image/png",
        "put",
      )
    ).status,
    404,
  );
  assert.equal(cloud.uploads.length, 6);
  assert.equal((await Order.findById(o._id)).images.length, 6);
});

test("legacy migration is dry-run by default, verified, idempotent and retains files and preview IDs", async () => {
  const legacy = await mediaStorage.put({
    buffer: png,
    mimetype: "image/png",
    size: png.length,
  });
  const o = await order({ images: [legacy] }),
    imageId = o.images[0]._id;
  const originalBytes = await readFile(mediaPath(legacy.key));
  assert.equal((await owner.api.get(endpoint(o) + "/" + imageId)).status, 200);
  const dry = await migrateMedia();
  assert.equal(dry.legacy, 1);
  assert.equal(dry.migrated, 0);
  assert.equal(cloud.uploads.length, 0);
  assert.equal((await migrateMedia({ apply: true })).migrated, 1);
  const image = (await Order.findById(o._id)).images[0];
  assert.equal(String(image._id), String(imageId));
  assert.equal(image.key, legacy.key);
  assert.ok(image.public_id);
  assert.deepEqual(await readFile(mediaPath(legacy.key)), originalBytes);
  assert.equal((await migrateMedia({ verify: true })).verified, 1);
  assert.equal((await migrateMedia({ apply: true })).skipped, 1);
  cloud.assets.delete(image.public_id);
  assert.equal((await migrateMedia({ verify: true })).failed, 1);
  assert.equal((await owner.api.get(endpoint(o) + "/" + imageId)).status, 200); // Local fallback.
});

test("migration skips missing/unsafe files and failed remote verification without corrupting historical references", async () => {
  const legacy = await mediaStorage.put({
    buffer: png,
    mimetype: "image/png",
    size: png.length,
  });
  const o = await order({
    images: [legacy, { key: `${randomUUID()}.webp` }, { key: "../../secret" }],
    deletedAt: new Date(),
  });
  cloud.state.afterUpload = ({ public_id }) =>
    cloud.assets.set(public_id, Buffer.from("corrupt"));
  const result = await migrateMedia({ apply: true });
  assert.equal(result.failed, 3);
  assert.equal(result.migrated, 0);
  assert.deepEqual(
    (await Order.findById(o._id)).images.toObject(),
    o.images.toObject(),
  );
  assert.equal(await MediaCleanup.countDocuments(), 1);
});

test("missing configuration fails closed, without falling back to disk for new uploads", async () => {
  const o = await order(),
    secret = process.env.CLOUDINARY_API_SECRET;
  delete process.env.CLOUDINARY_API_SECRET;
  try {
    assert.equal((await upload(owner.api, endpoint(o))).status, 503);
  } finally {
    process.env.CLOUDINARY_API_SECRET = secret;
  }
  assert.equal(cloud.uploads.length, 0);
  assert.equal((await Order.findById(o._id)).images.length, 0);
});

test("delivery signs authenticated optimized URLs on the server and never fetches stored/client URLs", async (t) => {
  const get = t.mock.method(axios, "get", async () => ({ data: "mock" }));
  const id = `logix-crm/orders/${randomUUID()}`;
  await cloud.originalRead(
    {
      public_id: id,
      secure_url: "http://127.0.0.1/private",
      version: 1,
      format: "webp",
    },
    { thumbnail: true },
  );
  const [url, options] = get.mock.calls[0].arguments;
  assert.match(
    url,
    /^https:\/\/res.cloudinary.com\/crm-test\/image\/authenticated\/s--/,
  );
  assert.ok(url.includes("w_320"));
  assert.ok(url.includes("/q_auto/"));
  assert.ok(!url.includes("test-secret"));
  assert.equal(options.maxRedirects, 0);
  await assert.rejects(() =>
    cloud.originalRead({ public_id: "../../outside" }),
  );
});

test("failed eager previews do not attach an unusable image", async () => {
  const o = await order();
  cloud.state.failEager = true;
  assert.equal((await upload(owner.api, endpoint(o))).status, 502);
  assert.equal((await Order.findById(o._id)).images.length, 0);
  assert.equal(await MediaCleanup.countDocuments(), 1);
});

test("cleanup fails closed when reference checks are unavailable", async (t) => {
  const o = await order(),
    saved = await add(o);
  await owner.api.delete(saved.images[0].url).send({ expectedRevision: 1 });
  t.mock.method(Order, "exists", async () => {
    throw new Error("database unavailable");
  });
  assert.equal((await cleanupMedia()).failed, 1);
  assert.equal(cloud.deletes.length, 0);
  assert.equal(await MediaCleanup.countDocuments(), 1);
});

test("migration includes resolved report attachments without changing report status or counters", async () => {
  const o = await order(),
    i = await issue(o);
  const legacy = await mediaStorage.put({
    buffer: png,
    mimetype: "image/png",
    size: png.length,
  });
  i.status = "RESOLVED";
  i.attachments.push(legacy);
  await i.save();
  assert.equal((await migrateMedia({ apply: true })).migrated, 1);
  const saved = await TrackingIssue.findById(i._id);
  assert.equal(saved.status, "RESOLVED");
  assert.equal(String(saved.attachments[0]._id), String(i.attachments[0]._id));
  assert.match(saved.attachments[0].public_id, /^logix-crm\/issues\//);
  assert.deepEqual(
    (await Order.findById(o._id)).tracking.toObject(),
    o.tracking.toObject(),
  );
  assert.equal((await migrateMedia({ verify: true })).verified, 1);
});
