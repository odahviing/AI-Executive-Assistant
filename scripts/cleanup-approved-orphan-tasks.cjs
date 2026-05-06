#!/usr/bin/env node
/**
 * One-shot cleanup — close parent tasks of already-approved approvals.
 *
 * Background: pre-this-fix, `resolveGenericApprove` (handles policy_exception,
 * lunch_bump, freeform, duration_override, unknown_person) only updated the
 * approvals row to status='approved' and never touched the parent tasks row.
 * The parent task auto-created at `create_approval(kind=...)` time stayed
 * forever at status='new', so the brief surfaced it every morning even
 * though the owner had already approved (and usually the downstream booking
 * had already happened too).
 *
 * Forward-going approvals get the parent-task close baked into the resolver.
 * This script handles the historical backlog — approvals that were approved
 * BEFORE the fix landed and whose parent tasks are still open.
 *
 * Idempotent: re-running on already-completed tasks is a no-op (filter by
 * task.status IN ('new', 'pending_owner')).
 *
 * Usage:
 *   node scripts/cleanup-approved-orphan-tasks.cjs           # dry-run (default)
 *   node scripts/cleanup-approved-orphan-tasks.cjs --commit  # actually close
 */

const path = require('path');
const Database = require('better-sqlite3');

const COMMIT = process.argv.includes('--commit');
const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, 'data', 'maelle.db');
const db = new Database(dbPath);

console.log(`\n${'='.repeat(72)}`);
console.log(`Approved-orphan-tasks cleanup  (${COMMIT ? 'COMMIT' : 'DRY RUN'})`);
console.log(`${'='.repeat(72)}\n`);

const candidates = db.prepare(`
  SELECT t.id           AS task_id,
         t.title        AS task_title,
         t.status       AS task_status,
         t.created_at   AS task_created,
         a.id           AS approval_id,
         a.kind         AS approval_kind,
         a.status       AS approval_status,
         a.responded_at AS approval_responded_at
  FROM tasks t
  JOIN approvals a ON a.task_id = t.id
  WHERE a.status = 'approved'
    AND t.status IN ('new', 'pending_owner', 'in_progress', 'pending_colleague')
    AND t.type = 'follow_up'
  ORDER BY a.responded_at DESC
`).all();

if (candidates.length === 0) {
  console.log('No orphan tasks found — every approved approval has a closed parent task. Nothing to do.\n');
  process.exit(0);
}

console.log(`Found ${candidates.length} orphan task${candidates.length === 1 ? '' : 's'}:\n`);
for (const row of candidates) {
  console.log(`  task ${row.task_id}`);
  console.log(`    title:        ${row.task_title}`);
  console.log(`    task status:  ${row.task_status}  (created ${row.task_created})`);
  console.log(`    approval:     ${row.approval_id}  kind=${row.approval_kind}  status=${row.approval_status}  decided=${row.approval_responded_at}`);
  console.log('');
}

if (!COMMIT) {
  console.log(`${'-'.repeat(72)}`);
  console.log(`DRY RUN — no changes applied. Re-run with --commit to close these.\n`);
  process.exit(0);
}

console.log(`${'-'.repeat(72)}`);
console.log(`Closing ${candidates.length} task${candidates.length === 1 ? '' : 's'}...\n`);

const update = db.prepare(`
  UPDATE tasks
  SET status = 'completed',
      completed_at = COALESCE(completed_at, datetime('now')),
      updated_at = datetime('now')
  WHERE id = ?
`);

const tx = db.transaction((rows) => {
  let changed = 0;
  for (const r of rows) {
    const res = update.run(r.task_id);
    changed += res.changes;
  }
  return changed;
});

const closed = tx(candidates);
console.log(`Closed ${closed} task${closed === 1 ? '' : 's'} (status='completed').`);
console.log(`The next brief will surface them once with closure language, then markTaskInformed will flip them to 'informed' and they'll drop.\n`);
