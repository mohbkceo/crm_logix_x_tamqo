import { randomUUID } from "node:crypto";
import { Webhook } from "standardwebhooks";

// Explicit operator invocation only. No secret is read from argv or printed.
const base = new URL(process.argv[2] || "http://127.0.0.1:4000");
const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
if (
  (!local && base.protocol !== "https:") ||
  base.username ||
  base.password ||
  base.pathname !== "/" ||
  base.search ||
  base.hash
)
  throw new Error("Use an HTTPS origin, or a local HTTP origin.");
const secret = process.env.ABEX_WEBHOOK_SECRET;
if (!secret?.startsWith("whsec_"))
  throw new Error(
    "Inject ABEX_WEBHOOK_SECRET into the backend environment first.",
  );
const id = `crm-smoke-${randomUUID()}`,
  date = new Date();
const body = JSON.stringify({ crmTransportSmokeTest: true });
try {
  const response = await fetch(new URL("/api/webhooks/delivery/abex", base), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    body,
    headers: {
      "Content-Type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(+date / 1000)),
      "webhook-signature": new Webhook(secret).sign(id, date, body),
    },
  });
  console.log(`Webhook transport smoke test: HTTP ${response.status}`);
  if (!response.ok) process.exitCode = 1;
} catch {
  console.error("Webhook transport smoke test failed.");
  process.exitCode = 1;
}
