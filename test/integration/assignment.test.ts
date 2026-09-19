import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";
import { encryptField } from "../../src/lib/field-encryption.js";
import { escalateOverdueAssignments } from "../../src/modules/assignment/escalation.js";
import { dispatchPending } from "../../src/modules/events/outbox.js";
import { setGatewayOrderCreator } from "../../src/modules/payments/razorpay.js";

/**
 * Automatic assignment.
 *
 * The headline claim is that exactly one qualified professional is claimed per paid
 * order, with no admin in the path, and that concurrent payments never exceed anyone's
 * capacity. Those are the tests here; the rest is supporting cast.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 8, prepare: !/-pooler\./.test(url) }) : undefined;

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
const PRICED = { category: "documentation", slug: "shareholders-agreement" };
const PRICE = 300_000;

const emails: string[] = [];
const professionalIds: string[] = [];

async function newClient(): Promise<string> {
  const email = `as-${randomUUID().slice(0, 8)}@example.test`;
  emails.push(email);
  const res = await request(app)
    .post("/auth/register")
    .send({
      name: "Assignment Client",
      email,
      password: "a-sufficiently-long-password",
      phone: `+9199${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
      whatsappConsent: false,
    })
    .expect(201);
  const raw = res.headers["set-cookie"];
  const list: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.find((c) => c.startsWith("lawxygen_session="))?.split(";")[0] ?? "";
}

type Pro = { id: string; cookie: string; email: string };

/**
 * A professional ready to receive work: verified, available, qualified for the
 * category, and — deliberately — with a payout identity, because one without cannot be
 * paid and is filtered out of eligibility.
 */
async function newProfessional(
  options: { capacity?: number; verified?: boolean; available?: boolean; payout?: boolean } = {},
): Promise<Pro> {
  const { capacity = 5, verified = true, available = true, payout = true } = options;
  const email = `pro-${randomUUID().slice(0, 8)}@example.test`;
  emails.push(email);

  const registered = await request(app)
    .post("/auth/register")
    .send({
      name: "Test Professional",
      email,
      password: "a-sufficiently-long-password",
      phone: `+9198${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
      whatsappConsent: false,
    })
    .expect(201);

  const userId = String(registered.body.data.user.id);
  await sql!`update users set role = 'professional' where id = ${userId}`;

  const [created] = await sql!`
    insert into professionals (user_id, kind, display_name, status, available, concurrent_capacity)
    values (${userId}, 'chartered_accountant', 'Test Pro',
            ${verified ? "verified" : "pending_review"}, ${available}, ${capacity})
    returning id`;
  const id = String(created!.id);
  professionalIds.push(id);

  await sql!`insert into professional_categories (professional_id, category_id)
             select ${id}, id from categories where slug = ${PRICED.category}`;

  if (payout) {
    await sql!`insert into payout_identities
                 (professional_id, pan_encrypted, account_number_encrypted, ifsc,
                  account_holder_name, account_last4)
               values (${id}, ${encryptField("ABCDE1234F")},
                       ${encryptField("000123456789")}, 'HDFC0001234', 'Test Pro', '6789')`;
  }

  // Sign in again: the session was issued before the role changed.
  const login = await request(app)
    .post("/auth/login")
    .send({ email, password: "a-sufficiently-long-password" })
    .expect(200);
  const raw = login.headers["set-cookie"];
  const list: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const cookie = list.find((c) => c.startsWith("lawxygen_session="))?.split(";")[0] ?? "";

  return { id, cookie, email };
}

async function adminCookie(): Promise<string> {
  const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
  emails.push(email);
  const registered = await request(app)
    .post("/auth/register")
    .send({
      name: "Admin",
      email,
      password: "a-sufficiently-long-password",
      phone: `+9197${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
      whatsappConsent: false,
    })
    .expect(201);

  await sql!`update users set role = 'admin' where id = ${String(registered.body.data.user.id)}`;

  const login = await request(app)
    .post("/auth/login")
    .send({ email, password: "a-sufficiently-long-password" })
    .expect(200);
  const raw = login.headers["set-cookie"];
  const list: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.find((c) => c.startsWith("lawxygen_session="))?.split(";")[0] ?? "";
}

/** Order → intent → signed capture webhook → drain the outbox. Returns the reference. */
async function payForService(cookie: string): Promise<string> {
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

  return reference;
}

async function orderStatus(reference: string): Promise<string> {
  const [row] = await sql!`select status from orders where reference = ${reference}`;
  return String(row!.status);
}

/**
 * Establishes the precondition every test here depends on: the only eligible supply is
 * what this test just created, and no work is already queued.
 *
 * Both halves were learned the hard way. `dispatchPending()` drains the **global**
 * outbox, so assignment events left by another suite get processed here and consume
 * the capacity a test is measuring. And making only *this file's* professionals
 * unavailable is not enough — anything created outside it, by another suite or by hand
 * against the dev database, is still eligible. The capacity test then reads a breach
 * that is really a stranger absorbing work.
 */
async function isolateSupply(): Promise<void> {
  await sql!`update professionals set available = false`;
  await sql!`update orders set status = 'cancelled'
             where status in ('paid', 'awaiting_assignment', 'assignment_escalated')`;
  await sql!`delete from outbox_events where status = 'pending'`;
}

beforeEach(async () => {
  if (sql) await isolateSupply();
  setGatewayOrderCreator((input) =>
    Promise.resolve({
      id: `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      amount: input.amountPaise,
      currency: input.currency,
    }),
  );
});

beforeAll(async () => {
  if (!sql) return;
  await sql`update services set price_paise = ${PRICE}, turnaround_days = 5, active = true
            where slug = ${PRICED.slug}
              and category_id = (select id from categories where slug = ${PRICED.category})`;
});

afterAll(async () => {
  if (!sql) return;
  setGatewayOrderCreator(undefined);

  const mine = sql`select id from orders where user_id in
                   (select id from users where email = any(${emails}))`;
  await sql`delete from outbox_events where aggregate_id in (
              select id::text from orders where user_id in
              (select id from users where email = any(${emails})))`;
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

suite("assignment on payment", () => {
  it("assigns automatically, with nobody in the path", async () => {
    const pro = await newProfessional();
    const reference = await payForService(await newClient());

    // Paid, but not yet assigned: the event is committed, not yet dispatched.
    expect(await orderStatus(reference)).toBe("paid");

    await dispatchPending();

    expect(await orderStatus(reference)).toBe("assigned");

    const matters = await request(app).get("/pro/matters").set("Cookie", pro.cookie).expect(200);
    expect(matters.body.data.map((m: { reference: string }) => m.reference)).toContain(reference);
  });

  it("gives the professional the client's contact details", async () => {
    const pro = await newProfessional();
    await payForService(await newClient());
    await dispatchPending();

    const matters = await request(app).get("/pro/matters").set("Cookie", pro.cookie).expect(200);
    const matter = matters.body.data[0] as { client: { email: string; phone: string } };

    expect(matter.client.email).toMatch(/@example\.test$/);
    expect(matter.client.phone).toMatch(/^\+91/);
  });

  it("sets an acknowledgement deadline", async () => {
    await newProfessional();
    const reference = await payForService(await newClient());
    await dispatchPending();

    const [row] = await sql!`select a.acknowledge_by from assignments a
                             join orders o on o.id = a.order_id
                             where o.reference = ${reference}`;
    expect(row!.acknowledge_by).not.toBeNull();
  });
});

suite("eligibility", () => {
  it("queues the order when nobody is qualified, rather than losing it", async () => {
    // No professional at all for this category.

    const reference = await payForService(await newClient());
    await dispatchPending();

    expect(await orderStatus(reference)).toBe("awaiting_assignment");
  });

  it("assigns the queued order as soon as a professional is approved", async () => {
    const reference = await payForService(await newClient());
    await dispatchPending();
    expect(await orderStatus(reference)).toBe("awaiting_assignment");

    // Approving emits an event whose subscriber drains the queue.
    const pro = await newProfessional({ verified: false });
    await request(app)
      .post(`/admin/professionals/${pro.id}/verify`)
      .set("Cookie", await adminCookie())
      .expect(200);

    await dispatchPending();

    expect(await orderStatus(reference)).toBe("assigned");
  });

  /**
   * A verified professional with no payout identity cannot be paid, so assigning them
   * creates work that can never be settled. This is the reverse one-to-one whose
   * nullability Drizzle's `one()` infers wrongly — filtered in SQL for that reason.
   */
  it("skips a professional who has not completed payout onboarding", async () => {
    await newProfessional({ payout: false });

    const reference = await payForService(await newClient());
    await dispatchPending();

    expect(await orderStatus(reference)).toBe("awaiting_assignment");
  });

  it("skips a professional who is unavailable or unverified", async () => {
    await newProfessional({ available: false });
    await newProfessional({ verified: false });

    const reference = await payForService(await newClient());
    await dispatchPending();

    expect(await orderStatus(reference)).toBe("awaiting_assignment");
  });
});

suite("concurrency", () => {
  /**
   * The claim this engine exists to make. Three professionals with capacity two can
   * absorb six matters and no more, however many payments land at once — enforced by
   * `FOR UPDATE SKIP LOCKED`, so concurrent assigners take *different* candidates
   * rather than all reading the same one as free.
   */
  it("never exceeds capacity when many payments land together", async () => {
    const pros = [
      await newProfessional({ capacity: 2 }),
      await newProfessional({ capacity: 2 }),
      await newProfessional({ capacity: 2 }),
    ];

    const cookie = await newClient();
    const references: string[] = [];
    for (let i = 0; i < 10; i += 1) references.push(await payForService(cookie));

    // Ten assignment events, dispatched concurrently.
    await Promise.all(Array.from({ length: 4 }, () => dispatchPending()));

    const counts = await sql!`
      select professional_id, count(*)::int as open
      from assignments
      where professional_id = any(${pros.map((p) => p.id)})
        and status in ('assigned','acknowledged','in_progress','awaiting_client')
      group by professional_id`;

    for (const row of counts) {
      expect(Number(row.open), "no professional may exceed capacity").toBeLessThanOrEqual(2);
    }

    const total = counts.reduce((sum, r) => sum + Number(r.open), 0);
    expect(total).toBe(6);

    // The four that could not be placed are queued, not lost.
    const statuses = await Promise.all(references.map((r) => orderStatus(r)));
    expect(statuses.filter((s) => s === "assigned")).toHaveLength(6);
    expect(statuses.filter((s) => s === "awaiting_assignment")).toHaveLength(4);
  });

  /** The partial unique index makes a second open assignment for one order impossible. */
  it("produces one assignment even if the event is dispatched twice", async () => {
    await newProfessional();

    const reference = await payForService(await newClient());

    await dispatchPending();
    // Force a redelivery of the same event.
    await sql!`update outbox_events set status = 'pending', next_attempt_at = now()
               where name = 'order.assignment_requested'
                 and aggregate_id = (select id::text from orders where reference = ${reference})`;
    await dispatchPending();

    const [row] = await sql!`select count(*)::int as n from assignments a
                             join orders o on o.id = a.order_id
                             where o.reference = ${reference}`;
    expect(row!.n).toBe(1);
  });
});

suite("acknowledgement and escalation", () => {
  it("lets the professional acknowledge, moving the matter in progress", async () => {
    const pro = await newProfessional();
    const reference = await payForService(await newClient());
    await dispatchPending();

    const matters = await request(app).get("/pro/matters").set("Cookie", pro.cookie).expect(200);
    const assignmentId = String(matters.body.data[0].assignmentId);

    await request(app)
      .post(`/pro/matters/${assignmentId}/acknowledge`)
      .set("Cookie", pro.cookie)
      .expect(200);

    expect(await orderStatus(reference)).toBe("in_progress");
  });

  it("flags a matter nobody acknowledged in time", async () => {
    await newProfessional();
    const reference = await payForService(await newClient());
    await dispatchPending();

    // Move the deadline into the past rather than waiting four hours.
    await sql!`update assignments set acknowledge_by = now() - interval '1 minute'
               where order_id = (select id from orders where reference = ${reference})`;

    const escalated = await escalateOverdueAssignments();
    expect(escalated).toBeGreaterThanOrEqual(1);
    expect(await orderStatus(reference)).toBe("assignment_escalated");

    const queue = await request(app)
      .get("/admin/queue")
      .set("Cookie", await adminCookie())
      .expect(200);
    expect(queue.body.data.escalated).toBeGreaterThanOrEqual(1);
  });

  /** A late acknowledgement must not resurrect a matter admin has already taken back. */
  it("refuses to acknowledge after escalation", async () => {
    const pro = await newProfessional();
    const reference = await payForService(await newClient());
    await dispatchPending();

    const matters = await request(app).get("/pro/matters").set("Cookie", pro.cookie).expect(200);
    const assignmentId = String(matters.body.data[0].assignmentId);

    await sql!`update assignments set acknowledge_by = now() - interval '1 minute'
               where id = ${assignmentId}`;
    await escalateOverdueAssignments();

    const late = await request(app)
      .post(`/pro/matters/${assignmentId}/acknowledge`)
      .set("Cookie", pro.cookie);

    expect(late.status).toBe(409);
    void reference;
  });
});

suite("admin override", () => {
  it("reassigns a matter to a different professional", async () => {
    const first = await newProfessional();
    const reference = await payForService(await newClient());
    await dispatchPending();

    // Only the replacement is free now.
    await sql!`update professionals set available = false where id = ${first.id}`;
    const second = await newProfessional();

    const res = await request(app)
      .post(`/admin/orders/${reference}/reassign`)
      .set("Cookie", await adminCookie())
      .send({ reason: "Client requested a different professional" })
      .expect(200);

    expect(res.body.data.reassigned).toBe(true);
    expect(res.body.data.professionalId).toBe(second.id);

    const rows = await sql!`select a.status from assignments a
                            join orders o on o.id = a.order_id
                            where o.reference = ${reference} order by a.attempt`;
    expect(rows.map((r) => r.status)).toEqual(["revoked", "assigned"]);
  });

  it("refuses admin routes to a client", async () => {
    const res = await request(app)
      .get("/admin/queue")
      .set("Cookie", await newClient());
    expect(res.status).toBe(403);
  });

  it("refuses professional routes to a client", async () => {
    const res = await request(app)
      .get("/pro/matters")
      .set("Cookie", await newClient());
    expect(res.status).toBe(403);
  });
});
