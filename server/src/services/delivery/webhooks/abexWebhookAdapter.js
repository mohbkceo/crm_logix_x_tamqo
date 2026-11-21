import { z } from "zod";
import { isAbexId } from "../abexMapper.js";

// This is an INTERNAL notification format, not an ABEX payload contract.
// A future adapter must translate only documented topics/fields into it.
export const notificationSchema = z
  .object({
    parcelId: z
      .string()
      .refine(isAbexId)
      .transform((v) => v.toLowerCase()),
    trackingNumber: z
      .string()
      .min(1)
      .max(150)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();

export const abexWebhookAdapter = Object.freeze({
  contractVerified: false,
  contractVersion: "unverified",
  // Standard Webhooks prescribes signing, not the provider's body schema.
  // No ABEX delivery topics or parcel fields have been verified. Never infer
  // them from a guessed type/data/id property or permit an env-var bypass.
  parse() {
    return {
      eventType: "UNVERIFIED",
      notification: null,
      resultCode: "ABEX_CONTRACT_UNVERIFIED",
    };
  },
});
