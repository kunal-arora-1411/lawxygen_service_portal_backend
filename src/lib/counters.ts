import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { counters } from "../db/schema/index.js";
import { ApiError } from "./api.js";

type Executor = Pick<typeof db, "insert">;

/**
 * Allocates the next value for a named counter.
 *
 * One statement: the upsert both creates the counter on first use and increments it,
 * under the row lock PostgreSQL takes for the update. Two concurrent callers cannot
 * receive the same number, and neither can skip one.
 *
 * **Pass `tx`.** Allocated inside the transaction that uses the number, an abort rolls
 * the counter back and no number is burned — which is the whole reason this is a table
 * and not a sequence. Called outside a transaction it still allocates correctly, but a
 * later failure leaves a gap.
 */
export async function nextCounterValue(name: string, tx?: Executor): Promise<number> {
  const [row] = await (tx ?? db)
    .insert(counters)
    .values({ name, value: 1 })
    .onConflictDoUpdate({
      target: counters.name,
      set: { value: sql`${counters.value} + 1` },
    })
    .returning({ value: counters.value });

  if (!row) throw new ApiError("internal", `Could not allocate a value for "${name}".`);
  return row.value;
}

/** e.g. `LX-000142`. Wide enough that it does not need re-formatting for a long time. */
export function formatOrderReference(value: number): string {
  return `LX-${String(value).padStart(6, "0")}`;
}
