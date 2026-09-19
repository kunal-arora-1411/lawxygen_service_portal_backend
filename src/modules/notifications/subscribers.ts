import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  assignments,
  DOMAIN_EVENTS,
  orders,
  payouts,
  professionals,
  services,
  users,
} from "../../db/schema/index.js";
import { register } from "../events/outbox.js";
import { deliver } from "./service.js";
import {
  assignmentNotice,
  matterStatusUpdate,
  paymentReceipt,
  payoutReleased,
  professionalVerified,
  refundIssued,
} from "./templates.js";

/**
 * Telling people what happened.
 *
 * Every one of these hangs off the outbox rather than being called from the code that
 * caused the event. That is the whole reason the outbox exists: capture must not fail
 * because a mail provider is down, and adding WhatsApp in Phase 2 should mean adding a
 * file like this one and changing nothing else.
 *
 * Each handler re-reads what it needs rather than trusting the event payload to carry
 * it. Payloads were written for other purposes and an event sitting in the queue for a
 * minute is a payload that may already be stale — the name on an order, say. Reading
 * at send time costs one query and removes a class of wrong-details bug.
 */
export function registerNotificationSubscribers(): void {
  /** The client's receipt. */
  register({
    name: "notify-payment-receipt",
    events: [DOMAIN_EVENTS.ORDER_PAID],
    handle: async (event) => {
      const [row] = await db
        .select({
          reference: orders.reference,
          pricePaise: orders.pricePaise,
          serviceTitle: services.title,
          name: users.name,
          email: users.email,
        })
        .from(orders)
        .innerJoin(users, eq(users.id, orders.userId))
        .innerJoin(services, eq(services.id, orders.serviceId))
        .where(eq(orders.id, event.aggregateId))
        .limit(1);

      if (!row) return;

      const payload = event.payload as { invoiceNumber?: string };
      const body = paymentReceipt({
        name: row.name,
        reference: row.reference,
        serviceTitle: row.serviceTitle,
        pricePaise: row.pricePaise,
        invoiceNumber: payload.invoiceNumber ?? null,
      });

      await deliver({ eventId: event.id, kind: "order.paid.receipt", to: row.email, ...body });
    },
  });

  /**
   * The professional's new matter.
   *
   * The most load-bearing message in the system. Until this existed a professional
   * found out they had been assigned work by happening to open the dashboard, while an
   * acknowledgement deadline ran down in the background and admin took the matter back.
   */
  register({
    name: "notify-assignment",
    events: [DOMAIN_EVENTS.ASSIGNMENT_CREATED],
    handle: async (event) => {
      const [row] = await db
        .select({
          reference: orders.reference,
          serviceTitle: services.title,
          acknowledgeBy: assignments.acknowledgeBy,
          professionalName: professionals.displayName,
          professionalEmail: users.email,
        })
        .from(assignments)
        .innerJoin(orders, eq(orders.id, assignments.orderId))
        .innerJoin(services, eq(services.id, orders.serviceId))
        .innerJoin(professionals, eq(professionals.id, assignments.professionalId))
        .innerJoin(users, eq(users.id, professionals.userId))
        .where(eq(assignments.id, event.aggregateId))
        .limit(1);

      if (!row) return;

      // A second query rather than a second join on users: the first one is already
      // joined to the professional's user row, and aliasing for the client too reads
      // worse than asking again.
      const [client] = await db
        .select({ name: users.name })
        .from(orders)
        .innerJoin(users, eq(users.id, orders.userId))
        .where(eq(orders.reference, row.reference))
        .limit(1);

      const body = assignmentNotice({
        professionalName: row.professionalName,
        reference: row.reference,
        serviceTitle: row.serviceTitle,
        clientName: client?.name ?? null,
        acknowledgeBy: row.acknowledgeBy,
      });

      await deliver({
        eventId: event.id,
        kind: "assignment.created.notice",
        to: row.professionalEmail,
        ...body,
      });
    },
  });

  /** Progress, to the client. */
  register({
    name: "notify-status-change",
    events: [DOMAIN_EVENTS.ORDER_STATUS_CHANGED],
    handle: async (event) => {
      const [row] = await db
        .select({
          reference: orders.reference,
          status: orders.status,
          serviceTitle: services.title,
          name: users.name,
          email: users.email,
        })
        .from(orders)
        .innerJoin(users, eq(users.id, orders.userId))
        .innerJoin(services, eq(services.id, orders.serviceId))
        .where(eq(orders.id, event.aggregateId))
        .limit(1);

      if (!row) return;

      /**
       * Only the transitions a client would want to hear about. `assigned` is covered
       * by the receipt already promising it, and mailing somebody for every internal
       * state change is how a transactional sender gets marked as spam.
       */
      const worthSending = ["in_progress", "awaiting_client", "completed"];
      if (!worthSending.includes(row.status)) return;

      const body = matterStatusUpdate({
        name: row.name,
        reference: row.reference,
        serviceTitle: row.serviceTitle,
        status: row.status,
      });

      await deliver({
        eventId: event.id,
        kind: "order.status.update",
        to: row.email,
        ...body,
      });
    },
  });

  /** Money going back. */
  register({
    name: "notify-refund",
    events: [DOMAIN_EVENTS.ORDER_REFUNDED],
    handle: async (event) => {
      const [row] = await db
        .select({
          reference: orders.reference,
          pricePaise: orders.pricePaise,
          serviceTitle: services.title,
          name: users.name,
          email: users.email,
        })
        .from(orders)
        .innerJoin(users, eq(users.id, orders.userId))
        .innerJoin(services, eq(services.id, orders.serviceId))
        .where(eq(orders.id, event.aggregateId))
        .limit(1);

      if (!row) return;

      const body = refundIssued({
        name: row.name,
        reference: row.reference,
        serviceTitle: row.serviceTitle,
        amountPaise: row.pricePaise,
      });

      await deliver({ eventId: event.id, kind: "order.refunded.notice", to: row.email, ...body });
    },
  });

  /** Verification. */
  register({
    name: "notify-verified",
    events: [DOMAIN_EVENTS.PROFESSIONAL_APPROVED],
    handle: async (event) => {
      const [row] = await db
        .select({ displayName: professionals.displayName, email: users.email })
        .from(professionals)
        .innerJoin(users, eq(users.id, professionals.userId))
        .where(eq(professionals.id, event.aggregateId))
        .limit(1);

      if (!row) return;

      const body = professionalVerified({ name: row.displayName });
      await deliver({
        eventId: event.id,
        kind: "professional.verified.notice",
        to: row.email,
        ...body,
      });
    },
  });

  /** Money going out. */
  register({
    name: "notify-payout",
    events: [DOMAIN_EVENTS.PAYOUT_RELEASED],
    handle: async (event) => {
      const [row] = await db
        .select({
          amountPaise: payouts.amountPaise,
          accountLast4: payouts.accountLast4,
          displayName: professionals.displayName,
          email: users.email,
        })
        .from(payouts)
        .innerJoin(professionals, eq(professionals.id, payouts.professionalId))
        .innerJoin(users, eq(users.id, professionals.userId))
        .where(eq(payouts.id, event.aggregateId))
        .limit(1);

      if (!row) return;

      const payload = event.payload as { batchReference?: string };
      const body = payoutReleased({
        name: row.displayName,
        amountPaise: row.amountPaise,
        reference: payload.batchReference ?? "",
        accountLast4: row.accountLast4,
      });

      await deliver({
        eventId: event.id,
        kind: "payout.released.notice",
        to: row.email,
        ...body,
      });
    },
  });
}
