import { Router } from "express";
import { z } from "zod";
import { handler, parse } from "../../lib/http.js";
import { assignmentQueueDepth } from "../assignment/escalation.js";
import { actorOf, requireRole } from "../auth/middleware.js";
import { reassignProfessionalSchema, suspendSchema } from "./schemas.js";
import { reassignOrder, suspendProfessional, verifyProfessional } from "./service.js";

export function adminRoutes(): Router {
  const router = Router();
  // A convenience gate. Each handler still calls authorize() for its own action, which
  // is what enforces the impersonation blocklist on the ones that move money.
  router.use(requireRole("admin"));

  router.get(
    "/queue",
    handler(() => assignmentQueueDepth()),
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

  router.post(
    "/orders/:reference/reassign",
    handler(async (req) => {
      const { reference } = parse(reassignProfessionalSchema, req.params);
      const { reason } = parse(suspendSchema, req.body);
      return reassignOrder(actorOf(req), reference, reason);
    }),
  );

  return router;
}
