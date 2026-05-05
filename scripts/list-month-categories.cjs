#!/usr/bin/env node
/**
 * One-shot — list all events in a given month with their current categories.
 *
 * Read-only. Output is a tab-separated table sorted by date. Owner reviews
 * the output and recategorizes via chat with Maelle ("set category=Interview
 * for events on May 3 14:00 with Lori"). Maelle uses the standard
 * `update_meeting` tool — no parallel script-driven Graph writes.
 *
 * The point: surface what's currently tagged how, so the owner can identify
 * misclassified or uncategorized events after rolling out new category rules.
 * Companion to v2.6 category scheduling rules.
 *
 * Usage:
 *   node scripts/list-month-categories.cjs YYYY-MM           # any month
 *   node scripts/list-month-categories.cjs                   # current month
 *
 * Notes:
 *   - Reads the SQLite events table populated by Maelle's calendar sync.
 *     Run after a fresh brief or calendar-health pass to make sure data is
 *     current. Or call `get_calendar` for the month via chat first.
 *   - Filters out cancelled events and all-day blocks.
 */

const path = require('path');
const Database = require('better-sqlite3');

const argMonth = process.argv[2];
const targetMonth = argMonth || new Date().toISOString().slice(0, 7);  // YYYY-MM
if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
  console.error(`Usage: node scripts/list-month-categories.cjs [YYYY-MM]`);
  console.error(`Got: "${targetMonth}"`);
  process.exit(1);
}

const monthStart = `${targetMonth}-01T00:00:00`;
const [yearStr, monthStr] = targetMonth.split('-');
const year = Number(yearStr);
const month = Number(monthStr);
const nextMonth = month === 12 ? `${year + 1}-01-01T00:00:00` : `${year}-${String(month + 1).padStart(2, '0')}-01T00:00:00`;

const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, 'data', 'maelle.db');
const db = new Database(dbPath, { readonly: true });

// Events table has start, end, subject, categories (JSON), is_cancelled, etc.
// Layout subject to small drift between versions; we read a generic shape.
const rows = db.prepare(`
  SELECT id, owner_user_id, subject, start_iso, end_iso, categories, is_all_day, is_cancelled
  FROM events
  WHERE start_iso >= ?
    AND start_iso < ?
  ORDER BY owner_user_id, start_iso
`).all(monthStart, nextMonth);

console.log(`\n${'='.repeat(80)}`);
console.log(`Month: ${targetMonth}  ·  events found: ${rows.length}`);
console.log(`${'='.repeat(80)}`);
console.log(`# | OWNER | DATE       | TIME  | CATEGORY        | SUBJECT`);
console.log(`-`.repeat(80));

let n = 0;
let uncategorized = 0;
const byCategory = new Map();
for (const r of rows) {
  if (r.is_cancelled) continue;
  if (r.is_all_day) continue;
  n++;
  const dt = r.start_iso?.slice(0, 16).replace('T', ' ') ?? '?';
  const date = dt.slice(0, 10);
  const time = dt.slice(11);
  let cats = [];
  try { cats = JSON.parse(r.categories ?? '[]'); } catch { cats = []; }
  const catStr = cats.length === 0 ? '(none)' : cats.join(', ');
  if (cats.length === 0) uncategorized++;
  for (const c of cats.length > 0 ? cats : ['(none)']) {
    byCategory.set(c, (byCategory.get(c) ?? 0) + 1);
  }
  console.log(`${String(n).padStart(3)} | ${r.owner_user_id.slice(0, 9).padEnd(9)} | ${date} | ${time} | ${catStr.padEnd(15).slice(0, 15)} | ${(r.subject ?? '').slice(0, 60)}`);
}

console.log(`\n${'='.repeat(80)}`);
console.log(`Summary  ·  total: ${n}  ·  uncategorized: ${uncategorized}`);
console.log(`Distribution:`);
const sorted = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
for (const [cat, count] of sorted) {
  console.log(`  ${count.toString().padStart(4)} ${cat}`);
}
console.log(`${'='.repeat(80)}`);
console.log(`\nNext step: review the uncategorized + misclassified rows, then ask Maelle in chat to recategorize them via update_meeting. She knows the new category rules from the prompt.`);
