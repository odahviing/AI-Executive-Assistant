// PM2 ecosystem for Maelle — Linux VM.
//
// First run (on the VM, in the repo root):
//   pm2 start ecosystem.config.js
//   pm2 save                     # persist the process list
//   pm2 startup systemd          # prints a command — run it once (sudo) so PM2
//                                # (and Maelle) come back after a reboot
//
// New code goes live automatically via `maelle-deploy-watcher` below, or manually
// via `npm run deploy` (build → pm2 restart maelle → tail).
//
// Two processes:
//   • maelle                — the bot (compiled dist/index.js). ONE Slack Socket
//                             Mode WebSocket, ONE SQLite writer, in-memory state.
//   • maelle-deploy-watcher — polls origin/master and auto-deploys new commits.
//                             Holds no socket. Drop this app from the array if you
//                             prefer manual deploys only.
//
// SINGLE-SOCKET INVARIANT: exactly one `maelle` process, ever. Two = two sockets
// → Slack `too_many_connections` and they fight. Enforced by fork mode + no
// `instances`. NEVER set instances>1, and NEVER use `pm2 reload maelle` (overlaps
// old+new during the swap = two sockets) — `pm2 restart` (kill-then-respawn) only.
module.exports = {
  apps: [
    {
      name: 'maelle',
      script: 'dist/index.js',
      cwd: __dirname,
      exec_mode: 'fork',        // NOT cluster — single stateful process (see above)
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
        // App config (Slack tokens live in config/users/idan.yaml; infra creds +
        // Vertex/LLM here) is read from the VM's .env via dotenv — nothing secret
        // is committed. Set DB_PATH/LOG_PATH in .env only to override the
        // defaults (./data/maelle.db, ./logs), which are correct for the VM.
      },
    },
    {
      name: 'maelle-deploy-watcher',
      script: 'scripts/deploy-watcher.mjs',
      cwd: __dirname,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      env: {
        NODE_ENV: 'production',
        DEPLOY_BRANCH: 'master',
        DEPLOY_POLL_SECONDS: '120',
      },
    },
  ],
};
