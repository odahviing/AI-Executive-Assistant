#!/usr/bin/env node
/**
 * One-shot cleanup — mark stale calendar_dismissed_issues rows as resolved.
 *
 * Background: pre-v2.4.2 the cascade in closeMeetingArtifacts didn't include
 * calendar_dismissed_issues, AND the table didn't even have an event_ids
 * column to enable the cascade (eventIds passed to upsertCalendarIssue were
 * silently dropped). Result: issue rows accumulated for weeks at status='new'
 * after their source meetings had been moved/recategorized — and the table
 * surfaced them in every active-mode health check as "carry-over from last
 * week" / "still open issues" (the brief in 2026-05-03 narrated 38 of them).
 *
 * v2.4.2 ships the column + cascade for forward-going rows. This script
 * cleans the historical backlog by marking every row whose event_date is in
 * the past (the issue can't possibly still apply — the date has come and
 * gone) as 'resolved' with a note explaining the cleanup.
 *
 * Idempotent: re-running on already-resolved rows is a no-op.
 *
 * Usage:
 *   node scripts/cleanup-stale-calendar-issues.cjs           # dry-run (default)
 *   node scripts/cleanup-stale-calendar-issues.cjs --commit  # actually resolve
 */

const path = require('path');
const Database = require('better-sqlite3');

const COMMIT = process.argv.includes('--commit');
const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, 'data', 'maelle.db');

const db = new Database(dbPath);

const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD UTC — close enough for a date filter

console.log(`\n${'='.repeat(72)}`);
console.log(`calendar_dismissed_issues stale-cleanup  (${COMMIT ? 'COMMIT' : 'DRY RUN'})`);
console.log(`${'='.repeat(72)}`);
console.log(`Today (UTC): ${today}`);
console.log(`Targeting rows with event_date < ${today} AND resolution IN ('new','to_resolve')\n`);

const candidates = db.prepare(`
  SELECT id, owner_user_id, event_date, issue_type, SUBSTR(detail, 1, 80) as detail_preview, resolution
  FROM calendar_dismissed_issues
  WHERE event_date < ?
    AND resolution IN ('new', 'to_resolve')
  ORDER BY event_date ASC
`).all(today);

if (candidates.length === 0) {
  console.log(`No stale rows found. Nothing to do.`);
  process.exit(0);
}

console.log(`Found ${candidates.length} stale row${candidates.length === 1 ? '' : 's'}:\n`);
const byOwner = new Map();
for (const row of candidates) {
  if (!byOwner.has(row.owner_user_id)) byOwner.set(row.owner_user_id, []);
  byOwner.get(row.owner_user_id).push(row);
}
for (const [owner, rows] of byOwner) {
  console.log(`  owner=${owner}: ${rows.length} row${rows.length === 1 ? '' : 's'}`);
  for (const row of rows.slice(0, 5)) {
    console.log(`    - ${row.event_date} [${row.issue_type}] ${row.detail_preview}`);
  }
  if (rows.length > 5) console.log(`    ... and ${rows.length - 5} more`);
}

if (!COMMIT) {
  console.log(`\nNothing was modified. Re-run with --commit to resolve these rows.`);
  process.exit(0);
}

const result = db.prepare(`
  UPDATE calendar_dismissed_issues
  SET resolution = 'resolved',
      resolution_notes = COALESCE(resolution_notes, 'auto-resolved by v2.4.2 cleanup — event_date was in the past')
  WHERE event_date < ?
    AND resolution IN ('new', 'to_resolve')
`).run(today);

console.log(`\n✅ Resolved ${result.changes} stale row${result.changes === 1 ? '' : 's'}.`);
