import { randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";
import { decryptField } from "../../src/lib/field-encryption.js";

/**
 * Becoming a professional.
 *
 * Two things are being tested. The ordinary one is that somebody can apply, be
 * reviewed and end up assignable — until this existed, every professional arrived by
 * hand-run SQL and the payout system could not pay a real person at all.
 *
 * The one that matters more is what the application must *not* do: leak a PAN or an
 * account number back out, let somebody edit a verified record, let an applicant
 * approve themselves, or let bank details move while operations has a payout batch
 * drafted against them.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 4, prepare: !/-pooler\./.test(url) }) : undefined;

const CATEGORY = "tax-compliance";
const PAN = "ABCDE1234F";
const ACCOUNT = "000123456789";

const emails: string[] = [];

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
      name: "Applicant",
      email,
      password: "a-sufficiently-long-password",
      phone: `+9174${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
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
  const { email, userId } = await register("onb-admin");
  await sql!`update users set role = 'admin' where id = ${userId}`;
  return signIn(email);
}

/** Applies and fills in everything, stopping short of submitting. */
async function completeApplication(cookie: string) {
  const applied = await request(app)
    .post("/pro/apply")
    .set("Cookie", cookie)
    .send({
      kind: "chartered_accountant",
      displayName: "A. Applicant, CA",
      headline: "GST and annual compliance",
      city: "Pune",
      categories: [CATEGORY],
    })
    .expect(201);

  await request(app)
    .post("/pro/application/credentials")
    .set("Cookie", cookie)
    .send({ body: "ICAI", registrationNumber: "123456" })
    .expect(201);

  await request(app)
    .put("/pro/application/payout-identity")
    .set("Cookie", cookie)
    .send({
      pan: PAN,
      accountNumber: ACCOUNT,
      ifsc: "HDFC0001234",
      accountHolderName: "A Applicant",
    })
    .expect(200);

  return String(applied.body.data.id);
}

beforeEach(async () => {
  if (!sql) return;
  await sql`update professionals set available = false`;
});

afterAll(async () => {
  if (!sql) return;
  const mine = sql`select id from professionals where user_id in
                   (select id from users where email = any(${emails}))`;
  await sql`delete from outbox_events`;
  await sql`delete from payout_identities where professional_id in (${mine})`;
  await sql`delete from professional_credentials where professional_id in (${mine})`;
  await sql`delete from professional_categories where professional_id in (${mine})`;
  await sql`delete from professionals where id in (${mine})`;
  if (emails.length) await sql`delete from users where email = any(${emails})`;
  await sql.end({ timeout: 5 });
  await closeDatabase();
});

suite("applying", () => {
  it("takes an applicant from client to assignable", async () => {
    const applicant = await register("onb-pro");

    // A client to begin with. The role is what /pro sits behind.
    const before = await sql!`select role from users where email = ${applicant.email}`;
    expect(before[0]!.role).toBe("client");

    const id = await completeApplication(applicant.cookie);

    const after = await sql!`select role from users where email = ${applicant.email}`;
    expect(after[0]!.role).toBe("professional");

    const ready = await request(app)
      .get("/pro/application")
      .set("Cookie", applicant.cookie)
      .expect(200);
    expect(ready.body.data.status).toBe("draft");
    expect(ready.body.data.submittable).toBe(true);
    expect(ready.body.data.readiness.every((c: { done: boolean }) => c.done)).toBe(true);

    await request(app).post("/pro/application/submit").set("Cookie", applicant.cookie).expect(200);

    const admin = await adminCookie();
    await request(app).post(`/admin/professionals/${id}/verify`).set("Cookie", admin).expect(200);

    const [row] = await sql!`select status, verified_at from professionals where id = ${id}`;
    expect(row!.status).toBe("verified");
    expect(row!.verified_at).not.toBeNull();

    // Approving the person approves the numbers that were being reviewed.
    const creds = await sql!`select status from professional_credentials
                             where professional_id = ${id}`;
    expect(creds[0]!.status).toBe("verified");
  });

  it("will not submit an incomplete application, and says what is missing", async () => {
    const applicant = await register("onb-partial");
    await request(app)
      .post("/pro/apply")
      .set("Cookie", applicant.cookie)
      .send({ kind: "advocate", displayName: "B. Applicant", categories: [CATEGORY] })
      .expect(201);

    const res = await request(app)
      .post("/pro/application/submit")
      .set("Cookie", applicant.cookie)
      .expect(409);

    expect(res.body.message).toContain("registration number");
    expect(res.body.message).toContain("bank");
  });

  it("refuses a second application from the same user", async () => {
    const applicant = await register("onb-dupe");
    await completeApplication(applicant.cookie);

    await request(app)
      .post("/pro/apply")
      .set("Cookie", applicant.cookie)
      .send({ kind: "advocate", displayName: "Someone Else", categories: [CATEGORY] })
      .expect(409);
  });

  it("rejects an unknown category rather than silently dropping it", async () => {
    const applicant = await register("onb-badcat");
    const res = await request(app)
      .post("/pro/apply")
      .set("Cookie", applicant.cookie)
      .send({
        kind: "company_secretary",
        displayName: "C. Applicant",
        categories: [CATEGORY, "not-a-real-category"],
      })
      .expect(400);

    expect(res.body.code).toBe("invalid_input");

    // And nothing was half-created.
    const rows = await sql!`select id from professionals where user_id in
                            (select id from users where email = ${applicant.email})`;
    expect(rows.length).toBe(0);
  });
});

suite("what the application must not leak", () => {
  it("encrypts PAN and the account number, and never returns either", async () => {
    const applicant = await register("onb-secret");
    const id = await completeApplication(applicant.cookie);

    const res = await request(app)
      .get("/pro/application")
      .set("Cookie", applicant.cookie)
      .expect(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(PAN);
    expect(body).not.toContain(ACCOUNT);
    // Enough to recognise their own details, not enough to use them.
    expect(res.body.data.payout.panMasked).toBe("AB••••••4F");
    expect(res.body.data.payout.accountLast4).toBe("6789");

    // At rest they are ciphertext, and they decrypt back to what was sent.
    const [stored] = await sql!`select pan_encrypted, account_number_encrypted
                                from payout_identities where professional_id = ${id}`;
    expect(String(stored!.pan_encrypted)).not.toContain(PAN);
    expect(String(stored!.pan_encrypted)).toMatch(/^v1:/);
    expect(decryptField(String(stored!.pan_encrypted))).toBe(PAN);
    expect(decryptField(String(stored!.account_number_encrypted))).toBe(ACCOUNT);
  });

  it("does not put the account number in the audit log", async () => {
    const applicant = await register("onb-audit");
    const id = await completeApplication(applicant.cookie);

    const rows = await sql!`select action, "after" from audit_log
                            where resource_id = ${id}
                              and action = 'professional.payout_identity.changed'`;
    expect(rows.length).toBe(1);
    const recorded = JSON.stringify(rows[0]!.after);
    expect(recorded).not.toContain(ACCOUNT);
    expect(recorded).not.toContain(PAN);
    // That it changed, and which account, without saying what the account is.
    expect(recorded).toContain("6789");
  });

  it("will not let an applicant verify themselves", async () => {
    const applicant = await register("onb-selfverify");
    const id = await completeApplication(applicant.cookie);
    await request(app).post("/pro/application/submit").set("Cookie", applicant.cookie).expect(200);

    await request(app)
      .post(`/admin/professionals/${id}/verify`)
      .set("Cookie", applicant.cookie)
      .expect(403);

    const [row] = await sql!`select status from professionals where id = ${id}`;
    expect(row!.status).toBe("pending_review");
  });

  it("will not let one applicant delete another's credential", async () => {
    const a = await register("onb-a");
    await completeApplication(a.cookie);
    const b = await register("onb-b");
    const bId = await completeApplication(b.cookie);

    const [cred] = await sql!`select id from professional_credentials
                              where professional_id = ${bId}`;

    // Scoped to their own row, so somebody else's id matches nothing.
    await request(app)
      .delete(`/pro/application/credentials/${String(cred!.id)}`)
      .set("Cookie", a.cookie)
      .expect(200);

    const still = await sql!`select id from professional_credentials
                             where professional_id = ${bId}`;
    expect(still.length).toBe(1);
  });
});

suite("editing after review", () => {
  it("freezes the details a reviewer approved", async () => {
    const applicant = await register("onb-frozen");
    const id = await completeApplication(applicant.cookie);
    await request(app).post("/pro/application/submit").set("Cookie", applicant.cookie).expect(200);
    await request(app)
      .post(`/admin/professionals/${id}/verify`)
      .set("Cookie", await adminCookie())
      .expect(200);

    await request(app)
      .patch("/pro/application")
      .set("Cookie", applicant.cookie)
      .send({ displayName: "Somebody Completely Different" })
      .expect(409);

    /**
     * Capacity is the exception, and deliberately so: it is about how much work they
     * can take, not about who they are, and nobody should need support to go from
     * five matters to two.
     */
    const ok = await request(app)
      .patch("/pro/application")
      .set("Cookie", applicant.cookie)
      .send({ concurrentCapacity: 2 })
      .expect(200);
    expect(ok.body.data.concurrentCapacity).toBe(2);
  });

  it("locks bank details while a payout batch is waiting on them", async () => {
    const applicant = await register("onb-locked");
    const id = await completeApplication(applicant.cookie);

    // Stand in for operations having drafted a batch that includes them.
    const [batch] = await sql!`insert into payout_batches (reference, status, total_paise)
                               values (${`PO-TEST-${randomUUID().slice(0, 6)}`}, 'draft', 1000)
                               returning id`;
    await sql!`insert into payouts (batch_id, professional_id, amount_paise, currency, status)
               values (${String(batch!.id)}, ${id}, 1000, 'INR', 'pending')`;

    const res = await request(app)
      .put("/pro/application/payout-identity")
      .set("Cookie", applicant.cookie)
      .send({
        pan: PAN,
        accountNumber: "999988887777",
        ifsc: "ICIC0004321",
        accountHolderName: "A Applicant",
      })
      .expect(409);

    expect(res.body.message).toContain("waiting to be released");

    // The approved account is still the one that will be paid.
    const [identity] = await sql!`select account_last4 from payout_identities
                                  where professional_id = ${id}`;
    expect(identity!.account_last4).toBe("6789");

    await sql!`delete from payouts where batch_id = ${String(batch!.id)}`;
    await sql!`delete from payout_batches where id = ${String(batch!.id)}`;
  });

  it("lets a rejected applicant fix it and resubmit", async () => {
    const applicant = await register("onb-rejected");
    const id = await completeApplication(applicant.cookie);
    await request(app).post("/pro/application/submit").set("Cookie", applicant.cookie).expect(200);

    await request(app)
      .post(`/admin/professionals/${id}/reject`)
      .set("Cookie", await adminCookie())
      .send({ reason: "Registration number does not appear on the ICAI register." })
      .expect(200);

    // They can read why, which is the point of storing it on the credential.
    const seen = await request(app)
      .get("/pro/application")
      .set("Cookie", applicant.cookie)
      .expect(200);
    expect(seen.body.data.status).toBe("rejected");
    expect(String(seen.body.data.credentials[0].reviewNote)).toContain("ICAI register");

    await request(app)
      .patch("/pro/application")
      .set("Cookie", applicant.cookie)
      .send({ displayName: "A. Applicant FCA" })
      .expect(200);

    await request(app).post("/pro/application/submit").set("Cookie", applicant.cookie).expect(200);
  });

  it("refuses to verify an application nobody submitted", async () => {
    const applicant = await register("onb-unsubmitted");
    const id = await completeApplication(applicant.cookie);

    const res = await request(app)
      .post(`/admin/professionals/${id}/verify`)
      .set("Cookie", await adminCookie())
      .expect(409);

    expect(res.body.message).toContain("draft");
  });
});
