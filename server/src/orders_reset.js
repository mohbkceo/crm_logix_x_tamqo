import mongoose from "mongoose";

import { config } from "./config.js";
import { Order, OrderEvent, Shipment, Counter } from "./models/index.js";
import { AuditLog } from "./models/security.js";

if (!process.argv.includes("--yes")) {
  console.error(
    "Refusing to reset orders without confirmation.\n" +
      "Run: npm run reset:orders -- --yes",
  );
  process.exit(1);
}

if (!config.mongoUri) {
  throw new Error("MONGODB_URI is required.");
}

await mongoose.connect(config.mongoUri, {
  serverSelectionTimeoutMS: 10000,
});

try {
  console.log("Resetting order data...");

  const shipments = await Shipment.deleteMany({});
  const events = await OrderEvent.deleteMany({});

  // Remove only audit logs related to orders.
  const audits = await AuditLog.deleteMany({
    resourceType: "Order",
  });

  const orders = await Order.deleteMany({});

  // Reset every ORD-YYYY-XXXXXX counter.
  const counters = await Counter.deleteMany({
    _id: /^orders-\d{4}$/,
  });

  console.log("Order reset completed.");
  console.log({
    orders: orders.deletedCount,
    shipments: shipments.deletedCount,
    orderEvents: events.deletedCount,
    orderAudits: audits.deletedCount,
    orderCounters: counters.deletedCount,
  });
} finally {
  await mongoose.disconnect();
}
