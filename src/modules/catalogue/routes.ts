import { Router } from "express";
import { z } from "zod";
import { handler, parse } from "../../lib/http.js";
import { pageQuerySchema } from "../../lib/pagination.js";
import { findService, listCategories, listServices } from "./repository.js";

const slugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]+$/, "Not a valid slug.")
  .max(160);

const listQuerySchema = pageQuerySchema.extend({
  category: slugSchema.optional(),
  q: z.string().trim().min(1).max(120).optional(),
  featured: z.coerce.boolean().optional(),
});

/**
 * The catalogue is public.
 *
 * Browsing prices before signing in is the point — the marketing site sends people
 * straight here, and forcing a login to see a price would lose them at the door. The
 * purchase is what requires an account.
 */
export function catalogueRoutes(): Router {
  const router = Router();

  router.get(
    "/categories",
    handler(() => listCategories()),
  );

  router.get(
    "/services",
    handler(async (req) => {
      const query = parse(listQuerySchema, req.query);
      return listServices({
        categorySlug: query.category,
        search: query.q,
        featuredOnly: query.featured,
        cursor: query.cursor,
        limit: query.limit,
      });
    }),
  );

  /**
   * Category and slug both, because 22 slugs exist in two categories at once. This is
   * also the shape of the checkout deep link from the marketing site.
   */
  router.get(
    "/services/:category/:slug",
    handler(async (req) => {
      const { category, slug } = parse(
        z.object({ category: slugSchema, slug: slugSchema }),
        req.params,
      );
      return findService(category, slug);
    }),
  );

  return router;
}
