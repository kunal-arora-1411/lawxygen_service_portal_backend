import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { assignments, orders } from "../../db/schema/index.js";
import { deriveAmounts } from "../../lib/money.js";
import { ACCOUNTS, postEntry } from "../payments/ledger.js";

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
  const share = deriveAmounts(input.pricePaise).professionalNetPaise;
  if (share <= 0) return;

  await postEntry(tx, {
    kind: "adjustment",
    // Per assignment, so a replacement attributes without colliding with the original.
    sourceRef: `attribute:${input.assignmentId}`,
    orderId: input.orderId,
    currency: input.currency,
    memo: `Attribute ${input.reference} to professional`,
    lines: [
      { account: ACCOUNTS.PRO_PAYABLE, direction: "debit", amountPaise: share },
      {
        account: ACCOUNTS.PRO_PAYABLE,
        direction: "credit",
        amountPaise: share,
        subjectId: input.professionalId,
      },
    ],
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

  const share = deriveAmounts(row.pricePaise).professionalNetPaise;
  if (share <= 0) return;

  await postEntry(tx, {
    kind: "adjustment",
    sourceRef: `unattribute:${assignmentId}`,
    orderId: row.orderId,
    currency: row.currency,
    memo: `Return ${row.reference} to the unattributed pool`,
    lines: [
      {
        account: ACCOUNTS.PRO_PAYABLE,
        direction: "debit",
        amountPaise: share,
        subjectId: row.professionalId,
      },
      { account: ACCOUNTS.PRO_PAYABLE, direction: "credit", amountPaise: share },
    ],
  });
}
