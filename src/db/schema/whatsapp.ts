import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orders } from "./orders.js";
import { users } from "./auth.js";

/**
 * WhatsApp.
 *
 * Phase A is outbound only: approved templates, sent through Meta's Cloud API. There
 * are no conversations or inbound messages yet — those arrive in Phase B, along with
 * the 24-hour reply window that governs free-form replies.
 *
 * Two rules from Meta shape everything here, and both cost money to get wrong:
 *
 * 1. **A template does not open the reply window.** Only a message *from the client*
 *    does. So until a client answers, every outreach must be another template.
 * 2. **Category decides price.** A utility template costs about ₹0.115; a marketing one
 *    about ₹0.86 — seven and a half times more, for the life of the template. Meta
 *    assigns the category from the wording, so every template Lawxygen sends is written
 *    to be unambiguously transactional.
 */

export const whatsappTemplateStatusEnum = pgEnum("whatsapp_template_status", [
  "draft",
  "pending",
  "approved",
  "rejected",
  "paused",
  "disabled",
]);

export const whatsappTemplateCategoryEnum = pgEnum("whatsapp_template_category", [
  "utility",
  "authentication",
  "marketing",
]);

/**
 * The templates Meta has on file, mirrored locally.
 *
 * Meta owns the truth — a template can be approved, then paused for poor quality,
 * without anything happening here. `syncTemplates` refreshes this table, and a send
 * checks it first so an unapproved template fails locally rather than after a
 * round-trip.
 */
export const whatsappTemplates = pgTable(
  "whatsapp_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Meta's template name. The identifier a send actually uses. */
    name: text("name").notNull(),
    language: text("language").notNull().default("en"),
    category: whatsappTemplateCategoryEnum("category").notNull().default("utility"),
    status: whatsappTemplateStatusEnum("status").notNull().default("draft"),

    /** Meta's own id, once it has been submitted. */
    providerTemplateId: text("provider_template_id"),

    /** The component definitions as Meta returns them, for rendering a preview. */
    components: jsonb("components").notNull().default([]),

    /**
     * What each `{{1}}`, `{{2}}` means, in order — e.g. `["client name",
     * "order reference"]`. Meta does not tell us, and a caller passing variables in the
     * wrong order produces a plausible-looking but wrong message.
     */
    variables: jsonb("variables").notNull().default([]),

    /** Why Meta rejected or paused it. Shown to whoever has to fix it. */
    reviewNote: text("review_note"),

    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Meta allows one template per name per language.
    uniqueIndex("whatsapp_templates_name_lang_uq").on(t.name, t.language),
    index("whatsapp_templates_status_idx").on(t.status),
  ],
);

export const whatsappSendStatusEnum = pgEnum("whatsapp_send_status", [
  "sending",
  "accepted",
  "failed_retryable",
  "failed",
  /** Sent, but the connection dropped before Meta answered. See below. */
  "delivery_unknown",
]);

/**
 * Every attempt to send, and what became of it.
 *
 * Ported in spirit from PingMe's `whatsapp_send_attempt`, which is the best idea in
 * their codebase. The mechanism:
 *
 * - A row is **reserved by idempotency key** before anything is sent. A second caller
 *   with the same key finds the existing row instead of sending again.
 * - The reserver takes an **owner token**. Only the holder may perform the send, so two
 *   processes racing on the same key cannot both call Meta.
 * - `biz_opaque_callback_data` carries this row's id to Meta and comes back on the
 *   status webhook, which is how a delivery report finds its way home in Phase B.
 *
 * **`delivery_unknown` is the one that matters.** If the connection drops after the
 * request goes out, Meta may already have accepted the message. Resending would deliver
 * it twice and charge twice, so it is never retried automatically — it is left for a
 * person, or for a reconciliation against Meta's status callbacks. The same reasoning
 * the payment code applies to Razorpay.
 */
export const whatsappSendAttempts = pgTable(
  "whatsapp_send_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * What makes a send unique. Derived from the cause — an outbox event id, say — so
     * that the outbox re-running a subscriber cannot send a second message.
     */
    idempotencyKey: text("idempotency_key").notNull(),

    /** `outbox`, `admin`, `professional`. Who or what asked for this. */
    source: text("source").notNull(),

    /**
     * The number it went from. Text, not a foreign key, because Phase A has a single
     * number in configuration — the pool and its table arrive with allocation.
     */
    phoneNumberId: text("phone_number_id").notNull(),
    recipientPhone: text("recipient_phone").notNull(),

    templateName: text("template_name"),
    templateLanguage: text("template_language"),
    templateCategory: whatsappTemplateCategoryEnum("template_category"),

    /** Context, when there is any. Both nullable: not every send concerns an order. */
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** The admin or professional who pressed send, for a manual one. */
    sentByUserId: uuid("sent_by_user_id").references(() => users.id, { onDelete: "set null" }),

    /** Exactly what went to Meta, including the correlation id. */
    payload: jsonb("payload").notNull(),

    status: whatsappSendStatusEnum("status").notNull().default("sending"),
    /** Held by whoever is mid-send. Null once the attempt has settled. */
    ownerToken: uuid("owner_token"),
    metaMessageId: text("meta_message_id"),
    lastError: text("last_error"),
    /** From `classifyGraphError`, so support can see *why* without reading logs. */
    failureKind: text("failure_kind"),

    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // The guarantee. Everything else in this file depends on it.
    uniqueIndex("whatsapp_send_attempts_idempotency_uq").on(t.idempotencyKey),
    index("whatsapp_send_attempts_order_idx").on(t.orderId),
    index("whatsapp_send_attempts_status_idx").on(t.status, t.createdAt),
    // Finds anything needing a human: delivery_unknown, or a retryable failure.
    index("whatsapp_send_attempts_unsettled_idx")
      .on(t.createdAt)
      .where(sql`${t.status} in ('delivery_unknown', 'failed_retryable')`),
  ],
);

/**
 * Cooldowns, per scope.
 *
 * PingMe keeps these in Redis. Lawxygen has no Redis and does not need one: a row with
 * an expiry does the same job, and a send checks it before calling Meta so a throttled
 * number stops hammering an endpoint that is already refusing.
 */
export const whatsappCooldowns = pgTable(
  "whatsapp_cooldowns",
  {
    /** `<scope>:<id>` — e.g. `number:123456`, `pair:123456:+9198…`. */
    key: text("key").primaryKey(),
    scope: text("scope").notNull(),
    reason: text("reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("whatsapp_cooldowns_expiry_idx").on(t.expiresAt)],
);

export type WhatsappTemplate = typeof whatsappTemplates.$inferSelect;
export type WhatsappSendAttempt = typeof whatsappSendAttempts.$inferSelect;
export type WhatsappTemplateStatus = (typeof whatsappTemplateStatusEnum.enumValues)[number];
export type WhatsappTemplateCategory = (typeof whatsappTemplateCategoryEnum.enumValues)[number];
