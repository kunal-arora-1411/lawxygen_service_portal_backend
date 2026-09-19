import { Router } from "express";
import { z } from "zod";
import { handler, parse } from "../../lib/http.js";
import { actorOf, requireRole } from "../auth/middleware.js";
import { acknowledge, currentLoad, listMatters, setAvailability } from "./service.js";

export function professionalRoutes(): Router {
  const router = Router();
  router.use(requireRole("professional"));

  router.get(
    "/matters",
    handler(async (req) => {
      const { open } = parse(z.object({ open: z.coerce.boolean().optional() }), req.query);
      return listMatters(actorOf(req), open ?? false);
    }),
  );

  router.get(
    "/load",
    handler((req) => currentLoad(actorOf(req))),
  );

  router.post(
    "/matters/:id/acknowledge",
    handler(async (req) => {
      const { id } = parse(z.object({ id: z.uuid() }), req.params);
      return acknowledge(actorOf(req), id);
    }),
  );

  router.put(
    "/availability",
    handler(async (req) => {
      const { available } = parse(z.object({ available: z.boolean() }), req.body);
      return setAvailability(actorOf(req), available);
    }),
  );

  return router;
}
