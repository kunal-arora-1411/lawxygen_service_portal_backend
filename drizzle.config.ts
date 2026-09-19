import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside the app, so it loads env itself rather than importing
// src/lib/env.ts — which would validate variables the CLI has no use for.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Absent is fine.
  }
}

/**
 * `generate` diffs the schema against the migration history on disk and never connects,
 * so it must work without credentials — that is what lets CI prove the schema still
 * produces a clean migration. The commands that do connect fail loudly instead.
 */
const NEEDS_CONNECTION = new Set(["migrate", "push", "pull", "studio", "up", "check"]);
const url = process.env.DATABASE_URL ?? "";

if (!url && NEEDS_CONNECTION.has(process.argv[2] ?? "")) {
  throw new Error(
    `drizzle-kit ${process.argv[2]} needs DATABASE_URL. Copy .env.example to .env.local.`,
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  dbCredentials: { url },
  casing: "snake_case",
  verbose: true,
  strict: true,
});
