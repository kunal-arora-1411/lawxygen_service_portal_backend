import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  assignments,
  DOMAIN_EVENTS,
  orders,
  professionals,
  services,
  users,
} from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";
import { register } from "../events/outbox.js";
import { isConfigured } from "./client.js";
import { sendTemplateMessage } from "./send.js";

/**
 * WhatsApp, hung off the outbox.
 *
 * Exactly the shape the email subscribers already have, and for the same reason: a
 * payment capture must never fail because Meta is down. Adding this file was the whole
 * point of building the outbox seam in M3.
 *
 * **Idempotency comes from the event id.** The outbox re-runs every subscriber for an
 * event when any one of them fails, so a WhatsApp send that succeeded beside a failing
 * sibling will be asked to send again. Keying the send attempt on
 * `<event id>:<kind>` makes the second attempt a no-op rather than a second message —
 * and a second message here costs real money as well as looking broken.
 *
 * Failures are swallowed, like the email ones. A WhatsApp outage must not re-run the
 * assignment subscriber and hand a matter to a second professional.
 */

/** Template names, authored in the WhatsApp console and referenced by name. */
export const TEMPLATES = {
  /** `{{1}}` client name · `{{2}}` service · `{{3}}` amount · `{{4}}` reference */
  PAYMENT_RECEIPT: "lawxygen_payment_receipt",
  /** `{{1}}` professional name · `{{2}}` service · `{{3}}` reference · `{{4}}` client */
  ASSIGNMENT_NOTICE: "lawxygen_assignment_notice",
} as const;

function rupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

/**
 * Meta rejects a template variable containing a newline, a tab, or four or more
 * consecutive spaces. A service title with an odd space in it would otherwise fail the
 * send with a message that explains nothing.
 */
function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function registerWhatsappSubscribers(): void {
  /**
   * The client's receipt.
   *
   * A template, not free text, because no reply window is open — and sending this does
   * not open one. Only the client answering does.
   */
  register({
    name: "whatsapp-payment-receipt",
    events: [DOMAIN_EVENTS.ORDER_PAID],
    handle: async (event) => {
      if (!isConfigured()) return;

      const [row] = await db
        .select({
          reference: orders.reference,
          pricePaise: orders.pricePaise,
          serviceTitle: services.title,
          name: users.name,
          phone: users.phone,
          whatsappConsent: users.whatsappConsent,
          userId: users.id,
          orderId: orders.id,
        })
        .from(orders)
        .innerJoin(users, eq(users.id, orders.userId))
        .innerJoin(services, eq(services.id, orders.serviceId))
        .where(eq(orders.id, event.aggregateId))
        .limit(1);

      if (!row?.phone) return;

      /**
       * Consent is not a formality. Meta requires opt-in and audits for it, and this is
       * exactly why the registration form has captured it since M0.
       */
      if (!row.whatsappConsent) {
        logger.info({ orderId: row.orderId }, "skipping WhatsApp receipt: no messaging consent");
        return;
      }

      await sendTemplateMessage({
        idempotencyKey: `${event.id}:receipt`,
        source: "outbox",
        recipientPhone: row.phone,
        templateName: TEMPLATES.PAYMENT_RECEIPT,
        variables: [
          clean(row.name ?? "there"),
          clean(row.serviceTitle),
          rupees(row.pricePaise),
          row.reference,
        ],
        orderId: row.orderId,
        userId: row.userId,
      });
    },
  });

  /**
   * The professional's new matter.
   *
   * The message with the most value in it — until email existed, a professional found
   * out they had work by happening to open the dashboard, and WhatsApp is read far more
   * reliably than email by the people doing this work.
   */
  register({
    name: "whatsapp-assignment-notice",
    events: [DOMAIN_EVENTS.ASSIGNMENT_CREATED],
    handle: async (event) => {
      if (!isConfigured()) return;

      const [row] = await db
        .select({
          reference: orders.reference,
          serviceTitle: services.title,
          professionalName: professionals.displayName,
          phone: users.phone,
          whatsappConsent: users.whatsappConsent,
          userId: users.id,
          orderId: orders.id,
        })
        .from(assignments)
        .innerJoin(orders, eq(orders.id, assignments.orderId))
        .innerJoin(services, eq(services.id, orders.serviceId))
        .innerJoin(professionals, eq(professionals.id, assignments.professionalId))
        .innerJoin(users, eq(users.id, professionals.userId))
        .where(eq(assignments.id, event.aggregateId))
        .limit(1);

      if (!row?.phone || !row.whatsappConsent) return;

      const [client] = await db
        .select({ name: users.name })
        .from(orders)
        .innerJoin(users, eq(users.id, orders.userId))
        .where(eq(orders.id, row.orderId))
        .limit(1);

      await sendTemplateMessage({
        idempotencyKey: `${event.id}:assignment`,
        source: "outbox",
        recipientPhone: row.phone,
        templateName: TEMPLATES.ASSIGNMENT_NOTICE,
        variables: [
          clean(row.professionalName),
          clean(row.serviceTitle),
          row.reference,
          clean(client?.name ?? "a client"),
        ],
        orderId: row.orderId,
        userId: row.userId,
      });
    },
  });
}
