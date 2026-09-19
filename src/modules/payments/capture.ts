import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { DOMAIN_EVENTS, invoices, orders, payments } from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { nextCounterValue } from "../../lib/counters.js";
import { financialYearOf, formatInvoiceNumber } from "../../lib/financial-year.js";
import { logger } from "../../lib/logger.js";
import { deriveAmounts, DEFAULT_MONEY_SETTINGS, type MoneySettings } from "../../lib/money.js";
import { emit } from "../events/outbox.js";
import { ACCOUNTS, postEntry, type LedgerLineInput } from "./ledger.js";

/**
 * Applying a confirmed payment.
 *
 * One transaction covers the order status, the ledger entry and the invoice number.
 * They cannot be allowed to disagree: an order marked paid without a ledger entry is
 * money that arrived and was never recorded, and an invoice number allocated outside
 * the transaction is a hole in a series Indian GST requires to be gapless.
 *
 * Idempotency has two independent locks, because this is the one path where being
 * wrong twice costs real money:
 *
 *   1. the order status transition is a conditional UPDATE — only an order still
 *      awaiting payment can become paid, so a replayed webhook matches nothing;
 *   2. `ledger_entries` is unique on (kind, source_ref), so even a bypass of the first
 *      cannot journal the same capture twice.
 */

export type CaptureInput = {
  providerPaymentId: string;
  providerOrderId: string;
  amountPaise: number;
  method?: string | null;
  settings?: MoneySettings;
};

export type CaptureOutcome =
  | { applied: true; orderReference: string; invoiceNumber: string }
  | { applied: false; reason: "already_paid" | "unknown_order" };

export async function applyCapture(input: CaptureInput): Promise<CaptureOutcome> {
  const settings = input.settings ?? DEFAULT_MONEY_SETTINGS;

  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select({ id: payments.id, orderId: payments.orderId, amountPaise: payments.amountPaise })
      .from(payments)
      .where(eq(payments.providerOrderId, input.providerOrderId))
      .limit(1);

    if (!payment) {
      // The gateway order is always recorded before checkout opens, so this means a
      // webhook for something this system did not initiate. Not an error to retry.
      logger.warn({ providerOrderId: input.providerOrderId }, "capture for an unknown order");
      return { applied: false, reason: "unknown_order" };
    }

    /**
     * The atomic claim. Only an order still awaiting payment may become paid, so a
     * duplicate or out-of-order webhook matches zero rows and falls through to the
     * no-op below rather than journalling a second time.
     */
    const [claimed] = await tx
      .update(orders)
      .set({ status: "paid" })
      .where(
        and(
          eq(orders.id, payment.orderId),
          inArray(orders.status, ["payment_pending", "payment_failed"]),
        ),
      )
      .returning({
        id: orders.id,
        reference: orders.reference,
        pricePaise: orders.pricePaise,
        currency: orders.currency,
      });

    if (!claimed) return { applied: false, reason: "already_paid" };

    /**
     * Trust the order, not the webhook, for the amount.
     *
     * The order's snapshot is what the client agreed to. If the gateway reports a
     * different figure, something is wrong enough that guessing is worse than failing:
     * the transaction rolls back and the event is retried rather than journalling an
     * amount nobody authorised.
     */
    if (input.amountPaise !== claimed.pricePaise) {
      throw new ApiError(
        "conflict",
        `Captured amount ${String(input.amountPaise)} does not match order ${claimed.reference} at ${String(claimed.pricePaise)}.`,
      );
    }

    await tx
      .update(payments)
      .set({
        status: "captured",
        providerPaymentId: input.providerPaymentId,
        method: input.method ?? null,
        capturedAt: new Date(),
        errorCode: null,
        errorDescription: null,
      })
      .where(eq(payments.id, payment.id));

    const amounts = deriveAmounts(claimed.pricePaise, settings);

    // Debit what arrived; credit where it is owed. The parts sum exactly to the gross
    // by construction — see deriveAmounts — so this entry always balances.
    await postEntry(tx, {
      kind: "capture",
      sourceRef: input.providerPaymentId,
      orderId: claimed.id,
      currency: claimed.currency,
      memo: `Capture for ${claimed.reference}`,
      lines: (
        [
          {
            account: ACCOUNTS.GATEWAY_RECEIVABLE,
            direction: "debit",
            amountPaise: amounts.grossPaise,
          },
          { account: ACCOUNTS.GST_OUTPUT, direction: "credit", amountPaise: amounts.gstPaise },
          {
            account: ACCOUNTS.COMMISSION,
            direction: "credit",
            amountPaise: amounts.commissionPaise,
          },
          {
            account: ACCOUNTS.PRO_PAYABLE,
            direction: "credit",
            amountPaise: amounts.professionalNetPaise,
          },
          { account: ACCOUNTS.TDS_PAYABLE, direction: "credit", amountPaise: amounts.tdsPaise },
          // A zero-value line would violate ledger_lines_amount_positive, so a component
          // that rounds to nothing is omitted rather than posted as zero.
        ] satisfies LedgerLineInput[]
      ).filter((line) => line.amountPaise > 0),
    });

    /**
     * The invoice number is allocated here, inside the transaction, and only after the
     * capture has been claimed. Allocating earlier — or from a PostgreSQL sequence,
     * which does not roll back — would burn a number whenever anything below failed,
     * and the series has to be gapless.
     */
    const issuedAt = new Date();
    const financialYear = financialYearOf(issuedAt);
    const sequence = await nextCounterValue(`invoice:${financialYear}`, tx);
    const number = formatInvoiceNumber(financialYear, sequence);

    await tx.insert(invoices).values({
      orderId: claimed.id,
      number,
      financialYear,
      sequence,
      grossPaise: amounts.grossPaise,
      taxablePaise: amounts.taxablePaise,
      gstPaise: amounts.gstPaise,
      gstRateBps: settings.gstBps,
      currency: claimed.currency,
      issuedAt,
    });

    /**
     * Emitted in this transaction, acted on outside it.
     *
     * Assignment must not run inline: a capture that failed because no professional
     * was free would roll back a payment that genuinely arrived. The event commits
     * with the money, and the dispatcher picks it up afterwards.
     */
    await emit(tx, {
      name: DOMAIN_EVENTS.ORDER_PAID,
      aggregateType: "order",
      aggregateId: claimed.id,
      payload: { reference: claimed.reference, invoiceNumber: number },
    });

    await emit(tx, {
      name: DOMAIN_EVENTS.ASSIGNMENT_REQUESTED,
      aggregateType: "order",
      aggregateId: claimed.id,
      payload: { reference: claimed.reference },
    });

    return { applied: true, orderReference: claimed.reference, invoiceNumber: number };
  });
}

/**
 * Records a failed attempt.
 *
 * Guarded so a late `payment.failed` for a superseded attempt cannot un-pay an order
 * that has already been captured — webhooks arrive out of order, and this one is
 * legitimate for an order still awaiting payment and dangerous for one that is not.
 *
 * The order moves to `payment_failed`, which the client is *shown* as "payment
 * pending". The distinction is kept because support needs the gateway's error code and
 * the retry path differs.
 */
export async function applyFailure(input: {
  providerOrderId: string;
  providerPaymentId?: string | null;
  errorCode?: string | null;
  errorDescription?: string | null;
}): Promise<{ applied: boolean }> {
  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select({ id: payments.id, orderId: payments.orderId })
      .from(payments)
      .where(eq(payments.providerOrderId, input.providerOrderId))
      .limit(1);

    if (!payment) return { applied: false };

    const [claimed] = await tx
      .update(orders)
      .set({ status: "payment_failed" })
      .where(and(eq(orders.id, payment.orderId), eq(orders.status, "payment_pending")))
      .returning({ id: orders.id });

    // No row means the order has moved on — most often already paid. Record the
    // attempt against the payment for support, but leave the order alone.
    await tx
      .update(payments)
      .set({
        status: claimed ? "failed" : "captured",
        providerPaymentId: input.providerPaymentId ?? null,
        errorCode: input.errorCode ?? null,
        errorDescription: input.errorDescription ?? null,
      })
      .where(and(eq(payments.id, payment.id), eq(payments.status, "created")));

    return { applied: Boolean(claimed) };
  });
}
