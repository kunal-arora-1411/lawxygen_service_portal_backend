import { z } from "zod";

/**
 * Typed environment.
 *
 * Validated once, at module load. A missing or malformed value fails the process start —
 * never the first request that happens to need it.
 *
 * Ported from the marketing repo's `lib/env.ts`, minus the browser half: this is a
 * standalone API with no client bundle, so there is no NEXT_PUBLIC split and no Proxy
 * guarding against reads from the browser.
 *
 * Variables belonging to a milestone that has not shipped stay `.optional()`. Each becomes
 * required by removing `.optional()` in the milestone that introduces it — until then,
 * `required()` is what turns absence into an error that names the feature.
 */

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["local", "staging", "production"]).default("local"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** Origin of the portal. Drives CORS. */
  PORTAL_ORIGIN: z.url().default("http://localhost:3000"),

  /**
   * Cookie scope, e.g. `.lawxygen.in` so the session is visible to both app. and api.
   * Left unset locally, where a host-only cookie on localhost is what we want.
   */
  COOKIE_DOMAIN: z.string().optional(),

  // M0 — database
  DATABASE_URL: z.url().optional(),

  // M0 — auth
  SESSION_SECRET: z.string().min(32).optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // M0 — transactional SMS (mobile OTP), DLT-registered templates
  SMS_PROVIDER_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),
  SMS_DLT_TEMPLATE_ID: z.string().optional(),

  // M2 — payments
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Observability
  SENTRY_DSN: z.url().optional(),
});

export type Env = z.infer<typeof schema>;

function format(error: z.ZodError): string {
  return error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment variables:\n${format(parsed.error)}`);
}

export const env: Env = parsed.data;

/**
 * Asserts a variable that is optional at the schema level is actually present. Call it at
 * the point of use, so the failure names the feature rather than surfacing as `undefined`
 * three frames deeper.
 */
export function required<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const value = env[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required environment variable ${String(key)}.`);
  }
  return value;
}
