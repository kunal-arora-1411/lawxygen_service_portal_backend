import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";
import { encryptField } from "../../src/lib/field-encryption.js";
import { GraphApiError, GraphNetworkError } from "../../src/lib/whatsapp/graph.js";
import { setMailSender } from "../../src/lib/mailer.js";
import { dispatchPending } from "../../src/modules/events/outbox.js";
import { setGatewayOrderCreator } from "../../src/modules/payments/razorpay.js";
import {
  setTemplateSubmitter,
  setWhatsappConfig,
  setWhatsappSender,
  type TemplateSend,
} from "../../src/modules/whatsapp/client.js";

/**
 * WhatsApp, Phase A — outbound templates only.
 *
 * The property worth defending is the same one the payment code defends: **exactly
 * once**. The outbox re-runs every subscriber for an event when any one of them fails,
 * so a WhatsApp send that succeeded beside a failing sibling will be asked to send
 * again. A duplicate here costs real money and looks broken to the client.
 *
 * The other half is who may send. A professional with a Lawxygen WhatsApp number and no
 * restriction could message anyone at Lawxygen's expense.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 4, prepare: !/-pooler\./.test(url) }) : undefined;

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
const PRICED = { category: "documentation", slug: "franchisee-agreement" };
const PRICE = 700_000; // ₹7,000
const RECEIPT = "lawxygen_payment_receipt";
const NOTICE = "lawxygen_assignment_notice";

const emails: string[] = [];
const professionalIds: string[] = [];
let sent: TemplateSend[] = [];

function cookieOf(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  const list: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.find((c) => c.startsWith("lawxygen_session="))?.split(";")[0] ?? "";
}

async function register(prefix: string, consent = true) {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
  emails.push(email);
  const res = await request(app)
    .post("/auth/register")
    .send({
      name: "WhatsApp Person",
      email,
      password: "a-sufficiently-long-password",
      phone: `+9171${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
      whatsappConsent: consent,
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
  const { email, userId } = await register("wa-admin");
  await sql!`update users set role = 'admin' where id = ${userId}`;
  return signIn(email);
}

async function newProfessional() {
  const { email, userId } = await register("wa-pro");
  await sql!`update users set role = 'professional' where id = ${userId}`;
  const [created] = await sql!`
    insert into professionals (user_id, kind, display_name, status, available, concurrent_capacity)
    values (${userId}, 'advocate', 'WhatsApp Pro', 'verified', true, 9)
    returning id`;
  const id = String(created!.id);
  professionalIds.push(id);
  await sql!`insert into professional_categories (professional_id, category_id)
             select ${id}, id from categories where slug = ${PRICED.category}`;
  await sql!`insert into payout_identities
               (professional_id, pan_encrypted, account_number_encrypted, ifsc,
                account_holder_name, account_last4)
             values (${id}, ${encryptField("ABCDE1234F")}, ${encryptField("000123456789")},
                     'HDFC0001234', 'WhatsApp Pro', '6789')`;
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

beforeEach(async () => {
  if (!sql) return;
  sent = [];

  /**
   * Configuration first, sender second. `setWhatsappConfig` re-derives the sender from
   * the new configuration, so installing the stub before it would throw the stub away.
   */
  setWhatsappConfig({
    phoneNumberId: "111222333",
    accessToken: "test-token",
    wabaId: "waba-test",
  });
  setWhatsappSender((input) => {
    sent.push(input);
    return Promise.resolve({ metaMessageId: `wamid.${randomUUID().slice(0, 12)}` });
  });
  // Email is not under test here, and a real send would be refused.
  setMailSender(() => Promise.resolve());
  setGatewayOrderCreator((input) =>
    Promise.resolve({
      id: `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      amount: input.amountPaise,
      currency: input.currency,
    }),
  );

  await sql`delete from whatsapp_cooldowns`;
  await sql`update professionals set available = false`;
  await sql`update services set price_paise = ${PRICE}, turnaround_days = 5, active = true
            where slug = ${PRICED.slug}`;

  // Both templates approved, as a sync from Meta would leave them.
  for (const name of [RECEIPT, NOTICE]) {
    await sql`insert into whatsapp_templates (name, language, category, status, variables)
              values (${name}, 'en', 'utility', 'approved', '[]'::jsonb)
              on conflict (name, language) do update set status = 'approved'`;
  }
});

afterEach(() => {
  setWhatsappSender(undefined);
  setTemplateSubmitter(undefined);
  setWhatsappConfig(undefined);
  setMailSender(undefined);
});

afterAll(async () => {
  if (!sql) return;
  setGatewayOrderCreator(undefined);

  const mine = sql`select id from orders where user_id in
                   (select id from users where email = any(${emails}))`;
  await sql`delete from whatsapp_send_attempts where order_id in (${mine})`;
  await sql`delete from whatsapp_send_attempts where source <> 'outbox'`;
  await sql`delete from whatsapp_cooldowns`;
  await sql`delete from whatsapp_templates`;
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

suite("templates sent from the outbox", () => {
  it("receipts the client and notifies the professional on one payment", async () => {
    const pro = await newProfessional();
    const client = await register("wa-client");
    const reference = await payOnce(client.cookie);

    const receipt = sent.find((m) => m.templateName === RECEIPT);
    expect(receipt).toBeDefined();
    // Digits only — Meta rejects a leading plus on the recipient.
    expect(receipt!.recipientPhone).toMatch(/^\d+$/);
    const body = receipt!.components[0] as { parameters: { text: string }[] };
    expect(body.parameters.map((p) => p.text)).toContain(reference);
    expect(body.parameters.some((p) => p.text.includes("7,000"))).toBe(true);

    const notice = sent.find((m) => m.templateName === NOTICE);
    expect(notice).toBeDefined();
    expect(notice!.recipientPhone).toMatch(/^\d+$/);

    // The correlation id is the attempt row, so a status webhook can find its way home.
    const rows = await sql!`select id, status from whatsapp_send_attempts
                            where template_name = ${RECEIPT} and source = 'outbox'
                            order by created_at desc limit 1`;
    expect(rows[0]!.status).toBe("accepted");
    expect(receipt!.correlationId).toBe(String(rows[0]!.id));
    void pro;
  });

  it("does not send twice when the dispatcher re-runs", async () => {
    await newProfessional();
    const client = await register("wa-client");
    await payOnce(client.cookie);
    const first = sent.filter((m) => m.templateName === RECEIPT).length;
    expect(first).toBe(1);

    await dispatchPending();
    await dispatchPending();

    expect(sent.filter((m) => m.templateName === RECEIPT)).toHaveLength(1);
  });

  it("stays silent for a client who did not consent", async () => {
    await newProfessional();
    const client = await register("wa-noconsent", false);
    await payOnce(client.cookie);

    expect(sent.find((m) => m.templateName === RECEIPT)).toBeUndefined();
  });

  it("a WhatsApp outage does not fail the payment or the assignment", async () => {
    const pro = await newProfessional();
    const client = await register("wa-client");
    setWhatsappSender(() => Promise.reject(new GraphApiError({ code: 131026 }, 400)));

    const reference = await payOnce(client.cookie);

    const [order] = await sql!`select status from orders where reference = ${reference}`;
    expect(["paid", "awaiting_assignment", "assigned"]).toContain(String(order!.status));

    const [assignment] = await sql!`select a.professional_id from assignments a
                                    join orders o on o.id = a.order_id
                                    where o.reference = ${reference}`;
    if (assignment) expect(String(assignment.professional_id)).toBe(pro.id);

    const [attempt] = await sql!`select status, failure_kind from whatsapp_send_attempts
                                 where template_name = ${RECEIPT} order by created_at desc limit 1`;
    expect(attempt!.status).toBe("failed");
    expect(attempt!.failure_kind).toBe("permanent");
  });

  it("records a dropped connection as delivery_unknown and never retries it", async () => {
    await newProfessional();
    const client = await register("wa-client");
    let calls = 0;
    setWhatsappSender(() => {
      calls += 1;
      return Promise.reject(new GraphNetworkError("socket hang up"));
    });

    await payOnce(client.cookie);
    const after = calls;

    // Meta may already have the message. Resending would deliver and charge twice.
    await dispatchPending();
    await dispatchPending();
    expect(calls).toBe(after);

    const [attempt] = await sql!`select status from whatsapp_send_attempts
                                 where template_name = ${RECEIPT} order by created_at desc limit 1`;
    expect(attempt!.status).toBe("delivery_unknown");
  });

  it("backs off the whole number after a throughput rejection", async () => {
    await newProfessional();
    const client = await register("wa-client");
    // 130429 arrives as HTTP 400. Matching on status alone would miss it entirely.
    setWhatsappSender(() => Promise.reject(new GraphApiError({ code: 130429 }, 400)));

    await payOnce(client.cookie);

    const [cooldown] = await sql!`select key, scope from whatsapp_cooldowns
                                  where scope = 'number' limit 1`;
    expect(cooldown).toBeDefined();
    expect(String(cooldown!.key)).toContain("number:");
  });
});

suite("sending by hand", () => {
  it("lets an admin send against an order", async () => {
    await newProfessional();
    const client = await register("wa-client");
    const reference = await payOnce(client.cookie);
    sent = [];

    const res = await request(app)
      .post("/admin/whatsapp/send")
      .set("Cookie", await adminCookie())
      .send({ templateName: RECEIPT, orderReference: reference, variables: ["a", "b", "c", "d"] })
      .expect(200);

    expect(res.body.data.status).toBe("accepted");
    expect(sent).toHaveLength(1);
  });

  it("refuses a template Meta has not approved", async () => {
    const client = await register("wa-client");
    const reference = await payOnce(client.cookie);
    await sql!`update whatsapp_templates set status = 'paused' where name = ${RECEIPT}`;
    sent = [];

    const res = await request(app)
      .post("/admin/whatsapp/send")
      .set("Cookie", await adminCookie())
      .send({ templateName: RECEIPT, orderReference: reference })
      .expect(409);

    // Caught locally, so no round-trip and no opaque Meta rejection.
    expect(res.body.message).toContain("paused");
    expect(sent).toHaveLength(0);
  });

  it("will not let a professional message a client they do not hold", async () => {
    const holder = await newProfessional();
    const client = await register("wa-client");
    const reference = await payOnce(client.cookie);

    const stranger = await newProfessional();
    sent = [];

    // not_found, not forbidden: references are sequential, and a 403 confirms the
    // order exists.
    await request(app)
      .post("/pro/whatsapp/send")
      .set("Cookie", stranger.cookie)
      .send({ templateName: RECEIPT, orderReference: reference })
      .expect(404);

    expect(sent).toHaveLength(0);
    void holder;
  });

  it("will not let a professional send to an arbitrary number", async () => {
    const pro = await newProfessional();
    sent = [];

    // Otherwise the Lawxygen number becomes theirs to use, at Lawxygen's cost.
    await request(app)
      .post("/pro/whatsapp/send")
      .set("Cookie", pro.cookie)
      .send({ templateName: RECEIPT, phone: "+919812345678" })
      .expect(403);

    expect(sent).toHaveLength(0);
  });

  it("treats a double-click as one message", async () => {
    await newProfessional();
    const client = await register("wa-client");
    const reference = await payOnce(client.cookie);
    const admin = await adminCookie();
    sent = [];

    const body = { templateName: RECEIPT, orderReference: reference, variables: ["a"] };
    await request(app).post("/admin/whatsapp/send").set("Cookie", admin).send(body).expect(200);
    const second = await request(app)
      .post("/admin/whatsapp/send")
      .set("Cookie", admin)
      .send(body)
      .expect(200);

    expect(second.body.data.status).toBe("deduplicated");
    expect(sent).toHaveLength(1);
  });
});

suite("authoring a template", () => {
  it("submits a valid draft and stores what Meta decided", async () => {
    setTemplateSubmitter(() =>
      Promise.resolve({ providerTemplateId: "tpl_1", status: "PENDING", category: "UTILITY" }),
    );

    const res = await request(app)
      .post("/admin/whatsapp/templates")
      .set("Cookie", await adminCookie())
      .send({
        name: "lawxygen_matter_update",
        category: "utility",
        body: "Hello {{1}}, your {{2}} is now in progress. Reference {{3}}.",
        samples: ["Priya", "GST Registration", "LX-000123"],
        variables: ["client name", "service", "reference"],
      })
      .expect(201);

    expect(res.body.data.status).toBe("pending");
    expect(res.body.data.category).toBe("utility");

    const [row] = await sql!`select provider_template_id, status from whatsapp_templates
                             where name = 'lawxygen_matter_update'`;
    expect(row!.provider_template_id).toBe("tpl_1");
    expect(row!.status).toBe("pending");
  });

  it("stores Meta's category, not the one we asked for", async () => {
    // Asking for utility and being given marketing is the difference between
    // ₹0.115 and ₹0.86 a message. Only Meta's answer counts.
    setTemplateSubmitter(() =>
      Promise.resolve({ providerTemplateId: "tpl_2", status: "PENDING", category: "MARKETING" }),
    );

    const res = await request(app)
      .post("/admin/whatsapp/templates")
      .set("Cookie", await adminCookie())
      .send({
        name: "lawxygen_reclassified",
        category: "utility",
        body: "Hello {{1}}, here is an update about your matter.",
        samples: ["Priya"],
        variables: ["client name"],
      })
      .expect(201);

    expect(res.body.data.category).toBe("marketing");
  });

  it("refuses a draft Meta would reject, before spending the name", async () => {
    let submitted = 0;
    setTemplateSubmitter(() => {
      submitted += 1;
      return Promise.resolve({ providerTemplateId: "tpl_x", status: "PENDING" });
    });

    const res = await request(app)
      .post("/admin/whatsapp/templates")
      .set("Cookie", await adminCookie())
      .send({
        name: "lawxygen_bad_draft",
        category: "utility",
        // Opens with a variable, and skips {{2}}. Both are Meta rejections.
        body: "{{1}} your matter {{3}} is ready",
        samples: ["Priya"],
        variables: ["client name"],
      })
      .expect(400);

    expect(res.body.code).toBe("invalid_input");
    expect(Object.keys(res.body.fieldErrors)).toContain("body");
    // A rejected name cannot be reused, so nothing was sent.
    expect(submitted).toBe(0);
  });

  it("warns that promotional wording will be repriced as marketing", async () => {
    const res = await request(app)
      .post("/admin/whatsapp/templates/check")
      .set("Cookie", await adminCookie())
      .send({
        name: "lawxygen_promo_ish",
        category: "utility",
        body: "Hi {{1}}, get 20% off your next filing. Limited time.",
        samples: ["Priya"],
      })
      .expect(200);

    const categoryIssue = (res.body.data.issues as { field: string; message: string }[]).find(
      (issue) => issue.field === "category",
    );
    expect(categoryIssue).toBeDefined();
    expect(categoryIssue!.message).toContain("seven times");
  });

  it("will not let a professional author a template", async () => {
    const pro = await newProfessional();
    await request(app)
      .post("/pro/whatsapp/templates")
      .set("Cookie", pro.cookie)
      .send({ name: "sneaky", body: "hello {{1}} there", samples: ["x"] })
      .expect(404);
  });
});
