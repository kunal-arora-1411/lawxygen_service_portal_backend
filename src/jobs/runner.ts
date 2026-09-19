import { drainAwaitingAssignment } from "../modules/assignment/engine.js";
import { escalateOverdueAssignments } from "../modules/assignment/escalation.js";
import { dispatchPending } from "../modules/events/outbox.js";
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
  ];

  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}
