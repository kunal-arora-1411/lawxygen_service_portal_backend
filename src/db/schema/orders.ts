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
import { categories, fulfilmentTypeEnum, services } from "./catalogue.js";
import { users } from "./auth.js";

/**
 * A client's purchase of one service.
 *
 * The full lifecycle is declared here even though M1 only reaches `payment_pending`.
 * Adding a value to a PostgreSQL enum later is awkward inside a transaction, and the
 * states are already known from the delivery plan — there is nothing speculative about
 * writing down a sequence we have agreed.
 *
 * `payment_failed` is a distinct state that the client is *shown* as "payment pending".
 * Collapsing the two would lose the gateway error code support needs, and the retry
 * path differs. Keep the truth and the label separate.
 */
export const orderStatusEnum = pgEnum("order_status", [
  "payment_pending",
  "payment_failed",
  "paid",
  "awaiting_assignment",
  "assigned",
  "assignment_escalated",
  "in_progress",
  "awaiting_client",
  "completed",
  "cancelled",
  "refunded",
]);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human-facing, e.g. LX-000142. What support and the client both quote. */
    reference: text("reference").notNull(),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    /**
     * Restrict rather than cascade: an order is a financial record. A service being
     * retired from the catalogue must never delete the orders that bought it.
     */
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "restrict" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),

    /**
     * Snapshot of what was sold, at the moment it was sold.
     *
     * Not denormalisation for speed — correctness. Admin can reprice the catalogue at
     * any time, and an order that silently followed the new price would disagree with
     * the invoice, the ledger and what the client actually agreed to pay.
     */
    serviceSlug: text("service_slug").notNull(),
    categorySlug: text("category_slug").notNull(),
    serviceTitle: text("service_title").notNull(),
    fulfilmentType: fulfilmentTypeEnum("fulfilment_type").notNull(),
    pricePaise: bigint("price_paise", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("INR"),
    turnaroundDays: integer("turnaround_days"),

    status: orderStatusEnum("status").notNull().default("payment_pending"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("orders_reference_uq").on(t.reference),
    // The client dashboard's list: this user's orders, newest first.
    index("orders_user_created_idx").on(t.userId, t.createdAt),
    index("orders_status_idx").on(t.status, t.createdAt),
    check("orders_price_non_negative", sql`${t.pricePaise} >= 0`),
  ],
);

export const ordersRelations = relations(orders, ({ one }) => ({
  user: one(users, { fields: [orders.userId], references: [users.id] }),
  service: one(services, { fields: [orders.serviceId], references: [services.id] }),
  category: one(categories, { fields: [orders.categoryId], references: [categories.id] }),
}));

export type Order = typeof orders.$inferSelect;
export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
