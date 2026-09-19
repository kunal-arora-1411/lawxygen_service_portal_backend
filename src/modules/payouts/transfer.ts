import { randomUUID } from "node:crypto";
import { ApiError } from "../../lib/api.js";
import { env } from "../../lib/env.js";
import { logger } from "../../lib/logger.js";

/**
 * Sending money to a professional.
 *
 * RazorpayX is the intended provider and is not wired up: it needs a business account
 * that does not exist yet. What matters is what happens in the meantime.
 *
 * Locally, the transfer is simulated and says so loudly. Anywhere else it **refuses**.
 * The failure mode to avoid is a deployed environment quietly marking payouts as paid
 * without any money moving — professionals would see "paid", the ledger would show the
 * liability settled, and nobody would notice until somebody asked where their money
 * was. A refusal is recoverable; a false success is not.
 */

export type TransferResult = { providerRef: string };

export type PayoutTransfer = (input: {
  professionalId: string;
  amountPaise: number;
  currency: string;
  reference: string;
}) => Promise<TransferResult>;

const simulate: PayoutTransfer = (input) => {
  logger.warn({ ...input, channel: "payout-stub" }, "PAYOUT SIMULATED — no bank transfer was made");
  return Promise.resolve({ providerRef: `sim_${randomUUID().slice(0, 12)}` });
};

const refuse: PayoutTransfer = () => {
  throw new ApiError("upstream_failure", "Payouts are not configured. No transfer was attempted.");
};

function configured(): PayoutTransfer {
  if (env.RAZORPAYX_KEY_ID && env.RAZORPAYX_KEY_SECRET && env.RAZORPAYX_ACCOUNT) {
    // Wire RazorpayX here. It must confirm the transfer was accepted before
    // returning — an optimistic success is the whole problem this file guards.
    return refuse;
  }

  if (env.APP_ENV === "local") return simulate;

  logger.error("payout requested but RazorpayX is not configured");
  return refuse;
}

let transfer: PayoutTransfer | undefined;

export async function sendPayout(input: Parameters<PayoutTransfer>[0]): Promise<TransferResult> {
  transfer ??= configured();
  return transfer(input);
}

/** Test seam. Pass undefined to restore the configured transfer. */
export function setPayoutTransfer(override: PayoutTransfer | undefined): void {
  transfer = override;
}
