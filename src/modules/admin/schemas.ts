import { z } from "zod";

/** A reason is required, not optional: every privileged action has to be explicable. */
export const suspendSchema = z.object({
  reason: z.string().trim().min(3, "Give a reason.").max(500),
});

export const reassignProfessionalSchema = z.object({
  reference: z
    .string()
    .trim()
    .regex(/^LX-\d{6,}$/, "Not an order reference."),
});
