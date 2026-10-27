import { assert } from "../errors.js";
export function normalizeWhatsApp(raw = "") {
  let phone = String(raw)
    .trim()
    .replace(/[\s().-]/g, "");
  if (!phone) return "";
  if (phone.startsWith("00")) phone = "+" + phone.slice(2);
  if (/^0[5-7]\d{8}$/.test(phone)) phone = "+213" + phone.slice(1);
  if (/^213[5-7]\d{8}$/.test(phone)) phone = "+" + phone;
  assert(
    /^\+[1-9]\d{7,14}$/.test(phone) &&
      (!phone.startsWith("+213") || /^\+213[5-7]\d{8}$/.test(phone)),
    "Enter a valid Algerian mobile or international E.164 WhatsApp number.",
  );
  return phone;
}
export const whatsAppUrl = (phone) =>
  phone
    ? `https://wa.me/${encodeURIComponent(phone.replace(/^\+/, ""))}`
    : null;
