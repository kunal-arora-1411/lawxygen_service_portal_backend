import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { ApiError, fail, ok, type ApiResult, type ErrorCode } from "./api.js";
import { logger } from "./logger.js";

/**
 * The boundary between `ApiResult` and HTTP.
 *
 * The status code is derived from `code`, never chosen at the call site, so the mapping
 * exists in exactly one place and a handler cannot invent a status the portal does not
 * expect. The portal switches on `code` regardless — status is for proxies, caches and
 * humans reading logs.
 */

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  rate_limited: 429,
  upstream_failure: 502,
  internal: 500,
};

export function sendResult<T>(res: Response, result: ApiResult<T>, successStatus = 200): void {
  res.status(result.ok ? successStatus : STATUS[result.code]).json(result);
}

/**
 * Wraps a handler that returns data.
 *
 * The handler returns `T` and throws `ApiError` for anything the caller should see; it
 * never touches `res`. Rejections propagate to `errorHandler` rather than becoming an
 * unhandled rejection — which is the whole reason `no-floating-promises` is an error in
 * this project.
 */
export function handler<T>(
  fn: (req: Parameters<RequestHandler>[0], res: Response) => Promise<T> | T,
  successStatus = 200,
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      try {
        sendResult(res, ok(await fn(req, res)), successStatus);
      } catch (error) {
        next(error);
      }
    })();
  };
}

/** Terminal 404 for unmatched routes, in the same envelope as everything else. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  sendResult(res, fail("not_found", "No such endpoint."));
};

/**
 * Terminal error handler.
 *
 * An `ApiError` is a decision the application made and its message is safe to show. A
 * `ZodError` is a validation failure that never reached a handler. Anything else is a bug:
 * it is logged in full and the client is told nothing, because an unplanned error message
 * is exactly where internals leak.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof ApiError) {
    sendResult(res, fail(error.code, error.message, error.fieldErrors));
    return;
  }

  if (error instanceof ZodError) {
    sendResult(res, fail("invalid_input", "Some fields need attention.", fieldErrorsOf(error)));
    return;
  }

  logger.error({ err: error, method: req.method, url: req.originalUrl }, "unhandled error");
  sendResult(res, fail("internal", "Something went wrong. Please try again."));
};

export function fieldErrorsOf(error: ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "(root)";
    (fields[key] ??= []).push(issue.message);
  }
  return fields;
}

/** Throws `invalid_input` carrying per-field detail when the body does not match. */
export function parse<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ApiError("invalid_input", "Some fields need attention.", {
        cause: error,
        fieldErrors: fieldErrorsOf(error),
      });
    }
    throw error;
  }
}
