import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client.js";
import { invoices, orders, payments } from "../../db/schema/index.js";
import { ApiError, fail, ok } from "../../lib/api.js";
import { env } from "../../lib/env.js";
import { handler, parse, sendResult } from "../../lib/http.js";
import { logger } from "../../lib/logger.js";
import { ownsOrAdmin } from "../../lib/auth/policy.js";
import { actorOf, requireAuth } from "../auth/middleware.js";
import { createGatewayOrder, verifyWebhookSignature } from "./razorpay.js";
import { handleWebhook } from "./webhook.js";

const referenceSchema = z.object({
  reference: z
    .string()
    .trim()
    .regex(/^LX-\d{6,}$/, "Not an order reference."),
});

/**
 * Starting a payment.
 *
 * The gateway order is created server-side and the amount comes from the order's own
 * snapshot, never from the request body. A client-supplied amount is a client-chosen
 * price.
 */
export function paymentRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.post(
    "/:reference/intent",
    handler(async (req) => {
      const { reference } = parse(referenceSchema, req.params);
      const actor = actorOf(req);

      const [order] = await db
        .select({
          id: orders.id,
          userId: orders.userId,
          reference: orders.reference,
          status: orders.status,
          pricePaise: orders.pricePaise,
          currency: orders.currency,
        })
        .from(orders)
        .where(eq(orders.reference, reference))
        .limit(1);

      if (!order) throw new ApiError("not_found", "No such order.");
      // not_found rather than forbidden: references are sequential, and a 403 would
      // confirm this one exists.
      if (!ownsOrAdmin(actor, order.userId)) throw new ApiError("not_found", "No such order.");

      if (order.status !== "payment_pending" && order.status !== "payment_failed") {
        throw new ApiError("conflict", "This order has already been paid for.");
      }

      // Reuse the gateway order if one is already open for this order, so a client who
      // reloads checkout does not accumulate abandoned gateway orders.
      const [existing] = await db
        .select({ providerOrderId: payments.providerOrderId, amountPaise: payments.amountPaise })
        .from(payments)
        .where(eq(payments.orderId, order.id))
        .limit(1);

      if (existing && existing.amountPaise === order.pricePaise) {
        return {
          gatewayOrderId: existing.providerOrderId,
          amountPaise: order.pricePaise,
          currency: order.currency,
          keyId: env.RAZORPAY_KEY_ID ?? null,
        };
      }

      const gateway = await createGatewayOrder({
        amountPaise: order.pricePaise,
        currency: order.currency,
        receipt: order.reference,
        notes: { orderReference: order.reference },
      });

      await db.insert(payments).values({
        orderId: order.id,
        providerOrderId: gateway.id,
        amountPaise: order.pricePaise,
        currency: order.currency,
      });

      return {
        gatewayOrderId: gateway.id,
        amountPaise: order.pricePaise,
        currency: order.currency,
        keyId: env.RAZORPAY_KEY_ID ?? null,
      };
    }, 201),
  );

  router.get(
    "/:reference/invoice",
    handler(async (req) => {
      const { reference } = parse(referenceSchema, req.params);
      const actor = actorOf(req);

      const [row] = await db
        .select({
          userId: orders.userId,
          number: invoices.number,
          financialYear: invoices.financialYear,
          grossPaise: invoices.grossPaise,
          taxablePaise: invoices.taxablePaise,
          gstPaise: invoices.gstPaise,
          gstRateBps: invoices.gstRateBps,
          currency: invoices.currency,
          issuedAt: invoices.issuedAt,
        })
        .from(invoices)
        .innerJoin(orders, eq(orders.id, invoices.orderId))
        .where(eq(orders.reference, reference))
        .limit(1);

      if (!row) throw new ApiError("not_found", "No invoice for that order yet.");
      if (!ownsOrAdmin(actor, row.userId)) throw new ApiError("not_found", "No such order.");

      const { userId: _userId, ...invoice } = row;
      return invoice;
    }),
  );

  return router;
}

/**
 * The webhook, mounted separately.
 *
 * Not under `paymentRoutes` because it must not require a session — Razorpay has no
 * cookie — and because it needs the **raw** body for signature verification, which
 * means it is registered ahead of the JSON parser in `app.ts`.
 */
export function webhookRoutes(): Router {
  const router = Router();

  router.post("/razorpay", (req: Request, res, next) => {
    void (async () => {
      try {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
        const signature = req.get("x-razorpay-signature");

        if (!env.RAZORPAY_WEBHOOK_SECRET) {
          logger.error("razorpay webhook received but no secret is configured");
          sendResult(res, fail("upstream_failure", "Webhooks are not configured."));
          return;
        }

        // Verified before the body is parsed or stored. An unsigned request is not a
        // malformed webhook, it is not a webhook at all.
        if (!verifyWebhookSignature(raw, signature)) {
          logger.warn({ signature: Boolean(signature) }, "rejected webhook: bad signature");
          sendResult(res, fail("forbidden", "Invalid signature."));
          return;
        }

        const eventId = req.get("x-razorpay-event-id") ?? "";
        if (!eventId) {
          sendResult(res, fail("invalid_input", "Missing event id."));
          return;
        }

        const outcome = await handleWebhook(raw, eventId);
        // 200 for processed and duplicate alike: both mean "do not send this again".
        sendResult(res, ok(outcome));
      } catch (error) {
        // Anything uncaught leaves processed_at null, so Razorpay's retry will pick the
        // event up again rather than it being silently lost.
        next(error);
      }
    })();
  });

  return router;
}
