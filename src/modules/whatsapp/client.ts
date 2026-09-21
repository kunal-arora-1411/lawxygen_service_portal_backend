import { ApiError } from "../../lib/api.js";
import { env } from "../../lib/env.js";
import { logger } from "../../lib/logger.js";
import { graphGet, graphPost } from "../../lib/whatsapp/graph.js";

/**
 * The only place Lawxygen talks to Meta.
 *
 * Same adapter pattern as `razorpay.ts`, `transfer.ts` and `mailer.ts`: a live
 * implementation over `fetch`, a `setXxx()` test seam, and a refusal when unconfigured.
 * Locally, with no credentials, a send logs what it would have sent — enough to develop
 * against without a WhatsApp number. Anywhere else it throws, because a deployed
 * environment that quietly drops a client's receipt looks perfectly healthy while
 * telling nobody anything.
 */

export type SendResult = { metaMessageId: string };

export type TemplateSend = {
  /** Digits only, no plus. Meta rejects the plus. */
  recipientPhone: string;
  templateName: string;
  language: string;
  /** Meta's component array. Built by `buildComponents`. */
  components: Record<string, unknown>[];
  /** Comes back on the status webhook, which is how Phase B correlates delivery. */
  correlationId: string;
};

export type WhatsappSender = (input: TemplateSend) => Promise<SendResult>;

export type MetaTemplate = {
  name: string;
  status: string;
  language: string;
  category?: string;
  id?: string;
  components: Record<string, unknown>[];
};

/**
 * Configuration read through a holder rather than straight off the parsed env, which
 * is frozen at import. Tests need to install a configuration, and a later phase will read the
 * number from the pool table rather than the environment — both want one place to
 * change.
 */
type WhatsappConfig = {
  phoneNumberId?: string;
  accessToken?: string;
  wabaId?: string;
  /** Verifies inbound webhook signatures. */
  appSecret?: string;
};

let config: WhatsappConfig = {
  ...(env.WHATSAPP_PHONE_NUMBER_ID ? { phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID } : {}),
  ...(env.WHATSAPP_ACCESS_TOKEN ? { accessToken: env.WHATSAPP_ACCESS_TOKEN } : {}),
  ...(env.WHATSAPP_WABA_ID ? { wabaId: env.WHATSAPP_WABA_ID } : {}),
  ...(env.WHATSAPP_APP_SECRET ? { appSecret: env.WHATSAPP_APP_SECRET } : {}),
};

/** Test seam. Pass undefined to restore whatever the environment says. */
export function setWhatsappConfig(override: WhatsappConfig | undefined): void {
  config = override ?? {
    ...(env.WHATSAPP_PHONE_NUMBER_ID ? { phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID } : {}),
    ...(env.WHATSAPP_ACCESS_TOKEN ? { accessToken: env.WHATSAPP_ACCESS_TOKEN } : {}),
    ...(env.WHATSAPP_WABA_ID ? { wabaId: env.WHATSAPP_WABA_ID } : {}),
    ...(env.WHATSAPP_APP_SECRET ? { appSecret: env.WHATSAPP_APP_SECRET } : {}),
  };
  sender = undefined;
  freeTextSender = undefined;
}

export function isConfigured(): boolean {
  return Boolean(config.phoneNumberId && config.accessToken);
}

/** The single configured number. The pool, and its table, arrive with allocation. */
export function senderNumberId(): string {
  if (!config.phoneNumberId) {
    throw new ApiError("upstream_failure", "No WhatsApp number is configured.");
  }
  return config.phoneNumberId;
}

/** The secret Meta signs inbound webhooks with. */
export function webhookSecret(): string | undefined {
  return config.appSecret;
}

/** The WABA a cooldown should be scoped to, falling back to the number. */
export function wabaIdOrNumber(fallback: string): string {
  return config.wabaId ?? fallback;
}

function token(): string {
  if (!config.accessToken) throw new ApiError("upstream_failure", "WhatsApp is not configured.");
  return config.accessToken;
}

const liveSend: WhatsappSender = async (input) => {
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.recipientPhone,
    type: "template",
    template: {
      name: input.templateName,
      language: { code: input.language },
      ...(input.components.length > 0 ? { components: input.components } : {}),
    },
    // Meta echoes this back on the status webhook.
    biz_opaque_callback_data: input.correlationId,
  };

  const response = await graphPost(`${senderNumberId()}/messages`, token(), body);
  const messages = (response as { messages?: { id?: string }[] }).messages;
  const metaMessageId = messages?.[0]?.id;

  if (!metaMessageId) {
    // Accepted without an id is not success — there would be nothing to correlate a
    // delivery report against. Treated as a failed send rather than a silent one.
    throw new ApiError("upstream_failure", "Meta accepted the message without returning an id.");
  }
  return { metaMessageId };
};

/** Local-only. Prints the message so development works without a WhatsApp number. */
const logOnly: WhatsappSender = (input) => {
  logger.warn(
    {
      to: input.recipientPhone,
      template: input.templateName,
      variablesForLocalDev: input.components,
      channel: "whatsapp-stub",
    },
    "WHATSAPP NOT SENT — no number configured; the template and variables are below",
  );
  return Promise.resolve({ metaMessageId: `stub_${input.correlationId}` });
};

const refuse: WhatsappSender = () => {
  throw new ApiError("upstream_failure", "WhatsApp is not available right now.");
};

function configuredSender(): WhatsappSender {
  if (isConfigured()) return liveSend;
  if (env.APP_ENV === "local") return logOnly;
  logger.error("WhatsApp is not configured; sending is refused");
  return refuse;
}

let sender: WhatsappSender | undefined;

export function sendTemplate(input: TemplateSend): Promise<SendResult> {
  sender ??= configuredSender();
  return sender(input);
}

/** Test seam. Pass undefined to restore the configured sender. */
export function setWhatsappSender(override: WhatsappSender | undefined): void {
  sender = override ?? configuredSender();
}

/**
 * Reads the templates Meta holds for this account.
 *
 * Meta owns the truth about approval status: a template can be approved today and
 * paused for quality tomorrow without anything happening here.
 */
export type TemplateLister = () => Promise<MetaTemplate[]>;

const liveList: TemplateLister = async () => {
  const wabaId = config.wabaId;
  if (!wabaId)
    throw new ApiError("upstream_failure", "No WhatsApp Business Account is configured.");

  const response = await graphGet(
    `${wabaId}/message_templates`,
    token(),
    "name,status,language,category,components,id",
  );
  return ((response as { data?: MetaTemplate[] }).data ?? []).map((row) => ({
    name: row.name,
    status: row.status,
    language: row.language,
    category: row.category,
    id: row.id,
    components: Array.isArray(row.components) ? row.components : [],
  }));
};

let lister: TemplateLister = liveList;

export function listMetaTemplates(): Promise<MetaTemplate[]> {
  if (!isConfigured()) throw new ApiError("upstream_failure", "WhatsApp is not configured.");
  return lister();
}

/** Test seam. Pass undefined to restore the live client. */
export function setTemplateLister(override: TemplateLister | undefined): void {
  lister = override ?? liveList;
}

/**
 * Submitting a template to Meta for review.
 *
 * Lawxygen authors its own templates — there is no other console in the loop. A
 * submission comes back PENDING and Meta reviews it, usually within minutes but
 * sometimes over a day.
 *
 * Two things about rejection are worth knowing before building on this. Meta may
 * return a different category from the one requested, and its answer is the one that
 * decides the price. And a rejected name cannot simply be resubmitted — the fix
 * usually has to go out under a new name.
 */
export type SubmittedTemplate = { providerTemplateId: string; status: string; category?: string };

export type TemplateSubmitter = (payload: Record<string, unknown>) => Promise<SubmittedTemplate>;

const liveSubmit: TemplateSubmitter = async (payload) => {
  if (!config.wabaId) {
    throw new ApiError("upstream_failure", "No WhatsApp Business Account is configured.");
  }
  const response = await graphPost(`${config.wabaId}/message_templates`, token(), payload);
  const body = response as { id?: string; status?: string; category?: string };
  if (!body.id) {
    throw new ApiError("upstream_failure", "Meta accepted the template without returning an id.");
  }
  return {
    providerTemplateId: body.id,
    status: body.status ?? "PENDING",
    ...(body.category ? { category: body.category } : {}),
  };
};

let submitter: TemplateSubmitter = liveSubmit;

export function submitTemplate(payload: Record<string, unknown>): Promise<SubmittedTemplate> {
  if (!isConfigured()) throw new ApiError("upstream_failure", "WhatsApp is not configured.");
  return submitter(payload);
}

/** Test seam. Pass undefined to restore the live client. */
export function setTemplateSubmitter(override: TemplateSubmitter | undefined): void {
  submitter = override ?? liveSubmit;
}

/**
 * A free-form text reply.
 *
 * Only legal inside the 24-hour window a client opens by writing to us; the caller
 * checks that before getting here. Meta would reject it anyway, but its error says
 * little and costs a round trip.
 */
export type FreeTextSend = { recipientPhone: string; text: string; correlationId: string };

export type FreeTextSender = (input: FreeTextSend) => Promise<SendResult>;

const liveFreeText: FreeTextSender = async (input) => {
  const response = await graphPost(`${senderNumberId()}/messages`, token(), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.recipientPhone.replace(/D/g, ""),
    type: "text",
    text: { preview_url: false, body: input.text },
    biz_opaque_callback_data: input.correlationId,
  });

  const metaMessageId = (response as { messages?: { id?: string }[] }).messages?.[0]?.id;
  if (!metaMessageId) {
    throw new ApiError("upstream_failure", "Meta accepted the message without returning an id.");
  }
  return { metaMessageId };
};

const logOnlyFreeText: FreeTextSender = (input) => {
  logger.warn(
    { to: input.recipientPhone, bodyForLocalDev: input.text, channel: "whatsapp-stub" },
    "WHATSAPP NOT SENT — no number configured; the reply is below",
  );
  return Promise.resolve({ metaMessageId: `stub_${input.correlationId}` });
};

function configuredFreeTextSender(): FreeTextSender {
  if (isConfigured()) return liveFreeText;
  if (env.APP_ENV === "local") return logOnlyFreeText;
  return () => {
    throw new ApiError("upstream_failure", "WhatsApp is not available right now.");
  };
}

let freeTextSender: FreeTextSender | undefined;

export function sendFreeText(input: FreeTextSend): Promise<SendResult> {
  freeTextSender ??= configuredFreeTextSender();
  return freeTextSender(input);
}

/** Test seam. Pass undefined to restore the configured sender. */
export function setFreeTextSender(override: FreeTextSender | undefined): void {
  freeTextSender = override ?? configuredFreeTextSender();
}
