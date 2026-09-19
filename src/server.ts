// Must come first: everything below reads validated configuration at import time.
import "./lib/load-env.js";

import { createApp } from "./app.js";
import { assertDatabaseReachable, closeDatabase } from "./db/client.js";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { startJobs } from "./jobs/runner.js";

/**
 * Process entry point.
 *
 * The database is checked before the port is opened. `db/client.ts` connects lazily so
 * that tooling does not need credentials, but a server that accepts traffic before
 * knowing it can reach its database just converts a configuration error into a stream of
 * 500s. Fail here instead.
 */
async function main(): Promise<void> {
  await assertDatabaseReachable();

  const server = createApp().listen(env.PORT, () => {
    logger.info({ port: env.PORT, appEnv: env.APP_ENV }, "api listening");
  });

  const stopJobs = startJobs();

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    stopJobs();
    server.close(() => {
      void closeDatabase().then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ err: error }, "failed to close database");
          process.exit(1);
        },
      );
    });

    // Don't let an in-flight request hold the process open indefinitely.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "failed to start");
  process.exit(1);
});
