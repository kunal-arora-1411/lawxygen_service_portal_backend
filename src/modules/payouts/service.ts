import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  ledgerLines,
  payoutBatches,
  payoutIdentities,
  payouts,
  professionals,
  type PayoutBatchStatus,
  type PayoutStatus,
} from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { authorize, type Actor } from "../../lib/auth/policy.js";
import { nextCounterValue } from "../../lib/counters.js";
import { logger } from "../../lib/logger.js";
import { DEFAULT_MONEY_SETTINGS } from "../../lib/money.js";
import { ACCOUNTS, postEntry } from "../payments/ledger.js";
import { sendPayout } from "./transfer.js";

/**
 * Paying professionals.
 *
 * Two steps on purpose. **Drafting** reads the ledger and writes down who is owed what;
 * **releasing** moves the money and journals it. Between them a human looks at the
 * list — this is the one action in the system that sends money out of the business,
 * and a single click from "it is Friday" to "money has left" is how the wrong figure
 * gets paid to the wrong person.
 *
 * Drafting snapshots the amounts. A professional completing another matter between
 * draft and release is paid for it in the *next* batch, not silently added to this one
 * after it was reviewed.
 */

const MINIMUM_PAYOUT_PAISE = 10_000; // ₹100

export type DraftedPayout = {
  professionalId: string;
  displayName: string;
  amountPaise: number;
  tdsPaise: number;
  accountLast4: string;
};

export type BatchView = {
  reference: string;
  status: PayoutBatchStatus;
  totalPaise: number;
  payoutCount: number;
  createdAt: Date;
  releasedAt: Date | null;
  note: string | null;
};

/**
 * Who is owed money right now, from the ledger.
 *
 * `LIABILITY:PRO_PAYABLE` credited to a subject, less anything already debited by a
 * previous payout. A professional with no payout identity is excluded — there is
 * nowhere to send it, and including them would produce a batch that cannot complete.
 */
export async function payableBalances(actor: Actor): Promise<DraftedPayout[]> {
  authorize(actor, "payout.read", { minimumRole: "admin" });

  const rows = await db
    .select({
      professionalId: professionals.id,
      displayName: professionals.displayName,
      accountLast4: payoutIdentities.accountLast4,
      amountPaise: sql<number>`coalesce(sum(case
        when ${ledgerLines.account} = ${ACCOUNTS.PRO_PAYABLE} and ${ledgerLines.direction} = 'credit'
          then ${ledgerLines.amountPaise}
        when ${ledgerLines.account} = ${ACCOUNTS.PRO_PAYABLE} and ${ledgerLines.direction} = 'debit'
          then -${ledgerLines.amountPaise}
        else 0 end), 0)::bigint`,
      tdsPaise: sql<number>`coalesce(sum(case
        when ${ledgerLines.account} = ${ACCOUNTS.TDS_PAYABLE} and ${ledgerLines.direction} = 'credit'
          then ${ledgerLines.amountPaise}
        when ${ledgerLines.account} = ${ACCOUNTS.TDS_PAYABLE} and ${ledgerLines.direction} = 'debit'
          then -${ledgerLines.amountPaise}
        else 0 end), 0)::bigint`,
    })
    .from(professionals)
    .innerJoin(payoutIdentities, eq(payoutIdentities.professionalId, professionals.id))
    .innerJoin(ledgerLines, eq(ledgerLines.subjectId, professionals.id))
    .groupBy(professionals.id, professionals.displayName, payoutIdentities.accountLast4);

  return rows
    .map((row) => ({
      professionalId: row.professionalId,
      displayName: row.displayName,
      amountPaise: Number(row.amountPaise),
      tdsPaise: Number(row.tdsPaise),
      accountLast4: row.accountLast4,
    }))
    .filter((row) => row.amountPaise >= MINIMUM_PAYOUT_PAISE)
    .sort((a, b) => b.amountPaise - a.amountPaise);
}

export async function draftBatch(
  actor: Actor,
  note?: string,
): Promise<{ reference: string; payouts: DraftedPayout[] }> {
  authorize(actor, "payout.draft", { minimumRole: "admin" });

  const candidates = await payableBalances(actor);
  if (candidates.length === 0) {
    throw new ApiError("conflict", "Nobody is owed enough to pay out yet.");
  }

  return db.transaction(async (tx) => {
    const reference = `PO-${String(await nextCounterValue("payout_batch", tx)).padStart(6, "0")}`;

    const [batch] = await tx
      .insert(payoutBatches)
      .values({
        reference,
        createdBy: actor.userId,
        note: note ?? null,
        totalPaise: candidates.reduce((sum, c) => sum + c.amountPaise, 0),
        payoutCount: candidates.length,
      })
      .returning({ id: payoutBatches.id });

    if (!batch) throw new ApiError("internal", "Could not create the batch.");

    await tx.insert(payouts).values(
      candidates.map((c) => ({
        batchId: batch.id,
        professionalId: c.professionalId,
        amountPaise: c.amountPaise,
        tdsPaise: c.tdsPaise,
        // Recorded per payout rather than read from settings later: a statement
        // issued in two years must say what was applied at the time.
        tdsSection: DEFAULT_MONEY_SETTINGS.tdsSection,
        tdsRateBps: DEFAULT_MONEY_SETTINGS.tdsBps,
        accountLast4: c.accountLast4,
      })),
    );

    await recordAudit(
      {
        actor,
        action: "payout.drafted",
        resourceType: "payout_batch",
        resourceId: reference,
        after: {
          count: candidates.length,
          totalPaise: candidates.reduce((s, c) => s + c.amountPaise, 0),
        },
      },
      tx,
    );

    return { reference, payouts: candidates };
  });
}

export type ReleaseResult = { paid: number; failed: number; totalPaise: number };

/**
 * Releases a drafted batch.
 *
 * Each payout is its own transaction. One failed transfer must not roll back the ones
 * that already succeeded — the money for those has genuinely left — so failures are
 * recorded against their row and the batch reports both counts.
 *
 * `payout.release` is on the impersonation blocklist: an admin acting as somebody else
 * cannot move money, whatever their rank.
 */
export async function releaseBatch(actor: Actor, reference: string): Promise<ReleaseResult> {
  authorize(actor, "payout.release", { minimumRole: "admin" });

  const [batch] = await db
    .select({ id: payoutBatches.id, status: payoutBatches.status })
    .from(payoutBatches)
    .where(eq(payoutBatches.reference, reference))
    .limit(1);

  if (!batch) throw new ApiError("not_found", "No such payout batch.");
  if (batch.status !== "draft") {
    throw new ApiError("conflict", `That batch is ${batch.status}, not a draft.`);
  }

  // Claim the batch so two admins clicking release cannot both run it.
  const [claimed] = await db
    .update(payoutBatches)
    .set({ status: "releasing" })
    .where(and(eq(payoutBatches.id, batch.id), eq(payoutBatches.status, "draft")))
    .returning({ id: payoutBatches.id });

  if (!claimed) throw new ApiError("conflict", "That batch is already being released.");

  const pending = await db
    .select({
      id: payouts.id,
      professionalId: payouts.professionalId,
      amountPaise: payouts.amountPaise,
      currency: payouts.currency,
      displayName: professionals.displayName,
    })
    .from(payouts)
    .innerJoin(professionals, eq(professionals.id, payouts.professionalId))
    .where(and(eq(payouts.batchId, batch.id), eq(payouts.status, "pending")));

  let paid = 0;
  let failed = 0;
  let totalPaise = 0;

  for (const payout of pending) {
    try {
      const transfer = await sendPayout({
        professionalId: payout.professionalId,
        amountPaise: payout.amountPaise,
        currency: payout.currency,
        reference: `${reference}/${payout.professionalId.slice(0, 8)}`,
      });

      await db.transaction(async (tx) => {
        // Settling the liability: what was owed is no longer owed, and the bank
        // balance falls by the same amount.
        await postEntry(tx, {
          kind: "payout",
          sourceRef: payout.id,
          currency: payout.currency,
          memo: `Payout ${reference} to ${payout.displayName}`,
          lines: [
            {
              account: ACCOUNTS.PRO_PAYABLE,
              direction: "debit",
              amountPaise: payout.amountPaise,
              subjectId: payout.professionalId,
            },
            { account: ACCOUNTS.BANK, direction: "credit", amountPaise: payout.amountPaise },
          ],
        });

        await tx
          .update(payouts)
          .set({ status: "paid", providerRef: transfer.providerRef, paidAt: new Date() })
          .where(and(eq(payouts.id, payout.id), eq(payouts.status, "pending")));
      });

      paid += 1;
      totalPaise += payout.amountPaise;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, payoutId: payout.id, reference }, "payout failed");

      await db
        .update(payouts)
        .set({ status: "failed", failureReason: reason })
        .where(eq(payouts.id, payout.id));

      failed += 1;
    }
  }

  await db
    .update(payoutBatches)
    .set({ status: "released", releasedAt: new Date(), releasedBy: actor.userId })
    .where(eq(payoutBatches.id, batch.id));

  await recordAudit({
    actor,
    action: "payout.release",
    resourceType: "payout_batch",
    resourceId: reference,
    after: { paid, failed, totalPaise },
  });

  return { paid, failed, totalPaise };
}

export async function listBatches(actor: Actor): Promise<BatchView[]> {
  authorize(actor, "payout.read", { minimumRole: "admin" });

  return db
    .select({
      reference: payoutBatches.reference,
      status: payoutBatches.status,
      totalPaise: payoutBatches.totalPaise,
      payoutCount: payoutBatches.payoutCount,
      createdAt: payoutBatches.createdAt,
      releasedAt: payoutBatches.releasedAt,
      note: payoutBatches.note,
    })
    .from(payoutBatches)
    .orderBy(desc(payoutBatches.createdAt))
    .limit(50);
}

export type PayoutHistoryRow = {
  reference: string;
  amountPaise: number;
  tdsPaise: number;
  tdsSection: string | null;
  status: PayoutStatus;
  accountLast4: string | null;
  paidAt: Date | null;
  createdAt: Date;
};

/** A professional's own payout history — what they were paid and what was withheld. */
export async function payoutHistoryFor(professionalId: string): Promise<PayoutHistoryRow[]> {
  return db
    .select({
      reference: payoutBatches.reference,
      amountPaise: payouts.amountPaise,
      tdsPaise: payouts.tdsPaise,
      tdsSection: payouts.tdsSection,
      status: payouts.status,
      accountLast4: payouts.accountLast4,
      paidAt: payouts.paidAt,
      createdAt: payouts.createdAt,
    })
    .from(payouts)
    .innerJoin(payoutBatches, eq(payoutBatches.id, payouts.batchId))
    .where(eq(payouts.professionalId, professionalId))
    .orderBy(desc(payouts.createdAt))
    .limit(50);
}
