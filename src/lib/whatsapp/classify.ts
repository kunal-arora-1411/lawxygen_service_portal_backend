import { GraphApiError, GraphNetworkError } from "./graph.js";

/**
 * Deciding what a failed send means.
 *
 * Ported from PingMe (`lib/metaThrottle.ts`). Meta enforces several independent limits
 * and each needs a different reaction:
 *
 * - **130429** Cloud API throughput reached (80 messages/second on a business number,
 *   20 on a coexistence number). Returned as HTTP **400**, so it can only be matched on
 *   the numeric code. Slow the whole number down.
 * - **4** App-level Graph ceiling, shared by every call the app makes.
 * - **80007** The WhatsApp Business Account hit its own rate limit.
 * - **131056** Pair limit — too many messages from this sender to this one recipient.
 *   Other recipients are unaffected, so only that pair backs off.
 * - **131048** Sending restricted after earlier messages were flagged as spam.
 * - **131049** Health-related per-user marketing cap.
 * - **131064 / 130497** Messaging tier limit for the rolling 24-hour window.
 *
 * Throughput and tier limits are different things: a portfolio cleared for thousands of
 * conversations a day is still capped at a few dozen messages a second.
 */

export type ThrottleScope = "number" | "app" | "waba" | "pair";

export type SendFailureKind =
  | "throughput"
  | "app_rate"
  | "waba_rate"
  | "pair_rate"
  | "spam_rate"
  | "messaging_limit"
  | "transient"
  | "permanent"
  | "unknown";

export type SendFailureClassification = {
  kind: SendFailureKind;
  /** True when resending the same message later can still succeed. */
  retryable: boolean;
  /** True when the send never left our process, so nothing was charged. */
  throttled: boolean;
  scope: ThrottleScope | null;
  /** How long to hold back further sends in this scope. */
  cooldownMs: number;
  reason: string;
};

const THROTTLE_CODES: Record<
  number,
  { kind: SendFailureKind; scope: ThrottleScope; cooldownMs: number }
> = {
  4: { kind: "app_rate", scope: "app", cooldownMs: 60_000 },
  80007: { kind: "waba_rate", scope: "waba", cooldownMs: 60_000 },
  130429: { kind: "throughput", scope: "number", cooldownMs: 10_000 },
  131056: { kind: "pair_rate", scope: "pair", cooldownMs: 15 * 60_000 },
};

const PROTECTION_CODES: Record<
  number,
  { kind: SendFailureKind; scope: ThrottleScope; cooldownMs: number }
> = {
  131048: { kind: "spam_rate", scope: "number", cooldownMs: 60 * 60_000 },
  131049: { kind: "spam_rate", scope: "pair", cooldownMs: 24 * 60 * 60_000 },
};

/** Retrying these only burns quota; the send needs a person or a waiting period. */
const MESSAGING_LIMIT_CODES = new Set([131048, 131049, 131064, 130497, 130472]);

export function classifyGraphError(error: unknown): SendFailureClassification {
  /**
   * A request with no response is the one case that must never be retried on its own.
   * Meta may already have the message, so `retryable` is false and the caller records
   * the send as `delivery_unknown` for a person to resolve.
   */
  if (error instanceof GraphNetworkError) {
    return {
      kind: "unknown",
      retryable: false,
      throttled: false,
      scope: null,
      cooldownMs: 0,
      reason: "Graph request outcome is unknown",
    };
  }

  if (!(error instanceof GraphApiError)) {
    return {
      kind: "unknown",
      retryable: false,
      throttled: false,
      scope: null,
      cooldownMs: 0,
      reason: error instanceof Error ? error.message : "Unknown send failure",
    };
  }

  const code = error.metaCode;
  const throttle = code === undefined ? undefined : THROTTLE_CODES[code];
  if (throttle) {
    return {
      kind: throttle.kind,
      retryable: true,
      throttled: true,
      scope: throttle.scope,
      // Meta's own Retry-After wins when it is longer than our default.
      cooldownMs: Math.max(error.retryAfterMs ?? 0, throttle.cooldownMs),
      reason: error.metaDetails ?? error.message,
    };
  }

  if (code !== undefined && MESSAGING_LIMIT_CODES.has(code)) {
    const protection = PROTECTION_CODES[code];
    return {
      kind: protection?.kind ?? "messaging_limit",
      retryable: false,
      throttled: false,
      scope: protection?.scope ?? null,
      cooldownMs: protection?.cooldownMs ?? 0,
      reason: error.metaDetails ?? error.message,
    };
  }

  // A bare 429 with no recognised code is still a throttle.
  if (error.httpStatus === 429) {
    return {
      kind: "app_rate",
      retryable: true,
      throttled: true,
      scope: "app",
      cooldownMs: Math.max(error.retryAfterMs ?? 0, 60_000),
      reason: error.metaDetails ?? error.message,
    };
  }

  if (error.httpStatus >= 500) {
    return {
      kind: "transient",
      retryable: true,
      throttled: false,
      scope: null,
      cooldownMs: error.retryAfterMs ?? 0,
      reason: error.message,
    };
  }

  return {
    kind: "permanent",
    retryable: false,
    throttled: false,
    scope: null,
    cooldownMs: 0,
    reason: error.metaDetails ?? error.message,
  };
}
