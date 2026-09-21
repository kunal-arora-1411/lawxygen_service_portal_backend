/**
 * Checking a template before Meta sees it.
 *
 * Ported from PingMe's `lib/templateValidator.ts`. Every rule here is one Meta enforces
 * but reports badly — a rejection often comes back days later as a terse code, and the
 * template has to be re-submitted under a **new name** because a rejected name cannot
 * be reused immediately. Catching these locally turns a multi-day round trip into an
 * error message.
 *
 * The category heuristic is the one that saves money rather than time. Meta classifies
 * from the wording, not from what we declare, and a template it decides is marketing
 * costs about ₹0.86 a message against ₹0.115 — for the life of the template.
 */

export type TemplateComponent = {
  type: string;
  format?: string;
  text?: string;
  buttons?: { type?: string; otp_type?: string; text?: string }[];
  example?: Record<string, unknown>;
};

export type TemplateDraft = {
  name: string;
  category: "UTILITY" | "AUTHENTICATION" | "MARKETING";
  language: string;
  components: TemplateComponent[];
  /** Keyed `body_1`, `body_2` … Meta requires an example for every variable. */
  sampleValues?: Record<string, string>;
};

export type ValidationIssue = { field: string; message: string };

/** Wording that pushes Meta to reclassify a template as marketing. */
const PROMOTIONAL = ["sale", "offer", "discount", "deal", "promo", "% off", "free", "limited time"];

function bodyText(components: TemplateComponent[]): string {
  return components.find((component) => component.type === "BODY")?.text ?? "";
}

function variableIndexes(text: string): number[] {
  return [...text.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
}

export function validateTemplate(draft: TemplateDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!/^[a-z0-9_]+$/.test(draft.name)) {
    issues.push({
      field: "name",
      message: "A template name is lowercase letters, numbers and underscores only.",
    });
  }
  if (draft.name.length > 512) {
    issues.push({ field: "name", message: "A template name is at most 512 characters." });
  }

  const body = bodyText(draft.components);
  if (!body.trim()) {
    issues.push({ field: "body", message: "A template needs a body." });
  }
  if (body.length > 1024) {
    issues.push({ field: "body", message: "The body is at most 1024 characters." });
  }

  /**
   * Not a hard rule of Meta's, but the expensive one. Flagged rather than refused,
   * because a legitimate utility message might genuinely say "free of charge".
   */
  if (draft.category !== "MARKETING") {
    const found = PROMOTIONAL.find((word) => body.toLowerCase().includes(word));
    if (found) {
      issues.push({
        field: "category",
        message: `The body contains "${found}". Meta usually reclassifies that as MARKETING, which costs roughly seven times more per message.`,
      });
    }
  }

  // Variables must be {{1}}, {{2}} … in order, with nothing skipped.
  const variables = variableIndexes(body);
  variables.forEach((value, index) => {
    if (value !== index + 1) {
      issues.push({
        field: "body",
        message: `Variables must run in sequence. Expected {{${String(index + 1)}}} but found {{${String(value)}}}.`,
      });
    }
  });

  const trimmed = body.trim();
  if (trimmed.startsWith("{{") || trimmed.endsWith("}}")) {
    issues.push({
      field: "body",
      message: "A variable cannot open or close the body. Put words around it.",
    });
  }

  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(body)) {
    issues.push({
      field: "body",
      message: "Two variables cannot sit next to each other with nothing between them.",
    });
  }

  // Meta reviewers need an example for each variable, or they reject on sight.
  for (let index = 0; index < variables.length; index += 1) {
    const key = `body_${String(index + 1)}`;
    if (!draft.sampleValues?.[key]) {
      issues.push({
        field: `sampleValues.${key}`,
        message: `Give an example for {{${String(index + 1)}}} so a reviewer can see what it means.`,
      });
    }
  }

  if (draft.category === "AUTHENTICATION") {
    const hasOtpButton = draft.components.some(
      (component) =>
        component.type === "BUTTONS" &&
        (component.buttons ?? []).some(
          (button) =>
            button.type === "OTP" ||
            button.otp_type === "COPY_CODE" ||
            button.otp_type === "ONE_TAP",
        ),
    );
    if (!hasOtpButton) {
      issues.push({
        field: "buttons",
        message: "An authentication template needs a copy-code or one-tap button.",
      });
    }
  }

  return issues;
}

/** The payload Meta's `POST /{waba}/message_templates` expects. */
export function toMetaPayload(draft: TemplateDraft): Record<string, unknown> {
  const body = bodyText(draft.components);
  const variables = variableIndexes(body);

  const components = draft.components.map((component) => {
    if (component.type !== "BODY" || variables.length === 0) return component;
    return {
      ...component,
      // Meta wants the examples inline on the body component, in order.
      example: {
        body_text: [variables.map((index) => draft.sampleValues?.[`body_${String(index)}`] ?? "")],
      },
    };
  });

  return {
    name: draft.name,
    category: draft.category,
    language: draft.language,
    components,
  };
}
