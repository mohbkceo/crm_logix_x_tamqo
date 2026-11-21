import express, { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { AppError } from "../errors.js";
import { webhookConfig } from "../services/delivery/webhooks/webhookConfig.js";
import { verifyAbexWebhook } from "../services/delivery/webhooks/verifyAbexWebhook.js";
import { acceptWebhook } from "../services/delivery/webhooks/webhookInboxService.js";

export function createAbexWebhookRouter({
  accept = acceptWebhook,
  getConfig = webhookConfig,
} = {}) {
  const router = Router();
  router.use(
    rateLimit({
      windowMs: 60000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) =>
        res.status(429).json({
          error: {
            code: "WEBHOOK_RATE_LIMIT",
            message: "Too many webhook requests.",
            requestId: req.id,
          },
        }),
    }),
  );
  router.all("/", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return next(
        new AppError("Webhook requires POST.", 405, "WEBHOOK_METHOD_INVALID"),
      );
    }
    if (
      !req.is("application/json") ||
      (req.headers["content-encoding"] &&
        req.headers["content-encoding"] !== "identity")
    )
      return next(
        new AppError(
          "Webhook requires uncompressed application/json.",
          415,
          "WEBHOOK_CONTENT_TYPE_INVALID",
        ),
      );
    next();
  });
  router.post(
    "/",
    express.raw({ type: "application/json", limit: "150kb", inflate: false }),
    async (req, res) => {
      const config = getConfig();
      const verified = verifyAbexWebhook(req, config);
      try {
        const { duplicate } = await accept({
          body: req.body,
          verified,
          config,
        });
        res.status(200).json({ accepted: true, duplicate });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          "Webhook storage is temporarily unavailable.",
          503,
          "WEBHOOK_DEPENDENCY_UNAVAILABLE",
        );
      }
    },
  );
  // Body-parser errors use the same sanitized model; never expose body bytes.
  router.use((error, _req, _res, next) => {
    next(
      error instanceof AppError
        ? error
        : new AppError(
            "Webhook request could not be read.",
            error.status === 413 ? 413 : 400,
            "WEBHOOK_SCHEMA_INVALID",
          ),
    );
  });
  return router;
}

export const abexWebhookRoutes = createAbexWebhookRouter();
