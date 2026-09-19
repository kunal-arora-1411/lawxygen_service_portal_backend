import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { notifications, outboxEvents } from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";
import { sendEmail } from "../../lib/mailer.js";
import { subscribersFor } from "../events/outbox.js";

/**
 * Sending a notification once, and only once.
 *
 * The outbox re-runs **every** subscriber for an event when any one of them fails. A
 * notification subscriber that succeeded alongside one that did not will therefore be
 * asked to send again. Nothing else in the system defends against that, so this does.
 *
 * The sequence is: claim a row keyed on `(event_id, kind)`, send, mark sent. A claim
 * that already exists and is `sent` means the work is done and we stop. A claim that
 * exists and is `failed` is retried **with the same row id as the provider's
 * idempotency key** — so if the previous attempt actually reached the provider before
 * the connection dropped, the provider suppresses the duplicate. We never have to
 * guess whether a message we could not confirm actually went.
 *
 * A send that fails is logged and swallowed rather than thrown. An email nobody
 * received is bad; an email failure that re-runs the assignment subscriber and hands
 * the matter to a second professional is worse. The row is left `failed`, which is
 * where a retry sweep or a person should look.
 */

export type Deliverable = {
  eventId: string;
  /** Distinguishes two subscribers on the same event. e.g. `order.paid.receipt`. */
  kind: string;
  to: string | null;
  subject: string;
  html: string;
  text: string;
};

export async function deliver(input: Deliverable): Promise<void> {
  if (!input.to) {
    // No address is a data problem, not a delivery failure. Recorded so it is visible.
    logger.warn({ kind: input.kind, eventId: input.eventId }, "no recipient for notification");
    return;
  }

  const [claim] = await db
    .insert(notifications)
    .values({
      eventId: input.eventId,
      kind: input.kind,
      channel: "email",
      recipient: input.to,
      subject: input.subject,
      status: "pending",
    })
    .onConflictDoNothing({ target: [notifications.eventId, notifications.kind] })
    .returning({ id: notifications.id });

  let id = claim?.id;

  if (!id) {
    // Somebody claimed it before us. Only a previous *failure* is ours to retry.
    const [existing] = await db
      .select({ id: notifications.id, status: notifications.status })
      .from(notifications)
      .where(and(eq(notifications.eventId, input.eventId), eq(notifications.kind, input.kind)))
      .limit(1);

    if (!existing || existing.status === "sent") return;
    id = existing.id;
  }

  try {
    await sendEmail({
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      // The row id, deliberately stable across retries.
      idempotencyKey: id,
    });

    await db
      .update(notifications)
      .set({ status: "sent", sentAt: new Date(), error: null })
      .where(eq(notifications.id, id));

    logger.info({ kind: input.kind, to: input.to }, "notification sent");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(notifications)
      .set({ status: "failed", error: message })
      .where(eq(notifications.id, id));

    // Swallowed on purpose — see the note at the top of this file.
    logger.error({ err: error, kind: input.kind, to: input.to }, "notification failed");
  }
}

/**
 * Retrying what did not go.
 *
 * `deliver` swallows a send failure so that a mail provider being down cannot re-run
 * the assignment engine. The cost of that choice is that the outbox considers the
 * event handled and will never look at it again — so without this, a `failed` row sits
 * there forever and somebody simply never gets their receipt.
 *
 * Rather than storing the rendered message, this re-drives the original event through
 * its subscribers. The body is regenerated from current data, `deliver` is idempotent
 * on `(event_id, kind)`, and the retry reuses the same row and therefore the same
 * provider idempotency key. Anything that already succeeded is skipped.
 */
export async function retryFailedNotifications(limit = 50): Promise<number> {
  const stuck = await db
    .select({ eventId: notifications.eventId })
    .from(notifications)
    .where(eq(notifications.status, "failed"))
    .limit(limit);

  const eventIds = [...new Set(stuck.map((r) => r.eventId).filter((id): id is string => !!id))];
  if (eventIds.length === 0) return 0;

  let retried = 0;

  for (const eventId of eventIds) {
    const [event] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, eventId))
      .limit(1);

    if (!event) continue;

    for (const subscriber of subscribersFor(event.name)) {
      // Only the notification subscribers. Re-running `assign` here would try to hand
      // out a matter that already has an owner.
      if (!subscriber.name.startsWith("notify-")) continue;

      try {
        await subscriber.handle(event);
        retried += 1;
      } catch (error) {
        logger.error(
          { err: error, eventId, subscriber: subscriber.name },
          "notification retry failed",
        );
      }
    }
  }

  return retried;
}
