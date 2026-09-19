import { describe, expect, it } from "vitest";
import { financialYearOf, formatInvoiceNumber } from "./financial-year.js";

describe("financialYearOf", () => {
  it("runs April to March", () => {
    expect(financialYearOf(new Date("2026-04-01T00:00:00+05:30"))).toBe("2026-27");
    expect(financialYearOf(new Date("2026-12-31T23:59:59+05:30"))).toBe("2026-27");
    expect(financialYearOf(new Date("2027-03-31T23:59:59+05:30"))).toBe("2026-27");
    expect(financialYearOf(new Date("2027-04-01T00:00:00+05:30"))).toBe("2027-28");
  });

  /**
   * The case that motivates evaluating in IST rather than UTC. 20:30 UTC on 31 March is
   * already 02:00 IST on 1 April — the new financial year. A server reasoning in UTC
   * files it under the old one, which both leaves a gap at the top of the new series
   * and appends to a year that has closed.
   */
  it("uses the IST boundary, not the server's", () => {
    // 2027-03-31T19:00Z is 00:30 IST on 1 April — the new year.
    expect(financialYearOf(new Date("2027-03-31T19:00:00Z"))).toBe("2027-28");
    // 2027-03-31T18:00Z is 23:30 IST on 31 March — still the old year.
    expect(financialYearOf(new Date("2027-03-31T18:00:00Z"))).toBe("2026-27");
  });

  it("straddles a century boundary without producing 2099-100", () => {
    expect(financialYearOf(new Date("2099-05-01T00:00:00+05:30"))).toBe("2099-00");
  });

  it("pads a single-digit end year", () => {
    expect(financialYearOf(new Date("2008-06-01T00:00:00+05:30"))).toBe("2008-09");
  });
});

describe("formatInvoiceNumber", () => {
  it("pads the sequence so the series sorts as text", () => {
    expect(formatInvoiceNumber("2026-27", 1)).toBe("LX/2026-27/000001");
    expect(formatInvoiceNumber("2026-27", 142)).toBe("LX/2026-27/000142");
  });
});
