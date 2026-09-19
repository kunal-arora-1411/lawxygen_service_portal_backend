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
import {
  createGatewayOrder,
  fetchGatewayPayment,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "./razorpay.js";
import { applyCapture } from "./capture.js";
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

  /**
   * The browser saying "I think that worked".
   *
   * The webhook remains the source of truth, and this endpoint does not weaken that.
   * What the browser hands back is a *hint*: a signed tuple proving Razorpay said
   * something, which is a good reason to go and ask the gateway what the payment's
   * state actually is. The answer to that question is what gets applied, through the
   * same `applyCapture` the webhook calls — so a forged or replayed confirm either
   * fails the signature, fails the ownership check, or applies exactly what the
   * webhook would have applied anyway.
   *
   * Why it exists at all, when the webhook would arrive on its own:
   *
   *   - A webhook takes seconds to tens of seconds. The client is staring at a screen
   *     for all of it, and "your payment is being confirmed" with no end in sight is
   *     how a paid client decides something went wrong and pays again.
   *   - In local development Razorpay cannot reach localhost, so without this there is
   *     no way to walk the real path end to end short of running a tunnel.
   *
   * It is not a fallback for a webhook that never arrives — a client who closes the
   * tab never calls this. That gap is reconciliation's, and remains so.
   */
  router.post(
    "/:reference/confirm",
    handler(async (req) => {
      const { reference } = parse(referenceSchema, req.params);
      const { paymentId, signature } = parse(
        z.object({
          paymentId: z.string().trim().min(4).max(64),
          signature: z.string().trim().min(16).max(256),
        }),
        req.body,
      );
      const actor = actorOf(req);

      const [row] = await db
        .select({
          userId: orders.userId,
          status: orders.status,
          pricePaise: orders.pricePaise,
          providerOrderId: payments.providerOrderId,
        })
        .from(orders)
        .innerJoin(payments, eq(payments.orderId, orders.id))
        .where(eq(orders.reference, reference))
        .limit(1);

      if (!row) throw new ApiError("not_found", "No such order.");
      if (!ownsOrAdmin(actor, row.userId)) throw new ApiError("not_found", "No such order.");

      // Already done — by the webhook, by reconciliation, or by an earlier confirm.
      if (row.status !== "payment_pending" && row.status !== "payment_failed") {
        return { status: "paid" as const, reference };
      }

      if (!row.providerOrderId) throw new ApiError("conflict", "No payment was started.");

      if (!verifyCheckoutSignature(row.providerOrderId, paymentId, signature)) {
        // Not "invalid_input": somebody posting an unsigned confirm is not a typo.
        logger.warn({ reference, paymentId }, "checkout confirm failed signature");
        throw new ApiError("forbidden", "That payment could not be verified.");
      }

      const remote = await fetchGatewayPayment(paymentId);
      if (!remote) throw new ApiError("not_found", "The gateway has no such payment.");

      /**
       * The signature proves Razorpay signed this pair for *some* order. These two
       * checks prove it is this one, for this amount. Without them a signed tuple from
       * a ₹100 order would confirm a ₹50,000 one.
       */
      if (remote.orderId !== row.providerOrderId) {
        throw new ApiError("conflict", "That payment belongs to a different order.");
      }
      if (remote.amountPaise !== row.pricePaise) {
        logger.error(
          { reference, expected: row.pricePaise, actual: remote.amountPaise },
          "confirm amount does not match the order",
        );
        throw new ApiError("conflict", "That payment is for a different amount.");
      }

      if (remote.status !== "captured") {
        // Authorised but not yet captured is a normal intermediate state. The webhook
        // will finish it; saying "pending" is the honest answer, not an error.
        return { status: "pending" as const, reference };
      }

      const outcome = await applyCapture({
        providerPaymentId: remote.id,
        providerOrderId: row.providerOrderId,
        amountPaise: remote.amountPaise,
        method: remote.method,
      });

      return {
        status: "paid" as const,
        reference,
        invoiceNumber: outcome.applied ? outcome.invoiceNumber : null,
      };
    }),
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
