import { createHash, randomInt } from "node:crypto";
import { TelegramLinkCode } from "../../../models/telegram.js";
import { User } from "../../../models/security.js";
import { audit } from "../../../models/security.js";
import { AppError } from "../../../errors.js";

export const LINK_TTL_MS = 10 * 60000;
// No 0/O/1/I/L so a code can be typed from a screen without ambiguity.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LINK_CODE_PATTERN = /^[A-Z0-9]{8}$/;
const hash = (code) =>
  createHash("sha256").update(`telegram-link:${code}`).digest("hex");
export const normalizeCode = (code) =>
  String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "");

export async function createLinkCode(user) {
  // One active code per user: issuing a new code invalidates earlier ones.
  await TelegramLinkCode.deleteMany({
    userId: user._id,
    usedAt: { $exists: false },
  });
  const code = Array.from(
    { length: 8 },
    () => ALPHABET[randomInt(ALPHABET.length)],
  ).join("");
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  await TelegramLinkCode.create({
    userId: user._id,
    codeHash: hash(code),
    expiresAt,
  });
  return { code, expiresAt };
}

// Invalidate a code that was exposed somewhere it should not be (a group).
export async function burnLinkCode(rawCode) {
  const code = normalizeCode(rawCode);
  if (!LINK_CODE_PATTERN.test(code)) return;
  await TelegramLinkCode.updateOne(
    { codeHash: hash(code), usedAt: { $exists: false } },
    { $set: { usedAt: new Date() } },
  );
}

// Atomically consumes a valid, unexpired, unused code and binds the numeric
// Telegram user ID to that CRM user. The username is stored for display only.
export async function consumeLinkCode(rawCode, from) {
  const code = normalizeCode(rawCode);
  const invalid = new AppError(
    "This link code is invalid, expired or already used. Generate a new code in CRM Settings → Telegram.",
    400,
    "TELEGRAM_LINK_INVALID",
  );
  if (!LINK_CODE_PATTERN.test(code) || !from?.id || from.is_bot) throw invalid;
  const telegramUserId = String(from.id);
  const record = await TelegramLinkCode.findOneAndUpdate(
    {
      codeHash: hash(code),
      usedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
    { new: true },
  );
  if (!record) throw invalid;
  const user = await User.findById(record.userId);
  if (!user || user.status !== "ACTIVE") throw invalid;
  if (user.telegramUserId && user.telegramUserId !== telegramUserId)
    throw new AppError(
      "Your CRM account is already linked to another Telegram account. Unlink it in CRM Settings first.",
      409,
      "TELEGRAM_LINK_CONFLICT",
    );
  const other = await User.exists({ telegramUserId, _id: { $ne: user._id } });
  if (other)
    throw new AppError(
      "This Telegram account is already linked to a different CRM user.",
      409,
      "TELEGRAM_LINK_CONFLICT",
    );
  try {
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          telegramUserId,
          telegramUsername: from.username
            ? String(from.username).slice(0, 64)
            : "",
          telegramLinkedAt: new Date(),
        },
      },
    );
  } catch (error) {
    if (error.code === 11000)
      throw new AppError(
        "This Telegram account is already linked to a different CRM user.",
        409,
        "TELEGRAM_LINK_CONFLICT",
      );
    throw error;
  }
  await audit(
    { userId: user._id, name: user.name },
    "TELEGRAM_ACCOUNT_LINKED",
    "User",
    user._id,
    undefined,
    {},
  ).catch(() => {});
  return user;
}

export async function unlinkTelegram(user, actor) {
  await User.updateOne(
    { _id: user._id },
    { $unset: { telegramUserId: 1, telegramUsername: 1, telegramLinkedAt: 1 } },
  );
  await TelegramLinkCode.deleteMany({
    userId: user._id,
    usedAt: { $exists: false },
  });
  await audit(
    actor,
    "TELEGRAM_ACCOUNT_UNLINKED",
    "User",
    user._id,
    undefined,
    {},
  );
}

// Identity for every protected command and callback: the numeric Telegram
// user ID mapped to an ACTIVE CRM user. Never the username or display name.
export async function resolveTelegramUser(from) {
  if (!from?.id || from.is_bot) return null;
  return User.findOne({
    telegramUserId: String(from.id),
    status: "ACTIVE",
  }).lean();
}
