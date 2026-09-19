import { z } from "zod";
import { ApiError } from "./api.js";

/**
 * Cursor pagination.
 *
 * Cursors, not offsets, from the first endpoint written. `OFFSET 40` re-reads and
 * discards forty rows on every page, and it skips or repeats rows whenever something is
 * inserted between requests — on an orders list, that means a client can page past their
 * own new order and never see it.
 *
 * The cursor is an opaque string by contract. It is base64 of the sort key, but clients
 * must treat it as a token so the sort key can change without breaking them.
 */

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export const pageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

/**
 * A pipe, not a NUL byte. None of the values joined here — integers, UUIDs, ISO
 * timestamps — can contain one, and a literal NUL in the source makes git classify the
 * file as binary and stop showing diffs for it.
 */
const SEPARATOR = "|";

export function encodeCursor(parts: readonly (string | number)[]): string {
  return Buffer.from(parts.join(SEPARATOR), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, expected: number): string[] {
  let parts: string[];
  try {
    parts = Buffer.from(cursor, "base64url").toString("utf8").split(SEPARATOR);
  } catch {
    throw new ApiError("invalid_input", "That page link is not valid.");
  }
  if (parts.length !== expected) {
    throw new ApiError("invalid_input", "That page link is not valid.");
  }
  return parts;
}

/**
 * Splits a deliberately over-fetched result into a page and its next cursor.
 *
 * Query `limit + 1` rows: the presence of the extra one is what says whether another
 * page exists, without a second COUNT query that would be wrong by the time it returned.
 */
export function toPage<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => string,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: last ? cursorOf(last) : null };
}
