import { randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";
import { setGoogleExchange, type GoogleProfile } from "../../src/modules/auth/google.js";

/**
 * Google sign-in.
 *
 * The exchange with Google is stubbed — what is worth testing is everything around it:
 * that a callback without a matching state cookie is refused, that identity is keyed on
 * the provider's subject rather than a mutable email, and that an existing password
 * account is never silently taken over.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 2, prepare: !/-pooler\./.test(url) }) : undefined;

const subs: string[] = [];
const emails: string[] = [];

function newProfile(overrides: Partial<GoogleProfile> = {}): GoogleProfile {
  const sub = `google-sub-${randomUUID()}`;
  const email = `g-${randomUUID().slice(0, 8)}@example.test`;
  subs.push(sub);
  emails.push(email);
  return { sub, email, emailVerified: true, name: "Google User", ...overrides };
}

beforeEach(() => setGoogleExchange(undefined));
afterEach(() => setGoogleExchange(undefined));

afterAll(async () => {
  if (!sql) return;
  if (subs.length) {
    await sql`delete from users where id in (
                select user_id from oauth_accounts where provider_account_id = any(${subs}))`;
    await sql`delete from oauth_accounts where provider_account_id = any(${subs})`;
  }
  if (emails.length) await sql`delete from users where email = any(${emails})`;
  await sql.end({ timeout: 5 });
  await closeDatabase();
});

/** Walks /auth/google/start to obtain a genuine state cookie, then stubs the exchange. */
async function signInWithGoogle(profile: GoogleProfile) {
  setGoogleExchange(() => Promise.resolve(profile));

  const start = await request(app).get("/auth/google/start");
  const raw = start.headers["set-cookie"];
  const list: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const stateCookie = list.find((c) => c.startsWith("lawxygen_oauth="))?.split(";")[0] ?? "";

  const location = new URL(start.headers.location as string);
  const state = location.searchParams.get("state") ?? "";

  const callback = await request(app)
    .get(`/auth/google/callback?code=fake-code&state=${state}`)
    .set("Cookie", stateCookie);

  return { start, callback, stateCookie, state };
}

suite("starting the flow", () => {
  it("redirects to Google with PKCE and a state cookie", async () => {
    const res = await request(app).get("/auth/google/start");

    expect(res.status).toBe(302);
    const target = new URL(res.headers.location as string);
    expect(target.origin + target.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("code_challenge")).toBeTruthy();
    expect(target.searchParams.get("state")).toBeTruthy();
    expect(target.searchParams.get("scope")).toBe("openid email profile");

    const raw = res.headers["set-cookie"];
    expect((Array.isArray(raw) ? raw : [raw]).join(";")).toContain("HttpOnly");
  });

  it("never puts the PKCE verifier in the URL", async () => {
    const res = await request(app).get("/auth/google/start");
    const target = new URL(res.headers.location as string);

    // Only the challenge may travel via the browser. The verifier stays in the cookie.
    expect(target.searchParams.get("code_verifier")).toBeNull();
  });
});

suite("the callback", () => {
  it("signs in and creates an account on first use", async () => {
    const profile = newProfile();
    const { callback } = await signInWithGoogle(profile);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain("/welcome");

    const raw = callback.headers["set-cookie"];
    expect((Array.isArray(raw) ? raw : [raw]).join(";")).toContain("lawxygen_session=");
  });

  it("recognises the same Google account on a second sign-in", async () => {
    const profile = newProfile();
    await signInWithGoogle(profile);
    const { callback } = await signInWithGoogle(profile);

    expect(callback.headers.location).toContain("/dashboard");

    const rows = await sql!`select count(*)::int as n from oauth_accounts
                            where provider_account_id = ${profile.sub}`;
    expect(rows[0]!.n).toBe(1);
  });

  /**
   * A Google account can change its email address. Keying on the subject means the user
   * keeps their matters and invoices when that happens; keying on email would silently
   * create a second account.
   */
  it("keys on the provider subject, not the email", async () => {
    const profile = newProfile();
    await signInWithGoogle(profile);

    const movedEmail = `moved-${randomUUID().slice(0, 8)}@example.test`;
    emails.push(movedEmail);
    const { callback } = await signInWithGoogle({ ...profile, email: movedEmail });

    expect(callback.headers.location).toContain("/dashboard");

    const rows = await sql!`select count(*)::int as n from oauth_accounts
                            where provider_account_id = ${profile.sub}`;
    expect(rows[0]!.n).toBe(1);
  });

  /**
   * Refusing to auto-link is a deliberate carry-over from the marketing repo's decision
   * to disable Auth.js's allowDangerousEmailAccountLinking. Whoever controls an address
   * at the provider would otherwise inherit an existing account — and here that account
   * holds legal documents and payment history.
   */
  it("refuses to take over an existing password account with the same email", async () => {
    const shared = `shared-${randomUUID().slice(0, 8)}@example.test`;
    emails.push(shared);

    await request(app)
      .post("/auth/register")
      .send({
        name: "Password User",
        email: shared,
        password: "a-sufficiently-long-password",
        phone: `+9155${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
        whatsappConsent: false,
      })
      .expect(201);

    const { callback } = await signInWithGoogle(newProfile({ email: shared }));

    expect(callback.headers.location).toContain("error=email_in_use");

    const rows = await sql!`select count(*)::int as n from users where lower(email) = ${shared}`;
    expect(rows[0]!.n).toBe(1);
  });

  it("does not store an email Google has not verified", async () => {
    const profile = newProfile({ emailVerified: false });
    await signInWithGoogle(profile);

    const [row] = await sql!`select u.email, u.email_verified from users u
                             join oauth_accounts o on o.user_id = u.id
                             where o.provider_account_id = ${profile.sub}`;

    expect(row!.email).toBeNull();
    expect(row!.email_verified).toBeNull();
  });
});

suite("callback rejection", () => {
  it("refuses a callback with no state cookie", async () => {
    setGoogleExchange(() => Promise.resolve(newProfile()));

    const res = await request(app).get("/auth/google/callback?code=fake-code&state=anything");

    expect(res.headers.location).toContain("error=google_failed");
    expect(
      (Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"] : []).join(";"),
    ).not.toContain("lawxygen_session=");
  });

  /** The forged-callback case: an attacker's code with this browser's cookie. */
  it("refuses when the returned state does not match the cookie", async () => {
    setGoogleExchange(() => Promise.resolve(newProfile()));

    const start = await request(app).get("/auth/google/start");
    const raw = start.headers["set-cookie"];
    const list: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    const stateCookie = list.find((c) => c.startsWith("lawxygen_oauth="))?.split(";")[0] ?? "";

    const res = await request(app)
      .get("/auth/google/callback?code=fake-code&state=not-the-issued-state")
      .set("Cookie", stateCookie);

    expect(res.headers.location).toContain("error=google_failed");
  });

  it("sends the user back to login when they cancel at Google", async () => {
    const res = await request(app).get("/auth/google/callback?error=access_denied");

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=google_denied");
  });

  it("refuses a suspended account", async () => {
    const profile = newProfile();
    await signInWithGoogle(profile);

    await sql!`update users set status = 'suspended' where id in (
                 select user_id from oauth_accounts where provider_account_id = ${profile.sub})`;

    const { callback } = await signInWithGoogle(profile);
    expect(callback.headers.location).toContain("error=google_failed");
  });
});
