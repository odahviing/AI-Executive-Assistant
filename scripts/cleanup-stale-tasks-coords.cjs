#!/usr/bin/env node
/**
 * One-shot cleanup — sweep stale open tasks / coord_jobs / outreach_jobs.
 *
 * Background: pre-v2.4.2 RULE 2d ("close the loop when owner handles it
 * himself") was the only mechanism for closing items the owner said are
 * done in chat. Sonnet drops the cancel_task/cancel_coordination call ~50%
 * of the time, so rows accumulate at status='pending_*' / 'sent' / etc.
 * for weeks past their useful life. Owner sees the same dead items
 * resurface in every brief ("Amazia coord still pending — 2 weeks ago").
 *
 * v2.4.2 ships closeLoopOnOwnerHandled (deterministic Sonnet pass after
 * every owner turn) which catches this forward-going. This script cleans
 * the historical backlog.
 *
 * Conservative criteria — only target items unambiguously stale:
 *   - tasks (type IN follow_up/reminder/research): updated_at older than
 *     STALE_DAYS, status still active. Owner-typed reminders that should
 *     have been resolved long ago.
 *   - coord_jobs: created_at older than STALE_DAYS AND winning_slot is
 *     in the past OR there's no winning_slot at all (collecting/resolving
 *     a meeting from weeks ago = abandoned). Status not in terminal
 *     (booked/cancelled/abandoned).
 *   - outreach_jobs: status='no_response' AND updated_at older than
 *     STALE_DAYS. The colleague never replied; carrying it forever
 *     doesn't change that.
 *
 * Idempotent — re-runnable.
 *
 * Usage:
 *   node scripts/cleanup-stale-tasks-coords.cjs           # dry-run (default)
 *   node scripts/cleanup-stale-tasks-coords.cjs --commit  # actually cancel
 *   node scripts/cleanup-stale-tasks-coords.cjs --days 14 # adjust threshold
 */

const path = require('path');
const Database = require('better-sqlite3');

const COMMIT = process.argv.includes('--commit');
const daysArgIdx = process.argv.findIndex(a => a === '--days');
const STALE_DAYS = daysArgIdx >= 0 && process.argv[daysArgIdx + 1]
  ? Number(process.argv[daysArgIdx + 1])
  : 14;

const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, 'data', 'maelle.db');
const db = new Database(dbPath);

const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
const today = new Date().toISOString().slice(0, 10);

console.log(`\n${'='.repeat(72)}`);
console.log(`stale tasks/coords/outreach cleanup  (${COMMIT ? 'COMMIT' : 'DRY RUN'})`);
console.log(`${'='.repeat(72)}`);
console.log(`Stale threshold: ${STALE_DAYS} days (cutoff ${cutoff.slice(0, 10)})\n`);

// ── Tasks ────────────────────────────────────────────────────────────────────
const staleTasks = db.prepare(`
  SELECT id, type, title, status, updated_at, target_name
  FROM tasks
  WHERE status IN ('new', 'in_progress', 'pending_owner', 'pending_colleague')
    AND type IN ('follow_up', 'reminder', 'research')
    AND updated_at < ?
  ORDER BY updated_at ASC
`).all(cutoff);

console.log(`\n── Stale TASKS (follow_up/reminder/research, no activity ${STALE_DAYS}+ days): ${staleTasks.length} ──`);
for (const t of staleTasks) {
  console.log(`  - ${t.id} [${t.type}/${t.status}] "${t.title.slice(0, 60)}"  (last touched ${t.updated_at.slice(0, 10)}${t.target_name ? `, re ${t.target_name}` : ''})`);
}

// ── Coord jobs ───────────────────────────────────────────────────────────────
const staleCoords = db.prepare(`
  SELECT id, subject, status, winning_slot, created_at, updated_at, participants
  FROM coord_jobs
  WHERE status NOT IN ('booked', 'cancelled', 'abandoned')
    AND created_at < ?
`).all(cutoff);

const staleCoordRows = [];
for (const c of staleCoords) {
  let collName = '';
  try {
    const parts = JSON.parse(c.participants || '[]');
    const names = parts.filter(p => !p.just_invite).map(p => p.name).filter(Boolean);
    if (names.length > 0) collName = ` re ${names.join(', ')}`;
  } catch {}
  // If winning_slot is set and in the future → not stale (still scheduled).
  const winningSlot = c.winning_slot ? new Date(c.winning_slot) : null;
  const inFuture = winningSlot && winningSlot.getTime() > Date.now();
  if (inFuture) continue;
  staleCoordRows.push({ ...c, collName });
}

console.log(`\n── Stale COORD JOBS (active status, created ${STALE_DAYS}+ days ago, no future winning_slot): ${staleCoordRows.length} ──`);
for (const c of staleCoordRows) {
  const slotInfo = c.winning_slot ? `, winning_slot=${c.winning_slot.slice(0, 10)}(past)` : ', no winning_slot';
  console.log(`  - ${c.id} [${c.status}] "${(c.subject ?? '').slice(0, 60)}"${c.collName}  (created ${c.created_at.slice(0, 10)}${slotInfo})`);
}

// ── Outreach jobs ────────────────────────────────────────────────────────────
const staleOutreach = db.prepare(`
  SELECT id, colleague_name, status, intent, updated_at, message
  FROM outreach_jobs
  WHERE status = 'no_response'
    AND updated_at < ?
  ORDER BY updated_at ASC
`).all(cutoff);

console.log(`\n── Stale OUTREACH (status=no_response, ${STALE_DAYS}+ days unchanged): ${staleOutreach.length} ──`);
for (const o of staleOutreach) {
  console.log(`  - ${o.id} → ${o.colleague_name}${o.intent ? ` (${o.intent})` : ''}  "${(o.message ?? '').slice(0, 50)}"  (last ${o.updated_at.slice(0, 10)})`);
}

const totalToClose = staleTasks.length + staleCoordRows.length + staleOutreach.length;

console.log(`\n${'='.repeat(72)}`);
console.log(`Summary: ${totalToClose} item${totalToClose === 1 ? '' : 's'} to close`);
console.log(`  tasks:       ${staleTasks.length}`);
console.log(`  coords:      ${staleCoordRows.length}`);
console.log(`  outreach:    ${staleOutreach.length}`);
console.log(`${'='.repeat(72)}`);

if (!COMMIT) {
  console.log(`\nNothing modified. Re-run with --commit to apply.`);
  process.exit(0);
}

if (totalToClose === 0) {
  console.log(`\nNothing to close.`);
  process.exit(0);
}

const cancelTaskStmt = db.prepare(`
  UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
  WHERE id = ?
`);
const cancelCoordStmt = db.prepare(`
  UPDATE coord_jobs SET status = 'abandoned', updated_at = datetime('now')
  WHERE id = ?
`);
const closeOutreachStmt = db.prepare(`
  UPDATE outreach_jobs SET status = 'done', updated_at = datetime('now')
  WHERE id = ?
`);

const tx = db.transaction(() => {
  for (const t of staleTasks) cancelTaskStmt.run(t.id);
  for (const c of staleCoordRows) cancelCoordStmt.run(c.id);
  for (const o of staleOutreach) closeOutreachStmt.run(o.id);
});
tx();

console.log(`\n✅ Closed ${totalToClose} stale items (cancelled / abandoned / done as appropriate).`);
console.log(`   Re-run any time — script is idempotent.`);
