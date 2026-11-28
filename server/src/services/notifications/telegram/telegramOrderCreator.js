import { User } from "../../../models/security.js";
import { normalizeWhatsApp, whatsAppUrl } from "../../../domain/whatsapp.js";

// The employee who submitted the order, for the Telegram "Contact <name>"
// button. The label uses the historical name stored on the order; the number
// is read from the employee's current User record (Administration → Users →
// WhatsApp phone), so an updated number applies to later notifications and
// message refreshes. The number only ever appears inside the wa.me URL, never
// in message text. Returns null when no valid contact exists.
export async function loadCreatorContact(order, { findUser } = {}) {
  const userId = order?.createdBy?.userId;
  if (!userId) return null;
  try {
    const user = findUser
      ? await findUser(userId)
      : await User.findById(userId).select("+whatsappPhone name").lean();
    const name = String(order.createdBy?.name || user?.name || "").trim();
    if (!user || !name || !user.whatsappPhone) return null;
    const url = whatsAppUrl(normalizeWhatsApp(user.whatsappPhone));
    return url ? { name, url } : null;
  } catch {
    // Invalid stored number or lookup failure: omit the button only.
    return null;
  }
}
