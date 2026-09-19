/**
 * Money arithmetic.
 *
 * Every amount is an integer number of paise. Nothing here uses a float: 0.1 + 0.2 is
 * not 0.3, and a rounding error in a ledger is an unexplained variance in a
 * reconciliation report three weeks later.
 *
 * Rates are **basis points** (1 bps = 0.01%), also integers, for the same reason.
 * 18% is 1800; ₹0.1% is 10.
 *
 * The property that matters more than any individual figure: **the parts always sum
 * exactly to the gross.** Each component is derived by rounding, and the last one in
 * each split is the residual rather than another rounded figure, so the total cannot
 * drift by a paisa. A ledger that is off by one will not balance, and a ledger that
 * does not balance stops the capture.
 */

export type Bps = number;

export type MoneySettings = {
  /** Platform commission, taken from the taxable value. Default 30%. */
  commissionBps: Bps;
  /** GST on the supply. Prices are GST-inclusive, per Indian consumer convention. */
  gstBps: Bps;
  /** Withholding on the professional's share. See the section note below. */
  tdsBps: Bps;
  /**
   * Which section the withholding is under. Recorded on every payout so a later
   * reassessment can tell what was applied at the time.
   *
   * **This is an open question for a practising CA.** A marketplace collecting on
   * behalf of professionals is likely an e-commerce operator under §194-O, currently
   * 0.1% of gross — not §194J's 10% on professional fees — and where 194-O applies it
   * displaces 194J for the same transaction. Which one governs *this* arrangement is a
   * determination nobody here can make, so the section and the rate are configuration
   * and every payout records which was used.
   */
  tdsSection: string;
};

export const DEFAULT_MONEY_SETTINGS: MoneySettings = {
  commissionBps: 3000,
  gstBps: 1800,
  tdsBps: 10,
  tdsSection: "194O",
};

export type Breakdown = {
  /** What the client paid. Every other figure is carved out of this. */
  grossPaise: number;
  /** Gross less GST. */
  taxablePaise: number;
  gstPaise: number;
  /** Lawxygen's fee, from the taxable value. */
  commissionPaise: number;
  /** The professional's share before withholding. */
  professionalGrossPaise: number;
  tdsPaise: number;
  /** What actually reaches the professional in a payout run. */
  professionalNetPaise: number;
};

/** Half-up on integers, without going near a float. */
function divideRounded(numerator: number, denominator: number): number {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

function applyBps(amount: number, bps: Bps): number {
  return divideRounded(amount * bps, 10_000);
}

/**
 * Splits a captured amount into its parts.
 *
 * Read the residuals deliberately: `gstPaise` is gross minus taxable rather than a
 * second rounding of the rate, and `professionalGrossPaise` is taxable minus
 * commission. Rounding each part independently would let the pieces sum to one paisa
 * more or less than was actually collected.
 */
export function deriveAmounts(
  grossPaise: number,
  settings: MoneySettings = DEFAULT_MONEY_SETTINGS,
): Breakdown {
  if (!Number.isInteger(grossPaise) || grossPaise < 0) {
    throw new RangeError(`grossPaise must be a non-negative integer, got ${String(grossPaise)}`);
  }

  // Prices are GST-inclusive, so the taxable value is extracted rather than added to.
  const taxablePaise = divideRounded(grossPaise * 10_000, 10_000 + settings.gstBps);
  const gstPaise = grossPaise - taxablePaise;

  const commissionPaise = applyBps(taxablePaise, settings.commissionBps);
  const professionalGrossPaise = taxablePaise - commissionPaise;

  const tdsPaise = applyBps(professionalGrossPaise, settings.tdsBps);
  const professionalNetPaise = professionalGrossPaise - tdsPaise;

  return {
    grossPaise,
    taxablePaise,
    gstPaise,
    commissionPaise,
    professionalGrossPaise,
    tdsPaise,
    professionalNetPaise,
  };
}

/** For display and for invoices. Never used to compute anything. */
export function formatPaise(paise: number, currency = "INR"): string {
  const sign = paise < 0 ? "-" : "";
  const absolute = Math.abs(paise);
  const rupees = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, "0");
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${sign}${symbol}${rupees.toLocaleString("en-IN")}.${remainder}`;
}
