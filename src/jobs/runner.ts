import { drainAwaitingAssignment } from "../modules/assignment/engine.js";
import { escalateOverdueAssignments } from "../modules/assignment/escalation.js";
import { dispatchPending } from "../modules/events/outbox.js";
import { retryFailedNotifications } from "../modules/notifications/service.js";
import { reconcileScheduled } from "../modules/payments/reconciliation.js";
import { logger } from "../lib/logger.js";

/**
 * Background work.
 *
 * In-process intervals, deliberately, for now. A separate worker process is the right
 * answer once there is more than one instance — and when that happens nothing here
 * changes, because both jobs claim their work with `FOR UPDATE SKIP LOCKED` and are
 * already safe to run concurrently in several processes.
 *
 * What they must not do is silently stop. Each catches its own errors and logs them;
 * an unhandled rejection inside `setInterval` takes the process down, and a dispatcher
 * that has quietly died is indistinguishable from a quiet day.
 */

const OUTBOX_INTERVAL_MS = 2_000;
const ESCALATION_INTERVAL_MS = 5 * 60_000;

/**
 * Retry the queue of orders parked for want of a professional.
 *
 * Supply changes already drain it — approving someone, or coming back available. That
 * covers the case the queue exists for, and misses a smaller one that is just as bad:
 * an order can be deferred because every candidate was *momentarily locked* by another
 * assigner, not because nobody was free. Seen in practice with a single professional
 * and two payments seconds apart; the second order queued and, with no periodic retry,
 * would have stayed there until somebody happened to toggle availability.
 */
const DRAIN_INTERVAL_MS = 60_000;

/**
 * Reconciliation runs every six hours over a 48-hour window, rather than once a night
 * over a day. The overlap is free — repairs go through the idempotent capture path —
 * and it means a missed webhook is found within hours instead of the next morning.
 *
 * It does nothing useful until the gateway is configured: the lister refuses, the run
 * is recorded as failed, and that is the honest state of affairs rather than a screen
 * full of clean runs that never asked anybody anything.
 */
const RECONCILE_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * A notification send that failed is recorded and swallowed, so a mail provider being
 * down cannot re-run the assignment engine. This is what picks those back up — without
 * it the swallow is simply a loss.
 */
const NOTIFICATION_RETRY_INTERVAL_MS = 5 * 60_000;

export type StopJobs = () => void;

function every(name: string, ms: number, task: () => Promise<unknown>): NodeJS.Timeout {
  let running = false;

  const timer = setInterval(() => {
    // Skip rather than overlap: a slow pass must not stack up behind itself.
    if (running) return;
    running = true;

    void task()
      .catch((error: unknown) => {
        logger.error({ err: error, job: name }, "background job failed");
      })
      .finally(() => {
        running = false;
      });
  }, ms);

  // Do not hold the process open on shutdown.
  timer.unref();
  return timer;
}

export function startJobs(): StopJobs {
  logger.info(
    { outboxMs: OUTBOX_INTERVAL_MS, escalationMs: ESCALATION_INTERVAL_MS },
    "background jobs started",
  );

  const timers = [
    every("outbox", OUTBOX_INTERVAL_MS, () => dispatchPending()),
    every("escalation", ESCALATION_INTERVAL_MS, () => escalateOverdueAssignments()),
    every("drain-queue", DRAIN_INTERVAL_MS, () => drainAwaitingAssignment()),
    every("reconcile", RECONCILE_INTERVAL_MS, () => reconcileScheduled()),
    every("notify-retry", NOTIFICATION_RETRY_INTERVAL_MS, () => retryFailedNotifications()),
  ];

  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}
