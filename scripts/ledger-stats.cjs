#!/usr/bin/env node
/**
 * ledger-stats — read `.claude/agent-loop/ledger.jsonl` and report whether the
 * charters are actually working.
 *
 * The report file is emptied at every wrap, so it cannot answer "has this lane
 * ever pushed back?". The ledger can: it is append-only, one line per dispatch.
 * This script is its reader.
 *
 * What it measures, and why the ratio is the point rather than the count:
 *   • A lane that returns `built` for everything is not obeying a charter, it is
 *     just building. Charters exist to produce refusals — `blocked-charter`,
 *     `needs-owner-decision`, `needs-dependency`. A pushback rate of ZERO is the
 *     signal, not a clean bill of health.
 *   • A CLIMBING `blocked-charter` rate is a lane telling you a rule has gone
 *     wrong. That is an M6 architectural signal, not a lane misbehaving.
 *   • `needs-dependency` is the seam map: which lanes keep reaching across tells
 *     you where the ownership boundary is drawn in the wrong place.
 *
 * Read-only. Never writes.
 *
 * Usage:
 *   node scripts/ledger-stats.cjs                 # all history
 *   node scripts/ledger-stats.cjs --since 2026-07-01
 *   node scripts/ledger-stats.cjs --lane meeting  # one lane, with its findings
 *   node scripts/ledger-stats.cjs --runs          # per-run summary
 */

const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, '..', '.claude', 'agent-loop', 'ledger.jsonl');

const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const since = argOf('--since');
const laneFilter = argOf('--lane');
const byRun = argv.includes('--runs');

if (!fs.existsSync(LEDGER)) {
  console.error(`No ledger at ${LEDGER}`);
  console.error('It is created on the first wrap that records a dispatch.');
  process.exit(1);
}

const rows = [];
const bad = [];
fs.readFileSync(LEDGER, 'utf8')
  .split(/\r?\n/)
  .forEach((line, n) => {
    const t = line.trim();
    if (!t) return;
    try {
      rows.push(JSON.parse(t));
    } catch {
      bad.push(n + 1);
    }
  });

if (bad.length) console.error(`! ${bad.length} unparseable line(s): ${bad.slice(0, 10).join(', ')}\n`);

const scoped = rows.filter(
  (r) => (!since || (r.date || '') >= since) && (!laneFilter || r.lane === laneFilter),
);

if (!scoped.length) {
  console.log('No entries match.');
  process.exit(0);
}

// `built` and `already-fixed` are the lane doing the work it was asked to do.
// The three PUSHBACK verdicts are the lane exercising judgment the charter gave
// it — that is what we measure.
//
// `flagged-for-owner` is NEITHER, and must stay out of the denominator: it marks
// a FINDINGS-ONLY dispatch (a verify or audit pass), where the lane was never
// asked to build, so it had nothing to push back on. Counting those as builds
// made the first run of this script report "guard: ZERO pushback, it is not
// being governed" — when all four of guard's rows were verify passes that did
// exactly their job. A ratio over the wrong denominator is worse than no ratio.
const PUSHBACK = new Set(['needs-dependency', 'blocked-charter', 'needs-owner-decision']);
const FINDINGS_ONLY = new Set(['flagged-for-owner']);
const VERDICTS = ['built', 'already-fixed', 'needs-dependency', 'blocked-charter', 'needs-owner-decision', 'flagged-for-owner'];

const dates = scoped.map((r) => r.date).filter(Boolean).sort();
const runs = new Set(scoped.map((r) => r.runId).filter(Boolean));
console.log(`\nLedger — ${scoped.length} dispatches · ${runs.size} run(s) · ${dates[0] || '?'} → ${dates[dates.length - 1] || '?'}`);
if (since) console.log(`(since ${since})`);
if (laneFilter) console.log(`(lane: ${laneFilter})`);

const byLane = new Map();
for (const r of scoped) {
  const lane = r.lane || '(none)';
  if (!byLane.has(lane)) byLane.set(lane, { total: 0, buildAsks: 0, pushback: 0, findings: 0, v: {} });
  const s = byLane.get(lane);
  s.total += 1;
  const v = r.verdict || '(none)';
  s.v[v] = (s.v[v] || 0) + 1;
  if (FINDINGS_ONLY.has(v)) s.findings += 1;
  else s.buildAsks += 1;
  if (PUSHBACK.has(v)) s.pushback += 1;
}

const lanes = [...byLane.entries()].sort((a, b) => b[1].total - a[1].total);
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const COLS = [
  ['built', 'built'],
  ['already-fixed', 'alrdy'],
  ['needs-dependency', 'dep'],
  ['blocked-charter', 'blockd'],
  ['needs-owner-decision', 'owner'],
  ['flagged-for-owner', 'findng'],
];

const header = pad('lane', 11) + lpad('asks', 5) + lpad('push%', 7) + '  ' + COLS.map(([, h]) => lpad(h, 7)).join('');
console.log('\n' + header);
console.log('-'.repeat(header.length));
for (const [lane, s] of lanes) {
  const pct = s.buildAsks ? Math.round((s.pushback / s.buildAsks) * 100) + '%' : '—';
  const cells = COLS.map(([v]) => lpad(s.v[v] || 0, 7)).join('');
  console.log(pad(lane, 11) + lpad(s.buildAsks, 5) + lpad(pct, 7) + '  ' + cells);
}
console.log('\n  asks = dispatches where the lane was asked to BUILD. push% is over that,');
console.log('  not over `findng` (verify/audit runs, where there was nothing to refuse).');

console.log('\nSignals');
let noted = 0;
for (const [lane, s] of lanes) {
  const pct = s.buildAsks ? (s.pushback / s.buildAsks) * 100 : 0;
  const blocked = s.v['blocked-charter'] || 0;
  if (s.buildAsks >= 5 && s.pushback === 0) {
    console.log(`  ! ${lane}: ${s.buildAsks} build asks, ZERO pushback — it is building, not being governed. Check the charter is actually loading.`);
    noted += 1;
  }
  if (blocked >= 3) {
    console.log(`  ! ${lane}: ${blocked} blocked-charter — a rule may be wrong. M6 signal; read the notes before assuming the lane is at fault.`);
    noted += 1;
  }
  if (s.buildAsks >= 5 && pct > 60) {
    console.log(`  ! ${lane}: ${Math.round(pct)}% pushback — either routing is sending it work it does not own, or its charter is too tight to build under.`);
    noted += 1;
  }
}
const deps = scoped.filter((r) => r.verdict === 'needs-dependency');
if (deps.length) {
  console.log(`  · ${deps.length} needs-dependency across the window — these are the seams. Repeats between the same two lanes mean the boundary is drawn wrong.`);
}
if (!noted && !deps.length) console.log('  · nothing anomalous.');
const totalAsks = lanes.reduce((n, [, s]) => n + s.buildAsks, 0);
if (totalAsks < 20) console.log(`  · only ${totalAsks} build asks so far — too thin to read a trend. Ratios need a few weeks.`);

if (byRun) {
  console.log('\nBy run');
  const rr = new Map();
  for (const r of scoped) {
    const k = r.runId || '(none)';
    if (!rr.has(k)) rr.set(k, { total: 0, built: 0, push: 0, date: r.date });
    const s = rr.get(k);
    s.total += 1;
    if (r.verdict === 'built') s.built += 1;
    if (PUSHBACK.has(r.verdict)) s.push += 1;
  }
  for (const [k, s] of rr) {
    console.log(`  ${pad(s.date || '?', 12)} ${pad(k, 28)} ${lpad(s.total, 4)} dispatches · ${lpad(s.built, 3)} built · ${lpad(s.push, 3)} pushback`);
  }
}

if (laneFilter) {
  console.log(`\nFindings — ${laneFilter}`);
  for (const r of scoped) {
    console.log(`  [${r.verdict}] ${r.date}  ${r.finding}`);
    if (r.note) console.log(`      ${r.note}`);
  }
}

console.log('');
