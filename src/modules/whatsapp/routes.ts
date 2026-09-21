import { and, desc, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/client.js";
import {
  assignments,
  orders,
  professionals,
  users,
  whatsappSendAttempts,
} from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { handler, parse } from "../../lib/http.js";
import { authorize } from "../../lib/auth/policy.js";
import { actorOf, requireRole } from "../auth/middleware.js";
import { isConfigured } from "./client.js";
import { sendTemplateMessage } from "./send.js";
import {
  assignableMembers,
  listConversations,
  listMessages,
  replyWithText,
  unassignedCount,
  updateConversation,
} from "./conversations.js";
import {
  checkTemplate,
  createTemplate,
  listTemplates,
  sendableTemplates,
  syncTemplates,
} from "./templates.js";

/**
 * Firing a template by hand, and managing the registry.
 *
 * Mounted twice — under `/admin/whatsapp` and `/pro/whatsapp` — because both surfaces
 * need to send, and the only difference is *who they may send to*. An admin may message
 * anyone; a professional may message only the client on a matter they currently hold.
 * That check is the substance of this file.
 */

const templateDraftSchema = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]+$/, "Lowercase letters, numbers and underscores only.")
    .max(512),
  language: z.string().trim().max(32).optional(),
  category: z.enum(["utility", "authentication", "marketing"]).optional(),
  body: z.string().trim().min(1).max(1024),
  footer: z.string().trim().max(60).optional(),
  samples: z.array(z.string().trim().max(200)).max(10).default([]),
  variables: z.array(z.string().trim().max(120)).max(10).default([]),
});

const sendSchema = z.object({
  templateName: z.string().trim().min(1).max(512),
  language: z.string().trim().max(32).optional(),
  variables: z.array(z.string().trim().max(1024)).max(10).default([]),
  /** Who to message. Exactly one of these. */
  orderReference: z
    .string()
    .trim()
    .regex(/^LX-\d{6,}$/)
    .optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{8,15}$/)
    .optional(),
});

/**
 * Resolves the recipient, and decides whether this actor may reach them.
 *
 * A professional sending to a bare phone number would be a way to use Lawxygen's
 * WhatsApp number for anything they liked, at Lawxygen's cost. So they may only send
 * against an order, and only one they hold.
 */
async function resolveRecipient(
  actor: ReturnType<typeof actorOf>,
  input: z.infer<typeof sendSchema>,
) {
  if (input.phone && input.orderReference) {
    throw new ApiError("invalid_input", "Give either an order reference or a phone number.");
  }

  if (input.phone) {
    // Admin only. A free-form recipient is not a professional's to choose.
    authorize(actor, "whatsapp.send.arbitrary", { minimumRole: "admin" });
    return { phone: input.phone, orderId: null, userId: null };
  }

  if (!input.orderReference) {
    throw new ApiError("invalid_input", "An order reference is required.");
  }

  const [order] = await db
    .select({
      id: orders.id,
      userId: users.id,
      phone: users.phone,
      consent: users.whatsappConsent,
    })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.reference, input.orderReference))
    .limit(1);

  if (!order) throw new ApiError("not_found", "No such order.");
  if (!order.phone) throw new ApiError("conflict", "That client has no phone number on file.");
  if (!order.consent) {
    throw new ApiError("conflict", "That client has not agreed to WhatsApp messages.");
  }

  if (actor.role === "professional") {
    /**
     * Joined through `professionals` on the user id rather than reading
     * `actor.professionalId`. That field is declared on the actor type but nothing
     * ever populates it — the session carries only the user id and the role.
     */
    const [held] = await db
      .select({ id: assignments.id })
      .from(assignments)
      .innerJoin(orders, eq(orders.id, assignments.orderId))
      .innerJoin(professionals, eq(professionals.id, assignments.professionalId))
      .where(
        and(eq(orders.reference, input.orderReference), eq(professionals.userId, actor.userId)),
      )
      .limit(1);

    if (!held) throw new ApiError("not_found", "No such order.");
  }

  return { phone: order.phone, orderId: order.id, userId: order.userId };
}

function whatsappRoutes(minimumRole: "admin" | "professional"): Router {
  const router = Router();
  router.use(requireRole(minimumRole));

  /** What can actually be sent — approved templates only. */
  router.get(
    "/templates",
    handler(async (req) =>
      minimumRole === "admin" ? listTemplates(actorOf(req)) : sendableTemplates(actorOf(req)),
    ),
  );

  router.post(
    "/send",
    handler(async (req) => {
      const actor = actorOf(req);
      const input = parse(sendSchema, req.body);

      if (!isConfigured()) {
        throw new ApiError("upstream_failure", "WhatsApp is not connected yet.");
      }

      const target = await resolveRecipient(actor, input);

      /**
       * A manual send is keyed on the actor, the template and the minute. Somebody
       * double-clicking sends one message; somebody deliberately sending the same
       * template again a minute later sends two, which is what they meant.
       */
      const minute = Math.floor(Date.now() / 60_000);
      const idempotencyKey = [
        "manual",
        actor.userId,
        input.templateName,
        target.phone,
        String(minute),
      ].join(":");

      return sendTemplateMessage({
        idempotencyKey,
        source: minimumRole === "admin" ? "admin" : "professional",
        recipientPhone: target.phone,
        templateName: input.templateName,
        ...(input.language ? { language: input.language } : {}),
        variables: input.variables,
        orderId: target.orderId,
        userId: target.userId,
        sentByUserId: actor.userId,
      });
    }),
  );

  /** Everything sent about one order. The beginnings of a thread view. */
  router.get(
    "/orders/:reference/messages",
    handler(async (req) => {
      const actor = actorOf(req);
      const { reference } = parse(
        z.object({
          reference: z
            .string()
            .trim()
            .regex(/^LX-\d{6,}$/),
        }),
        req.params,
      );
      await resolveRecipient(actor, { templateName: "", variables: [], orderReference: reference });

      const rows = await db
        .select({
          id: whatsappSendAttempts.id,
          templateName: whatsappSendAttempts.templateName,
          status: whatsappSendAttempts.status,
          source: whatsappSendAttempts.source,
          failureKind: whatsappSendAttempts.failureKind,
          lastError: whatsappSendAttempts.lastError,
          payload: whatsappSendAttempts.payload,
          createdAt: whatsappSendAttempts.createdAt,
        })
        .from(whatsappSendAttempts)
        .innerJoin(orders, eq(orders.id, whatsappSendAttempts.orderId))
        .where(eq(orders.reference, reference))
        .orderBy(desc(whatsappSendAttempts.createdAt))
        .limit(100);

      return rows;
    }),
  );

  // ------------------------------------------------------------- conversations

  /**
   * The thread list. An admin sees every conversation; a professional sees only the
   * clients on matters they currently hold — the filter lives in the service, because
   * a route guard is a convenience and never the boundary.
   */
  router.get(
    "/conversations",
    handler((req) => listConversations(actorOf(req))),
  );

  router.get(
    "/conversations/:id/messages",
    handler(async (req) => {
      const { id } = parse(z.object({ id: z.uuid() }), req.params);
      return listMessages(actorOf(req), id);
    }),
  );

  /**
   * A free-form reply. Only possible inside the 24-hour window the client opened by
   * writing to us; outside it this refuses and the caller sends a template instead.
   */
  router.post(
    "/conversations/:id/messages",
    handler(async (req) => {
      const { id } = parse(z.object({ id: z.uuid() }), req.params);
      const { text } = parse(z.object({ text: z.string().trim().min(1).max(4096) }), req.body);
      return replyWithText(actorOf(req), id, text);
    }, 201),
  );

  if (minimumRole === "admin") {
    /** Who a thread can be handed to. */
    router.get(
      "/members",
      handler((req) => assignableMembers(actorOf(req))),
    );

    router.get(
      "/conversations/unassigned/count",
      handler(async (req) => ({ count: await unassignedCount(actorOf(req)) })),
    );

    router.patch(
      "/conversations/:id",
      handler(async (req) => {
        const { id } = parse(z.object({ id: z.uuid() }), req.params);
        const { action, assigneeUserId } = parse(
          z.object({
            action: z.enum(["assign", "takeover", "resolve", "reopen"]),
            assigneeUserId: z.uuid().optional(),
          }),
          req.body,
        );
        return updateConversation(actorOf(req), id, action, assigneeUserId);
      }),
    );

    router.post(
      "/templates/sync",
      handler((req) => syncTemplates(actorOf(req))),
    );

    /** Validate without submitting, so a bad name is never spent. */
    router.post(
      "/templates/check",
      handler((req) => checkTemplate(actorOf(req), parse(templateDraftSchema, req.body))),
    );

    router.post(
      "/templates",
      handler(
        async (req) => createTemplate(actorOf(req), parse(templateDraftSchema, req.body)),
        201,
      ),
    );
  }

  return router;
}

export const adminWhatsappRoutes = (): Router => whatsappRoutes("admin");
export const professionalWhatsappRoutes = (): Router => whatsappRoutes("professional");
