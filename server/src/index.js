import mongoose from "mongoose";
import { config, validateConfig } from "./config.js";
import { app } from "./app.js";
import { startDeliverySyncScheduler } from "./services/delivery/deliveryScheduler.js";
import { migrate } from "./migrate.js";
validateConfig();
await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
await migrate();
const server = app.listen(config.port, "0.0.0.0", () =>
  console.log(`Workspace API: http://127.0.0.1:${config.port}`),
);
const timer = startDeliverySyncScheduler();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (timer) clearInterval(timer);
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
  });
