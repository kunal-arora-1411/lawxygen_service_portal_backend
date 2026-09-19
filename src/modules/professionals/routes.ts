import { Router } from "express";
import { z } from "zod";
import { handler, parse } from "../../lib/http.js";
import { actorOf, requireAuth, requireRole } from "../auth/middleware.js";
import {
  addCredential,
  applyAsProfessional,
  myApplication,
  removeCredential,
  savePayoutIdentity,
  submitForReview,
  updateApplication,
  withdrawFromReview,
} from "./onboarding.js";
import {
  applySchema,
  credentialSchema,
  payoutIdentitySchema,
  updateProfileSchema,
} from "./schemas.js";
import {
  acknowledge,
  advanceMatter,
  currentLoad,
  earningsFor,
  listMatters,
  payoutHistory,
  setAvailability,
} from "./service.js";

export function professionalRoutes(): Router {
  const router = Router();

  /**
   * Applying is the one thing here a client may do, because until they have applied
   * they are not a professional. Everything after it sits behind the role, which
   * applying grants — resolveSession reads the role fresh on each request, so the very
   * next call is already through.
   */
  router.post(
    "/apply",
    requireAuth,
    handler(async (req) => applyAsProfessional(actorOf(req), parse(applySchema, req.body)), 201),
  );

  router.use(requireRole("professional"));

  // --------------------------------------------------------------- onboarding

  router.get(
    "/application",
    handler((req) => myApplication(actorOf(req))),
  );

  router.patch(
    "/application",
    handler(async (req) => updateApplication(actorOf(req), parse(updateProfileSchema, req.body))),
  );

  router.post(
    "/application/credentials",
    handler(async (req) => addCredential(actorOf(req), parse(credentialSchema, req.body)), 201),
  );

  router.delete(
    "/application/credentials/:id",
    handler(async (req) => {
      const { id } = parse(z.object({ id: z.uuid() }), req.params);
      await removeCredential(actorOf(req), id);
      return { removed: true };
    }),
  );

  /** Encrypted on the way in. Nothing here ever comes back out in the clear. */
  router.put(
    "/application/payout-identity",
    handler(async (req) => savePayoutIdentity(actorOf(req), parse(payoutIdentitySchema, req.body))),
  );

  router.post(
    "/application/submit",
    handler((req) => submitForReview(actorOf(req))),
  );

  router.post(
    "/application/withdraw",
    handler((req) => withdrawFromReview(actorOf(req))),
  );

  // ------------------------------------------------------------------ matters

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

  router.post(
    "/matters/:id/status",
    handler(async (req) => {
      const { id } = parse(z.object({ id: z.uuid() }), req.params);
      const { status } = parse(
        z.object({ status: z.enum(["in_progress", "awaiting_client", "completed"]) }),
        req.body,
      );
      return advanceMatter(actorOf(req), id, status);
    }),
  );

  router.get(
    "/payouts",
    handler((req) => payoutHistory(actorOf(req))),
  );

  router.get(
    "/earnings",
    handler((req) => earningsFor(actorOf(req))),
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
