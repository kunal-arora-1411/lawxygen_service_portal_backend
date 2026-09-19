import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { assignments, DOMAIN_EVENTS, orders } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { logger } from "../../lib/logger.js";
import { emit } from "../events/outbox.js";

/**
 * Flagging matters a professional has not picked up.
 *
 * A sweep over an indexed deadline column, not a timer per assignment. An in-process
 * timer dies with the process, and the failure it was guarding — a paid matter sitting
 * untouched — is exactly the one nobody notices on their own.
 *
 * Escalating does not reassign automatically. Admin decides: the professional may be
 * mid-conversation with the client off-platform, and silently moving the matter would
 * produce two people working one job.
 */
export async function escalateOverdueAssignments(limit = 100): Promise<number> {
  const overdue = await db
    .select({
      id: assignments.id,
      orderId: assignments.orderId,
      professionalId: assignments.professionalId,
      reference: orders.reference,
    })
    .from(assignments)
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .where(and(eq(assignments.status, "assigned"), lte(assignments.acknowledgeBy, new Date())))
    .limit(limit);

  let escalated = 0;

  for (const row of overdue) {
    await db.transaction(async (tx) => {
      // Guarded: the professional may have acknowledged between the read and here.
      const [claimed] = await tx
        .update(assignments)
        .set({ status: "escalated", closedReason: "not_acknowledged_in_time" })
        .where(and(eq(assignments.id, row.id), eq(assignments.status, "assigned")))
        .returning({ id: assignments.id });

      if (!claimed) return;

      // The order goes back to a state admin can act on. The client is shown
      // "matching you with a professional" throughout — they should never see the
      // platform's internal difficulty staffing their matter.
      await tx
        .update(orders)
        .set({ status: "assignment_escalated" })
        .where(and(eq(orders.id, row.orderId), eq(orders.status, "assigned")));

      await emit(tx, {
        name: DOMAIN_EVENTS.ASSIGNMENT_ESCALATED,
        aggregateType: "assignment",
        aggregateId: row.id,
        payload: {
          orderId: row.orderId,
          reference: row.reference,
          professionalId: row.professionalId,
        },
      });

      await recordAudit(
        {
          action: "assignment.escalated",
          resourceType: "order",
          resourceId: row.reference,
          metadata: { assignmentId: row.id, reason: "not_acknowledged_in_time" },
        },
        tx,
      );

      escalated += 1;
    });
  }

  if (escalated > 0) logger.warn({ escalated }, "assignments escalated for non-acknowledgement");
  return escalated;
}

/** Counts what admin would see in the queue right now. */
export async function assignmentQueueDepth(): Promise<{ awaiting: number; escalated: number }> {
  const [row] = await db
    .select({
      awaiting: sql<number>`count(*) filter (where ${orders.status} = 'awaiting_assignment')::int`,
      escalated: sql<number>`count(*) filter (where ${orders.status} = 'assignment_escalated')::int`,
    })
    .from(orders);

  return { awaiting: row?.awaiting ?? 0, escalated: row?.escalated ?? 0 };
}
