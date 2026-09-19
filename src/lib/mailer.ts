import { ApiError } from "./api.js";
import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * Transactional email.
 *
 * Same shape as `sms.ts` and the Razorpay adapters, for the same reason: the provider
 * is one function, so changing it is a change to one function. What matters more is
 * the behaviour when nothing is configured — locally the message is logged so
 * development works, and anywhere else it throws. A deployed environment that quietly
 * logged receipts instead of sending them would look perfectly healthy while every
 * client wondered where their invoice went.
 *
 * The body is written here as both HTML and plain text. Plain text is not a courtesy:
 * a mail client that renders only text, or a spam filter scoring a text-free message,
 * both turn an HTML-only receipt into a receipt nobody reads.
 */

export type Email = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Passed to the provider so a retried send cannot deliver twice. The outbox re-runs
   * every subscriber for an event when any one of them fails, so a send that succeeded
   * before a later failure *will* be attempted again.
   */
  idempotencyKey: string;
};

export type MailSender = (email: Email) => Promise<void>;

/** Local-only. Prints enough to read the message without a provider. */
const logOnly: MailSender = (email) => {
  logger.warn(
    { to: email.to, subject: email.subject, bodyForLocalDev: email.text, channel: "mail-stub" },
    "EMAIL NOT SENT — no mail provider configured; the body is below",
  );
  return Promise.resolve();
};

const refuse: MailSender = () => {
  throw new ApiError("upstream_failure", "Unable to send mail right now.");
};

/**
 * Resend's API, which is a single POST and needs no SDK.
 *
 * Any provider with an HTTP send endpoint drops in here unchanged as far as the rest
 * of the codebase is concerned. The one requirement is a genuine idempotency
 * mechanism — without it, an outbox retry sends a second copy of somebody's receipt.
 */
const liveSend: MailSender = async (email) => {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${String(env.MAIL_PROVIDER_KEY)}`,
      "content-type": "application/json",
      "Idempotency-Key": email.idempotencyKey,
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  });

  if (!res.ok) {
    throw new ApiError("upstream_failure", "The mail provider rejected the message.", {
      cause: new Error(`Mail provider responded ${String(res.status)}: ${await res.text()}`),
    });
  }
};

function configuredSender(): MailSender {
  if (!env.MAIL_PROVIDER_KEY || !env.MAIL_FROM) {
    if (env.APP_ENV === "local") return logOnly;
    logger.error("mail provider is not configured; email delivery is refused");
    return refuse;
  }
  return liveSend;
}

let sender: MailSender | undefined;

export async function sendEmail(email: Email): Promise<void> {
  sender ??= configuredSender();
  await sender(email);
}

/** Test seam. Pass undefined to restore the configured sender. */
export function setMailSender(override: MailSender | undefined): void {
  sender = override ?? configuredSender();
}
