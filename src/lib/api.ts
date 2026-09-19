/**
 * The API contract.
 *
 * Every handler and data-access function returns `ApiResult<T>`. The shape is a
 * discriminated union so a failure can be represented without inventing a `T` — narrow on
 * `ok` before touching `data`.
 *
 * This is the single envelope the portal decodes. The portal switches on `code`, never on
 * message text and never on HTTP status alone, so adding a status mapping here cannot
 * silently change client behaviour.
 */

export type ErrorCode =
  /** Not signed in. */
  | "unauthenticated"
  /** Signed in, but not allowed to do this. */
  | "forbidden"
  /** The thing being addressed does not exist, or is not visible to this actor. */
  | "not_found"
  /** Input failed validation. `fieldErrors` carries the per-field detail. */
  | "invalid_input"
  /** The resource changed underneath this request — e.g. a slot was taken first. */
  | "conflict"
  /** Caller is going too fast. */
  | "rate_limited"
  /** A third party (gateway, SMS) failed or timed out. */
  | "upstream_failure"
  /** Anything uncaught. Never surface the raw message to a client. */
  | "internal";

export type ApiFailure = {
  ok: false;
  code: ErrorCode;
  /** Safe to show a user. Says what went wrong and what to do about it. */
  message: string;
  /** Present for `invalid_input`: field name → messages. */
  fieldErrors?: Record<string, string[]>;
};

export type ApiSuccess<T> = { ok: true; data: T };

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

/**
 * The shape of every list endpoint, without exception.
 *
 * Cursor rather than offset, and present from the first endpoint written: retrofitting
 * pagination onto a client that assumed a bare array means editing every call site.
 */
export type Page<T> = { items: T[]; nextCursor: string | null };

export function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

export function fail(
  code: ErrorCode,
  message: string,
  fieldErrors?: Record<string, string[]>,
): ApiFailure {
  return fieldErrors ? { ok: false, code, message, fieldErrors } : { ok: false, code, message };
}

/**
 * Thrown by the authorization helpers and caught at the boundary. Carrying the code on the
 * error lets `authorize()` throw from deep inside a query without every caller threading a
 * result type back up by hand.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { cause?: unknown; fieldErrors?: Record<string, string[]> },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ApiError";
    this.code = code;
    this.fieldErrors = options?.fieldErrors;
  }
}
