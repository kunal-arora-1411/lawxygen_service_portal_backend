import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { assignments, DOMAIN_EVENTS, orders, payments } from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { authorize, type Actor } from "../../lib/auth/policy.js";
import { logger } from "../../lib/logger.js";
import { deriveAmounts } from "../../lib/money.js";
import { emit } from "../events/outbox.js";
import { ACCOUNTS, postEntry } from "./ledger.js";
import { sendRefund } from "./razorpay.js";

/**
 * Refunding a client.
 *
 * Full refunds only. A partial refund changes the GST position, the commission split
 * and the professional's share all at once, and getting that wrong quietly is worse
 * than not offering it — so it is deliberately absent rather than half-built.
 *
 * The refund reverses the capture entry exactly: every component that was carved out
 * of the payment goes back. Because the parts summed precisely to the gross going in,
 * they sum precisely to it coming out, and the ledger stays balanced.
 */

/** Anything already refunded, or never paid for, has nothing to return. */
const REFUNDABLE = [
  "paid",
  "awaiting_assignment",
  "assigned",
  "assignment_escalated",
  "in_progress",
  "awaiting_client",
  "completed",
  "cancelled",
] as const;

/** The assignment states that still hold a claim on the money. */
const HOLDING = [
  "assigned",
  "acknowledged",
  "in_progress",
  "awaiting_client",
  "completed",
] as const;

export type RefundOutcome = {
  reference: string;
  amountPaise: number;
  professionalClawedBack: boolean;
};

/**
 * Reverses a captured payment.
 *
 * `refund.approve` is on the impersonation blocklist — an admin acting as someone else
 * cannot return money, whatever their rank.
 */
export async function refundOrder(
  actor: Actor,
  reference: string,
  reason: string,
): Promise<RefundOutcome> {
  authorize(actor, "refund.approve", { minimumRole: "admin" });

  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      pricePaise: orders.pricePaise,
      currency: orders.currency,
    })
    .from(orders)
    .where(eq(orders.reference, reference))
    .limit(1);

  if (!order) throw new ApiError("not_found", "No such order.");

  if (!(REFUNDABLE as readonly string[]).includes(order.status)) {
    throw new ApiError("conflict", `An order that is ${order.status} cannot be refunded.`);
  }

  const [payment] = await db
    .select({ id: payments.id, providerPaymentId: payments.providerPaymentId })
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.status, "captured")))
    .limit(1);

  if (!payment?.providerPaymentId) {
    throw new ApiError("conflict", "No captured payment to refund.");
  }

  // Held in a local: narrowing on a property does not survive into the transaction closure.
  const providerPaymentId = payment.providerPaymentId;

  // The gateway first. Journalling a refund the gateway never accepted would leave the
  // ledger claiming money went back when it did not.
  const transfer = await sendRefund({
    providerPaymentId: payment.providerPaymentId,
    amountPaise: order.pricePaise,
    reason,
  });

  const amounts = deriveAmounts(order.pricePaise);

  return db.transaction(async (tx) => {
    // Guarded, so two admins approving at once produce one refund.
    const [claimed] = await tx
      .update(orders)
      .set({ status: "refunded" })
      .where(and(eq(orders.id, order.id), inArray(orders.status, REFUNDABLE)))
      .returning({ id: orders.id });

    if (!claimed) throw new ApiError("conflict", "That order was refunded a moment ago.");

    /**
     * Whoever holds the matter is no longer owed for it.
     *
     * If they have already been paid this drives their attributed balance negative,
     * which is intended: the next payout nets it off, because `payableBalances` only
     * pays a positive balance. Clawing back money already sent is a conversation, not
     * a transaction, and the ledger should show the debt in the meantime rather than
     * quietly absorbing it.
     */
    const [holder] = await tx
      .select({ professionalId: assignments.professionalId })
      .from(assignments)
      .where(and(eq(assignments.orderId, order.id), inArray(assignments.status, HOLDING)))
      .limit(1);

    const lines = [
      { account: ACCOUNTS.GST_OUTPUT, direction: "debit" as const, amountPaise: amounts.gstPaise },
      {
        account: ACCOUNTS.COMMISSION,
        direction: "debit" as const,
        amountPaise: amounts.commissionPaise,
      },
      {
        account: ACCOUNTS.PRO_PAYABLE,
        direction: "debit" as const,
        amountPaise: amounts.professionalNetPaise,
        ...(holder ? { subjectId: holder.professionalId } : {}),
      },
      {
        account: ACCOUNTS.TDS_PAYABLE,
        direction: "debit" as const,
        amountPaise: amounts.tdsPaise,
        ...(holder ? { subjectId: holder.professionalId } : {}),
      },
      {
        account: ACCOUNTS.GATEWAY_RECEIVABLE,
        direction: "credit" as const,
        amountPaise: amounts.grossPaise,
      },
    ].filter((line) => line.amountPaise > 0);

    await postEntry(tx, {
      kind: "refund",
      // One refund per payment, so a replayed approval cannot journal twice.
      sourceRef: providerPaymentId,
      orderId: order.id,
      currency: order.currency,
      memo: `Refund ${reference}: ${reason}`,
      lines,
    });

    await tx.update(payments).set({ status: "refunded" }).where(eq(payments.id, payment.id));

    // Whoever was working on it stops. Revoked rather than cancelled so the reason
    // survives on the assignment.
    if (holder) {
      await tx
        .update(assignments)
        .set({ status: "revoked", closedReason: `Order refunded: ${reason}` })
        .where(and(eq(assignments.orderId, order.id), inArray(assignments.status, HOLDING)));
    }

    // Emitted so the client is told. Keyed on the payment rather than the order,
    // because the order can only be refunded once but the key should say why.
    await emit(tx, {
      name: DOMAIN_EVENTS.ORDER_REFUNDED,
      aggregateType: "order",
      aggregateId: order.id,
      payload: { reference, amountPaise: order.pricePaise, reason },
      dedupeKey: `${DOMAIN_EVENTS.ORDER_REFUNDED}:${providerPaymentId}`,
    });

    await recordAudit(
      {
        actor,
        action: "refund.approved",
        resourceType: "order",
        resourceId: reference,
        after: { amountPaise: order.pricePaise, providerRef: transfer.providerRef },
        metadata: { reason, clawedBackFrom: holder?.professionalId ?? null },
      },
      tx,
    );

    logger.info({ reference, amountPaise: order.pricePaise }, "order refunded");

    return {
      reference,
      amountPaise: order.pricePaise,
      professionalClawedBack: Boolean(holder),
    };
  });
}
