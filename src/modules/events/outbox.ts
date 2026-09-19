import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { outboxEvents, type DomainEventName, type OutboxEvent } from "../../db/schema/index.js";
import { isUniqueViolation } from "../../lib/db-errors.js";
import { logger } from "../../lib/logger.js";

/**
 * The outbox.
 *
 * Events are written in the **same transaction** as the state change that caused them,
 * so an event cannot exist for a change that rolled back, and a change cannot commit
 * while losing its event. A queue published after the commit has a window where the
 * process dies in between; there is no such window here.
 *
 * Just as important in the other direction: work triggered by an event runs *outside*
 * the originating transaction. A payment capture must never fail because no
 * professional was available — the money arrived regardless.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type EmitInput = {
  name: DomainEventName;
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown>;
  /**
   * Defaults to `<name>:<aggregateId>`, which is right when an event can only
   * legitimately happen once for its subject. Pass one explicitly where it can repeat —
   * an order reassigned twice emits two `assignment.created` events.
   */
  dedupeKey?: string;
};

/**
 * Writes an event inside the caller's transaction.
 *
 * A duplicate `dedupeKey` is **not** an error: it means this exact event was already
 * emitted, most often by a reconciliation backfill re-driving something. Swallowing it
 * here, rather than letting 23505 abort the transaction, is what keeps a replay from
 * failing the state change it accompanies.
 */
export async function emit(tx: Tx, input: EmitInput): Promise<void> {
  const dedupeKey = input.dedupeKey ?? `${input.name}:${input.aggregateId}`;

  try {
    await tx.insert(outboxEvents).values({
      name: input.name,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload ?? {},
      dedupeKey,
    });
  } catch (error) {
    if (isUniqueViolation(error, "outbox_dedupe_uq")) {
      logger.debug({ dedupeKey }, "outbox event already emitted");
      return;
    }
    throw error;
  }
}

export type Subscriber = {
  name: string;
  events: readonly DomainEventName[];
  handle: (event: OutboxEvent) => Promise<void>;
};

const subscribers: Subscriber[] = [];

export function register(subscriber: Subscriber): void {
  subscribers.push(subscriber);
}

/** Test seam — restores the registry to a known state. */
export function clearSubscribers(): void {
  subscribers.length = 0;
}

export function subscribersFor(name: string): Subscriber[] {
  return subscribers.filter((s) => (s.events as readonly string[]).includes(name));
}

const MAX_ATTEMPTS = 10;
const STALE_LOCK_MS = 60_000;

/**
 * Claims one pending event.
 *
 * `FOR UPDATE SKIP LOCKED` inside the subquery is what lets several dispatchers run
 * without coordinating: each skips rows another has taken rather than blocking on them.
 */
async function claimNext(): Promise<OutboxEvent | undefined> {
  const [claimed] = await db
    .update(outboxEvents)
    .set({
      status: "dispatching",
      lockedAt: new Date(),
      attempts: sql`${outboxEvents.attempts} + 1`,
    })
    .where(
      eq(
        outboxEvents.id,
        sql`(SELECT id FROM outbox_events
             WHERE status = 'pending' AND next_attempt_at <= now()
             ORDER BY next_attempt_at
             LIMIT 1
             FOR UPDATE SKIP LOCKED)`,
      ),
    )
    .returning();

  return claimed;
}

/** Returns anything a crashed dispatcher left mid-flight to the queue. */
async function reclaimStale(): Promise<void> {
  await db
    .update(outboxEvents)
    .set({ status: "pending", lockedAt: null })
    .where(
      and(
        eq(outboxEvents.status, "dispatching"),
        sql`${outboxEvents.lockedAt} < now() - ${`${String(STALE_LOCK_MS)} milliseconds`}::interval`,
      ),
    );
}

async function deliver(event: OutboxEvent): Promise<void> {
  const targets = subscribersFor(event.name);
  const failures: string[] = [];

  for (const subscriber of targets) {
    try {
      await subscriber.handle(event);
    } catch (error) {
      failures.push(
        `${subscriber.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures.length === 0) {
    await db
      .update(outboxEvents)
      .set({ status: "dispatched", dispatchedAt: new Date(), lockedAt: null, lastError: null })
      .where(eq(outboxEvents.id, event.id));
    return;
  }

  // A partial failure re-runs every subscriber for this event, so each handler must be
  // idempotent. That constraint is why the assignment handler keys off a unique index
  // rather than assuming it runs once.
  const dead = event.attempts >= MAX_ATTEMPTS;
  const backoffMs = Math.min(2 ** event.attempts * 1000, 30 * 60_000);
  // Jitter, so a backlog released after an outage does not retry in lockstep.
  const jitter = Math.floor(Math.random() * backoffMs * 0.3);

  await db
    .update(outboxEvents)
    .set({
      status: dead ? "dead" : "pending",
      lockedAt: null,
      nextAttemptAt: new Date(Date.now() + backoffMs + jitter),
      lastError: failures.join(" | "),
    })
    .where(eq(outboxEvents.id, event.id));

  if (dead) logger.error({ event: event.name, id: event.id, failures }, "outbox event gave up");
}

/** Drains up to `max` events. Returns how many were delivered. */
export async function dispatchPending(max = 50): Promise<number> {
  await reclaimStale();

  let handled = 0;
  for (let i = 0; i < max; i += 1) {
    const event = await claimNext();
    if (!event) break;
    await deliver(event);
    handled += 1;
  }
  return handled;
}
