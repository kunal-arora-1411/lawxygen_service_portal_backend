import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env, required } from "../lib/env.js";
import * as schema from "./schema/index.js";

/**
 * Database client.
 *
 * Connecting is **lazy**. Importing this module must not open a socket or require
 * DATABASE_URL to be present, so that unit tests and a typecheck can run without
 * credentials. The pool opens on the first actual query instead, and the error then names
 * the missing variable.
 *
 * Laziness is not an excuse for discovering a bad URL on the first customer request:
 * `assertDatabaseReachable()` is called at server boot precisely so the process fails
 * fast. Lazy for tooling, eager for the server.
 */

type Database = PostgresJsDatabase<typeof schema>;

let sql: ReturnType<typeof postgres> | undefined;
let instance: Database | undefined;

function connect(): Database {
  if (instance) return instance;

  const url = required("DATABASE_URL");

  // Neon's connection-pooler endpoint runs PgBouncer in transaction mode, which does not
  // hold a session across statements. postgres-js uses prepared statements by default and
  // they break there — intermittently, under load, which is the worst way to find out.
  // Detected from the host rather than configured, so a direct URL still gets prepares.
  const pooled = /-pooler\./.test(url);

  sql = postgres(url, {
    max: env.APP_ENV === "local" ? 5 : 20,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: !pooled,
  });

  instance = drizzle(sql, { schema, casing: "snake_case" });
  return instance;
}

/**
 * The Drizzle instance. Behaves exactly like a normal `db`, but the underlying pool is
 * created on first property access rather than at import time.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, property, receiver) {
    const real = connect();
    const value: unknown = Reflect.get(real, property, receiver);
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(real)
      : value;
  },
  has(_target, property) {
    return Reflect.has(connect(), property);
  },
});

/** Opens the pool and runs a trivial query, so a bad URL fails the boot and not a request. */
export async function assertDatabaseReachable(): Promise<void> {
  const client = sql ?? (connect(), sql);
  if (!client) throw new Error("Database client was not initialised.");
  await client`select 1`;
}

/** Closes the pool. Used by the graceful shutdown path and by integration teardown. */
export async function closeDatabase(): Promise<void> {
  if (!sql) return;
  await sql.end({ timeout: 5 });
  sql = undefined;
  instance = undefined;
}

export { schema };
