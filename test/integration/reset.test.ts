import { randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";
import { setMailSender, type Email } from "../../src/lib/mailer.js";

/**
 * Forgetting a password.
 *
 * Until this existed the table was dead schema and a locked-out client stayed locked
 * out. The tests that matter are less about the happy path than about what the
 * endpoint refuses to tell you: whether an address exists, whether it is throttled,
 * and which part of a stale link is wrong.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 4, prepare: !/-pooler\./.test(url) }) : undefined;

const OLD = "a-sufficiently-long-password";
const NEW = "an-even-better-password-1";

const emails: string[] = [];
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
      name: "Forgetful Person",
      email,
      password: OLD,
      phone: `+9172${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
      whatsappConsent: false,
    })
    .expect(201);
  return { email, userId: String(res.body.data.user.id), cookie: cookieOf(res) };
}

/** Pulls the token out of the link the email carries. */
function tokenFrom(email: Email): string {
  // base64url, not hex — generateToken encodes with base64url.
  const match = /\/reset\?token=([A-Za-z0-9_-]+)/.exec(email.text);
  if (!match?.[1]) throw new Error(`no reset link in: ${email.text}`);
  return match[1];
}

beforeEach(() => {
  outbox = [];
  setMailSender((email) => {
    outbox.push(email);
    return Promise.resolve();
  });
});

afterEach(() => {
  setMailSender(undefined);
});

afterAll(async () => {
  if (!sql) return;
  await sql`delete from password_reset_tokens where user_id in
            (select id from users where email = any(${emails}))`;
  await sql`delete from notifications`;
  if (emails.length) await sql`delete from users where email = any(${emails})`;
  await sql.end({ timeout: 5 });
  await closeDatabase();
});

suite("asking for a reset", () => {
  it("emails a working link", async () => {
    const user = await register("rst-ok");

    await request(app).post("/auth/password/forgot").send({ email: user.email }).expect(200);

    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe(user.email);
    expect(outbox[0]!.subject).toContain("Reset your Lawxygen password");
    // Says plainly that nothing has changed yet, so an unexpected mail is not alarming.
    expect(outbox[0]!.text).toContain("nothing has changed");

    const token = tokenFrom(outbox[0]!);

    await request(app).post("/auth/password/reset").send({ token, password: NEW }).expect(200);

    await request(app).post("/auth/login").send({ email: user.email, password: NEW }).expect(200);
    await request(app).post("/auth/login").send({ email: user.email, password: OLD }).expect(401);
  });

  it("answers identically for an address that does not exist", async () => {
    const real = await register("rst-real");

    const known = await request(app)
      .post("/auth/password/forgot")
      .send({ email: real.email })
      .expect(200);

    const unknown = await request(app)
      .post("/auth/password/forgot")
      .send({ email: `nobody-${randomUUID().slice(0, 8)}@example.test` })
      .expect(200);

    // Byte-for-byte the same, which is the point: the response is not an oracle.
    expect(unknown.body).toEqual(known.body);
    expect(outbox).toHaveLength(1);
  });

  it("stores only a hash of the token", async () => {
    const user = await register("rst-hash");
    await request(app).post("/auth/password/forgot").send({ email: user.email }).expect(200);
    const token = tokenFrom(outbox[0]!);

    const rows = await sql!`select token_hash from password_reset_tokens
                            where user_id = ${user.userId}`;
    expect(rows).toHaveLength(1);
    // A leaked database must not hand over live reset links.
    expect(String(rows[0]!.token_hash)).not.toBe(token);
    expect(String(rows[0]!.token_hash)).not.toContain(token);
  });

  it("throttles silently rather than admitting the account is real", async () => {
    const user = await register("rst-throttle");

    const first = await request(app)
      .post("/auth/password/forgot")
      .send({ email: user.email })
      .expect(200);
    const second = await request(app)
      .post("/auth/password/forgot")
      .send({ email: user.email })
      .expect(200);

    // A 429 here would confirm the address exists, undoing the blank response above.
    expect(second.body).toEqual(first.body);
    expect(outbox).toHaveLength(1);
  });
});

suite("using a reset", () => {
  async function linkFor(email: string) {
    outbox = [];
    await request(app).post("/auth/password/forgot").send({ email }).expect(200);
    return tokenFrom(outbox[0]!);
  }

  it("signs out every existing session", async () => {
    const user = await register("rst-sessions");
    // A second device, to prove it is not just the requesting session that dies.
    const other = await request(app)
      .post("/auth/login")
      .send({ email: user.email, password: OLD })
      .expect(200);
    const otherCookie = cookieOf(other);

    await request(app).get("/auth/me").set("Cookie", otherCookie).expect(200);

    const token = await linkFor(user.email);
    await request(app).post("/auth/password/reset").send({ token, password: NEW }).expect(200);

    // Whoever had the old password is out. Anything less makes the reset theatre.
    await request(app).get("/auth/me").set("Cookie", otherCookie).expect(401);
    await request(app).get("/auth/me").set("Cookie", user.cookie).expect(401);
  });

  it("works once", async () => {
    const user = await register("rst-once");
    const token = await linkFor(user.email);

    await request(app).post("/auth/password/reset").send({ token, password: NEW }).expect(200);

    const again = await request(app)
      .post("/auth/password/reset")
      .send({ token, password: "yet-another-password-9" })
      .expect(400);
    expect(again.body.code).toBe("invalid_input");

    // The second attempt changed nothing.
    await request(app).post("/auth/login").send({ email: user.email, password: NEW }).expect(200);
  });

  it("kills every other outstanding link when one is used", async () => {
    const user = await register("rst-multi");
    const first = await linkFor(user.email);
    // Step past the resend window so a second link is actually issued.
    await sql!`update password_reset_tokens set created_at = created_at - interval '5 minutes'
               where user_id = ${user.userId}`;
    const second = await linkFor(user.email);
    expect(second).not.toBe(first);

    await request(app)
      .post("/auth/password/reset")
      .send({ token: second, password: NEW })
      .expect(200);

    // Three resets requested should not leave two live links behind.
    await request(app)
      .post("/auth/password/reset")
      .send({ token: first, password: "a-third-password-entirely" })
      .expect(400);
  });

  it("refuses an expired link", async () => {
    const user = await register("rst-expired");
    const token = await linkFor(user.email);
    await sql!`update password_reset_tokens set expires_at = now() - interval '1 minute'
               where user_id = ${user.userId}`;

    await request(app).post("/auth/password/reset").send({ token, password: NEW }).expect(400);
    await request(app).post("/auth/login").send({ email: user.email, password: OLD }).expect(200);
  });

  it("gives the same message whatever is wrong with the link", async () => {
    const user = await register("rst-samemsg");
    const token = await linkFor(user.email);

    const nonsense = await request(app)
      .post("/auth/password/reset")
      .send({ token: "A".repeat(43), password: NEW })
      .expect(400);

    await request(app).post("/auth/password/reset").send({ token, password: NEW }).expect(200);
    const used = await request(app)
      .post("/auth/password/reset")
      .send({ token, password: NEW })
      .expect(400);

    // "No such token" and "already used" must not be distinguishable.
    expect(used.body.message).toBe(nonsense.body.message);
  });

  it("will not reset a suspended account", async () => {
    const user = await register("rst-suspended");
    const token = await linkFor(user.email);
    await sql!`update users set status = 'suspended' where id = ${user.userId}`;

    await request(app).post("/auth/password/reset").send({ token, password: NEW }).expect(400);

    await sql!`update users set status = 'active' where id = ${user.userId}`;
    await request(app).post("/auth/login").send({ email: user.email, password: OLD }).expect(200);
  });
});
