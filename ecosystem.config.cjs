// PM2 process definition for api.lawxygen.in.
//
//   pm2 startOrReload ecosystem.config.cjs --update-env
//
// deploy/deploy.sh is what runs that; nothing else should need to.
//
// `.cjs` because package.json declares `"type": "module"` and PM2 loads this with require.

module.exports = {
  apps: [
    {
      name: "lawxygen-api",
      cwd: __dirname,
      script: "dist/server.js",

      // Node's own loader reads the file, rather than PM2's `env_file` or a shell
      // `source`: a value like `MAIL_FROM=Lawxygen <no-reply@lawxygen.in>` is a syntax
      // error to bash. A missing file stops the process starting, which is the point.
      // Source maps because the stack traces are otherwise line numbers in compiled JS.
      node_args: ["--env-file=.env.production", "--enable-source-maps"],

      // Exactly one process, in fork mode. The background jobs run inside the API
      // (src/jobs/runner.ts) and reconciliation takes no lock, so a second instance —
      // cluster mode, or `instances: 2` — would run it twice concurrently. See backlog
      // item 18 before changing this.
      instances: 1,
      exec_mode: "fork",

      // These win over .env.production: Node never overwrites a variable that is already
      // set. HOST keeps the API off the public interface — nginx proxies to it on
      // loopback, and ufw is not enabled on this shared host.
      env: {
        NODE_ENV: "production",
        APP_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "4000",
      },

      // PM2 sends SIGINT, then SIGKILL after this long. server.ts gives in-flight requests
      // ten seconds before it exits on its own, so this must be longer than that.
      kill_timeout: 12_000,

      // A boot failure — Neon unreachable, a bad variable — exits immediately. Back off
      // rather than restarting in a tight loop against the same failure.
      exp_backoff_restart_delay: 1_000,
      max_memory_restart: "600M",

      // pino already writes a timestamp into every line.
      time: false,
    },
  ],
};
