import { randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";

/**
 * The M0 exit criterion, end to end over HTTP.
 *
 * Skipped without DATABASE_URL. Run against a Neon branch after `npm run db:migrate`.
 *
 * The suspension test is the one that matters most: it is the entire justification for
 * database sessions over a JWT. If suspending an account did not take effect on the very
 * next request, the whole session design would be paying a per-request join for nothing.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 1, prepare: !/-pooler\./.test(url) }) : undefined;

const emails: string[] = [];

function newAccount() {
  const id = randomUUID().slice(0, 8);
  const email = `m0-${id}@example.test`;
  emails.push(email);
  return {
    name: "Test Client",
    email,
    password: "a-sufficiently-long-password",
    phone: `+9188${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
    whatsappConsent: true,
  };
}

/** Extracts the `name=value` pair from Set-Cookie, ready to send back as a Cookie header. */
function cookieOf(res: request.Response): string {
  const raw: unknown = res.headers["set-cookie"];
  const list: string[] = Array.isArray(raw)
    ? (raw as string[])
    : typeof raw === "string"
      ? [raw]
      : [];
  const found = list.find((c) => c.startsWith("lawxygen_session="));
  if (!found) throw new Error("no session cookie was set");
  return found.split(";")[0]!;
}

afterAll(async () => {
  if (!sql) return;
  if (emails.length) await sql`delete from users where email = any(${emails})`;
  await sql.end({ timeout: 5 });
  await closeDatabase();
});

suite("registration", () => {
  it("creates an account, sets an httpOnly session cookie, and never returns the token", async () => {
    const account = newAccount();
    const res = await request(app).post("/auth/register").send(account);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true });
    expect(res.body.data.user.email).toBe(account.email);

    const raw = res.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw : [raw]).join(";");
    expect(cookie).toContain("HttpOnly");

    // The token exists only in the cookie. A body copy is a token a script can read.
    expect(JSON.stringify(res.body)).not.toContain("lawxygen_session");
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  it("records WhatsApp consent with a timestamp and a source", async () => {
    const account = newAccount();
    await request(app).post("/auth/register").send(account).expect(201);

    const [row] = await sql!`select whatsapp_consent, whatsapp_consent_at, whatsapp_consent_source
                             from users where email = ${account.email}`;

    expect(row!.whatsapp_consent).toBe(true);
    expect(row!.whatsapp_consent_at).not.toBeNull();
    expect(row!.whatsapp_consent_source).toBe("registration");
  });

  it("refuses a duplicate email with a field error, case-insensitively", async () => {
    const account = newAccount();
    await request(app).post("/auth/register").send(account).expect(201);

    const res = await request(app)
      .post("/auth/register")
      .send({ ...account, email: account.email.toUpperCase(), phone: newAccount().phone });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, code: "conflict" });
    expect(res.body.fieldErrors.email).toBeDefined();
  });

  it("rejects a short password and a non-E.164 phone with per-field detail", async () => {
    const res = await request(app)
      .post("/auth/register")
      .send({ ...newAccount(), password: "short", phone: "9876543210" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_input");
    expect(res.body.fieldErrors.password).toBeDefined();
    expect(res.body.fieldErrors.phone).toBeDefined();
  });
});

suite("login and session", () => {
  it("signs in, and /auth/me answers for the cookie", async () => {
    const account = newAccount();
    await request(app).post("/auth/register").send(account).expect(201);

    const login = await request(app)
      .post("/auth/login")
      .send({ email: account.email, password: account.password });
    expect(login.status).toBe(200);

    const me = await request(app).get("/auth/me").set("Cookie", cookieOf(login));
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(account.email);
    expect(me.body.data.impersonated).toBe(false);
  });

  it("accepts the email in any case", async () => {
    const account = newAccount();
    await request(app).post("/auth/register").send(account).expect(201);

    await request(app)
      .post("/auth/login")
      .send({ email: account.email.toUpperCase(), password: account.password })
      .expect(200);
  });

  it("gives the same answer for a wrong password and an unknown account", async () => {
    const account = newAccount();
    await request(app).post("/auth/register").send(account).expect(201);

    const wrongPassword = await request(app)
      .post("/auth/login")
      .send({ email: account.email, password: "not-the-right-password" });

    const noSuchUser = await request(app)
      .post("/auth/login")
      .send({ email: `ghost-${randomUUID()}@example.test`, password: "not-the-right-password" });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(wrongPassword.body.message).toBe(noSuchUser.body.message);
  });

  it("refuses /auth/me without a cookie", async () => {
    const res = await request(app).get("/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthenticated");
  });

  it("stops accepting the cookie after logout", async () => {
    const account = newAccount();
    const registered = await request(app).post("/auth/register").send(account).expect(201);
    const cookie = cookieOf(registered);

    await request(app).get("/auth/me").set("Cookie", cookie).expect(200);
    await request(app).post("/auth/logout").set("Cookie", cookie).expect(200);
    await request(app).get("/auth/me").set("Cookie", cookie).expect(401);
  });

  it("invalidates every session on logout-everywhere", async () => {
    const account = newAccount();
    await request(app).post("/auth/register").send(account).expect(201);

    const first = cookieOf(
      await request(app)
        .post("/auth/login")
        .send({ email: account.email, password: account.password }),
    );
    const second = cookieOf(
      await request(app)
        .post("/auth/login")
        .send({ email: account.email, password: account.password }),
    );

    await request(app).post("/auth/logout-everywhere").set("Cookie", first).expect(200);

    await request(app).get("/auth/me").set("Cookie", first).expect(401);
    await request(app).get("/auth/me").set("Cookie", second).expect(401);
  });

  it("stores the session token hashed, never in plaintext", async () => {
    const account = newAccount();
    const registered = await request(app).post("/auth/register").send(account).expect(201);
    const token = cookieOf(registered).split("=")[1]!;

    const rows = await sql!`select token_hash from sessions
                            join users on users.id = sessions.user_id
                            where users.email = ${account.email}`;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

suite("suspension", () => {
  /**
   * This is why sessions live in the database. With a JWT the token would keep working
   * until it expired, and an admin suspending a professional could not stop paid work
   * landing on them until then.
   */
  it("rejects the very next request after the account is suspended", async () => {
    const account = newAccount();
    const registered = await request(app).post("/auth/register").send(account).expect(201);
    const cookie = cookieOf(registered);

    await request(app).get("/auth/me").set("Cookie", cookie).expect(200);

    await sql!`update users set status = 'suspended' where email = ${account.email}`;

    const after = await request(app).get("/auth/me").set("Cookie", cookie);
    expect(after.status).toBe(401);
  });

  it("refuses to sign a suspended account back in", async () => {
    const account = newAccount();
    await request(app).post("/auth/register").send(account).expect(201);
    await sql!`update users set status = 'suspended' where email = ${account.email}`;

    const res = await request(app)
      .post("/auth/login")
      .send({ email: account.email, password: account.password });

    expect(res.status).toBe(403);
  });

  it("restores access when the account is reinstated, without re-issuing the session", async () => {
    const account = newAccount();
    const registered = await request(app).post("/auth/register").send(account).expect(201);
    const cookie = cookieOf(registered);

    await sql!`update users set status = 'suspended' where email = ${account.email}`;
    await request(app).get("/auth/me").set("Cookie", cookie).expect(401);

    await sql!`update users set status = 'active' where email = ${account.email}`;
    await request(app).get("/auth/me").set("Cookie", cookie).expect(200);
  });
});

suite("audit trail", () => {
  it("records registration and sign-in against the user", async () => {
    const account = newAccount();
    await request(app).post("/auth/register").send(account).expect(201);
    await request(app)
      .post("/auth/login")
      .send({ email: account.email, password: account.password })
      .expect(200);

    const rows = await sql!`select action from audit_log
                            join users on users.id = audit_log.actor_user_id
                            where users.email = ${account.email}
                            order by audit_log.created_at`;

    expect(rows.map((r) => r.action)).toEqual(["user.registered", "auth.login"]);
  });
});
