import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../../db/client.js";
import { orders, payments, reconciliationRuns } from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { authorize, type Actor } from "../../lib/auth/policy.js";
import { logger } from "../../lib/logger.js";
import { applyCapture } from "./capture.js";
import { ledgerImbalance } from "./ledger.js";
import { listGatewayPayments, type GatewayPayment } from "./razorpay.js";

/**
 * Daily reconciliation.
 *
 * Everything else in the payment path defends against a webhook that arrived and was
 * mishandled. Nothing defends against one that never arrived, because from inside the
 * system that is indistinguishable from nobody having paid. The client is charged, the
 * order sits in `payment_pending`, no professional is assigned, and the first report of
 * the problem is the client asking where their money went.
 *
 * So once a day we ask the gateway what it thinks happened and compare.
 *
 * What gets repaired automatically and what does not is a deliberate line. A capture we
 * simply missed is replayed through `applyCapture` — the same function the webhook
 * calls, idempotent by construction, so a run that overlaps a previous one costs
 * nothing. Anything where the two sides disagree about an *amount* is recorded and left
 * alone. A mismatch means one of the two is wrong, and a job that guesses which is a
 * job that can lose money quietly.
 */

export type ReconciliationException =
  | { kind: "missing_capture"; providerPaymentId: string; amountPaise: number; repaired: boolean }
  | { kind: "unknown_order"; providerPaymentId: string; providerOrderId: string | null }
  | {
      kind: "amount_mismatch";
      providerPaymentId: string;
      gatewayPaise: number;
      recordedPaise: number;
    }
  | { kind: "refund_not_recorded"; providerPaymentId: string; refundedPaise: number }
  | { kind: "unknown_to_gateway"; providerPaymentId: string; amountPaise: number }
  | { kind: "ledger_imbalance"; imbalancePaise: number };

export type ReconciliationReport = {
  id: string;
  windowStart: string;
  windowEnd: string;
  gatewayCount: number;
  matchedCount: number;
  repairedCount: number;
  ledgerImbalancePaise: number;
  status: "clean" | "exceptions" | "failed";
  exceptions: ReconciliationException[];
  failureReason: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/** Gateway statuses that mean the money actually moved. */
const SETTLED = new Set(["captured", "refunded"]);

/**
 * Reconciles one window.
 *
 * The window overlaps the previous run's on purpose — a payment created seconds before
 * a boundary can be captured seconds after it, and a run that took the boundary
 * literally would never look at it again.
 */
export async function reconcile(window: { from: Date; to: Date }): Promise<ReconciliationReport> {
  const [run] = await db
    .insert(reconciliationRuns)
    .values({ windowStart: window.from, windowEnd: window.to, status: "running" })
    .returning({ id: reconciliationRuns.id, startedAt: reconciliationRuns.startedAt });

  if (!run) throw new ApiError("internal", "Could not start a reconciliation run.");

  try {
    const gateway = await listGatewayPayments(window);
    const result = await compare(gateway, window);

    const status = result.exceptions.length === 0 ? "clean" : "exceptions";

    await db
      .update(reconciliationRuns)
      .set({
        gatewayCount: gateway.length,
        matchedCount: result.matched,
        repairedCount: result.repaired,
        exceptions: result.exceptions,
        ledgerImbalancePaise: result.imbalance,
        status,
        finishedAt: new Date(),
      })
      .where(eq(reconciliationRuns.id, run.id));

    // Logged at warn so an exception surfaces in whatever watches the logs, not only
    // to an admin who happens to open the screen.
    const line = {
      runId: run.id,
      gateway: gateway.length,
      repaired: result.repaired,
      exceptions: result.exceptions.length,
    };
    if (status === "clean") logger.info(line, "reconciliation clean");
    else logger.warn({ ...line, detail: result.exceptions }, "reconciliation found exceptions");

    return {
      id: run.id,
      windowStart: window.from.toISOString(),
      windowEnd: window.to.toISOString(),
      gatewayCount: gateway.length,
      matchedCount: result.matched,
      repairedCount: result.repaired,
      ledgerImbalancePaise: result.imbalance,
      status,
      exceptions: result.exceptions,
      failureReason: null,
      startedAt: run.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  } catch (error) {
    /**
     * A run that could not reach the gateway must be recorded as failed rather than
     * left half-written. An absent run and a clean run look identical on a screen, and
     * "reconciliation has not succeeded for three days" is exactly the thing this is
     * supposed to make visible.
     */
    const reason = error instanceof Error ? error.message : String(error);
    await db
      .update(reconciliationRuns)
      .set({ status: "failed", failureReason: reason, finishedAt: new Date() })
      .where(eq(reconciliationRuns.id, run.id));

    logger.error({ err: error, runId: run.id }, "reconciliation failed");
    throw error;
  }
}

async function compare(
  gateway: GatewayPayment[],
  window: { from: Date; to: Date },
): Promise<{
  matched: number;
  repaired: number;
  imbalance: number;
  exceptions: ReconciliationException[];
}> {
  const exceptions: ReconciliationException[] = [];
  let matched = 0;
  let repaired = 0;

  const settled = gateway.filter((p) => SETTLED.has(p.status));
  const seenLocally = new Set<string>();

  for (const remote of settled) {
    const [local] = await db
      .select({
        id: payments.id,
        status: payments.status,
        amountPaise: payments.amountPaise,
        providerOrderId: payments.providerOrderId,
        orderStatus: orders.status,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(
        remote.orderId
          ? eq(payments.providerOrderId, remote.orderId)
          : eq(payments.providerPaymentId, remote.id),
      )
      .limit(1);

    if (!local) {
      // A payment against a gateway order this system never created. Not repairable —
      // there is no order to attach it to.
      exceptions.push({
        kind: "unknown_order",
        providerPaymentId: remote.id,
        providerOrderId: remote.orderId,
      });
      continue;
    }

    seenLocally.add(local.id);

    if (local.amountPaise !== remote.amountPaise) {
      // Never auto-repaired. One of the two figures is wrong and a job cannot know which.
      exceptions.push({
        kind: "amount_mismatch",
        providerPaymentId: remote.id,
        gatewayPaise: remote.amountPaise,
        recordedPaise: local.amountPaise,
      });
      continue;
    }

    if (local.status === "captured" || local.status === "refunded") {
      matched += 1;
    } else if (remote.orderId) {
      /**
       * The case this whole module exists for. Replayed through the same path the
       * webhook would have taken, so the ledger, the invoice, the outbox event and the
       * assignment all happen exactly as they should have at the time.
       */
      const outcome = await applyCapture({
        providerPaymentId: remote.id,
        providerOrderId: remote.orderId,
        amountPaise: remote.amountPaise,
        method: remote.method,
      });

      const applied = outcome.applied;
      if (applied) repaired += 1;
      exceptions.push({
        kind: "missing_capture",
        providerPaymentId: remote.id,
        amountPaise: remote.amountPaise,
        repaired: applied,
      });
    }

    /**
     * A refund taken at the gateway's own dashboard rather than through this system.
     * Left for a person: refunding here needs a reason and an actor, and inventing
     * both would put an unattributable entry in the audit log.
     */
    if (remote.amountRefundedPaise > 0 && local.status !== "refunded") {
      exceptions.push({
        kind: "refund_not_recorded",
        providerPaymentId: remote.id,
        refundedPaise: remote.amountRefundedPaise,
      });
    }
  }

  /**
   * The other direction: something we believe was captured that the gateway does not
   * report. Rarer and more alarming than a missing capture — it means either a bug
   * here or a payment credited that never existed.
   */
  const locallyCaptured = await db
    .select({
      id: payments.id,
      providerPaymentId: payments.providerPaymentId,
      amountPaise: payments.amountPaise,
    })
    .from(payments)
    .where(
      and(
        inArray(payments.status, ["captured", "refunded"]),
        // Created, not updated: the gateway's own `from`/`to` filter on when the
        // payment was created, so comparing on anything else compares two different
        // windows. A payment refunded today would otherwise re-enter a window it was
        // reconciled out of months ago.
        gte(payments.createdAt, window.from),
        lte(payments.createdAt, window.to),
      ),
    );

  const remoteIds = new Set(gateway.map((p) => p.id));
  for (const local of locallyCaptured) {
    if (seenLocally.has(local.id)) continue;
    if (local.providerPaymentId && remoteIds.has(local.providerPaymentId)) continue;
    exceptions.push({
      kind: "unknown_to_gateway",
      providerPaymentId: local.providerPaymentId ?? local.id,
      amountPaise: local.amountPaise,
    });
  }

  // Cheap, and the single strongest statement the system can make about its own books.
  const imbalance = await ledgerImbalance();
  if (imbalance !== 0) exceptions.push({ kind: "ledger_imbalance", imbalancePaise: imbalance });

  return { matched, repaired, imbalance, exceptions };
}

/** The window a scheduled run uses: the last two days, so a boundary cannot hide one. */
export function defaultWindow(now = new Date()): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - 48 * 60 * 60 * 1000), to: now };
}

/** For the job runner. Swallows the error — the run row already records the failure. */
export async function reconcileScheduled(): Promise<void> {
  try {
    await reconcile(defaultWindow());
  } catch {
    // Already logged and recorded by reconcile(). A throw here would only stop the job.
  }
}

export async function runReconciliation(
  actor: Actor,
  window?: { from: Date; to: Date },
): Promise<ReconciliationReport> {
  authorize(actor, "reconciliation.run", { minimumRole: "admin" });
  return reconcile(window ?? defaultWindow());
}

export async function recentRuns(actor: Actor, limit = 20): Promise<ReconciliationReport[]> {
  authorize(actor, "reconciliation.read", { minimumRole: "admin" });

  const rows = await db
    .select()
    .from(reconciliationRuns)
    .orderBy(desc(reconciliationRuns.startedAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    gatewayCount: row.gatewayCount,
    matchedCount: row.matchedCount,
    repairedCount: row.repairedCount,
    ledgerImbalancePaise: row.ledgerImbalancePaise,
    status: row.status as ReconciliationReport["status"],
    exceptions: row.exceptions as ReconciliationException[],
    failureReason: row.failureReason,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));
}
