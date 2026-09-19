import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";

/**
 * Append-only record of privileged actions.
 *
 * Who, what, when, and the before and after state. Nothing in the application ever issues
 * an UPDATE or DELETE against this table; the admin console reads it and nothing more.
 *
 * Later milestones extend this by adding `action` values and resource types, never by
 * adding mutable columns — the value of the log is that a row means what it meant when
 * written.
 *
 * Note the two actor columns. `actorUserId` is the account that performed the action;
 * `impersonatorId` is the admin driving it, if any. Both are recorded so a support action
 * taken on a client's behalf is attributable to the human who actually took it.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    impersonatorId: uuid("impersonator_id").references(() => users.id, { onDelete: "set null" }),
    /** Denormalised so the entry still reads correctly after a role change. */
    actorRole: text("actor_role"),

    /** Dotted verb, e.g. "professional.verified", "payout.released", "session.revoked". */
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),

    before: jsonb("before"),
    after: jsonb("after"),

    /** Never personal data — identifiers and reason codes only. */
    metadata: jsonb("metadata"),

    ip: text("ip"),
    userAgent: text("user_agent"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_actor_idx").on(t.actorUserId, t.createdAt),
    index("audit_resource_idx").on(t.resourceType, t.resourceId, t.createdAt),
    index("audit_action_idx").on(t.action, t.createdAt),
    index("audit_created_idx").on(t.createdAt),
  ],
);

export type AuditEntry = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;
