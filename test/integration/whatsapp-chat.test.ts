import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";
import { setFreeTextSender, setWhatsappConfig } from "../../src/modules/whatsapp/client.js";

/**
 * Inbound messages, the 24-hour window, and who may read a thread.
 *
 * Three properties carry this feature.
 *
 * **A redelivered webhook must not duplicate.** Meta resends anything it does not see
 * acknowledged, so the same message arriving twice has to leave one row.
 *
 * **The window opens only when the client writes.** A template Lawxygen sends does not
 * open it, and a free-form reply outside it must be refused locally rather than by
 * Meta — a professional whose message fails with a gateway error concludes the product
 * is broken.
 *
 * **A professional sees only their own clients.** The thread belongs to the client, so
 * without a filter every professional would read every conversation.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 4, prepare: !/-pooler\./.test(url) }) : undefined;

const APP_SECRET = "whatsapp-test-app-secret";
const NUMBER_ID = "111222333";
const PRICED = { category: "documentation", slug: "license-agreement" };
const PRICE = 400_000;

const emails: string[] = [];
const professionalIds: string[] = [];
let outgoing: { recipientPhone: string; text: string }[] = [];

function cookieOf(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  const list: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.find((c) => c.startsWith("lawxygen_session="))?.split(";")[0] ?? "";
}

async function register(prefix: string, phone: string) {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
  emails.push(email);
  const res = await request(app)
    .post("/auth/register")
    .send({
      name: "Chat Person",
      email,
      password: "a-sufficiently-long-password",
      phone,
      whatsappConsent: true,
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
  const phone = `+9170${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
  const { email, userId } = await register("chat-admin", phone);
  await sql!`update users set role = 'admin' where id = ${userId}`;
  return { cookie: await signIn(email), userId };
}

/** A professional who holds a matter for `clientCookie`'s owner. */
async function professionalHolding(clientCookie: string) {
  const phone = `+9170${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
  const { email, userId } = await register("chat-pro", phone);
  await sql!`update users set role = 'professional' where id = ${userId}`;
  const [created] = await sql!`
    insert into professionals (user_id, kind, display_name, status, available, concurrent_capacity)
    values (${userId}, 'advocate', 'Chat Pro', 'verified', true, 9)
    returning id`;
  const id = String(created!.id);
  professionalIds.push(id);
  await sql!`insert into professional_categories (professional_id, category_id)
             select ${id}, id from categories where slug = ${PRICED.category}`;

  // A paid order, then an assignment straight to this professional.
  const order = await request(app)
    .post("/orders")
    .set("Cookie", clientCookie)
    .send({ category: PRICED.category, service: PRICED.slug })
    .expect(201);
  const reference = String(order.body.data.reference);
  await sql!`update orders set status = 'assigned' where reference = ${reference}`;
  await sql!`insert into assignments (order_id, professional_id, status)
             select id, ${id}, 'acknowledged' from orders where reference = ${reference}`;

  return { id, userId, cookie: await signIn(email), reference };
}

/** A signed inbound webhook, exactly as Meta would send it. */
function inbound(fromPhone: string, text: string, messageId = `wamid.${randomUUID()}`) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: NUMBER_ID },
              contacts: [{ wa_id: fromPhone.replace(/\D/g, ""), profile: { name: "Chat Person" } }],
              messages: [
                {
                  id: messageId,
                  from: fromPhone.replace(/\D/g, ""),
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  return request(app)
    .post("/webhooks/whatsapp")
    .set("content-type", "application/json")
    .set(
      "x-hub-signature-256",
      `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`,
    )
    .send(body);
}

beforeEach(async () => {
  if (!sql) return;
  outgoing = [];
  setWhatsappConfig({
    phoneNumberId: NUMBER_ID,
    accessToken: "t",
    wabaId: "w",
    appSecret: APP_SECRET,
  });
  setFreeTextSender((input) => {
    outgoing.push({ recipientPhone: input.recipientPhone, text: input.text });
    return Promise.resolve({ metaMessageId: `wamid.out.${randomUUID().slice(0, 8)}` });
  });

  await sql`delete from whatsapp_messages`;
  await sql`delete from whatsapp_conversations`;
  await sql`update professionals set available = false`;
  await sql`update services set price_paise = ${PRICE}, turnaround_days = 4, active = true
            where slug = ${PRICED.slug}`;
});

afterEach(() => {
  setFreeTextSender(undefined);
  setWhatsappConfig(undefined);
});

afterAll(async () => {
  if (!sql) return;
  const mine = sql`select id from orders where user_id in
                   (select id from users where email = any(${emails}))`;
  await sql`delete from whatsapp_messages`;
  await sql`delete from whatsapp_conversations`;
  await sql`delete from outbox_events`;
  await sql`delete from assignments where order_id in (${mine})`;
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

suite("receiving a message", () => {
  it("opens a thread and links it to the registered client", async () => {
    const phone = `+9176${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
    const client = await register("chat-client", phone);

    await inbound(phone, "Hello, any update on my filing?").expect(200);

    const [conversation] = await sql!`select contact_phone, user_id, unread_count, last_inbound_at
                                      from whatsapp_conversations`;
    expect(conversation!.contact_phone).toBe(phone.replace(/\D/g, ""));
    // Linked because the number matches a registered user.
    expect(String(conversation!.user_id)).toBe(client.userId);
    expect(conversation!.unread_count).toBe(1);
    expect(conversation!.last_inbound_at).not.toBeNull();

    const messages = await sql!`select direction, body from whatsapp_messages`;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.direction).toBe("inbound");
    expect(messages[0]!.body).toBe("Hello, any update on my filing?");
  });

  it("keeps a message from a number nobody registered, unlinked", async () => {
    await inbound("+919999000011", "Is this Lawxygen?").expect(200);

    const [conversation] = await sql!`select user_id from whatsapp_conversations`;
    // Worth keeping — dropping it loses a real contact. Guessing an owner would be
    // worse than leaving it unattached.
    expect(conversation).toBeDefined();
    expect(conversation!.user_id).toBeNull();
  });

  it("stores a redelivered webhook once", async () => {
    const phone = `+9176${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
    await register("chat-client", phone);
    const messageId = `wamid.${randomUUID()}`;

    await inbound(phone, "Same message", messageId).expect(200);
    await inbound(phone, "Same message", messageId).expect(200);

    const messages = await sql!`select id from whatsapp_messages`;
    expect(messages).toHaveLength(1);
  });

  it("refuses an unsigned webhook", async () => {
    await request(app)
      .post("/webhooks/whatsapp")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", "sha256=" + "0".repeat(64))
      .send(JSON.stringify({ object: "whatsapp_business_account", entry: [] }))
      .expect(403);

    const rows = await sql!`select id from whatsapp_conversations`;
    expect(rows).toHaveLength(0);
  });
});

suite("the 24-hour window", () => {
  it("lets a professional reply after the client writes", async () => {
    const phone = `+9176${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
    const client = await register("chat-client", phone);
    const pro = await professionalHolding(client.cookie);

    await inbound(phone, "Any update?").expect(200);

    const list = await request(app)
      .get("/pro/whatsapp/conversations")
      .set("Cookie", pro.cookie)
      .expect(200);

    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].windowOpen).toBe(true);
    const conversationId = String(list.body.data[0].id);

    const reply = await request(app)
      .post(`/pro/whatsapp/conversations/${conversationId}/messages`)
      .set("Cookie", pro.cookie)
      .send({ text: "Yes — filed this morning, documents to follow." })
      .expect(201);

    expect(reply.body.data.direction).toBe("outbound");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.text).toContain("filed this morning");

    // Answering an unowned thread claims it.
    const [row] = await sql!`select assigned_user_id from whatsapp_conversations
                             where id = ${conversationId}`;
    expect(String(row!.assigned_user_id)).toBe(pro.userId);
  });

  it("refuses a reply once the window has closed, and says why", async () => {
    const phone = `+9176${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
    const client = await register("chat-client", phone);
    const pro = await professionalHolding(client.cookie);

    await inbound(phone, "Any update?").expect(200);
    // Age the client's last message past 24 hours.
    await sql!`update whatsapp_conversations
               set last_inbound_at = now() - interval '25 hours'`;

    const list = await request(app)
      .get("/pro/whatsapp/conversations")
      .set("Cookie", pro.cookie)
      .expect(200);
    expect(list.body.data[0].windowOpen).toBe(false);

    const res = await request(app)
      .post(`/pro/whatsapp/conversations/${String(list.body.data[0].id)}/messages`)
      .set("Cookie", pro.cookie)
      .send({ text: "Still working on it." })
      .expect(409);

    // Refused here rather than by Meta, and the message says what to do instead.
    expect(res.body.message).toContain("template");
    expect(outgoing).toHaveLength(0);
  });

  it("will not open a window just because we sent something", async () => {
    const phone = `+9176${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
    const client = await register("chat-client", phone);
    const pro = await professionalHolding(client.cookie);

    // A conversation that exists but where the client has never written.
    await sql!`insert into whatsapp_conversations (phone_number_id, contact_phone, user_id)
               values (${NUMBER_ID}, ${phone.replace(/\D/g, "")}, ${client.userId})`;

    const list = await request(app)
      .get("/pro/whatsapp/conversations")
      .set("Cookie", pro.cookie)
      .expect(200);
    expect(list.body.data[0].windowOpen).toBe(false);

    const res = await request(app)
      .post(`/pro/whatsapp/conversations/${String(list.body.data[0].id)}/messages`)
      .set("Cookie", pro.cookie)
      .send({ text: "Hello there" })
      .expect(409);

    expect(res.body.message).toContain("has not written to us");
  });
});

suite("who can see a thread", () => {
  it("hides a client from a professional who does not hold their matter", async () => {
    const phone = `+9176${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
    const client = await register("chat-client", phone);
    await professionalHolding(client.cookie);
    await inbound(phone, "Hello").expect(200);

    // A different professional, holding nothing for this client.
    const otherClientPhone = `+9176${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
    const otherClient = await register("chat-other", otherClientPhone);
    const stranger = await professionalHolding(otherClient.cookie);

    const list = await request(app)
      .get("/pro/whatsapp/conversations")
      .set("Cookie", stranger.cookie)
      .expect(200);

    const phones = (list.body.data as { contactPhone: string }[]).map((c) => c.contactPhone);
    expect(phones).not.toContain(phone.replace(/\D/g, ""));
  });

  it("shows an admin everything, and lets them hand a thread over", async () => {
    const phone = `+9176${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
    const client = await register("chat-client", phone);
    const pro = await professionalHolding(client.cookie);
    await inbound(phone, "Hello").expect(200);

    const admin = await adminCookie();
    const list = await request(app)
      .get("/admin/whatsapp/conversations")
      .set("Cookie", admin.cookie)
      .expect(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(1);

    const conversationId = String(list.body.data[0].id);
    const assigned = await request(app)
      .patch(`/admin/whatsapp/conversations/${conversationId}`)
      .set("Cookie", admin.cookie)
      .send({ action: "assign", assigneeUserId: pro.userId })
      .expect(200);

    expect(assigned.body.data.assignedUserId).toBe(pro.userId);
  });

  it("will not assign a thread to a client", async () => {
    const phone = `+9176${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
    const client = await register("chat-client", phone);
    await inbound(phone, "Hello").expect(200);

    const admin = await adminCookie();
    const [conversation] = await sql!`select id from whatsapp_conversations limit 1`;

    // A client cannot open the thread, so assigning it to them is a dead end.
    await request(app)
      .patch(`/admin/whatsapp/conversations/${String(conversation!.id)}`)
      .set("Cookie", admin.cookie)
      .send({ action: "assign", assigneeUserId: client.userId })
      .expect(400);
  });

  it("releases a thread when it is resolved", async () => {
    const phone = `+9176${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
    const client = await register("chat-client", phone);
    const pro = await professionalHolding(client.cookie);
    await inbound(phone, "Hello").expect(200);

    const admin = await adminCookie();
    const [conversation] = await sql!`select id from whatsapp_conversations limit 1`;
    const id = String(conversation!.id);

    await request(app)
      .patch(`/admin/whatsapp/conversations/${id}`)
      .set("Cookie", admin.cookie)
      .send({ action: "assign", assigneeUserId: pro.userId })
      .expect(200);

    const resolved = await request(app)
      .patch(`/admin/whatsapp/conversations/${id}`)
      .set("Cookie", admin.cookie)
      .send({ action: "resolve" })
      .expect(200);

    // Unassigned on resolve, so the client's next message lands in the unassigned
    // queue rather than silently in somebody's list.
    expect(resolved.body.data.status).toBe("resolved");
    expect(resolved.body.data.assignedUserId).toBeNull();
  });

  it("does not let a professional assign anything", async () => {
    const phone = `+9176${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
    const client = await register("chat-client", phone);
    const pro = await professionalHolding(client.cookie);
    await inbound(phone, "Hello").expect(200);

    const [conversation] = await sql!`select id from whatsapp_conversations limit 1`;
    await request(app)
      .patch(`/pro/whatsapp/conversations/${String(conversation!.id)}`)
      .set("Cookie", pro.cookie)
      .send({ action: "takeover" })
      .expect(404);
  });
});
