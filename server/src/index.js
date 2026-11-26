import mongoose from "mongoose";
import { config, validateConfig } from "./config.js";
import { app } from "./app.js";
import {
  startDeliverySyncScheduler,
  stopDeliverySyncScheduler,
} from "./services/delivery/deliveryScheduler.js";
import { migrate } from "./migrate.js";
import { startMediaCleanupScheduler } from "./services/mediaCleanup.js";
import { validateWebhookConfig } from "./services/delivery/webhooks/webhookConfig.js";
import { ensureWebhookIndexes } from "./models/deliveryWebhook.js";
import { startWebhookProcessor } from "./services/delivery/webhooks/webhookProcessor.js";
import { startNotificationWorker } from "./services/notifications/notificationWorker.js";
import { webhookHooks } from "./services/notifications/telegram/telegramWebhook.js";
validateConfig();
validateWebhookConfig();
await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
await migrate();
await ensureWebhookIndexes();
const server = app.listen(config.port, "0.0.0.0", () =>
  console.log(`Workspace API: http://127.0.0.1:${config.port}`),
);
await startDeliverySyncScheduler();
const mediaTimer = startMediaCleanupScheduler();
const stopWebhookProcessor = startWebhookProcessor();
const notificationWorker = startNotificationWorker();
webhookHooks.wake = notificationWorker.wake;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopDeliverySyncScheduler();
    clearInterval(mediaTimer);
    server.close(async () => {
      await stopWebhookProcessor();
      await notificationWorker.stop();
      await mongoose.disconnect();
      process.exit(0);
    });
  });
