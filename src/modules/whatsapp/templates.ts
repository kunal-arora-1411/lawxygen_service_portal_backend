import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  whatsappTemplates,
  type WhatsappTemplateCategory,
  type WhatsappTemplateStatus,
} from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { authorize, type Actor } from "../../lib/auth/policy.js";
import {
  toMetaPayload,
  validateTemplate,
  type TemplateComponent,
  type TemplateDraft,
  type ValidationIssue,
} from "../../lib/whatsapp/validate.js";
import { logger } from "../../lib/logger.js";
import { listMetaTemplates, submitTemplate } from "./client.js";

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
 * Authoring a template, and sending it to Meta for review.
 *
 * Lawxygen owns its own WhatsApp Business Account and authors its own templates —
 * nothing else is in the loop. A draft is validated locally first, because Meta reports
 * a rejection days later as a terse code and a rejected name cannot immediately be
 * reused: the fix usually has to go out under a different name.
 *
 * Meta may also answer with a **different category** from the one requested, and its
 * answer is the one that sets the price. So whatever comes back is what gets stored,
 * never what was asked for.
 */
export async function createTemplate(
  actor: Actor,
  input: {
    name: string;
    language?: string;
    category?: WhatsappTemplateCategory;
    /** The message, with `{{1}}`, `{{2}}` … for the variable parts. */
    body: string;
    /** Short line under the message. Optional, and cannot contain variables. */
    footer?: string;
    /** An example for each variable, in order. Meta rejects a draft without them. */
    samples: string[];
    /** What each variable means, for whoever fills them in later. */
    variables: string[];
  },
): Promise<TemplateView> {
  authorize(actor, "whatsapp.template.write", { minimumRole: "admin" });

  const language = input.language ?? "en";
  const category = input.category ?? "utility";

  const components: TemplateComponent[] = [
    { type: "BODY", text: input.body },
    ...(input.footer ? [{ type: "FOOTER" as const, text: input.footer }] : []),
  ];

  const draft: TemplateDraft = {
    name: input.name,
    language,
    category: category.toUpperCase() as TemplateDraft["category"],
    components,
    sampleValues: Object.fromEntries(
      input.samples.map((value, index) => [`body_${String(index + 1)}`, value]),
    ),
  };

  const issues = validateTemplate(draft);
  if (issues.length > 0) {
    throw new ApiError("invalid_input", "That template would be rejected by Meta.", {
      fieldErrors: issues.reduce<Record<string, string[]>>((all, issue) => {
        all[issue.field] = [...(all[issue.field] ?? []), issue.message];
        return all;
      }, {}),
    });
  }

  const submitted = await submitTemplate(toMetaPayload(draft));

  // Meta's category wins. Asking for utility and being given marketing is the
  // difference between ₹0.115 and ₹0.86 a message, and only Meta decides.
  const decided = mapCategory(submitted.category);

  await db
    .insert(whatsappTemplates)
    .values({
      name: input.name,
      language,
      category: decided,
      status: mapStatus(submitted.status),
      providerTemplateId: submitted.providerTemplateId,
      components,
      variables: input.variables,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [whatsappTemplates.name, whatsappTemplates.language],
      set: {
        category: decided,
        status: mapStatus(submitted.status),
        providerTemplateId: submitted.providerTemplateId,
        components,
        variables: input.variables,
        syncedAt: new Date(),
      },
    });

  if (decided !== category) {
    logger.warn(
      { template: input.name, asked: category, decided },
      "Meta assigned a different template category from the one requested",
    );
  }

  logger.info({ template: input.name, status: submitted.status }, "whatsapp template submitted");

  const [row] = await db
    .select()
    .from(whatsappTemplates)
    .where(and(eq(whatsappTemplates.name, input.name), eq(whatsappTemplates.language, language)))
    .limit(1);

  return {
    name: input.name,
    language,
    category: decided,
    status: row?.status ?? "pending",
    variables: input.variables,
    reviewNote: row?.reviewNote ?? null,
    syncedAt: row?.syncedAt?.toISOString() ?? null,
    bodyPreview: input.body,
  };
}

/**
 * Checks a draft without sending it anywhere.
 *
 * So the authoring screen can warn about a promotional-sounding utility template
 * *before* somebody commits to a name they cannot reuse.
 */
export function checkTemplate(
  actor: Actor,
  input: {
    name: string;
    language?: string;
    category?: WhatsappTemplateCategory;
    body: string;
    footer?: string;
    samples: string[];
  },
): { issues: ValidationIssue[] } {
  authorize(actor, "whatsapp.template.write", { minimumRole: "admin" });

  const category = (input.category ?? "utility").toUpperCase() as TemplateDraft["category"];
  return {
    issues: validateTemplate({
      name: input.name,
      language: input.language ?? "en",
      category,
      components: [
        { type: "BODY", text: input.body },
        ...(input.footer ? [{ type: "FOOTER" as const, text: input.footer }] : []),
      ],
      sampleValues: Object.fromEntries(
        input.samples.map((value, index) => [`body_${String(index + 1)}`, value]),
      ),
    }),
  };
}
