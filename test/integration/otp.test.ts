import postgres from "postgres";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";
import { setSmsSender } from "../../src/modules/auth/sms.js";

/**
 * Mobile OTP.
 *
 * A six-digit code is only 20 bits, so the guarantees worth testing are not "the right
 * code works" but the ones that bound an attacker: attempts are capped, a code is
 * single-use even under concurrency, and parallel guesses cannot share one budget.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 4, prepare: !/-pooler\./.test(url) }) : undefined;

const phones: string[] = [];
let lastCode = "";

function newPhone(): string {
  const phone = `+9166${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
  phones.push(phone);
  return phone;
}

beforeEach(() => {
  // Capture the code instead of sending it. The stub is the only way the test can know
  // the code at all — it is never returned by the API and never stored in plaintext.
  setSmsSender((_phone, code) => {
    lastCode = code;
    return Promise.resolve();
  });
});

afterEach(() => setSmsSender(undefined));

afterAll(async () => {
  if (!sql) return;
  if (phones.length) {
    await sql`delete from otp_challenges where phone = any(${phones})`;
    await sql`delete from users where phone = any(${phones})`;
  }
  await sql.end({ timeout: 5 });
  await closeDatabase();
});

async function startChallenge(phone: string): Promise<string> {
  const res = await request(app).post("/auth/otp/request").send({ phone });
  expect(res.status).toBe(200);
  return res.body.data.challengeId as string;
}

suite("requesting a code", () => {
  it("never returns the code itself", async () => {
    const res = await request(app).post("/auth/otp/request").send({ phone: newPhone() });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(lastCode);
    expect(res.body.data.challengeId).toBeDefined();
  });

  it("stores the code hashed, not in plaintext", async () => {
    const phone = newPhone();
    await startChallenge(phone);

    const [row] = await sql!`select code_hash from otp_challenges where phone = ${phone}`;

    expect(row!.code_hash).not.toBe(lastCode);
    expect(row!.code_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  /**
   * Registration and sign-in are the same call, so the response must not reveal whether
   * the number already has an account — otherwise the endpoint is a customer-list oracle
   * for anyone willing to iterate phone numbers.
   */
  it("answers identically for a registered and an unregistered number", async () => {
    const registered = newPhone();
    const firstChallenge = await startChallenge(registered);
    await request(app)
      .post("/auth/otp/verify")
      .send({ challengeId: firstChallenge, code: lastCode })
      .expect(200);

    // Clear the resend cooldown left by that sign-in.
    await sql!`update otp_challenges set created_at = now() - interval '5 minutes'
               where phone = ${registered}`;

    const known = await request(app).post("/auth/otp/request").send({ phone: registered });
    const unknown = await request(app).post("/auth/otp/request").send({ phone: newPhone() });

    expect(known.status).toBe(unknown.status);
    expect(Object.keys(known.body.data).sort()).toEqual(Object.keys(unknown.body.data).sort());
    // No field may differ in a way that betrays which is which.
    expect(known.body.ok).toBe(unknown.body.ok);
  });

  it("refuses a resend inside the cooldown", async () => {
    const phone = newPhone();
    await startChallenge(phone);

    const again = await request(app).post("/auth/otp/request").send({ phone });

    expect(again.status).toBe(429);
    expect(again.body.code).toBe("rate_limited");
  });

  it("rejects a phone number that is not E.164", async () => {
    const res = await request(app).post("/auth/otp/request").send({ phone: "9876543210" });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.phone).toBeDefined();
  });
});

suite("verifying a code", () => {
  it("signs in and creates the account on first use", async () => {
    const phone = newPhone();
    const challengeId = await startChallenge(phone);

    const res = await request(app).post("/auth/otp/verify").send({ challengeId, code: lastCode });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(true);
    expect(res.body.data.user.phone).toBe(phone);

    const raw = res.headers["set-cookie"];
    expect((Array.isArray(raw) ? raw : [raw]).join(";")).toContain("HttpOnly");
  });

  it("marks the phone verified", async () => {
    const phone = newPhone();
    const challengeId = await startChallenge(phone);
    await request(app).post("/auth/otp/verify").send({ challengeId, code: lastCode }).expect(200);

    const [row] = await sql!`select phone_verified from users where phone = ${phone}`;
    expect(row!.phone_verified).not.toBeNull();
  });

  it("does not assume WhatsApp consent for an account created this way", async () => {
    const phone = newPhone();
    const challengeId = await startChallenge(phone);
    await request(app).post("/auth/otp/verify").send({ challengeId, code: lastCode }).expect(200);

    const [row] = await sql!`select whatsapp_consent from users where phone = ${phone}`;
    expect(row!.whatsapp_consent).toBe(false);
  });

  it("rejects a wrong code", async () => {
    const challengeId = await startChallenge(newPhone());
    const wrong = lastCode === "000000" ? "111111" : "000000";

    const res = await request(app).post("/auth/otp/verify").send({ challengeId, code: wrong });

    expect(res.status).toBe(401);
  });

  it("gives the same message for a wrong code and an unknown challenge", async () => {
    const challengeId = await startChallenge(newPhone());
    const wrong = lastCode === "000000" ? "111111" : "000000";

    const badCode = await request(app).post("/auth/otp/verify").send({ challengeId, code: wrong });
    const badId = await request(app)
      .post("/auth/otp/verify")
      .send({ challengeId: "11111111-1111-4111-8111-111111111111", code: wrong });

    expect(badCode.body.message).toBe(badId.body.message);
  });

  /** The code must not survive its own success. */
  it("refuses a correct code the second time", async () => {
    const challengeId = await startChallenge(newPhone());
    const code = lastCode;

    await request(app).post("/auth/otp/verify").send({ challengeId, code }).expect(200);
    const replay = await request(app).post("/auth/otp/verify").send({ challengeId, code });

    expect(replay.status).toBe(401);
  });

  it("stops accepting guesses after five attempts, even with the right code", async () => {
    const challengeId = await startChallenge(newPhone());
    const code = lastCode;
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i += 1) {
      await request(app).post("/auth/otp/verify").send({ challengeId, code: wrong }).expect(401);
    }

    // The budget is spent. The genuine code is now worthless, which is the point.
    await request(app).post("/auth/otp/verify").send({ challengeId, code }).expect(401);
  });

  /**
   * The attempt counter is incremented in the same UPDATE that reads the challenge. If
   * it were read-then-write, these twenty requests would each observe attempts = 0 and
   * the cap would be worth nothing.
   */
  it("does not let parallel guesses share one attempt budget", async () => {
    const challengeId = await startChallenge(newPhone());
    const wrong = lastCode === "000000" ? "111111" : "000000";

    await Promise.all(
      Array.from({ length: 20 }, () =>
        request(app).post("/auth/otp/verify").send({ challengeId, code: wrong }),
      ),
    );

    const [row] = await sql!`select attempts from otp_challenges where id = ${challengeId}`;
    expect(Number(row!.attempts)).toBeLessThanOrEqual(5);
  });

  /** Two requests presenting the same valid code must not both get a session. */
  it("issues exactly one session when a correct code is submitted concurrently", async () => {
    const phone = newPhone();
    const challengeId = await startChallenge(phone);
    const code = lastCode;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post("/auth/otp/verify").send({ challengeId, code }),
      ),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);

    const rows = await sql!`select count(*)::int as n from sessions
                            join users on users.id = sessions.user_id
                            where users.phone = ${phone}`;
    expect(rows[0]!.n).toBe(1);
  });

  it("refuses an expired code", async () => {
    const challengeId = await startChallenge(newPhone());
    const code = lastCode;

    await sql!`update otp_challenges set expires_at = now() - interval '1 second'
               where id = ${challengeId}`;

    await request(app).post("/auth/otp/verify").send({ challengeId, code }).expect(401);
  });

  it("refuses a suspended account", async () => {
    const phone = newPhone();
    const first = await startChallenge(phone);
    await request(app)
      .post("/auth/otp/verify")
      .send({ challengeId: first, code: lastCode })
      .expect(200);

    await sql!`update users set status = 'suspended' where phone = ${phone}`;
    await sql!`update otp_challenges set created_at = now() - interval '5 minutes' where phone = ${phone}`;

    const second = await startChallenge(phone);
    const res = await request(app)
      .post("/auth/otp/verify")
      .send({ challengeId: second, code: lastCode });

    expect(res.status).toBe(403);
  });
});
