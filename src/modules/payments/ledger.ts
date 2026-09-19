import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { ledgerEntries, ledgerLines } from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";

/**
 * Writing to the ledger.
 *
 * The chart of accounts is data, not an enum. The GST treatment is still an open
 * question for a CA — principal (Lawxygen invoices the client for the whole amount and
 * the professional invoices Lawxygen) versus agent (the professional supplies the
 * client and Lawxygen charges commission) — and the two produce different postings.
 * Keeping account codes as text means that determination changes a mapping rather than
 * a migration.
 */
export const ACCOUNTS = {
  /** Collected by the gateway, not yet settled to the bank. */
  GATEWAY_RECEIVABLE: "ASSET:GATEWAY_RECEIVABLE",
  BANK: "ASSET:BANK",
  /** Lawxygen's fee. */
  COMMISSION: "INCOME:COMMISSION",
  /** Owed to the professional, net of withholding. */
  PRO_PAYABLE: "LIABILITY:PRO_PAYABLE",
  /** Withheld from the professional and owed to the department. */
  TDS_PAYABLE: "LIABILITY:TDS_PAYABLE",
  /** Output GST collected from the client. */
  GST_OUTPUT: "LIABILITY:GST_OUTPUT",
} as const;

export type LedgerLineInput = {
  account: string;
  direction: "debit" | "credit";
  amountPaise: number;
  subjectId?: string | null;
};

export type PostEntryInput = {
  kind: "capture" | "refund" | "payout" | "adjustment";
  /** Idempotency key for the journal — e.g. the gateway payment id. */
  sourceRef: string;
  orderId?: string | null;
  currency?: string;
  memo?: string;
  lines: LedgerLineInput[];
  occurredAt?: Date;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Posts one balanced journal entry.
 *
 * Takes a transaction rather than defaulting to `db`, deliberately: a ledger entry that
 * commits separately from the state change it describes is a lie waiting to happen.
 *
 * Balance is checked here for a readable error, and again by a deferred constraint
 * trigger at COMMIT, which is the check that actually cannot be bypassed. The
 * duplication is the point — this one produces a good message, that one produces a
 * guarantee.
 */
export async function postEntry(tx: Tx, input: PostEntryInput): Promise<string> {
  if (input.lines.length === 0) {
    throw new ApiError("internal", "A ledger entry needs at least one line.");
  }

  let debits = 0;
  let credits = 0;
  for (const line of input.lines) {
    if (!Number.isInteger(line.amountPaise) || line.amountPaise <= 0) {
      throw new ApiError(
        "internal",
        `Ledger line for ${line.account} must be a positive integer, got ${String(line.amountPaise)}.`,
      );
    }
    if (line.direction === "debit") debits += line.amountPaise;
    else credits += line.amountPaise;
  }

  if (debits !== credits) {
    throw new ApiError(
      "internal",
      `Ledger entry ${input.kind}/${input.sourceRef} does not balance: debits ${String(debits)}, credits ${String(credits)}.`,
    );
  }

  const [entry] = await tx
    .insert(ledgerEntries)
    .values({
      kind: input.kind,
      sourceRef: input.sourceRef,
      orderId: input.orderId ?? null,
      currency: input.currency ?? "INR",
      memo: input.memo ?? null,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    })
    .returning({ id: ledgerEntries.id });

  if (!entry) throw new ApiError("internal", "Could not create the ledger entry.");

  await tx.insert(ledgerLines).values(
    input.lines.map((line) => ({
      entryId: entry.id,
      account: line.account,
      direction: line.direction,
      amountPaise: line.amountPaise,
      subjectId: line.subjectId ?? null,
    })),
  );

  return entry.id;
}

/** Zero across the whole ledger is the invariant a reconciliation starts from. */
export async function ledgerImbalance(): Promise<number> {
  const [row] = await db
    .select({
      delta: sql<number>`COALESCE(SUM(CASE WHEN ${ledgerLines.direction} = 'debit'
                                           THEN ${ledgerLines.amountPaise}
                                           ELSE -${ledgerLines.amountPaise} END), 0)::bigint`,
    })
    .from(ledgerLines);
  return Number(row?.delta ?? 0);
}

/** Running balance of one account, debits positive. */
export async function accountBalance(account: string): Promise<number> {
  const [row] = await db
    .select({
      balance: sql<number>`COALESCE(SUM(CASE WHEN ${ledgerLines.direction} = 'debit'
                                             THEN ${ledgerLines.amountPaise}
                                             ELSE -${ledgerLines.amountPaise} END), 0)::bigint`,
    })
    .from(ledgerLines)
    .where(eq(ledgerLines.account, account));
  return Number(row?.balance ?? 0);
}
