#!/usr/bin/env node
/**
 * Diagnose duplicate routine fires — find cases where the same routine
 * produced two materialized task rows (cron race / multi-time schedule
 * collision / startup catch-up overlap with regular fire).
 *
 * Usage:
 *   node scripts/diagnose-duplicate-routine-fires.cjs [options]
 *
 * Options:
 *   --hours=N        Look back N hours for tasks (default 48).
 *   --window=N       Treat tasks within N minutes as "near-duplicate" candidates (default 30).
 *   --routine=STR    Filter to routines whose title contains STR (case-insensitive).
 *
 * Output (read-only):
 *   - Grouped list of routine fires by routine_id with their task rows.
 *   - Flag pairs within --window minutes as suspect duplicates.
 *   - Sibling sweep: tasks created in the same minute regardless of routine.
 *   - Active routines snapshot showing schedule_time + next_run_at.
 *
 * No mutations. Safe to run anytime.
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const flags = {};
for (const a of argv) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) flags[m[1]] = m[2] ?? true;
}
const HOURS = Number(flags.hours ?? 48);
const WINDOW_MIN = Number(flags.window ?? 30);
const ROUTINE_FILTER = typeof flags.routine === 'string' ? flags.routine.toLowerCase() : null;

const DB_PATH = process.env.MAELLE_DB_PATH ?? path.resolve(__dirname, '..', 'data', 'maelle.db');
const db = new Database(DB_PATH, { readonly: true });

const cutoffIso = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();

console.log(`\n== Routine-fire diagnostic (last ${HOURS}h, near-dup window ${WINDOW_MIN}min${ROUTINE_FILTER ? `, routine~"${ROUTINE_FILTER}"` : ''}) ==\n`);

// ── Active routines snapshot ────────────────────────────────────────────────
const routines = db.prepare(`
  SELECT id, title, schedule_type, schedule_time, schedule_day, is_system,
         status, last_run_at, last_result, next_run_at, run_count
  FROM routines
  WHERE status = 'active'
  ORDER BY title
`).all().filter(r => !ROUTINE_FILTER || (r.title ?? '').toLowerCase().includes(ROUTINE_FILTER));

console.log(`Active routines: ${routines.length}`);
for (const r of routines) {
  console.log(`  - ${r.id}  "${r.title}"  ${r.is_system ? '[system] ' : ''}schedule=${r.schedule_time}  next=${r.next_run_at}  last=${r.last_run_at ?? '-'}  runs=${r.run_count}`);
  if (r.last_result) console.log(`      last_result: ${(r.last_result ?? '').slice(0, 80)}`);
}

// ── Materialized routine tasks ──────────────────────────────────────────────
const tasks = db.prepare(`
  SELECT t.id, t.routine_id, t.created_at, t.due_at, t.completed_at, t.status,
         t.context, r.title AS routine_title, r.schedule_time
  FROM tasks t
  LEFT JOIN routines r ON r.id = t.routine_id
  WHERE t.type = 'routine'
    AND t.created_at >= ?
  ORDER BY t.routine_id, t.created_at
`).all(cutoffIso).filter(t => !ROUTINE_FILTER || (t.routine_title ?? '').toLowerCase().includes(ROUTINE_FILTER));

console.log(`\nMaterialized routine tasks (last ${HOURS}h): ${tasks.length}`);

// Group by routine_id, look for near-duplicates within WINDOW_MIN minutes.
const byRoutine = new Map();
for (const t of tasks) {
  const arr = byRoutine.get(t.routine_id) ?? [];
  arr.push(t);
  byRoutine.set(t.routine_id, arr);
}

const suspectPairs = [];
for (const [routineId, arr] of byRoutine) {
  arr.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  console.log(`\n  routine "${arr[0].routine_title ?? '?'}" (${routineId}) — ${arr.length} fire${arr.length === 1 ? '' : 's'}:`);
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i];
    console.log(`    [${i + 1}] ${t.id}  created=${t.created_at}  due=${t.due_at ?? '-'}  status=${t.status}  completed=${t.completed_at ?? '-'}`);
    if (i > 0) {
      const prev = arr[i - 1];
      const deltaMin = (Date.parse(t.created_at) - Date.parse(prev.created_at)) / 60000;
      if (deltaMin <= WINDOW_MIN) {
        console.log(`        ⚠ within ${Math.round(deltaMin * 10) / 10}min of [${i}] — SUSPECT DUPLICATE`);
        suspectPairs.push({
          routineTitle: t.routine_title ?? '?',
          routineId,
          taskA: prev.id, taskB: t.id,
          deltaMin: Math.round(deltaMin * 10) / 10,
          createdA: prev.created_at, createdB: t.created_at,
        });
      }
    }
  }
}

// ── Cross-routine same-minute sweep ────────────────────────────────────────
const groupedByMinute = new Map();
for (const t of tasks) {
  const minuteKey = t.created_at.slice(0, 16);  // YYYY-MM-DDTHH:MM
  const arr = groupedByMinute.get(minuteKey) ?? [];
  arr.push(t);
  groupedByMinute.set(minuteKey, arr);
}
const sameMinuteClusters = [...groupedByMinute.entries()]
  .filter(([, arr]) => arr.length > 1);

if (sameMinuteClusters.length > 0) {
  console.log(`\nSame-minute clusters (≥2 routine tasks in same minute):`);
  for (const [minute, arr] of sameMinuteClusters) {
    console.log(`  ${minute}:`);
    for (const t of arr) {
      console.log(`    - ${t.routine_title ?? '?'} (${t.routine_id})  task ${t.id}  status=${t.status}`);
    }
  }
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n== Summary ==`);
console.log(`Suspect within-routine duplicates: ${suspectPairs.length}`);
for (const p of suspectPairs) {
  console.log(`  - "${p.routineTitle}" — task ${p.taskA} → ${p.taskB} (${p.deltaMin}min apart at ${p.createdB})`);
}
console.log(`Cross-routine same-minute clusters: ${sameMinuteClusters.length}`);
console.log(`\n(Read-only — no mutations.)\n`);
