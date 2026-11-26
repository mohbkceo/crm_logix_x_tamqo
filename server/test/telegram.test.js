import { before, after, beforeEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import axios from "axios";
import sharp from "sharp";
import supertest from "supertest";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TELEGRAM_WEBHOOK_BASE_URL = "https://crm.example.test";

const { app } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const {
  Order,
  OrderEvent,
  Shipment,
  Customer,
  LogixProduct,
  TamqoPlan,
  OrderSource,
  Wilaya,
} = await import("../src/models/index.js");
const { DeliveryAgency } = await import("../src/models/delivery.js");
const { User, AuditLog } = await import("../src/models/security.js");
const {
  TelegramSetting,
  NotificationOutbox,
  TelegramUpdate,
  TelegramLinkCode,
} = await import("../src/models/telegram.js");
const { createOrder, transaction } =
  await import("../src/services/orderService.js");
const { mediaStorage } = await import("../src/services/mediaStorage.js");
const { decryptCredentials } =
  await import("../src/services/delivery/credentials.js");
const outbox =
  await import("../src/services/notifications/notificationOutboxService.js");
const { runNotificationBatch } =
  await import("../src/services/notifications/notificationWorker.js");
const { runUpdateBatch } =
  await import("../src/services/notifications/telegram/telegramWebhook.js");
const formatter =
  await import("../src/services/notifications/telegram/telegramOrderFormatter.js");
const { parseCommand } =
  await import("../src/services/notifications/telegram/telegramCommandHandler.js");
const { P } = await import("../../shared/permissions.js");
const { fakeCloudinary } = await import("./fixtures/cloudinary.js");

const TOKEN = "123456789:AAEhBOweik6ad6PsVMRxjeQKbOTYa1cX0Aa";
const TOKEN2 = "987654321:BBEhBOweik6ad6PsVMRxjeQKbOTYa1cX0Bb";
const GROUP_LOGIX = "-1001234567890";
const GROUP_TAMQO = "-1009876543210";
const GROUP_ALL = "-1005555555555";

let replica,
  tmp,
  admin,
  viewer,
  confirmer,
  limited,
  agency,
  wilaya,
  product,
  plan,
  source,
  png;
let calls = [];
let handlers = {};
let messageId = 1000;
let updateId = 1;
let webhookSecret = "";

function method(url) {
  return String(url).split("/").pop();
}
const formValue = (form, key) =>
  typeof form?.get === "function" ? form.get(key) : undefined;
function installTelegramMock() {
  mock.method(axios, "post", async (url, body) => {
    assert.ok(
      String(url).startsWith("https://api.telegram.org/bot"),
      "only Telegram is called",
    );
    const name = method(url);
    const token = String(url).split("/bot")[1].split("/")[0];
    calls.push({ name, body, token });
    if (handlers[name]) {
      const result = await handlers[name](body, token);
      if (result !== undefined)
        return { status: 200, data: { ok: true, result } };
    }
    switch (name) {
      case "getMe":
        return {
          status: 200,
          data: {
            ok: true,
            result: {
              id: Number(token.split(":")[0]),
              is_bot: true,
              first_name: "Logix Ops",
              username: token === TOKEN ? "LogixOperationsBot" : "OtherBot",
            },
          },
        };
      case "setWebhook":
        webhookSecret = body.secret_token;
        return { status: 200, data: { ok: true, result: true } };
      case "getWebhookInfo":
        return {
          status: 200,
          data: {
            ok: true,
            result: {
              url: "https://crm.example.test/api/webhooks/telegram",
              pending_update_count: 0,
            },
          },
        };
      case "getChat":
        return {
          status: 200,
          data: {
            ok: true,
            result: {
              id: Number(body.chat_id),
              title: "Ops Group",
              type: "supergroup",
            },
          },
        };
      case "sendMediaGroup": {
        const media = JSON.parse(formValue(body, "media"));
        return {
          status: 200,
          data: {
            ok: true,
            result: media.map(() => ({ message_id: messageId++ })),
          },
        };
      }
      case "sendMessage":
      case "sendPhoto":
        return {
          status: 200,
          data: { ok: true, result: { message_id: messageId++ } },
        };
      default:
        return { status: 200, data: { ok: true, result: true } };
    }
  });
}
const telegramFailure = (status, description, parameters) =>
  Object.assign(new Error("Request failed"), {
    response: {
      status,
      data: { ok: false, error_code: status, description, parameters },
    },
  });
const sent = (name) => calls.filter((c) => c.name === name);

async function employee(name, permissions, extra = {}) {
  const password = "telegram-test-password";
  const user = await User.create({
    name,
    email: `${name}@telegram.invalid`,
    passwordHash: await bcrypt.hash(password, 4),
    permissions,
    businessAccess: ["LOGIX", "TAMQO"],
    ...extra,
  });
  const api = supertest.agent(app);
  assert.equal(
    (await api.post("/api/auth/login").send({ email: user.email, password }))
      .status,
    200,
  );
  return { user, api };
}

function orderInput(kind = "LOGIX_ONLY", overrides = {}) {
  return {
    customer: { name: "Mohamed", phoneA: "0550000000", phoneB: "" },
    location: {
      wilayaId: String(wilaya._id),
      commune: "Alger Centre",
      address: "12 Test Street",
    },
    sourceId: String(source._id),
    items: [
      ...(kind !== "LOGIX_ONLY"
        ? [{ business: "TAMQO", catalogItemId: String(plan._id), quantity: 1 }]
        : []),
      ...(kind !== "TAMQO_ONLY"
        ? [
            {
              business: "LOGIX",
              catalogItemId: String(product._id),
              quantity: 2,
            },
          ]
        : []),
    ],
    delivery: { type: "HOME", exchange: false, agencyId: String(agency._id) },
    deliveryCharged: 400,
    payment: { method: "COD", amountPaidOnline: 0 },
    ...overrides,
  };
}

async function connect() {
  const r = await admin.api
    .put("/api/settings/telegram")
    .send({ token: TOKEN });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function addDestination(body) {
  const r = await admin.api
    .post("/api/settings/telegram/destinations")
    .send(body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.destinations.at(-1);
}
async function standardDestinations() {
  await addDestination({
    name: "Logix Orders",
    chatId: GROUP_LOGIX,
    businessTypes: ["LOGIX_ONLY"],
  });
  await addDestination({
    name: "Tamqo Orders",
    chatId: GROUP_TAMQO,
    messageThreadId: 42,
    businessTypes: ["TAMQO_ONLY"],
  });
}
async function webhook(update, secret = webhookSecret) {
  return supertest(app)
    .post("/api/webhooks/telegram")
    .set("X-Telegram-Bot-Api-Secret-Token", secret)
    .send({ update_id: updateId++, ...update });
}
const groupChat = {
  id: Number(GROUP_LOGIX),
  type: "supergroup",
  title: "LOGIX Operations",
};
async function command(
  text,
  { from = { id: 5001, username: "someone" }, chat = groupChat, thread } = {},
) {
  const r = await webhook({
    message: {
      message_id: messageId++,
      chat,
      from,
      text,
      ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}),
    },
  });
  assert.equal(r.status, 200);
  calls = [];
  await runUpdateBatch();
  return sent("sendMessage").at(-1)?.body;
}
async function press(data, { from, chat = groupChat, message_id = 777 } = {}) {
  const r = await webhook({
    callback_query: {
      id: `cb${updateId}`,
      from,
      data,
      message: { message_id, chat },
    },
  });
  assert.equal(r.status, 200);
  calls = [];
  await runUpdateBatch();
  return {
    answer: sent("answerCallbackQuery").at(-1)?.body,
    edit: sent("editMessageText").at(-1)?.body,
  };
}
async function link(user, telegramId, username = "tg_user") {
  const code = (await user.api.post("/api/settings/telegram/link-code")).body
    .code;
  const reply = await command(`/link ${code}`, {
    from: { id: telegramId, username },
    chat: { id: telegramId, type: "private" },
  });
  assert.match(reply.text, /Linked to CRM user/);
}
async function createViaApi(kind = "LOGIX_ONLY", overrides = {}) {
  const r = await admin.api
    .post("/api/orders")
    .send(orderInput(kind, overrides));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

before(
  async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "crm-telegram-tests-"));
    process.env.MEDIA_STORAGE_DIR = tmp;
    replica = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replica.getUri("telegram_tests"));
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
    await seed();
    wilaya = await Wilaya.findOne({ agencyId: "16" });
    [product] = await LogixProduct.create([
      { name: "20cm Plaque", price: 3500 },
    ]);
    [plan] = await TamqoPlan.create([
      { name: "3 Months", price: 4000, durationDays: 90 },
    ]);
    source = await OrderSource.create({ name: "Messages", isDefault: true });
    agency = await DeliveryAgency.create({
      name: "Manual courier",
      code: "MANUAL_TG",
      businesses: ["LOGIX", "TAMQO"],
      integrationType: "MANUAL",
      apiProvider: "MANUAL",
    });
    admin = await employee("admin", [], { role: "SUPER_ADMIN" });
    viewer = await employee("viewer", [P.settings.view]);
    confirmer = await employee("confirmer", [
      P.orders.viewAll,
      P.orders.confirm,
      P.orders.prepare,
      P.orders.cancel,
    ]);
    limited = await employee("limited", [P.orders.viewAll], {
      businessAccess: ["LOGIX"],
    });
    png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    installTelegramMock();
  },
  { timeout: 300000 },
);
after(async () => {
  mock.restoreAll();
  await mongoose.disconnect();
  await replica?.stop();
  await rm(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const Model of [
    Order,
    OrderEvent,
    Shipment,
    Customer,
    TelegramSetting,
    NotificationOutbox,
    TelegramUpdate,
    TelegramLinkCode,
  ])
    await Model.deleteMany({});
  await User.updateMany(
    {},
    { $unset: { telegramUserId: 1, telegramUsername: 1, telegramLinkedAt: 1 } },
  );
  calls = [];
  handlers = {};
  webhookSecret = "";
});

// ---------------------------------------------------------------- settings

test("connecting a bot validates, encrypts the token and configures the webhook", async () => {
  const body = await connect();
  assert.deepEqual(
    {
      enabled: body.enabled,
      configured: body.configured,
      connected: body.connected,
      botUsername: body.botUsername,
      webhookConfigured: body.webhookConfigured,
    },
    {
      enabled: true,
      configured: true,
      connected: true,
      botUsername: "LogixOperationsBot",
      webhookConfigured: true,
    },
  );
  const serialized = JSON.stringify(body);
  assert.ok(
    !serialized.includes(TOKEN) &&
      !serialized.includes("encryptedToken") &&
      !serialized.includes(webhookSecret),
  );
  const stored = await TelegramSetting.findById("telegram")
    .select("+encryptedToken +webhookSecretHash")
    .lean();
  assert.ok(stored.encryptedToken && !stored.encryptedToken.includes(TOKEN));
  assert.equal(
    decryptCredentials(stored.encryptedToken).telegramBotToken,
    TOKEN,
  );
  assert.notEqual(stored.webhookSecretHash, webhookSecret);
  const hook = sent("setWebhook")[0].body;
  assert.equal(hook.url, "https://crm.example.test/api/webhooks/telegram");
  assert.ok(!hook.url.includes(TOKEN));
  assert.deepEqual(hook.allowed_updates, ["message", "callback_query"]);
  assert.equal(hook.drop_pending_updates, false);
  assert.match(hook.secret_token, /^[a-f0-9]{64}$/);
  assert.ok(
    sent("setMyCommands")[0].body.commands.every((c) =>
      /^[a-z0-9_]+$/.test(c.command),
    ),
  );
  const auditRows = await AuditLog.find({
    resourceType: "TelegramSetting",
  }).lean();
  assert.ok(auditRows.length && !JSON.stringify(auditRows).includes(TOKEN));
  const read = await viewer.api.get("/api/settings/telegram");
  assert.equal(read.status, 200);
  assert.ok(!JSON.stringify(read.body).includes(TOKEN));
});

test("blank token preserves, replacement re-encrypts, invalid tokens and disconnect are handled", async () => {
  await connect();
  const first = (
    await TelegramSetting.findById("telegram").select("+encryptedToken").lean()
  ).encryptedToken;
  const blank = await admin.api
    .put("/api/settings/telegram")
    .send({ token: "", enabled: false });
  assert.equal(blank.status, 200);
  assert.equal(blank.body.enabled, false);
  assert.equal(
    (
      await TelegramSetting.findById("telegram")
        .select("+encryptedToken")
        .lean()
    ).encryptedToken,
    first,
  );

  const replaced = await admin.api
    .put("/api/settings/telegram")
    .send({ token: TOKEN2 });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.botUsername, "OtherBot");
  const second = (
    await TelegramSetting.findById("telegram").select("+encryptedToken").lean()
  ).encryptedToken;
  assert.equal(decryptCredentials(second).telegramBotToken, TOKEN2);

  assert.equal(
    (
      await admin.api
        .put("/api/settings/telegram")
        .send({ token: "not-a-token" })
    ).status,
    400,
  );
  handlers.getMe = () => {
    throw telegramFailure(401, "Unauthorized");
  };
  const rejected = await admin.api
    .put("/api/settings/telegram")
    .send({ token: TOKEN });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, "TELEGRAM_CONNECTION_FAILED");
  assert.equal(
    decryptCredentials(
      (
        await TelegramSetting.findById("telegram")
          .select("+encryptedToken")
          .lean()
      ).encryptedToken,
    ).telegramBotToken,
    TOKEN2,
  );
  handlers = {};

  const disconnected = await admin.api.post(
    "/api/settings/telegram/disconnect",
  );
  assert.equal(disconnected.status, 200);
  assert.deepEqual(
    [
      disconnected.body.configured,
      disconnected.body.enabled,
      disconnected.body.botUsername,
    ],
    [false, false, ""],
  );
  assert.equal(sent("deleteWebhook")[0].body.drop_pending_updates, false);
  const cleared = await TelegramSetting.findById("telegram")
    .select("+encryptedToken +webhookSecretHash")
    .lean();
  assert.equal(cleared.encryptedToken, undefined);
  assert.equal(cleared.webhookSecretHash, undefined);
  assert.equal(
    (await admin.api.put("/api/settings/telegram").send({ enabled: true }))
      .status,
    409,
  );
});

test("token storage requires the configured encryption key", async () => {
  const key = process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY;
  delete process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY;
  try {
    const r = await admin.api
      .put("/api/settings/telegram")
      .send({ token: TOKEN });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, "TELEGRAM_ENCRYPTION_UNAVAILABLE");
    assert.equal(sent("getMe").length, 0);
  } finally {
    process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY = key;
  }
});

test("settings endpoints enforce permissions", async () => {
  assert.equal(
    (await supertest(app).get("/api/settings/telegram")).status,
    401,
  );
  assert.equal((await confirmer.api.get("/api/settings/telegram")).status, 403);
  assert.equal(
    (await viewer.api.put("/api/settings/telegram").send({ token: TOKEN }))
      .status,
    403,
  );
  assert.equal(
    (
      await viewer.api
        .post("/api/settings/telegram/destinations")
        .send({ name: "x", chatId: GROUP_LOGIX, businessTypes: ["LOGIX_ONLY"] })
    ).status,
    403,
  );
  assert.equal(
    (await viewer.api.post("/api/settings/telegram/disconnect")).status,
    403,
  );
  assert.equal(sent("getMe").length, 0);
});

test("destinations can be added, validated, edited, tested and deleted", async () => {
  await connect();
  const d = await addDestination({
    name: "Logix Orders",
    chatId: GROUP_LOGIX,
    messageThreadId: "12",
    businessTypes: ["LOGIX_ONLY", "PARTNERSHIP", "LOGIX_ONLY"],
  });
  assert.deepEqual(
    [d.chatId, d.messageThreadId, d.businessTypes, d.enabled],
    [GROUP_LOGIX, 12, ["LOGIX_ONLY", "PARTNERSHIP"], true],
  );
  const bad = (body) =>
    admin.api
      .post("/api/settings/telegram/destinations")
      .send({
        name: "x",
        chatId: GROUP_LOGIX,
        businessTypes: ["LOGIX_ONLY"],
        ...body,
      });
  assert.equal((await bad({ chatId: "@mygroup" })).status, 400);
  assert.equal((await bad({ chatId: "-100abc" })).status, 400);
  assert.equal((await bad({ messageThreadId: "abc" })).status, 400);
  assert.equal((await bad({ messageThreadId: 0 })).status, 400);
  assert.equal((await bad({ businessTypes: [] })).status, 400);
  assert.equal((await bad({ businessTypes: ["LOGIX"] })).status, 400);

  const patched = await admin.api
    .patch(`/api/settings/telegram/destinations/${d._id}`)
    .send({ name: "Logix", enabled: false });
  assert.equal(patched.status, 200);
  assert.deepEqual(
    [
      patched.body.destinations[0].name,
      patched.body.destinations[0].enabled,
      patched.body.destinations[0].messageThreadId,
    ],
    ["Logix", false, 12],
  );
  const cleared = await admin.api
    .patch(`/api/settings/telegram/destinations/${d._id}`)
    .send({ messageThreadId: "" });
  assert.equal(cleared.body.destinations[0].messageThreadId, null);
  await admin.api
    .patch(`/api/settings/telegram/destinations/${d._id}`)
    .send({ messageThreadId: 12 });

  const tested = await admin.api.post(
    `/api/settings/telegram/destinations/${d._id}/test`,
  );
  assert.equal(tested.status, 200);
  const testMessage = sent("sendMessage")[0].body;
  assert.deepEqual(
    [testMessage.chat_id, testMessage.message_thread_id],
    [GROUP_LOGIX, 12],
  );
  assert.equal(tested.body.destinations[0].lastTestOk, true);
  assert.equal(tested.body.destinations[0].chatTitle, "Ops Group");

  handlers.sendMessage = () => {
    throw telegramFailure(400, "Bad Request: chat not found");
  };
  const failed = await admin.api.post(
    `/api/settings/telegram/destinations/${d._id}/test`,
  );
  assert.equal(failed.status, 502);
  assert.match(
    failed.body.error.message,
    /Bot connected successfully, but the test message could not be delivered/,
  );
  assert.match(failed.body.error.message, /Group ID/);
  const after = (await admin.api.get("/api/settings/telegram")).body
    .destinations[0];
  assert.deepEqual(
    [after.lastTestOk, after.lastError.includes("not found")],
    [false, true],
  );

  const removed = await admin.api.delete(
    `/api/settings/telegram/destinations/${d._id}`,
  );
  assert.equal(removed.body.destinations.length, 0);
  assert.equal(
    (await admin.api.delete(`/api/settings/telegram/destinations/${d._id}`))
      .status,
    404,
  );
});

// ------------------------------------------------------------ notifications

test("formatter renders the compact summary, status emoji and copy buttons", () => {
  const order = {
    _id: new mongoose.Types.ObjectId(),
    revision: 3,
    orderNumber: "ORD-2026-000123",
    status: "NEW",
    totalOrderValue: 11400,
    items: [{ quantity: 2 }, { quantity: 1 }],
    customer: { name: "Mo <b>hamed</b> & Co", phoneA: "0550000000" },
    location: { wilayaName: "Alger" },
  };
  const text = formatter.orderSummary(order, { tracking: "ABEX-123456" });
  assert.equal(
    text,
    [
      "<b>🆕 ORDER · #ORD-2026-000123</b>",
      "",
      "<b>🟡 NEW</b>",
      "",
      "📦 Tracking: <code>ABEX-123456</code>",
      "",
      "💰 11,400 DA | 3 Units",
      "",
      "👤 Mo &lt;b&gt;hamed&lt;/b&gt; &amp; Co | Alger",
      "📞 <code>0550000000</code>",
    ].join("\n"),
  );
  assert.match(formatter.orderSummary(order, null), /Tracking: Pending/);
  assert.equal(formatter.STATUS_EMOJI.FAILED_DELIVERY, "⚠️");
  assert.equal(formatter.STATUS_EMOJI.RETURNED, "❌");
  assert.match(
    formatter.orderSummary({ ...order, status: "OUT_FOR_DELIVERY" }),
    /🚛 OUT FOR DELIVERY/,
  );
  const keyboard = formatter.summaryKeyboard(order, {
    tracking: "ABEX-123456",
  });
  assert.deepEqual(
    keyboard[0].map((b) => b.text),
    ["Update Status"],
  ); // CLIENT_URL is not HTTPS in tests
  assert.equal(keyboard[0][0].callback_data, `s:${order._id}:3`);
  assert.deepEqual(keyboard[1], [
    { text: "Copy Tracking", copy_text: { text: "ABEX-123456" } },
    { text: "Copy Phone", copy_text: { text: "0550000000" } },
  ]);
  assert.deepEqual(
    formatter.summaryKeyboard(order, null)[1].map((b) => b.text),
    ["Copy Phone"],
  );
  assert.ok(Buffer.byteLength(formatter.cb.action(order, "GR")) <= 64);
  assert.deepEqual(
    parseCommand("/week-production@LogixOperationsBot", "LogixOperationsBot"),
    { name: "week_production", args: "" },
  );
  assert.equal(parseCommand("/today@SomeOtherBot", "LogixOperationsBot"), null);
});

test("manual order creation queues one job that is released after courier sync and routed by business", async () => {
  await connect();
  await standardDestinations();
  await addDestination({
    name: "All",
    chatId: GROUP_ALL,
    businessTypes: ["LOGIX_ONLY", "TAMQO_ONLY", "PARTNERSHIP"],
  });
  const order = await createViaApi("LOGIX_ONLY", {
    customer: { name: "Mohamed", phoneA: "0550000000", phoneB: "" },
  });
  const job = await NotificationOutbox.findOne({ orderId: order._id }).lean();
  assert.deepEqual(
    [job.eventKey, job.status, job.eventType],
    [`ORDER_CREATED:${order._id}`, "PENDING", "ORDER_CREATED"],
  );
  await runNotificationBatch();
  const messages = sent("sendMessage");
  assert.deepEqual(
    messages.map((m) => m.body.chat_id).sort(),
    [GROUP_ALL, GROUP_LOGIX].sort(),
  );
  const text = messages[0].body.text;
  assert.match(text, new RegExp(`#${order.orderNumber}`));
  assert.match(text, /🟡 NEW/);
  assert.match(text, /Tracking: Pending/);
  assert.match(text, /💰 7,400 DA \| 2 Units/);
  assert.match(text, /👤 Mohamed \| /);
  assert.match(text, /📞 <code>0550000000<\/code>/);
  assert.equal(messages[0].body.parse_mode, "HTML");
  assert.ok(
    !messages[0].body.reply_markup.inline_keyboard
      .flat()
      .some((b) => b.text === "Copy Tracking"),
  );
  const done = await NotificationOutbox.findById(job._id).lean();
  assert.equal(done.status, "SENT");
  assert.ok(
    done.deliveries.every((d) => d.status === "SENT" && d.summaryMessageId),
  );
  // Nothing is sent twice.
  calls = [];
  await runNotificationBatch();
  assert.equal(calls.length, 0);
  await assert.rejects(
    () =>
      transaction((session) =>
        outbox.enqueueOrderCreated(
          { _id: order._id, orderNumber: "x" },
          session,
        ),
      ),
    { code: 11000 },
  );
  assert.equal(
    await NotificationOutbox.countDocuments({ orderId: order._id }),
    1,
  );
});

test("partnership orders reach only destinations that include partnership; tracking comes from Shipment", async () => {
  await connect();
  await standardDestinations();
  const order = await createViaApi("PARTNERSHIP");
  await runNotificationBatch();
  assert.equal(sent("sendMessage").length, 0);
  const job = await NotificationOutbox.findOne({ orderId: order._id }).lean();
  assert.deepEqual(
    [job.status, job.skipReason],
    ["SKIPPED", "NO_MATCHING_DESTINATION"],
  );
  assert.ok(await Order.exists({ _id: order._id }));

  await addDestination({
    name: "Partnership",
    chatId: GROUP_ALL,
    businessTypes: ["PARTNERSHIP"],
  });
  const second = await createViaApi("TAMQO_ONLY");
  await Shipment.create({
    orderId: second._id,
    tracking: "ABEX-778899",
    provider: "MANUAL",
    syncStatus: "SYNCED",
  });
  await runNotificationBatch();
  const message = sent("sendMessage")[0].body;
  assert.deepEqual(
    [message.chat_id, message.message_thread_id],
    [GROUP_TAMQO, 42],
  );
  assert.match(message.text, /<code>ABEX-778899<\/code>/);
  assert.match(message.text, /💰 4,400 DA \| 1 Unit\b/);
  assert.deepEqual(message.reply_markup.inline_keyboard[1][0], {
    text: "Copy Tracking",
    copy_text: { text: "ABEX-778899" },
  });
});

test("outbox rows roll back with the order transaction; imports and disabled integrations never queue", async () => {
  await connect();
  const fake = {
    _id: new mongoose.Types.ObjectId(),
    orderNumber: "ORD-ROLLBACK",
  };
  await assert.rejects(() =>
    transaction(async (session) => {
      await outbox.enqueueOrderCreated(fake, session);
      throw new Error("rollback");
    }),
  );
  assert.equal(
    await NotificationOutbox.countDocuments({ orderId: fake._id }),
    0,
  );
  const silent = await createOrder(orderInput(), {
    userId: admin.user._id,
    name: "admin",
  });
  assert.equal(
    await NotificationOutbox.countDocuments({ orderId: silent._id }),
    0,
  );
  await admin.api.put("/api/settings/telegram").send({ enabled: false });
  const disabled = await createViaApi();
  assert.equal(
    await NotificationOutbox.countDocuments({ orderId: disabled._id }),
    0,
  );
  await admin.api
    .put("/api/settings/telegram")
    .send({ enabled: true, events: { ORDER_CREATED: false } });
  const eventOff = await createViaApi();
  assert.equal(
    await NotificationOutbox.countDocuments({ orderId: eventOff._id }),
    0,
  );
});

test("a Telegram outage never blocks order creation and temporary failures retry", async () => {
  await connect();
  await standardDestinations();
  handlers.sendMessage = () => {
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  };
  const order = await createViaApi();
  assert.ok(await Order.exists({ _id: order._id }));
  await runNotificationBatch();
  let job = await NotificationOutbox.findOne({ orderId: order._id }).lean();
  assert.deepEqual(
    [
      job.status,
      job.attempts,
      job.deliveries[0].status,
      job.deliveries[0].lastErrorCode,
    ],
    ["PENDING", 1, "PENDING", "TELEGRAM_NETWORK"],
  );
  assert.ok(job.nextAttemptAt > new Date());

  handlers.sendMessage = () => {
    throw telegramFailure(429, "Too Many Requests: retry after 30", {
      retry_after: 30,
    });
  };
  await NotificationOutbox.updateOne(
    { _id: job._id },
    { nextAttemptAt: new Date() },
  );
  await runNotificationBatch();
  job = await NotificationOutbox.findById(job._id).lean();
  assert.equal(job.status, "PENDING");
  assert.ok(job.nextAttemptAt - Date.now() >= 28000, "respects retry_after");

  handlers = {};
  calls = [];
  await NotificationOutbox.updateOne(
    { _id: job._id },
    { nextAttemptAt: new Date() },
  );
  await runNotificationBatch();
  job = await NotificationOutbox.findById(job._id).lean();
  assert.deepEqual([job.status, job.attempts], ["SENT", 3]);
  assert.equal(sent("sendMessage").length, 1);
});

test("permanent destination errors fail without retry, are surfaced and can be retried manually", async () => {
  await connect();
  await standardDestinations();
  handlers.sendMessage = () => {
    throw telegramFailure(
      403,
      "Forbidden: bot was kicked from the supergroup chat",
    );
  };
  const order = await createViaApi();
  await runNotificationBatch();
  const job = await NotificationOutbox.findOne({ orderId: order._id }).lean();
  assert.deepEqual(
    [job.status, job.deliveries[0].status, job.deliveries[0].lastErrorCode],
    ["FAILED", "FAILED", "BOT_REMOVED"],
  );
  const view = (await admin.api.get("/api/settings/telegram")).body;
  assert.match(view.lastNotificationError.message, /not a member/);
  assert.equal(view.lastNotificationError.orderNumber, order.orderNumber);
  assert.equal(view.recentFailures[0].orderNumber, order.orderNumber);
  calls = [];
  await runNotificationBatch();
  assert.equal(
    sent("sendMessage").length,
    0,
    "permanent failures are not retried automatically",
  );

  handlers = {};
  const retried = await admin.api.post(
    `/api/settings/telegram/notifications/${job._id}/retry`,
  );
  assert.equal(retried.status, 200);
  await runNotificationBatch();
  assert.equal(
    (await NotificationOutbox.findById(job._id).lean()).status,
    "SENT",
  );
  assert.equal(
    (
      await viewer.api.post(
        `/api/settings/telegram/notifications/${job._id}/retry`,
      )
    ).status,
    403,
  );
});

async function localImage() {
  const saved = await mediaStorage.put({
    buffer: png,
    mimetype: "image/png",
    size: png.length,
  });
  return {
    key: saved.key,
    mime: saved.mime,
    size: saved.size,
    width: saved.width,
    height: saved.height,
  };
}

test("images are uploaded as Telegram media before the summary", async () => {
  await connect();
  await standardDestinations();
  const single = await createViaApi("LOGIX_ONLY", {
    notificationImageCount: 1,
  });
  let job = await NotificationOutbox.findOne({ orderId: single._id }).lean();
  assert.equal(job.status, "WAITING", "waits for the post-creation upload");
  await Order.updateOne(
    { _id: single._id },
    { $push: { images: await localImage() } },
  );
  await outbox.orderImagesChanged(single._id);
  assert.equal(
    (await NotificationOutbox.findById(job._id).lean()).status,
    "PENDING",
  );
  calls = [];
  await runNotificationBatch();
  assert.deepEqual(
    calls.map((c) => c.name),
    ["sendPhoto", "sendMessage"],
  );
  const photo = calls[0].body;
  assert.equal(formValue(photo, "chat_id"), GROUP_LOGIX);
  const file = formValue(photo, "photo");
  assert.equal(file.type, "image/jpeg");
  assert.ok(file.size > 0);
  job = await NotificationOutbox.findById(job._id).lean();
  assert.equal(job.deliveries[0].photoMessageIds.length, 1);

  calls = [];
  const album = await createViaApi("TAMQO_ONLY");
  await Order.updateOne(
    { _id: album._id },
    {
      $set: {
        images: [
          await localImage(),
          await localImage(),
          { key: "00000000-0000-0000-0000-000000000000.webp" },
        ],
      },
    },
  );
  await runNotificationBatch();
  assert.deepEqual(
    calls.map((c) => c.name),
    ["sendMediaGroup", "sendMessage"],
  );
  assert.equal(formValue(calls[0].body, "message_thread_id"), "42");
  assert.equal(
    JSON.parse(formValue(calls[0].body, "media")).length,
    2,
    "missing files are skipped",
  );

  calls = [];
  const broken = await createViaApi();
  await Order.updateOne(
    { _id: broken._id },
    {
      $set: { images: [{ key: "11111111-1111-1111-1111-111111111111.webp" }] },
    },
  );
  await runNotificationBatch();
  assert.deepEqual(
    calls.map((c) => c.name),
    ["sendMessage"],
    "inaccessible images never lose the notification",
  );

  // A photo-only rejection does not block the summary.
  calls = [];
  handlers.sendPhoto = () => {
    throw telegramFailure(400, "Bad Request: IMAGE_PROCESS_FAILED");
  };
  const rejected = await createViaApi();
  await Order.updateOne(
    { _id: rejected._id },
    { $set: { images: [await localImage()] } },
  );
  await runNotificationBatch();
  assert.deepEqual(
    calls.map((c) => c.name),
    ["sendPhoto", "sendMessage"],
  );
  assert.equal(
    (await NotificationOutbox.findOne({ orderId: rejected._id }).lean()).status,
    "SENT",
  );
});

test("authenticated Cloudinary uploads release the job and are sent as bytes, never URLs", async (t) => {
  fakeCloudinary(t.mock);
  await connect();
  await standardDestinations();
  const order = await createViaApi("LOGIX_ONLY", { notificationImageCount: 2 });
  const job = await NotificationOutbox.findOne({ orderId: order._id }).lean();
  let revision = order.revision;
  for (const [index, name] of ["a.png", "b.png"].entries()) {
    const upload = await admin.api
      .post(`/api/order-media/${order._id}`)
      .field("expectedRevision", String(revision))
      .attach("image", png, { filename: name, contentType: "image/png" });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    revision = upload.body.revision;
    assert.equal(
      (await NotificationOutbox.findById(job._id).lean()).status,
      index === 0 ? "WAITING" : "PENDING",
    );
  }
  calls = [];
  await runNotificationBatch();
  assert.deepEqual(
    calls.map((c) => c.name),
    ["sendMediaGroup", "sendMessage"],
  );
  assert.equal(JSON.parse(formValue(calls[0].body, "media")).length, 2);
  assert.equal(formValue(calls[0].body, "photo0").type, "image/jpeg");
  const everything = calls
    .map((c) =>
      typeof c.body?.get === "function"
        ? formValue(c.body, "media")
        : JSON.stringify(c.body),
    )
    .join(" ");
  assert.ok(
    !/cloudinary|s--|authenticated/.test(everything),
    "private media URLs never reach Telegram",
  );
});

test("stale WAITING jobs are recovered", async () => {
  await connect();
  await standardDestinations();
  const order = await createOrder(
    orderInput(),
    { userId: admin.user._id, name: "admin" },
    { notify: true, expectedImages: 3 },
  );
  assert.equal(
    (await NotificationOutbox.findOne({ orderId: order._id }).lean()).status,
    "WAITING",
  );
  await runNotificationBatch();
  assert.equal(sent("sendMessage").length, 0);
  await runNotificationBatch({
    now: new Date(Date.now() + outbox.CRASH_RECOVERY_MS + 1000),
  });
  assert.equal(sent("sendMessage").length, 1);
  assert.equal(
    (await NotificationOutbox.findOne({ orderId: order._id }).lean()).status,
    "SENT",
  );
});

// --------------------------------------------------------------- webhook

test("webhook verifies the secret and deduplicates updates", async () => {
  await connect();
  const message = {
    message: {
      message_id: 1,
      chat: groupChat,
      from: { id: 1 },
      text: "/chatid",
    },
  };
  assert.equal((await webhook(message, "wrong-secret")).status, 401);
  assert.equal(
    (
      await supertest(app)
        .post("/api/webhooks/telegram")
        .send({ update_id: 99, ...message })
    ).status,
    401,
  );
  assert.equal(await TelegramUpdate.countDocuments(), 0);
  const body = { update_id: 500, ...message };
  const first = await supertest(app)
    .post("/api/webhooks/telegram")
    .set("X-Telegram-Bot-Api-Secret-Token", webhookSecret)
    .send(body);
  const again = await supertest(app)
    .post("/api/webhooks/telegram")
    .set("X-Telegram-Bot-Api-Secret-Token", webhookSecret)
    .send(body);
  assert.deepEqual(
    [first.status, again.status, again.body.duplicate],
    [200, 200, true],
  );
  assert.equal(await TelegramUpdate.countDocuments(), 1);
  await runUpdateBatch();
  await runUpdateBatch();
  assert.equal(sent("sendMessage").length, 1);
  const processed = await TelegramUpdate.findOne({ updateId: 500 }).lean();
  assert.deepEqual([processed.status, processed.payload], ["DONE", undefined]);
});

test("/chatid works for anyone, before any destination exists", async () => {
  await connect();
  const topic = await command("/chatid", { thread: 123 });
  assert.match(topic.text, /Group: LOGIX Operations/);
  assert.match(topic.text, /<code>-1001234567890<\/code>/);
  assert.match(topic.text, /Topic ID:\n<code>123<\/code>/);
  assert.equal(topic.message_thread_id, 123);
  const plain = await command("/chatid@LogixOperationsBot");
  assert.match(plain.text, /Topic ID:\nNot applicable/);
  assert.equal(plain.message_thread_id, undefined);
});

test("account linking codes are hashed, single-use, expiring and private-chat only", async () => {
  await connect();
  assert.match(
    await command("/today").then((r) => r.text),
    /Link your CRM account first/,
  );
  const issued = (await confirmer.api.post("/api/settings/telegram/link-code"))
    .body;
  assert.match(issued.code, /^[A-Z0-9]{8}$/);
  assert.equal(
    issued.deepLink,
    `https://t.me/LogixOperationsBot?start=link_${issued.code}`,
  );
  const row = await TelegramLinkCode.findOne({
    userId: confirmer.user._id,
  }).lean();
  assert.ok(
    row.codeHash &&
      row.codeHash !== issued.code &&
      !JSON.stringify(row).includes(issued.code),
  );

  // Posted in a group: refused and burned.
  assert.match((await command(`/link ${issued.code}`)).text, /private chat/);
  const priv = (id) => ({
    from: { id, username: "conf" },
    chat: { id, type: "private" },
  });
  assert.match(
    (await command(`/link ${issued.code}`, priv(7001))).text,
    /invalid, expired or already used/,
  );

  const code = (await confirmer.api.post("/api/settings/telegram/link-code"))
    .body.code;
  assert.match(
    (await command(`/start link_${code}`, priv(7001))).text,
    /Linked to CRM user <b>confirmer<\/b>/,
  );
  const linked = await User.findById(confirmer.user._id).lean();
  assert.deepEqual(
    [linked.telegramUserId, linked.telegramUsername],
    ["7001", "conf"],
  );
  assert.match(
    (await command(`/link ${code}`, priv(7002))).text,
    /invalid, expired or already used/,
  );
  const me = (await confirmer.api.get("/api/settings/telegram/link")).body;
  assert.deepEqual([me.linked, me.telegramUsername], [true, "conf"]);

  // One Telegram account cannot belong to two CRM users.
  const other = (await limited.api.post("/api/settings/telegram/link-code"))
    .body.code;
  assert.match(
    (await command(`/link ${other}`, priv(7001))).text,
    /already linked to a different CRM user/,
  );

  // Expired codes are rejected.
  const late = (await limited.api.post("/api/settings/telegram/link-code")).body
    .code;
  await TelegramLinkCode.updateMany(
    { userId: limited.user._id },
    { expiresAt: new Date(Date.now() - 1000) },
  );
  assert.match(
    (await command(`/link ${late}`, priv(7003))).text,
    /invalid, expired/,
  );

  assert.equal(
    (await confirmer.api.delete("/api/settings/telegram/link")).status,
    200,
  );
  assert.equal(
    (await User.findById(confirmer.user._id).lean()).telegramUserId,
    undefined,
  );
  assert.match(
    (await command("/today", priv(7001))).text,
    /Link your CRM account first/,
  );
});

async function stagedOrder(
  stage,
  { createdDaysAgo = 0, stageDaysAgo = 0, name = "Ahmed" } = {},
) {
  const order = await createOrder(
    orderInput("LOGIX_ONLY", {
      customer: { name, phoneA: "0550000000", phoneB: "" },
    }),
    { userId: admin.user._id, name: "admin" },
  );
  await Order.collection.updateOne(
    { _id: order._id },
    {
      $set: {
        createdAt: new Date(Date.now() - createdDaysAgo * 86400000 - 60000),
        "tracking.stage": stage,
        "tracking.stageEnteredAt": new Date(
          Date.now() - stageDaysAgo * 86400000 - 60000,
        ),
      },
    },
  );
  return order;
}

test("production commands respect tracking stages, the rolling window and ordering", async () => {
  await connect();
  await link(confirmer, 7001);
  const a = await stagedOrder("AT_PRODUCTION", {
    createdDaysAgo: 3,
    stageDaysAgo: 2,
    name: "Ahmed",
  });
  const b = await stagedOrder("AT_PRODUCTION", {
    createdDaysAgo: 4,
    stageDaysAgo: 3,
    name: "Mohamed",
  });
  const old = await stagedOrder("AT_PRODUCTION", {
    createdDaysAgo: 9,
    stageDaysAgo: 8,
    name: "Old",
  });
  const preparing = await stagedOrder("PREPARING", { name: "Prep" });
  const ready = await stagedOrder("READY_TO_SHIP", { name: "Ready" });
  const as = { from: { id: 7001 } };

  const week = (await command("/week-production", as)).text;
  assert.match(week, /🏭 PRODUCTION · LAST 7 DAYS/);
  assert.match(week, /Total: 2 Orders/);
  assert.ok(
    week.indexOf(b.orderNumber) < week.indexOf(a.orderNumber),
    "longest in stage first",
  );
  assert.match(week, /At Production · 3 days/);
  assert.ok(!week.includes(old.orderNumber));
  const all = (await command("/production", as)).text;
  assert.match(all, /Total: 3 Orders/);
  assert.ok(all.indexOf(old.orderNumber) < all.indexOf(b.orderNumber));
  assert.match(
    (await command("/preparing", as)).text,
    new RegExp(preparing.orderNumber),
  );
  const readyText = (await command("/ready_to_ship", as)).text;
  assert.match(readyText, new RegExp(ready.orderNumber));
  assert.match(readyText, /Total: 1 Order\b/);
});

test("/today, /order, /shipment-issues, /week-summary and pagination", async () => {
  await connect();
  await link(confirmer, 7001);
  const as = { from: { id: 7001 } };
  const orders = [];
  for (let i = 0; i < 12; i++)
    orders.push(
      await createOrder(orderInput(), {
        userId: admin.user._id,
        name: "admin",
      }),
    );
  const yesterday = orders[0];
  await Order.collection.updateOne(
    { _id: yesterday._id },
    { $set: { createdAt: new Date(Date.now() - 3 * 86400000) } },
  );

  const today = await command("/today", as);
  assert.match(today.text, /Total: 11 Orders/);
  assert.ok(!today.text.includes(yesterday.orderNumber));
  const pending = await command("/pending-confirmation", as);
  assert.match(pending.text, /Total: 12 Orders/);
  const nav = pending.reply_markup.inline_keyboard.at(-1);
  assert.deepEqual(
    nav.map((b) => b.text),
    ["1/2", "Next ▶"],
  );
  assert.equal(nav[1].callback_data, "p:pc:2");
  assert.equal((pending.text.match(/#ORD-/g) || []).length, 10);
  const page = await press("p:pc:2", as);
  assert.equal(
    page.edit.message_id,
    777,
    "pagination edits the existing message",
  );
  assert.equal((page.edit.text.match(/#ORD-/g) || []).length, 2);
  assert.deepEqual(
    page.edit.reply_markup.inline_keyboard.at(-1).map((b) => b.text),
    ["◀ Prev", "2/2"],
  );
  assert.equal(sent("sendMessage").length, 0);

  const byNumber = await command(
    `/order ${orders[3].orderNumber.toLowerCase()}`,
    as,
  );
  assert.match(
    byNumber.text,
    new RegExp(`📦 ORDER · #${orders[3].orderNumber}`),
  );
  assert.equal(
    byNumber.reply_markup.inline_keyboard[0].at(-1).callback_data,
    `s:${orders[3]._id}:${orders[3].revision}`,
  );
  await Shipment.create({
    orderId: orders[4]._id,
    tracking: "ABEX-555",
    provider: "MANUAL",
    syncStatus: "ERROR",
    lastError: "Commune not served",
  });
  const byTracking = await command("/order abex-555", as);
  assert.match(byTracking.text, new RegExp(orders[4].orderNumber));
  assert.match(byTracking.text, /<code>ABEX-555<\/code>/);
  assert.match(
    (await command("/order NOPE-1", as)).text,
    /No accessible order/,
  );

  const issues = (await command("/shipment-issues", as)).text;
  assert.match(issues, /Total: 1 Order\b/);
  assert.match(issues, /Commune not served/);
  assert.match(issues, /not delivery failures/);
  await Order.updateOne({ _id: orders[5]._id }, { status: "FAILED_DELIVERY" });
  assert.match(
    (await command("/failed-delivery", as)).text,
    new RegExp(orders[5].orderNumber),
  );

  const summary = (await command("/week-summary", as)).text;
  assert.match(summary, /Total: 12 Orders/);
  assert.match(summary, /🟡 New: 11/);
  assert.match(summary, /⚠️ Failed Delivery: 1/);
  assert.match(summary, /Logix Only: 12/);
  assert.match(summary, /not realized revenue/);
  assert.match((await command("/recent", as)).text, /Total: 10 Orders/);
});

test("commands enforce CRM permissions and business scope", async () => {
  await connect();
  await link(limited, 7100);
  await link(confirmer, 7001);
  const partnership = await createOrder(orderInput("PARTNERSHIP"), {
    userId: admin.user._id,
    name: "admin",
  });
  assert.match(
    (await command(`/order ${partnership.orderNumber}`, { from: { id: 7100 } }))
      .text,
    /No accessible order/,
  );
  assert.match(
    (await command(`/order ${partnership.orderNumber}`, { from: { id: 7001 } }))
      .text,
    new RegExp(partnership.orderNumber),
  );
  assert.match(
    (await command("/bot-status", { from: { id: 7001 } })).text,
    /Only administrators/,
  );
  await link(admin, 9000);
  const status = (await command("/bot_status", { from: { id: 9000 } })).text;
  assert.match(status, /Webhook: Configured/);
  await User.updateOne({ _id: confirmer.user._id }, { status: "DISABLED" });
  try {
    assert.match(
      (await command("/today", { from: { id: 7001 } })).text,
      /Link your CRM account first/,
    );
  } finally {
    await User.updateOne({ _id: confirmer.user._id }, { status: "ACTIVE" });
  }
});

// -------------------------------------------------------------- callbacks

test("status buttons authorize the linked employee and use existing business logic", async () => {
  await connect();
  await standardDestinations();
  await link(confirmer, 7001);
  await link(limited, 7100);
  const created = await createViaApi();
  await runNotificationBatch();
  const summaryId = (
    await NotificationOutbox.findOne({ orderId: created._id }).lean()
  ).deliveries[0].summaryMessageId;
  const order = await Order.findById(created._id).lean();
  const chat = { id: Number(GROUP_LOGIX), type: "supergroup" };

  const stranger = await press(`s:${order._id}:${order.revision}`, {
    from: { id: 4242 },
    chat,
    message_id: summaryId,
  });
  assert.equal(stranger.answer.show_alert, true);
  assert.match(stranger.answer.text, /Link your Telegram/);

  const noRights = await press(`s:${order._id}:${order.revision}`, {
    from: { id: 7100 },
    chat,
    message_id: summaryId,
  });
  assert.match(noRights.edit.text, /No status changes are available/);
  assert.deepEqual(
    noRights.edit.reply_markup.inline_keyboard.flat().map((b) => b.text),
    ["« Back"],
  );
  const forged = await press(`t:${order._id}:${order.revision}:C`, {
    from: { id: 7100 },
    chat,
    message_id: summaryId,
  });
  assert.match(forged.answer.text, /not available for you/);
  assert.equal((await Order.findById(order._id).lean()).status, "NEW");

  const menu = await press(`s:${order._id}:${order.revision}`, {
    from: { id: 7001 },
    chat,
    message_id: summaryId,
  });
  const buttons = menu.edit.reply_markup.inline_keyboard.flat();
  assert.deepEqual(
    buttons.map((b) => b.text),
    ["🔵 Confirm order", "🔴 Cancel order…", "« Back"],
  );
  const invalid = await press(`t:${order._id}:${order.revision}:P`, {
    from: { id: 7001 },
    chat,
    message_id: summaryId,
  });
  assert.match(invalid.answer.text, /not available/);

  const confirmed = await press(buttons[0].callback_data, {
    from: { id: 7001 },
    chat,
    message_id: summaryId,
  });
  assert.match(confirmed.answer.text, /Confirmed — saved by confirmer/);
  assert.match(confirmed.edit.text, /🔵 CONFIRMED/);
  assert.equal(confirmed.edit.message_id, summaryId);
  assert.equal(
    confirmed.edit.reply_markup.inline_keyboard[0].at(-1).text,
    "Update Status",
  );
  const current = await Order.findById(order._id).lean();
  assert.deepEqual(
    [current.status, String(current.lastUpdatedBy.userId)],
    ["CONFIRMED", String(confirmer.user._id)],
  );
  assert.ok(
    await OrderEvent.exists({
      orderId: order._id,
      type: "ORDER_CONFIRMED",
      "actor.userId": confirmer.user._id,
    }),
  );
  assert.ok(
    await AuditLog.exists({
      action: "ORDER_CONFIRMED",
      actorId: confirmer.user._id,
      resourceId: String(order._id),
    }),
  );
  assert.ok(
    await AuditLog.exists({
      action: "TELEGRAM_ORDER_ACTION",
      actorId: confirmer.user._id,
    }),
  );
  assert.equal(
    await NotificationOutbox.countDocuments({ orderId: order._id }),
    1,
    "no new ORDER_CREATED notification",
  );

  // The old button carries an outdated revision.
  const stale = await press(buttons[1].callback_data, {
    from: { id: 7001 },
    chat,
    message_id: summaryId,
  });
  assert.match(stale.answer.text, /changed since this message was sent/);
  assert.equal((await Order.findById(order._id).lean()).status, "CONFIRMED");

  const ask = await press(`t:${order._id}:${current.revision}:X`, {
    from: { id: 7001 },
    chat,
    message_id: summaryId,
  });
  assert.match(ask.edit.text, /Cancel this order\?/);
  const yes = ask.edit.reply_markup.inline_keyboard[0][0].callback_data;
  const cancelled = await press(yes, {
    from: { id: 7001 },
    chat,
    message_id: summaryId,
  });
  assert.match(cancelled.edit.text, /🔴 CANCELLED/);
  assert.equal((await Order.findById(order._id).lean()).status, "CANCELLED");
});

test("cancellation is hidden once a courier parcel exists; production stages use tracking rules", async () => {
  await connect();
  await link(admin, 9000);
  await link(confirmer, 7001);
  const order = await createOrder(orderInput(), {
    userId: admin.user._id,
    name: "admin",
  });
  await Shipment.create({
    orderId: order._id,
    tracking: "ABEX-1",
    provider: "MANUAL",
    creationAttemptedAt: new Date(),
  });
  const chat = { id: Number(GROUP_LOGIX), type: "supergroup" };
  const menu = await press(`s:${order._id}:${order.revision}`, {
    from: { id: 7001 },
    chat,
  });
  assert.deepEqual(
    menu.edit.reply_markup.inline_keyboard.flat().map((b) => b.text),
    ["🔵 Confirm order", "« Back"],
  );
  const forced = await press(`t:${order._id}:${order.revision}:Y`, {
    from: { id: 7001 },
    chat,
  });
  assert.match(forced.answer.text, /not available/);

  const adminMenu = await press(`s:${order._id}:${order.revision}`, {
    from: { id: 9000 },
    chat,
  });
  const stage = adminMenu.edit.reply_markup.inline_keyboard
    .flat()
    .find((b) => b.text === "🏭 Move to Production");
  assert.ok(stage, "elevated users see the production stage transition");
  const moved = await press(stage.callback_data, { from: { id: 9000 }, chat });
  assert.match(moved.answer.text, /Move to Production/);
  const after = await Order.findById(order._id).lean();
  assert.deepEqual(
    [after.status, after.tracking.stage],
    ["NEW", "AT_PRODUCTION"],
  );
});
