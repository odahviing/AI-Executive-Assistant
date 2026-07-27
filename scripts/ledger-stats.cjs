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
 *   • `source` (github / logs / both / owner / audit / verify) answers whether
 *     each intake earns its cost. The log review is low-volume and is the ONLY
 *     source for bugs nobody reported — judge it on what it catches.
 *
 * Read-only. Never writes.
 *
 * Usage:
 *   node scripts/ledger-stats.cjs --open          # THE OPEN BACKLOG — start here
 *   node scripts/ledger-stats.cjs                 # per-lane pushback ratios
 *   node scripts/ledger-stats.cjs --since 2026-07-01
 *   node scripts/ledger-stats.cjs --lane meeting  # one lane, with its findings
 *   node scripts/ledger-stats.cjs --runs          # per-run summary
 *
 * `--open` exists because the backlog IS the ledger — every row whose verdict is
 * not `built` is still open, so a separate backlog file is a second copy that
 * drifts. Owner's call, 2026-07-26: "audit backlog is the ledger, so you should
 * update there."
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
const openOnly = argv.includes('--open');

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

// A `converted` row that does not say WHERE it went is the prose-not-a-row
// failure wearing a new hat: it closes the item here and leaves it findable
// nowhere. The destination IS the state — without it, `converted` is just a
// quieter `declined`. Checked on every invocation, including `--open`.
const orphanConverted = scoped.filter((r) => r.verdict === 'converted' && !String(r.note || '').trim());
if (orphanConverted.length)
  console.error(
    `! ${orphanConverted.length} \`converted\` row(s) record NO destination in \`note\` — closed here, findable nowhere: ${orphanConverted
      .map((r) => r.ref || '(no ref)')
      .join(', ')}\n`,
  );

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
// NOT a build ask, so never in the pushback denominator:
//   `flagged-for-owner` / `audit` — a findings-only pass; the lane was never
//     asked to build, so it had nothing to refuse.
//   `declined` — the OWNER's verdict, not the lane's. It closes a row as firmly
//     as `built`, but no lane was governed by anything.
//   `converted` — the row LEFT the bug track for a named destination (usually a
//     GitHub Improvement/Feature issue, sometimes another chat). No lane built
//     it and no lane refused it.
// Counting these produced a false alarm on 2026-07-27: the 24 declines the owner
// backfilled carry no lane, so they landed as "(none): 24 build asks, ZERO
// pushback — check the charter is actually loading." A signal that fires on a
// clean state gets ignored, and then it is not a signal.
const FINDINGS_ONLY = new Set(['flagged-for-owner', 'audit', 'declined', 'converted']);
const VERDICTS = ['built', 'already-fixed', 'needs-dependency', 'blocked-charter', 'needs-owner-decision', 'flagged-for-owner'];

// ── --open: THE BACKLOG. Every row still awaiting the owner. ────────────────
// A row is open unless it was built or proven already-fixed. Grouped by lane so
// he can hand one lane its whole list in a single dispatch.
if (openOnly) {
  // `audit` is a record that a findings-only pass RAN — not something to decide.
  // Six such rows sat in the open list on 2026-07-26 under `flagged-for-owner`,
  // inflating a 25-item backlog to 31 and burying the real decisions. A verdict
  // that means "this happened" must never appear in a list that means "act".
  // `declined` closes a row as firmly as `built` does. On 2026-07-26 the owner
  // declined 24 items and the decline was recorded as PROSE in report.md — "not
  // to be re-raised" — in a file nothing parses. So --open kept surfacing them
  // and would have re-raised every one tomorrow, which is precisely what that
  // sentence was trying to prevent. A decision is only durable once it is a row.
  //
  // `converted` closes a row that LEFT the bug track: a bug that turned out to be
  // a design question and became a GitHub Improvement/Feature issue, or one
  // handed to another chat. Added 2026-07-27 because there was no honest way to
  // close one — it either sat open here forever, or got logged `declined`, which
  // reads as a decision the owner made AGAINST it. Neither was true.
  // Its `note` MUST name the destination; see the check below.
  const CLOSED = new Set(['built', 'already-fixed', 'audit', 'declined', 'converted']);

  // ── COLLAPSE BY REF ────────────────────────────────────────────────────────
  // The ledger is APPEND-ONLY, so one item legitimately has several rows: parked
  // on Monday, built on Tuesday. Filtering row-by-row therefore reported items as
  // open that had already shipped — 37 "open" when the true number was 6. Two
  // distinct causes, both handled here:
  //
  //   1. Same ref, later row closes it (P24, P25, P32, gh#148).
  //   2. The closing row used a COMBINED ref because one dispatch covered several
  //      items — `P29+P30`, `A2+A3`, `P27+P28+gate-order`, `gh#41-step1`. Those
  //      never string-matched the original, so the item looked untouched.
  //
  // Tokenising handles both. Matching is exact per token, never substring, so
  // `P2` is not closed by `P24`.
  const refTokens = (ref) => {
    const out = new Set();
    const raw = String(ref || '').trim();
    if (!raw) return out;
    out.add(raw);
    for (const part of raw.split(/[+,/]| and /i).map((s) => s.trim()).filter(Boolean)) {
      out.add(part);
      // `gh#41-step1` / `P19-part2` / `A2-1` → also close the base item
      const m = part.match(/^(.+?)[-–_](?:step|part|phase)?\s*\d+$/i);
      if (m && m[1].length > 1) out.add(m[1]);
    }
    return out;
  };

  const closedBy = new Map(); // ref token -> the row that closed it
  for (const r of scoped) {
    if (!CLOSED.has(r.verdict)) continue;
    for (const t of refTokens(r.ref)) if (!closedBy.has(t)) closedBy.set(t, r);
  }

  // Keep the LATEST row per ref, so a re-raised item shows once with its newest state.
  const latest = new Map();
  const refless = [];
  for (const r of scoped) {
    if (CLOSED.has(r.verdict)) continue;
    if (!r.ref) { refless.push(r); continue; }
    latest.set(r.ref, r); // ledger is chronological, so last write wins
  }
  const collapsed = [];
  const open = [];
  for (const r of latest.values()) {
    const closer = closedBy.get(r.ref);
    if (closer) collapsed.push({ r, closer });
    else open.push(r);
  }
  // A row with no ref cannot be collapsed — that is exactly what `ref` is for.
  open.push(...refless);
  if (!open.length) {
    console.log('\nNothing open. Every ledger row is built or already-fixed.\n');
    process.exit(0);
  }
  console.log(`\nOPEN — ${open.length} row(s) awaiting you\n`);
  const laneGroups = new Map();
  for (const r of open) {
    const k = r.lane || '(no lane)';
    if (!laneGroups.has(k)) laneGroups.set(k, []);
    laneGroups.get(k).push(r);
  }
  for (const [lane, rows] of [...laneGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${lane}  (${rows.length})`);
    for (const r of rows) {
      const ref = r.ref ? `[${r.ref}] ` : '';
      console.log(`  ${r.verdict === 'needs-owner-decision' ? 'DECIDE' : r.verdict === 'flagged-for-owner' ? 'FLAGGED' : r.verdict.toUpperCase()}  ${ref}${(r.finding || '').slice(0, 110)}`);
      if (r.rootCause) console.log(`          ${r.rootCause.slice(0, 100)}`);
    }
    console.log('');
  }
  if (collapsed.length) {
    console.log(`Collapsed ${collapsed.length} row(s) that a later row already closed — shown so a WRONG collapse is visible:`);
    for (const { r, closer } of collapsed) {
      const via = closer.ref === r.ref ? 'same ref' : `via "${closer.ref}"`;
      console.log(`  ${r.ref} → ${closer.verdict} (${via})`);
    }
    console.log('');
  }
  if (refless.length) console.log(`! ${refless.length} open row(s) carry NO ref, so nothing can ever close them automatically. Give every ledger row a ref.\n`);
  console.log(`To build a lane's list:  say "build the <lane> ones" and the Manager dispatches that lane directly.`);
  console.log(`Anything you do not want: say so and it is recorded as declined, not silently left open.\n`);
  process.exit(0);
}

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

// ── By SOURCE — is each intake earning its keep? ────────────────────────────
// Added 2026-07-27. Before this, "does the log review pay for itself?" could
// only be answered by grepping old workflow journals — which gave 4 log
// findings ever against 8 from GitHub. All four were real, and two were things
// the owner had never reported (a phantom "the colleague has been notified",
// and a required attendee silently dropped on a follow-up turn). That is the
// class GitHub can never carry, because nobody noticed it to file it. So this
// column is not a volume contest: a cheap source that finds the unreported is
// worth keeping at low volume, and the judgement should come off a query.
const bySource = new Map();
for (const r of scoped) {
  const k = r.source || '(unrecorded)';
  if (!bySource.has(k)) bySource.set(k, { total: 0, shipped: 0, open: 0, moved: 0 });
  const s = bySource.get(k);
  s.total += 1;
  if (r.verdict === 'built' || r.verdict === 'already-fixed') s.shipped += 1;
  else if (r.verdict === 'converted') s.moved += 1;
  else if (!FINDINGS_ONLY.has(r.verdict)) s.open += 1;
}
console.log('\nBy source');
for (const [src, s] of [...bySource.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(
    `  ${pad(src, 14)}${lpad(s.total, 4)} raised · ${lpad(s.shipped, 3)} shipped · ${lpad(s.open, 3)} still open${s.moved ? ` · ${s.moved} moved off the bug track` : ''}`,
  );
}

// What left the bug track, and where it went. A bug that turned out to be a
// design question is not lost — it is a GitHub issue now — but only if the
// pointer is printed somewhere the owner actually reads.
const convertedRows = scoped.filter((r) => r.verdict === 'converted');
if (convertedRows.length) {
  console.log(`\nLeft the bug track (${convertedRows.length}) — these are NOT dropped, they moved`);
  for (const r of convertedRows) console.log(`  ${pad(r.ref || '(no ref)', 16)} → ${(r.note || 'NO DESTINATION RECORDED').slice(0, 88)}`);
}
const unrec = bySource.get('(unrecorded)');
if (unrec) console.log(`  ! ${unrec.total} row(s) carry no source — they predate the field. Every NEW row must have one, or this table goes back to being unanswerable.`);
const logRows = bySource.get('logs');
const bothRows = bySource.get('both');
const logTotal = (logRows ? logRows.total : 0) + (bothRows ? bothRows.total : 0);
if (logTotal && logTotal < 6)
  console.log(`  · the log review has raised ${logTotal} — thin, but it is the only source for bugs nobody reported. Judge it on WHAT it catches, not how much.`);
if (bothRows) console.log(`  · ${bothRows.total} row(s) merged a GitHub issue with a log moment — his words as the ask, the transcript as the proof. That merge working is the scout doing its job.`);

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
