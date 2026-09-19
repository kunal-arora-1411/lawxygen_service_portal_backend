import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { categories } from "./catalogue.js";

/**
 * The supply side.
 *
 * A professional is an independent CA, CS or advocate. They are a `users` row with a
 * `professional` role plus this record — identity and access stay in one place, and a
 * professional who is also a client does not need two accounts.
 */

export const professionalStatusEnum = pgEnum("professional_status", [
  "draft",
  "pending_review",
  "verified",
  "suspended",
  "rejected",
]);

export const professionalKindEnum = pgEnum("professional_kind", [
  "chartered_accountant",
  "company_secretary",
  "advocate",
]);

export const professionals = pgTable(
  "professionals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    kind: professionalKindEnum("kind").notNull(),
    displayName: text("display_name").notNull(),
    headline: text("headline"),
    city: text("city"),

    status: professionalStatusEnum("status").notNull().default("draft"),
    /** Set by the professional. Independent of `status`, which is admin's. */
    available: boolean("available").notNull().default(false),

    /**
     * How many open matters this professional will hold at once.
     *
     * Assignment is automatic, so without a cap the least-loaded professional absorbs
     * every order that arrives while others are briefly busier.
     */
    concurrentCapacity: integer("concurrent_capacity").notNull().default(5),

    /** Round-robin tiebreaker, so equal load does not always pick the same person. */
    lastAssignedAt: timestamp("last_assigned_at", { withTimezone: true }),

    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("professionals_user_uq").on(t.userId),
    // The eligibility query: verified and available, ordered by who was assigned least
    // recently. Partial, because only these rows are ever candidates.
    index("professionals_assignable_idx")
      .on(t.lastAssignedAt)
      .where(sql`${t.status} = 'verified' AND ${t.available}`),
    index("professionals_status_idx").on(t.status),
    check("professionals_capacity_positive", sql`${t.concurrentCapacity} > 0`),
  ],
);

/** Which categories a professional may be assigned work from. */
export const professionalCategories = pgTable(
  "professional_categories",
  {
    professionalId: uuid("professional_id")
      .notNull()
      .references(() => professionals.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.professionalId, t.categoryId] }),
    index("professional_categories_category_idx").on(t.categoryId),
  ],
);

export const credentialStatusEnum = pgEnum("credential_status", [
  "submitted",
  "verified",
  "rejected",
]);

/**
 * Bar Council / ICAI / ICSI registration numbers and their supporting documents.
 *
 * The number is stored in the clear because admin has to read it to check it against a
 * public register. The document itself is a storage key, not the file.
 */
export const professionalCredentials = pgTable(
  "professional_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    professionalId: uuid("professional_id")
      .notNull()
      .references(() => professionals.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    registrationNumber: text("registration_number").notNull(),
    documentKey: text("document_key"),
    status: credentialStatusEnum("status").notNull().default("submitted"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("professional_credentials_pro_idx").on(t.professionalId, t.status)],
);

/**
 * Bank and tax identity, for payouts.
 *
 * **Encrypted at field level**, not merely at rest. Disk encryption protects a stolen
 * drive; it does nothing about a SQL injection, a leaked read-replica credential or a
 * backup copied to somewhere it should not be. PAN and an account number are the two
 * things worth the most to whoever gets them.
 *
 * The last four digits of the account are kept in the clear so the UI and support can
 * identify an account without decrypting anything.
 */
export const payoutIdentities = pgTable(
  "payout_identities",
  {
    professionalId: uuid("professional_id")
      .primaryKey()
      .references(() => professionals.id, { onDelete: "cascade" }),

    panEncrypted: text("pan_encrypted").notNull(),
    gstinEncrypted: text("gstin_encrypted"),
    accountNumberEncrypted: text("account_number_encrypted").notNull(),
    ifsc: text("ifsc").notNull(),
    accountHolderName: text("account_holder_name").notNull(),
    accountLast4: text("account_last4").notNull(),

    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [check("payout_last4_shape", sql`${t.accountLast4} ~ '^[0-9]{4}$'`)],
);

export const professionalsRelations = relations(professionals, ({ one, many }) => ({
  user: one(users, { fields: [professionals.userId], references: [users.id] }),
  categories: many(professionalCategories),
  credentials: many(professionalCredentials),
  /**
   * Note: Drizzle infers a `one()` relation's nullability from the foreign key column,
   * not from whether the row exists — so this reads as non-nullable and is `undefined`
   * at runtime for a professional who has not completed payout onboarding. That state
   * is real, and the eligibility query filters it by hand rather than trusting the type.
   */
  payoutIdentity: one(payoutIdentities, {
    fields: [professionals.id],
    references: [payoutIdentities.professionalId],
  }),
}));

export const professionalCategoriesRelations = relations(professionalCategories, ({ one }) => ({
  professional: one(professionals, {
    fields: [professionalCategories.professionalId],
    references: [professionals.id],
  }),
  category: one(categories, {
    fields: [professionalCategories.categoryId],
    references: [categories.id],
  }),
}));

export type Professional = typeof professionals.$inferSelect;
export type ProfessionalStatus = (typeof professionalStatusEnum.enumValues)[number];
export type ProfessionalKind = (typeof professionalKindEnum.enumValues)[number];
export type PayoutIdentity = typeof payoutIdentities.$inferSelect;
