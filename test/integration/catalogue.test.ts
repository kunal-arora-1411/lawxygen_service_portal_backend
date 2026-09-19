import { resolve } from "node:path";
import postgres from "postgres";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDatabase } from "../../src/db/client.js";
import { fulfilmentFor, loadCatalogue, serviceSlug } from "../../src/db/seed-catalogue.js";

/**
 * Catalogue seed parity and the public browsing API.
 *
 * The parity assertions matter because the join between the two systems is a bare
 * string. If this repo's slug function ever drifts from the marketing site's, every
 * "Get started" link lands on a checkout for a service that does not exist, and nothing
 * else would catch it.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const app = createApp();
const sql = url ? postgres(url, { max: 2, prepare: !/-pooler\./.test(url) }) : undefined;

const CATALOGUE = resolve(process.cwd(), "../LAWXYGEN_AGAIN_NEW_UI/data/serviceCatalog.ts");

afterAll(async () => {
  if (!sql) return;
  await sql.end({ timeout: 5 });
  await closeDatabase();
});

suite("seed parity with the marketing catalogue", () => {
  it("has every catalogued service, addressable by its marketing slug", async () => {
    const groups = await loadCatalogue(CATALOGUE);

    const expected = groups.flatMap((g) =>
      g.services.map((title) => ({ category: g.slug, slug: serviceSlug(title), title })),
    );
    expect(expected).toHaveLength(259);

    const rows = await sql!`select c.slug as category, s.slug, s.title
                            from services s join categories c on c.id = s.category_id`;

    const seeded = new Set(rows.map((r) => `${String(r.category)}/${String(r.slug)}`));
    const missing = expected.filter((e) => !seeded.has(`${e.category}/${e.slug}`));

    expect(missing).toEqual([]);
    expect(rows).toHaveLength(259);
  });

  /**
   * 259 services, 237 distinct slugs. Verified against the source rather than hardcoded
   * so that adding a service to the marketing catalogue cannot silently break the
   * compound key assumption.
   */
  it("keys on (category, slug) because slugs repeat across categories", async () => {
    const groups = await loadCatalogue(CATALOGUE);
    const counts = new Map<string, number>();
    for (const g of groups) {
      for (const title of g.services) {
        const slug = serviceSlug(title);
        counts.set(slug, (counts.get(slug) ?? 0) + 1);
      }
    }

    const repeated = [...counts.entries()].filter(([, n]) => n > 1);
    expect(counts.size).toBe(237);
    expect(repeated).toHaveLength(22);

    // Each repeat really is two rows in the database, not one that overwrote the other.
    for (const [slug] of repeated) {
      const rows = await sql!`select count(*)::int as n from services where slug = ${slug}`;
      expect(rows[0]!.n, `${slug} should exist in two categories`).toBe(2);
    }
  });

  it("never seeds the u2013 slugs, which are generator orphans", async () => {
    const rows = await sql!`select slug from services where slug like '%u2013%'`;
    expect(rows).toEqual([]);
  });

  it("marks talk-* categories as consultations and the rest as services", async () => {
    expect(fulfilmentFor("talk-ca")).toBe("consultation");
    expect(fulfilmentFor("tax-compliance")).toBe("service");

    const rows = await sql!`select c.slug as category, s.fulfilment_type, count(*)::int as n
                            from services s join categories c on c.id = s.category_id
                            group by c.slug, s.fulfilment_type`;

    for (const row of rows) {
      const expected = String(row.category).startsWith("talk-") ? "consultation" : "service";
      expect(row.fulfilment_type, `${String(row.category)} should be ${expected}`).toBe(expected);
    }
  });

  /** The same slug sold two ways must be two distinct, separately priceable products. */
  it("keeps the filing and the consultation apart for a shared slug", async () => {
    const rows = await sql!`select c.slug as category, s.fulfilment_type
                            from services s join categories c on c.id = s.category_id
                            where s.slug = 'gst-audit-support' order by c.slug`;

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.category)).toEqual(["talk-ca", "tax-compliance"]);
  });

  it("seeds everything inactive, because the catalogue carries no prices", async () => {
    const rows = await sql!`select count(*)::int as n from services
                            where active and price_paise is null`;
    expect(rows[0]!.n).toBe(0);
  });
});

suite("the pricing constraint", () => {
  /**
   * The database, not the application, is what makes an unpriced published service
   * impossible. Without this, a forgotten price is a checkout at zero.
   */
  it("refuses to publish a service with no price", async () => {
    await expect(
      sql!`update services set active = true
           where slug = 'trademark-registration-indian' and price_paise is null`,
    ).rejects.toThrow(/services_priced_when_active/);
  });

  it("refuses a negative price", async () => {
    await expect(
      sql!`update services set price_paise = -1 where slug = 'trademark-registration-indian'`,
    ).rejects.toThrow(/services_price_non_negative/);
  });
});

/**
 * Scoped to a service this suite publishes itself.
 *
 * Asserting on global state ("nothing anywhere is published") is what made an earlier
 * version of these tests fail as soon as another suite published a fixture — and it
 * would fail again against any realistically seeded environment.
 */
const PUBLISHED = { category: "documentation", slug: "founder-agreement" };
const PRICE = 249_900;

suite("browsing", () => {
  beforeAll(async () => {
    if (!sql) return;
    await sql`update services set price_paise = ${PRICE}, turnaround_days = 5, active = true
              where slug = ${PUBLISHED.slug}
                and category_id = (select id from categories where slug = ${PUBLISHED.category})`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`update services set active = false, price_paise = null, turnaround_days = null
              where slug = ${PUBLISHED.slug}`;
  });

  it("is public — no session required to see prices", async () => {
    await request(app).get("/catalogue/categories").expect(200);
    await request(app).get("/catalogue/services").expect(200);
  });

  it("lists all ten categories in their marketing order", async () => {
    const res = await request(app).get("/catalogue/categories").expect(200);

    expect(res.body.data).toHaveLength(10);
    expect(res.body.data.map((c: { slug: string }) => c.slug).slice(0, 3)).toEqual([
      "business-setup",
      "tax-compliance",
      "intellectual-property",
    ]);
  });

  it("counts a category's published services", async () => {
    const res = await request(app).get("/catalogue/categories").expect(200);

    const documentation = res.body.data.find(
      (c: { slug: string }) => c.slug === PUBLISHED.category,
    ) as { serviceCount: number };

    expect(documentation.serviceCount).toBeGreaterThanOrEqual(1);
  });

  it("returns a published service with its price", async () => {
    const res = await request(app)
      .get(`/catalogue/services/${PUBLISHED.category}/${PUBLISHED.slug}`)
      .expect(200);

    expect(res.body.data.pricePaise).toBe(PRICE);
    expect(res.body.data.currency).toBe("INR");
    expect(res.body.data.turnaroundDays).toBe(5);
    expect(res.body.data.fulfilmentType).toBe("service");
  });

  it("includes it when filtering by its category", async () => {
    const res = await request(app)
      .get(`/catalogue/services?category=${PUBLISHED.category}`)
      .expect(200);

    const slugs = res.body.data.items.map((s: { slug: string }) => s.slug);
    expect(slugs).toContain(PUBLISHED.slug);
  });

  it("answers not_found for a service that exists but is unpublished", async () => {
    const res = await request(app).get("/catalogue/services/tax-compliance/gst-audit-support");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
  });

  it("answers not_found for a published slug asked for under the wrong category", async () => {
    const res = await request(app).get(`/catalogue/services/talk-ca/${PUBLISHED.slug}`);

    expect(res.status).toBe(404);
  });
});
