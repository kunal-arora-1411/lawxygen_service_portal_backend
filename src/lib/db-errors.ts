/**
 * Reading Postgres error codes through Drizzle.
 *
 * Drizzle wraps driver errors in a `DrizzleQueryError`, so the SQLSTATE that actually
 * matters is on `error.cause`, not on the error itself. Code that checks `error.code`
 * directly silently never matches — and the places that check are exactly the places where
 * failing to match is expensive:
 *
 *   - `23P01` is how an exclusion constraint says "that slot was taken a millisecond ago",
 *     which must become a 409 and not a 500.
 *   - `23505` on `webhook_events.event_id` is how a duplicate gateway callback announces
 *     itself, and it must be swallowed rather than retried.
 *
 * Unwraps a chain rather than a single level, because a driver error can be wrapped more
 * than once depending on where it was caught.
 */

/** SQLSTATE codes this application reacts to by name. */
export const PG = {
  /** unique_violation */
  UNIQUE_VIOLATION: "23505",
  /** exclusion_violation */
  EXCLUSION_VIOLATION: "23P01",
  /** foreign_key_violation */
  FOREIGN_KEY_VIOLATION: "23503",
  /** check_violation */
  CHECK_VIOLATION: "23514",
  /** not_null_violation */
  NOT_NULL_VIOLATION: "23502",
  /** invalid_text_representation — e.g. a value outside an enum */
  INVALID_TEXT_REPRESENTATION: "22P02",
  /** serialization_failure — retryable */
  SERIALIZATION_FAILURE: "40001",
  /** deadlock_detected — retryable */
  DEADLOCK_DETECTED: "40P01",
} as const;

export type PgErrorCode = (typeof PG)[keyof typeof PG];

type MaybePgError = { code?: unknown; constraint_name?: unknown; cause?: unknown };

/** The SQLSTATE for an error thrown by a query, unwrapping Drizzle's wrapper. */
export function pgErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as MaybePgError;
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

/** The name of the violated constraint, when Postgres reported one. */
export function pgConstraintName(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as MaybePgError;
    if (typeof candidate.constraint_name === "string") return candidate.constraint_name;
    current = candidate.cause;
  }
  return undefined;
}

export function isPgError(error: unknown, ...codes: string[]): boolean {
  const code = pgErrorCode(error);
  return code !== undefined && codes.includes(code);
}

/**
 * True when a unique constraint was violated. Pass `constraint` to match one specific
 * index — "this email is taken" and "this webhook was already processed" call for very
 * different responses and must not be conflated.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!isPgError(error, PG.UNIQUE_VIOLATION)) return false;
  return constraint === undefined || pgConstraintName(error) === constraint;
}

/** True when an exclusion constraint refused a write — i.e. the slot is gone. */
export function isExclusionViolation(error: unknown): boolean {
  return isPgError(error, PG.EXCLUSION_VIOLATION);
}

/** True for failures that are worth retrying the transaction for, unchanged. */
export function isRetryable(error: unknown): boolean {
  return isPgError(error, PG.SERIALIZATION_FAILURE, PG.DEADLOCK_DETECTED);
}
