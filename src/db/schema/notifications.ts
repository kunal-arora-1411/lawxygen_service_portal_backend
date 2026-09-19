import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { outboxEvents } from "./assignments.js";

/**
 * What we have told people, and what we have not.
 *
 * This table exists for one reason: the outbox re-runs **every** subscriber for an
 * event when any one of them fails. Without a record of what has already gone out, a
 * notification subscriber that succeeds alongside one that fails will send its message
 * again on the retry, and a client gets two receipts for one payment.
 *
 * `unique (event_id, kind)` is the guard. A subscriber claims the row before sending;
 * a claim that already exists and is `sent` means somebody else has done the work.
 *
 * A row that is `failed` is retried, deliberately reusing the same id as the
 * provider's idempotency key — so if the previous attempt actually reached the provider
 * before the connection dropped, the provider suppresses the duplicate rather than us
 * having to guess whether it arrived.
 */

export const notificationStatusEnum = pgEnum("notification_status", ["pending", "sent", "failed"]);

export const notificationChannelEnum = pgEnum("notification_channel", ["email", "sms"]);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * The event that caused it. Null is allowed for anything sent outside the outbox —
     * a password reset, say, which answers a request rather than a state change.
     */
    eventId: uuid("event_id").references(() => outboxEvents.id, { onDelete: "set null" }),

    /** e.g. `order.paid.receipt`. Two subscribers on one event need two kinds. */
    kind: text("kind").notNull(),
    channel: notificationChannelEnum("channel").notNull().default("email"),

    /** Kept so "did they ever get it, and where" is answerable from this table alone. */
    recipient: text("recipient").notNull(),
    subject: text("subject"),

    status: notificationStatusEnum("status").notNull().default("pending"),
    error: text("error"),
    attempts: text("attempts").notNull().default("0"),

    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The whole point of the table.
    uniqueIndex("notifications_event_kind_uq").on(t.eventId, t.kind),
    index("notifications_recipient_idx").on(t.recipient, t.createdAt),
    index("notifications_status_idx").on(t.status),
  ],
);

export type Notification = typeof notifications.$inferSelect;
