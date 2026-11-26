import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../../../config.js";
import {
  TelegramSetting,
  NotificationOutbox,
} from "../../../models/telegram.js";
import {
  encryptCredentials,
  decryptCredentials,
} from "../../delivery/credentials.js";
import { AppError } from "../../../errors.js";
import {
  telegramClient,
  TelegramError,
  TOKEN_PATTERN,
} from "./telegramClient.js";

export const SETTING_ID = "telegram";
export const WEBHOOK_PATH = "/api/webhooks/telegram";
const sha256 = (value) => createHash("sha256").update(String(value)).digest();

// Telegram command names may only contain a-z, 0-9 and "_". Hyphenated forms
// such as /week-production are accepted when typed, and normalized.
export const BOT_COMMANDS = [
  ["start", "Show basic instructions"],
  ["help", "List available commands"],
  ["chatid", "Show this chat's Group ID and Topic ID"],
  ["link", "Link your CRM account: /link CODE"],
  ["today", "Orders created today"],
  ["recent", "Latest 10 orders"],
  ["pending_confirmation", "Orders waiting for confirmation"],
  ["order", "Find an order: /order ORD-2026-000123 or tracking"],
  ["production", "Orders currently at production"],
  ["week_production", "Last 7 days, currently at production"],
  ["preparing", "Orders in the Preparing stage"],
  ["ready_to_ship", "Orders in the Ready to Ship stage"],
  ["shipped", "Orders with status Shipped"],
  ["failed_delivery", "Orders with status Failed Delivery"],
  ["shipment_issues", "Shipments with courier sync errors"],
  ["week_summary", "Summary of the last 7 days"],
  ["bot_status", "Integration health (administrators)"],
].map(([command, description]) => ({ command, description }));

export async function loadSetting({ withSecrets = false } = {}) {
  const query = TelegramSetting.findById(SETTING_ID);
  if (withSecrets) query.select("+encryptedToken +webhookSecretHash");
  return (await query) || new TelegramSetting({ _id: SETTING_ID });
}

export function webhookBaseUrl() {
  return String(
    process.env.TELEGRAM_WEBHOOK_BASE_URL || config.clientUrl || "",
  ).replace(/\/+$/, "");
}
export const webhookUrl = () => webhookBaseUrl() + WEBHOOK_PATH;

// Reuses DELIVERY_CREDENTIALS_ENCRYPTION_KEY and its AES-256-GCM format.
export function encryptToken(token) {
  try {
    return encryptCredentials({ telegramBotToken: token });
  } catch (error) {
    if (error instanceof AppError)
      throw new AppError(
        "Configure DELIVERY_CREDENTIALS_ENCRYPTION_KEY on the server before saving the bot token.",
        503,
        "TELEGRAM_ENCRYPTION_UNAVAILABLE",
      );
    throw error;
  }
}
export function decryptToken(setting) {
  if (!setting?.encryptedToken) return null;
  try {
    return decryptCredentials(setting.encryptedToken).telegramBotToken || null;
  } catch {
    return null;
  }
}
export function clientFor(setting) {
  const token = decryptToken(setting);
  return token ? telegramClient(token) : null;
}
// Client for operational traffic: requires the integration to be enabled.
export async function activeClient() {
  const setting = await loadSetting({ withSecrets: true });
  if (!setting.enabled) return { setting, client: null };
  return { setting, client: clientFor(setting) };
}

export function verifyWebhookSecret(setting, header) {
  if (!setting?.webhookSecretHash || typeof header !== "string" || !header)
    return false;
  const expected = Buffer.from(setting.webhookSecretHash, "hex");
  const actual = sha256(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const publicError = (error, fallback = "Telegram request failed.") =>
  error instanceof TelegramError || error instanceof AppError
    ? error.message
    : fallback;

// Configure the webhook with a fresh random secret. The secret is sent only to
// Telegram and stored only as a digest. Never drops pending updates.
export async function configureWebhook(setting, client) {
  const base = webhookBaseUrl();
  if (!/^https:\/\//i.test(base)) {
    setting.webhookUrl = webhookUrl();
    setting.webhookConfiguredAt = undefined;
    setting.webhookError =
      "Telegram commands need a public HTTPS application URL. Set CLIENT_URL or TELEGRAM_WEBHOOK_BASE_URL to an https:// address.";
    return false;
  }
  const secret = randomBytes(32).toString("hex");
  try {
    await client.setWebhook({ url: webhookUrl(), secret });
    setting.webhookSecretHash = sha256(secret).toString("hex");
    setting.webhookUrl = webhookUrl();
    setting.webhookConfiguredAt = new Date();
    setting.webhookError = undefined;
    await client.setMyCommands(BOT_COMMANDS).catch(() => {});
    return true;
  } catch (error) {
    setting.webhookConfiguredAt = undefined;
    setting.webhookError = publicError(
      error,
      "The Telegram webhook could not be configured.",
    );
    return false;
  }
}

export async function connectBot(setting, token) {
  if (!TOKEN_PATTERN.test(token))
    throw new AppError(
      "This does not look like a BotFather token (123456789:ABC...).",
      400,
      "TELEGRAM_TOKEN_INVALID",
    );
  const encryptedToken = encryptToken(token); // fails fast without the key
  const client = telegramClient(token);
  let me;
  try {
    me = await client.getMe();
  } catch (error) {
    throw new AppError(
      error.code === "TELEGRAM_UNAUTHORIZED"
        ? "Telegram rejected this bot token. Copy it again from BotFather."
        : publicError(error, "Telegram could not verify the bot token."),
      error.code === "TELEGRAM_UNAUTHORIZED" ? 400 : 502,
      "TELEGRAM_CONNECTION_FAILED",
    );
  }
  if (!me?.is_bot)
    throw new AppError(
      "This token does not belong to a bot.",
      400,
      "TELEGRAM_TOKEN_INVALID",
    );
  setting.encryptedToken = encryptedToken;
  setting.botId = String(me.id);
  setting.botUsername = me.username || "";
  setting.botName = me.first_name || "";
  setting.connectedAt = new Date();
  setting.lastConnectionTestAt = new Date();
  setting.lastConnectionTestOk = true;
  await configureWebhook(setting, client);
  return client;
}

export async function presentSetting(setting) {
  const failures = await NotificationOutbox.find({ status: "FAILED" })
    .sort({ updatedAt: -1 })
    .limit(5)
    .select(
      "orderId orderNumber lastError updatedAt deliveries.destinationName deliveries.status deliveries.lastError",
    )
    .lean();
  const configured = Boolean(
    setting.botId && (setting.encryptedToken || setting.connectedAt),
  );
  return {
    enabled: Boolean(setting.enabled),
    configured,
    connected: configured && setting.lastConnectionTestOk !== false,
    botUsername: setting.botUsername || "",
    botName: setting.botName || "",
    webhookConfigured: Boolean(setting.webhookConfiguredAt),
    webhookUrl: webhookUrl(),
    webhookError: setting.webhookError || "",
    webhookConfiguredAt: setting.webhookConfiguredAt || null,
    connectedAt: setting.connectedAt || null,
    lastConnectionTestAt: setting.lastConnectionTestAt || null,
    lastConnectionTestOk: setting.lastConnectionTestOk ?? null,
    lastNotificationError: setting.lastNotificationError?.at
      ? setting.lastNotificationError
      : null,
    events: { ORDER_CREATED: setting.events?.ORDER_CREATED !== false },
    destinations: (setting.destinations || []).map((d) => ({
      _id: String(d._id),
      name: d.name,
      chatId: d.chatId,
      messageThreadId: d.messageThreadId ?? null,
      businessTypes: d.businessTypes || [],
      enabled: d.enabled !== false,
      chatTitle: d.chatTitle || "",
      lastTestAt: d.lastTestAt || null,
      lastTestOk: d.lastTestOk ?? null,
      lastError: d.lastError || "",
    })),
    recentFailures: failures.map((f) => ({
      _id: String(f._id),
      orderId: String(f.orderId),
      orderNumber: f.orderNumber,
      lastError:
        f.lastError || f.deliveries?.find((d) => d.lastError)?.lastError || "",
      at: f.updatedAt,
    })),
  };
}
