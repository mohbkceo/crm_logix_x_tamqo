import { P, can } from "../../../authorization.js";
import { NotificationOutbox } from "../../../models/telegram.js";
import { AppError } from "../../../errors.js";
import {
  escapeHtml,
  orderSummary,
  summaryKeyboard,
} from "./telegramOrderFormatter.js";
import {
  LIST_BY_COMMAND,
  renderList,
  findOrder,
  weekSummary,
} from "./telegramQueries.js";
import { loadOrder } from "./telegramOrderActions.js";
import {
  burnLinkCode,
  consumeLinkCode,
  resolveTelegramUser,
} from "./telegramLinking.js";
import { BOT_COMMANDS } from "./telegramSettings.js";

const LINK_HELP =
  "Link your CRM account first: open <b>CRM → Settings → Telegram</b>, press <b>Link my Telegram</b>, then send <code>/link CODE</code> to this bot in a private chat.";

// "/week-production@MyBot arg" -> { name: "week_production", args: "arg" }.
// Commands addressed to another bot are ignored.
export function parseCommand(text, botUsername) {
  const match =
    /^\/([A-Za-z0-9_-]{1,64})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/.exec(
      String(text || "").trim(),
    );
  if (!match) return null;
  if (
    match[2] &&
    botUsername &&
    match[2].toLowerCase() !== botUsername.toLowerCase()
  )
    return null;
  return {
    name: match[1].toLowerCase().replace(/-/g, "_"),
    args: (match[3] || "").trim(),
  };
}

function helpText() {
  const dash = (c) => c.replace(/_/g, "-");
  return [
    "<b>CRM Operations Bot</b>",
    "",
    ...BOT_COMMANDS.map(
      (c) =>
        `/${escapeHtml(c.command.includes("_") ? dash(c.command) : c.command)} — ${escapeHtml(c.description)}`,
    ),
    "",
    "<i>Hyphens and underscores both work, e.g. /week-production or /week_production.</i>",
  ].join("\n");
}

function chatIdText(message) {
  const chat = message.chat || {};
  const topic =
    message.is_topic_message && message.message_thread_id
      ? String(message.message_thread_id)
      : "Not applicable";
  return [
    "<b>Telegram Destination Information</b>",
    "",
    `Group: ${escapeHtml(chat.title || (chat.type === "private" ? "Private chat" : "—"))}`,
    "",
    "Chat ID:",
    `<code>${escapeHtml(String(chat.id))}</code>`,
    "",
    "Topic ID:",
    topic === "Not applicable" ? topic : `<code>${escapeHtml(topic)}</code>`,
  ].join("\n");
}

async function botStatus(client, setting) {
  const [info, pending, failed, waiting] = await Promise.all([
    client.getWebhookInfo().catch(() => null),
    NotificationOutbox.countDocuments({
      status: { $in: ["PENDING", "PROCESSING"] },
    }),
    NotificationOutbox.countDocuments({ status: "FAILED" }),
    NotificationOutbox.countDocuments({ status: "WAITING" }),
  ]);
  const destinations = setting.destinations || [];
  return [
    "<b>🤖 Bot status</b>",
    "",
    `Integration: ${setting.enabled ? "Enabled ✅" : "Disabled"}`,
    `Bot: @${escapeHtml(setting.botUsername || "—")}`,
    `Webhook: ${setting.webhookConfiguredAt ? "Configured ✅" : "Not configured"}`,
    ...(info
      ? [
          `Pending updates at Telegram: ${Number(info.pending_update_count) || 0}`,
        ]
      : []),
    ...(info?.last_error_message
      ? [
          `Last webhook error: ${escapeHtml(String(info.last_error_message).slice(0, 200))}`,
        ]
      : []),
    `Destinations: ${destinations.filter((d) => d.enabled !== false).length} enabled / ${destinations.length}`,
    "",
    `Notifications waiting: ${waiting} · queued: ${pending} · failed: ${failed}`,
    ...(setting.lastNotificationError?.at
      ? [
          `Last notification error: ${escapeHtml(setting.lastNotificationError.message || "")}`,
        ]
      : []),
  ].join("\n");
}

export async function handleCommand(
  message,
  { client, setting, now = new Date() },
) {
  const command = parseCommand(message.text, setting.botUsername);
  if (!command) return;
  const reply = (text, keyboard) =>
    client.sendMessage({
      chatId: message.chat.id,
      threadId: message.is_topic_message
        ? message.message_thread_id
        : undefined,
      text,
      keyboard,
    });
  const privateChat = message.chat?.type === "private";
  let { name, args } = command;
  if (name === "start" && /^link[_-]/i.test(args)) {
    name = "link";
    args = args.slice(5);
  }
  if (name === "chatid") return reply(chatIdText(message));
  if (name === "help") return reply(helpText());
  if (name === "start")
    return reply(
      [
        "<b>Welcome to the CRM Operations Bot.</b>",
        "",
        "• /chatid shows the IDs needed to add a group in CRM Settings.",
        "• /link CODE connects your CRM account (private chat only).",
        "• /help lists every command.",
      ].join("\n"),
    );
  if (name === "link") {
    if (!privateChat) {
      // A code posted in a group is considered exposed: invalidate it.
      await burnLinkCode(args);
      return reply(
        "For security, send <code>/link CODE</code> to me in a <b>private chat</b>. That code has been invalidated; generate a new one in CRM Settings.",
      );
    }
    try {
      const user = await consumeLinkCode(args, message.from);
      return reply(
        `✅ Linked to CRM user <b>${escapeHtml(user.name)}</b>. You can now use order commands and buttons.`,
      );
    } catch (error) {
      return reply(
        escapeHtml(
          error instanceof AppError
            ? error.message
            : "Linking failed. Try again.",
        ),
      );
    }
  }
  const known =
    name === "order" ||
    name === "week_summary" ||
    name === "bot_status" ||
    LIST_BY_COMMAND[name];
  // Unknown commands in groups may belong to other bots: stay silent there.
  if (!known)
    return privateChat
      ? reply("Unknown command. Send /help for the list.")
      : undefined;
  const user = await resolveTelegramUser(message.from);
  if (!user) return reply(LINK_HELP);
  try {
    if (name === "bot_status") {
      if (!can(user, P.settings.manage))
        return reply("Only administrators can view the bot status.");
      return reply(await botStatus(client, setting));
    }
    if (name === "week_summary") return reply(await weekSummary(user, now));
    if (name === "order") {
      if (!args)
        return reply(
          "Usage: <code>/order ORD-2026-000123</code> or <code>/order TRACKING</code>",
        );
      const id = await findOrder(user, args);
      if (!id)
        return reply(
          `No accessible order matches <code>${escapeHtml(args.slice(0, 80))}</code>.`,
        );
      const { order, shipment, contact } = await loadOrder(id);
      return reply(
        orderSummary(order, shipment, { title: "📦 ORDER" }),
        summaryKeyboard(order, shipment, contact),
      );
    }
    const code = LIST_BY_COMMAND[name];
    const page = await renderList(user, code, 1, now);
    return reply(page.text, page.keyboard);
  } catch (error) {
    if (error instanceof AppError && error.status === 403)
      return reply(escapeHtml(error.message));
    throw error;
  }
}
