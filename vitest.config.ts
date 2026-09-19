import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],

    /**
     * Integration test files share one database, so they are not isolated from each
     * other and must not run concurrently. Running them in parallel produced exactly
     * the failure that motivates this: the orders suite publishes a service in its
     * setup while the catalogue suite asserts on which services are published, and
     * each passed alone while the pair failed together.
     *
     * Tests should also not assert on global catalogue state — see catalogue.test.ts,
     * which scopes its assertions to a service it publishes itself.
     */
    fileParallelism: false,
  },
});
