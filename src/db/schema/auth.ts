import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Identity and access.
 *
 * Role lives here, in the database, and is read on every request from the session row —
 * not baked into a JWT. A JWT role goes stale the moment an admin suspends an account and
 * cannot be revoked before it expires; a database role takes effect on the next request,
 * and "sign out everywhere" is a DELETE. The cost is one indexed lookup the session load
 * was already performing.
 *
 * Ported from the marketing repo's `db/schema/auth.ts`. Two deliberate changes, both
 * consequences of dropping Auth.js now that this is a standalone API:
 *
 *   - `oauth_accounts` replaces the Auth.js adapter's `accounts` table. The adapter's
 *     seven token columns existed for a library we no longer run and nothing reads them;
 *     we do not call Google APIs on the user's behalf, only identify them at sign-in.
 *   - `verification_tokens` stores a SHA-256 hash rather than the plaintext token. The
 *     adapter required plaintext; `password_reset_tokens` was already hashed in the
 *     original, and there is no reason for the two to differ.
 */

export const roleEnum = pgEnum("role", ["client", "professional", "admin", "superadmin"]);
export const userStatusEnum = pgEnum("user_status", ["active", "suspended", "deleted"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name"),
    email: text("email"),
    emailVerified: timestamp("email_verified", { withTimezone: true, mode: "date" }),
    image: text("image"),

    /** E.164, e.g. +919876543210. Nullable: OAuth users may never supply one. */
    phone: text("phone"),
    phoneVerified: timestamp("phone_verified", { withTimezone: true, mode: "date" }),

    /** argon2id. Null for accounts that only ever use OAuth or OTP. */
    passwordHash: text("password_hash"),

    /**
     * Consent to be messaged on WhatsApp, captured at registration.
     *
     * WhatsApp is Phase 2, but the consent is collected in v1 deliberately: Meta requires
     * opt-in, and gathering it later means re-contacting every existing user. The source
     * is recorded because a consent you cannot evidence is not a consent.
     */
    whatsappConsent: boolean("whatsapp_consent").notNull().default(false),
    whatsappConsentAt: timestamp("whatsapp_consent_at", { withTimezone: true }),
    whatsappConsentSource: text("whatsapp_consent_source"),

    role: roleEnum("role").notNull().default("client"),
    status: userStatusEnum("status").notNull().default("active"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Case-insensitive uniqueness on lower(email). A plain unique index would happily
    // accept Asha@x.com alongside asha@x.com, which are the same person to everyone
    // except the index. Partial, so the many NULL-email OTP accounts don't collide.
    uniqueIndex("users_email_lower_uq")
      .on(sql`lower(${t.email})`)
      .where(sql`${t.email} IS NOT NULL`),
    uniqueIndex("users_phone_uq")
      .on(t.phone)
      .where(sql`${t.phone} IS NOT NULL`),
    index("users_role_status_idx").on(t.role, t.status),
  ],
);

/**
 * Federated sign-in identities. One row per (provider, subject) the user has linked.
 *
 * No tokens are stored: we use the provider to establish who someone is at sign-in and
 * never act on their behalf afterwards. Storing refresh tokens we would never spend would
 * be a breach liability with no upside.
 */
export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** The provider's immutable subject identifier — not the email, which can change. */
    providerAccountId: text("provider_account_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index("oauth_accounts_user_idx").on(t.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the cookie value. The plaintext token never touches the database. */
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),

    /**
     * Set while an admin is impersonating this user. Every write made during the session
     * is attributed to both identities in the audit log, and payout and refund actions are
     * refused outright — see FORBIDDEN_WHILE_IMPERSONATING in lib/auth/policy.ts.
     */
    impersonatorId: uuid("impersonator_id").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expiry_idx").on(t.expiresAt)],
);

/** Email verification and magic-link style flows. Hashed, like every other token here. */
export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.tokenHash] })],
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the emailed token. The plaintext never touches the database. */
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("password_reset_user_idx").on(t.userId)],
);

export const otpPurposeEnum = pgEnum("otp_purpose", ["login", "phone_verification"]);

/**
 * Mobile OTP challenges.
 *
 * The code is stored hashed, attempts are counted, and the row carries its own expiry so
 * brute force is bounded by the row rather than by whatever the caller remembers to check.
 * Transactional SMS in India needs DLT-registered templates — see .env.example.
 */
export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone").notNull(),
    purpose: otpPurposeEnum("purpose").notNull().default("login"),
    /** SHA-256 of the 6-digit code. */
    codeHash: text("code_hash").notNull(),
    attempts: smallint("attempts").notNull().default(0),
    consumed: boolean("consumed").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    ip: text("ip"),
  },
  (t) => [index("otp_phone_idx").on(t.phone, t.createdAt), index("otp_expiry_idx").on(t.expiresAt)],
);

export const usersRelations = relations(users, ({ many }) => ({
  oauthAccounts: many(oauthAccounts),
  sessions: many(sessions),
}));

export const oauthAccountsRelations = relations(oauthAccounts, ({ one }) => ({
  user: one(users, { fields: [oauthAccounts.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export type Role = (typeof roleEnum.enumValues)[number];
export type UserStatus = (typeof userStatusEnum.enumValues)[number];
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
