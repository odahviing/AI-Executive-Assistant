#!/usr/bin/env node
/**
 * Deploy watcher — polls origin/master every 5 minutes and pulls + rebuilds +
 * restarts Maelle under PM2 when a new auto-triage commit lands.
 *
 * v1.8.2. Runs on the laptop under PM2 as the `maelle-deploy-watcher` process.
 *
 * Gate: only deploys when the new commits are authored by "Maelle Auto-Triage".
 * User-authored commits are skipped — the owner handles his own deploys by
 * running `npm run build && pm2 restart maelle` locally when he's ready.
 *
 * Flow every tick:
 *   1. `git fetch origin master` (silent)
 *   2. Compare origin/master SHA vs HEAD
 *   3. If different:
 *      a. List new commits' authors
 *      b. If ANY are "Maelle Auto-Triage" → pull, build, restart
 *      c. Otherwise skip (owner's own commits, not our job)
 *   4. Log everything
 *
 * Safety:
 *   - Never force-pulls or resets — uses plain `git pull`
 *   - If build fails, does NOT restart (keeps existing running maelle alive)
 *   - Single-instance: PM2 ensures only one watcher runs
 */

import { execSync, spawnSync } from 'node:child_process';

const REPO_DIR      = process.cwd();
const POLL_SECONDS  = parseInt(process.env.DEPLOY_POLL_SECONDS || '300', 10); // 5 min default
const AUTO_AUTHOR   = 'Maelle Auto-Triage';
const PM2_APP_NAME  = process.env.PM2_APP_NAME || 'maelle';

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function shOrNull(cmd) {
  try { return sh(cmd); } catch { return null; }
}

function runVerbose(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: REPO_DIR, encoding: 'utf8', stdio: 'inherit' });
  return r.status === 0;
}

async function tick() {
  // 1. Fetch
  const fetched = shOrNull('git fetch origin master');
  if (fetched === null) {
    log('git fetch failed — skipping this tick');
    return;
  }

  // 2. Compare SHAs
  const localSha  = sh('git rev-parse HEAD');
  const remoteSha = sh('git rev-parse origin/master');
  if (localSha === remoteSha) {
    return; // nothing to do, quiet tick
  }

  log(`New commits on origin: ${localSha.slice(0, 7)} → ${remoteSha.slice(0, 7)}`);

  // 3. Check authors of the new commits
  const authors = sh(`git log ${localSha}..${remoteSha} --pretty=format:%an`).split('\n').filter(Boolean);
  const hasAutoCommit = authors.some(a => a.includes(AUTO_AUTHOR));

  if (!hasAutoCommit) {
    log(`Skipping — no "${AUTO_AUTHOR}" commits in new range (authors: ${authors.join(', ')})`);
    return;
  }

  log(`Auto-triage commits detected. Pulling + rebuilding + restarting.`);

  // 4a. Pull
  if (!runVerbose('git', ['pull', '--ff-only', 'origin', 'master'])) {
    log('git pull failed — aborting deploy');
    return;
  }

  // 4b. Install (if package-lock changed) + build
  const pkgChanged = shOrNull(`git diff --name-only ${localSha} ${remoteSha}`)?.split('\n').some(f => f === 'package.json' || f === 'package-lock.json');
  if (pkgChanged) {
    log('package.json or lockfile changed — running npm ci');
    if (!runVerbose('npm', ['ci'])) {
      log('npm ci failed — aborting deploy (keeping current Maelle running)');
      return;
    }
  }

  log('Running npm run build...');
  if (!runVerbose('npm', ['run', 'build'])) {
    log('Build failed — aborting deploy (keeping current Maelle running)');
    return;
  }

  // 4c. Restart PM2
  log(`Restarting PM2 process "${PM2_APP_NAME}"...`);
  if (!runVerbose('pm2', ['restart', PM2_APP_NAME])) {
    log(`pm2 restart ${PM2_APP_NAME} failed — manual intervention needed`);
    return;
  }

  log('Deploy complete.');
}

// ── Main loop ────────────────────────────────────────────────────────────────

log(`Deploy watcher starting. Polling every ${POLL_SECONDS}s. Auto-author filter: "${AUTO_AUTHOR}". Repo: ${REPO_DIR}`);

// Run once immediately, then on interval
await tick();
setInterval(() => { tick().catch(err => log(`Tick error: ${String(err)}`)); }, POLL_SECONDS * 1000);
