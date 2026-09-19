import { eq } from "drizzle-orm";
import type { db } from "../../db/client.js";
import { assignments, orders } from "../../db/schema/index.js";
import { deriveAmounts } from "../../lib/money.js";
import { ACCOUNTS, postEntry, type LedgerLineInput } from "../payments/ledger.js";

/**
 * Attributing the professional's share, and taking it back.
 *
 * At capture there is no professional, so `LIABILITY:PRO_PAYABLE` is credited to
 * nobody in particular. Assignment reclassifies that amount to whoever took the
 * matter; losing the matter has to reclassify it back, or the ledger says two people
 * are owed for one order and the person who no longer holds it sees earnings they
 * will never be paid.
 *
 * Both directions are separate journal entries rather than edits, because a ledger is
 * append-only: what was true at the time stays on the record, and the correction is
 * its own fact.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function attributePayable(
  tx: Tx,
  input: {
    assignmentId: string;
    orderId: string;
    professionalId: string;
    pricePaise: number;
    currency: string;
    reference: string;
  },
): Promise<void> {
  const amounts = deriveAmounts(input.pricePaise);
  const lines = attributionLines(amounts, input.professionalId, "to");
  if (lines.length === 0) return;

  await postEntry(tx, {
    kind: "adjustment",
    // Per assignment, so a replacement attributes without colliding with the original.
    sourceRef: `attribute:${input.assignmentId}`,
    orderId: input.orderId,
    currency: input.currency,
    memo: `Attribute ${input.reference} to professional`,
    lines,
  });
}

/**
 * The two balances that belong to a named professional rather than to the pool.
 *
 * `PRO_PAYABLE` is what they are owed. `TDS_PAYABLE` is what was withheld from them —
 * and it needs a subject for the same reason the payable does: withholding is reported
 * deductee-wise, so a TDS certificate cannot be produced from a single undifferentiated
 * pile. Both are credited to nobody in particular at capture, because at capture there
 * is no professional yet.
 *
 * The account totals are unchanged either way. Only the subject moves.
 */
function attributionLines(
  amounts: ReturnType<typeof deriveAmounts>,
  professionalId: string,
  direction: "to" | "from",
): LedgerLineInput[] {
  const toSubject = direction === "to";

  return (
    [
      { account: ACCOUNTS.PRO_PAYABLE, amount: amounts.professionalNetPaise },
      { account: ACCOUNTS.TDS_PAYABLE, amount: amounts.tdsPaise },
    ] as const
  ).flatMap(({ account, amount }): LedgerLineInput[] => {
    if (amount <= 0) return [];

    /**
     * Two lines per account, and which is which never moves: the unattributed pool
     * carries no subject, the professional's side always does. Only the directions
     * swap between attributing and reversing.
     *
     * An earlier version toggled *which line* carried the subject, which read as
     * symmetric and was not — reversing credited the professional instead of
     * debiting them, so taking a matter away doubled what they appeared to be owed.
     */
    return [
      { account, direction: toSubject ? "debit" : "credit", amountPaise: amount },
      {
        account,
        direction: toSubject ? "credit" : "debit",
        amountPaise: amount,
        subjectId: professionalId,
      },
    ];
  });
}

/**
 * Reverses an attribution when a matter leaves a professional unpaid — revoked by
 * admin, or escalated for never being acknowledged.
 *
 * Reads the assignment rather than taking the amounts as arguments, so every caller
 * reverses exactly what was attributed and none of them can pass a different figure.
 */
export async function reverseAttribution(tx: Tx, assignmentId: string): Promise<void> {
  const [row] = await tx
    .select({
      professionalId: assignments.professionalId,
      orderId: assignments.orderId,
      pricePaise: orders.pricePaise,
      currency: orders.currency,
      reference: orders.reference,
    })
    .from(assignments)
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .where(eq(assignments.id, assignmentId))
    .limit(1);

  if (!row) return;

  const lines = attributionLines(deriveAmounts(row.pricePaise), row.professionalId, "from");
  if (lines.length === 0) return;

  await postEntry(tx, {
    kind: "adjustment",
    sourceRef: `unattribute:${assignmentId}`,
    orderId: row.orderId,
    currency: row.currency,
    memo: `Return ${row.reference} to the unattributed pool`,
    lines,
  });
}
