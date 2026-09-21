import { env } from "../env.js";

/**
 * Meta's Graph API, over `fetch`.
 *
 * Ported from PingMe (`lib/graph.ts`), which earned the one non-obvious thing in this
 * file the hard way: **Meta signals throttling through the numeric error code, not the
 * HTTP status.** A throughput rejection (130429) arrives as HTTP 400, so status alone
 * cannot tell a retryable throttle from a permanent rejection. Everything that reads
 * these errors must look at `metaCode`.
 */

export class GraphApiError extends Error {
  constructor(
    public metaError: unknown,
    public httpStatus: number,
    public retryAfterMs?: number,
  ) {
    const detail = metaError as { error_user_msg?: string; message?: string } | null;
    super(detail?.error_user_msg ?? detail?.message ?? "Graph API error");
    this.name = "GraphApiError";
  }

  get metaCode(): number | undefined {
    const code = (this.metaError as { code?: unknown } | null)?.code;
    return code === null || code === undefined || code === "" ? undefined : Number(code);
  }

  get metaDetails(): string | undefined {
    return (this.metaError as { error_data?: { details?: string } } | null)?.error_data?.details;
  }

  get fbtraceId(): string | undefined {
    return (this.metaError as { fbtrace_id?: string } | null)?.fbtrace_id;
  }
}

/**
 * The request never got a response.
 *
 * Distinct from `GraphApiError` on purpose: Meta may have accepted the message before
 * the connection dropped, so this outcome is **never** safe to retry automatically.
 */
export class GraphNetworkError extends Error {
  constructor(
    message: string,
    public override cause?: unknown,
  ) {
    super(message);
    this.name = "GraphNetworkError";
  }
}

const TIMEOUT_MS = 30_000;

function base(): string {
  return `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}`;
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.round(seconds * 1000) : undefined;
  const timestamp = Date.parse(headerValue);
  if (Number.isNaN(timestamp)) return undefined;
  const delta = timestamp - Date.now();
  return delta > 0 ? delta : undefined;
}

type GraphResponse = Record<string, unknown> & { error?: unknown };

export async function graphGet(
  path: string,
  token: string,
  fields?: string,
): Promise<GraphResponse> {
  const url = new URL(`${base()}/${path}`);
  if (fields) url.searchParams.set("fields", fields);

  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const json = (await res.json()) as GraphResponse;
  if (!res.ok) {
    throw new GraphApiError(
      json.error,
      res.status,
      parseRetryAfterMs(res.headers.get("retry-after")),
    );
  }
  return json;
}

export async function graphPost(
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<GraphResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${base()}/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    // Deliberately its own type. A timeout or a dropped socket after the bytes went
    // out is not the same as a rejection, and must not be retried blindly.
    throw new GraphNetworkError("Graph request failed before a response was received", error);
  } finally {
    clearTimeout(timeout);
  }

  const json = (await res.json().catch(() => ({}))) as GraphResponse;
  if (!res.ok) {
    throw new GraphApiError(
      json.error,
      res.status,
      parseRetryAfterMs(res.headers.get("retry-after")),
    );
  }
  return json;
}
