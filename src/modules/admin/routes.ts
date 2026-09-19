import { Router } from "express";
import { z } from "zod";
import { handler, parse } from "../../lib/http.js";
import { assignmentQueueDepth } from "../assignment/escalation.js";
import { actorOf, requireRole } from "../auth/middleware.js";
import { catalogueSummary, listAllServices, updateService } from "./catalogue.js";
import { listOrders, listProfessionals, overview } from "./queries.js";
import {
  listOrdersQuerySchema,
  listProfessionalsQuerySchema,
  listServicesQuerySchema,
  orderReferenceSchema,
  serviceKeySchema,
  suspendSchema,
  updateServiceSchema,
} from "./schemas.js";
import { reassignOrder, suspendProfessional, verifyProfessional } from "./service.js";

export function adminRoutes(): Router {
  const router = Router();
  // A convenience gate. Each handler still calls authorize() for its own action, which
  // is what enforces the impersonation blocklist on the ones that move money.
  router.use(requireRole("admin"));

  // ------------------------------------------------------------------ overview

  router.get(
    "/overview",
    handler(async (req) => {
      const actor = actorOf(req);
      const [counts, catalogue, queue] = await Promise.all([
        overview(actor),
        catalogueSummary(actor),
        assignmentQueueDepth(),
      ]);
      return { ...counts, catalogue, queue };
    }),
  );

  router.get(
    "/queue",
    handler(() => assignmentQueueDepth()),
  );

  // ----------------------------------------------------------------- catalogue

  router.get(
    "/services",
    handler(async (req) => {
      const query = parse(listServicesQuerySchema, req.query);
      return listAllServices(actorOf(req), {
        categorySlug: query.category,
        search: query.q,
        active: query.active,
        cursor: query.cursor,
        limit: query.limit,
      });
    }),
  );

  /**
   * Addressed by category and slug together, because 22 slugs exist in two categories
   * at once. Pricing the wrong half of such a pair is the mistake this prevents.
   */
  router.patch(
    "/services/:category/:slug",
    handler(async (req) => {
      const { category, slug } = parse(serviceKeySchema, req.params);
      const update = parse(updateServiceSchema, req.body);
      return updateService(actorOf(req), category, slug, update);
    }),
  );

  // ------------------------------------------------------------- professionals

  router.get(
    "/professionals",
    handler(async (req) => {
      const { status } = parse(listProfessionalsQuerySchema, req.query);
      return listProfessionals(actorOf(req), { status });
    }),
  );

  router.post(
    "/professionals/:id/verify",
    handler(async (req) => {
      const { id } = parse(z.object({ id: z.uuid() }), req.params);
      return verifyProfessional(actorOf(req), id);
    }),
  );

  router.post(
    "/professionals/:id/suspend",
    handler(async (req) => {
      const { id } = parse(z.object({ id: z.uuid() }), req.params);
      const { reason } = parse(suspendSchema, req.body);
      await suspendProfessional(actorOf(req), id, reason);
      return { suspended: true };
    }),
  );

  // -------------------------------------------------------------------- orders

  router.get(
    "/orders",
    handler(async (req) => {
      const query = parse(listOrdersQuerySchema, req.query);
      return listOrders(actorOf(req), {
        status: query.status,
        cursor: query.cursor,
        limit: query.limit,
      });
    }),
  );

  router.post(
    "/orders/:reference/reassign",
    handler(async (req) => {
      const { reference } = parse(orderReferenceSchema, req.params);
      const { reason } = parse(suspendSchema, req.body);
      return reassignOrder(actorOf(req), reference, reason);
    }),
  );

  return router;
}
