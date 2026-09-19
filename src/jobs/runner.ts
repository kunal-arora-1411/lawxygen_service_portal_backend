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
  ];

  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}
