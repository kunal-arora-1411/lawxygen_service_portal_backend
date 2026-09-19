import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  assignments,
  DOMAIN_EVENTS,
  ledgerLines,
  OPEN_ASSIGNMENT_STATUSES,
  orders,
  professionals,
  users,
  type AssignmentStatus,
  type ProfessionalStatus,
  type OrderStatus,
} from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { authorize, type Actor } from "../../lib/auth/policy.js";
import { emit } from "../events/outbox.js";
import { ACCOUNTS } from "../payments/ledger.js";

/** A professional's own view of their work. */

async function professionalFor(actor: Actor): Promise<{ id: string; displayName: string }> {
  const [row] = await db
    .select({ id: professionals.id, displayName: professionals.displayName })
    .from(professionals)
    .where(eq(professionals.userId, actor.userId))
    .limit(1);

  if (!row) throw new ApiError("forbidden", "This account is not a professional.");
  return row;
}

export type MatterView = {
  assignmentId: string;
  status: AssignmentStatus;
  reference: string;
  serviceTitle: string;
  categorySlug: string;
  acknowledgeBy: Date | null;
  acknowledgedAt: Date | null;
  createdAt: Date;
  /**
   * Decided by the database's clock — the same one the escalation sweep uses — rather
   * than by the page comparing against `Date.now()` while rendering. That comparison
   * is impure and can disagree between the server render and a later client one.
   */
  acknowledgeOverdue: boolean;
  /** Contact details, released only once the matter is theirs. */
  client: { name: string | null; email: string | null; phone: string | null } | null;
};

export async function listMatters(actor: Actor, openOnly = false): Promise<MatterView[]> {
  authorize(actor, "assignment.list", { minimumRole: "professional" });
  const professional = await professionalFor(actor);

  const rows = await db
    .select({
      assignmentId: assignments.id,
      status: assignments.status,
      reference: orders.reference,
      serviceTitle: orders.serviceTitle,
      categorySlug: orders.categorySlug,
      acknowledgeBy: assignments.acknowledgeBy,
      acknowledgedAt: assignments.acknowledgedAt,
      createdAt: assignments.createdAt,
      acknowledgeOverdue: sql<boolean>`coalesce(
        ${assignments.status} = 'assigned' and ${assignments.acknowledgeBy} < now(), false
      )`,
      clientName: users.name,
      clientEmail: users.email,
      clientPhone: users.phone,
    })
    .from(assignments)
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .innerJoin(users, eq(users.id, orders.userId))
    .where(
      openOnly
        ? and(
            eq(assignments.professionalId, professional.id),
            inArray(assignments.status, [...OPEN_ASSIGNMENT_STATUSES]),
          )
        : eq(assignments.professionalId, professional.id),
    )
    .orderBy(desc(assignments.createdAt));

  return rows.map((row) => ({
    assignmentId: row.assignmentId,
    status: row.status,
    reference: row.reference,
    serviceTitle: row.serviceTitle,
    categorySlug: row.categorySlug,
    acknowledgeBy: row.acknowledgeBy,
    acknowledgedAt: row.acknowledgedAt,
    createdAt: row.createdAt,
    acknowledgeOverdue: row.acknowledgeOverdue,
    client: { name: row.clientName, email: row.clientEmail, phone: row.clientPhone },
  }));
}

/**
 * Confirms the matter is picked up.
 *
 * Guarded on `assigned`, so acknowledging a matter that was escalated out from under
 * the professional does nothing — the escalation already moved it, and letting a late
 * acknowledgement resurrect it would leave admin reassigning work someone has started.
 */
export async function acknowledge(
  actor: Actor,
  assignmentId: string,
): Promise<{ reference: string }> {
  authorize(actor, "assignment.acknowledge", { minimumRole: "professional" });
  const professional = await professionalFor(actor);

  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(assignments)
      .set({ status: "acknowledged", acknowledgedAt: new Date() })
      .where(
        and(
          eq(assignments.id, assignmentId),
          eq(assignments.professionalId, professional.id),
          eq(assignments.status, "assigned"),
        ),
      )
      .returning({ orderId: assignments.orderId });

    if (!claimed) {
      throw new ApiError("conflict", "That matter is no longer waiting to be acknowledged.");
    }

    const [order] = await tx
      .update(orders)
      .set({ status: "in_progress" })
      .where(and(eq(orders.id, claimed.orderId), eq(orders.status, "assigned")))
      .returning({ reference: orders.reference });

    const reference = order?.reference ?? "";

    await emit(tx, {
      name: DOMAIN_EVENTS.ASSIGNMENT_ACKNOWLEDGED,
      aggregateType: "assignment",
      aggregateId: assignmentId,
      payload: { reference, professionalId: professional.id },
    });

    await recordAudit(
      {
        actor,
        action: "assignment.acknowledged",
        resourceType: "order",
        resourceId: reference,
        metadata: { assignmentId },
      },
      tx,
    );

    return { reference };
  });
}

/**
 * Turning availability on or off.
 *
 * Going unavailable does not release matters already held — those are commitments.
 * Coming back on emits an event that drains the queue of orders parked for want of
 * supply, so someone waiting is matched immediately rather than on the next tick.
 */
export async function setAvailability(
  actor: Actor,
  available: boolean,
): Promise<{ available: boolean }> {
  authorize(actor, "professional.availability", { minimumRole: "professional" });
  const professional = await professionalFor(actor);

  await db.transaction(async (tx) => {
    await tx.update(professionals).set({ available }).where(eq(professionals.id, professional.id));

    if (available) {
      await emit(tx, {
        name: DOMAIN_EVENTS.PROFESSIONAL_AVAILABLE,
        aggregateType: "professional",
        aggregateId: professional.id,
        // Availability flips repeatedly, so each change needs its own key.
        dedupeKey: `${DOMAIN_EVENTS.PROFESSIONAL_AVAILABLE}:${professional.id}:${String(Date.now())}`,
      });
    }

    await recordAudit(
      {
        actor,
        action: "professional.availability",
        resourceType: "professional",
        resourceId: professional.id,
        after: { available },
      },
      tx,
    );
  });

  return { available };
}

/**
 * Slots in use, and whether they are accepting more.
 *
 * `available` belongs here rather than being read from the admin professional list —
 * that endpoint is admin-only, so a professional asking about themselves would get a
 * 403 and the UI would fall back to a guess about their own state.
 */
export async function currentLoad(
  actor: Actor,
): Promise<{ open: number; capacity: number; available: boolean; status: ProfessionalStatus }> {
  const professional = await professionalFor(actor);

  const [row] = await db
    .select({
      capacity: professionals.concurrentCapacity,
      available: professionals.available,
      status: professionals.status,
    })
    .from(professionals)
    .where(eq(professionals.id, professional.id))
    .limit(1);

  const open = await db
    .select({ id: assignments.id })
    .from(assignments)
    .where(
      and(
        eq(assignments.professionalId, professional.id),
        inArray(assignments.status, [...OPEN_ASSIGNMENT_STATUSES]),
      ),
    );

  return {
    open: open.length,
    capacity: row?.capacity ?? 0,
    available: row?.available ?? false,
    status: row?.status ?? "draft",
  };
}

/**
 * Moving a matter along.
 *
 * Only the professional holding it may move it, and only between states that make
 * sense — guarded in the UPDATE filter, so a stale tab cannot drag a completed matter
 * backwards. The order's status follows the assignment's, because those are the same
 * fact seen from two sides.
 */
const MATTER_TRANSITIONS: Record<string, { from: AssignmentStatus[]; order: OrderStatus }> = {
  in_progress: { from: ["acknowledged", "awaiting_client"], order: "in_progress" },
  awaiting_client: { from: ["acknowledged", "in_progress"], order: "awaiting_client" },
  completed: { from: ["acknowledged", "in_progress", "awaiting_client"], order: "completed" },
};

export async function advanceMatter(
  actor: Actor,
  assignmentId: string,
  to: "in_progress" | "awaiting_client" | "completed",
): Promise<{ status: AssignmentStatus }> {
  authorize(actor, "assignment.update", { minimumRole: "professional" });
  const professional = await professionalFor(actor);

  const transition = MATTER_TRANSITIONS[to];
  if (!transition) throw new ApiError("invalid_input", "Not a state a matter can move to.");

  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(assignments)
      .set({
        status: to,
        ...(to === "completed" ? { completedAt: new Date() } : {}),
      })
      .where(
        and(
          eq(assignments.id, assignmentId),
          eq(assignments.professionalId, professional.id),
          inArray(assignments.status, transition.from),
        ),
      )
      .returning({ orderId: assignments.orderId, status: assignments.status });

    if (!claimed) {
      throw new ApiError("conflict", "That matter is not in a state that can move there.");
    }

    const [order] = await tx
      .update(orders)
      .set({ status: transition.order })
      .where(eq(orders.id, claimed.orderId))
      .returning({ reference: orders.reference });

    await emit(tx, {
      name: DOMAIN_EVENTS.ORDER_STATUS_CHANGED,
      aggregateType: "order",
      aggregateId: claimed.orderId,
      payload: { reference: order?.reference ?? "", status: transition.order },
      // A matter legitimately moves between states more than once, so each change
      // needs its own key rather than being swallowed as a repeat.
      dedupeKey: `${DOMAIN_EVENTS.ORDER_STATUS_CHANGED}:${assignmentId}:${to}:${String(Date.now())}`,
    });

    await recordAudit(
      {
        actor,
        action: "assignment.status_changed",
        resourceType: "order",
        resourceId: order?.reference ?? claimed.orderId,
        after: { status: to },
        metadata: { assignmentId },
      },
      tx,
    );

    return { status: claimed.status };
  });
}

export type Earnings = {
  /** Attributed to this professional and not yet paid out. */
  pendingPaise: number;
  /** Already released in a payout run. Zero until payouts exist. */
  paidPaise: number;
  matters: { completed: number; open: number };
};

/**
 * What this professional is owed, read from the ledger.
 *
 * Not derived from assignments and prices: the payout run reads the ledger, so an
 * earnings statement computed any other way would be a second source of truth for
 * money and the two would eventually disagree in front of the person being paid.
 *
 * The balance is credits minus debits against `LIABILITY:PRO_PAYABLE` for this
 * subject — a liability, so a credit increases what is owed. The assignment posts the
 * credit; a payout will post the matching debit.
 */
export async function earningsFor(actor: Actor): Promise<Earnings> {
  authorize(actor, "earnings.read", { minimumRole: "professional" });
  const professional = await professionalFor(actor);

  const [balance] = await db
    .select({
      pending: sql<number>`coalesce(sum(case when ${ledgerLines.direction} = 'credit'
                                             then ${ledgerLines.amountPaise}
                                             else -${ledgerLines.amountPaise} end), 0)::bigint`,
      paid: sql<number>`coalesce(sum(case when ${ledgerLines.direction} = 'debit'
                                          then ${ledgerLines.amountPaise} else 0 end), 0)::bigint`,
    })
    .from(ledgerLines)
    .where(
      and(
        eq(ledgerLines.account, ACCOUNTS.PRO_PAYABLE),
        eq(ledgerLines.subjectId, professional.id),
      ),
    );

  const [counts] = await db
    .select({
      completed: sql<number>`count(*) filter (where ${assignments.status} = 'completed')::int`,
      open: sql<number>`count(*) filter (
        where ${assignments.status} in ('assigned','acknowledged','in_progress','awaiting_client')
      )::int`,
    })
    .from(assignments)
    .where(eq(assignments.professionalId, professional.id));

  return {
    pendingPaise: Number(balance?.pending ?? 0),
    paidPaise: Number(balance?.paid ?? 0),
    matters: { completed: counts?.completed ?? 0, open: counts?.open ?? 0 },
  };
}
