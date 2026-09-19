import { and, asc, eq, ilike, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/client.js";
import { categories, services } from "../../db/schema/index.js";
import { ApiError, type Page } from "../../lib/api.js";
import { decodeCursor, encodeCursor, toPage } from "../../lib/pagination.js";

/**
 * Reading the sellable catalogue.
 *
 * Everything here filters on `active`. An inactive service is not merely hidden in the
 * UI — it must be unreachable by direct URL too, or the checkout deep link becomes a way
 * to buy something that was deliberately withdrawn.
 */

export type CatalogueService = {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  categorySlug: string;
  categoryLabel: string;
  fulfilmentType: "service" | "consultation";
  pricePaise: number;
  currency: string;
  turnaroundDays: number | null;
  featured: boolean;
};

/**
 * Selected as the real column, never as `sql<number>`.
 *
 * A raw `sql<number>` fragment is an *unchecked assertion*: it bypasses Drizzle's
 * bigint mapping, so postgres-js hands back the string `"249900"` while the type
 * confidently says `number`. Same shape as the `error.cause` bug in the decision log —
 * it compiles, it reads correctly, and it is wrong at runtime.
 */
const SELECTION = {
  id: services.id,
  slug: services.slug,
  title: services.title,
  summary: services.summary,
  categorySlug: categories.slug,
  categoryLabel: categories.label,
  fulfilmentType: services.fulfilmentType,
  pricePaise: services.pricePaise,
  currency: services.currency,
  turnaroundDays: services.turnaroundDays,
  featured: services.featured,
  position: services.position,
};

type SelectedRow = { pricePaise: number | null; position: number } & Omit<
  CatalogueService,
  "pricePaise"
>;

/**
 * Only rows a client may actually buy.
 *
 * `isNotNull(pricePaise)` is redundant against the `services_priced_when_active` CHECK
 * and included anyway: it lets the query, not a downstream assumption, be the reason
 * the price is present.
 */
const purchasable = and(
  eq(services.active, true),
  eq(categories.active, true),
  isNotNull(services.pricePaise),
);

function toCatalogueService(row: SelectedRow): CatalogueService {
  const { position: _position, pricePaise, ...rest } = row;
  if (pricePaise === null) {
    // Unreachable while the CHECK and the `purchasable` filter both hold.
    throw new ApiError("internal", `Service ${row.slug} is published without a price.`);
  }
  return { ...rest, pricePaise };
}

export async function listCategories(): Promise<
  { slug: string; label: string; accent: string | null; serviceCount: number }[]
> {
  return db
    .select({
      slug: categories.slug,
      label: categories.label,
      accent: categories.accent,
      serviceCount: sql<number>`count(${services.id}) filter (where ${services.active})::int`,
    })
    .from(categories)
    .leftJoin(services, eq(services.categoryId, categories.id))
    .where(eq(categories.active, true))
    .groupBy(categories.id)
    .orderBy(asc(categories.position));
}

export type ListServicesOptions = {
  categorySlug?: string;
  search?: string;
  featuredOnly?: boolean;
  cursor?: string;
  limit: number;
};

export async function listServices(options: ListServicesOptions): Promise<Page<CatalogueService>> {
  const filters: (SQL | undefined)[] = [purchasable];

  if (options.categorySlug) filters.push(eq(categories.slug, options.categorySlug));
  if (options.featuredOnly) filters.push(eq(services.featured, true));

  if (options.search) {
    const pattern = `%${options.search}%`;
    filters.push(or(ilike(services.title, pattern), ilike(services.summary, pattern)));
  }

  if (options.cursor) {
    const [position, id] = decodeCursor(options.cursor, 2);
    // Keyset on (position, id): position alone is not unique, so ties would drop or
    // repeat rows across pages.
    filters.push(sql`(${services.position}, ${services.id}) > (${Number(position)}, ${id}::uuid)`);
  }

  const rows = await db
    .select(SELECTION)
    .from(services)
    .innerJoin(categories, eq(categories.id, services.categoryId))
    .where(and(...filters))
    .orderBy(asc(services.position), asc(services.id))
    .limit(options.limit + 1);

  const page = toPage(rows, options.limit, (row) => encodeCursor([row.position, row.id]));
  return { items: page.items.map(toCatalogueService), nextCursor: page.nextCursor };
}

/**
 * One service, addressed the way the marketing site addresses it.
 *
 * Both parts are required because slugs are not globally unique — 22 of them appear in
 * two categories. `gst-audit-support` alone would be ambiguous between the filing and
 * the consultation about it.
 */
export async function findService(
  categorySlug: string,
  serviceSlug: string,
): Promise<CatalogueService> {
  const [row] = await db
    .select(SELECTION)
    .from(services)
    .innerJoin(categories, eq(categories.id, services.categoryId))
    .where(and(purchasable, eq(categories.slug, categorySlug), eq(services.slug, serviceSlug)))
    .limit(1);

  if (!row) {
    // Same answer whether it never existed, was withdrawn, or has no price yet. The
    // catalogue is public; which services are drafted is not.
    throw new ApiError("not_found", "That service is not available.");
  }

  return toCatalogueService(row);
}

/** Unfiltered by `active` — for the order snapshot, which needs the row it just sold. */
export async function findServiceForPurchase(categorySlug: string, serviceSlug: string) {
  const [row] = await db
    .select({
      id: services.id,
      categoryId: services.categoryId,
      slug: services.slug,
      categorySlug: categories.slug,
      title: services.title,
      fulfilmentType: services.fulfilmentType,
      pricePaise: services.pricePaise,
      currency: services.currency,
      turnaroundDays: services.turnaroundDays,
      active: services.active,
      categoryActive: categories.active,
    })
    .from(services)
    .innerJoin(categories, eq(categories.id, services.categoryId))
    .where(and(eq(categories.slug, categorySlug), eq(services.slug, serviceSlug)))
    .limit(1);

  return row;
}

/** Used by the seed-parity test to prove every catalogued slug is addressable. */
export async function countActiveServices(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(services)
    .innerJoin(categories, eq(categories.id, services.categoryId))
    .where(purchasable);
  return row?.count ?? 0;
}
