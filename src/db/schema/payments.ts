import { relations, sql } from "drizzle-orm";
import {
  bigint,
  check,
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

/**
 * Money in.
 *
 * The gateway **webhook** is the source of truth for whether a payment succeeded, never
 * the browser redirect. A redirect is a claim made by the client's browser; a signed
 * webhook is a statement by Razorpay. A client who closes the tab after paying must
 * still end up with a paid order, and a client who forges a redirect must not.
 */

export const paymentStatusEnum = pgEnum("payment_status", [
  "created",
  "authorized",
  "captured",
  "failed",
  "refunded",
]);

/**
 * Every webhook Razorpay has delivered, recorded before it is acted on.
 *
 * The unique index on `event_id` is the idempotency mechanism: Razorpay retries, and a
 * retry must be swallowed rather than replayed. An insert that raises 23505 here means
 * "already handled", which is the one place `isUniqueViolation` is expected rather than
 * exceptional.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull().default("razorpay"),
    /** Razorpay's `x-razorpay-event-id`. The dedupe key. */
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null until the event has been applied. Non-null means "done, do not repeat". */
    processedAt: timestamp("processed_at", { withTimezone: true }),
    /** Set when handling threw, so a failed event is visible rather than lost. */
    error: text("error"),
  },
  (t) => [
    uniqueIndex("webhook_events_event_id_uq").on(t.provider, t.eventId),
    index("webhook_events_unprocessed_idx")
      .on(t.receivedAt)
      .where(sql`${t.processedAt} IS NULL`),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),

    provider: text("provider").notNull().default("razorpay"),
    /** Razorpay order id (`order_...`), created server-side before checkout opens. */
    providerOrderId: text("provider_order_id").notNull(),
    /** Razorpay payment id (`pay_...`). Absent until an attempt is actually made. */
    providerPaymentId: text("provider_payment_id"),

    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("INR"),

    status: paymentStatusEnum("status").notNull().default("created"),
    method: text("method"),
    /** Kept for support: this is the difference between "declined" and "cancelled". */
    errorCode: text("error_code"),
    errorDescription: text("error_description"),

    capturedAt: timestamp("captured_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("payments_provider_order_uq").on(t.provider, t.providerOrderId),
    // Partial, because the id is null until an attempt happens — a plain unique index
    // would allow only one un-attempted payment in the whole table.
    uniqueIndex("payments_provider_payment_uq")
      .on(t.provider, t.providerPaymentId)
      .where(sql`${t.providerPaymentId} IS NOT NULL`),
    index("payments_order_idx").on(t.orderId),
    check("payments_amount_non_negative", sql`${t.amountPaise} >= 0`),
  ],
);

/**
 * Double-entry ledger.
 *
 * Money is recorded as balanced journal entries, not as mutable status columns on an
 * order. A status column answers "what is true now"; a ledger answers "how did we get
 * here", which is the question a reconciliation, a refund dispute or an auditor asks.
 *
 * Balance is enforced by a deferred constraint trigger (see the migration), checked at
 * commit rather than per statement — the lines of one entry are inserted separately and
 * are legitimately unbalanced in between.
 */
export const ledgerEntryKindEnum = pgEnum("ledger_entry_kind", [
  "capture",
  "refund",
  "payout",
  "adjustment",
]);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: ledgerEntryKindEnum("kind").notNull(),
    /**
     * What caused this entry, e.g. a Razorpay payment id. Unique per kind so the same
     * capture cannot be journalled twice even if the webhook guard is bypassed.
     */
    sourceRef: text("source_ref").notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    currency: text("currency").notNull().default("INR"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    memo: text("memo"),
  },
  (t) => [
    uniqueIndex("ledger_entries_kind_source_uq").on(t.kind, t.sourceRef),
    index("ledger_entries_order_idx").on(t.orderId),
    index("ledger_entries_occurred_idx").on(t.occurredAt),
  ],
);

export const ledgerDirectionEnum = pgEnum("ledger_direction", ["debit", "credit"]);

export const ledgerLines = pgTable(
  "ledger_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => ledgerEntries.id, { onDelete: "cascade" }),
    /**
     * Account code, e.g. `ASSET:GATEWAY_RECEIVABLE`, `INCOME:COMMISSION`,
     * `LIABILITY:PRO_PAYABLE`. Text rather than an enum on purpose: the chart of
     * accounts changes when the GST treatment is settled, and that must be a data
     * change rather than a migration.
     */
    account: text("account").notNull(),
    direction: ledgerDirectionEnum("direction").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    /** Who the line is about, when it is about someone — e.g. the professional. */
    subjectId: uuid("subject_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ledger_lines_entry_idx").on(t.entryId),
    index("ledger_lines_account_idx").on(t.account, t.createdAt),
    // Direction carries the sign. A negative amount would let the same movement be
    // written two ways and make every balance query ambiguous.
    check("ledger_lines_amount_positive", sql`${t.amountPaise} > 0`),
  ],
);

/**
 * GST invoices.
 *
 * Numbering is gapless within a financial year, which Indian GST requires. The number is
 * allocated from the `counters` table inside the capture transaction, so an abort rolls
 * it back rather than burning it — a PostgreSQL sequence would not, because `nextval`
 * is deliberately non-transactional.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),

    /** e.g. `LX/2026-27/000042`. */
    number: text("number").notNull(),
    /** Indian financial year, April to March, as `2026-27`. */
    financialYear: text("financial_year").notNull(),
    sequence: integer("sequence").notNull(),

    grossPaise: bigint("gross_paise", { mode: "number" }).notNull(),
    taxablePaise: bigint("taxable_paise", { mode: "number" }).notNull(),
    gstPaise: bigint("gst_paise", { mode: "number" }).notNull(),
    gstRateBps: integer("gst_rate_bps").notNull(),
    currency: text("currency").notNull().default("INR"),

    /** Two-digit state code. Decides CGST+SGST versus IGST. */
    placeOfSupply: text("place_of_supply"),
    supplierGstin: text("supplier_gstin"),
    buyerGstin: text("buyer_gstin"),
    /** Services Accounting Code for the supply. */
    sacCode: text("sac_code"),

    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_number_uq").on(t.number),
    // One invoice per order, and the series has no repeats within a year.
    uniqueIndex("invoices_order_uq").on(t.orderId),
    uniqueIndex("invoices_year_sequence_uq").on(t.financialYear, t.sequence),
    check("invoices_totals_balance", sql`${t.taxablePaise} + ${t.gstPaise} = ${t.grossPaise}`),
  ],
);

export const paymentsRelations = relations(payments, ({ one }) => ({
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
}));

export const ledgerEntriesRelations = relations(ledgerEntries, ({ many, one }) => ({
  lines: many(ledgerLines),
  order: one(orders, { fields: [ledgerEntries.orderId], references: [orders.id] }),
}));

export const ledgerLinesRelations = relations(ledgerLines, ({ one }) => ({
  entry: one(ledgerEntries, { fields: [ledgerLines.entryId], references: [ledgerEntries.id] }),
}));

export type Payment = typeof payments.$inferSelect;
export type PaymentStatus = (typeof paymentStatusEnum.enumValues)[number];
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type LedgerLine = typeof ledgerLines.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;

/**
 * Daily reconciliation.
 *
 * This is the only thing in the system that detects a webhook which never arrived at
 * all. Every other safeguard — signature checks, dedupe on processed, the atomic claim
 * — protects against a webhook that *did* arrive being mishandled. Nothing protects
 * against silence, because silence looks exactly like a quiet day.
 *
 * So a run asks the gateway what it thinks happened and compares it to what we
 * recorded. A capture we missed is repaired automatically, through the same code path
 * the webhook would have taken. Anything involving a discrepancy in an amount is
 * recorded and left alone: a mismatch is a question for a person, not something to
 * paper over.
 */
export const reconciliationRuns = pgTable(
  "reconciliation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),

    /** How many payments the gateway reported inside the window. */
    gatewayCount: integer("gateway_count").notNull().default(0),
    /** How many of those already matched a captured payment here. */
    matchedCount: integer("matched_count").notNull().default(0),
    /** Captures we had missed and have now applied. */
    repairedCount: integer("repaired_count").notNull().default(0),

    /**
     * Every discrepancy, as `{ kind, providerPaymentId, … }`. JSON rather than a table
     * because the shape differs per kind and nothing queries inside it — this is read
     * by a person looking at one run.
     */
    exceptions: jsonb("exceptions").notNull().default([]),

    /** Total debits minus total credits across the whole ledger. Must be zero. */
    ledgerImbalancePaise: bigint("ledger_imbalance_paise", { mode: "number" }).notNull().default(0),

    /** `clean` means nothing to look at; `exceptions` means somebody should. */
    status: text("status").notNull(),
    /** Set when the run itself could not complete — the gateway was unreachable. */
    failureReason: text("failure_reason"),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("reconciliation_runs_window_idx").on(t.windowStart),
    index("reconciliation_runs_started_idx").on(t.startedAt),
  ],
);

export type ReconciliationRun = typeof reconciliationRuns.$inferSelect;
