// PM2 ecosystem for Maelle (v1.8.2+). Start everything with:
//   pm2 start ecosystem.config.js
//   pm2 save                          # persist for pm2-windows-startup
//
// Processes:
//   - maelle:                 the main bot (runs built dist/index.js)
//   - maelle-deploy-watcher:  polls origin/master every 5 min, pulls +
//                             rebuilds + restarts maelle when an
//                             auto-triage commit lands

module.exports = {
  apps: [
    {
      name: 'maelle',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'maelle-deploy-watcher',
      script: 'scripts/deploy-watcher.mjs',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        DEPLOY_POLL_SECONDS: '300',
        PM2_APP_NAME: 'maelle',
      },
    },
  ],
};
