#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# vm-setup.sh — provision + first-run for Maelle on a single Linux VM (PM2).
#
# The simple always-on shape: one small VM, Node 20 + PM2, SQLite on the local
# disk, config from .env + config/users/, restart-on-crash + restart-on-boot, and
# auto-deploy on new commits via the deploy-watcher (see ecosystem.config.js).
# (The k8s/ + Dockerfile path is left intact for a possible later move to GKE.)
#
# Run this ON THE VM, from the repo root, after cloning. Safe to re-run.
#
# ═══ FULL RUNBOOK ════════════════════════════════════════════════════════════
#
# 0. Provision a Debian/Ubuntu VM. For Vertex auth WITHOUT a key file, attach a
#    GCE service account holding roles/aiplatform.user (ADC via the metadata
#    server). Then:
#      git clone <repo> ~/Maelle && cd ~/Maelle
#      bash scripts/vm-setup.sh
#
# 1. Add the config the app needs (NOT in git — you provide these):
#      ~/Maelle/.env                     # see the keys below
#      ~/Maelle/config/users/idan.yaml   # profile + Slack tokens (migrated, step 2)
#
#    .env keys:
#      LLM_PROVIDER=vertex
#      VERTEX_PROJECT_ID=reflectiz-ai-backoffice
#      VERTEX_REGION=global            # a Claude-serving Vertex location
#      AZURE_TENANT_ID=...  AZURE_CLIENT_ID=...  AZURE_CLIENT_SECRET=...
#      OPENAI_API_KEY=...              # optional (voice)
#      TAVILY_API_KEY=...              # optional (web search)
#      # no ANTHROPIC_API_KEY — Vertex handles the LLM (keyless via the VM's SA).
#      # If NOT on a GCE VM with an attached SA, also set:
#      #   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
#
# 2. Migrate the live data FROM THE LAPTOP (run on the laptop). Stop the laptop
#    bot FIRST — quiesces the DB and guarantees only one Slack socket is ever live:
#      pm2 stop maelle
#      sqlite3 data/maelle.db "PRAGMA wal_checkpoint(TRUNCATE);"
#      rsync -avz        data/maelle.db     <vm>:~/Maelle/data/
#      rsync -avz --delete config/users/    <vm>:~/Maelle/config/users/
#
# 3. Start on the VM:
#      pm2 start ecosystem.config.js && pm2 save
#      pm2 startup systemd            # run the printed sudo command once (reboot-safe)
#
# 4. Verify — only then is the cutover done (NEVER run laptop + VM together):
#      pm2 logs maelle --lines 40    # confirm the boot stamp (version + gitSha)
#      # DM Maelle a test message; confirm a round-trip + that briefs/timers fire.
#    ROLLBACK: `pm2 stop maelle` on the VM, `pm2 start maelle` on the laptop.
#
# After cutover: pushing to origin/master auto-deploys within ~2 min
# (deploy-watcher: pull → typecheck → build → pm2 restart maelle).
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

NODE_MAJOR=20

echo "== Maelle VM setup — repo: $(pwd) =="
if [ ! -f package.json ] || [ ! -d src ]; then
  echo "ABORT: run this from the Maelle repo root (package.json + src/ not found)."; exit 1
fi

echo "== 1. System packages (Node ${NODE_MAJOR}, git, build tools for better-sqlite3, sqlite3) =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y git build-essential python3 sqlite3

echo "== 2. PM2 (global) =="
command -v pm2 >/dev/null 2>&1 || sudo npm install -g pm2

echo "== 3. Install deps + build (compiles the better-sqlite3 native addon) =="
npm ci
npm run build

echo
echo "== Setup done.  Node $(node -v) | pm2 $(pm2 -v) =="
[ -f .env ]                    || echo "⚠️  .env missing — add it before starting (see runbook header)."
[ -f config/users/idan.yaml ]  || echo "⚠️  config/users/idan.yaml missing — add it + migrate the DB (runbook step 2)."
echo "Next: runbook steps 1–4 in this file's header (config, migrate, pm2 start)."
