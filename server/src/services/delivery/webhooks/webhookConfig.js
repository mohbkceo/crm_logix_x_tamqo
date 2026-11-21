import { isAbexId } from "../abexMapper.js";

const integer = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max
    ? number
    : fallback;
};

export function webhookConfig(env = process.env) {
  const secret = env.ABEX_WEBHOOK_SECRET || "";
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : "";
  const secretValid =
    /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) &&
    Buffer.from(encoded, "base64").length >= 32 &&
    Buffer.from(encoded, "base64").toString("base64") === encoded;
  const destinationId = (env.ABEX_WEBHOOK_DESTINATION_ID || "").toLowerCase();
  const agencyId = (env.ABEX_WEBHOOK_AGENCY_ID || "").toLowerCase();
  return {
    enabled: env.ABEX_WEBHOOK_ENABLED === "true",
    processingEnabled: env.ABEX_WEBHOOK_PROCESSING_ENABLED === "true",
    configured: secretValid && isAbexId(destinationId),
    secret,
    destinationId,
    agencyId: /^[a-f0-9]{24}$/i.test(agencyId) ? agencyId : undefined,
    retentionDays: integer(env.ABEX_WEBHOOK_RETENTION_DAYS, 30, 1, 365),
    failedRetentionDays: integer(
      env.ABEX_WEBHOOK_FAILED_RETENTION_DAYS,
      90,
      1,
      365,
    ),
    maxAttempts: integer(env.ABEX_WEBHOOK_MAX_ATTEMPTS, 8, 1, 20),
    // Covers normal targeted reads; the fence rejects results after expiry.
    leaseMs: 300000,
    pollMs: 5000,
  };
}

export function validateWebhookConfig(env = process.env) {
  const config = webhookConfig(env);
  if (config.enabled && !config.configured)
    throw new Error(
      "ABEX webhooks require a valid whsec_ signing secret and destination UUID.",
    );
  if (env.ABEX_WEBHOOK_AGENCY_ID && !config.agencyId)
    throw new Error("ABEX_WEBHOOK_AGENCY_ID must be a CRM agency ObjectId.");
}
