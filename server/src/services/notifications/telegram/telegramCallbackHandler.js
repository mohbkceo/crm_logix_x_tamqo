import { AppError } from "../../../errors.js";
import {
  orderSummary,
  summaryKeyboard,
  humanStatus,
} from "./telegramOrderFormatter.js";
import { loadCreatorContact } from "./telegramOrderCreator.js";
import { LISTS, renderList } from "./telegramQueries.js";
import {
  availableActions,
  cancelConfirmKeyboard,
  executeAction,
  loadOrder,
  refreshOrderMessages,
  StaleActionError,
  statusMenuKeyboard,
  ACTIONS,
} from "./telegramOrderActions.js";
import { resolveTelegramUser } from "./telegramLinking.js";

const ID = "([a-f0-9]{24})";
const PATTERNS = {
  menu: new RegExp(`^s:${ID}:(\\d{1,9})$`),
  back: new RegExp(`^b:${ID}:(\\d{1,9})$`),
  action: new RegExp(`^t:${ID}:(\\d{1,9}):(C|P|X|Y|G0|G1|GR)$`),
  page: /^p:([a-z]{2}):(\d{1,4})$/,
};
const NOT_LINKED =
  "Link your Telegram account in CRM Settings → Telegram first.";

export function parseCallback(data) {
  const value = String(data || "");
  for (const [kind, pattern] of Object.entries(PATTERNS)) {
    const m = pattern.exec(value);
    if (m)
      return {
        kind,
        id: m[1],
        revision: m[2] === undefined ? undefined : Number(m[2]),
        code: m[3],
      };
  }
  return value === "n" ? { kind: "noop" } : null;
}

// Every callback is authorized from callback_query.from.id → linked active CRM
// user → permissions/business scope → current order state. A button is never
// trusted merely because it exists in a chat.
export async function handleCallback(query, { client }) {
  const message = query.message;
  const answer = (text, alert = false) =>
    client.answerCallbackQuery({ id: query.id, text, alert }).catch(() => {});
  const parsed = parseCallback(query.data);
  if (!parsed) return answer("This button is no longer supported.");
  if (parsed.kind === "noop") return answer();
  const user = await resolveTelegramUser(query.from);
  if (!user) return answer(NOT_LINKED, true);
  if (!message?.chat?.id || !message.message_id)
    return answer("This message can no longer be updated.");
  const edit = (text, keyboard) =>
    client
      .editMessageText({
        chatId: message.chat.id,
        messageId: message.message_id,
        text,
        keyboard,
      })
      .catch((error) => {
        if (!/not modified/i.test(error.message)) throw error;
      });
  try {
    if (parsed.kind === "page") {
      if (!LISTS[parsed.id]) return answer("This list is no longer available.");
      const page = await renderList(user, parsed.id, Number(parsed.revision));
      await edit(page.text, page.keyboard);
      return answer();
    }
    const { order, shipment, contact } = await loadOrder(parsed.id);
    if (!order || order.deletedAt)
      return answer("This order is no longer available.", true);
    if (parsed.kind === "back") {
      await edit(
        orderSummary(order, shipment),
        summaryKeyboard(order, shipment, contact),
      );
      return answer();
    }
    if (order.revision !== parsed.revision) throw new StaleActionError();
    const codes = await availableActions(user, order, shipment);
    if (parsed.kind === "menu") {
      await edit(
        orderSummary(order, shipment) +
          (codes.length
            ? "\n\n<b>Choose the new status:</b>"
            : "\n\n<i>No status changes are available for you on this order.</i>"),
        statusMenuKeyboard(order, codes),
      );
      return answer();
    }
    if (parsed.code === "X") {
      if (!codes.includes("X"))
        return answer(
          "This action is not available for you on this order.",
          true,
        );
      await edit(
        orderSummary(order, shipment) +
          "\n\n<b>Cancel this order?</b> This cannot be undone.",
        cancelConfirmKeyboard(order),
      );
      return answer();
    }
    const updated = await executeAction(
      user,
      parsed.id,
      parsed.revision,
      parsed.code,
    );
    await edit(
      orderSummary(updated.order, updated.shipment),
      summaryKeyboard(
        updated.order,
        updated.shipment,
        await loadCreatorContact(updated.order),
      ),
    );
    await refreshOrderMessages(client, updated.order, updated.shipment, {
      except: { chatId: message.chat.id, messageId: message.message_id },
    });
    const label = ACTIONS[parsed.code].stage
      ? ACTIONS[parsed.code].label.replace(/^\S+\s/, "")
      : humanStatus(updated.order.status);
    return answer(`✅ ${label} — saved by ${user.name}`.slice(0, 200));
  } catch (error) {
    if (error instanceof StaleActionError || error.name === "VersionError") {
      const latest = await loadOrder(parsed.id).catch(() => null);
      if (latest?.order)
        await edit(
          orderSummary(latest.order, latest.shipment),
          summaryKeyboard(latest.order, latest.shipment, latest.contact),
        ).catch(() => {});
      return answer(new StaleActionError().message, true);
    }
    // Business-rule rejections are shown; anything else stays generic.
    if (error instanceof AppError && error.status < 500)
      return answer(error.message, true);
    await answer(
      "The CRM could not complete this action. Try again or use the CRM.",
      true,
    );
    throw error;
  }
}
