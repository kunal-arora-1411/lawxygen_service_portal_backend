import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  users,
  whatsappConversations,
  whatsappMessages,
  whatsappSendAttempts,
} from "../../db/schema/index.js";
import { isUniqueViolation } from "../../lib/db-errors.js";
import { logger } from "../../lib/logger.js";

/**
 * Messages arriving from clients.
 *
 * Persisted **before** the webhook is acknowledged, and deliberately independent of
 * any background worker. PingMe learned this one in production: if ingestion waits on
 * a queue, a worker that is restarting makes a customer message disappear, and the
 * reply window goes stale while the thread looks empty.
 *
 * Meta redelivers anything it does not think was acknowledged, so every write here has
 * to be idempotent. The unique index on `meta_message_id` is what provides that — a
 * redelivery hits the conflict and stops.
 */

type MetaValue = {
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: {
    id?: string;
    from?: string;
    timestamp?: string;
    type?: string;
    text?: { body?: string };
    [key: string]: unknown;
  }[];
  statuses?: {
    id?: string;
    status?: string;
    timestamp?: string;
    recipient_id?: string;
    biz_opaque_callback_data?: string;
    errors?: { title?: string; message?: string }[];
  }[];
};

function whenSent(timestamp: string | undefined): Date {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

/**
 * The readable part of a message.
 *
 * Only text and the two interactive replies have one. Media is kept whole in the
 * payload rather than guessed at — a caption is not the message.
 */
function readableBody(message: Record<string, unknown>): string | null {
  const type = typeof message.type === "string" ? message.type : "";
  if (type === "text") {
    return (message.text as { body?: string } | undefined)?.body ?? null;
  }
  if (type === "button") {
    return (message.button as { text?: string } | undefined)?.text ?? null;
  }
  if (type === "interactive") {
    const interactive = message.interactive as
      { button_reply?: { title?: string }; list_reply?: { title?: string } } | undefined;
    return interactive?.button_reply?.title ?? interactive?.list_reply?.title ?? null;
  }
  return null;
}

/**
 * Finds or opens the thread for a number pair.
 *
 * Keyed on `(phoneNumberId, contactPhone)` — the number as well as the contact —
 * because WhatsApp gives one thread per pair, and because a pool of numbers allocated
 * per matter then needs no migration.
 */
async function conversationFor(
  phoneNumberId: string,
  contactPhone: string,
  contactName: string | null,
): Promise<string> {
  const [existing] = await db
    .select({ id: whatsappConversations.id })
    .from(whatsappConversations)
    .where(
      sql`${whatsappConversations.phoneNumberId} = ${phoneNumberId}
          and ${whatsappConversations.contactPhone} = ${contactPhone}`,
    )
    .limit(1);

  if (existing) return existing.id;

  /**
   * Linked to a registered user only when the number matches. An inbound message from
   * a number nobody registered is still worth keeping — dropping it loses a real
   * contact — but guessing at the owner would show one client another's thread.
   */
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`regexp_replace(coalesce(${users.phone}, ''), '\\D', '', 'g') = ${contactPhone}`)
    .limit(1);

  const [created] = await db
    .insert(whatsappConversations)
    .values({
      phoneNumberId,
      contactPhone,
      contactName,
      userId: user?.id ?? null,
    })
    .onConflictDoNothing({
      target: [whatsappConversations.phoneNumberId, whatsappConversations.contactPhone],
    })
    .returning({ id: whatsappConversations.id });

  if (created) return created.id;

  // Lost a race with another webhook for the same pair. The row exists now.
  const [raced] = await db
    .select({ id: whatsappConversations.id })
    .from(whatsappConversations)
    .where(
      sql`${whatsappConversations.phoneNumberId} = ${phoneNumberId}
          and ${whatsappConversations.contactPhone} = ${contactPhone}`,
    )
    .limit(1);

  if (!raced) throw new Error("Could not open a WhatsApp conversation");
  return raced.id;
}

/** Stores inbound messages. Returns how many were new. */
export async function persistInbound(value: MetaValue): Promise<number> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return 0;

  let stored = 0;

  for (const message of value.messages ?? []) {
    const metaMessageId = message.id;
    if (!metaMessageId) continue;

    const contactPhone = String(message.from ?? "").replace(/\D/g, "");
    if (!contactPhone) continue;

    const profile = value.contacts?.find((c) => c.wa_id === message.from) ?? value.contacts?.[0];
    const contactName = profile?.profile?.name?.trim() ?? null;
    const occurredAt = whenSent(message.timestamp);

    const conversationId = await conversationFor(phoneNumberId, contactPhone, contactName);

    try {
      await db.transaction(async (tx) => {
        await tx.insert(whatsappMessages).values({
          conversationId,
          direction: "inbound",
          metaMessageId,
          type: typeof message.type === "string" ? message.type : "unknown",
          body: readableBody(message),
          payload: message,
          occurredAt,
        });

        await tx
          .update(whatsappConversations)
          .set({
            // The 24-hour window runs from here. Nothing Lawxygen sends moves it.
            lastInboundAt: occurredAt,
            lastMessageAt: occurredAt,
            unreadCount: sql`${whatsappConversations.unreadCount} + 1`,
            status: "open",
            resolvedAt: null,
            ...(contactName ? { contactName } : {}),
          })
          .where(eq(whatsappConversations.id, conversationId));
      });
      stored += 1;
    } catch (error) {
      // Meta redelivers anything it thinks went unacknowledged. Not an error.
      if (isUniqueViolation(error, "whatsapp_messages_meta_id_uq")) continue;
      throw error;
    }
  }

  return stored;
}

/**
 * Delivery reports.
 *
 * Correlated through `biz_opaque_callback_data`, which carries the send attempt's own
 * id out to Meta and back. Without it there would be no way to tie a status to the
 * attempt that caused it — the Meta message id is only known after the send succeeded,
 * which is exactly the case that sometimes fails.
 */
export async function persistStatuses(value: MetaValue): Promise<number> {
  let applied = 0;

  for (const status of value.statuses ?? []) {
    const state = status.status;
    if (!state) continue;

    const failure = status.errors?.[0];
    const reason = failure ? (failure.message ?? failure.title ?? null) : null;

    if (status.id) {
      await db
        .update(whatsappMessages)
        .set({ status: state, ...(reason ? { failedReason: reason } : {}) })
        .where(eq(whatsappMessages.metaMessageId, status.id));
    }

    const attemptId = status.biz_opaque_callback_data;
    if (attemptId) {
      /**
       * A `failed` status resolves the one case nothing else can: an attempt left as
       * `delivery_unknown` because the connection dropped. Meta saying it failed means
       * it never arrived, so the record can stop being ambiguous.
       */
      if (state === "failed") {
        await db
          .update(whatsappSendAttempts)
          .set({ status: "failed", lastError: reason ?? "Meta reported the message failed" })
          .where(eq(whatsappSendAttempts.id, attemptId));
      } else {
        await db
          .update(whatsappSendAttempts)
          .set({ status: "accepted", ...(status.id ? { metaMessageId: status.id } : {}) })
          .where(eq(whatsappSendAttempts.id, attemptId));
      }
    }

    applied += 1;
  }

  if (applied > 0) logger.debug({ applied }, "whatsapp delivery statuses applied");
  return applied;
}
