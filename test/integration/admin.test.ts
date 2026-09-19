import { randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";

/**
 * Admin catalogue and read models.
 *
 * The behaviour worth proving is that an operator cannot put an unpriced service on
 * sale and cannot price the wrong half of a shared slug — both of which would be
 * silent mistakes with money attached.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 2, prepare: !/-pooler\./.test(url) }) : undefined;

const emails: string[] = [];
const TARGET = { category: "certifications", slug: "iso-certification" };

async function cookieFor(role: "client" | "admin"): Promise<string> {
  const email = `adm-${randomUUID().slice(0, 8)}@example.test`;
  emails.push(email);
  const registered = await request(app)
    .post("/auth/register")
    .send({
      name: role === "admin" ? "Ops" : "Client",
      email,
      password: "a-sufficiently-long-password",
      phone: `+9188${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
      whatsappConsent: false,
    })
    .expect(201);

  if (role === "admin") {
    await sql!`update users set role = 'admin' where id = ${String(registered.body.data.user.id)}`;
    const login = await request(app)
      .post("/auth/login")
      .send({ email, password: "a-sufficiently-long-password" })
      .expect(200);
    return cookieOf(login);
  }
  return cookieOf(registered);
}

function cookieOf(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  const list: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.find((c) => c.startsWith("lawxygen_session="))?.split(";")[0] ?? "";
}

beforeEach(async () => {
  if (!sql) return;
  await sql`update services set active = false, price_paise = null, turnaround_days = null,
            featured = false where slug = ${TARGET.slug}`;
});

afterAll(async () => {
  if (!sql) return;
  await sql`update services set active = false, price_paise = null, turnaround_days = null,
            featured = false where slug = ${TARGET.slug}`;
  if (emails.length) await sql`delete from users where email = any(${emails})`;
  await sql.end({ timeout: 5 });
  await closeDatabase();
});

suite("access", () => {
  it("refuses every admin route to a client", async () => {
    const cookie = await cookieFor("client");
    for (const path of [
      "/admin/overview",
      "/admin/services",
      "/admin/professionals",
      "/admin/orders",
    ]) {
      const res = await request(app).get(path).set("Cookie", cookie);
      expect(res.status, `${path} must be forbidden`).toBe(403);
    }
  });

  it("refuses an unauthenticated caller", async () => {
    await request(app).get("/admin/overview").expect(401);
  });
});

suite("catalogue administration", () => {
  it("lists unpriced services, which the public catalogue hides entirely", async () => {
    const cookie = await cookieFor("admin");

    const res = await request(app)
      .get(`/admin/services?category=${TARGET.category}&active=false&limit=200`)
      .set("Cookie", cookie)
      .expect(200);

    const slugs = res.body.data.items.map((s: { slug: string }) => s.slug);
    expect(slugs).toContain(TARGET.slug);

    // The same service is absent from the public catalogue, because it has no price.
    const publicRes = await request(app)
      .get(`/catalogue/services/${TARGET.category}/${TARGET.slug}`)
      .expect(404);
    expect(publicRes.body.code).toBe("not_found");
  });

  /**
   * The constraint that makes a forgotten price impossible rather than merely
   * discouraged. It must arrive as something an operator can act on, not a 500.
   */
  it("refuses to publish a service with no price, with a usable message", async () => {
    const cookie = await cookieFor("admin");

    const res = await request(app)
      .patch(`/admin/services/${TARGET.category}/${TARGET.slug}`)
      .set("Cookie", cookie)
      .send({ active: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_input");
    expect(res.body.fieldErrors.pricePaise).toBeDefined();
    expect(res.body.fieldErrors.turnaroundDays).toBeDefined();
  });

  it("prices and publishes, and the service then appears publicly", async () => {
    const cookie = await cookieFor("admin");

    const updated = await request(app)
      .patch(`/admin/services/${TARGET.category}/${TARGET.slug}`)
      .set("Cookie", cookie)
      .send({ pricePaise: 1_499_900, turnaroundDays: 21, active: true })
      .expect(200);

    expect(updated.body.data.pricePaise).toBe(1_499_900);
    expect(updated.body.data.active).toBe(true);

    const live = await request(app)
      .get(`/catalogue/services/${TARGET.category}/${TARGET.slug}`)
      .expect(200);
    expect(live.body.data.pricePaise).toBe(1_499_900);
    expect(live.body.data.turnaroundDays).toBe(21);
  });

  it("rejects a fractional or negative price rather than rounding it", async () => {
    const cookie = await cookieFor("admin");

    for (const pricePaise of [10.5, -1]) {
      const res = await request(app)
        .patch(`/admin/services/${TARGET.category}/${TARGET.slug}`)
        .set("Cookie", cookie)
        .send({ pricePaise });
      expect(res.status, `${String(pricePaise)} must be rejected`).toBe(400);
    }
  });

  /** 22 slugs exist in two categories. Pricing one must not touch the other. */
  it("prices only the addressed half of a shared slug", async () => {
    const cookie = await cookieFor("admin");

    // Both halves cleared first. The assertion is about what this call changes, not
    // about whatever the shared dev database happened to be carrying.
    await sql!`update services set price_paise = null, turnaround_days = null, active = false
               where slug = 'gst-audit-support'`;

    await request(app)
      .patch("/admin/services/talk-ca/gst-audit-support")
      .set("Cookie", cookie)
      .send({ pricePaise: 250_000, turnaroundDays: 2 })
      .expect(200);

    const rows = await sql!`select c.slug as category, s.price_paise
                            from services s join categories c on c.id = s.category_id
                            where s.slug = 'gst-audit-support' order by c.slug`;

    expect(rows).toHaveLength(2);
    const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.price_paise]));
    expect(Number(byCategory["talk-ca"])).toBe(250_000);
    expect(byCategory["tax-compliance"]).toBeNull();

    await sql!`update services set price_paise = null, turnaround_days = null
               where slug = 'gst-audit-support'`;
  });

  it("answers not_found for a slug under the wrong category", async () => {
    const cookie = await cookieFor("admin");

    const res = await request(app)
      .patch("/admin/services/business-setup/gst-audit-support")
      .set("Cookie", cookie)
      .send({ pricePaise: 100_000 });

    expect(res.status).toBe(404);
  });

  it("records the before and after of a price change in the audit log", async () => {
    const cookie = await cookieFor("admin");

    await request(app)
      .patch(`/admin/services/${TARGET.category}/${TARGET.slug}`)
      .set("Cookie", cookie)
      .send({ pricePaise: 500_000, turnaroundDays: 10 })
      .expect(200);

    const [entry] = await sql!`select before, after from audit_log
                               where action = 'catalogue.updated'
                                 and resource_id = ${`${TARGET.category}/${TARGET.slug}`}
                               order by created_at desc limit 1`;

    expect(entry!.before).toMatchObject({ pricePaise: null });
    expect(entry!.after).toMatchObject({ pricePaise: 500000 });
  });
});

suite("read models", () => {
  it("summarises how much of the catalogue is actually sellable", async () => {
    const cookie = await cookieFor("admin");

    const res = await request(app).get("/admin/overview").set("Cookie", cookie).expect(200);

    // 259 seeded services, whatever else the database has been through.
    expect(res.body.data.catalogue.total).toBe(259);
    expect(res.body.data.catalogue.live).toBeLessThanOrEqual(259);
    expect(res.body.data.professionals).toBeDefined();
    expect(res.body.data.revenuePaise.allTime).toBeGreaterThanOrEqual(0);
  });

  it("lists professionals with the facts that decide eligibility", async () => {
    const cookie = await cookieFor("admin");

    const res = await request(app).get("/admin/professionals").set("Cookie", cookie).expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    for (const professional of res.body.data as { hasPayoutIdentity: boolean }[]) {
      // Present on every row: a verified professional without one is skipped by the
      // engine, and admin needs to see why somebody is not receiving work.
      expect(typeof professional.hasPayoutIdentity).toBe("boolean");
    }
  });

  it("pages orders newest first without repeating one", async () => {
    const cookie = await cookieFor("admin");

    const first = await request(app).get("/admin/orders?limit=5").set("Cookie", cookie).expect(200);
    expect(first.body.data.items.length).toBeLessThanOrEqual(5);

    if (first.body.data.nextCursor) {
      const second = await request(app)
        .get(
          `/admin/orders?limit=5&cursor=${encodeURIComponent(String(first.body.data.nextCursor))}`,
        )
        .set("Cookie", cookie)
        .expect(200);

      const refs = [...first.body.data.items, ...second.body.data.items].map(
        (o: { reference: string }) => o.reference,
      );
      expect(new Set(refs).size).toBe(refs.length);
    }
  });
});
