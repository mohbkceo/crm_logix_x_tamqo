import axios from "axios";

// Official Bot API over HTTPS. The token is part of the request path, so no
// axios error, URL or config object may ever be logged or persisted: every
// failure is converted into a TelegramError holding only safe fields.
const API = "https://api.telegram.org";
const TIMEOUT_MS = 20000;
export const TOKEN_PATTERN = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;
export const MESSAGE_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;
export const CALLBACK_DATA_LIMIT = 64;

// Descriptions that mean "this destination cannot receive messages until an
// administrator fixes it". They are not retried automatically.
const DESTINATION_ERRORS = [
  [
    /chat not found/i,
    "CHAT_NOT_FOUND",
    "The group was not found. Check the Group ID and that the bot is a member.",
  ],
  [
    /bot was kicked|bot is not a member|user is deactivated|bot was blocked/i,
    "BOT_REMOVED",
    "The bot is not a member of this group (it may have been removed).",
  ],
  [
    /not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|CHAT_SEND_PHOTOS_FORBIDDEN|need administrator rights/i,
    "MISSING_PERMISSION",
    "The bot is not allowed to send messages or photos in this group.",
  ],
  [
    /message thread not found|TOPIC_CLOSED|TOPIC_DELETED|thread/i,
    "TOPIC_INVALID",
    "The forum topic was not found or is closed. Check the Topic ID.",
  ],
  [
    /group chat was upgraded to a supergroup/i,
    "CHAT_MIGRATED",
    "The group was upgraded to a supergroup. Run /chatid again and update the Group ID.",
  ],
];

export class TelegramError extends Error {
  constructor({
    code,
    message,
    status = 0,
    retryable = false,
    retryAfter = 0,
    destination = false,
  }) {
    super(message);
    this.name = "TelegramError";
    this.code = code;
    this.httpStatus = status;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
    this.destination = destination;
  }
}

export function classifyTelegramFailure(error) {
  if (error instanceof TelegramError) return error;
  const response = error?.response;
  if (!response) {
    const timeout =
      error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT";
    return new TelegramError({
      code: timeout ? "TELEGRAM_TIMEOUT" : "TELEGRAM_NETWORK",
      message: timeout
        ? "Telegram did not respond in time."
        : "Telegram could not be reached.",
      retryable: true,
    });
  }
  const status = response.status;
  const body =
    response.data && typeof response.data === "object" ? response.data : {};
  // Telegram descriptions are short, never contain the token, and are trimmed.
  const description = String(body.description || "").slice(0, 300);
  if (status === 429)
    return new TelegramError({
      code: "TELEGRAM_RATE_LIMIT",
      message: "Telegram rate limit reached; retry scheduled.",
      status,
      retryable: true,
      retryAfter: Number(body.parameters?.retry_after) || 5,
    });
  if (status >= 500)
    return new TelegramError({
      code: "TELEGRAM_UNAVAILABLE",
      message: "Telegram is temporarily unavailable.",
      status,
      retryable: true,
    });
  if (status === 401 || status === 404)
    return new TelegramError({
      code: "TELEGRAM_UNAUTHORIZED",
      message:
        "Telegram rejected the bot token. Replace the token in Settings.",
      status,
    });
  for (const [pattern, code, message] of DESTINATION_ERRORS)
    if (pattern.test(description))
      return new TelegramError({ code, message, status, destination: true });
  if (status === 403)
    return new TelegramError({
      code: "BOT_REMOVED",
      message: "The bot is not allowed to post in this chat.",
      status,
      destination: true,
    });
  return new TelegramError({
    code: "TELEGRAM_REJECTED",
    message: description
      ? `Telegram rejected the request: ${description}`
      : "Telegram rejected the request.",
    status,
  });
}

function unwrap(response) {
  const body = response?.data;
  if (!body || body.ok !== true)
    throw classifyTelegramFailure({
      response: { status: response?.status || 400, data: body },
    });
  return body.result;
}

export function telegramClient(token) {
  if (!TOKEN_PATTERN.test(String(token || "")))
    throw new TelegramError({
      code: "TELEGRAM_TOKEN_INVALID",
      message: "The bot token format is invalid.",
    });
  const url = (method) => `${API}/bot${token}/${method}`;
  async function call(method, params = {}) {
    try {
      return unwrap(
        await axios.post(url(method), params, {
          timeout: TIMEOUT_MS,
          maxRedirects: 0,
        }),
      );
    } catch (error) {
      throw classifyTelegramFailure(error);
    }
  }
  async function multipart(method, fields, files) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields))
      if (value !== undefined && value !== null)
        form.append(
          key,
          typeof value === "object" ? JSON.stringify(value) : String(value),
        );
    for (const file of files)
      form.append(
        file.field,
        new Blob([file.buffer], { type: file.mime }),
        file.filename,
      );
    try {
      return unwrap(
        await axios.post(url(method), form, {
          timeout: 60000,
          maxRedirects: 0,
          maxBodyLength: 60 * 1024 * 1024,
        }),
      );
    } catch (error) {
      throw classifyTelegramFailure(error);
    }
  }
  const thread = (id) => (id ? { message_thread_id: id } : {});
  return {
    getMe: () => call("getMe"),
    getChat: (chatId) => call("getChat", { chat_id: chatId }),
    getWebhookInfo: () => call("getWebhookInfo"),
    setWebhook: ({ url: webhookUrl, secret }) =>
      call("setWebhook", {
        url: webhookUrl,
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
        max_connections: 10,
      }),
    deleteWebhook: () => call("deleteWebhook", { drop_pending_updates: false }),
    setMyCommands: (commands) => call("setMyCommands", { commands }),
    sendMessage: ({ chatId, threadId, text, keyboard }) =>
      call("sendMessage", {
        chat_id: chatId,
        ...thread(threadId),
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      }),
    editMessageText: ({ chatId, messageId, text, keyboard }) =>
      call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard || [] },
      }),
    answerCallbackQuery: ({ id, text, alert = false }) =>
      call("answerCallbackQuery", {
        callback_query_id: id,
        ...(text ? { text: text.slice(0, 200), show_alert: alert } : {}),
      }),
    sendPhoto: ({ chatId, threadId, photo }) =>
      multipart("sendPhoto", { chat_id: chatId, ...thread(threadId) }, [
        { field: "photo", ...photo },
      ]),
    sendMediaGroup: ({ chatId, threadId, photos }) =>
      multipart(
        "sendMediaGroup",
        {
          chat_id: chatId,
          ...thread(threadId),
          media: photos.map((_, i) => ({
            type: "photo",
            media: `attach://photo${i}`,
          })),
        },
        photos.map((photo, i) => ({ field: `photo${i}`, ...photo })),
      ),
  };
}
