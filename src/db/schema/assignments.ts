import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orders } from "./orders.js";
import { professionals } from "./professionals.js";

/**
 * Matching a paid order to a professional.
 */

export const assignmentStatusEnum = pgEnum("assignment_status", [
  "assigned",
  "acknowledged",
  "in_progress",
  "awaiting_client",
  "completed",
  "declined",
  "revoked",
  "escalated",
]);

/** Statuses that occupy one of a professional's concurrent slots. */
export const OPEN_ASSIGNMENT_STATUSES = [
  "assigned",
  "acknowledged",
  "in_progress",
  "awaiting_client",
] as const;

export const assignments = pgTable(
  "assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    professionalId: uuid("professional_id")
      .notNull()
      .references(() => professionals.id, { onDelete: "restrict" }),

    status: assignmentStatusEnum("status").notNull().default("assigned"),

    /**
     * When acknowledgement stops being timely.
     *
     * Indexed and swept, rather than scheduled per assignment: a timer held in a
     * process disappears when the process restarts, and a paid matter silently sitting
     * unacknowledged is the failure this exists to catch.
     */
    acknowledgeBy: timestamp("acknowledge_by", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),

    /** Which attempt this is for the order — 1 for the first, higher after reassignment. */
    attempt: integer("attempt").notNull().default(1),
    /** Set when admin reassigns, so the reason survives the reassignment. */
    closedReason: text("closed_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * At most one open assignment per order.
     *
     * The partial unique index is what makes double-assignment impossible rather than
     * merely unlikely — two racing assigners cannot both produce an open row for the
     * same order, whatever the application does.
     */
    uniqueIndex("assignments_one_open_per_order_uq")
      .on(t.orderId)
      .where(sql`${t.status} IN ('assigned', 'acknowledged', 'in_progress', 'awaiting_client')`),
    index("assignments_professional_idx").on(t.professionalId, t.status),
    index("assignments_order_idx").on(t.orderId),
    // The escalation sweep: unacknowledged and past its deadline.
    index("assignments_overdue_idx")
      .on(t.acknowledgeBy)
      .where(sql`${t.status} = 'assigned'`),
  ],
);

/**
 * Domain events, written in the same transaction as the change they describe.
 *
 * The outbox exists so that work which must happen *because* of a state change cannot
 * be lost when that change commits — and, just as importantly, cannot roll the change
 * back when it fails. A capture must never fail because no professional was available;
 * the money arrived either way.
 *
 * It is also the seam WhatsApp attaches to in Phase 2: a new subscriber, touching none
 * of the code that emits.
 */
export const outboxStatusEnum = pgEnum("outbox_status", [
  "pending",
  "dispatching",
  "dispatched",
  "dead",
]);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload"),

    /**
     * Guards against the same event being emitted twice across separate invocations —
     * a reconciliation backfill re-driving a capture, an admin replaying an event.
     * Those arrive months apart and would otherwise re-notify about an old order.
     */
    dedupeKey: text("dedupe_key").notNull(),

    status: outboxStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("outbox_dedupe_uq").on(t.dedupeKey),
    // The dispatcher's claim: equality on status, then an index-provided sort.
    index("outbox_claim_idx").on(t.status, t.nextAttemptAt),
    index("outbox_aggregate_idx").on(t.aggregateType, t.aggregateId),
  ],
);

export const assignmentsRelations = relations(assignments, ({ one }) => ({
  order: one(orders, { fields: [assignments.orderId], references: [orders.id] }),
  professional: one(professionals, {
    fields: [assignments.professionalId],
    references: [professionals.id],
  }),
}));

export type Assignment = typeof assignments.$inferSelect;
export type AssignmentStatus = (typeof assignmentStatusEnum.enumValues)[number];
export type OutboxEvent = typeof outboxEvents.$inferSelect;

/** Kept here so the audit log and the outbox cannot drift on spelling. */
export const DOMAIN_EVENTS = {
  ORDER_PAID: "order.paid",
  ASSIGNMENT_REQUESTED: "order.assignment_requested",
  ASSIGNMENT_CREATED: "assignment.created",
  ASSIGNMENT_DEFERRED: "order.assignment_deferred",
  ASSIGNMENT_ACKNOWLEDGED: "assignment.acknowledged",
  ORDER_STATUS_CHANGED: "order.status_changed",
  ASSIGNMENT_ESCALATED: "assignment.escalated",
  ASSIGNMENT_REVOKED: "assignment.revoked",
  PROFESSIONAL_APPROVED: "professional.approved",
  ORDER_REFUNDED: "order.refunded",
  PAYOUT_RELEASED: "payout.released",
  PROFESSIONAL_AVAILABLE: "professional.availability_changed",
} as const;

export type DomainEventName = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];
