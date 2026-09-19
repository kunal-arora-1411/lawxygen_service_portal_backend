import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";
import { encryptField } from "../../src/lib/field-encryption.js";
import { deriveAmounts } from "../../src/lib/money.js";
import { dispatchPending } from "../../src/modules/events/outbox.js";
import { setPayoutTransfer } from "../../src/modules/payouts/transfer.js";
import { setGatewayOrderCreator } from "../../src/modules/payments/razorpay.js";

/**
 * Paying professionals.
 *
 * The invariants that matter: what is paid equals what the ledger said was owed, the
 * ledger still balances afterwards, the same money cannot go out twice, and a failed
 * transfer leaves the liability standing rather than quietly settling it.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 4, prepare: !/-pooler\./.test(url) }) : undefined;

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
const PRICED = { category: "certifications", slug: "iso-certification" };
const PRICE = 1_000_000; // ₹10,000

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
      phone: `+9177${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
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
  const { email, userId } = await register("Ops", "pay-admin");
  await sql!`update users set role = 'admin' where id = ${userId}`;
  return signIn(email);
}

async function newProfessional(payout = true) {
  const { email, userId } = await register("Payable Pro", "pay-pro");
  await sql!`update users set role = 'professional' where id = ${userId}`;

  const [created] = await sql!`
    insert into professionals (user_id, kind, display_name, status, available, concurrent_capacity)
    values (${userId}, 'chartered_accountant', 'Payable Pro', 'verified', true, 9)
    returning id`;
  const id = String(created!.id);
  professionalIds.push(id);

  await sql!`insert into professional_categories (professional_id, category_id)
             select ${id}, id from categories where slug = ${PRICED.category}`;

  if (payout) {
    await sql!`insert into payout_identities
                 (professional_id, pan_encrypted, account_number_encrypted, ifsc,
                  account_holder_name, account_last4)
               values (${id}, ${encryptField("ABCDE1234F")}, ${encryptField("000123456789")},
                       'HDFC0001234', 'Payable Pro', '6789')`;
  }

  return { id, cookie: await signIn(email) };
}

/** Pay for one service and let the assignment engine attribute it. */
async function earnOnce(clientCookie: string) {
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

  const body = {
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: `pay_${randomUUID()}`,
          order_id: String(intent.body.data.gatewayOrderId),
          amount: PRICE,
          currency: "INR",
          status: "captured",
          method: "upi",
        },
      },
    },
  };
  const raw = JSON.stringify(body);
  await request(app)
    .post("/webhooks/razorpay")
    .set("content-type", "application/json")
    .set("x-razorpay-signature", createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex"))
    .set("x-razorpay-event-id", `evt_${randomUUID()}`)
    .send(raw)
    .expect(200);

  await dispatchPending();
  return reference;
}

async function ledgerImbalance(): Promise<number> {
  const [row] = await sql!`select coalesce(sum(case when direction = 'debit'
                                                    then amount_paise else -amount_paise end), 0)::bigint
                           as imbalance from ledger_lines`;
  return Number(row!.imbalance);
}

beforeEach(async () => {
  if (!sql) return;
  setPayoutTransfer(() => Promise.resolve({ providerRef: `test_${randomUUID().slice(0, 8)}` }));
  setGatewayOrderCreator((input) =>
    Promise.resolve({
      id: `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      amount: input.amountPaise,
      currency: input.currency,
    }),
  );

  // Only this test's professionals are payable, and no earlier batch is outstanding.
  await sql`update professionals set available = false`;
  await sql`delete from payouts`;
  await sql`delete from payout_batches`;
  await sql`update services set price_paise = ${PRICE}, turnaround_days = 9, active = true
            where slug = ${PRICED.slug}`;
});

afterAll(async () => {
  if (!sql) return;
  setPayoutTransfer(undefined);
  setGatewayOrderCreator(undefined);

  const mine = sql`select id from orders where user_id in
                   (select id from users where email = any(${emails}))`;
  await sql`delete from payouts`;
  await sql`delete from payout_batches`;
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

suite("what is payable", () => {
  it("reports exactly what the ledger attributed", async () => {
    const pro = await newProfessional();
    const client = await register("Client", "pay-client");
    await earnOnce(client.cookie);

    const res = await request(app)
      .get("/admin/payouts/payable")
      .set("Cookie", await adminCookie())
      .expect(200);

    const mine = (res.body.data as { professionalId: string; amountPaise: number }[]).find(
      (p) => p.professionalId === pro.id,
    );
    expect(mine?.amountPaise).toBe(deriveAmounts(PRICE).professionalNetPaise);
  });

  /** Nowhere to send it, so including them would produce a batch that cannot finish. */
  it("excludes a professional with no payout identity", async () => {
    const pro = await newProfessional(false);
    const client = await register("Client", "pay-client");
    await earnOnce(client.cookie);

    const res = await request(app)
      .get("/admin/payouts/payable")
      .set("Cookie", await adminCookie())
      .expect(200);

    const ids = (res.body.data as { professionalId: string }[]).map((p) => p.professionalId);
    expect(ids).not.toContain(pro.id);
  });

  it("refuses the whole payout surface to a client", async () => {
    const client = await register("Client", "pay-client");
    for (const path of ["/admin/payouts", "/admin/payouts/payable"]) {
      await request(app).get(path).set("Cookie", client.cookie).expect(403);
    }
  });
});

suite("drafting and releasing", () => {
  it("drafts, releases, and settles the liability exactly", async () => {
    const pro = await newProfessional();
    const client = await register("Client", "pay-client");
    await earnOnce(client.cookie);
    const admin = await adminCookie();

    const owed = deriveAmounts(PRICE).professionalNetPaise;

    const draft = await request(app)
      .post("/admin/payouts/draft")
      .set("Cookie", admin)
      .send({ note: "Weekly run" })
      .expect(201);

    const reference = String(draft.body.data.reference);
    expect(reference).toMatch(/^PO-\d{6}$/);

    const release = await request(app)
      .post(`/admin/payouts/${reference}/release`)
      .set("Cookie", admin)
      .expect(200);

    expect(release.body.data.paid).toBeGreaterThanOrEqual(1);
    expect(release.body.data.failed).toBe(0);

    // The professional is owed nothing further, and the ledger still balances.
    const earnings = await request(app).get("/pro/earnings").set("Cookie", pro.cookie).expect(200);
    expect(earnings.body.data.pendingPaise).toBe(0);
    expect(earnings.body.data.paidPaise).toBe(owed);
    expect(await ledgerImbalance()).toBe(0);
  });

  it("records the withholding section and rate on the payout row", async () => {
    await newProfessional();
    const client = await register("Client", "pay-client");
    await earnOnce(client.cookie);
    const admin = await adminCookie();

    await request(app).post("/admin/payouts/draft").set("Cookie", admin).send({}).expect(201);

    const [row] = await sql!`select tds_paise, tds_section, tds_rate_bps from payouts limit 1`;
    // Recorded rather than recomputed: a statement issued later must say what was
    // applied at the time, not what the settings happen to say then.
    expect(row!.tds_section).toBe("194O");
    expect(Number(row!.tds_rate_bps)).toBe(10);
    expect(Number(row!.tds_paise)).toBe(deriveAmounts(PRICE).tdsPaise);
  });

  /** The same money must not go out twice. */
  it("refuses to release a batch that has already been released", async () => {
    await newProfessional();
    const client = await register("Client", "pay-client");
    await earnOnce(client.cookie);
    const admin = await adminCookie();

    const draft = await request(app)
      .post("/admin/payouts/draft")
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const reference = String(draft.body.data.reference);

    await request(app).post(`/admin/payouts/${reference}/release`).set("Cookie", admin).expect(200);
    const second = await request(app)
      .post(`/admin/payouts/${reference}/release`)
      .set("Cookie", admin);

    expect(second.status).toBe(409);
  });

  it("has nothing left to draft immediately after a release", async () => {
    await newProfessional();
    const client = await register("Client", "pay-client");
    await earnOnce(client.cookie);
    const admin = await adminCookie();

    const draft = await request(app)
      .post("/admin/payouts/draft")
      .set("Cookie", admin)
      .send({})
      .expect(201);
    await request(app)
      .post(`/admin/payouts/${String(draft.body.data.reference)}/release`)
      .set("Cookie", admin)
      .expect(200);

    const again = await request(app).post("/admin/payouts/draft").set("Cookie", admin).send({});
    expect(again.status).toBe(409);
  });

  /**
   * A transfer that fails must leave the debt standing. Marking it paid anyway would
   * settle the ledger for money that never moved, and the professional would be told
   * they had been paid.
   */
  it("leaves the liability intact when the transfer fails", async () => {
    const pro = await newProfessional();
    const client = await register("Client", "pay-client");
    await earnOnce(client.cookie);
    const admin = await adminCookie();

    const owed = deriveAmounts(PRICE).professionalNetPaise;
    setPayoutTransfer(() => Promise.reject(new Error("bank refused the transfer")));

    const draft = await request(app)
      .post("/admin/payouts/draft")
      .set("Cookie", admin)
      .send({})
      .expect(201);

    const release = await request(app)
      .post(`/admin/payouts/${String(draft.body.data.reference)}/release`)
      .set("Cookie", admin)
      .expect(200);

    expect(release.body.data.paid).toBe(0);
    expect(release.body.data.failed).toBeGreaterThanOrEqual(1);

    const earnings = await request(app).get("/pro/earnings").set("Cookie", pro.cookie).expect(200);
    expect(earnings.body.data.pendingPaise, "still owed").toBe(owed);
    expect(await ledgerImbalance()).toBe(0);

    const [row] = await sql!`select status, failure_reason from payouts limit 1`;
    expect(row!.status).toBe("failed");
    expect(String(row!.failure_reason)).toContain("bank refused");
  });
});

suite("the professional's view", () => {
  it("shows the payout with what was withheld", async () => {
    const pro = await newProfessional();
    const client = await register("Client", "pay-client");
    await earnOnce(client.cookie);
    const admin = await adminCookie();

    const draft = await request(app)
      .post("/admin/payouts/draft")
      .set("Cookie", admin)
      .send({})
      .expect(201);
    await request(app)
      .post(`/admin/payouts/${String(draft.body.data.reference)}/release`)
      .set("Cookie", admin)
      .expect(200);

    const history = await request(app).get("/pro/payouts").set("Cookie", pro.cookie).expect(200);

    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0].status).toBe("paid");
    expect(history.body.data[0].amountPaise).toBe(deriveAmounts(PRICE).professionalNetPaise);
    expect(history.body.data[0].tdsSection).toBe("194O");
    // The account is identified without decrypting anything.
    expect(history.body.data[0].accountLast4).toBe("6789");
  });
});
