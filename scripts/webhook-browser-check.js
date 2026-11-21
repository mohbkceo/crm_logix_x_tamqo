import { chromium, expect } from "@playwright/test";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Webhook } from "standardwebhooks";

process.env.NODE_ENV = "test";
process.env.CLIENT_URL = "http://127.0.0.1:4026";
process.env.BOOTSTRAP_SUPER_ADMIN_NAME = "Webhook QA";
process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL = "webhook-qa@example.test";
process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD = "webhook-test-password";
process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY =
  randomBytes(32).toString("hex");
process.env.ABEX_WEBHOOK_ENABLED = "true";
process.env.ABEX_WEBHOOK_PROCESSING_ENABLED = "true";
process.env.ABEX_WEBHOOK_SECRET = `whsec_${randomBytes(32).toString("base64")}`;
process.env.ABEX_WEBHOOK_DESTINATION_ID =
  "00c7191e-83b7-43dd-beda-9d5425cf51d3";
process.env.ABEX_WRITES_ENABLED = "false";
process.env.DELIVERY_SYNC_ENABLED = "false";
const replica = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
});
let browser, server;
try {
  await mongoose.connect(replica.getUri("webhook_browser_check"));
  const { migrate } = await import("../server/src/migrate.js");
  const { DeliveryAgency } = await import("../server/src/models/delivery.js");
  const { DeliveryWebhookEvent } =
    await import("../server/src/models/deliveryWebhook.js");
  const { AuditLog } = await import("../server/src/models/security.js");
  const { runWebhookBatch } =
    await import("../server/src/services/delivery/webhooks/webhookProcessor.js");
  await migrate();
  const agency = await DeliveryAgency.findOne({ code: "ABEX" });
  process.env.ABEX_WEBHOOK_AGENCY_ID = String(agency._id);
  const { app } = await import("../server/src/app.js");
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init()),
  );
  server = await new Promise((resolve) => {
    const http = app.listen(4026, "127.0.0.1", () => resolve(http));
  });
  for (let i = 0; i < 25; i++) {
    const id = randomUUID(),
      date = new Date(),
      body = JSON.stringify({ fixture: i });
    const response = await fetch(
      `${process.env.CLIENT_URL}/api/webhooks/delivery/abex`,
      {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": String(Math.floor(+date / 1000)),
          "webhook-signature": new Webhook(
            process.env.ABEX_WEBHOOK_SECRET,
          ).sign(id, date, body),
        },
      },
    );
    assert.equal(response.status, 200);
  }
  await runWebhookBatch();
  await runWebhookBatch();
  // Synthetic recovery row, never dispatched to a provider. Validates the real
  // UI -> authorized retry -> database -> audit path while the worker is idle.
  await DeliveryWebhookEvent.findOneAndUpdate(
    {},
    {
      $set: {
        processingStatus: "FAILED",
        eventType: "test.recovery",
        resultCode: "WEBHOOK_UNMAPPED_STATUS",
        notification: { parcelId: randomUUID() },
        contractVersion: "test-fixture-v1",
        lastErrorCode: "WEBHOOK_UNMAPPED_STATUS",
        lastErrorMessage: "Synthetic mapping review fixture.",
      },
    },
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400)
      errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(process.env.CLIENT_URL);
  await page.getByLabel("Email").fill(process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL);
  await page
    .getByLabel("Password")
    .fill(process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("Connected workspace").waitFor();
  await page.goto(`${process.env.CLIENT_URL}/settings/delivery-sync`);
  await expect(
    page.getByRole("heading", {
      name: "Delivery Synchronization",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Configured · Enabled", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("The ABEX event contract is unverified.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Next page", exact: true })
    .first()
    .click();
  await expect(page.getByText("Page 2 of 2", { exact: true })).toBeVisible();
  await page
    .getByLabel("Processing status", { exact: true })
    .selectOption("FAILED");
  await expect(
    page.getByRole("cell", { name: "test.recovery", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Retry event", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("RETRY_PENDING", { exact: true }),
  ).toBeVisible();
  assert.equal(
    await AuditLog.countDocuments({ action: "DELIVERY_WEBHOOK_RETRY" }),
    1,
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByLabel("Processing status", { exact: true })
    .selectOption("IGNORED");
  await expect(page.getByText("1–20 of 24", { exact: true })).toBeVisible();
  await page.getByLabel("Event type", { exact: true }).fill("UNVERIFIED");
  await page
    .getByLabel("Agency", { exact: true })
    .selectOption(String(agency._id));
  await expect(page.getByText("1–20 of 24", { exact: true })).toBeVisible();
  await mkdir(".local/qa/webhooks", { recursive: true });
  await page.screenshot({
    path: ".local/qa/webhooks/desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".app-shell")).toHaveClass(/collapsed/);
  await page
    .getByRole("heading", { name: "Delivery Synchronization", exact: true })
    .click();
  await page.screenshot({
    path: ".local/qa/webhooks/mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile document must not overflow horizontally",
  );
  await page
    .getByRole("button", { name: "Inspect", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  assert.ok(
    await page
      .locator(".delivery-webhook-details .metric-rows")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
    "Event details must wrap identifiers and explanations on mobile",
  );
  await page.screenshot({
    path: ".local/qa/webhooks/mobile-details.png",
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  console.log(
    "Webhook browser checks passed: signed reception, health, pagination, filters, details, audited retry, desktop and 390px mobile layout.",
  );
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await mongoose.disconnect();
  await replica.stop();
}
