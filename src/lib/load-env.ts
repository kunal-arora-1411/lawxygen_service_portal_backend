/**
 * Loads .env.local, then .env, into process.env.
 *
 * Side-effecting on purpose, and it must be the **first** import in any entry point.
 * `env.ts` validates on module load, so anything that imports it before this has run
 * sees an empty environment and throws — which is exactly what happened the first time
 * `npm run dev` was tried.
 *
 * Node's own loader is used rather than dotenv: it is built in, and a runtime dependency
 * for reading a file the runtime can already read is not worth the supply chain.
 *
 * Real deployments set variables directly and have neither file; absence is not an error.
 */
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Not present. Deployed environments inject variables directly.
  }
}
