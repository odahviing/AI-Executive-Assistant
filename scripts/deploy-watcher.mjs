#!/usr/bin/env node
/**
 * deploy-watcher — VM auto-deploy on new commits (poll-based, outbound-only).
 *
 * Runs as its own PM2 app (see ecosystem.config.js). Every DEPLOY_POLL_SECONDS it
 * fetches origin/<branch>; when the branch is ahead of the local checkout it
 * pulls, type-checks, builds, and restarts the `maelle` process. Poll-based (not
 * a webhook) so it needs NO inbound port — consistent with Maelle being
 * outbound-only.
 *
 * Safety guards (this deploys to a LIVE assistant):
 *   • typecheck GATE — if `npm run typecheck` fails, the deploy aborts BEFORE
 *     touching dist/ or restarting. Maelle keeps running the previous build.
 *   • restart only on a clean build — a failed build never takes Maelle down.
 *   • `git pull --ff-only` — never merges/forces; the VM checkout must stay clean
 *     (all changes arrive as commits, never local edits).
 *   • single-flight — overlapping ticks can't stack deploys.
 *   • never crashes the watcher — any error is logged; the poller keeps running.
 *
 * NOTE: uses `pm2 restart` (kill-then-respawn, no overlap), NEVER `pm2 reload`
 * (which would run two processes briefly = two Slack sockets = the
 * `too_many_connections` fight). Do not change this to reload.
 */
import { execSync } from 'node:child_process';

const REPO = process.cwd(); // PM2 runs with cwd = repo root (ecosystem `cwd`)
const BRANCH = process.env.DEPLOY_BRANCH || 'master';
const POLL_MS = Math.max(30, Number(process.env.DEPLOY_POLL_SECONDS || 120)) * 1000;

let deploying = false;

function sh(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}
function run(cmd) { sh(cmd, { stdio: ['ignore', 'inherit', 'inherit'] }); }
function log(msg, extra) { console.log(`[deploy-watcher] ${msg}${extra ? ' — ' + extra : ''}`); }

function tick() {
  if (deploying) return;

  try {
    sh(`git fetch --quiet origin ${BRANCH}`, { timeout: 60 * 1000 });
  } catch (e) {
    log('git fetch failed (transient) — skipping this tick', String(e?.message || e).slice(0, 120));
    return;
  }

  let local, remote;
  try {
    local = sh(`git rev-parse HEAD`).trim();
    remote = sh(`git rev-parse origin/${BRANCH}`).trim();
  } catch (e) {
    log('rev-parse failed — skipping', String(e?.message || e).slice(0, 120));
    return;
  }
  if (local === remote) return; // already up to date

  deploying = true;
  try {
    log('new commits detected', `${local.slice(0, 7)} → ${remote.slice(0, 7)}`);

    // Decide whether deps need reinstalling BEFORE pulling (diff old→new).
    // Only the LOCKFILE signals a real dependency change — a bare version bump
    // touches package.json alone and must NOT trigger a reinstall.
    let depsChanged = false;
    try {
      const changed = sh(`git diff --name-only HEAD origin/${BRANCH}`).split('\n');
      depsChanged = changed.includes('package-lock.json');
    } catch { /* fall through — treat as no dep change */ }

    run(`git pull --ff-only origin ${BRANCH}`);

    if (depsChanged) {
      log('dependencies changed — running npm ci (dev deps included, Chromium skipped)');
      // --include=dev: this watcher runs with NODE_ENV=production (ecosystem.config.js),
      //   under which `npm ci` OMITS devDependencies — but the very next steps
      //   (typecheck + build) need typescript + @types/*, so force them in.
      // PUPPETEER_SKIP_*: WhatsApp/puppeteer is off and the Chromium download fails
      //   on this small VM boot disk; without skipping it, `npm ci` aborts.
      sh('npm ci --include=dev', {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true', PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true' },
      });
    }

    // Typecheck GATE — abort the deploy on a bad build; leave dist/ + the running
    // process untouched so Maelle stays up on the last-good build.
    try {
      run(`npm run typecheck`);
    } catch {
      log('TYPECHECK FAILED — deploy aborted, Maelle stays on the previous build');
      return;
    }

    run(`npm run build`);
    run(`pm2 restart maelle --update-env`);
    log('deployed + restarted maelle', `now at ${sh(`git rev-parse --short HEAD`).trim()}`);
  } catch (e) {
    log('DEPLOY FAILED — Maelle left running on the previous build', String(e?.message || e).slice(0, 200));
  } finally {
    deploying = false;
  }
}

log(`watching origin/${BRANCH} every ${POLL_MS / 1000}s`, `repo ${REPO}`);
tick();
setInterval(tick, POLL_MS);
