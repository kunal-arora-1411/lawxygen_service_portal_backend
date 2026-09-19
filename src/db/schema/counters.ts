import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Named monotonic counters.
 *
 * A table rather than a PostgreSQL sequence, because a sequence deliberately does *not*
 * roll back — `nextval` is non-transactional, so an aborted transaction burns a number.
 * That is the right trade for a surrogate key and the wrong one for an invoice number,
 * where Indian GST requires the series to be gapless.
 *
 * Order references use this now; GST invoice numbering in M2 uses the same mechanism,
 * which is the reason it is a shared helper rather than inlined.
 *
 * The cost is that every allocation for a given name serialises on one row. That is
 * accepted deliberately: it is exactly the property that makes the series gapless, and
 * the usual fix — sharded counters — would destroy it.
 */
export const counters = pgTable("counters", {
  /** e.g. `order_reference`, or `invoice:2026-27` once invoices exist. */
  name: text("name").primaryKey(),
  value: bigint("value", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Counter = typeof counters.$inferSelect;
