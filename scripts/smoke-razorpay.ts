import "../src/lib/load-env.js";
import { createGatewayOrder, listGatewayPayments } from "../src/modules/payments/razorpay.js";

/**
 * Proves the live Razorpay adapters work against the configured keys.
 *
 * Not a test: it makes real calls to the gateway. Run it by hand after changing keys
 * or the adapter, `npm run smoke:razorpay`. In test mode it costs nothing and creates
 * an order nobody will ever pay.
 */
const order = await createGatewayOrder({
  amountPaise: 100,
  currency: "INR",
  receipt: `smoke-${String(Date.now())}`,
  notes: { purpose: "adapter smoke test" },
});
console.log("orders API  ->", order.id, order.amount, order.currency);

const payments = await listGatewayPayments({
  from: new Date(Date.now() - 7 * 86_400_000),
  to: new Date(),
});
console.log("payments API ->", payments.length, "payment(s) in the last 7 days");
for (const p of payments.slice(0, 5)) {
  console.log("   ", p.id, p.status, p.amountPaise, p.orderId ?? "(no order)");
}
