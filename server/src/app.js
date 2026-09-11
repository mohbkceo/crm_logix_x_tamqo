import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import mongoose from "mongoose";
import path from "node:path";
import { existsSync } from "node:fs";
import { z, ZodError } from "zod";
import { config } from "./config.js";
import { assert, AppError } from "./errors.js";
import authRoutes, { requireAuth } from "./auth.js";
import configRoutes from "./routes/configRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import expenseRoutes from "./routes/expenseRoutes.js";
import saleRoutes from "./routes/saleRoutes.js";
import { analytics } from "./services/analyticsService.js";
import { Customer, Order } from "./models/index.js";
import { pagination, escapeRegex, objectId } from "./services/filters.js";
import { deliveryClient } from "./services/delivery/deliveryClient.js";

import { securityRoutes } from "./routes/securityRoutes.js";
import { agencyRoutes } from "./routes/agencyRoutes.js";
import { teamRoutes, employeeOptions } from "./routes/teamRoutes.js";
import { deliverySyncRoutes } from "./routes/deliverySyncRoutes.js";
import { P, can, requirePermission, orderScope } from "./authorization.js";
import { deliveryService } from "./services/delivery/deliveryService.js";
import { normalizePhone } from "./domain/order.js";
import { audit } from "./models/security.js";
import { transaction } from "./services/orderService.js";
import { deliveryStatusMapping } from "./services/delivery/deliveryStatusMapper.js";
export const app = express();
app.disable("x-powered-by");
app.use(
  helmet({ contentSecurityPolicy: config.production ? undefined : false }),
);
app.use(cors({ origin: config.clientUrl, credentials: true }));
app.use(express.json({ limit: "150kb" }), cookieParser());
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.use("/api", (req, _res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin)
    assert(
      req.headers.origin === config.clientUrl,
      "Request origin is not allowed.",
      403,
    );
  next();
});
app.get("/api/health", (_req, res) =>
  res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({
    status:
      mongoose.connection.readyState === 1 ? "ok" : "database unavailable",
  }),
);
app.use("/api/auth", authRoutes);
app.use("/api", requireAuth);
app.use("/api", securityRoutes);
app.use("/api/delivery-agencies", agencyRoutes);
app.use("/api/delivery-sync", deliverySyncRoutes);
app.use("/api/analytics", teamRoutes);
app.get("/api/employees", employeeOptions);
app.use("/api/config", configRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/sales", saleRoutes);
app.get("/api/analytics/:scope", async (req, res) => {
  if (req.query.export)
    assert(can(req.user, P.analytics.export), "Export permission denied", 403);
  const scope = req.params.scope.toUpperCase();
  assert(
    ["ALL", "TAMQO", "LOGIX", "PARTNERSHIP"].includes(scope),
    "Unknown business",
    404,
  );
  res.json(await analytics(req.query, scope, req.user));
});
const realizedExpression = {
  $and: [
    {
      $not: [
        { $in: ["$status", ["NEW", "CANCELLED", "RETURNED", "RETURNING"]] },
      ],
    },
    {
      $or: [
        { $eq: ["$status", "DELIVERED"] },
        {
          $and: [
            { $eq: ["$businessType", "TAMQO_ONLY"] },
            {
              $or: [
                { $ne: [{ $ifNull: ["$tamqoActivatedAt", null] }, null] },
                { $gte: ["$payment.amountPaidOnline", "$productRevenue"] },
              ],
            },
          ],
        },
      ],
    },
  ],
};
app.get(
  "/api/customers",
  requirePermission(P.customers.view),
  async (req, res) => {
    const p = pagination(req.query),
      f = {
        _id: { $in: await Order.distinct("customerId", orderScope(req.user)) },
      };
    if (req.query.search) {
      const r = { $regex: escapeRegex(req.query.search), $options: "i" };
      f.$or = [{ name: r }, { phoneA: r }, { normalizedPhone: r }];
    }
    const [customers, total] = await Promise.all([
      Customer.find(f)
        .sort({ createdAt: -1, _id: -1 })
        .skip(p.skip)
        .limit(p.limit)
        .lean(),
      Customer.countDocuments(f),
    ]);
    const stats = await Order.aggregate([
      {
        $match: {
          ...orderScope(req.user),
          customerId: { $in: customers.map((c) => c._id) },
        },
      },
      {
        $group: {
          _id: "$customerId",
          orders: { $sum: 1 },
          lifetimeRevenue: {
            $sum: { $cond: [realizedExpression, "$productRevenue", 0] },
          },
          lastOrder: { $max: "$createdAt" },
          firstOrder: { $min: "$createdAt" },
        },
      },
    ]);
    res.json({
      items: customers.map((c) => ({
        ...c,
        ...stats.find((s) => String(s._id) === String(c._id)),
        _id: c._id,
      })),
      total,
      page: p.page,
      limit: p.limit,
    });
  },
);
app.get(
  "/api/customers/:id",
  requirePermission(P.customers.view),
  async (req, res) => {
    const customer = await Customer.findById(objectId(req.params.id));
    assert(customer, "Customer not found", 404);
    assert(
      await Order.exists({ ...orderScope(req.user), customerId: customer._id }),
      "Customer business access denied",
      403,
    );
    res.json(customer);
  },
);
app.patch(
  "/api/customers/:id",
  requirePermission(P.customers.update),
  async (req, res) => {
    const customer = await Customer.findById(objectId(req.params.id));
    assert(customer, "Customer not found", 404);
    assert(
      await Order.exists({ ...orderScope(req.user), customerId: customer._id }),
      "Customer business access denied",
      403,
    );
    const input = z
      .object({
        name: z.string().trim().min(2).max(150),
        phoneA: z.string().min(1).max(30),
        phoneB: z.string().max(30).optional().default(""),
      })
      .parse(req.body);
    input.normalizedPhone = normalizePhone(input.phoneA);
    input.normalizedPhoneB = input.phoneB ? normalizePhone(input.phoneB) : "";
    await transaction(async (session) => {
      Object.assign(customer, input);
      await customer.save({ session });
      await audit(
        req.actor,
        "CUSTOMER_UPDATED",
        "Customer",
        customer._id,
        undefined,
        {},
        session,
      );
    });
    res.json(customer);
  },
);
app.get(
  "/api/delivery/status",
  requirePermission(P.deliveryAgencies.view),
  (_req, res) => {
    const mapping = deliveryStatusMapping();
    res.json({
      configured: Boolean(
        process.env.DELIVERY_API_TOKEN && process.env.DELIVERY_API_KEY,
      ),
      statusMappingConfigured: mapping.configured,
      statusMappingError: mapping.error,
      invalidStatusMappings: mapping.invalidEntries || 0,
    });
  },
);
app.post(
  "/api/delivery/test",
  requirePermission(P.deliveryAgencies.testConnection),
  async (req, res) => {
    assert(
      req.user.role === "SUPER_ADMIN",
      "Use agency-specific connection tests",
      403,
    );
    assert(
      await deliveryClient.testCredentials(),
      "Procolis credentials are not activated",
      422,
    );
    res.json({
      message: "Procolis API connection and credentials verified successfully.",
    });
  },
);
app.post(
  "/api/delivery/sync",
  requirePermission(P.deliverySync.run),
  async (req, res) => {
    const result = await deliveryService.syncBatch({ trigger: "MANUAL" });
    await audit(
      req.actor,
      "DELIVERY_SYNC_RUN",
      "DeliverySyncRun",
      result.runId,
      undefined,
      { status: result.status },
    );
    res.json(result);
  },
);
app.use("/api", (_req, _res, next) =>
  next(new AppError("Endpoint not found", 404)),
);
const dist = path.resolve(import.meta.dirname, "../../client/dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(dist, "index.html")),
  );
}
app.use((err, _req, res, _next) => {
  let status = err.status || 500,
    message = err.message,
    code = err.code || "INTERNAL_ERROR";
  if (err instanceof ZodError) {
    status = 400;
    message = err.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    code = "VALIDATION_ERROR";
  } else if (err.code === 11000) {
    status = 409;
    message = "A record with this unique value already exists.";
    code = "CONFLICT";
  } else if (err.name === "VersionError") {
    status = 409;
    message = "This record changed. Reload and try again.";
    code = "CONFLICT";
  } else if (err.name === "ValidationError" || err.name === "CastError") {
    status = 400;
    message = "Invalid record values.";
    code = "VALIDATION_ERROR";
  } else if (!(err instanceof AppError)) {
    message =
      status === 400
        ? "Malformed request."
        : "The request could not be completed.";
  }
  res.status(status).json({ error: { message, code } });
});
