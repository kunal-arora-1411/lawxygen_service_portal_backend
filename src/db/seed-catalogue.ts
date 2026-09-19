import "../lib/load-env.js";

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { closeDatabase, db } from "./client.js";
import { categories, services } from "./schema/index.js";

/**
 * Seeds the sellable catalogue from the marketing site's own source of truth.
 *
 * Run with:  npm run db:seed [-- --catalogue <path to serviceCatalog.ts>]
 *
 * Idempotent. Re-running updates titles and positions and adds anything new; it never
 * touches price, turnaround, active or featured, because those are set by admin and the
 * seed has no business overwriting a live price with a null.
 *
 * Rows arrive **inactive**: the catalogue carries no prices, and the
 * `services_priced_when_active` constraint makes publishing an unpriced service
 * impossible rather than merely discouraged.
 */

const DEFAULT_CATALOGUE = resolve(process.cwd(), "../LAWXYGEN_AGAIN_NEW_UI/data/serviceCatalog.ts");

/**
 * The marketing site's slug function, reproduced exactly.
 *
 * Copied rather than imported: that repo is a separate Next.js application and this one
 * must build without it. The parity test asserts the two agree, so a divergence fails
 * CI instead of silently producing URLs that 404.
 *
 * Source: LAWXYGEN_AGAIN_NEW_UI/lib/serviceRoutes.ts
 */
export function serviceSlug(service: string): string {
  return service
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type CatalogueGroup = { slug: string; label: string; accent: string; services: string[] };

/**
 * Loads the catalogue by importing the marketing site's module.
 *
 * `serviceCatalog.ts` is a plain exported array with no imports and no computation, so
 * the runtime can simply load it — this script runs under tsx, which strips the type
 * annotations. An earlier version scraped the array literal out of the file text and
 * evaluated it, which was both fragile (it matched the brackets in `ServiceGroup[]` and
 * silently produced an empty array) and an implied `eval` of another repo's source.
 */
export async function loadCatalogue(path: string): Promise<CatalogueGroup[]> {
  const module: unknown = await import(pathToFileURL(path).href);
  const exported = (module as { serviceCatalog?: unknown }).serviceCatalog;
  if (!Array.isArray(exported)) {
    throw new Error(`${path} does not export a serviceCatalog array.`);
  }
  return validateCatalogue(exported as CatalogueGroup[]);
}

/**
 * A catalogue that parses to nothing must fail here rather than seeding zero rows and
 * reporting success — which is exactly what the previous implementation did.
 */
export function validateCatalogue(groups: CatalogueGroup[]): CatalogueGroup[] {
  if (groups.length === 0) throw new Error("serviceCatalog is empty.");
  for (const group of groups) {
    if (!group.slug || !group.label || !Array.isArray(group.services) || !group.services.length) {
      throw new Error(`Category "${group.slug || "(unnamed)"}" has no services.`);
    }
  }
  return groups;
}

/** `talk-*` categories sell time with a professional; everything else is done for you. */
export function fulfilmentFor(categorySlug: string): "service" | "consultation" {
  return categorySlug.startsWith("talk-") ? "consultation" : "service";
}

export type SeedReport = {
  categories: number;
  services: number;
  distinctSlugs: number;
  duplicateSlugs: number;
};

export async function seedCatalogue(groups: CatalogueGroup[]): Promise<SeedReport> {
  let serviceCount = 0;
  const slugCounts = new Map<string, number>();

  await db.transaction(async (tx) => {
    for (const [position, group] of groups.entries()) {
      const [category] = await tx
        .insert(categories)
        .values({ slug: group.slug, label: group.label, accent: group.accent, position })
        .onConflictDoUpdate({
          target: categories.slug,
          set: { label: group.label, accent: group.accent, position },
        })
        .returning({ id: categories.id });

      if (!category) throw new Error(`Could not upsert category ${group.slug}`);

      for (const [index, title] of group.services.entries()) {
        const slug = serviceSlug(title);
        slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
        serviceCount += 1;

        await tx
          .insert(services)
          .values({
            categoryId: category.id,
            slug,
            title,
            fulfilmentType: fulfilmentFor(group.slug),
            position: index,
          })
          .onConflictDoUpdate({
            target: [services.categoryId, services.slug],
            // Price, turnaround, active and featured are admin's. Never reset here.
            set: { title, position: index, fulfilmentType: fulfilmentFor(group.slug) },
          });
      }
    }
  });

  return {
    categories: groups.length,
    services: serviceCount,
    distinctSlugs: slugCounts.size,
    duplicateSlugs: [...slugCounts.values()].filter((n) => n > 1).length,
  };
}

async function main(): Promise<void> {
  const flagIndex = process.argv.indexOf("--catalogue");
  const path = flagIndex !== -1 ? process.argv[flagIndex + 1] : DEFAULT_CATALOGUE;
  if (!path) throw new Error("--catalogue needs a path.");

  const groups = await loadCatalogue(resolve(path));
  const report = await seedCatalogue(groups);

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(services);

  process.stdout.write(
    `Seeded ${String(report.categories)} categories and ${String(report.services)} services ` +
      `(${String(report.distinctSlugs)} distinct slugs; ` +
      `${String(report.duplicateSlugs)} reused across categories). ` +
      `${String(count)} rows in services.\n` +
      `All rows are inactive until priced.\n`,
  );

  await closeDatabase();
}

// Only runs when invoked directly, so the helpers above stay importable by tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((error: unknown) => {
    process.stderr.write(`Seed failed: ${String(error)}\n`);
    process.exit(1);
  });
}
