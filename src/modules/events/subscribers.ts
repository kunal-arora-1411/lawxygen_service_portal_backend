import { DOMAIN_EVENTS } from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";
import { assignOrder, drainAwaitingAssignment } from "../assignment/engine.js";
import { register } from "./outbox.js";

/**
 * Who reacts to what.
 *
 * This file is the entire wiring. Adding WhatsApp in Phase 2 means adding a subscriber
 * here and nothing else — no emitting code changes, no schema changes, because phone
 * numbers and messaging consent are already captured at registration.
 *
 * Every handler must be **idempotent**: a partial failure re-runs all subscribers for
 * the event, so a handler that assumes it runs once will run twice.
 */
export function registerSubscribers(): void {
  register({
    name: "assign",
    events: [DOMAIN_EVENTS.ASSIGNMENT_REQUESTED],
    handle: async (event) => {
      const outcome = await assignOrder(event.aggregateId);
      logger.info({ orderId: event.aggregateId, outcome: outcome.status }, "assignment attempted");
    },
  });

  /**
   * New supply drains the queue immediately.
   *
   * Without this an order parked for want of a professional waits for the next retry
   * tick even though someone qualified was approved seconds ago.
   */
  register({
    name: "drain-queue",
    events: [DOMAIN_EVENTS.PROFESSIONAL_APPROVED, DOMAIN_EVENTS.PROFESSIONAL_AVAILABLE],
    handle: async () => {
      const assigned = await drainAwaitingAssignment();
      if (assigned > 0) logger.info({ assigned }, "queued orders assigned after supply change");
    },
  });
}
