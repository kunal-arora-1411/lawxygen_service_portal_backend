/**
 * Indian financial years.
 *
 * April 1 to March 31, labelled `2026-27`. GST invoice numbering restarts each year and
 * must be gapless within it, so getting the boundary wrong either splits one year's
 * series in two or runs two years together — both of which are the kind of thing that
 * surfaces during an assessment rather than in testing.
 *
 * The boundary is evaluated in **IST**, not in the server's timezone. A capture at
 * 02:00 IST on 1 April is 20:30 UTC on 31 March; a server reasoning in UTC would file
 * it under the previous year and leave a gap at the top of the new one.
 */

const IST_OFFSET_MINUTES = 5 * 60 + 30;

/** The civil date in IST for an instant, as a plain year/month/day. */
function istParts(at: Date): { year: number; month: number; day: number } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** e.g. `2026-27` for anything from 1 April 2026 to 31 March 2027, IST. */
export function financialYearOf(at: Date): string {
  const { year, month } = istParts(at);
  const startYear = month >= 4 ? year : year - 1;
  const endYear = (startYear + 1) % 100;
  return `${String(startYear)}-${String(endYear).padStart(2, "0")}`;
}

/** e.g. `LX/2026-27/000042`. */
export function formatInvoiceNumber(financialYear: string, sequence: number): string {
  return `LX/${financialYear}/${String(sequence).padStart(6, "0")}`;
}
