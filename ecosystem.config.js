// PM2 ecosystem for Maelle. Start with:
//   pm2 start ecosystem.config.js
//   pm2 save                          # persist for pm2-windows-startup
//
// Single process — `maelle`, the main bot (runs the compiled dist/index.js).
// PM2 keeps it alive across crashes / terminal-close / reboot. New code goes
// live via `npm run deploy` (build → pm2 restart maelle → tail logs).
//
// The old `maelle-deploy-watcher` (a 5-min origin/master git-poll that
// auto-pulled "Maelle Auto-Triage" commits) was REMOVED 2026-06-11 — auto-
// triage is retired, so the watcher had nothing to act on. Deploys are now
// manual via `npm run deploy`. (scripts/deploy-watcher.mjs is now orphaned.)

module.exports = {
  apps: [
    {
      name: 'maelle',
      script: 'dist/index.js',
      cwd: __dirname,
      // fork mode (NOT cluster). Maelle is a single stateful process: one Slack
      // Socket Mode WebSocket, in-memory state (dedup / inbound queue / thread
      // activity), and ONE SQLite file. Cluster mode buys nothing here and is a
      // footgun — bumping instances>1 would spawn multiple workers all binding
      // the same Slack token (turn-splitting) and writing the same DB. Setting
      // exec_mode:'fork' + omitting `instances` keeps it single by construction.
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
