import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";
import { encryptField } from "../../src/lib/field-encryption.js";
import { setMailSender, type Email } from "../../src/lib/mailer.js";
import { dispatchPending } from "../../src/modules/events/outbox.js";
import { retryFailedNotifications } from "../../src/modules/notifications/service.js";
import { setGatewayOrderCreator, setRefundSender } from "../../src/modules/payments/razorpay.js";

/**
 * Telling people what happened.
 *
 * The property worth defending is **exactly once**. The outbox re-runs every
 * subscriber for an event when any one of them fails, so a receipt that sent
 * successfully alongside a failing sibling will be asked to send again. Two receipts
 * for one payment is the failure mode, and the `notifications` table exists solely to
 * stop it.
 *
 * The rest is about not making things worse: a mail provider being down must not roll
 * back a payment or re-run the assignment engine.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 4, prepare: !/-pooler\./.test(url) }) : undefined;

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
const PRICED = { category: "documentation", slug: "loan-agreement" };
const PRICE = 600_000; // ₹6,000

const emails: string[] = [];
const professionalIds: string[] = [];

/** Everything the stubbed provider was asked to send, in order. */
let outbox: Email[] = [];

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
      name: "Notified Person",
      email,
      password: "a-sufficiently-long-password",
      phone: `+9173${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
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
  const { email, userId } = await register("ntf-admin");
  await sql!`update users set role = 'admin' where id = ${userId}`;
  return signIn(email);
}

async function newProfessional() {
  const { email, userId } = await register("ntf-pro");
  await sql!`update users set role = 'professional' where id = ${userId}`;
  const [created] = await sql!`
    insert into professionals (user_id, kind, display_name, status, available, concurrent_capacity)
    values (${userId}, 'advocate', 'Notified Pro', 'verified', true, 9)
    returning id`;
  const id = String(created!.id);
  professionalIds.push(id);
  await sql!`insert into professional_categories (professional_id, category_id)
             select ${id}, id from categories where slug = ${PRICED.category}`;
  await sql!`insert into payout_identities
               (professional_id, pan_encrypted, account_number_encrypted, ifsc,
                account_holder_name, account_last4)
             values (${id}, ${encryptField("ABCDE1234F")}, ${encryptField("000123456789")},
                     'HDFC0001234', 'Notified Pro', '6789')`;
  return { id, email, cookie: await signIn(email) };
}

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

  const raw = JSON.stringify({
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
  });
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

function sentTo(address: string): Email[] {
  return outbox.filter((e) => e.to === address);
}

beforeEach(async () => {
  if (!sql) return;
  outbox = [];
  setMailSender((email) => {
    outbox.push(email);
    return Promise.resolve();
  });
  setGatewayOrderCreator((input) =>
    Promise.resolve({
      id: `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      amount: input.amountPaise,
      currency: input.currency,
    }),
  );
  setRefundSender(() => Promise.resolve({ providerRef: `rfnd_${randomUUID().slice(0, 8)}` }));
  await sql`update professionals set available = false`;
  await sql`update services set price_paise = ${PRICE}, turnaround_days = 4, active = true
            where slug = ${PRICED.slug}`;
});

afterEach(() => {
  setMailSender(undefined);
});

afterAll(async () => {
  if (!sql) return;
  setGatewayOrderCreator(undefined);
  setRefundSender(undefined);

  const mine = sql`select id from orders where user_id in
                   (select id from users where email = any(${emails}))`;
  await sql`delete from notifications`;
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

suite("what gets sent", () => {
  it("receipts the client and tells the professional, on one payment", async () => {
    const pro = await newProfessional();
    const client = await register("ntf-client");
    const reference = await payOnce(client.cookie);

    const receipt = sentTo(client.email);
    expect(receipt).toHaveLength(1);
    expect(receipt[0]!.subject).toContain(reference);
    expect(receipt[0]!.subject).toContain("Payment received");
    // The figure has to be right, and in rupees.
    expect(receipt[0]!.text).toContain("6,000");
    expect(receipt[0]!.text).toMatch(/LX\/\d{4}-\d{2}\/\d+/);

    const notice = sentTo(pro.email);
    expect(notice).toHaveLength(1);
    expect(notice[0]!.subject).toContain("New matter to acknowledge");
    // The deadline is the whole reason this one is an email and not a badge.
    expect(notice[0]!.text).toContain("acknowledge");
    expect(notice[0]!.text).toContain("IST");

    // Both come with a plain-text alternative, not just HTML.
    for (const email of outbox) {
      expect(email.text.length).toBeGreaterThan(40);
      expect(email.html).toContain("<!doctype html>");
    }
  });

  it("tells the client when work starts and finishes, but not for every state", async () => {
    const pro = await newProfessional();
    const client = await register("ntf-client");
    await payOnce(client.cookie);

    const matters = await request(app).get("/pro/matters").set("Cookie", pro.cookie).expect(200);
    const assignmentId = String(matters.body.data[0].assignmentId);

    await request(app)
      .post(`/pro/matters/${assignmentId}/acknowledge`)
      .set("Cookie", pro.cookie)
      .expect(200);
    await dispatchPending();

    // Acknowledging is not news to a client who was already told they were matched.
    outbox = [];

    await request(app)
      .post(`/pro/matters/${assignmentId}/status`)
      .set("Cookie", pro.cookie)
      .send({ status: "in_progress" })
      .expect(200);
    await dispatchPending();

    await request(app)
      .post(`/pro/matters/${assignmentId}/status`)
      .set("Cookie", pro.cookie)
      .send({ status: "completed" })
      .expect(200);
    await dispatchPending();

    const updates = sentTo(client.email);
    expect(updates).toHaveLength(2);
    expect(updates[0]!.subject).toContain("underway");
    expect(updates[1]!.subject).toContain("complete");
  });

  it("tells a professional they have been verified", async () => {
    const applicant = await register("ntf-applicant");
    await request(app)
      .post("/pro/apply")
      .set("Cookie", applicant.cookie)
      .send({
        kind: "advocate",
        displayName: "Verified Soon",
        categories: [PRICED.category],
      })
      .expect(201);
    await request(app)
      .post("/pro/application/credentials")
      .set("Cookie", applicant.cookie)
      .send({ body: "Bar Council of Maharashtra", registrationNumber: "MAH/1234/2019" })
      .expect(201);
    await request(app)
      .put("/pro/application/payout-identity")
      .set("Cookie", applicant.cookie)
      .send({
        pan: "ABCDE1234F",
        accountNumber: "000123456789",
        ifsc: "HDFC0001234",
        accountHolderName: "Verified Soon",
      })
      .expect(200);
    await request(app).post("/pro/application/submit").set("Cookie", applicant.cookie).expect(200);

    const [pro] = await sql!`select p.id from professionals p join users u on u.id = p.user_id
                             where u.email = ${applicant.email}`;
    professionalIds.push(String(pro!.id));

    outbox = [];
    await request(app)
      .post(`/admin/professionals/${String(pro!.id)}/verify`)
      .set("Cookie", await adminCookie())
      .expect(200);
    await dispatchPending();

    const sent = sentTo(applicant.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("verified");
  });

  it("confirms a refund", async () => {
    await newProfessional();
    const client = await register("ntf-client");
    const reference = await payOnce(client.cookie);
    outbox = [];

    await request(app)
      .post(`/admin/orders/${reference}/refund`)
      .set("Cookie", await adminCookie())
      .send({ reason: "Client changed their mind" })
      .expect(200);
    await dispatchPending();

    const sent = sentTo(client.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("Refund issued");
    expect(sent[0]!.text).toContain("6,000");
    // Sets the expectation, so "where is my money" is answered before it is asked.
    expect(sent[0]!.text).toContain("working days");
  });
});

suite("exactly once", () => {
  it("does not send a second receipt when the dispatcher re-runs", async () => {
    await newProfessional();
    const client = await register("ntf-client");
    await payOnce(client.cookie);
    expect(sentTo(client.email)).toHaveLength(1);

    // Whatever causes it — a sibling subscriber failing, a redelivery, a restart —
    // the dispatcher running the same event again must not mail twice.
    await dispatchPending();
    await dispatchPending();

    expect(sentTo(client.email)).toHaveLength(1);

    const rows = await sql!`select status from notifications
                            where recipient = ${client.email} and kind = 'order.paid.receipt'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("sent");
  });

  it("records a failure rather than losing it, and keeps the same idempotency key", async () => {
    await newProfessional();
    const client = await register("ntf-client");

    // Only this client's receipt. The professional's assignment notice is a
    // different notification with its own row and its own key.
    const keys: string[] = [];
    setMailSender((email) => {
      if (email.to === client.email) keys.push(email.idempotencyKey);
      return Promise.reject(new Error("provider unavailable"));
    });

    await payOnce(client.cookie);

    const [row] = await sql!`select id, status, error from notifications
                             where recipient = ${client.email} and kind = 'order.paid.receipt'`;
    expect(row!.status).toBe("failed");
    expect(String(row!.error)).toContain("provider unavailable");

    /**
     * The outbox will never look at this event again — the subscriber swallowed the
     * failure so that a dead mail provider could not re-run the assignment engine.
     * The retry sweep is what picks it back up, and it reuses the row id, so a
     * provider that did receive the first attempt suppresses the duplicate instead
     * of us having to guess whether it landed.
     */
    await dispatchPending();
    expect(keys).toHaveLength(1);
    await retryFailedNotifications();
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(String(row!.id));
  });

  it("a failing mail provider does not fail the payment or the assignment", async () => {
    const pro = await newProfessional();
    const client = await register("ntf-client");

    setMailSender(() => Promise.reject(new Error("provider on fire")));

    const reference = await payOnce(client.cookie);

    // The money landed and the matter was assigned regardless.
    const [order] = await sql!`select status from orders where reference = ${reference}`;
    expect(["paid", "awaiting_assignment", "assigned"]).toContain(String(order!.status));

    const [assignment] = await sql!`select a.professional_id from assignments a
                                    join orders o on o.id = a.order_id
                                    where o.reference = ${reference}`;
    if (assignment) expect(String(assignment.professional_id)).toBe(pro.id);

    const [imbalance] = await sql!`select coalesce(sum(case when direction = 'debit'
                                                            then amount_paise else -amount_paise end), 0)::bigint
                                   as d from ledger_lines`;
    expect(Number(imbalance!.d)).toBe(0);
  });

  it("says nothing and records nothing when there is no address", async () => {
    await newProfessional();
    const client = await register("ntf-client");
    await sql!`update users set email = null where email = ${client.email}`;

    await payOnce(client.cookie);

    // No row, because nothing was attempted — as opposed to a failed send, which
    // would leave one for somebody to chase.
    const rows = await sql!`select id from notifications where kind = 'order.paid.receipt'
                            and recipient is null`;
    expect(rows).toHaveLength(0);

    await sql!`update users set email = ${client.email} where email is null
               and phone is not null and id in (select user_id from sessions)`;
  });
});
