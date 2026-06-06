#!/usr/bin/env node
/**
 * One-time cleanup (v3.2.6): dormant-ize social_subjects that are actually
 * WORK content mis-filed as social (the bug #1 pollution — "Idan call
 * scheduling" under `partner`, "Ido interview" under `learning`, "Brainrocket
 * POC" under `side_projects`, etc.). The capture-pass classifier now refuses
 * to create these, but rows created before the fix linger and keep qualifying
 * people for social codas / surfacing as `continue` topics.
 *
 * SAFE: dry-run by default (readonly). Flags ACTIVE subjects whose label
 * matches a work pattern. Sets them status='dormant' (reversible — not a
 * delete) ONLY with --apply. Review the dry-run list first.
 *
 *   node scripts/clean-work-subjects.cjs            # dry-run (list only)
 *   node scripts/clean-work-subjects.cjs --apply    # dormant-ize the matches
 *   node scripts/clean-work-subjects.cjs --ids a,b  # dormant-ize specific IDs
 *                                                     (residuals keyword-match misses:
 *                                                      bare names, work labels w/o a keyword)
 */

const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const idsArg = process.argv.find(a => a.startsWith('--ids='))
  ?? (process.argv.includes('--ids') ? process.argv[process.argv.indexOf('--ids') + 1] : null);
const EXPLICIT_IDS = idsArg ? idsArg.replace(/^--ids=/, '').split(',').map(s => s.trim()).filter(Boolean) : [];
const DB_PATH = path.resolve(__dirname, '..', 'data', 'maelle.db');

// Explicit-ID mode: dormant-ize exactly the listed subject IDs (write mode).
if (EXPLICIT_IDS.length > 0) {
  const db = new Database(DB_PATH, { readonly: false, fileMustExist: true });
  try {
    const sel = db.prepare(`SELECT id, label, category_id, status FROM social_subjects WHERE id = ?`);
    const upd = db.prepare(`UPDATE social_subjects SET status='dormant', updated_at=datetime('now') WHERE id = ?`);
    for (const id of EXPLICIT_IDS) {
      const row = sel.get(id);
      if (!row) { process.stdout.write(`  [skip] ${id} — not found\n`); continue; }
      upd.run(id);
      process.stdout.write(`  [dormant] "${row.label}" (${id}) — was ${row.status}\n`);
    }
  } finally {
    db.close();
  }
  return;
}

// Word-ish work signals. Case-insensitive. Kept conservative — these are
// unambiguously job-not-hobby. Review the dry-run output before --apply.
const WORK_PATTERNS = [
  /\bschedul/i, /\bcall\b/i, /\bsync\b/i, /\bmeeting/i, /\binterview/i,
  /\bcandidate/i, /\bpoc\b/i, /\bdeadline/i, /\blaunch/i, /\bdeliverable/i,
  /\bstandup\b/i, /\bonboard/i, /\bhiring\b/i, /\b1:1\b/i, /\bsprint\b/i,
  /social media post/i, /\bproject\b/i, /\bticket/i, /\bbug\b/i, /\brelease\b/i,
];

const db = new Database(DB_PATH, { readonly: !APPLY, fileMustExist: true });
try {
  const rows = db.prepare(`
    SELECT s.id, s.label, s.category_id, s.engagement_score, s.person_slack_id,
           p.name AS person_name
    FROM social_subjects s
    LEFT JOIN people_memory p ON p.slack_id = s.person_slack_id
    WHERE s.status = 'active'
    ORDER BY s.last_touched_at DESC
  `).all();

  const flagged = rows.filter(r => WORK_PATTERNS.some(re => re.test(r.label || '')));

  process.stdout.write(`\nActive subjects: ${rows.length} | flagged as work: ${flagged.length}\n\n`);
  for (const r of flagged) {
    const cat = (r.category_id || '').replace(/^cat_(global_|[^_]+_)/, '');
    process.stdout.write(`  [WORK] "${r.label}"  (${r.person_name || r.person_slack_id}, category=${cat}, score=${r.engagement_score})\n`);
  }
  process.stdout.write('\n');

  if (!APPLY) {
    process.stdout.write('Dry-run. Re-run with --apply to set these to dormant (reversible).\n');
  } else {
    const upd = db.prepare(`UPDATE social_subjects SET status='dormant', updated_at=datetime('now') WHERE id = ?`);
    const txn = db.transaction((items) => { for (const r of items) upd.run(r.id); });
    txn(flagged);
    process.stdout.write(`Applied: ${flagged.length} subject(s) set to dormant.\n`);
  }
} finally {
  db.close();
}
