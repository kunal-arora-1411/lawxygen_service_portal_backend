import { z } from "zod";

/**
 * Request contracts for the auth module.
 *
 * These schemas are the source of truth for the shape of every auth request. The portal
 * generates its client from them rather than hand-writing a matching interface, which is
 * what stops the two repos drifting.
 */

/**
 * E.164. Indian numbers are `+91` followed by ten digits, but the platform sells overseas
 * incorporation and will see foreign numbers, so the general form is accepted and
 * normalisation to E.164 happens before it ever reaches here.
 */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, "Enter a phone number in international format, e.g. +919876543210.");

export const emailSchema = z.email("Enter a valid email address.").trim().toLowerCase().max(320);

/**
 * Length is the only rule. Composition requirements (a digit, a symbol, a capital) push
 * people towards `Password1!` and are explicitly discouraged by current NIST guidance;
 * the upper bound exists because argon2 hashes whatever it is given and a megabyte-long
 * password is a denial-of-service vector, not a security feature.
 */
export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(128, "Use at most 128 characters.");

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Tell us your name.").max(120),
  email: emailSchema,
  password: passwordSchema,
  phone: phoneSchema,
  /**
   * WhatsApp is Phase 2, but consent is captured now: Meta requires opt-in, and asking
   * every existing user later is a campaign nobody wants to run. Defaults to false —
   * an unticked box is not consent.
   */
  whatsappConsent: z.boolean().default(false),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
});

export const otpRequestSchema = z.object({
  phone: phoneSchema,
});

export const otpVerifySchema = z.object({
  challengeId: z.uuid("That sign-in attempt is not valid. Request a new code."),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the six-digit code."),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type OtpRequestInput = z.infer<typeof otpRequestSchema>;
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;
