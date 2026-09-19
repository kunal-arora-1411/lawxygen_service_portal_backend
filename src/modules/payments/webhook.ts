import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { webhookEvents } from "../../db/schema/index.js";
import { isUniqueViolation } from "../../lib/db-errors.js";
import { logger } from "../../lib/logger.js";
import { applyCapture, applyFailure } from "./capture.js";
import { parseWebhook, type RazorpayWebhook } from "./razorpay.js";

/**
 * Handling a gateway webhook.
 *
 * The dedupe is on **processed**, not on **received** — and the difference is the whole
 * design.
 *
 * The obvious implementation inserts the event id, treats a unique violation as "seen
 * before", and returns 200. That silently drops every retry of an event whose first
 * attempt *failed*: the row exists, so the retry looks like a duplicate, and the
 * payment is never applied. The order stays unpaid while Razorpay's dashboard shows the
 * webhook delivered successfully.
 *
 * So: record on arrival with `processed_at` null, and only a row that already has a
 * `processed_at` is a true duplicate. Anything else is a retry we still owe work for.
 */

export type WebhookOutcome =
  | { status: "processed"; event: string }
  | { status: "duplicate"; event: string }
  | { status: "ignored"; event: string };

type Claim = { id: string; alreadyProcessed: boolean };

async function claimEvent(
  eventId: string,
  eventType: string,
  payload: unknown,
): Promise<Claim | null> {
  try {
    const [row] = await db
      .insert(webhookEvents)
      .values({ eventId, eventType, payload })
      .returning({ id: webhookEvents.id });
    return row ? { id: row.id, alreadyProcessed: false } : null;
  } catch (error) {
    if (!isUniqueViolation(error, "webhook_events_event_id_uq")) throw error;

    const [existing] = await db
      .select({ id: webhookEvents.id, processedAt: webhookEvents.processedAt })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.provider, "razorpay"), eq(webhookEvents.eventId, eventId)))
      .limit(1);

    if (!existing) return null;
    return { id: existing.id, alreadyProcessed: existing.processedAt !== null };
  }
}

/**
 * Applies one webhook.
 *
 * Signature verification happens in the route, before this is called. A throw here
 * leaves `processed_at` null and propagates, so the route answers 5xx and Razorpay
 * retries — which is what we want for a transient failure and harmless for a permanent
 * one, since the payload is stored either way.
 */
export async function handleWebhook(rawBody: Buffer, eventId: string): Promise<WebhookOutcome> {
  const body = parseWebhook(rawBody);

  const claim = await claimEvent(eventId, body.event, body);
  if (!claim) return { status: "ignored", event: body.event };
  if (claim.alreadyProcessed) return { status: "duplicate", event: body.event };

  try {
    await dispatch(body);
  } catch (error) {
    await db
      .update(webhookEvents)
      .set({ error: error instanceof Error ? error.message : String(error) })
      .where(eq(webhookEvents.id, claim.id));
    throw error;
  }

  // Only now is the event a duplicate for anything that arrives later. The guard on
  // `processed_at` being null keeps two concurrent deliveries from both marking it.
  await db
    .update(webhookEvents)
    .set({ processedAt: new Date(), error: null })
    .where(and(eq(webhookEvents.id, claim.id), isNull(webhookEvents.processedAt)));

  return { status: "processed", event: body.event };
}

async function dispatch(body: RazorpayWebhook): Promise<void> {
  const entity = body.payload.payment?.entity;

  switch (body.event) {
    case "payment.captured": {
      if (!entity?.id || !entity.order_id || typeof entity.amount !== "number") {
        logger.warn({ event: body.event }, "captured webhook missing payment fields");
        return;
      }
      const outcome = await applyCapture({
        providerPaymentId: entity.id,
        providerOrderId: entity.order_id,
        amountPaise: entity.amount,
        method: entity.method ?? null,
      });
      logger.info({ event: body.event, outcome }, "capture webhook applied");
      return;
    }

    case "payment.failed": {
      if (!entity?.order_id) {
        logger.warn({ event: body.event }, "failed webhook missing order id");
        return;
      }
      await applyFailure({
        providerOrderId: entity.order_id,
        providerPaymentId: entity.id ?? null,
        errorCode: entity.error_code ?? null,
        errorDescription: entity.error_description ?? null,
      });
      return;
    }

    default:
      // Razorpay sends more than this system subscribes to. Recording and ignoring
      // beats rejecting: the payload is kept, and turning one on later is a case here
      // rather than a hunt for what was missed.
      logger.debug({ event: body.event }, "webhook event not handled");
  }
}
