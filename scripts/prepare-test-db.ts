import "../src/lib/load-env.js";

import { execFileSync } from "node:child_process";
import postgres from "postgres";

/**
 * Creates the test database if it is missing and brings its schema up to date.
 *
 * Tests run against their own database rather than sharing one with a running dev
 * server — see the note in test/setup.ts for what that sharing actually breaks. This
 * makes that separation a single command rather than something each developer has to
 * remember to set up.
 */
const source = process.env.DATABASE_URL;
if (!source) {
  process.stdout.write("No DATABASE_URL; integration tests will skip.\n");
  process.exit(0);
}

const testUrl = new URL(source);
const name = `${testUrl.pathname.replace(/^\//, "").replace(/\/$/, "")}_test`;
testUrl.pathname = `/${name}`;

const admin = new URL(source);
admin.pathname = "/postgres";

const sql = postgres(admin.toString(), { max: 1 });
try {
  const [existing] = await sql`select 1 from pg_database where datname = ${name}`;
  if (!existing) {
    // Identifier, so it cannot be parameterised — the name is derived from our own
    // configured URL and validated below rather than taken from input.
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Refusing odd database name: ${name}`);
    await sql.unsafe(`create database ${name}`);
    process.stdout.write(`Created ${name}.\n`);
  }
} finally {
  await sql.end({ timeout: 5 });
}

const withTestDb = { ...process.env, DATABASE_URL: testUrl.toString() };

execFileSync("npx", ["drizzle-kit", "migrate"], {
  stdio: "inherit",
  shell: true,
  env: withTestDb,
});

// The suite asserts against the full catalogue — 259 services, 237 distinct slugs —
// so the test database needs it too. The seed is idempotent, so this is cheap to
// repeat on every run and removes a setup step nobody would remember.
execFileSync("npx", ["tsx", "src/db/seed-catalogue.ts"], {
  stdio: "inherit",
  shell: true,
  env: withTestDb,
});
