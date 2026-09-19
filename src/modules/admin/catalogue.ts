import { and, asc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/client.js";
import { categories, services } from "../../db/schema/index.js";
import { ApiError, type Page } from "../../lib/api.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { authorize, type Actor } from "../../lib/auth/policy.js";
import { isPgError, PG } from "../../lib/db-errors.js";
import { decodeCursor, encodeCursor, toPage } from "../../lib/pagination.js";

/**
 * Catalogue administration.
 *
 * The public catalogue shows only what is sellable; this shows everything, because the
 * whole job here is turning the 259 unpriced rows into priced ones. Without it the only
 * way to put a service on sale is raw SQL, which is not a thing operations should ever
 * be asked to do.
 */

export type AdminService = {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  categorySlug: string;
  categoryLabel: string;
  fulfilmentType: "service" | "consultation";
  pricePaise: number | null;
  currency: string;
  turnaroundDays: number | null;
  active: boolean;
  featured: boolean;
};

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
  active: services.active,
  featured: services.featured,
  position: services.position,
};

export type ListOptions = {
  categorySlug?: string;
  search?: string;
  /** Undefined means both — the default, since the work is finding unpriced rows. */
  active?: boolean;
  cursor?: string;
  limit: number;
};

export async function listAllServices(
  actor: Actor,
  options: ListOptions,
): Promise<Page<AdminService>> {
  authorize(actor, "catalogue.read", { minimumRole: "admin" });

  const filters: (SQL | undefined)[] = [];
  if (options.categorySlug) filters.push(eq(categories.slug, options.categorySlug));
  if (options.active !== undefined) filters.push(eq(services.active, options.active));
  if (options.search) {
    const pattern = `%${options.search}%`;
    filters.push(or(ilike(services.title, pattern), ilike(services.slug, pattern)));
  }
  if (options.cursor) {
    const [category, slug] = decodeCursor(options.cursor, 2);
    // Keyset on (category, slug) — the same compound key the table is unique on, so
    // the order is total and no row can be skipped or repeated between pages.
    filters.push(sql`(${categories.slug}, ${services.slug}) > (${category}, ${slug})`);
  }

  const rows = await db
    .select(SELECTION)
    .from(services)
    .innerJoin(categories, eq(categories.id, services.categoryId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(categories.slug), asc(services.slug))
    .limit(options.limit + 1);

  const page = toPage(rows, options.limit, (row) => encodeCursor([row.categorySlug, row.slug]));

  return {
    items: page.items.map(({ position: _position, ...rest }) => rest),
    nextCursor: page.nextCursor,
  };
}

export type PriceUpdate = {
  pricePaise?: number | null;
  turnaroundDays?: number | null;
  summary?: string | null;
  active?: boolean;
  featured?: boolean;
};

/**
 * Prices or publishes one service.
 *
 * Addressed by `(category, slug)` because slugs are not unique — 22 exist in two
 * categories at once, and pricing the wrong one of a pair is exactly the mistake this
 * addressing prevents.
 *
 * Publishing without a price is refused by the database, not here. The
 * `services_priced_when_active` CHECK raises 23514, which is translated into something
 * an operator can act on rather than surfacing as a 500.
 */
export async function updateService(
  actor: Actor,
  categorySlug: string,
  serviceSlug: string,
  update: PriceUpdate,
): Promise<AdminService> {
  authorize(actor, "catalogue.update", { minimumRole: "admin" });

  const [existing] = await db
    .select(SELECTION)
    .from(services)
    .innerJoin(categories, eq(categories.id, services.categoryId))
    .where(and(eq(categories.slug, categorySlug), eq(services.slug, serviceSlug)))
    .limit(1);

  if (!existing) throw new ApiError("not_found", "No such service.");

  try {
    const [updated] = await db
      .update(services)
      .set({
        ...(update.pricePaise !== undefined ? { pricePaise: update.pricePaise } : {}),
        ...(update.turnaroundDays !== undefined ? { turnaroundDays: update.turnaroundDays } : {}),
        ...(update.summary !== undefined ? { summary: update.summary } : {}),
        ...(update.active !== undefined ? { active: update.active } : {}),
        ...(update.featured !== undefined ? { featured: update.featured } : {}),
      })
      .where(eq(services.id, existing.id))
      .returning({
        id: services.id,
        slug: services.slug,
        title: services.title,
        summary: services.summary,
        fulfilmentType: services.fulfilmentType,
        pricePaise: services.pricePaise,
        currency: services.currency,
        turnaroundDays: services.turnaroundDays,
        active: services.active,
        featured: services.featured,
      });

    if (!updated) throw new ApiError("internal", "Could not update the service.");

    await recordAudit({
      actor,
      action: "catalogue.updated",
      resourceType: "service",
      resourceId: `${categorySlug}/${serviceSlug}`,
      before: {
        pricePaise: existing.pricePaise,
        turnaroundDays: existing.turnaroundDays,
        active: existing.active,
        featured: existing.featured,
      },
      after: {
        pricePaise: updated.pricePaise,
        turnaroundDays: updated.turnaroundDays,
        active: updated.active,
        featured: updated.featured,
      },
    });

    return {
      ...updated,
      categorySlug,
      categoryLabel: existing.categoryLabel,
    };
  } catch (error) {
    if (isPgError(error, PG.CHECK_VIOLATION)) {
      throw new ApiError(
        "invalid_input",
        "A service needs a price and a turnaround before it can go on sale.",
        {
          cause: error,
          fieldErrors: {
            pricePaise: ["Required before publishing."],
            turnaroundDays: ["Required before publishing."],
          },
        },
      );
    }
    throw error;
  }
}

/** Counts for the admin overview: how much of the catalogue is actually sellable. */
export async function catalogueSummary(
  actor: Actor,
): Promise<{ total: number; priced: number; live: number; featured: number }> {
  authorize(actor, "catalogue.read", { minimumRole: "admin" });

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      priced: sql<number>`count(*) filter (where ${services.pricePaise} is not null)::int`,
      live: sql<number>`count(*) filter (where ${services.active})::int`,
      featured: sql<number>`count(*) filter (where ${services.featured})::int`,
    })
    .from(services);

  return row ?? { total: 0, priced: 0, live: 0, featured: 0 };
}
