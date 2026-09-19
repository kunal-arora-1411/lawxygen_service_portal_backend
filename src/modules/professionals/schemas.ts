import { z } from "zod";

/**
 * What an applicant may send.
 *
 * The Indian identifier formats are checked here rather than trusted, because every
 * one of them is copied off a card by hand and a transposed character in an IFSC sends
 * money to the wrong bank. None of these checks prove the identifier is *real* — only
 * that it is shaped like one, which is the difference between catching a typo and
 * catching a lie. Verification against the public registers is admin's job.
 */

/** Five letters, four digits, one letter. The fourth letter encodes holder type. */
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Two-digit state code, a PAN, an entity digit, 'Z', then a checksum character. */
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

/** Four letters, a mandatory zero, then six alphanumerics. */
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export const applySchema = z.object({
  kind: z.enum(["chartered_accountant", "company_secretary", "advocate"]),
  displayName: z.string().trim().min(2).max(120),
  headline: z.string().trim().max(160).optional(),
  city: z.string().trim().max(80).optional(),
  /** Category slugs. At least one, or there is nothing they can be assigned. */
  categories: z.array(z.string().trim().min(1)).min(1).max(10),
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  headline: z.string().trim().max(160).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  categories: z.array(z.string().trim().min(1)).min(1).max(10).optional(),
  /**
   * Capacity is the professional's own call, within a ceiling. Assignment is
   * automatic, so an uncapped professional absorbs everything that arrives while
   * others are briefly busier.
   */
  concurrentCapacity: z.coerce.number().int().min(1).max(50).optional(),
});

export const credentialSchema = z.object({
  /** ICAI, ICSI, or the state Bar Council. Free text: there are 25 bar councils. */
  body: z.string().trim().min(2).max(80),
  registrationNumber: z.string().trim().min(3).max(40),
});

export const payoutIdentitySchema = z.object({
  pan: z.string().trim().toUpperCase().regex(PAN, "A PAN looks like ABCDE1234F."),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(GSTIN, "That is not a valid GSTIN.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  accountNumber: z
    .string()
    .trim()
    .regex(/^[0-9]{6,20}$/, "An account number is 6 to 20 digits."),
  ifsc: z.string().trim().toUpperCase().regex(IFSC, "An IFSC looks like HDFC0001234."),
  accountHolderName: z.string().trim().min(2).max(120),
});

export const rejectSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
