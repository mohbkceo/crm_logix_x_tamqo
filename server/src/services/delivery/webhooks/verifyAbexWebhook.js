import { Webhook } from "standardwebhooks";
import { AppError } from "../../../errors.js";

const invalid = () =>
  new AppError(
    "Webhook authentication failed.",
    401,
    "WEBHOOK_SIGNATURE_INVALID",
  );

export function verifyAbexWebhook(req, config) {
  if (!config.enabled || !config.configured)
    throw new AppError(
      "Webhook receiver is unavailable.",
      503,
      "WEBHOOK_UNAVAILABLE",
    );
  const headers = {};
  for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
    // Reject duplicate HTTP headers rather than accepting Node's joined value.
    const count = req.rawHeaders.filter(
      (_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name,
    ).length;
    const value = req.headers[name];
    if (count !== 1 || typeof value !== "string") throw invalid();
    headers[name] = value;
  }
  if (
    !/^[\x21-\x7e]{1,200}$/.test(headers["webhook-id"]) ||
    !/^[1-9]\d{0,10}$/.test(headers["webhook-timestamp"]) ||
    headers["webhook-signature"].length > 4096 ||
    !Buffer.isBuffer(req.body)
  )
    throw invalid();
  try {
    // The library verifies the exact bytes, versioned signatures, timing-safe
    // comparison, and both directions of its five-minute timestamp tolerance.
    new Webhook(config.secret).verify(req.body, headers, { jsonParse: false });
  } catch {
    throw invalid();
  }
  let payload;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(req.body),
    );
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error();
  } catch {
    throw new AppError(
      "Webhook body must be a JSON object.",
      400,
      "WEBHOOK_SCHEMA_INVALID",
    );
  }
  return {
    eventId: headers["webhook-id"],
    providerTimestamp: new Date(Number(headers["webhook-timestamp"]) * 1000),
    payload,
  };
}
