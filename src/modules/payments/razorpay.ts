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
