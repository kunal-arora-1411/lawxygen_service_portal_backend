import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";
import { dispatchPending } from "../../src/modules/events/outbox.js";
import {
  setGatewayOrderCreator,
  setGatewayPaymentLister,
  type GatewayPayment,
} from "../../src/modules/payments/razorpay.js";

/**
 * The webhook that never arrived.
 *
 * Every other safeguard in the payment path protects against a webhook that came and
 * was mishandled. This is the only one that notices silence — and silence is
 * indistinguishable, from inside, from nobody having paid. The client is charged, the
 * order sits in `payment_pending`, nobody is assigned, and the first report is the
 * client asking where their money went.
 *
 * So the test that matters is: skip the webhook entirely, tell the gateway lister the
 * payment happened, and assert the order comes out the far side fully paid — invoice,
 * ledger, assignment and all — exactly as if the webhook had arrived.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 4, prepare: !/-pooler\./.test(url) }) : undefined;

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
const PRICED = { category: "documentation", slug: "joint-venture-agreement" };
const PRICE = 300_000; // ₹3,000

const emails: string[] = [];
const professionalIds: string[] = [];

function cookieOf(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  const list: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.find((c) => c.startsWith("lawxygen_session="))?.split(";")[0] ?? "";
}

async function register(name: string, prefix: string) {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
  emails.push(email);
  const res = await request(app)
    .post("/auth/register")
    .send({
      name,
      email,
      password: "a-sufficiently-long-password",
      phone: `+9179${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
      whatsappConsent: false,
    })
    .expect(201);
  return { email, userId: String(res.body.data.user.id), cookie: cookieOf(res) };
}

async function signIn(email: string) {
  const res = await request(app)
    .post("/auth/login")
    .send({ email, password: "a-sufficiently-long-password" })
    .expect(200);
  return cookieOf(res);
}

async function adminCookie() {
  const { email, userId } = await register("Ops", "rec-admin");
  await sql!`update users set role = 'admin' where id = ${userId}`;
  return signIn(email);
}

async function newProfessional() {
  const { email, userId } = await register("Recon Pro", "rec-pro");
  await sql!`update users set role = 'professional' where id = ${userId}`;
  const [created] = await sql!`
    insert into professionals (user_id, kind, display_name, status, available, concurrent_capacity)
    values (${userId}, 'company_secretary', 'Recon Pro', 'verified', true, 9)
    returning id`;
  const id = String(created!.id);
  professionalIds.push(id);
  await sql!`insert into professional_categories (professional_id, category_id)
             select ${id}, id from categories where slug = ${PRICED.category}`;
  return { id, cookie: await signIn(email) };
}

/** Get as far as a gateway order, then stop. No webhook is sent. */
async function checkoutWithoutWebhook(clientCookie: string) {
  const order = await request(app)
    .post("/orders")
    .set("Cookie", clientCookie)
    .send({ category: PRICED.category, service: PRICED.slug })
    .expect(201);
  const reference = String(order.body.data.reference);

  const intent = await request(app)
    .post(`/payments/${reference}/intent`)
    .set("Cookie", clientCookie)
    .expect(201);

  return { reference, providerOrderId: String(intent.body.data.gatewayOrderId) };
}

function gatewayRow(overrides: Partial<GatewayPayment> & { orderId: string }): GatewayPayment {
  return {
    id: `pay_${randomUUID()}`,
    amountPaise: PRICE,
    currency: "INR",
    status: "captured",
    amountRefundedPaise: 0,
    createdAt: new Date(),
    method: "upi",
    ...overrides,
  };
}

/**
 * Other suites share this database, and their captured payments are genuinely unknown
 * to a stubbed gateway that only reports this suite's. Real deployments have one
 * gateway and no such thing; here the reverse-direction check has to be set aside.
 */
function ours(exceptions: { kind: string }[]): { kind: string }[] {
  return exceptions.filter((e) => e.kind !== "unknown_to_gateway");
}

async function ledgerImbalance(): Promise<number> {
  const [row] = await sql!`select coalesce(sum(case when direction = 'debit'
                                                    then amount_paise else -amount_paise end), 0)::bigint
                           as imbalance from ledger_lines`;
  return Number(row!.imbalance);
}

beforeEach(async () => {
  if (!sql) return;
  setGatewayOrderCreator((input) =>
    Promise.resolve({
      id: `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      amount: input.amountPaise,
      currency: input.currency,
    }),
  );
  setGatewayPaymentLister(() => Promise.resolve([]));

  await sql`update professionals set available = false`;
  await sql`delete from reconciliation_runs`;
  await sql`update services set price_paise = ${PRICE}, turnaround_days = 5, active = true
            where slug = ${PRICED.slug}`;
});

afterAll(async () => {
  if (!sql) return;
  setGatewayOrderCreator(undefined);
  setGatewayPaymentLister(undefined);

  const mine = sql`select id from orders where user_id in
                   (select id from users where email = any(${emails}))`;
  await sql`delete from reconciliation_runs`;
  await sql`delete from outbox_events`;
  await sql`delete from assignments where order_id in (${mine})`;
  await sql`delete from ledger_entries where order_id in (${mine})`;
  await sql`delete from invoices where order_id in (${mine})`;
  await sql`delete from payments where order_id in (${mine})`;
  await sql`delete from orders where id in (${mine})`;
  if (professionalIds.length) {
    await sql`delete from professional_categories where professional_id = any(${professionalIds})`;
    await sql`delete from professionals where id = any(${professionalIds})`;
  }
  if (emails.length) await sql`delete from users where email = any(${emails})`;
  await sql`update services set active = false, price_paise = null, turnaround_days = null
            where slug = ${PRICED.slug}`;
  await sql.end({ timeout: 5 });
  await closeDatabase();
});

suite("reconciliation", () => {
  it("repairs a capture whose webhook never arrived", async () => {
    const pro = await newProfessional();
    const client = await register("Client", "rec-client");
    const { reference, providerOrderId } = await checkoutWithoutWebhook(client.cookie);

    // Exactly the state a lost webhook leaves behind.
    const [before] = await sql!`select status from orders where reference = ${reference}`;
    expect(before!.status).toBe("payment_pending");

    setGatewayPaymentLister(() => Promise.resolve([gatewayRow({ orderId: providerOrderId })]));

    const res = await request(app)
      .post("/admin/reconciliation/run")
      .set("Cookie", await adminCookie())
      .send({})
      .expect(200);

    expect(res.body.data.repairedCount).toBe(1);
    expect(res.body.data.status).toBe("exceptions");
    expect(res.body.data.exceptions[0]).toMatchObject({ kind: "missing_capture", repaired: true });

    // Everything the webhook would have done, done.
    const [after] = await sql!`select status from orders where reference = ${reference}`;
    expect(after!.status).not.toBe("payment_pending");

    const [invoice] = await sql!`select i.number from invoices i join orders o on o.id = i.order_id
                                 where o.reference = ${reference}`;
    expect(String(invoice!.number)).toMatch(/^LX\//);

    expect(await ledgerImbalance()).toBe(0);

    /**
     * And it enters the assignment pipeline like any other payment. Which side of the
     * pipeline it lands on depends on who is available at that instant, and suites
     * sharing this database toggle availability — so the claim here is that the order
     * is in the pipeline at all. Who gets claimed, and the capacity rules around it,
     * are assignment.test.ts's job.
     */
    await dispatchPending();
    const [settled] = await sql!`select status from orders where reference = ${reference}`;
    expect(["paid", "awaiting_assignment", "assigned"]).toContain(String(settled!.status));

    const [assignment] = await sql!`select a.professional_id from assignments a
                                    join orders o on o.id = a.order_id
                                    where o.reference = ${reference}`;
    if (assignment) expect(String(assignment.professional_id)).toBe(pro.id);
  });

  it("is a no-op the second time, because capture is idempotent", async () => {
    await newProfessional();
    const client = await register("Client", "rec-client");
    const { providerOrderId } = await checkoutWithoutWebhook(client.cookie);
    const row = gatewayRow({ orderId: providerOrderId });
    setGatewayPaymentLister(() => Promise.resolve([row]));
    const admin = await adminCookie();

    await request(app).post("/admin/reconciliation/run").set("Cookie", admin).send({}).expect(200);

    const second = await request(app)
      .post("/admin/reconciliation/run")
      .set("Cookie", admin)
      .send({})
      .expect(200);

    expect(second.body.data.repairedCount).toBe(0);
    expect(second.body.data.matchedCount).toBe(1);
    expect(ours(second.body.data.exceptions)).toEqual([]);
    expect(await ledgerImbalance()).toBe(0);
  });

  it("records an amount mismatch and refuses to act on it", async () => {
    const client = await register("Client", "rec-client");
    const { reference, providerOrderId } = await checkoutWithoutWebhook(client.cookie);

    setGatewayPaymentLister(() =>
      Promise.resolve([gatewayRow({ orderId: providerOrderId, amountPaise: PRICE - 100 })]),
    );

    const res = await request(app)
      .post("/admin/reconciliation/run")
      .set("Cookie", await adminCookie())
      .send({})
      .expect(200);

    expect(res.body.data.repairedCount).toBe(0);
    expect(res.body.data.exceptions[0]).toMatchObject({
      kind: "amount_mismatch",
      gatewayPaise: PRICE - 100,
      recordedPaise: PRICE,
    });

    // The order stays unpaid. A job that guesses which figure is right loses money.
    const [order] = await sql!`select status from orders where reference = ${reference}`;
    expect(order!.status).toBe("payment_pending");
  });

  it("flags a payment against an order this system never created", async () => {
    setGatewayPaymentLister(() =>
      Promise.resolve([gatewayRow({ orderId: "order_notoursatall00" })]),
    );

    const res = await request(app)
      .post("/admin/reconciliation/run")
      .set("Cookie", await adminCookie())
      .send({})
      .expect(200);

    expect(res.body.data.exceptions).toContainEqual(
      expect.objectContaining({ kind: "unknown_order" }),
    );
  });

  it("reports clean when the two sides agree", async () => {
    await newProfessional();
    const client = await register("Client", "rec-client");
    const { providerOrderId } = await checkoutWithoutWebhook(client.cookie);

    // The webhook does arrive this time.
    const providerPaymentId = `pay_${randomUUID()}`;
    const raw = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: providerPaymentId,
            order_id: providerOrderId,
            amount: PRICE,
            currency: "INR",
            status: "captured",
            method: "upi",
          },
        },
      },
    });
    await request(app)
      .post("/webhooks/razorpay")
      .set("content-type", "application/json")
      .set("x-razorpay-signature", createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex"))
      .set("x-razorpay-event-id", `evt_${randomUUID()}`)
      .send(raw)
      .expect(200);
    await dispatchPending();

    setGatewayPaymentLister(() =>
      Promise.resolve([gatewayRow({ id: providerPaymentId, orderId: providerOrderId })]),
    );

    const res = await request(app)
      .post("/admin/reconciliation/run")
      .set("Cookie", await adminCookie())
      .send({})
      .expect(200);

    expect(res.body.data).toMatchObject({ matchedCount: 1, repairedCount: 0 });
    expect(ours(res.body.data.exceptions)).toEqual([]);
  });

  it("records a failed run rather than leaving nothing behind", async () => {
    setGatewayPaymentLister(() => Promise.reject(new Error("gateway unreachable")));
    const admin = await adminCookie();

    await request(app).post("/admin/reconciliation/run").set("Cookie", admin).send({}).expect(500);

    // An absent run and a clean run look identical on a screen. They must not.
    const history = await request(app)
      .get("/admin/reconciliation")
      .set("Cookie", admin)
      .expect(200);

    expect(history.body.data[0]).toMatchObject({ status: "failed" });
    expect(String(history.body.data[0].failureReason)).toContain("unreachable");
  });
});
