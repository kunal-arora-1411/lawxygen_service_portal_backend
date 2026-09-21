import { and, eq, gt, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db/client.js";
import {
  whatsappCooldowns,
  whatsappSendAttempts,
  whatsappTemplates,
  type WhatsappTemplateCategory,
} from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { isUniqueViolation } from "../../lib/db-errors.js";
import { logger } from "../../lib/logger.js";
import { classifyGraphError } from "../../lib/whatsapp/classify.js";
import { senderNumberId, sendTemplate, wabaIdOrNumber } from "./client.js";

/**
 * Sending a template, exactly once.
 *
 * Ported in spirit from PingMe's `messageAudit.service.ts`, which is the strongest idea
 * in their codebase. The sequence:
 *
 * 1. **Reserve** a row on the idempotency key. A second caller with the same key finds
 *    the existing row rather than sending again.
 * 2. **Claim** it with an owner token. Two processes racing on one key cannot both
 *    reach Meta, because only the token holder proceeds.
 * 3. **Send**, carrying the row id to Meta as `biz_opaque_callback_data`.
 * 4. **Settle** the row: accepted, failed, retryable, or `delivery_unknown`.
 *
 * `delivery_unknown` is the important one. A dropped connection after the request went
 * out means Meta may already have the message, so resending would deliver and charge
 * twice. It is never retried automatically — the same judgement the payment code makes
 * about Razorpay.
 *
 * Callers do not pass a key. It is derived from the cause (an outbox event id, an order
 * reference), so the outbox re-running a subscriber after a sibling failure cannot
 * produce a second WhatsApp message.
 */

export type SendOutcome =
  | { status: "accepted"; attemptId: string; metaMessageId: string }
  | { status: "deduplicated"; attemptId: string; metaMessageId: string | null }
  | { status: "in_progress"; attemptId: string }
  | { status: "delivery_unknown"; attemptId: string }
  | { status: "failed"; attemptId: string; retryable: boolean; reason: string };

export type SendTemplateInput = {
  idempotencyKey: string;
  source: "outbox" | "admin" | "professional";
  /** E.164, with or without the plus. Normalised before it reaches Meta. */
  recipientPhone: string;
  templateName: string;
  language?: string;
  /** Positional, matching `{{1}}`, `{{2}}` in the template body. */
  variables?: string[];
  orderId?: string | null;
  userId?: string | null;
  sentByUserId?: string | null;
};

/** Meta rejects a leading plus on the recipient. */
function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Meta's component array for a body with positional variables.
 *
 * Only the body is filled. Header and button variables exist but no Lawxygen template
 * uses them yet, and guessing at their shape would be worse than not supporting them.
 */
export function buildComponents(variables: string[]): Record<string, unknown>[] {
  if (variables.length === 0) return [];
  return [
    {
      type: "body",
      parameters: variables.map((value) => ({ type: "text", text: value })),
    },
  ];
}

/** True while this scope is backing off. */
async function cooledDown(keys: string[]): Promise<string | null> {
  if (keys.length === 0) return null;
  const [row] = await db
    .select({ key: whatsappCooldowns.key, reason: whatsappCooldowns.reason })
    .from(whatsappCooldowns)
    .where(
      and(
        // inArray, not a raw ANY: Drizzle expands a JS array to a tuple and ANY
        // needs an array on the right. Same trap as the assignment query.
        inArray(whatsappCooldowns.key, keys),
        gt(whatsappCooldowns.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ? (row.reason ?? row.key) : null;
}

async function startCooldown(scope: string, id: string, ms: number, reason: string): Promise<void> {
  const key = `${scope}:${id}`;
  const expiresAt = new Date(Date.now() + ms);
  await db
    .insert(whatsappCooldowns)
    .values({ key, scope, reason, expiresAt })
    .onConflictDoUpdate({ target: whatsappCooldowns.key, set: { expiresAt, reason } });
  logger.warn({ key, ms, reason }, "whatsapp cooldown started");
}

/**
 * Checks the template locally before spending a round-trip.
 *
 * Meta can pause an approved template for poor quality at any time. Failing here gives
 * a usable error instead of an opaque rejection, and costs nothing.
 */
async function approvedTemplate(name: string, language: string) {
  const [row] = await db
    .select({
      name: whatsappTemplates.name,
      language: whatsappTemplates.language,
      status: whatsappTemplates.status,
      category: whatsappTemplates.category,
    })
    .from(whatsappTemplates)
    .where(and(eq(whatsappTemplates.name, name), eq(whatsappTemplates.language, language)))
    .limit(1);

  if (!row) {
    throw new ApiError("invalid_input", `No WhatsApp template named "${name}" in ${language}.`);
  }
  if (row.status !== "approved") {
    throw new ApiError("conflict", `Template "${name}" is ${row.status}, not approved.`);
  }
  return row;
}

export async function sendTemplateMessage(input: SendTemplateInput): Promise<SendOutcome> {
  const language = input.language ?? "en";
  const recipient = digitsOnly(input.recipientPhone);
  if (!recipient) throw new ApiError("invalid_input", "A recipient phone number is required.");

  const template = await approvedTemplate(input.templateName, language);
  const numberId = senderNumberId();

  const blocked = await cooledDown([
    `number:${numberId}`,
    `pair:${numberId}:${recipient}`,
    "app:global",
  ]);
  if (blocked) {
    throw new ApiError("rate_limited", `WhatsApp sending is backing off: ${blocked}`);
  }

  const ownerToken = randomUUID();
  const components = buildComponents(input.variables ?? []);

  // ---------------------------------------------------------------- reserve
  let attempt = await reserve(input, {
    language,
    recipient,
    numberId,
    ownerToken,
    components,
    category: template.category,
  });

  if (attempt.ownerToken !== ownerToken) {
    // Somebody else holds it. What we return depends on how far they got.
    if (attempt.metaMessageId) {
      return {
        status: "deduplicated",
        attemptId: attempt.id,
        metaMessageId: attempt.metaMessageId,
      };
    }
    if (attempt.status === "delivery_unknown") {
      return { status: "delivery_unknown", attemptId: attempt.id };
    }
    if (attempt.status === "failed_retryable") {
      // Re-claim it, guarded on the token we saw, so only one retrier wins.
      const [claimed] = await db
        .update(whatsappSendAttempts)
        .set({ status: "sending", ownerToken })
        .where(
          and(
            eq(whatsappSendAttempts.id, attempt.id),
            eq(whatsappSendAttempts.status, "failed_retryable"),
          ),
        )
        .returning();
      if (!claimed || claimed.ownerToken !== ownerToken) {
        return { status: "in_progress", attemptId: attempt.id };
      }
      attempt = claimed;
    } else {
      return { status: "in_progress", attemptId: attempt.id };
    }
  }

  // ------------------------------------------------------------------- send
  try {
    const { metaMessageId } = await sendTemplate({
      recipientPhone: recipient,
      templateName: input.templateName,
      language,
      components,
      correlationId: attempt.id,
    });

    await db
      .update(whatsappSendAttempts)
      .set({
        status: "accepted",
        metaMessageId,
        acceptedAt: new Date(),
        ownerToken: null,
        lastError: null,
        failureKind: null,
      })
      .where(eq(whatsappSendAttempts.id, attempt.id));

    logger.info(
      { attemptId: attempt.id, template: input.templateName, source: input.source },
      "whatsapp template sent",
    );
    return { status: "accepted", attemptId: attempt.id, metaMessageId };
  } catch (error) {
    const classification = classifyGraphError(error);

    if (classification.scope && classification.cooldownMs > 0) {
      const scopeId =
        classification.scope === "pair"
          ? `${numberId}:${recipient}`
          : classification.scope === "app"
            ? "global"
            : classification.scope === "waba"
              ? wabaIdOrNumber(numberId)
              : numberId;
      await startCooldown(
        classification.scope,
        scopeId,
        classification.cooldownMs,
        classification.reason,
      );
    }

    /**
     * `kind: "unknown"` from a `GraphNetworkError` means the request left without an
     * answer. Recorded as `delivery_unknown` and never retried on its own.
     */
    const status =
      classification.kind === "unknown" && !classification.retryable
        ? "delivery_unknown"
        : classification.retryable
          ? "failed_retryable"
          : "failed";

    await db
      .update(whatsappSendAttempts)
      .set({
        status,
        ownerToken: null,
        lastError: classification.reason,
        failureKind: classification.kind,
      })
      .where(eq(whatsappSendAttempts.id, attempt.id));

    logger.error(
      { attemptId: attempt.id, kind: classification.kind, reason: classification.reason },
      "whatsapp send failed",
    );

    if (status === "delivery_unknown") {
      return { status: "delivery_unknown", attemptId: attempt.id };
    }
    return {
      status: "failed",
      attemptId: attempt.id,
      retryable: classification.retryable,
      reason: classification.reason,
    };
  }
}

/** Insert-or-fetch on the idempotency key. The guarantee the whole file rests on. */
async function reserve(
  input: SendTemplateInput,
  ctx: {
    language: string;
    recipient: string;
    numberId: string;
    ownerToken: string;
    components: Record<string, unknown>[];
    category: WhatsappTemplateCategory;
  },
) {
  const values = {
    idempotencyKey: input.idempotencyKey,
    source: input.source,
    phoneNumberId: ctx.numberId,
    recipientPhone: ctx.recipient,
    templateName: input.templateName,
    templateLanguage: ctx.language,
    templateCategory: ctx.category,
    orderId: input.orderId ?? null,
    userId: input.userId ?? null,
    sentByUserId: input.sentByUserId ?? null,
    payload: { template: input.templateName, language: ctx.language, components: ctx.components },
    status: "sending" as const,
    ownerToken: ctx.ownerToken,
  };

  try {
    const [created] = await db.insert(whatsappSendAttempts).values(values).returning();
    if (created) return created;
  } catch (error) {
    if (!isUniqueViolation(error, "whatsapp_send_attempts_idempotency_uq")) throw error;
  }

  const [existing] = await db
    .select()
    .from(whatsappSendAttempts)
    .where(eq(whatsappSendAttempts.idempotencyKey, input.idempotencyKey))
    .limit(1);

  if (!existing) throw new ApiError("internal", "Could not reserve a WhatsApp send attempt.");
  return existing;
}
