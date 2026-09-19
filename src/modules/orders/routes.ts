import { Router } from "express";
import { z } from "zod";
import { handler, parse } from "../../lib/http.js";
import { pageQuerySchema } from "../../lib/pagination.js";
import { actorOf, requireAuth } from "../auth/middleware.js";
import { createOrder, findOrder, listOrdersFor } from "./service.js";

const slugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]+$/, "Not a valid slug.")
  .max(160);

/** Both parts, because 22 slugs are shared between two categories. */
const createOrderSchema = z.object({
  category: slugSchema,
  service: slugSchema,
});

export function orderRoutes(): Router {
  const router = Router();

  // Everything here is a signed-in client's own data. The guard produces a clean 401;
  // authorize() inside each handler is what actually decides.
  router.use(requireAuth);

  router.post(
    "/",
    handler(async (req) => {
      const { category, service } = parse(createOrderSchema, req.body);
      return createOrder(actorOf(req), category, service);
    }, 201),
  );

  router.get(
    "/",
    handler(async (req) => {
      const { cursor, limit } = parse(pageQuerySchema, req.query);
      return listOrdersFor(actorOf(req), { cursor, limit });
    }),
  );

  router.get(
    "/:reference",
    handler(async (req) => {
      const { reference } = parse(
        z.object({
          reference: z
            .string()
            .trim()
            .regex(/^LX-\d{6,}$/, "Not an order reference."),
        }),
        req.params,
      );
      return findOrder(actorOf(req), reference);
    }),
  );

  return router;
}
