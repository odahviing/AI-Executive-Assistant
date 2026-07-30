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
 *   node scripts/ledger-stats.cjs --report        # does report.md's own arithmetic add up?
 *   node scripts/ledger-stats.cjs                 # per-lane pushback ratios
 *   node scripts/ledger-stats.cjs --since 2026-07-01
 *   node scripts/ledger-stats.cjs --lane meeting  # one lane, with its findings
 *   node scripts/ledger-stats.cjs --runs          # per-run summary
 *   node scripts/ledger-stats.cjs --by-invariant  # one PRINCIPLE, however many places broke it
 *
 * `--open` exists because the backlog IS the ledger — every row whose verdict is
 * not `built` is still open, so a separate backlog file is a second copy that
 * drifts. Owner's call, 2026-07-26: "audit backlog is the ledger, so you should
 * update there."
 */

const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, '..', '.claude', 'agent-loop', 'ledger.jsonl');
const REPO = path.join(__dirname, '..');

// ── A38 · STALENESS — one check, BOTH ledgers ───────────────────────────────
// `verifiedClean` has carried a pruning discipline since 2026-07-27: drop an
// entry the moment a wave changes the code it describes, because a stale "proven
// clean" SILENCES a real check. The open list has the mirror failure and had no
// rule — a stale open row silences nothing, it DILUTES, so 48 open rows read as
// 48 live decisions when some describe code that has since moved. That is what
// makes the list unreadable and therefore unread.
//
// A row's evidence names a `file:line`, so staleness is CHECKABLE rather than a
// judgement: if a commit touched that file AFTER the row was written, the row
// needs one re-read before it counts as open. Same check the scout already runs
// outward for `alreadyBuilt` / `openKnown`, turned inward on the ledger.
//
// It MARKS, never closes. Most fixes touch a file without addressing every
// defect in it, so auto-retiring would delete real findings.
//
// COMMITTED history only, and the output says so: an uncommitted edit carries no
// date to compare against, and this repo is uncommitted by default.
const fileTouchDates = (sinceDay) => {
  let out = '';
  try {
    out = require('child_process').execFileSync(
      'git',
      ['-C', REPO, 'log', `--since=${sinceDay}`, '--name-only', '--pretty=format:%x01%cs'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return null; // no git, or not a repo — reported as "not checked", NEVER as confirmed
  }
  const map = new Map(); // repo path -> latest YYYY-MM-DD that touched it
  let day = '';
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('\x01')) {
      day = line.slice(1).trim();
      continue;
    }
    const p = line.trim();
    if (!p || !day) continue;
    if (!map.has(p) || map.get(p) < day) map.set(p, day);
  }
  return map;
};
const CITED = /[\w./@#-]*[\w-]\.(?:ts|tsx|js|cjs|mjs|md|jsonl|json|ya?ml|sql)\b/g;
// A47 · a row that cites NO file is not confirmed — it is UNCHECKABLE, and
// counting it as confirmed is the count-that-is-wrong failure inside the reader
// that exists to be trusted. It can never be flagged RE-READ either, so the
// nightly backlog pass will never look at it: 12 of the 49 open rows on
// 2026-07-30. They need a hand read, so they are named rather than left to look
// like the healthy majority.
const uncheckable = (s) => s.checked && Array.isArray(s.cited) && !s.cited.length;
/** Did the code a row cites move after the row was written? Marks, never closes. */
const staleness = (touched, row, ...fields) => {
  if (!touched) return { checked: false };
  const cited = [...new Set(fields.map((f) => String(f || '')).join(' ').match(CITED) || [])];
  if (!cited.length) return { checked: true, cited: [] };
  let movedOn = null;
  let which = '';
  for (const c of cited) {
    const base = '/' + c.replace(/^.*\//, '');
    for (const [p, day] of touched) {
      if (p !== c && !p.endsWith(base)) continue;
      if (!movedOn || day > movedOn) {
        movedOn = day;
        which = p;
      }
    }
  }
  const rowDay = String(row.date || '');
  return { checked: true, cited, movedOn, which, needsRecheck: !!(movedOn && rowDay && movedOn > rowDay) };
};
/** The oldest date in a set of rows, as the `git log --since` floor. */
const oldestDay = (rows) => rows.map((r) => String(r.date || '')).filter(Boolean).sort()[0] || '2026-01-01';

// ── A59 · TWO REASONS TO RE-READ. A38 only ever had the first ────────────────
// A38 asks "did the cited code MOVE", which is staleness of the CITATION. The
// question the backlog exists to answer is "is this finding still worth fixing",
// and for a row nobody has ever opened the honest answer is *nobody knows*.
// Measured 2026-07-30: 4 of 47 open rows cited a file the day's wave touched, so
// 38 read as `confirmed` while no lane had re-read any of them and several dated
// from 07-26 — and the pass that exists to shorten the list looked at ONE row.
//
// A58 · `confirmed` was also the wrong NAME for the complement. It meant "no
// commit touched the file" and read as "somebody verified this is still real" —
// the weaker claim wearing the stronger one's name, on the surface he rules from.
// It now means exactly one thing: a lane opened the code and stood behind the row,
// which is what `architect-file --recheck` / a `recheck` field records. The
// `unchanged` bucket A58 asked for is not renamed, it is GONE: once a
// never-examined row prints RE-READ, nothing can land in it.
//
// FOUR buckets, mutually exclusive, summing to the open count:
//   confirmed   — carries a `recheck` line and nothing has moved since
//   moved       — the cited code changed after the row's latest date (A38)
//   unexamined  — cites a file, and nobody has ever re-read it
//   no-cite     — cites no file, so no pass can ever check it (A47) — HIS read
// RE-READ = `moved` ∪ `unexamined`, which is the set the scout's brief takes.
// `unexamined` deliberately does NOT depend on git: with no history available
// `moved` is unknowable, but "nobody has looked" is still a fact.
const bucketOf = (s, row) => {
  if (String(row.recheck || '').trim() && !s.needsRecheck) return 'confirmed';
  if (uncheckable(s)) return 'no-cite';
  return s.needsRecheck ? 'moved' : 'unexamined';
};
const REREAD = new Set(['moved', 'unexamined']);
const LEGEND_REREAD =
  'RE-READ = nobody has stood behind this row yet — either the code it cites MOVED after it was written, or NO ONE HAS EVER RE-READ IT. Re-read it, then rule; nothing is closed automatically.';
const LEGEND_CONFIRMED =
  'CONFIRMED = a lane opened the code and said it is still real. It is the ONLY bucket that means somebody looked; "no commit touched the file" is not a confirmation.';

const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const since = argOf('--since');
const laneFilter = argOf('--lane');
const byRun = argv.includes('--runs');
const byInvariant = argv.includes('--by-invariant');
const openOnly = argv.includes('--open');

// --architect reads the OTHER ledger: `.claude/agent-loop/architect-ledger.jsonl`,
// the framework's own backlog, filed by whichever chat hit the problem via
// `scripts/architect-file.cjs`. Same collapse-to-latest logic (append-only means
// A23-open and A23-built are two rows), different grouping — framework rows have a
// `target` rather than a lane. Deliberately a self-contained early exit so it
// cannot perturb the bug-ledger path below.
if (argv.includes('--architect')) {
  const AL = path.join(__dirname, '..', '.claude', 'agent-loop', 'architect-ledger.jsonl');
  if (!fs.existsSync(AL)) {
    console.error(`No architect ledger at ${AL}`);
    console.error("It is created by the first 'node scripts/architect-file.cjs' call.");
    process.exit(1);
  }
  const all = fs.readFileSync(AL, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // A41 · MERGE per id, not overwrite. Append-only means a finished row is TWO
  // lines — the filing and the closing — and the closing row is deliberately
  // minimal (`{id, date, verdict, built}`). A plain overwrite would blank the
  // `finding`, `target` and `note` the filing carried, so a completed row would
  // read as an anonymous one and `architect-file.cjs`'s clash check would lose the
  // text it matches against. Spreading keeps the history and lets the writer append
  // four fields instead of copying the whole row back into the file.
  const latest = new Map();
  for (const r of all) latest.set(r.id, { ...(latest.get(r.id) || {}), ...r });
  const rows = [...latest.values()];
  const CLOSED = new Set(['built', 'declined', 'duplicate']);
  const open = rows.filter((r) => !CLOSED.has(r.verdict));
  const p = (s, n) => String(s).padEnd(n);

  // A38 · The ledger is append-only and a target label is not worth breaking
  // that for, so drift is normalised at READ time. The hand-migrated rows carry
  // `both engines` and `scripts/ledger-stats.cjs`, which printed as their own
  // groups beside the enum values `both-engines` and `scripts` — one target in
  // two places, which is the second-copy-that-drifts failure inside the reader
  // whose whole job is to be the single copy. `architect-file.cjs` validates
  // `--target` against its enum, so only legacy rows can be off-enum and every
  // group printed here lands on an enum value.
  const normTarget = (raw) => {
    const t = String(raw || '').trim();
    if (!t) return '(no target)';
    if (/^scripts[/\\]/.test(t)) return 'scripts';
    if (/^both[ -]engines$/i.test(t)) return 'both-engines';
    if (/\.md$/.test(t) && t !== 'SKILL.md' && t !== 'SESSION_STARTER.md') return 'charter';
    return t;
  };

  console.log(`\nArchitect ledger — ${rows.length} row(s) · ${open.length} open · ${rows.length - open.length} closed`);
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  console.log(`  ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}:${n}`).join(' · ')}`);

  if (!open.length) {
    console.log(`\nNothing open. Every framework finding is built, declined or a duplicate.\n`);
    process.exit(0);
  }
  // A38 · the open count splits, so a row describing code that has since moved
  // stops being counted as a live decision.
  const aTouched = fileTouchDates(oldestDay(open));
  const aStale = new Map(open.map((r) => [r.id, staleness(aTouched, r, r.evidence, r.note, r.finding)]));
  // A58/A59 · one bucket per row, so every count below is the same partition.
  const aBucket = new Map(open.map((r) => [r.id, bucketOf(aStale.get(r.id), r)]));
  const aN = (b) => open.filter((r) => aBucket.get(r.id) === b).length;
  const aRecheck = open.filter((r) => REREAD.has(aBucket.get(r.id)));
  const aNoCite = open.filter((r) => aBucket.get(r.id) === 'no-cite');
  const byTarget = new Map();
  for (const r of open) {
    const t = normTarget(r.target);
    if (!byTarget.has(t)) byTarget.set(t, []);
    byTarget.get(t).push(r);
  }
  console.log(
    `\nOPEN — ${open.length} awaiting triage or approval · ${aN('confirmed')} confirmed · ${aRecheck.length} need a re-read (${aN('moved')} moved · ${aN(
      'unexamined',
    )} never examined) · ${aNoCite.length} cite no file` + (aTouched ? '' : ' (no git history — `moved` NOT CHECKED; `never examined` is unaffected)'),
  );
  console.log(LEGEND_REREAD);
  console.log(LEGEND_CONFIRMED + '\n');
  for (const [t, list] of [...byTarget.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${t}  (${list.length})`);
    for (const r of list) {
      const s = aStale.get(r.id);
      const b = aBucket.get(r.id);
      console.log(`  ${p(r.id, 5)} ${p(REREAD.has(b) ? 'RE-READ' : r.verdict, 10)} ${String(r.finding).slice(0, 96)}`);
      if (r.evidence) console.log(`        ${String(r.evidence).slice(0, 96)}`);
      if (b === 'moved') console.log(`        ! ${s.which} changed ${s.movedOn}, this row was written ${r.date}`);
      if (b === 'unexamined') console.log(`        ! never re-read — filed ${r.date || '(no date)'}, and nobody has opened it since`);
      // A47 · somebody looked and it was still real. Printed with its date, so a
      // confirmation is visible as a real read rather than clearing the flag silently.
      if (r.recheck) console.log(`        re-read ${r.date}: ${String(r.recheck).slice(0, 88)}`);
      if (r.amends) console.log(`        amends ${r.amends}`);
    }
    console.log('');
  }
  if (aNoCite.length)
    console.log(
      `${aNoCite.length} row(s) cite no file, so staleness cannot be checked and they never print RE-READ — read these by hand: ${aNoCite.map((r) => r.id).join(', ')}\n`,
    );
  console.log(`Confirm one with: node scripts/architect-file.cjs --recheck <id> --checked "<what you opened>"`);
  console.log(`Nothing here is approved to build. The architect triages and proposes; the owner rules.\n`);
  process.exit(0);
}

// ── A54 · DOES THE REPORT'S OWN ARITHMETIC ADD UP? ──────────────────────────
// Reads `report.md` and checks the numbers it asserts about ITSELF: every group
// heading's count against the rows beneath it, the headline's "N rows await you"
// against the pending group, and that group against the decision budget (A55).
//
// WHY A CHECK AND NOT A BETTER SENTENCE. SKILL.md already told the Manager to read
// every count off the Status cells and never from the engine's return — and the
// FIRST report produced under the grouped format printed `Pending owner (3)` above
// FIVE rows. A27 is the same failure one release earlier: a head line reading
// `ZERO built` above four `built` rows, alive four hours fifty-six minutes across
// nine row-level edits, because every edit flipped a status and none touched the
// count. A hand-written count is a hand-written count; the layer that fixes it is
// a check (A7), not more prose.
//
// It NEVER writes. `report.md` belongs to whoever is mid-wave.
if (argv.includes('--report')) {
  const RP = argOf('--report') || path.join(__dirname, '..', '.claude', 'agent-loop', 'report.md');
  if (!fs.existsSync(RP)) {
    console.error(`\nNo report at ${RP}\n`);
    process.exit(1);
  }
  // `capDecisions` — the engine's own default lives at bugger.js:1150. Pass --cap
  // if he raised it for a run, so this check and that run agree on one number.
  const CAP = Number(argOf('--cap')) || 12;
  const lines = fs.readFileSync(RP, 'utf8').split(/\r?\n/);
  const isPipe = (l) => /^\s*\|/.test(String(l));
  const isSep = (l) => /^\s*\|[\s|:—–-]*\|\s*$/.test(String(l)) && /-/.test(String(l));
  const groups = [];
  let cur = null;
  let loose = 0;
  lines.forEach((l, i) => {
    // A `#` heading, or a bold-only line that CARRIES a count. A bold sentence with
    // no `(n)` in it is prose (the emptied report's headline is exactly that) and
    // must not capture the rows below it as a group.
    const h = l.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/) || (/\(\d+\)/.test(l) ? l.match(/^\s*\*\*(.+?)\*\*\s*$/) : null);
    if (h) {
      const m = h[1].match(/\((\d+)\)/);
      cur = { line: i + 1, title: h[1].replace(/\*\*/g, '').trim(), claimed: m ? Number(m[1]) : null, rows: 0 };
      groups.push(cur);
      return;
    }
    if (!isPipe(l) || isSep(l)) return;
    if (isSep(lines[i + 1])) return; // the column header, not a row
    if (cur) cur.rows += 1;
    else loose += 1;
  });

  const shown = groups.filter((g) => g.claimed !== null || g.rows);
  const totalRows = groups.reduce((n, g) => n + g.rows, 0) + loose;
  const pending = groups.filter((g) => /pending|await|decide|needs? you/i.test(g.title));
  const pendingRows = pending.reduce((n, g) => n + g.rows, 0);
  let bad = 0;
  console.log(`\n${path.relative(REPO, RP).replace(/\\/g, '/')} — ${shown.length} group(s) · ${totalRows} table row(s) · budget ${CAP}\n`);
  for (const g of shown) {
    const claim = g.claimed === null ? 'no count claimed' : `claims ${g.claimed}`;
    const ok = g.claimed === null || g.claimed === g.rows;
    if (!ok) bad += 1;
    console.log(`  line ${String(g.line).padStart(4)}  ${String(g.title).slice(0, 54).padEnd(56)} ${claim} · holds ${g.rows}   ${ok ? 'ok' : '! MISMATCH'}`);
  }
  if (loose) {
    console.log(`\n  ! ${loose} table row(s) sit under NO heading — the format is grouped by status, so those rows are in no group and no count covers them.`);
    bad += 1;
  }
  // The headline's own claim. NOT CHECKED, loudly, when it names no number — the
  // one thing this must never do is print a clean line about something it skipped.
  const numeric = lines.map((l) => l.match(/(\d+)\s+rows?\b[^.\n]{0,40}?await/i)).find(Boolean);
  const zeroClaim = lines.find((l) => /noth(ing|in)\b[^.\n]{0,48}?await/i.test(l));
  if (numeric) {
    const ok = Number(numeric[1]) === pendingRows;
    if (!ok) bad += 1;
    console.log(`\n  headline says "${numeric[0]}" · the pending group(s) hold ${pendingRows}   ${ok ? 'ok' : '! MISMATCH'}`);
  } else if (zeroClaim) {
    const ok = pendingRows === 0;
    if (!ok) bad += 1;
    console.log(`\n  headline claims nothing awaits him · the pending group(s) hold ${pendingRows}   ${ok ? 'ok' : '! MISMATCH'}`);
  } else {
    console.log(`\n  headline: NOT CHECKED — no "<n> rows await you" line found. Its ledger total is a separate claim: node scripts/ledger-stats.cjs --open`);
  }
  // A55 · the budget GATES what the backlog may add, it does not merely warn. The
  // run's own rows come first; the backlog fills whatever room is left, often none.
  if (pendingRows > CAP) {
    console.log(`  ! OVER BUDGET — ${pendingRows} rows need him, cap is ${CAP}. 2026-07-26 put 30 in front of him and he could not act on any of them.`);
    bad += 1;
  } else if (pending.length) {
    console.log(`  decision budget: ${pendingRows} of ${CAP} spent · room for ${CAP - pendingRows} more backlog row(s)`);
  }
  if (!totalRows) console.log(`\n  0 table rows — an emptied report is a valid state. Its headline must still carry the ledger's open total (\`--open\`).`);
  console.log(bad ? `\n${bad} problem(s). A count the table contradicts is the defect, not the number.\n` : `\nEvery count agrees with the rows beneath it.\n`);
  process.exit(bad ? 1 : 0);
}

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
  //
  // A47 · every token is NORMALISED for the `gh#` / `#` prefix, because the ledger
  // genuinely holds all three forms of the same issue. `bugger.js` has normalised
  // them since the `alreadyBuilt` fix — its brief says `#147` = `gh#147` = `147` —
  // and this reader did not, so an open row `gh#144` sat in the list while the row
  // that closed it was written `144`: one falsely-open row out of 49, in the count
  // the report headline is computed from.
  //
  // A SPACE is deliberately NOT a suffix separator. `gh#52 O3` is one piece of a
  // multi-lane ticket, and minting `52` from it would let one piece close its
  // parent — measured on 2026-07-30 as 4 extra collapses, three of them wrong.
  const normRef = (t) => String(t || '').trim().toLowerCase().replace(/^(?:gh)?#/, '');
  const refTokens = (ref) => {
    const out = new Set();
    const raw = String(ref || '').trim();
    if (!raw) return out;
    out.add(normRef(raw));
    for (const part of raw.split(/[+,/]| and /i).map((s) => s.trim()).filter(Boolean)) {
      out.add(normRef(part));
      // `gh#41-step1` / `P19-part2` / `A2-1` → also close the base item. A34 · the
      // suffix may now be NON-numeric — his scheme is `156-a` for a complaint and
      // `153-blockA` for a raised blocker, so a suffix that was previously
      // unmatchable had to become linkable or a child could never close its parent.
      // Gated on the BASE looking like a bare id (`156`, `gh#158`, `P14`, `A2`)
      // rather than on the suffix, which is what keeps a long slug ref like
      // `gh#158-exception-must-be-name-scoped` from minting a junk base token.
      const m = part.match(/^(.+?)[-–_](?:step|part|phase)?\s*([a-z0-9]{1,6})$/i);
      if (m && /^(?:gh#)?\d+$|^[a-z]\d+$/i.test(m[1])) out.add(normRef(m[1]));
    }
    return out;
  };

  const closedBy = new Map(); // ref token -> the row that closed it
  for (const r of scoped) {
    if (!CLOSED.has(r.verdict)) continue;
    for (const t of refTokens(r.ref)) if (!closedBy.has(t)) closedBy.set(t, r);
  }

  // Keep the LATEST state per ref, so a re-raised item shows once with its newest
  // state. A47 · MERGED, not overwritten — the same fix `--architect` carries, for
  // the same reason: append-only means a row is legitimately several lines, and a
  // later line that carries only what CHANGED must not blank the `lane`, `finding`
  // and `rootCause` the first one held. That is what lets a re-read append
  // `{date, ref, recheck}` and nothing else. Measured across all 344 rows on
  // 2026-07-30: 15 refs have more than one open line and merging changes no printed
  // label on any of them.
  const latest = new Map();
  const refless = [];
  for (const r of scoped) {
    if (CLOSED.has(r.verdict)) continue;
    if (!r.ref) { refless.push(r); continue; }
    latest.set(r.ref, { ...(latest.get(r.ref) || {}), ...r }); // ledger is chronological, so later fields win
  }
  const collapsed = [];
  const open = [];
  for (const r of latest.values()) {
    // The CLOSER's ref is the one that expands into tokens; the open row is looked
    // up by its own normalised ref alone. Expanding both would let a closed `gh#41-step1`
    // collapse an open `gh#41-step5` through the shared base — measured as no
    // difference on today's ledger, and a false close waiting for tomorrow's.
    const closer = closedBy.get(normRef(r.ref));
    if (closer) collapsed.push({ r, closer });
    else open.push(r);
  }
  // A row with no ref cannot be collapsed — that is exactly what `ref` is for.
  open.push(...refless);
  if (!open.length) {
    console.log('\nNothing open. Every ledger row is built or already-fixed.\n');
    process.exit(0);
  }
  // A38 · the same staleness check as `--architect`, on the same helper. A row
  // whose cited code moved after it was written is not a live decision until
  // someone re-reads it, and 18 of these rows are two to four days old across
  // waves that changed the very files they cite. It MARKS; it never closes.
  const touched = fileTouchDates(oldestDay(open));
  const stale = new Map(open.map((r) => [r, staleness(touched, r, r.rootCause, r.finding, r.note)]));
  // A58/A59 · one bucket per row, so every count below is the same partition.
  const bucket = new Map(open.map((r) => [r, bucketOf(stale.get(r), r)]));
  const nOf = (b) => open.filter((r) => bucket.get(r) === b).length;
  const recheck = open.filter((r) => REREAD.has(bucket.get(r)));
  const noCite = open.filter((r) => bucket.get(r) === 'no-cite');
  console.log(
    `\nOPEN — ${open.length} row(s) awaiting you · ${nOf('confirmed')} confirmed · ${recheck.length} need a re-read (${nOf('moved')} moved · ${nOf(
      'unexamined',
    )} never examined) · ${noCite.length} cite no file` + (touched ? '' : ' (no git history — `moved` NOT CHECKED; `never examined` is unaffected)'),
  );
  console.log(LEGEND_REREAD);
  console.log(LEGEND_CONFIRMED);
  // A51 · the two states read alike and are opposites. A `converted` row is CLOSED
  // and never prints here; a `deferred` row is a ONE-RUN skip and is DUE. Deriving
  // `openKnown` from both told the scout to drop four rows the owner had ruled due.
  console.log(`DEFERRED = a ONE-RUN skip, DUE on the next run — not parked. It never belongs in \`openKnown\`; that list is \`converted\` rows only, and those left the bug track for GitHub.\n`);
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
      // A23 · `state` is on 310 of the ledger's 344 rows and was read by NOTHING, so a row the
      // owner had already parked printed as `DECIDE` — the script asking him to
      // decide the thing he decided. It stays in the list, deliberately: a lapsed
      // deferral must not read as handled, so this shows the date it was PARKED
      // (the row's own date, never a due date parsed out of prose) and lets him see
      // for himself that it has gone stale. `deferred` is not in CLOSED and must
      // never be — hiding it is the failure this replaces, one direction along.
      //
      // BOTH fields, because the ledger genuinely records a deferral in either: 6
      // rows carry `state:'deferred'` and 3 more carry `verdict:'deferred'`, and all
      // 9 print here. Keying on one field alone printed the same word for both and
      // the date for only 6 of 9 — the same rule true on one path and not the other.
      const isDeferred = r.state === 'deferred' || r.verdict === 'deferred';
      const label = isDeferred
        ? `DEFERRED ${r.date || '(no date)'} · DUE NEXT RUN`
        : r.verdict === 'needs-owner-decision'
          ? 'DECIDE'
          : r.verdict === 'flagged-for-owner'
            ? 'FLAGGED'
            : String(r.verdict || 'NO VERDICT').toUpperCase();
      const s = stale.get(r);
      const b = bucket.get(r);
      console.log(`  ${REREAD.has(b) ? 'RE-READ ' : ''}${label}  ${ref}${(r.finding || '').slice(0, 110)}`);
      if (r.rootCause) console.log(`          ${r.rootCause.slice(0, 100)}`);
      if (b === 'moved') console.log(`          ! ${s.which} changed ${s.movedOn}, this row was written ${r.date}`);
      if (b === 'unexamined') console.log(`          ! never re-read — filed ${r.date || '(no date)'}, and nobody has opened it since`);
      // A47 · somebody re-read it and it was still real. This is what keeps the same
      // row off tomorrow's RE-READ list, so it prints with the date that cleared it.
      if (r.recheck) console.log(`          re-read ${r.date}: ${String(r.recheck).slice(0, 96)}`);
      // His own words on the deferral, which is the only thing that distinguishes
      // "not now" from "never" — first clause only; the rest of `note` is the fix.
      if (isDeferred && String(r.note || '').trim())
        console.log(`          parked: ${String(r.note).split('. ')[0].slice(0, 100)}`);
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
  // A47 · NAMED, never silently worked. The backlog pass takes only RE-READ rows, so
  // these are the ones no run will ever reach: they cite no file, so no commit can
  // flag them. Naming them is the difference between a known hand-read list and 12
  // rows quietly counted as confirmed.
  if (noCite.length) {
    console.log(`${noCite.length} open row(s) cite no file, so staleness cannot be checked and no backlog pass will ever re-read them. Read these by hand:`);
    for (const r of noCite) console.log(`  ${r.ref || '(no ref)'}  ${String(r.finding || '').slice(0, 88)}`);
    console.log('');
  }
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
    if (!rr.has(k)) rr.set(k, { total: 0, built: 0, push: 0, days: new Map() });
    const s = rr.get(k);
    s.total += 1;
    if (r.verdict === 'built') s.built += 1;
    if (PUSHBACK.has(r.verdict)) s.push += 1;
    if (r.date) s.days.set(r.date, (s.days.get(r.date) || 0) + 1);
  }
  // A48 · A run that crossed midnight used to print its ENTIRE count under its
  // FIRST row's date, because the bucket kept `date: r.date` from whichever row
  // created it and every later row's own date was thrown away. `owner-review`
  // holds 29 rows on 2026-07-26 and 3 on 2026-07-29, and this table read
  // "2026-07-26 · 32 dispatches" — a wrong number on a real day, on the one view
  // whose whole job is per-run attribution. `--since` and the header range were
  // never affected: they read each row's own `date`.
  //
  // Both halves are printed because both are asked: the SPAN says when the run
  // lived, the per-day split says what each day actually carried, so neither day
  // can be read as owning dispatches it did not.
  for (const [k, s] of rr) {
    const days = [...s.days.keys()].sort();
    const when = days.length > 1 ? `${days[0]}→${days[days.length - 1].slice(5)}` : days[0] || '?';
    const split = days.length > 1 ? `  [${days.map((d) => `${d.slice(5)}:${s.days.get(d)}`).join(' ')}]` : '';
    console.log(`  ${pad(when, 17)} ${pad(k, 28)} ${lpad(s.total, 4)} dispatches · ${lpad(s.built, 3)} built · ${lpad(s.push, 3)} pushback${split}`);
  }
}

if (byInvariant) {
  // N22 · Dedupe is by rootCause `file:line`, which answers "is this the same BUG"
  // and is blind to "is this the same RULE". Three rows in three files broke one
  // invariant — a model may pick a VALUE, never the TIER — and read as three
  // unrelated findings; the product chat, reading the same rows, proposed three
  // separate charter rules, one per lane. Correct from where it stood. This groups
  // by the principle instead of the location, so a root gets fixed once.
  console.log('\nBy invariant — one principle, however many places it broke');
  const inv = new Map();
  let untagged = 0;
  for (const r of scoped) {
    if (!r.invariant) {
      untagged += 1;
      continue;
    }
    if (!inv.has(r.invariant)) inv.set(r.invariant, []);
    inv.get(r.invariant).push(r);
  }
  if (!inv.size) console.log('  No row carries an `invariant` tag yet.');
  for (const [name, list] of [...inv.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const lanes = [...new Set(list.map((r) => r.lane))];
    console.log(`\n  ${name} — ${list.length} row(s) across ${lanes.length} lane(s): ${lanes.join(', ')}`);
    for (const r of list) console.log(`    [${r.verdict}] ${pad(r.lane, 12)} ${r.ref || '(no ref)'}  ${String(r.finding || '').slice(0, 80)}`);
    if (list.length > 1)
      console.log(`    → ${list.length} places, ONE rule. Fix the root once; ${list.length} symptom fixes is the failure this view exists to catch.`);
  }
  // A5: the tag is optional, so its own coverage must be visible — otherwise this
  // view prints "no invariants" on a ledger nobody tagged and reads like good news.
  console.log(`\n  ${untagged} of ${scoped.length} row(s) carry NO \`invariant\` tag. This view sees only what was tagged.`);
}

if (laneFilter) {
  console.log(`\nFindings — ${laneFilter}`);
  for (const r of scoped) {
    console.log(`  [${r.verdict}] ${r.date}  ${r.finding}`);
    if (r.note) console.log(`      ${r.note}`);
  }
}

console.log('');
