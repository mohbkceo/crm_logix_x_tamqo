import mongoose from "mongoose";
import { config, validateConfig } from "./config.js";
import { app } from "./app.js";
import { deliveryService as deliverySyncService } from "./services/delivery/deliveryService.js";
import { migrate } from "./migrate.js";
validateConfig();
await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
await migrate();
const server = app.listen(config.port, "0.0.0.0", () =>
  console.log(`Workspace API: http://127.0.0.1:${config.port}`),
);
let timer,
  busy = false;
const interval = Number(process.env.DELIVERY_SYNC_INTERVAL_MS || 60000);
if (interval >= 60000)
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await deliverySyncService.syncBatch();
    } catch {
      console.error(
        "Scheduled delivery sync failed. Inspect shipment errors in the workspace.",
      );
    } finally {
      busy = false;
    }
  }, interval);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (timer) clearInterval(timer);
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
  });
