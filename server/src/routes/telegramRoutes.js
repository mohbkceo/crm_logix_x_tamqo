import { Router } from "express";
import { z } from "zod";
import { P, requirePermission } from "../authorization.js";
import { assert, AppError } from "../errors.js";
import { audit, User } from "../models/security.js";
import { TelegramSetting } from "../models/telegram.js";
import { BUSINESS_TYPES } from "../constants.js";
import { objectId } from "../services/filters.js";
import {
  loadSetting,
  connectBot,
  clientFor,
  configureWebhook,
  presentSetting,
  publicError,
} from "../services/notifications/telegram/telegramSettings.js";
import {
  createLinkCode,
  unlinkTelegram,
} from "../services/notifications/telegram/telegramLinking.js";
import { retryJob } from "../services/notifications/notificationOutboxService.js";
import { escapeHtml } from "../services/notifications/telegram/telegramOrderFormatter.js";

const router = Router();
const manage = requirePermission(P.settings.manage);

// Supergroups/channels are -100…; basic groups are negative; private chats
// positive. Kept as strings: these exceed Number precision in some cases.
const chatId = z
  .string()
  .trim()
  .regex(
    /^-?\d{5,20}$/,
    "Enter the numeric Group ID returned by /chatid (for example -1001234567890).",
  );
const threadId = z
  .union([
    z.literal(""),
    z.null(),
    z.coerce.number().int().min(1).max(2147483647),
  ])
  .optional()
  .transform((v) => (v === "" || v == null ? null : v));
const destinationFields = {
  name: z.string().trim().min(1).max(100),
  chatId,
  messageThreadId: threadId,
  businessTypes: z
    .array(z.enum(BUSINESS_TYPES))
    .min(1, "Choose at least one business.")
    .max(3)
    .transform((v) => [...new Set(v)]),
  enabled: z.boolean(),
};
const destinationInput = z
  .object({
    ...destinationFields,
    enabled: destinationFields.enabled.optional().default(true),
  })
  .strict();
const destinationPatch = z
  .object({
    name: destinationFields.name.optional(),
    chatId: chatId.optional(),
    messageThreadId: threadId,
    businessTypes: destinationFields.businessTypes.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const settingsInput = z
  .object({
    token: z.string().trim().max(200).optional().default(""),
    enabled: z.boolean().optional(),
    events: z.object({ ORDER_CREATED: z.boolean() }).strict().optional(),
  })
  .strict();

async function respond(res, setting) {
  res.json(await presentSetting(setting));
}
const auditMeta = (setting) => ({
  enabled: setting.enabled,
  botUsername: setting.botUsername,
  destinations: setting.destinations.length,
});

// Per-user linking: any signed-in employee manages only their own link.
router.get("/link", async (req, res) => {
  const [user, setting] = await Promise.all([
    User.findById(req.user._id)
      .select("telegramUserId telegramUsername telegramLinkedAt")
      .lean(),
    TelegramSetting.findById("telegram").select("botUsername enabled").lean(),
  ]);
  res.json({
    linked: Boolean(user?.telegramUserId),
    telegramUsername: user?.telegramUsername || "",
    linkedAt: user?.telegramLinkedAt || null,
    botUsername: setting?.botUsername || "",
    available: Boolean(setting?.enabled && setting?.botUsername),
  });
});
router.post("/link-code", async (req, res) => {
  const setting = await TelegramSetting.findById("telegram")
    .select("botUsername enabled")
    .lean();
  assert(
    setting?.enabled && setting.botUsername,
    "The Telegram bot is not connected yet. Ask an administrator.",
    409,
    "TELEGRAM_NOT_CONNECTED",
  );
  const { code, expiresAt } = await createLinkCode(req.user);
  await audit(
    req.actor,
    "TELEGRAM_LINK_CODE_CREATED",
    "User",
    req.user._id,
    undefined,
    {},
  );
  res.status(201).json({
    code,
    expiresAt,
    botUsername: setting.botUsername,
    deepLink: `https://t.me/${setting.botUsername}?start=link_${code}`,
  });
});
router.delete("/link", async (req, res) => {
  await unlinkTelegram(req.user, req.actor);
  res.json({ linked: false });
});

router.get("/", requirePermission(P.settings.view), async (_req, res) =>
  respond(res, await loadSetting()),
);

router.put("/", manage, async (req, res) => {
  const input = settingsInput.parse(req.body);
  const setting = await loadSetting({ withSecrets: true });
  const replacing = Boolean(input.token);
  // An empty token field preserves the stored token.
  if (replacing) await connectBot(setting, input.token);
  assert(
    !input.enabled || setting.encryptedToken,
    "Connect a bot token before enabling Telegram.",
    409,
    "TELEGRAM_NOT_CONNECTED",
  );
  if (input.enabled !== undefined) setting.enabled = input.enabled;
  else if (replacing) setting.enabled = true;
  if (input.events) setting.events = input.events;
  setting.updatedBy = req.actor;
  await setting.save();
  await audit(
    req.actor,
    replacing ? "TELEGRAM_BOT_CONNECTED" : "TELEGRAM_SETTINGS_UPDATED",
    "TelegramSetting",
    "telegram",
    undefined,
    auditMeta(setting),
  );
  await respond(res, setting);
});

router.post("/test-connection", manage, async (req, res) => {
  const setting = await loadSetting({ withSecrets: true });
  const client = clientFor(setting);
  assert(client, "Connect a bot token first.", 409, "TELEGRAM_NOT_CONNECTED");
  setting.lastConnectionTestAt = new Date();
  try {
    const me = await client.getMe();
    setting.botUsername = me.username || setting.botUsername;
    setting.botName = me.first_name || setting.botName;
    setting.lastConnectionTestOk = true;
    const info = await client.getWebhookInfo().catch(() => null);
    // Repair a missing or moved webhook automatically.
    if (
      !info ||
      info.url !== setting.webhookUrl ||
      !setting.webhookConfiguredAt ||
      !setting.webhookSecretHash
    )
      await configureWebhook(setting, client);
    else if (info.last_error_message)
      setting.webhookError = `Telegram reported: ${String(info.last_error_message).slice(0, 200)}`;
    else setting.webhookError = undefined;
  } catch (error) {
    setting.lastConnectionTestOk = false;
    await setting.save();
    throw new AppError(
      publicError(error, "Telegram could not be reached."),
      502,
      "TELEGRAM_CONNECTION_FAILED",
    );
  }
  await setting.save();
  await audit(
    req.actor,
    "TELEGRAM_CONNECTION_TESTED",
    "TelegramSetting",
    "telegram",
    undefined,
    { ok: true },
  );
  await respond(res, setting);
});

router.post("/disconnect", manage, async (req, res) => {
  const setting = await loadSetting({ withSecrets: true });
  const client = clientFor(setting);
  if (client) await client.deleteWebhook().catch(() => {});
  setting.encryptedToken = undefined;
  setting.webhookSecretHash = undefined;
  for (const key of [
    "botId",
    "botUsername",
    "botName",
    "connectedAt",
    "webhookConfiguredAt",
    "webhookError",
    "lastConnectionTestAt",
    "lastConnectionTestOk",
  ])
    setting[key] = undefined;
  setting.enabled = false;
  setting.updatedBy = req.actor;
  await setting.save();
  await audit(
    req.actor,
    "TELEGRAM_BOT_DISCONNECTED",
    "TelegramSetting",
    "telegram",
    undefined,
    {},
  );
  await respond(res, setting);
});

router.post("/destinations", manage, async (req, res) => {
  const input = destinationInput.parse(req.body);
  const setting = await loadSetting();
  assert(
    setting.destinations.length < 50,
    "Up to 50 destinations are supported.",
  );
  setting.destinations.push(input);
  setting.updatedBy = req.actor;
  await setting.save();
  await audit(
    req.actor,
    "TELEGRAM_DESTINATION_ADDED",
    "TelegramSetting",
    "telegram",
    undefined,
    { name: input.name, businessTypes: input.businessTypes },
  );
  await respond(res, setting);
});

function destination(setting, id) {
  const d = setting.destinations.id(objectId(id));
  assert(d, "Destination not found", 404);
  return d;
}
router.patch("/destinations/:id", manage, async (req, res) => {
  const { messageThreadId, ...input } = destinationPatch.parse(req.body);
  const setting = await loadSetting();
  const d = destination(setting, req.params.id);
  if (input.chatId !== undefined && input.chatId !== d.chatId)
    d.chatTitle = undefined;
  Object.assign(
    d,
    Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined),
    ),
  );
  // Only an explicit field changes the topic; "" or null clears it.
  if (Object.hasOwn(req.body, "messageThreadId"))
    d.messageThreadId = messageThreadId ?? null;
  setting.updatedBy = req.actor;
  await setting.save();
  await audit(
    req.actor,
    "TELEGRAM_DESTINATION_UPDATED",
    "TelegramSetting",
    "telegram",
    undefined,
    { name: d.name, businessTypes: d.businessTypes, enabled: d.enabled },
  );
  await respond(res, setting);
});
router.delete("/destinations/:id", manage, async (req, res) => {
  const setting = await loadSetting();
  const d = destination(setting, req.params.id);
  const name = d.name;
  d.deleteOne();
  setting.updatedBy = req.actor;
  await setting.save();
  await audit(
    req.actor,
    "TELEGRAM_DESTINATION_DELETED",
    "TelegramSetting",
    "telegram",
    undefined,
    { name },
  );
  await respond(res, setting);
});

// Sending a real message is the only proof the bot can post in a group/topic.
router.post("/destinations/:id/test", manage, async (req, res) => {
  const setting = await loadSetting({ withSecrets: true });
  const d = destination(setting, req.params.id);
  const client = clientFor(setting);
  assert(client, "Connect a bot token first.", 409, "TELEGRAM_NOT_CONNECTED");
  d.lastTestAt = new Date();
  try {
    const chat = await client.getChat(d.chatId).catch(() => null);
    if (chat?.title) d.chatTitle = String(chat.title).slice(0, 255);
    await client.sendMessage({
      chatId: d.chatId,
      threadId: d.messageThreadId || undefined,
      text: `✅ <b>Test message</b>\nThis chat will receive CRM notifications for destination “${escapeHtml(d.name)}”.`,
    });
    d.lastTestOk = true;
    d.lastError = undefined;
    await setting.save();
    await audit(
      req.actor,
      "TELEGRAM_DESTINATION_TESTED",
      "TelegramSetting",
      "telegram",
      undefined,
      { name: d.name, ok: true },
    );
    await respond(res, setting);
  } catch (error) {
    d.lastTestOk = false;
    d.lastError = publicError(
      error,
      "The test message could not be delivered.",
    );
    await setting.save();
    throw new AppError(
      "Bot connected successfully, but the test message could not be delivered to this Telegram group. " +
        `${d.lastError} Check that the bot is a member of the group, can send messages, and that the Group ID and Topic ID are correct.`,
      502,
      "TELEGRAM_DESTINATION_FAILED",
    );
  }
});

router.post("/notifications/:id/retry", manage, async (req, res) => {
  const job = await retryJob(objectId(req.params.id));
  assert(job, "Only failed or skipped notifications can be retried.", 409);
  await audit(
    req.actor,
    "TELEGRAM_NOTIFICATION_RETRIED",
    "NotificationOutbox",
    job._id,
    undefined,
    { orderNumber: job.orderNumber },
  );
  await respond(res, await loadSetting());
});

export const telegramRoutes = router;
