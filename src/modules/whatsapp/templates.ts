import { desc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  whatsappTemplates,
  type WhatsappTemplateCategory,
  type WhatsappTemplateStatus,
} from "../../db/schema/index.js";
import { authorize, type Actor } from "../../lib/auth/policy.js";
import { logger } from "../../lib/logger.js";
import { listMetaTemplates } from "./client.js";

/**
 * The template registry.
 *
 * Meta owns the truth. A template approved today can be paused tomorrow for poor
 * quality, or have its category reassigned — and nothing tells us. So this table is a
 * mirror, refreshed by `syncTemplates`, and every send checks it first so a paused
 * template fails locally with a readable message rather than opaquely at Meta.
 *
 * **Category is the expensive field.** Utility costs about ₹0.115 a message;
 * marketing about ₹0.86. Meta decides the category from the wording, not from what we
 * claim, so a template written like an advertisement costs 7.5× for its whole life.
 * The sync records what Meta actually decided, which is the only figure that matters.
 */

export type TemplateView = {
  name: string;
  language: string;
  category: WhatsappTemplateCategory;
  status: WhatsappTemplateStatus;
  variables: string[];
  reviewNote: string | null;
  syncedAt: string | null;
  /** Rendered body text with `{{1}}` still in place, for a preview. */
  bodyPreview: string | null;
};

/** Meta's statuses are upper-case and broader than ours. */
function mapStatus(value: string): WhatsappTemplateStatus {
  switch (value.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "REJECTED":
      return "rejected";
    case "PAUSED":
      return "paused";
    case "DISABLED":
      return "disabled";
    case "PENDING":
    case "IN_APPEAL":
    case "PENDING_DELETION":
      return "pending";
    default:
      return "draft";
  }
}

function mapCategory(value: string | undefined): WhatsappTemplateCategory {
  switch ((value ?? "").toUpperCase()) {
    case "MARKETING":
      return "marketing";
    case "AUTHENTICATION":
      return "authentication";
    default:
      return "utility";
  }
}

function bodyOf(components: unknown): string | null {
  // Narrowed to a known element type before `.find`, or the callback's parameter is
  // `any` and the result of the search is too.
  if (!Array.isArray(components)) return null;
  const parts = components as { type?: string; text?: unknown }[];

  const body = parts.find((part) => (part.type ?? "").toUpperCase() === "BODY");
  return typeof body?.text === "string" ? body.text : null;
}

/** `{{1}}`, `{{2}}` … in order of first appearance. */
function variablesOf(components: unknown): string[] {
  const text = bodyOf(components);
  if (!text) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const key = match[1]?.trim();
    if (key) found.add(key);
  }
  return [...found];
}

/**
 * Pulls every template Meta holds and reconciles the local mirror.
 *
 * Upsert, never delete: a template removed at Meta is left here as a record of what was
 * once sent. A send would fail its status check anyway.
 */
export async function syncTemplates(actor: Actor): Promise<{ synced: number }> {
  authorize(actor, "whatsapp.template.sync", { minimumRole: "admin" });

  const remote = await listMetaTemplates();
  const now = new Date();

  for (const template of remote) {
    const values = {
      name: template.name,
      language: template.language,
      category: mapCategory(template.category),
      status: mapStatus(template.status),
      providerTemplateId: template.id ?? null,
      components: template.components,
      variables: variablesOf(template.components),
      syncedAt: now,
    };

    await db
      .insert(whatsappTemplates)
      .values(values)
      .onConflictDoUpdate({
        target: [whatsappTemplates.name, whatsappTemplates.language],
        // `variables` is deliberately not overwritten — see below.
        set: {
          category: values.category,
          status: values.status,
          providerTemplateId: values.providerTemplateId,
          components: values.components,
          syncedAt: now,
        },
      });
  }

  logger.info({ count: remote.length }, "whatsapp templates synced");
  return { synced: remote.length };
}

export async function listTemplates(actor: Actor): Promise<TemplateView[]> {
  authorize(actor, "whatsapp.template.read", { minimumRole: "professional" });

  const rows = await db
    .select()
    .from(whatsappTemplates)
    .orderBy(desc(whatsappTemplates.status), whatsappTemplates.name);

  return rows.map((row) => ({
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    variables: (row.variables as string[] | null) ?? [],
    reviewNote: row.reviewNote,
    syncedAt: row.syncedAt?.toISOString() ?? null,
    bodyPreview: bodyOf(row.components),
  }));
}

/** Only approved templates can actually be sent, so this is what a picker shows. */
export async function sendableTemplates(actor: Actor): Promise<TemplateView[]> {
  const all = await listTemplates(actor);
  return all.filter((template) => template.status === "approved");
}

/**
 * Registers a template Lawxygen intends to use, before Meta has been asked.
 *
 * Phase A authors templates in PingMe's console and references them by name here —
 * names are just strings to Meta. This exists so a name can be recorded, and its
 * variable order documented, ahead of the first sync. Authoring inside Lawxygen is
 * Phase E.
 */
export async function registerTemplate(
  actor: Actor,
  input: {
    name: string;
    language?: string;
    variables: string[];
    category?: WhatsappTemplateCategory;
  },
): Promise<TemplateView> {
  authorize(actor, "whatsapp.template.write", { minimumRole: "admin" });

  const language = input.language ?? "en";
  await db
    .insert(whatsappTemplates)
    .values({
      name: input.name,
      language,
      category: input.category ?? "utility",
      status: "draft",
      variables: input.variables,
    })
    .onConflictDoUpdate({
      target: [whatsappTemplates.name, whatsappTemplates.language],
      /**
       * Only the variable list. Meta owns status, category and components, and a
       * registration must never overwrite what a sync learned from them.
       */
      set: { variables: input.variables },
    });

  const [row] = await db
    .select()
    .from(whatsappTemplates)
    .where(eq(whatsappTemplates.name, input.name))
    .limit(1);

  return {
    name: input.name,
    language,
    category: row?.category ?? "utility",
    status: row?.status ?? "draft",
    variables: input.variables,
    reviewNote: row?.reviewNote ?? null,
    syncedAt: row?.syncedAt?.toISOString() ?? null,
    bodyPreview: bodyOf(row?.components),
  };
}
