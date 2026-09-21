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
type WhatsappConfig = { phoneNumberId?: string; accessToken?: string; wabaId?: string };

let config: WhatsappConfig = {
  ...(env.WHATSAPP_PHONE_NUMBER_ID ? { phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID } : {}),
  ...(env.WHATSAPP_ACCESS_TOKEN ? { accessToken: env.WHATSAPP_ACCESS_TOKEN } : {}),
  ...(env.WHATSAPP_WABA_ID ? { wabaId: env.WHATSAPP_WABA_ID } : {}),
};

/** Test seam. Pass undefined to restore whatever the environment says. */
export function setWhatsappConfig(override: WhatsappConfig | undefined): void {
  config = override ?? {
    ...(env.WHATSAPP_PHONE_NUMBER_ID ? { phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID } : {}),
    ...(env.WHATSAPP_ACCESS_TOKEN ? { accessToken: env.WHATSAPP_ACCESS_TOKEN } : {}),
    ...(env.WHATSAPP_WABA_ID ? { wabaId: env.WHATSAPP_WABA_ID } : {}),
  };
  sender = undefined;
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
