import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";
import { encryptField } from "../../src/lib/field-encryption.js";
import { deriveAmounts } from "../../src/lib/money.js";
import { dispatchPending } from "../../src/modules/events/outbox.js";
import { setGatewayOrderCreator, setRefundSender } from "../../src/modules/payments/razorpay.js";

/**
 * Giving money back.
 *
 * A refund touches more of the system than a payment does: it un-earns commission,
 * un-collects GST, takes a matter away from whoever was doing it, and claws back a
 * share that may already have been paid out. The invariants worth testing are that
 * the ledger still balances afterwards, that nothing is refunded twice, and that a
 * gateway refusal leaves the books exactly as they were.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 4, prepare: !/-pooler\./.test(url) }) : undefined;

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
const PRICED = { category: "tax-compliance", slug: "12a-registration" };
const PRICE = 500_000; // ₹5,000

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
      phone: `+9178${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
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
  const { email, userId } = await register("Ops", "ref-admin");
  await sql!`update users set role = 'admin' where id = ${userId}`;
  return signIn(email);
}

async function newProfessional() {
  const { email, userId } = await register("Refundable Pro", "ref-pro");
  await sql!`update users set role = 'professional' where id = ${userId}`;

  const [created] = await sql!`
    insert into professionals (user_id, kind, display_name, status, available, concurrent_capacity)
    values (${userId}, 'chartered_accountant', 'Refundable Pro', 'verified', true, 9)
    returning id`;
  const id = String(created!.id);
  professionalIds.push(id);

  await sql!`insert into professional_categories (professional_id, category_id)
             select ${id}, id from categories where slug = ${PRICED.category}`;
  await sql!`insert into payout_identities
               (professional_id, pan_encrypted, account_number_encrypted, ifsc,
                account_holder_name, account_last4)
             values (${id}, ${encryptField("ABCDE1234F")}, ${encryptField("000123456789")},
                     'HDFC0001234', 'Refundable Pro', '6789')`;

  return { id, cookie: await signIn(email) };
}

/** Pay for one service. Returns the order reference and the gateway's payment id. */
async function payOnce(clientCookie: string) {
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

  const providerPaymentId = `pay_${randomUUID()}`;
  const raw = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: providerPaymentId,
          order_id: String(intent.body.data.gatewayOrderId),
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
  return { reference, providerPaymentId };
}

async function ledgerImbalance(): Promise<number> {
  const [row] = await sql!`select coalesce(sum(case when direction = 'debit'
                                                    then amount_paise else -amount_paise end), 0)::bigint
                           as imbalance from ledger_lines`;
  return Number(row!.imbalance);
}

/** What the ledger says one professional is owed, net of everything. */
async function owedTo(professionalId: string): Promise<number> {
  const [row] = await sql!`
    select coalesce(sum(case when direction = 'credit'
                             then amount_paise else -amount_paise end), 0)::bigint as owed
    from ledger_lines
    where subject_id = ${professionalId} and account = 'LIABILITY:PRO_PAYABLE'`;
  return Number(row!.owed);
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
  setRefundSender(() => Promise.resolve({ providerRef: `rfnd_${randomUUID().slice(0, 8)}` }));

  // Nobody else's professional may claim this suite's orders.
  await sql`update professionals set available = false`;
  await sql`update services set price_paise = ${PRICE}, turnaround_days = 7, active = true
            where slug = ${PRICED.slug}`;
});

afterAll(async () => {
  if (!sql) return;
  setGatewayOrderCreator(undefined);
  setRefundSender(undefined);

  const mine = sql`select id from orders where user_id in
                   (select id from users where email = any(${emails}))`;
  await sql`delete from outbox_events`;
  await sql`delete from assignments where order_id in (${mine})`;
  await sql`delete from ledger_entries where order_id in (${mine})`;
  await sql`delete from invoices where order_id in (${mine})`;
  await sql`delete from payments where order_id in (${mine})`;
  await sql`delete from orders where id in (${mine})`;
  if (professionalIds.length) {
    await sql`delete from payout_identities where professional_id = any(${professionalIds})`;
    await sql`delete from professional_categories where professional_id = any(${professionalIds})`;
    await sql`delete from professionals where id = any(${professionalIds})`;
  }
  if (emails.length) await sql`delete from users where email = any(${emails})`;
  await sql`update services set active = false, price_paise = null, turnaround_days = null
            where slug = ${PRICED.slug}`;
  await sql.end({ timeout: 5 });
  await closeDatabase();
});

suite("refunding an assigned order", () => {
  it("returns the gross, unwinds every component, and releases the professional", async () => {
    const pro = await newProfessional();
    const client = await register("Client", "ref-client");
    const { reference } = await payOnce(client.cookie);

    const amounts = deriveAmounts(PRICE);
    expect(await owedTo(pro.id)).toBe(amounts.professionalNetPaise);

    const res = await request(app)
      .post(`/admin/orders/${reference}/refund`)
      .set("Cookie", await adminCookie())
      .send({ reason: "Client withdrew before work started" })
      .expect(200);

    expect(res.body.data).toMatchObject({
      reference,
      amountPaise: PRICE,
      professionalClawedBack: true,
    });

    // The whole point: the books still balance after money goes back out.
    expect(await ledgerImbalance()).toBe(0);

    // Nobody is owed for a matter that was refunded.
    expect(await owedTo(pro.id)).toBe(0);

    const [order] = await sql!`select status from orders where reference = ${reference}`;
    expect(order!.status).toBe("refunded");

    const [payment] = await sql!`select p.status from payments p
                                 join orders o on o.id = p.order_id
                                 where o.reference = ${reference} and p.status <> 'created'`;
    expect(payment!.status).toBe("refunded");

    const [assignment] = await sql!`select a.status, a.closed_reason from assignments a
                                    join orders o on o.id = a.order_id
                                    where o.reference = ${reference}`;
    expect(assignment!.status).toBe("revoked");
    expect(String(assignment!.closed_reason)).toContain("withdrew");

    // The refund journal reverses the capture exactly, so GST and commission
    // net to nothing across the pair.
    const [gst] = await sql!`
      select coalesce(sum(case when l.direction = 'credit'
                               then l.amount_paise else -l.amount_paise end), 0)::bigint as bal
      from ledger_lines l
      join ledger_entries e on e.id = l.entry_id
      join orders o on o.id = e.order_id
      where o.reference = ${reference} and l.account = 'LIABILITY:GST_OUTPUT'`;
    expect(Number(gst!.bal)).toBe(0);
  });

  it("refuses a second time", async () => {
    await newProfessional();
    const client = await register("Client", "ref-client");
    const { reference } = await payOnce(client.cookie);
    const admin = await adminCookie();

    await request(app)
      .post(`/admin/orders/${reference}/refund`)
      .set("Cookie", admin)
      .send({ reason: "Duplicate order" })
      .expect(200);

    const again = await request(app)
      .post(`/admin/orders/${reference}/refund`)
      .set("Cookie", admin)
      .send({ reason: "Duplicate order" })
      .expect(409);

    expect(again.body.code).toBe("conflict");
    expect(await ledgerImbalance()).toBe(0);
  });

  it("clawing back an already-paid professional leaves them owing, not the pool", async () => {
    const pro = await newProfessional();
    const client = await register("Client", "ref-client");
    const { reference } = await payOnce(client.cookie);
    const amounts = deriveAmounts(PRICE);

    // Stand in for a released payout: the liability to them is settled.
    const [entry] = await sql!`insert into ledger_entries (kind, source_ref, currency, memo)
                               values ('payout', ${`test:${randomUUID()}`}, 'INR', 'Simulated payout')
                               returning id`;
    await sql!`insert into ledger_lines (entry_id, account, direction, amount_paise, subject_id)
               values (${String(entry!.id)}, 'LIABILITY:PRO_PAYABLE', 'debit',
                       ${amounts.professionalNetPaise}, ${pro.id}),
                      (${String(entry!.id)}, 'ASSET:BANK', 'credit',
                       ${amounts.professionalNetPaise}, null)`;
    expect(await owedTo(pro.id)).toBe(0);

    await request(app)
      .post(`/admin/orders/${reference}/refund`)
      .set("Cookie", await adminCookie())
      .send({ reason: "Work was never delivered" })
      .expect(200);

    // Negative on purpose. The next batch nets it off; it is not silently absorbed.
    expect(await owedTo(pro.id)).toBe(-amounts.professionalNetPaise);
    expect(await ledgerImbalance()).toBe(0);

    const payable = await request(app)
      .get("/admin/payouts/payable")
      .set("Cookie", await adminCookie())
      .expect(200);
    expect(
      (payable.body.data as { professionalId: string }[]).some((r) => r.professionalId === pro.id),
    ).toBe(false);

    // Entry first: the lines cascade, and deleting them on their own trips the
    // deferred "an entry has lines" trigger at commit.
    await sql!`delete from ledger_entries where id = ${String(entry!.id)}`;
  });

  it("balances when nobody ever took the matter", async () => {
    // No professional is available, so the order parks unassigned.
    const client = await register("Client", "ref-client");
    const { reference } = await payOnce(client.cookie);

    const res = await request(app)
      .post(`/admin/orders/${reference}/refund`)
      .set("Cookie", await adminCookie())
      .send({ reason: "Nobody could take it" })
      .expect(200);

    expect(res.body.data.professionalClawedBack).toBe(false);
    expect(await ledgerImbalance()).toBe(0);
  });

  it("journals nothing when the gateway refuses", async () => {
    await newProfessional();
    const client = await register("Client", "ref-client");
    const { reference } = await payOnce(client.cookie);

    const before = await sql!`select count(*)::int as n from ledger_entries`;
    setRefundSender(() => Promise.reject(new Error("gateway down")));

    await request(app)
      .post(`/admin/orders/${reference}/refund`)
      .set("Cookie", await adminCookie())
      .send({ reason: "Client asked" })
      .expect(500);

    const after = await sql!`select count(*)::int as n from ledger_entries`;
    expect(after[0]!.n).toBe(before[0]!.n);

    const [order] = await sql!`select status from orders where reference = ${reference}`;
    expect(order!.status).not.toBe("refunded");
  });
});
