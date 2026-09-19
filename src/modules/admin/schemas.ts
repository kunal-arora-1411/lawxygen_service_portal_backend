import { z } from "zod";

/** A reason is required, not optional: every privileged action has to be explicable. */
export const suspendSchema = z.object({
  reason: z.string().trim().min(3, "Give a reason.").max(500),
});

export const orderReferenceSchema = z.object({
  reference: z
    .string()
    .trim()
    .regex(/^LX-\d{6,}$/, "Not an order reference."),
});

const slugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]+$/, "Not a valid slug.")
  .max(160);

export const serviceKeySchema = z.object({
  category: slugSchema,
  slug: slugSchema,
});

/**
 * Prices arrive in **paise**, as integers, because that is what the system stores.
 *
 * Accepting rupees here would mean a decimal crossing the wire and a multiplication
 * somewhere — and money that has been through a float is money that can be a paisa
 * out. The admin UI does the conversion from a validated whole-rupee input.
 *
 * Every field is optional so a partial edit does not have to resend the rest, but
 * `null` is meaningful and distinct from absent: it clears the value.
 */
export const updateServiceSchema = z
  .object({
    pricePaise: z.int().min(0).max(100_000_000).nullable().optional(),
    turnaroundDays: z.int().min(1).max(365).nullable().optional(),
    summary: z.string().trim().max(600).nullable().optional(),
    active: z.boolean().optional(),
    featured: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update." });

export const listServicesQuerySchema = z.object({
  category: slugSchema.optional(),
  q: z.string().trim().min(1).max(120).optional(),
  active: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const listProfessionalsQuerySchema = z.object({
  status: z.enum(["draft", "pending_review", "verified", "suspended", "rejected"]).optional(),
});

export const listOrdersQuerySchema = z.object({
  status: z
    .enum([
      "payment_pending",
      "payment_failed",
      "paid",
      "awaiting_assignment",
      "assigned",
      "assignment_escalated",
      "in_progress",
      "awaiting_client",
      "completed",
      "cancelled",
      "refunded",
    ])
    .optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
