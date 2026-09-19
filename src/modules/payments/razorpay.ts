import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "../../lib/api.js";
import { env, required } from "../../lib/env.js";

/**
 * Razorpay, over `fetch`.
 *
 * No SDK: the two calls needed here are ordinary HTTP with basic auth, and a payment
 * integration is the last place to accept a dependency whose behaviour is not obvious
 * from reading this file.
 */

const API = "https://api.razorpay.com/v1";

export type CreatedGatewayOrder = { id: string; amount: number; currency: string };

/** Creates the gateway order the checkout widget opens against. Replaced in tests. */
export type CreateGatewayOrder = (input: {
  amountPaise: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}) => Promise<CreatedGatewayOrder>;

const liveCreateOrder: CreateGatewayOrder = async (input) => {
  const auth = Buffer.from(
    `${required("RAZORPAY_KEY_ID")}:${required("RAZORPAY_KEY_SECRET")}`,
  ).toString("base64");

  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes ?? {},
      // Capture automatically: a separately authorised payment that is never captured
      // is money held against the client's card that reaches nobody.
      payment_capture: 1,
    }),
  });

  if (!res.ok) {
    throw new ApiError("upstream_failure", "Could not start the payment. Please try again.", {
      cause: new Error(`Razorpay responded ${String(res.status)}: ${await res.text()}`),
    });
  }

  const body = (await res.json()) as { id?: string; amount?: number; currency?: string };
  if (!body.id) {
    throw new ApiError("upstream_failure", "Could not start the payment. Please try again.");
  }
  return {
    id: body.id,
    amount: body.amount ?? input.amountPaise,
    currency: body.currency ?? "INR",
  };
};

let createOrderImpl: CreateGatewayOrder = liveCreateOrder;

/** Test seam. Pass undefined to restore the live client. */
export function setGatewayOrderCreator(override: CreateGatewayOrder | undefined): void {
  createOrderImpl = override ?? liveCreateOrder;
}

export function createGatewayOrder(
  input: Parameters<CreateGatewayOrder>[0],
): Promise<CreatedGatewayOrder> {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    // A deployment that never configured payments, not a fault in this request.
    throw new ApiError("upstream_failure", "Payments are not available right now.");
  }
  return createOrderImpl(input);
}

/**
 * Verifies a webhook signature.
 *
 * HMAC-SHA256 of the **raw request body** with the webhook secret. Raw matters: JSON
 * re-serialised after parsing differs from what Razorpay signed — key order, spacing,
 * unicode escaping — and the signature would never match. That is why the webhook route
 * is mounted with a raw body parser ahead of `express.json()`.
 *
 * Compared in constant time. A byte-by-byte early return leaks the expected signature
 * to anyone willing to measure, one character at a time.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;

  const expected = createHmac("sha256", required("RAZORPAY_WEBHOOK_SECRET"))
    .update(rawBody)
    .digest("hex");

  const provided = Buffer.from(signature, "utf8");
  const computed = Buffer.from(expected, "utf8");
  if (provided.length !== computed.length) return false;
  return timingSafeEqual(provided, computed);
}

/** The slice of a Razorpay webhook this system acts on. */
export type RazorpayWebhook = {
  event: string;
  payload: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        currency?: string;
        status?: string;
        method?: string;
        error_code?: string | null;
        error_description?: string | null;
      };
    };
  };
};

export function parseWebhook(rawBody: Buffer): RazorpayWebhook {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new ApiError("invalid_input", "Malformed webhook body.");
  }

  const body = parsed as RazorpayWebhook;
  if (typeof body.event !== "string") {
    throw new ApiError("invalid_input", "Webhook body has no event.");
  }
  return body;
}

/**
 * Refunding a captured payment.
 *
 * Called before the ledger is touched: journalling a refund the gateway never accepted
 * would have the books claim money went back when it did not.
 */
export type RefundResult = { providerRef: string };

export type SendRefund = (input: {
  providerPaymentId: string;
  amountPaise: number;
  reason: string;
}) => Promise<RefundResult>;

const liveRefund: SendRefund = async (input) => {
  const auth = Buffer.from(
    `${required("RAZORPAY_KEY_ID")}:${required("RAZORPAY_KEY_SECRET")}`,
  ).toString("base64");

  const res = await fetch(`${API}/payments/${input.providerPaymentId}/refund`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({
      amount: input.amountPaise,
      // Razorpay dedupes on this, so the same approval retried does not refund twice.
      notes: { reason: input.reason },
      speed: "normal",
    }),
  });

  if (!res.ok) {
    throw new ApiError("upstream_failure", "The gateway refused the refund.", {
      cause: new Error(`Razorpay responded ${String(res.status)}: ${await res.text()}`),
    });
  }

  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new ApiError("upstream_failure", "The gateway refused the refund.");
  return { providerRef: body.id };
};

let refundImpl: SendRefund = liveRefund;

/** Test seam. Pass undefined to restore the live client. */
export function setRefundSender(override: SendRefund | undefined): void {
  refundImpl = override ?? liveRefund;
}

export function sendRefund(input: Parameters<SendRefund>[0]): Promise<RefundResult> {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new ApiError("upstream_failure", "Refunds are not available right now.");
  }
  return refundImpl(input);
}

/**
 * Asking the gateway what it thinks happened.
 *
 * Used by reconciliation, and only there. The webhook remains the source of truth for
 * a payment in the normal case; this is the fallback for when the webhook never came.
 */
export type GatewayPayment = {
  id: string;
  orderId: string | null;
  amountPaise: number;
  currency: string;
  status: string;
  amountRefundedPaise: number;
  createdAt: Date;
  method: string | null;
};

export type ListGatewayPayments = (window: { from: Date; to: Date }) => Promise<GatewayPayment[]>;

type RazorpayPaymentRow = {
  id: string;
  order_id?: string | null;
  amount: number;
  currency: string;
  status: string;
  amount_refunded?: number;
  created_at: number;
  method?: string | null;
};

const liveList: ListGatewayPayments = async ({ from, to }) => {
  const auth = Buffer.from(
    `${required("RAZORPAY_KEY_ID")}:${required("RAZORPAY_KEY_SECRET")}`,
  ).toString("base64");

  const collected: GatewayPayment[] = [];
  const count = 100;

  // Razorpay caps a page at 100 and offers no cursor, so this walks `skip`. Bounded
  // at 50 pages: a window with 5,000 payments in it is a different conversation, and
  // an unbounded loop against a paging bug is how a job spins forever.
  for (let skip = 0; skip < count * 50; skip += count) {
    const query = new URLSearchParams({
      from: String(Math.floor(from.getTime() / 1000)),
      to: String(Math.floor(to.getTime() / 1000)),
      count: String(count),
      skip: String(skip),
    });

    const res = await fetch(`${API}/payments?${query.toString()}`, {
      headers: { authorization: `Basic ${auth}` },
    });

    if (!res.ok) {
      throw new ApiError("upstream_failure", "Could not read payments from the gateway.", {
        cause: new Error(`Razorpay responded ${String(res.status)}: ${await res.text()}`),
      });
    }

    const body = (await res.json()) as { items?: RazorpayPaymentRow[] };
    const items = body.items ?? [];

    for (const item of items) {
      collected.push({
        id: item.id,
        orderId: item.order_id ?? null,
        amountPaise: item.amount,
        currency: item.currency,
        status: item.status,
        amountRefundedPaise: item.amount_refunded ?? 0,
        createdAt: new Date(item.created_at * 1000),
        method: item.method ?? null,
      });
    }

    if (items.length < count) break;
  }

  return collected;
};

let listImpl: ListGatewayPayments = liveList;

/** Test seam. Pass undefined to restore the live client. */
export function setGatewayPaymentLister(override: ListGatewayPayments | undefined): void {
  listImpl = override ?? liveList;
}

export function listGatewayPayments(window: { from: Date; to: Date }): Promise<GatewayPayment[]> {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new ApiError("upstream_failure", "The gateway is not configured.");
  }
  return listImpl(window);
}

/**
 * Reading one payment back.
 *
 * Used when the browser claims a payment succeeded. The claim itself is worthless —
 * anyone can post it — but it is a good reason to go and ask.
 */
export type FetchGatewayPayment = (paymentId: string) => Promise<GatewayPayment | null>;

const liveFetchPayment: FetchGatewayPayment = async (paymentId) => {
  const auth = Buffer.from(
    `${required("RAZORPAY_KEY_ID")}:${required("RAZORPAY_KEY_SECRET")}`,
  ).toString("base64");

  const res = await fetch(`${API}/payments/${paymentId}`, {
    headers: { authorization: `Basic ${auth}` },
  });

  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) {
    throw new ApiError("upstream_failure", "Could not confirm the payment with the gateway.", {
      cause: new Error(`Razorpay responded ${String(res.status)}: ${await res.text()}`),
    });
  }

  const item = (await res.json()) as RazorpayPaymentRow;
  return {
    id: item.id,
    orderId: item.order_id ?? null,
    amountPaise: item.amount,
    currency: item.currency,
    status: item.status,
    amountRefundedPaise: item.amount_refunded ?? 0,
    createdAt: new Date(item.created_at * 1000),
    method: item.method ?? null,
  };
};

let fetchPaymentImpl: FetchGatewayPayment = liveFetchPayment;

/** Test seam. Pass undefined to restore the live client. */
export function setGatewayPaymentFetcher(override: FetchGatewayPayment | undefined): void {
  fetchPaymentImpl = override ?? liveFetchPayment;
}

export function fetchGatewayPayment(paymentId: string): Promise<GatewayPayment | null> {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new ApiError("upstream_failure", "Payments are not available right now.");
  }
  return fetchPaymentImpl(paymentId);
}

/**
 * Verifies the signature Checkout hands the browser on success.
 *
 * Razorpay signs `<gateway order id>|<payment id>` with the key secret. Checking it
 * proves the browser is relaying something Razorpay actually said rather than a
 * fabrication — but it proves nothing about the payment's *state*, which is why the
 * confirm path goes on to ask the gateway directly. This is a cheap filter in front of
 * an expensive call, not a substitute for it.
 */
export function verifyCheckoutSignature(
  gatewayOrderId: string,
  paymentId: string,
  signature: string,
): boolean {
  const secret = env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;

  const expected = createHmac("sha256", secret)
    .update(`${gatewayOrderId}|${paymentId}`)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
