import { randomUUID } from "node:crypto";
import postgres from "postgres";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";

/**
 * Checkout.
 *
 * The behaviour worth proving is the price snapshot: an order records what was agreed,
 * not a pointer to a price the catalogue can change underneath it. Everything about the
 * invoice and the ledger in M2 depends on that being true.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 4, prepare: !/-pooler\./.test(url) }) : undefined;

const emails: string[] = [];

/** Published specifically for these tests, and withdrawn again afterwards. */
const PRICED = { category: "business-setup", slug: "private-limited-company-registration" };
const PRICE = 799_900; // ₹7,999.00 in paise
const UNPRICED = { category: "certifications", slug: "iso-certification" };

async function newClient() {
  const email = `order-${randomUUID().slice(0, 8)}@example.test`;
  emails.push(email);
  const res = await request(app)
    .post("/auth/register")
    .send({
      name: "Order Client",
      email,
      password: "a-sufficiently-long-password",
      phone: `+9144${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
      whatsappConsent: false,
    })
    .expect(201);

  const raw = res.headers["set-cookie"];
  const list: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const cookie = list.find((c) => c.startsWith("lawxygen_session="))?.split(";")[0] ?? "";
  return { email, cookie };
}

beforeAll(async () => {
  if (!sql) return;
  await sql`update services set price_paise = ${PRICE}, turnaround_days = 10, active = true
            where slug = ${PRICED.slug}
              and category_id = (select id from categories where slug = ${PRICED.category})`;
});

afterAll(async () => {
  if (!sql) return;
  await sql`delete from orders where user_id in (select id from users where email = any(${emails}))`;
  if (emails.length) await sql`delete from users where email = any(${emails})`;
  await sql`update services set active = false, price_paise = null, turnaround_days = null
            where slug = ${PRICED.slug}`;
  await sql.end({ timeout: 5 });
  await closeDatabase();
});

suite("creating an order", () => {
  it("requires a session", async () => {
    const res = await request(app).post("/orders").send(PRICED);
    expect(res.status).toBe(401);
  });

  it("creates a pending order with a readable reference", async () => {
    const { cookie } = await newClient();

    const res = await request(app).post("/orders").set("Cookie", cookie).send({
      category: PRICED.category,
      service: PRICED.slug,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("payment_pending");
    expect(res.body.data.reference).toMatch(/^LX-\d{6}$/);
    expect(res.body.data.pricePaise).toBe(PRICE);
    expect(res.body.data.currency).toBe("INR");
  });

  /**
   * The whole point of snapshotting. An order that followed the live catalogue price
   * would disagree with the invoice already issued against it.
   */
  it("keeps its original price when the catalogue is repriced afterwards", async () => {
    const { cookie } = await newClient();

    const created = await request(app)
      .post("/orders")
      .set("Cookie", cookie)
      .send({ category: PRICED.category, service: PRICED.slug })
      .expect(201);

    await sql!`update services set price_paise = 1_500_000 where slug = ${PRICED.slug}`;

    const after = await request(app)
      .get(`/orders/${String(created.body.data.reference)}`)
      .set("Cookie", cookie)
      .expect(200);

    expect(after.body.data.pricePaise).toBe(PRICE);

    await sql!`update services set price_paise = ${PRICE} where slug = ${PRICED.slug}`;
  });

  it("refuses a service that is not published", async () => {
    const { cookie } = await newClient();

    const res = await request(app)
      .post("/orders")
      .set("Cookie", cookie)
      .send({ category: UNPRICED.category, service: UNPRICED.slug });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
  });

  /** The 22 shared slugs: the wrong category must not silently sell the other product. */
  it("will not buy a shared slug from the wrong category", async () => {
    const { cookie } = await newClient();

    const res = await request(app)
      .post("/orders")
      .set("Cookie", cookie)
      .send({ category: "talk-ca", service: PRICED.slug });

    expect(res.status).toBe(404);
  });

  it("allocates references without gaps or duplicates under concurrency", async () => {
    const { cookie } = await newClient();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app)
          .post("/orders")
          .set("Cookie", cookie)
          .send({ category: PRICED.category, service: PRICED.slug }),
      ),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);

    const numbers = results
      .map((r) => Number(String(r.body.data.reference).replace("LX-", "")))
      .sort((a, b) => a - b);

    expect(new Set(numbers).size).toBe(10);
    // Contiguous: the counter is a row update, so concurrent callers queue rather than
    // colliding, and none of the ten numbers is skipped.
    for (let i = 1; i < numbers.length; i += 1) {
      expect(numbers[i]! - numbers[i - 1]!).toBe(1);
    }
  });
});

suite("reading orders", () => {
  it("lists only the caller's own orders, newest first", async () => {
    const mine = await newClient();
    const theirs = await newClient();

    await request(app)
      .post("/orders")
      .set("Cookie", mine.cookie)
      .send({ category: PRICED.category, service: PRICED.slug })
      .expect(201);
    await request(app)
      .post("/orders")
      .set("Cookie", theirs.cookie)
      .send({ category: PRICED.category, service: PRICED.slug })
      .expect(201);

    const res = await request(app).get("/orders").set("Cookie", mine.cookie).expect(200);

    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.nextCursor).toBeNull();
  });

  /**
   * References are sequential, so a 403 on someone else's order would confirm it exists
   * and let anyone count the platform's orders by walking LX-000001 upwards.
   */
  it("answers not_found — not forbidden — for another client's order", async () => {
    const mine = await newClient();
    const theirs = await newClient();

    const other = await request(app)
      .post("/orders")
      .set("Cookie", theirs.cookie)
      .send({ category: PRICED.category, service: PRICED.slug })
      .expect(201);

    const res = await request(app)
      .get(`/orders/${String(other.body.data.reference)}`)
      .set("Cookie", mine.cookie);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
  });

  it("pages without skipping or repeating an order", async () => {
    const { cookie } = await newClient();

    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post("/orders")
        .set("Cookie", cookie)
        .send({ category: PRICED.category, service: PRICED.slug })
        .expect(201);
    }

    const first = await request(app).get("/orders?limit=2").set("Cookie", cookie).expect(200);
    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.nextCursor).toBeTruthy();

    const second = await request(app)
      .get(`/orders?limit=2&cursor=${encodeURIComponent(String(first.body.data.nextCursor))}`)
      .set("Cookie", cookie)
      .expect(200);

    const third = await request(app)
      .get(`/orders?limit=2&cursor=${encodeURIComponent(String(second.body.data.nextCursor))}`)
      .set("Cookie", cookie)
      .expect(200);

    const seen = [
      ...first.body.data.items,
      ...second.body.data.items,
      ...third.body.data.items,
    ].map((o: { reference: string }) => o.reference);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(third.body.data.nextCursor).toBeNull();
  });

  it("rejects a malformed cursor rather than ignoring it", async () => {
    const { cookie } = await newClient();

    const res = await request(app).get("/orders?cursor=not-a-cursor").set("Cookie", cookie);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_input");
  });
});
