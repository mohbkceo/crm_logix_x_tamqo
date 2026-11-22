import { z } from "zod";
import { isAbexId, isAbexDate } from "../abexMapper.js";

// This is an INTERNAL notification format, not an ABEX payload contract.
// The adapter translates only the provider fields confirmed below into it.
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

// Confirmed in the authenticated ABEX destination portal on 2026-11-22:
// f9179308-7e45-4c7a-990b-64567878e805: parcel.state.situation.created
// b100a51a-40da-4cca-b714-7f6d3b60b6fc: parcel.state.updated
// Both bodies use { eventType, occurredAt, data: { id, trackingNumber, ... } }.
// See docs/abex-webhooks.md for provenance. No customer snapshot is applied.
const supportedEventTypes = Object.freeze([
  "parcel.state.updated",
  "parcel.state.situation.created",
]);
const topic = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const envelope = z.object({
  occurredAt: z.string().refine(isAbexDate),
  data: z.object({
    id: z.string().refine(isAbexId),
    trackingNumber: notificationSchema.shape.trackingNumber,
  }),
});

export const abexWebhookAdapter = Object.freeze({
  contractVerified: true,
  contractVersion: "abex-parcel-notification-2026-11-22-v1",
  supportedEventTypes,
  parse(payload) {
    // The eventType in the signed body is authoritative. Do not guess a topic
    // from aliases or trust an unsigned event-type header to select an order.
    const parsedTopic = topic.safeParse(payload?.eventType);
    const eventType = parsedTopic.success ? parsedTopic.data : "UNKNOWN";
    if (!supportedEventTypes.includes(eventType))
      return {
        eventType,
        notification: null,
        resultCode: "WEBHOOK_UNKNOWN_EVENT",
      };
    const parsed = envelope.safeParse(payload);
    if (!parsed.success)
      return {
        eventType,
        notification: null,
        resultCode: "WEBHOOK_SCHEMA_INVALID",
      };
    return {
      eventType,
      eventOccurredAt: new Date(parsed.data.occurredAt),
      notification: notificationSchema.parse({
        parcelId: parsed.data.data.id,
        ...(parsed.data.data.trackingNumber !== undefined
          ? { trackingNumber: parsed.data.data.trackingNumber }
          : {}),
      }),
    };
  },
});
