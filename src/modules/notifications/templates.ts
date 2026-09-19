import { env } from "../../lib/env.js";

/**
 * What the messages say.
 *
 * Plain, short, and specific. A transactional email competes with a full inbox: the
 * subject line has to carry the news on its own, because for a good share of people it
 * is the only part that gets read.
 *
 * Every message names the order reference. It is the one string that support, the
 * client and the professional can all say to each other.
 */

const BRAND = "Lawxygen";

function portal(path: string): string {
  return `${env.PORTAL_ORIGIN}${path}`;
}

/** Rupees from paise, grouped the Indian way. */
function money(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

/**
 * Escaped because service titles and people's names come from the database and end up
 * inside HTML. Nobody is going to inject a script into a CA's display name today, but
 * the template that skips this is the one somebody pastes into a page later.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type Body = { subject: string; html: string; text: string };

/** One house style, so every message looks like it came from the same place. */
function layout(heading: string, paragraphs: string[], cta?: { label: string; href: string }) {
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a2233">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fb;padding:28px 16px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:30px 32px">
<tr><td>
<div style="font-weight:700;font-size:17px;letter-spacing:-0.01em;color:#1c5dd8;margin-bottom:22px">${BRAND}</div>
<h1 style="font-size:19px;line-height:1.35;margin:0 0 14px;font-weight:620">${esc(heading)}</h1>
${paragraphs.map((p) => `<p style="font-size:14.5px;line-height:1.6;margin:0 0 13px;color:#404a5c">${p}</p>`).join("\n")}
${
  cta
    ? `<p style="margin:22px 0 4px"><a href="${cta.href}" style="display:inline-block;background:#1c5dd8;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14.5px;font-weight:560">${esc(cta.label)}</a></p>`
    : ""
}
</td></tr></table>
<div style="max-width:560px;margin:16px auto 0;font-size:12px;color:#8992a4;text-align:center">
This is an automated message about your ${BRAND} account.
</div>
</td></tr></table>
</body></html>`;

  const text = [
    heading,
    "",
    ...paragraphs.map((p) => p.replace(/<[^>]+>/g, "")),
    ...(cta ? ["", `${cta.label}: ${cta.href}`] : []),
    "",
    `— ${BRAND}`,
  ].join("\n");

  return { html, text };
}

export function paymentReceipt(input: {
  name: string | null;
  reference: string;
  serviceTitle: string;
  pricePaise: number;
  invoiceNumber: string | null;
}): Body {
  const heading = `We have your payment for ${input.serviceTitle}`;
  const { html, text } = layout(
    heading,
    [
      `${input.name ? `Hello ${esc(input.name)}, ` : ""}thank you — we have received <strong>${money(input.pricePaise)}</strong> for order <strong>${esc(input.reference)}</strong>.`,
      input.invoiceNumber
        ? `Your tax invoice is <strong>${esc(input.invoiceNumber)}</strong>.`
        : "Your tax invoice will follow shortly.",
      // Set the expectation the assignment engine is about to meet, so silence for the
      // next thirty seconds does not read as nothing happening.
      "We are matching you with a qualified professional now. You will hear from them directly, and you can follow progress in your orders at any time.",
    ],
    { label: "View your order", href: portal("/orders") },
  );

  return { subject: `Payment received · ${input.reference}`, html, text };
}

export function assignmentNotice(input: {
  professionalName: string;
  reference: string;
  serviceTitle: string;
  clientName: string | null;
  acknowledgeBy: Date | null;
}): Body {
  const deadline = input.acknowledgeBy
    ? input.acknowledgeBy.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  const heading = `New matter: ${input.serviceTitle}`;
  const { html, text } = layout(
    heading,
    [
      `${esc(input.professionalName)}, a paid matter has been assigned to you — <strong>${esc(input.reference)}</strong>${input.clientName ? ` for ${esc(input.clientName)}` : ""}.`,
      // The clock is the entire reason this email exists rather than a dashboard badge.
      deadline
        ? `Please acknowledge it by <strong>${esc(deadline)} IST</strong>. Unacknowledged matters are reassigned.`
        : "Please acknowledge it as soon as you can. Unacknowledged matters are reassigned.",
      "The client's contact details are on the matter.",
    ],
    { label: "Open the matter", href: portal("/pro") },
  );

  return { subject: `New matter to acknowledge · ${input.reference}`, html, text };
}

export function matterStatusUpdate(input: {
  name: string | null;
  reference: string;
  serviceTitle: string;
  status: string;
}): Body {
  const readable: Record<string, string> = {
    in_progress: "is underway",
    awaiting_client: "is waiting on you",
    completed: "is complete",
  };
  const phrase = readable[input.status] ?? `is now ${input.status.replace(/_/g, " ")}`;

  const heading = `Your ${input.serviceTitle} ${phrase}`;
  const paragraphs = [
    `${input.name ? `Hello ${esc(input.name)}, ` : ""}order <strong>${esc(input.reference)}</strong> ${phrase}.`,
  ];

  // The one status that needs the client to do something gets a sentence saying so.
  if (input.status === "awaiting_client") {
    paragraphs.push(
      "Your professional needs something from you before they can continue. They will have been in touch directly.",
    );
  }

  const { html, text } = layout(heading, paragraphs, {
    label: "View your order",
    href: portal("/orders"),
  });

  return { subject: `${input.serviceTitle} ${phrase} · ${input.reference}`, html, text };
}

export function refundIssued(input: {
  name: string | null;
  reference: string;
  serviceTitle: string;
  amountPaise: number;
}): Body {
  const heading = `Refunded ${money(input.amountPaise)}`;
  const { html, text } = layout(heading, [
    `${input.name ? `Hello ${esc(input.name)}, ` : ""}we have refunded <strong>${money(input.amountPaise)}</strong> in full for <strong>${esc(input.reference)}</strong> (${esc(input.serviceTitle)}).`,
    // Said plainly, because "where is my money" is the next question otherwise.
    "It returns to the account you paid from. Banks usually take five to seven working days to show it.",
  ]);

  return { subject: `Refund issued · ${input.reference}`, html, text };
}

export function professionalVerified(input: { name: string }): Body {
  const heading = "You are verified";
  const { html, text } = layout(
    heading,
    [
      `${esc(input.name)}, your registration has been checked and your ${BRAND} account is verified.`,
      "Turn yourself available on your dashboard and matters will start arriving automatically. You can set how many you take at once.",
    ],
    { label: "Go to your dashboard", href: portal("/pro") },
  );

  return { subject: `Your ${BRAND} account is verified`, html, text };
}

export function payoutReleased(input: {
  name: string;
  amountPaise: number;
  reference: string;
  accountLast4: string | null;
}): Body {
  const heading = `${money(input.amountPaise)} is on its way`;
  const { html, text } = layout(
    heading,
    [
      `${esc(input.name)}, we have released <strong>${money(input.amountPaise)}</strong> to you${input.accountLast4 ? ` — account ending ${esc(input.accountLast4)}` : ""}.`,
      `Payout reference <strong>${esc(input.reference)}</strong>. This is net of commission and tax withheld at source; the breakdown is on your earnings page.`,
    ],
    { label: "See your earnings", href: portal("/pro") },
  );

  return { subject: `Payout released · ${money(input.amountPaise)}`, html, text };
}
