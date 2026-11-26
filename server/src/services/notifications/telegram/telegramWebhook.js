import express, { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { TelegramUpdate } from "../../../models/telegram.js";
import {
  loadSetting,
  verifyWebhookSecret,
  clientFor,
} from "./telegramSettings.js";
import { handleCommand } from "./telegramCommandHandler.js";
import { handleCallback } from "./telegramCallbackHandler.js";

const LOCK_MS = 60000;
// The worker registers its wake-up here at startup (no-op in tests/CLI).
export const webhookHooks = { wake: () => {} };
const MESSAGE_ATTEMPTS = 2; // callbacks are interactive and never replayed

const pick = (o, keys) =>
  o
    ? Object.fromEntries(
        keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]),
      )
    : undefined;
// Persist only what the handlers need: no photos, contacts or other content.
export function sanitizeUpdate(update) {
  const chat = (c) => pick(c, ["id", "type", "title"]);
  const from = (f) => pick(f, ["id", "is_bot", "username"]);
  if (update.message) {
    const m = update.message;
    return {
      kind: "message",
      payload: {
        message_id: m.message_id,
        message_thread_id: m.message_thread_id,
        is_topic_message: m.is_topic_message,
        chat: chat(m.chat),
        from: from(m.from),
        text: typeof m.text === "string" ? m.text.slice(0, 500) : undefined,
      },
    };
  }
  if (update.callback_query) {
    const q = update.callback_query;
    return {
      kind: "callback_query",
      payload: {
        id: String(q.id || ""),
        data: typeof q.data === "string" ? q.data.slice(0, 64) : undefined,
        from: from(q.from),
        message: q.message
          ? { message_id: q.message.message_id, chat: chat(q.message.chat) }
          : undefined,
      },
    };
  }
  return { kind: "other" };
}

// Mounted before CORS/JSON/CRM authentication. The secret header proves the
// request came from Telegram for this bot; it does NOT authorize any user.
export function createTelegramWebhookRouter({ onAccepted } = {}) {
  const router = Router();
  router.use(
    rateLimit({
      windowMs: 60000,
      limit: 600,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  router.post("/", express.json({ limit: "1mb" }), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const setting = await loadSetting({ withSecrets: true }).catch(() => null);
    if (!setting) return res.status(503).json({ ok: false });
    if (
      !verifyWebhookSecret(setting, req.get("X-Telegram-Bot-Api-Secret-Token"))
    )
      return res.status(401).json({ ok: false });
    const updateId = Number(req.body?.update_id);
    // Acknowledge (200) anything Telegram cannot fix by retrying.
    if (!setting.enabled || !Number.isSafeInteger(updateId))
      return res.json({ ok: true });
    const { kind, payload } = sanitizeUpdate(req.body);
    if (kind === "other") return res.json({ ok: true });
    try {
      await TelegramUpdate.create({ updateId, kind, payload });
    } catch (error) {
      if (error.code === 11000) return res.json({ ok: true, duplicate: true });
      // 5xx: Telegram keeps the update and redelivers it.
      return res.status(503).json({ ok: false });
    }
    res.json({ ok: true });
    onAccepted?.();
  });
  router.use((_error, _req, res, _next) => res.status(400).json({ ok: false }));
  return router;
}

export async function claimUpdate(now = new Date()) {
  return TelegramUpdate.findOneAndUpdate(
    {
      $or: [
        { status: "RECEIVED" },
        { status: "PROCESSING", lockedUntil: { $lte: now } },
      ],
    },
    {
      $set: { status: "PROCESSING", lockedUntil: new Date(+now + LOCK_MS) },
      $inc: { attempts: 1 },
    },
    { sort: { updateId: 1 }, new: true },
  );
}

export async function processUpdate(update, { setting, client }) {
  const payload = update.payload || {};
  if (update.kind === "message") {
    if (payload.from?.is_bot || !payload.text?.startsWith("/")) return;
    await handleCommand(payload, { client, setting });
  } else if (update.kind === "callback_query") {
    await handleCallback(payload, { client, setting });
  }
}

export async function runUpdateBatch({ limit = 25 } = {}) {
  const setting = await loadSetting({ withSecrets: true });
  if (!setting.enabled) return 0;
  const client = clientFor(setting);
  if (!client) return 0;
  let processed = 0;
  for (; processed < limit; processed++) {
    const update = await claimUpdate();
    if (!update) break;
    try {
      await processUpdate(update, { setting, client });
      // Drop message content once handled (link codes, search terms).
      await TelegramUpdate.updateOne(
        { _id: update._id },
        {
          $set: { status: "DONE", processedAt: new Date() },
          $unset: { payload: 1, lockedUntil: 1 },
        },
      );
    } catch (error) {
      const retry =
        update.kind === "message" && update.attempts < MESSAGE_ATTEMPTS;
      await TelegramUpdate.updateOne(
        { _id: update._id },
        {
          $set: {
            status: retry ? "RECEIVED" : "FAILED",
            lastErrorCode: String(error?.code || error?.name || "ERROR").slice(
              0,
              60,
            ),
            ...(retry ? {} : { processedAt: new Date() }),
          },
          $unset: { lockedUntil: 1, ...(retry ? {} : { payload: 1 }) },
        },
      );
    }
  }
  return processed;
}
