import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { assertDatabaseReachable } from "./db/client.js";
import { env } from "./lib/env.js";
import { errorHandler, handler, notFoundHandler } from "./lib/http.js";
import { logger } from "./lib/logger.js";
import { attachActor } from "./modules/auth/middleware.js";
import { authRoutes } from "./modules/auth/routes.js";
import { catalogueRoutes } from "./modules/catalogue/routes.js";
import { orderRoutes } from "./modules/orders/routes.js";
import { paymentRoutes, webhookRoutes } from "./modules/payments/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { adminWhatsappRoutes, professionalWhatsappRoutes } from "./modules/whatsapp/routes.js";
import { whatsappWebhookRoutes } from "./modules/whatsapp/webhook.js";
import { professionalRoutes } from "./modules/professionals/routes.js";
import { registerSubscribers } from "./modules/events/subscribers.js";

/**
 * Builds the application.
 *
 * `mountRoutes` runs after the middleware stack and before the terminal 404 and error
 * handlers. Express matches in registration order, so anything mounted after those two
 * is unreachable — every module registers through here rather than on the returned app.
 */
let subscribersRegistered = false;

export function createApp(mountRoutes?: (app: Express) => void): Express {
  // Once per process: the registry is module-level, and tests build several apps.
  if (!subscribersRegistered) {
    registerSubscribers();
    subscribersRegistered = true;
  }

  const app = express();

  // Behind a proxy in staging and production, so req.ip and secure-cookie detection
  // reflect the client rather than the load balancer.
  app.set("trust proxy", env.APP_ENV === "local" ? false : 1);
  app.disable("x-powered-by");

  app.use(helmet());

  // The portal is the only browser client. Credentials are on because the session
  // travels as an httpOnly cookie, and a wildcard origin is invalid with credentials.
  app.use(cors({ origin: env.PORTAL_ORIGIN, credentials: true }));

  /**
   * The gateway webhook needs the byte-for-byte body to verify its HMAC signature.
   * JSON re-serialised after parsing differs from what Razorpay signed — key order,
   * spacing, unicode escaping — so the signature would never match. Registered ahead
   * of the JSON parser, and scoped to this one path.
   */
  app.use("/webhooks", express.raw({ type: "*/*", limit: "1mb" }), webhookRoutes());
  /**
   * Before `express.json`, deliberately. Meta signs the exact bytes it sent, so the
   * signature can only be checked against a raw Buffer — a parsed and re-serialised
   * object fails on nothing worse than a different key order.
   */
  app.use(
    "/webhooks/whatsapp",
    express.raw({ type: "*/*", limit: "1mb" }),
    whatsappWebhookRoutes(),
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  // Permissive: resolves the session when there is one and does nothing when there is
  // not. Rejecting is the job of the route guards and of authorize() in the handler.
  app.use(attachActor);

  /**
   * Liveness. Deliberately does not touch the database: if it did, a brief database
   * blip would fail every instance's health check at once and take the fleet down for
   * an outage the application could otherwise have ridden out.
   */
  app.get(
    "/health",
    handler(() => ({ status: "ok", uptime: process.uptime() })),
  );

  /** Readiness. This one does check the database — it answers "should traffic come here". */
  app.get(
    "/health/ready",
    handler(async () => {
      await assertDatabaseReachable();
      return { status: "ready" };
    }),
  );

  app.use("/auth", authRoutes());
  app.use("/catalogue", catalogueRoutes());
  app.use("/orders", orderRoutes());
  app.use("/payments", paymentRoutes());
  app.use("/pro", professionalRoutes());
  app.use("/admin", adminRoutes());
  app.use("/admin/whatsapp", adminWhatsappRoutes());
  app.use("/pro/whatsapp", professionalWhatsappRoutes());

  mountRoutes?.(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
