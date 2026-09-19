import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  assignments,
  DOMAIN_EVENTS,
  OPEN_ASSIGNMENT_STATUSES,
  orders,
  payoutIdentities,
  professionals,
} from "../../db/schema/index.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { isUniqueViolation } from "../../lib/db-errors.js";
import { logger } from "../../lib/logger.js";
import { emit } from "../events/outbox.js";
import { attributePayable } from "./attribution.js";

/**
 * Automatic assignment.
 *
 * On a confirmed payment, exactly one approved, available, qualified professional is
 * claimed for the order — with no admin in the path. The hard part is not choosing; it
 * is choosing exactly once under concurrent payments.
 */

const ACKNOWLEDGE_WINDOW_MS = 4 * 60 * 60 * 1000;

export type AssignOutcome =
  | { status: "assigned"; assignmentId: string; professionalId: string }
  | { status: "already_assigned" }
  | { status: "deferred"; reason: "no_eligible_professional" }
  | { status: "skipped"; reason: "order_not_payable" };

/**
 * Claims a professional for an order.
 *
 * Idempotent by two mechanisms, because the outbox re-runs a handler whenever any
 * subscriber for the same event failed:
 *
 *   1. `assignments_one_open_per_order_uq` — a partial unique index permitting at most
 *      one open assignment per order. A second attempt raises 23505 and is read as
 *      "already assigned" rather than becoming an error;
 *   2. the order status transition only fires from `paid` or `awaiting_assignment`.
 */
export async function assignOrder(orderId: string): Promise<AssignOutcome> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({
        id: orders.id,
        reference: orders.reference,
        status: orders.status,
        categoryId: orders.categoryId,
        pricePaise: orders.pricePaise,
        currency: orders.currency,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!order) return { status: "skipped", reason: "order_not_payable" };
    if (order.status !== "paid" && order.status !== "awaiting_assignment") {
      // Already assigned, cancelled or refunded. Not an error — a replayed event.
      return { status: "already_assigned" };
    }

    const professionalId = await claimProfessional(tx, order.categoryId);

    if (!professionalId) {
      /**
       * No eligible professional. The order must never be lost: it parks in
       * `awaiting_assignment`, which is a queue admin can see, and is re-driven when
       * supply appears — a professional being approved or flipping to available emits
       * an event that drains it.
       */
      await tx
        .update(orders)
        .set({ status: "awaiting_assignment" })
        .where(and(eq(orders.id, order.id), eq(orders.status, "paid")));

      await emit(tx, {
        name: DOMAIN_EVENTS.ASSIGNMENT_DEFERRED,
        aggregateType: "order",
        aggregateId: order.id,
        payload: { reference: order.reference, reason: "no_eligible_professional" },
        // Deduped per attempt, so a later deferral after a failed reassignment still
        // notifies rather than being swallowed as a repeat.
        dedupeKey: `${DOMAIN_EVENTS.ASSIGNMENT_DEFERRED}:${order.id}:${String(Date.now())}`,
      });

      logger.warn(
        { orderId: order.id, reference: order.reference },
        "no eligible professional; order queued",
      );
      return { status: "deferred", reason: "no_eligible_professional" };
    }

    const attempt = await nextAttemptNumber(tx, order.id);

    let assignmentId: string;
    try {
      const [created] = await tx
        .insert(assignments)
        .values({
          orderId: order.id,
          professionalId,
          attempt,
          acknowledgeBy: new Date(Date.now() + ACKNOWLEDGE_WINDOW_MS),
        })
        .returning({ id: assignments.id });

      if (!created) throw new Error("assignment insert returned nothing");
      assignmentId = created.id;
    } catch (error) {
      // The partial unique index fired: a concurrent assigner got there first. The
      // professional claimed above is released by the rollback.
      if (isUniqueViolation(error, "assignments_one_open_per_order_uq")) {
        return { status: "already_assigned" };
      }
      throw error;
    }

    await tx
      .update(orders)
      .set({ status: "assigned" })
      .where(and(eq(orders.id, order.id), inArray(orders.status, ["paid", "awaiting_assignment"])));

    await tx
      .update(professionals)
      .set({ lastAssignedAt: new Date() })
      .where(eq(professionals.id, professionalId));

    /**
     * Attribute the payable to whoever just took the matter.
     *
     * At capture there is no professional yet, so `LIABILITY:PRO_PAYABLE` is credited
     * to nobody in particular. This moves it to them, which is what lets an earnings
     * statement and a payout run both read the ledger rather than deriving money two
     * different ways and eventually disagreeing.
     *
     * Reversed by `reverseAttribution` when a matter is revoked or escalated.
     */
    await attributePayable(tx, {
      assignmentId,
      orderId: order.id,
      professionalId,
      pricePaise: order.pricePaise,
      currency: order.currency,
      reference: order.reference,
    });

    await emit(tx, {
      name: DOMAIN_EVENTS.ASSIGNMENT_CREATED,
      aggregateType: "assignment",
      aggregateId: assignmentId,
      payload: { orderId: order.id, reference: order.reference, professionalId },
    });

    await recordAudit(
      {
        action: "assignment.created",
        resourceType: "order",
        resourceId: order.reference,
        after: { professionalId, attempt },
        metadata: { automatic: true },
      },
      tx,
    );

    return { status: "assigned", assignmentId, professionalId };
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Picks and locks an eligible professional who genuinely has capacity.
 *
 * **Two statements, and it has to be two.** The obvious single query — filter on a
 * `count(*)` over `assignments` inside a `SELECT … FOR UPDATE SKIP LOCKED` — looks
 * airtight and lets capacity be exceeded under load. It did, here: a professional
 * capped at two picked up three.
 *
 * The reason is what the row lock actually protects. Under READ COMMITTED, when a
 * locked row turns out to have been updated by a transaction that committed after
 * this statement's snapshot, PostgreSQL runs an EvalPlanQual recheck — but that
 * re-evaluates the qual against the latest version of *the locked row*. A subquery
 * counting a different table is still answered from the original snapshot. So a
 * transaction whose snapshot predates a just-committed assignment can lock the
 * professional, pass the recheck, and add one more on top of a full workload.
 *
 * So: lock first, then count in a **separate statement**, which under READ COMMITTED
 * takes a fresh snapshot and sees every committed assignment. Holding the lock is
 * what makes that count stable — every other claimer must take the same lock — so
 * once it says there is room, there is room.
 *
 * The count filter stays in the first query as a cheap pre-filter. It is a hint for
 * ordering, not the guarantee.
 *
 * Load is counted rather than kept as a column, because a denormalised counter has to
 * be decremented on every exit path — completed, declined, revoked, escalated — and
 * the day one is missed a professional silently stops receiving work.
 *
 * `payout_identities` is required: a verified professional who never completed payout
 * onboarding cannot be paid, so assigning them creates work nobody can settle.
 */
async function claimProfessional(tx: Tx, categoryId: string): Promise<string | undefined> {
  const open = OPEN_ASSIGNMENT_STATUSES.map((s) => `'${s}'`).join(", ");
  const rejected: string[] = [];

  // Bounded: each pass either claims somebody or rules one candidate out, and the
  // pool a single order can reasonably work through is small.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidates = await tx.execute<{ id: string }>(sql`
      SELECT p.id
      FROM ${professionals} p
      JOIN professional_categories pc
        ON pc.professional_id = p.id AND pc.category_id = ${categoryId}
      JOIN ${payoutIdentities} pi ON pi.professional_id = p.id
      WHERE p.status = 'verified'
        AND p.available
        ${rejected.length ? sql`AND p.id <> ALL(${rejected}::uuid[])` : sql``}
        AND (
          SELECT count(*) FROM ${assignments} a
          WHERE a.professional_id = p.id
            AND a.status IN (${sql.raw(open)})
        ) < p.concurrent_capacity
      ORDER BY (
          SELECT count(*) FROM ${assignments} a
          WHERE a.professional_id = p.id
            AND a.status IN (${sql.raw(open)})
        ) ASC,
        p.last_assigned_at ASC NULLS FIRST,
        p.id ASC
      FOR UPDATE OF p SKIP LOCKED
      LIMIT 1
    `);

    const candidate = candidates[0]?.id;
    if (!candidate) return undefined;

    // Fresh snapshot, taken while holding the lock. This is the actual check.
    const [verified] = await tx
      .select({
        open: sql<number>`(
          SELECT count(*) FROM ${assignments} a
          WHERE a.professional_id = ${candidate}
            AND a.status IN (${sql.raw(open)})
        )::int`,
        capacity: professionals.concurrentCapacity,
      })
      .from(professionals)
      .where(eq(professionals.id, candidate))
      .limit(1);

    if (verified && verified.open < verified.capacity) return candidate;

    // Full after all. Rule them out and look at the next one; the lock is held until
    // this transaction ends, which is correct — they have no room either way.
    rejected.push(candidate);
  }

  logger.warn({ categoryId }, "gave up looking for a professional with spare capacity");
  return undefined;
}

async function nextAttemptNumber(tx: Tx, orderId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(assignments)
    .where(eq(assignments.orderId, orderId));
  return (row?.count ?? 0) + 1;
}

/**
 * Re-drives orders parked for want of supply.
 *
 * Called when a professional is approved or becomes available, so a queued order is
 * picked up immediately rather than waiting for a retry tick.
 */
export async function drainAwaitingAssignment(limit = 50): Promise<number> {
  const waiting = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.status, "awaiting_assignment"))
    .orderBy(orders.createdAt)
    .limit(limit);

  let assigned = 0;
  for (const order of waiting) {
    const outcome = await assignOrder(order.id);
    if (outcome.status === "assigned") assigned += 1;
    // Stop at the first deferral: supply is exhausted, and trying the rest of the queue
    // against an empty pool is wasted work.
    else if (outcome.status === "deferred") break;
  }
  return assigned;
}
