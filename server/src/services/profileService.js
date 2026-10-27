import { TrackingSetting } from "../models/tracking.js";
import { normalizeWhatsApp } from "../domain/whatsapp.js";
import { assert } from "../errors.js";
export async function validateWhatsApp(value) {
  const phone = normalizeWhatsApp(value);
  const settings = await TrackingSetting.findById("tracking");
  assert(
    !settings?.requireWhatsApp || phone,
    "A WhatsApp number is required. Complete your profile.",
  );
  return phone;
}
export async function validateOperationalRoles(roles) {
  if (!roles) return;
  const settings = await TrackingSetting.findById("tracking");
  assert(
    !settings ||
      roles.every((role) =>
        settings.operationalRoles.some((r) => r.code === role && r.enabled),
      ),
    "Select enabled operational roles",
  );
}
