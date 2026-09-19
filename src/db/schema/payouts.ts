import { relations, sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { professionals } from "./professionals.js";

/**
 * Money out.
 *
 * Razorpay **Route** — splitting each payment to the professional at capture — is not
 * used: it requires ₹40L+ turnover under the Sept-2025 RBI rules, which a launching
 * marketplace cannot show. So Lawxygen collects the whole amount and settles
 * periodically, which is what these tables record.
 *
 * The ledger already knows what each professional is owed. A batch is the operational
 * wrapper around paying it: who, how much, when, and what the bank said.
 */

export const payoutBatchStatusEnum = pgEnum("payout_batch_status", [
  "draft",
  "releasing",
  "released",
  "cancelled",
]);

export const payoutStatusEnum = pgEnum("payout_status", ["pending", "paid", "failed", "skipped"]);

export const payoutBatches = pgTable(
  "payout_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human-facing, e.g. PO-000007. What finance and a professional both quote. */
    reference: text("reference").notNull(),
    status: payoutBatchStatusEnum("status").notNull().default("draft"),

    /** Totals snapshotted when the batch was drafted, not recomputed on read. */
    totalPaise: bigint("total_paise", { mode: "number" }).notNull().default(0),
    payoutCount: integer("payout_count").notNull().default(0),

    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    releasedBy: uuid("released_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("payout_batches_reference_uq").on(t.reference),
    index("payout_batches_status_idx").on(t.status, t.createdAt),
    check("payout_batches_total_non_negative", sql`${t.totalPaise} >= 0`),
  ],
);

export const payouts = pgTable(
  "payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => payoutBatches.id, { onDelete: "restrict" }),
    professionalId: uuid("professional_id")
      .notNull()
      .references(() => professionals.id, { onDelete: "restrict" }),

    /**
     * What is actually transferred. Already net of withholding — TDS was deducted at
     * capture, so `LIABILITY:PRO_PAYABLE` has never included it.
     */
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("INR"),

    /**
     * Withholding covering the same earnings, recorded here rather than recomputed.
     *
     * Rates and even the governing section may change; a payout statement issued two
     * years from now has to say what was actually applied at the time, not what the
     * settings say today. This is the row a TDS certificate is produced from.
     */
    tdsPaise: bigint("tds_paise", { mode: "number" }).notNull().default(0),
    tdsSection: text("tds_section"),
    tdsRateBps: integer("tds_rate_bps"),

    status: payoutStatusEnum("status").notNull().default("pending"),
    /** The bank or gateway's own reference, for reconciliation and for disputes. */
    providerRef: text("provider_ref"),
    failureReason: text("failure_reason"),

    /** Snapshotted so a later bank-detail change cannot rewrite where money went. */
    accountLast4: text("account_last4"),

    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One payout per professional per batch: drafting twice must not double-pay.
    uniqueIndex("payouts_batch_professional_uq").on(t.batchId, t.professionalId),
    index("payouts_professional_idx").on(t.professionalId, t.createdAt),
    index("payouts_status_idx").on(t.status),
    check("payouts_amount_positive", sql`${t.amountPaise} > 0`),
  ],
);

export const payoutBatchesRelations = relations(payoutBatches, ({ many }) => ({
  payouts: many(payouts),
}));

export const payoutsRelations = relations(payouts, ({ one }) => ({
  batch: one(payoutBatches, { fields: [payouts.batchId], references: [payoutBatches.id] }),
  professional: one(professionals, {
    fields: [payouts.professionalId],
    references: [professionals.id],
  }),
}));

export type PayoutBatch = typeof payoutBatches.$inferSelect;
export type Payout = typeof payouts.$inferSelect;
export type PayoutStatus = (typeof payoutStatusEnum.enumValues)[number];
export type PayoutBatchStatus = (typeof payoutBatchStatusEnum.enumValues)[number];
