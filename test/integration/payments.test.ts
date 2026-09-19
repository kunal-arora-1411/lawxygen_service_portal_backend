import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";
import { deriveAmounts } from "../../src/lib/money.js";
import { setGatewayOrderCreator } from "../../src/modules/payments/razorpay.js";

/**
 * Payments.
 *
 * These are the tests that exist because the failures are expensive and silent. A
 * duplicate webhook that journals twice, a retry that gets swallowed and leaves an
 * order unpaid, a late failure event that un-pays a captured order, an invoice series
 * with a hole in it — none of them show up as an error at the time.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 4, prepare: !/-pooler\./.test(url) }) : undefined;

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
const PRICED = { category: "business-setup", slug: "one-person-company-opc-registration" };
const PRICE = 500_000; // ₹5,000.00

const emails: string[] = [];
const gatewayOrderIds: string[] = [];

async function newClient() {
  const email = `pay-${randomUUID().slice(0, 8)}@example.test`;
  emails.push(email);
  const res = await request(app)
    .post("/auth/register")
    .send({
      name: "Paying Client",
      email,
      password: "a-sufficiently-long-password",
      phone: `+9122${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
      whatsappConsent: false,
    })
    .expect(201);

  const raw = res.headers["set-cookie"];
  const list: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.find((c) => c.startsWith("lawxygen_session="))?.split(";")[0] ?? "";
}

/** Order → gateway intent, returning both references. */
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

function capturedPayload(gatewayOrderId: string, paymentId: string, amount = PRICE) {
  return {
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: gatewayOrderId,
          amount,
          currency: "INR",
          status: "captured",
          method: "upi",
        },
      },
    },
  };
}

/** Signs exactly the bytes that are sent, the way Razorpay does. */
function postWebhook(body: unknown, eventId = `evt_${randomUUID()}`) {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return request(app)
    .post("/webhooks/razorpay")
    .set("content-type", "application/json")
    .set("x-razorpay-signature", signature)
    .set("x-razorpay-event-id", eventId)
    .send(raw);
}

beforeEach(() => {
  // Stand in for Razorpay's Orders API. Each call returns a fresh gateway order id.
  setGatewayOrderCreator((input) => {
    const id = `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    gatewayOrderIds.push(id);
    return Promise.resolve({ id, amount: input.amountPaise, currency: input.currency });
  });
});

beforeAll(async () => {
  if (!sql) return;
  await sql`update services set price_paise = ${PRICE}, turnaround_days = 7, active = true
            where slug = ${PRICED.slug}
              and category_id = (select id from categories where slug = ${PRICED.category})`;
});

afterAll(async () => {
  if (!sql) return;
  setGatewayOrderCreator(undefined);

  // Delete the entries, not the lines. The balance trigger refuses to leave an entry
  // standing with its lines removed — deleting lines directly is exactly the
  // "money vanishes" edit it exists to stop. The FK cascades the lines away.
  const mine = sql`select id from orders where user_id in
                   (select id from users where email = any(${emails}))`;
  await sql`delete from ledger_entries where order_id in (${mine})`;
  await sql`delete from invoices where order_id in (${mine})`;
  await sql`delete from payments where order_id in (${mine})`;
  await sql`delete from orders where id in (${mine})`;
  if (emails.length) await sql`delete from users where email = any(${emails})`;
  if (gatewayOrderIds.length) {
    await sql`delete from webhook_events where payload->'payload'->'payment'->'entity'->>'order_id'
              = any(${gatewayOrderIds})`;
  }

  await sql`update services set active = false, price_paise = null, turnaround_days = null
            where slug = ${PRICED.slug}`;
  await sql.end({ timeout: 5 });
  await closeDatabase();
});

suite("signature verification", () => {
  it("rejects an unsigned request", async () => {
    const res = await request(app)
      .post("/webhooks/razorpay")
      .set("content-type", "application/json")
      .set("x-razorpay-event-id", `evt_${randomUUID()}`)
      .send(JSON.stringify(capturedPayload("order_nope", "pay_nope")));

    expect(res.status).toBe(403);
  });

  it("rejects a wrong signature", async () => {
    const raw = JSON.stringify(capturedPayload("order_nope", "pay_nope"));
    const res = await request(app)
      .post("/webhooks/razorpay")
      .set("content-type", "application/json")
      .set("x-razorpay-signature", createHmac("sha256", "not-the-secret").update(raw).digest("hex"))
      .set("x-razorpay-event-id", `evt_${randomUUID()}`)
      .send(raw);

    expect(res.status).toBe(403);
  });

  /**
   * The reason the webhook route parses a raw body. A signature computed over the
   * original bytes will not match JSON that has been parsed and re-serialised.
   */
  it("rejects a body altered after signing", async () => {
    const original = JSON.stringify(capturedPayload("order_a", "pay_a"));
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(original).digest("hex");
    const tampered = JSON.stringify(capturedPayload("order_a", "pay_a", 100));

    const res = await request(app)
      .post("/webhooks/razorpay")
      .set("content-type", "application/json")
      .set("x-razorpay-signature", signature)
      .set("x-razorpay-event-id", `evt_${randomUUID()}`)
      .send(tampered);

    expect(res.status).toBe(403);
  });
});

suite("capture", () => {
  it("marks the order paid, journals it, and issues an invoice", async () => {
    const cookie = await newClient();
    const { reference, gatewayOrderId } = await startCheckout(cookie);

    const res = await postWebhook(capturedPayload(gatewayOrderId, `pay_${randomUUID()}`));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("processed");

    const order = await request(app).get(`/orders/${reference}`).set("Cookie", cookie).expect(200);
    expect(order.body.data.status).toBe("paid");

    const invoice = await request(app)
      .get(`/payments/${reference}/invoice`)
      .set("Cookie", cookie)
      .expect(200);

    const expected = deriveAmounts(PRICE);
    expect(invoice.body.data.grossPaise).toBe(PRICE);
    expect(invoice.body.data.taxablePaise).toBe(expected.taxablePaise);
    expect(invoice.body.data.gstPaise).toBe(expected.gstPaise);
    expect(invoice.body.data.number).toMatch(/^LX\/\d{4}-\d{2}\/\d{6}$/);
  });

  it("writes lines that balance and match the derived split", async () => {
    const cookie = await newClient();
    const { reference, gatewayOrderId } = await startCheckout(cookie);
    const paymentId = `pay_${randomUUID()}`;

    await postWebhook(capturedPayload(gatewayOrderId, paymentId)).expect(200);

    const lines = await sql!`select l.account, l.direction, l.amount_paise
                             from ledger_lines l
                             join ledger_entries e on e.id = l.entry_id
                             where e.source_ref = ${paymentId}
                             order by l.account`;

    const debits = lines
      .filter((l) => l.direction === "debit")
      .reduce((sum, l) => sum + Number(l.amount_paise), 0);
    const credits = lines
      .filter((l) => l.direction === "credit")
      .reduce((sum, l) => sum + Number(l.amount_paise), 0);

    expect(debits).toBe(credits);
    expect(debits).toBe(PRICE);

    const expected = deriveAmounts(PRICE);
    const byAccount = Object.fromEntries(lines.map((l) => [l.account, Number(l.amount_paise)]));
    expect(byAccount["ASSET:GATEWAY_RECEIVABLE"]).toBe(expected.grossPaise);
    expect(byAccount["LIABILITY:GST_OUTPUT"]).toBe(expected.gstPaise);
    expect(byAccount["INCOME:COMMISSION"]).toBe(expected.commissionPaise);
    expect(byAccount["LIABILITY:PRO_PAYABLE"]).toBe(expected.professionalNetPaise);
    expect(byAccount["LIABILITY:TDS_PAYABLE"]).toBe(expected.tdsPaise);

    void reference;
  });

  it("refuses an amount that disagrees with the order", async () => {
    const cookie = await newClient();
    const { reference, gatewayOrderId } = await startCheckout(cookie);

    // A gateway reporting a different figure is not something to guess about.
    const res = await postWebhook(
      capturedPayload(gatewayOrderId, `pay_${randomUUID()}`, PRICE - 100),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);

    const order = await request(app).get(`/orders/${reference}`).set("Cookie", cookie).expect(200);
    expect(order.body.data.status).toBe("payment_pending");
  });
});

suite("idempotency", () => {
  /** Razorpay retries. The same event id must never be applied twice. */
  it("applies a repeated event exactly once", async () => {
    const cookie = await newClient();
    const { gatewayOrderId } = await startCheckout(cookie);
    const paymentId = `pay_${randomUUID()}`;
    const eventId = `evt_${randomUUID()}`;
    const body = capturedPayload(gatewayOrderId, paymentId);

    const first = await postWebhook(body, eventId);
    const second = await postWebhook(body, eventId);

    expect(first.body.data.status).toBe("processed");
    expect(second.body.data.status).toBe("duplicate");

    const entries = await sql!`select count(*)::int as n from ledger_entries
                               where source_ref = ${paymentId}`;
    expect(entries[0]!.n).toBe(1);
  });

  /** A redelivery with a *different* event id must also not journal twice. */
  it("applies the same capture once even under two different event ids", async () => {
    const cookie = await newClient();
    const { gatewayOrderId } = await startCheckout(cookie);
    const paymentId = `pay_${randomUUID()}`;
    const body = capturedPayload(gatewayOrderId, paymentId);

    await postWebhook(body, `evt_${randomUUID()}`).expect(200);
    await postWebhook(body, `evt_${randomUUID()}`).expect(200);

    const entries = await sql!`select count(*)::int as n from ledger_entries
                               where source_ref = ${paymentId}`;
    const invoiceRows = await sql!`select count(*)::int as n from invoices i
                                   join payments p on p.order_id = i.order_id
                                   where p.provider_order_id = ${gatewayOrderId}`;
    expect(entries[0]!.n).toBe(1);
    expect(invoiceRows[0]!.n).toBe(1);
  });

  it("applies exactly one capture when the same event arrives concurrently", async () => {
    const cookie = await newClient();
    const { gatewayOrderId } = await startCheckout(cookie);
    const paymentId = `pay_${randomUUID()}`;
    const body = capturedPayload(gatewayOrderId, paymentId);

    await Promise.all(Array.from({ length: 5 }, () => postWebhook(body, `evt_${randomUUID()}`)));

    const entries = await sql!`select count(*)::int as n from ledger_entries
                               where source_ref = ${paymentId}`;
    expect(entries[0]!.n).toBe(1);
  });

  /**
   * The bug this guards against: dedupe on *received* rather than *processed* silently
   * drops the retry of an event whose first attempt failed. The order stays unpaid
   * while the gateway dashboard shows delivery succeeded.
   */
  it("still applies a retry whose first attempt failed", async () => {
    const cookie = await newClient();
    const { reference, gatewayOrderId } = await startCheckout(cookie);
    const eventId = `evt_${randomUUID()}`;

    // First attempt fails inside handling: the amount disagrees with the order.
    const failed = await postWebhook(
      capturedPayload(gatewayOrderId, `pay_${randomUUID()}`, PRICE + 1),
      eventId,
    );
    expect(failed.status).toBeGreaterThanOrEqual(400);

    const stored = await sql!`select processed_at, error from webhook_events
                              where event_id = ${eventId}`;
    expect(stored[0]!.processed_at).toBeNull();
    expect(stored[0]!.error).not.toBeNull();

    // The retry carries the same event id and must not be treated as a duplicate.
    const retried = await postWebhook(
      capturedPayload(gatewayOrderId, `pay_${randomUUID()}`),
      eventId,
    );
    expect(retried.status).toBe(200);
    expect(retried.body.data.status).toBe("processed");

    const order = await request(app).get(`/orders/${reference}`).set("Cookie", cookie).expect(200);
    expect(order.body.data.status).toBe("paid");
  });
});

suite("out-of-order delivery", () => {
  /** A late failure for a superseded attempt must not un-pay a captured order. */
  it("does not un-pay an order when payment.failed arrives after payment.captured", async () => {
    const cookie = await newClient();
    const { reference, gatewayOrderId } = await startCheckout(cookie);

    await postWebhook(capturedPayload(gatewayOrderId, `pay_${randomUUID()}`)).expect(200);

    await postWebhook({
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: `pay_${randomUUID()}`,
            order_id: gatewayOrderId,
            amount: PRICE,
            error_code: "BAD_REQUEST_ERROR",
            error_description: "Payment failed",
          },
        },
      },
    }).expect(200);

    const order = await request(app).get(`/orders/${reference}`).set("Cookie", cookie).expect(200);
    expect(order.body.data.status).toBe("paid");
  });

  it("leaves a failed payment retryable and visible to the client", async () => {
    const cookie = await newClient();
    const { reference, gatewayOrderId } = await startCheckout(cookie);

    await postWebhook({
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: `pay_${randomUUID()}`,
            order_id: gatewayOrderId,
            amount: PRICE,
            error_code: "GATEWAY_ERROR",
            error_description: "Card declined",
          },
        },
      },
    }).expect(200);

    const order = await request(app).get(`/orders/${reference}`).set("Cookie", cookie).expect(200);
    expect(order.body.data.status).toBe("payment_failed");

    // And it can still be paid: a declined card is not a closed order.
    await postWebhook(capturedPayload(gatewayOrderId, `pay_${randomUUID()}`)).expect(200);
    const after = await request(app).get(`/orders/${reference}`).set("Cookie", cookie).expect(200);
    expect(after.body.data.status).toBe("paid");
  });

  it("records an unknown gateway order without failing", async () => {
    const res = await postWebhook(capturedPayload("order_never_created", `pay_${randomUUID()}`));
    expect(res.status).toBe(200);
  });
});

suite("invoice numbering", () => {
  /** Indian GST requires the series to be gapless within a financial year. */
  it("issues a contiguous series with no gaps or duplicates", async () => {
    const cookie = await newClient();

    const issued: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const { reference, gatewayOrderId } = await startCheckout(cookie);
      await postWebhook(capturedPayload(gatewayOrderId, `pay_${randomUUID()}`)).expect(200);
      const invoice = await request(app)
        .get(`/payments/${reference}/invoice`)
        .set("Cookie", cookie)
        .expect(200);
      issued.push(Number(String(invoice.body.data.number).split("/")[2]));
    }

    const sorted = [...issued].sort((a, b) => a - b);
    expect(new Set(sorted).size).toBe(6);
    for (let i = 1; i < sorted.length; i += 1) expect(sorted[i]! - sorted[i - 1]!).toBe(1);
  });

  /**
   * A failed capture must not burn a number. The allocation is inside the transaction
   * precisely so an abort rolls it back — a PostgreSQL sequence would not.
   */
  it("burns no number when the capture aborts", async () => {
    const cookie = await newClient();

    const before = await sql!`select value from counters where name like 'invoice:%'`;
    const startedAt = before[0] ? Number(before[0].value) : 0;

    const { gatewayOrderId } = await startCheckout(cookie);
    const failed = await postWebhook(
      capturedPayload(gatewayOrderId, `pay_${randomUUID()}`, PRICE + 500),
    );
    expect(failed.status).toBeGreaterThanOrEqual(400);

    const after = await sql!`select value from counters where name like 'invoice:%'`;
    expect(after[0] ? Number(after[0].value) : 0).toBe(startedAt);
  });
});
