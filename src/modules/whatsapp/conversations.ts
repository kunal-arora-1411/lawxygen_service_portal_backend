import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db/client.js";
import {
  assignments,
  OPEN_ASSIGNMENT_STATUSES,
  orders,
  professionals,
  users,
  whatsappConversations,
  whatsappMessages,
} from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { authorize, hasAtLeast, type Actor } from "../../lib/auth/policy.js";
import { logger } from "../../lib/logger.js";
import { sendFreeText } from "./client.js";

/**
 * Threads, and who may read or answer them.
 *
 * The rule that shapes every screen here is Meta's **24-hour window**. A business may
 * only send free-form text within 24 hours of the client's last message. Outside it,
 * nothing but an approved template will go, and a template does *not* reopen the
 * window — only the client writing again does.
 *
 * So the window state is part of the conversation's public shape, not an error the UI
 * discovers by trying. A professional whose first out-of-window message fails with a
 * gateway error concludes the product is broken.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;

export type ConversationView = {
  id: string;
  contactPhone: string;
  contactName: string | null;
  clientName: string | null;
  status: "open" | "resolved";
  assignedUserId: string | null;
  assignedName: string | null;
  unreadCount: number;
  lastMessageAt: string;
  /** When free-form replies stop being possible. Null if they never started. */
  replyWindowExpiresAt: string | null;
  /** The only thing a screen needs to decide between a textbox and a template picker. */
  windowOpen: boolean;
};

export type MessageView = {
  id: string;
  direction: "inbound" | "outbound";
  body: string | null;
  type: string;
  status: string | null;
  failedReason: string | null;
  sentByName: string | null;
  occurredAt: string;
};

function windowFrom(lastInboundAt: Date | null): { expiresAt: Date | null; open: boolean } {
  if (!lastInboundAt) return { expiresAt: null, open: false };
  const expiresAt = new Date(lastInboundAt.getTime() + WINDOW_MS);
  return { expiresAt, open: expiresAt.getTime() > Date.now() };
}

/**
 * Which conversations this actor may see.
 *
 * An admin sees everything. A professional sees only the clients on matters they
 * currently hold — the thread belongs to the client, not the matter, so the filter has
 * to run through the client's user id rather than through the conversation.
 */
async function visibleConversationIds(actor: Actor): Promise<string[] | "all"> {
  if (hasAtLeast(actor.role, "admin")) return "all";

  const rows = await db
    .selectDistinct({ id: whatsappConversations.id })
    .from(assignments)
    .innerJoin(professionals, eq(professionals.id, assignments.professionalId))
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .innerJoin(whatsappConversations, eq(whatsappConversations.userId, orders.userId))
    .where(
      and(
        eq(professionals.userId, actor.userId),
        inArray(assignments.status, OPEN_ASSIGNMENT_STATUSES),
      ),
    );

  return rows.map((row) => row.id);
}

export async function listConversations(actor: Actor): Promise<ConversationView[]> {
  authorize(actor, "whatsapp.conversation.read", { minimumRole: "professional" });

  const visible = await visibleConversationIds(actor);
  if (visible !== "all" && visible.length === 0) return [];

  const assignee = db
    .$with("assignee")
    .as(db.select({ id: users.id, name: users.name }).from(users));

  const rows = await db
    .with(assignee)
    .select({
      id: whatsappConversations.id,
      contactPhone: whatsappConversations.contactPhone,
      contactName: whatsappConversations.contactName,
      clientName: users.name,
      status: whatsappConversations.status,
      assignedUserId: whatsappConversations.assignedUserId,
      assignedName: assignee.name,
      unreadCount: whatsappConversations.unreadCount,
      lastMessageAt: whatsappConversations.lastMessageAt,
      lastInboundAt: whatsappConversations.lastInboundAt,
    })
    .from(whatsappConversations)
    .leftJoin(users, eq(users.id, whatsappConversations.userId))
    .leftJoin(assignee, eq(assignee.id, whatsappConversations.assignedUserId))
    .where(visible === "all" ? undefined : inArray(whatsappConversations.id, visible))
    .orderBy(desc(whatsappConversations.lastMessageAt))
    .limit(100);

  return rows.map((row) => {
    const window = windowFrom(row.lastInboundAt);
    return {
      id: row.id,
      contactPhone: row.contactPhone,
      contactName: row.contactName,
      clientName: row.clientName,
      status: row.status,
      assignedUserId: row.assignedUserId,
      assignedName: row.assignedName,
      unreadCount: row.unreadCount,
      lastMessageAt: row.lastMessageAt.toISOString(),
      replyWindowExpiresAt: window.expiresAt?.toISOString() ?? null,
      windowOpen: window.open,
    };
  });
}

async function readableConversation(actor: Actor, conversationId: string) {
  const visible = await visibleConversationIds(actor);
  if (visible !== "all" && !visible.includes(conversationId)) {
    // not_found, not forbidden: a 403 would confirm the thread exists.
    throw new ApiError("not_found", "No such conversation.");
  }

  const [row] = await db
    .select()
    .from(whatsappConversations)
    .where(eq(whatsappConversations.id, conversationId))
    .limit(1);

  if (!row) throw new ApiError("not_found", "No such conversation.");
  return row;
}

export async function listMessages(actor: Actor, conversationId: string): Promise<MessageView[]> {
  authorize(actor, "whatsapp.conversation.read", { minimumRole: "professional" });
  await readableConversation(actor, conversationId);

  const rows = await db
    .select({
      id: whatsappMessages.id,
      direction: whatsappMessages.direction,
      body: whatsappMessages.body,
      type: whatsappMessages.type,
      status: whatsappMessages.status,
      failedReason: whatsappMessages.failedReason,
      sentByName: users.name,
      occurredAt: whatsappMessages.occurredAt,
    })
    .from(whatsappMessages)
    .leftJoin(users, eq(users.id, whatsappMessages.sentByUserId))
    .where(eq(whatsappMessages.conversationId, conversationId))
    .orderBy(whatsappMessages.occurredAt)
    .limit(300);

  // Opening a thread is reading it.
  await db
    .update(whatsappConversations)
    .set({ unreadCount: 0 })
    .where(eq(whatsappConversations.id, conversationId));

  return rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    body: row.body,
    type: row.type,
    status: row.status,
    failedReason: row.failedReason,
    sentByName: row.sentByName,
    occurredAt: row.occurredAt.toISOString(),
  }));
}

/**
 * A free-form reply.
 *
 * Refused outside the 24-hour window with a code the UI can act on, rather than a
 * gateway error. Meta would reject it anyway; failing here says why, and says it
 * before spending a round trip.
 */
export async function replyWithText(
  actor: Actor,
  conversationId: string,
  text: string,
): Promise<MessageView> {
  authorize(actor, "whatsapp.conversation.reply", { minimumRole: "professional" });

  const conversation = await readableConversation(actor, conversationId);
  const window = windowFrom(conversation.lastInboundAt);

  if (!window.open) {
    throw new ApiError(
      "conflict",
      conversation.lastInboundAt
        ? "The 24-hour reply window has closed. Send an approved template to reopen the conversation."
        : "This client has not written to us yet, so only an approved template can be sent.",
    );
  }

  const { metaMessageId } = await sendFreeText({
    recipientPhone: conversation.contactPhone,
    text,
    correlationId: randomUUID(),
  });

  const now = new Date();
  const [saved] = await db
    .insert(whatsappMessages)
    .values({
      conversationId,
      direction: "outbound",
      metaMessageId,
      type: "text",
      body: text,
      payload: { type: "text", text: { body: text } },
      sentByUserId: actor.userId,
      status: "sent",
      occurredAt: now,
    })
    .returning();

  if (!saved) throw new ApiError("internal", "Could not record the message.");

  await db
    .update(whatsappConversations)
    .set({
      lastMessageAt: now,
      status: "open",
      resolvedAt: null,
      // Answering a thread claims it, if nobody had.
      ...(conversation.assignedUserId ? {} : { assignedUserId: actor.userId, assignedAt: now }),
    })
    .where(eq(whatsappConversations.id, conversationId));

  const [sender] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);

  return {
    id: saved.id,
    direction: "outbound",
    body: text,
    type: "text",
    status: "sent",
    failedReason: null,
    sentByName: sender?.name ?? null,
    occurredAt: now.toISOString(),
  };
}

/**
 * Handing a thread to somebody, taking it, or closing it.
 *
 * Admin only. A professional answering a thread claims it implicitly, which is enough
 * for them — deciding who else should hold a conversation is an operations call.
 */
export async function updateConversation(
  actor: Actor,
  conversationId: string,
  action: "assign" | "takeover" | "resolve" | "reopen",
  assigneeUserId?: string,
): Promise<ConversationView> {
  authorize(actor, "whatsapp.conversation.manage", { minimumRole: "admin" });

  const [conversation] = await db
    .select({ id: whatsappConversations.id })
    .from(whatsappConversations)
    .where(eq(whatsappConversations.id, conversationId))
    .limit(1);

  if (!conversation) throw new ApiError("not_found", "No such conversation.");

  const now = new Date();
  let patch: Record<string, unknown>;

  switch (action) {
    case "assign": {
      if (!assigneeUserId) throw new ApiError("invalid_input", "Choose somebody to assign it to.");
      const [member] = await db
        .select({ id: users.id, role: users.role, status: users.status })
        .from(users)
        .where(eq(users.id, assigneeUserId))
        .limit(1);

      // Only somebody who could actually open the thread. Assigning a client to it
      // would be a dead end nobody notices until they look.
      if (!member || member.status !== "active" || !hasAtLeast(member.role, "professional")) {
        throw new ApiError("invalid_input", "That person cannot take a conversation.");
      }
      patch = { assignedUserId: assigneeUserId, assignedAt: now, status: "open", resolvedAt: null };
      break;
    }
    case "takeover":
      patch = { assignedUserId: actor.userId, assignedAt: now, status: "open", resolvedAt: null };
      break;
    case "resolve":
      /**
       * Unassigned on resolve, deliberately. A closed thread that stays owned means the
       * next message from that client lands silently in somebody's list rather than
       * the unassigned queue.
       */
      patch = { status: "resolved", resolvedAt: now, unreadCount: 0, assignedUserId: null };
      break;
    case "reopen":
      patch = { status: "open", resolvedAt: null };
      break;
  }

  await db
    .update(whatsappConversations)
    .set(patch)
    .where(eq(whatsappConversations.id, conversationId));

  await recordAudit({
    actor,
    action: `whatsapp.conversation.${action}`,
    resourceType: "whatsapp_conversation",
    resourceId: conversationId,
    after: patch,
  });

  logger.info({ conversationId, action }, "whatsapp conversation updated");

  const [view] = await listConversationsById(actor, conversationId);
  if (!view) throw new ApiError("internal", "Could not read the conversation back.");
  return view;
}

async function listConversationsById(actor: Actor, id: string): Promise<ConversationView[]> {
  const all = await listConversations(actor);
  return all.filter((conversation) => conversation.id === id);
}

/** Who an admin may hand a thread to. */
export async function assignableMembers(
  actor: Actor,
): Promise<{ id: string; name: string | null; role: string }[]> {
  authorize(actor, "whatsapp.conversation.manage", { minimumRole: "admin" });

  return db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(
      and(
        eq(users.status, "active"),
        or(eq(users.role, "professional"), eq(users.role, "admin"), eq(users.role, "superadmin")),
      ),
    )
    .orderBy(users.name)
    .limit(200);
}

/** Threads nobody owns. The queue an admin works from. */
export async function unassignedCount(actor: Actor): Promise<number> {
  authorize(actor, "whatsapp.conversation.manage", { minimumRole: "admin" });

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(whatsappConversations)
    .where(
      and(eq(whatsappConversations.status, "open"), isNull(whatsappConversations.assignedUserId)),
    );

  return Number(row?.count ?? 0);
}
