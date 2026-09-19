import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  assignments,
  DOMAIN_EVENTS,
  orders,
  professionalCredentials,
  professionals,
} from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { authorize, type Actor } from "../../lib/auth/policy.js";
import { reverseAttribution } from "../assignment/attribution.js";
import { assignOrder } from "../assignment/engine.js";
import { emit } from "../events/outbox.js";

/** Admin operations on the supply pool and the assignment queue. */

/**
 * Approves a professional into the assignment pool.
 *
 * Emits so the queue of orders parked for want of supply is drained at once — the
 * common case for a marketplace at launch is an order arriving before anyone qualified
 * exists, and it should not sit there once someone does.
 */
export async function verifyProfessional(
  actor: Actor,
  professionalId: string,
): Promise<{ status: string }> {
  authorize(actor, "professional.verify", { minimumRole: "admin" });

  return db.transaction(async (tx) => {
    /**
     * Only an application that was actually submitted. Verifying a draft would approve
     * somebody mid-way through filling the form — before they have confirmed the
     * details are final, and possibly before they have a payout identity, which the
     * eligibility query would then have to keep excluding.
     *
     * Reinstating a suspended professional is `reinstateProfessional`, not this.
     */
    const [updated] = await tx
      .update(professionals)
      .set({ status: "verified", verifiedAt: new Date() })
      .where(and(eq(professionals.id, professionalId), eq(professionals.status, "pending_review")))
      .returning({ id: professionals.id, status: professionals.status });

    if (!updated) {
      const [exists] = await tx
        .select({ status: professionals.status })
        .from(professionals)
        .where(eq(professionals.id, professionalId))
        .limit(1);

      if (!exists) throw new ApiError("not_found", "No such professional.");
      throw new ApiError("conflict", `That application is ${exists.status}, not awaiting review.`);
    }

    // The registration numbers were the thing being reviewed. Approving the person
    // approves what they submitted, or the credential list stays "submitted" forever.
    await tx
      .update(professionalCredentials)
      .set({ status: "verified", reviewedBy: actor.userId, reviewedAt: new Date() })
      .where(
        and(
          eq(professionalCredentials.professionalId, professionalId),
          eq(professionalCredentials.status, "submitted"),
        ),
      );

    await emit(tx, {
      name: DOMAIN_EVENTS.PROFESSIONAL_APPROVED,
      aggregateType: "professional",
      aggregateId: professionalId,
    });

    await recordAudit(
      {
        actor,
        action: "professional.verified",
        resourceType: "professional",
        resourceId: professionalId,
        after: { status: "verified" },
      },
      tx,
    );

    return { status: updated.status };
  });
}

/**
 * Turning an application down.
 *
 * The reason is stored on every credential rather than only in the audit log, because
 * the applicant has to see it — a rejection they cannot read is a support ticket. They
 * can correct and resubmit, because a rejected application is editable again.
 */
export async function rejectProfessional(
  actor: Actor,
  professionalId: string,
  reason: string,
): Promise<void> {
  authorize(actor, "professional.verify", { minimumRole: "admin" });

  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(professionals)
      .set({ status: "rejected", available: false })
      .where(and(eq(professionals.id, professionalId), eq(professionals.status, "pending_review")))
      .returning({ id: professionals.id });

    if (!updated) throw new ApiError("conflict", "That application is not awaiting review.");

    await tx
      .update(professionalCredentials)
      .set({
        status: "rejected",
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        reviewNote: reason,
      })
      .where(eq(professionalCredentials.professionalId, professionalId));

    await recordAudit(
      {
        actor,
        action: "professional.rejected",
        resourceType: "professional",
        resourceId: professionalId,
        after: { status: "rejected" },
        metadata: { reason },
      },
      tx,
    );
  });
}

/**
 * Putting a suspended professional back.
 *
 * Separate from verification because it is a different decision about a different
 * person: one is "are these credentials real", the other is "is this behaviour
 * resolved". It emits the same approval event so the parked queue drains.
 */
export async function reinstateProfessional(actor: Actor, professionalId: string): Promise<void> {
  authorize(actor, "professional.verify", { minimumRole: "admin" });

  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(professionals)
      .set({ status: "verified" })
      .where(and(eq(professionals.id, professionalId), eq(professionals.status, "suspended")))
      .returning({ id: professionals.id });

    if (!updated) throw new ApiError("conflict", "That professional is not suspended.");

    await emit(tx, {
      name: DOMAIN_EVENTS.PROFESSIONAL_APPROVED,
      aggregateType: "professional",
      aggregateId: professionalId,
    });

    await recordAudit(
      {
        actor,
        action: "professional.reinstated",
        resourceType: "professional",
        resourceId: professionalId,
        after: { status: "verified" },
      },
      tx,
    );
  });
}

/** Removes a professional from the pool. Matters already held are not released. */
export async function suspendProfessional(
  actor: Actor,
  professionalId: string,
  reason: string,
): Promise<void> {
  authorize(actor, "professional.suspend", { minimumRole: "admin" });

  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(professionals)
      .set({ status: "suspended", available: false })
      .where(eq(professionals.id, professionalId))
      .returning({ id: professionals.id });

    if (!updated) throw new ApiError("not_found", "No such professional.");

    await recordAudit(
      {
        actor,
        action: "professional.suspended",
        resourceType: "professional",
        resourceId: professionalId,
        metadata: { reason },
      },
      tx,
    );
  });
}

/**
 * Takes a matter off one professional and runs the engine again.
 *
 * The automatic engine is the default path, not the only one: a client asking for
 * someone else, a professional going quiet, a conflict of interest. Revoking and
 * re-running beats hand-picking, because the same eligibility and capacity rules still
 * apply to the replacement.
 */
export async function reassignOrder(
  actor: Actor,
  reference: string,
  reason: string,
): Promise<{ reassigned: boolean; professionalId?: string }> {
  authorize(actor, "assignment.reassign", { minimumRole: "admin" });

  const orderId = await db.transaction(async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(eq(orders.reference, reference))
      .limit(1);

    if (!order) throw new ApiError("not_found", "No such order.");

    const [revoked] = await tx
      .update(assignments)
      .set({ status: "revoked", closedReason: reason })
      .where(
        and(
          eq(assignments.orderId, order.id),
          // Only an open assignment can be revoked; a completed one is history.
          eq(assignments.status, "assigned"),
        ),
      )
      .returning({ id: assignments.id, professionalId: assignments.professionalId });

    if (revoked) {
      // They no longer hold the matter, so they are no longer owed for it. Without
      // this their earnings would claim money for work taken off them.
      await reverseAttribution(tx, revoked.id);

      await emit(tx, {
        name: DOMAIN_EVENTS.ASSIGNMENT_REVOKED,
        aggregateType: "assignment",
        aggregateId: revoked.id,
        payload: { reference, professionalId: revoked.professionalId, reason },
      });
    }

    // Back to a state the engine will act on. Without this the partial unique index
    // would be free but the order status would still say `assigned`.
    await tx.update(orders).set({ status: "paid" }).where(eq(orders.id, order.id));

    await recordAudit(
      {
        actor,
        action: "assignment.reassigned",
        resourceType: "order",
        resourceId: reference,
        metadata: { reason, revokedFrom: revoked?.professionalId ?? null },
      },
      tx,
    );

    return order.id;
  });

  // Outside the transaction: the revocation stands even if no replacement is free,
  // and the order then parks in the queue rather than staying with someone unsuitable.
  const outcome = await assignOrder(orderId);
  return outcome.status === "assigned"
    ? { reassigned: true, professionalId: outcome.professionalId }
    : { reassigned: false };
}
