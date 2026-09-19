import { db } from "../../db/client.js";
import { auditLog, type NewAuditEntry } from "../../db/schema/index.js";
import type { Actor } from "./policy.js";

/**
 * Writes to the append-only audit log.
 *
 * `tx` exists so the audit row commits with the change it describes. An audit entry
 * written outside the transaction that made the change is a lie waiting to happen: the
 * change rolls back, the entry does not, and the log records something that never
 * occurred.
 *
 * `action` is the same dotted verb passed to `authorize()`, so what was checked and what
 * was recorded cannot drift apart.
 */

export type AuditInput = {
  actor?: Actor | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  /** Identifiers and reason codes only — never personal data. */
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
};

type Inserter = Pick<typeof db, "insert">;

function toRow(input: AuditInput): NewAuditEntry {
  return {
    actorUserId: input.actor?.userId ?? null,
    impersonatorId: input.actor?.impersonatorId ?? null,
    actorRole: input.actor?.role ?? null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    metadata: input.metadata ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  };
}

export async function recordAudit(input: AuditInput, tx?: Inserter): Promise<void> {
  await (tx ?? db).insert(auditLog).values(toRow(input));
}

export async function recordAuditBatch(inputs: AuditInput[], tx?: Inserter): Promise<void> {
  if (inputs.length === 0) return;
  await (tx ?? db).insert(auditLog).values(inputs.map((i) => toRow(i)));
}
