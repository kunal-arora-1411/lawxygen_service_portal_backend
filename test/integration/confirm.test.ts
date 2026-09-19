import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";
import {
  setGatewayOrderCreator,
  setGatewayPaymentFetcher,
  type GatewayPayment,
} from "../../src/modules/payments/razorpay.js";

/**
 * "I think that worked", said by a browser.
 *
 * The confirm endpoint exists so a client is not left staring at a spinner for the
 * seconds a webhook takes, and so the real path can be walked locally where Razorpay
 * cannot reach localhost. What it must never become is a way to mark an order paid by
 * asking nicely.
 *
 * So the tests here are mostly attacks: an unsigned confirm, a signature lifted from a
 * different order, and a payment for the wrong amount. Each one has to be refused
 * *before* anything is journalled.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 4, prepare: !/-pooler\./.test(url) }) : undefined;

const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? "";
const PRICED = { category: "documentation", slug: "license-agreement" };
const PRICE = 450_000; // ₹4,500

const emails: string[] = [];

function cookieOf(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  const list: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.find((c) => c.startsWith("lawxygen_session="))?.split(";")[0] ?? "";
}

async function register(prefix: string) {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
  emails.push(email);
  const res = await request(app)
    .post("/auth/register")
    .send({
      name: "Confirming Client",
      email,
      password: "a-sufficiently-long-password",
      phone: `+9175${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
      whatsappConsent: false,
    })
    .expect(201);
  return { email, cookie: cookieOf(res) };
}

/** Order plus gateway order, exactly as checkout leaves things before the widget. */
async function startCheckout(cookie: string) {
  const order = await request(app)
    .post("/orders")
    .set("Cookie", cookie)
    .send({ category: PRICED.category, service: PRICED.slug })
    .expect(201);
  const reference = String(order.body.data.reference);

  const intent = await request(app)
    .post(`/payments/${reference}/intent`)
    .set("Cookie", cookie)
    .expect(201);

  return { reference, gatewayOrderId: String(intent.body.data.gatewayOrderId) };
}

/** What Razorpay hands the browser on success. */
function sign(gatewayOrderId: string, paymentId: string): string {
  return createHmac("sha256", KEY_SECRET).update(`${gatewayOrderId}|${paymentId}`).digest("hex");
}

function gatewayPayment(over: Partial<GatewayPayment> & { orderId: string }): GatewayPayment {
  return {
    id: `pay_${randomUUID().slice(0, 12)}`,
    amountPaise: PRICE,
    currency: "INR",
    status: "captured",
    amountRefundedPaise: 0,
    createdAt: new Date(),
    method: "card",
    ...over,
  };
}

async function ledgerEntryCount(): Promise<number> {
  const [row] = await sql!`select count(*)::int as n from ledger_entries`;
  return Number(row!.n);
}

beforeEach(() => {
  if (!sql) return;
  setGatewayOrderCreator((input) =>
    Promise.resolve({
      id: `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      amount: input.amountPaise,
      currency: input.currency,
    }),
  );
});

afterAll(async () => {
  if (!sql) return;
  setGatewayOrderCreator(undefined);
  setGatewayPaymentFetcher(undefined);

  const mine = sql`select id from orders where user_id in
                   (select id from users where email = any(${emails}))`;
  await sql`delete from outbox_events`;
  await sql`delete from assignments where order_id in (${mine})`;
  await sql`delete from ledger_entries where order_id in (${mine})`;
  await sql`delete from invoices where order_id in (${mine})`;
  await sql`delete from payments where order_id in (${mine})`;
  await sql`delete from orders where id in (${mine})`;
  if (emails.length) await sql`delete from users where email = any(${emails})`;
  await sql`update services set active = false, price_paise = null, turnaround_days = null
            where slug = ${PRICED.slug}`;
  await sql.end({ timeout: 5 });
  await closeDatabase();
});

suite("confirming a payment from the browser", () => {
  beforeEach(async () => {
    if (!sql) return;
    await sql`update services set price_paise = ${PRICE}, turnaround_days = 6, active = true
              where slug = ${PRICED.slug}`;
  });

  it("applies a genuinely captured payment", async () => {
    const client = await register("cfm-ok");
    const { reference, gatewayOrderId } = await startCheckout(client.cookie);
    const remote = gatewayPayment({ orderId: gatewayOrderId });
    setGatewayPaymentFetcher(() => Promise.resolve(remote));

    const res = await request(app)
      .post(`/payments/${reference}/confirm`)
      .set("Cookie", client.cookie)
      .send({ paymentId: remote.id, signature: sign(gatewayOrderId, remote.id) })
      .expect(200);

    expect(res.body.data.status).toBe("paid");
    expect(String(res.body.data.invoiceNumber)).toMatch(/^LX\//);

    const [order] = await sql!`select status from orders where reference = ${reference}`;
    expect(order!.status).not.toBe("payment_pending");
  });

  it("is idempotent, so a double-click does not journal twice", async () => {
    const client = await register("cfm-twice");
    const { reference, gatewayOrderId } = await startCheckout(client.cookie);
    const remote = gatewayPayment({ orderId: gatewayOrderId });
    setGatewayPaymentFetcher(() => Promise.resolve(remote));
    const body = { paymentId: remote.id, signature: sign(gatewayOrderId, remote.id) };

    await request(app)
      .post(`/payments/${reference}/confirm`)
      .set("Cookie", client.cookie)
      .send(body)
      .expect(200);

    const before = await ledgerEntryCount();

    const second = await request(app)
      .post(`/payments/${reference}/confirm`)
      .set("Cookie", client.cookie)
      .send(body)
      .expect(200);

    expect(second.body.data.status).toBe("paid");
    expect(await ledgerEntryCount()).toBe(before);
  });

  it("refuses an unsigned claim", async () => {
    const client = await register("cfm-unsigned");
    const { reference, gatewayOrderId } = await startCheckout(client.cookie);
    const remote = gatewayPayment({ orderId: gatewayOrderId });
    setGatewayPaymentFetcher(() => Promise.resolve(remote));
    const before = await ledgerEntryCount();

    const res = await request(app)
      .post(`/payments/${reference}/confirm`)
      .set("Cookie", client.cookie)
      .send({ paymentId: remote.id, signature: "0".repeat(64) })
      .expect(403);

    expect(res.body.code).toBe("forbidden");
    expect(await ledgerEntryCount()).toBe(before);

    const [order] = await sql!`select status from orders where reference = ${reference}`;
    expect(order!.status).toBe("payment_pending");
  });

  /**
   * The one that a signature check alone would let through. Pay ₹4,500 for one order,
   * then replay that signed tuple against a second — the signature is valid, and only
   * the gateway-order comparison catches it.
   */
  it("refuses a signature lifted from another order", async () => {
    const client = await register("cfm-lifted");
    const cheap = await startCheckout(client.cookie);
    const target = await startCheckout(client.cookie);

    const remote = gatewayPayment({ orderId: cheap.gatewayOrderId });
    setGatewayPaymentFetcher(() => Promise.resolve(remote));
    const before = await ledgerEntryCount();

    const res = await request(app)
      .post(`/payments/${target.reference}/confirm`)
      .set("Cookie", client.cookie)
      // Signed for the *target* order id, but the payment belongs to the cheap one.
      .send({ paymentId: remote.id, signature: sign(target.gatewayOrderId, remote.id) })
      .expect(409);

    expect(res.body.code).toBe("conflict");
    expect(await ledgerEntryCount()).toBe(before);
  });

  it("refuses a payment for the wrong amount", async () => {
    const client = await register("cfm-amount");
    const { reference, gatewayOrderId } = await startCheckout(client.cookie);
    const remote = gatewayPayment({ orderId: gatewayOrderId, amountPaise: 100 });
    setGatewayPaymentFetcher(() => Promise.resolve(remote));
    const before = await ledgerEntryCount();

    await request(app)
      .post(`/payments/${reference}/confirm`)
      .set("Cookie", client.cookie)
      .send({ paymentId: remote.id, signature: sign(gatewayOrderId, remote.id) })
      .expect(409);

    expect(await ledgerEntryCount()).toBe(before);
  });

  it("says pending for an authorised-but-uncaptured payment", async () => {
    const client = await register("cfm-pending");
    const { reference, gatewayOrderId } = await startCheckout(client.cookie);
    const remote = gatewayPayment({ orderId: gatewayOrderId, status: "authorized" });
    setGatewayPaymentFetcher(() => Promise.resolve(remote));

    const res = await request(app)
      .post(`/payments/${reference}/confirm`)
      .set("Cookie", client.cookie)
      .send({ paymentId: remote.id, signature: sign(gatewayOrderId, remote.id) })
      .expect(200);

    expect(res.body.data.status).toBe("pending");
  });

  it("will not confirm somebody else's order", async () => {
    const owner = await register("cfm-owner");
    const stranger = await register("cfm-stranger");
    const { reference, gatewayOrderId } = await startCheckout(owner.cookie);
    const remote = gatewayPayment({ orderId: gatewayOrderId });
    setGatewayPaymentFetcher(() => Promise.resolve(remote));

    // not_found rather than forbidden: references are sequential, and a 403 confirms
    // the order exists.
    await request(app)
      .post(`/payments/${reference}/confirm`)
      .set("Cookie", stranger.cookie)
      .send({ paymentId: remote.id, signature: sign(gatewayOrderId, remote.id) })
      .expect(404);
  });
});
