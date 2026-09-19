import { describe, expect, it } from "vitest";
import { DEFAULT_MONEY_SETTINGS, deriveAmounts, formatPaise } from "./money.js";

/**
 * The invariant these tests exist for: the parts sum exactly to the gross, for every
 * amount, at every rate. A one-paisa drift is not cosmetic — it is a ledger that does
 * not balance, which is an unexplained variance in a reconciliation report weeks later
 * with no way left to reconstruct which order caused it.
 */

function assertExact(gross: number, settings = DEFAULT_MONEY_SETTINGS): void {
  const b = deriveAmounts(gross, settings);

  expect(b.taxablePaise + b.gstPaise, `GST split of ${String(gross)}`).toBe(gross);
  expect(b.commissionPaise + b.professionalGrossPaise, `commission split of ${String(gross)}`).toBe(
    b.taxablePaise,
  );
  expect(b.tdsPaise + b.professionalNetPaise, `TDS split of ${String(gross)}`).toBe(
    b.professionalGrossPaise,
  );

  // Nothing may be negative, and nothing may exceed what was collected.
  for (const [name, value] of Object.entries(b)) {
    expect(Number.isInteger(value), `${name} must be an integer`).toBe(true);
    expect(value, `${name} must not be negative`).toBeGreaterThanOrEqual(0);
    expect(value, `${name} must not exceed the gross`).toBeLessThanOrEqual(gross);
  }
}

describe("deriveAmounts", () => {
  it("splits a ₹5,000 order the way the ledger will record it", () => {
    const b = deriveAmounts(500_000);

    // 5000 inclusive of 18% GST → 4237.29 taxable + 762.71 GST
    expect(b.taxablePaise).toBe(423_729);
    expect(b.gstPaise).toBe(76_271);
    // 30% commission on the taxable value
    expect(b.commissionPaise).toBe(127_119);
    expect(b.professionalGrossPaise).toBe(296_610);
    // 0.1% withholding under the configured section
    expect(b.tdsPaise).toBe(297);
    expect(b.professionalNetPaise).toBe(296_313);

    assertExact(500_000);
  });

  it("sums exactly for every rupee from ₹1 to ₹2,000", () => {
    for (let rupees = 1; rupees <= 2000; rupees += 1) assertExact(rupees * 100);
  });

  /** Awkward amounts are where naive independent rounding drifts. */
  it("sums exactly for amounts that do not divide cleanly", () => {
    for (const gross of [1, 3, 7, 33, 99, 101, 999, 1_00_001, 33_33_333, 99_99_999]) {
      assertExact(gross);
    }
  });

  it("sums exactly across every plausible rate combination", () => {
    for (const gstBps of [0, 500, 1200, 1800, 2800]) {
      for (const commissionBps of [0, 1000, 2500, 3000, 5000, 10_000]) {
        for (const tdsBps of [0, 10, 100, 200, 1000]) {
          for (const gross of [1, 999, 500_000, 1_234_567]) {
            assertExact(gross, { gstBps, commissionBps, tdsBps, tdsSection: "test" });
          }
        }
      }
    }
  });

  it("handles a free order without dividing by anything", () => {
    const b = deriveAmounts(0);
    expect(b).toMatchObject({ grossPaise: 0, taxablePaise: 0, gstPaise: 0, tdsPaise: 0 });
  });

  it("gives the whole taxable value to the professional at zero commission", () => {
    const b = deriveAmounts(500_000, { ...DEFAULT_MONEY_SETTINGS, commissionBps: 0 });
    expect(b.commissionPaise).toBe(0);
    expect(b.professionalGrossPaise).toBe(b.taxablePaise);
  });

  it("leaves the professional nothing at 100% commission", () => {
    const b = deriveAmounts(500_000, { ...DEFAULT_MONEY_SETTINGS, commissionBps: 10_000 });
    expect(b.professionalGrossPaise).toBe(0);
    expect(b.professionalNetPaise).toBe(0);
  });

  /**
   * §194J at 10% and §194-O at 0.1% differ by a factor of a hundred. Which applies is
   * a CA's determination, so both must work — and the arithmetic must not assume the
   * small one.
   */
  it("works at the §194J rate as well as the §194-O rate", () => {
    const o = deriveAmounts(500_000, { ...DEFAULT_MONEY_SETTINGS, tdsBps: 10 });
    const j = deriveAmounts(500_000, {
      ...DEFAULT_MONEY_SETTINGS,
      tdsBps: 1000,
      tdsSection: "194J",
    });

    expect(o.tdsPaise).toBe(297);
    expect(j.tdsPaise).toBe(29_661);
    assertExact(500_000, { ...DEFAULT_MONEY_SETTINGS, tdsBps: 1000, tdsSection: "194J" });
  });

  it("refuses a non-integer or negative gross rather than rounding it silently", () => {
    expect(() => deriveAmounts(10.5)).toThrow(RangeError);
    expect(() => deriveAmounts(-1)).toThrow(RangeError);
    expect(() => deriveAmounts(Number.NaN)).toThrow(RangeError);
  });
});

describe("formatPaise", () => {
  it("formats in Indian digit grouping", () => {
    expect(formatPaise(500_000)).toBe("₹5,000.00");
    expect(formatPaise(1_23_45_678)).toBe("₹1,23,456.78");
    expect(formatPaise(5)).toBe("₹0.05");
    expect(formatPaise(0)).toBe("₹0.00");
  });

  it("keeps the sign outside the symbol for a refund", () => {
    expect(formatPaise(-500_000)).toBe("-₹5,000.00");
  });
});
