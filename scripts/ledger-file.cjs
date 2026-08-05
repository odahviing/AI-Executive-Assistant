#!/usr/bin/env node
/**
 * ledger-file — the WRITER for `.claude/agent-loop/ledger.jsonl`, the bug ledger.
 *
 * There has never been one. `grep -rn appendFileSync scripts/ .claude/workflows/`
 * finds a writer for the architect ledger (`architect-file.cjs`) and for the
 * design-cluster join-back — nothing for this file. Every row in it, ever, was a
 * chat hand-composing JSON and following `SKILL.md` from memory. That is why any
 * shape can land in it, why rows have shipped with no closing row, and why
 * `invariant` coverage sat at 23% of 415 refs the day this was built (measured
 * 2026-08-05, `node scripts/ledger-stats.cjs --index`).
 *
 * This steals `architect-file.cjs`'s design wholesale — refuse loudly, evidence
 * before append, append-only — and adapts it to the bug ledger's own schema
 * (`ref`/`lane`/`source`/`rootCause`/`invariant`, not `id`/`target`/`amends`).
 *
 * WHY `invariant` IS REQUIRED HERE AND NOWHERE ELSE. The owner asked whether
 * duplicate rows could be merged automatically; it was tested against the real
 * ledger (score >= 3 of {same file, same lane, within 2 days, "build together"
 * said}) and the answer is no — ~33 candidates, ~2 real, and the rule flagged
 * three genuinely distinct Hebrew-filtering bugs in one file on one day as
 * duplicates. Same-file-same-day-same-lane is a wave doing focused work, not
 * duplication. The only signal that held was the filer's OWN WORDS. So dedup
 * cannot be detected after the fact — it can only be DECLARED at write time,
 * and `invariant` is the field that carries that declaration. Refusing a row
 * with no invariant DECISION (a real slug, or the explicit word `none` for a
 * genuinely local bug) is what keeps the index in X164 meaningful instead of
 * drifting back to invisible.
 *
 * Usage:
 *   node scripts/ledger-file.cjs \
 *     --ref "some-slug" --lane matchmaker --source verify \
 *     --finding "…" --rootCause "src/foo.ts:120" --verdict built \
 *     --invariant "existing-slug-or-a-new-one" --note "…"
 *
 *   node scripts/ledger-file.cjs --ref "some-slug" --lane profiler --source github \
 *     --finding "…" --verdict needs-owner-decision --invariant none --recommend "decide — …"
 *
 *   node scripts/ledger-file.cjs --ref "some-slug" --invariant "a-new-principle" --confirm-new-invariant \
 *     --lane matchmaker --source verify --finding "…" --verdict built --rootCause "src/foo.ts:1"
 *
 *   # WRAP_UP.md step 12, the built -> wrapped companion (no writer existed for this either):
 *   node scripts/ledger-file.cjs --wrap-companion --ref "some-slug" --version 4.4.8 --sha abc1234
 *
 *   # WRAP_UP.md step 12, the GitHub <-> ledger sync row:
 *   node scripts/ledger-file.cjs --gh-sync --ref gh#200 --version 4.4.8 --ghstate closed \
 *     --note "Fixed in abc1234 (v4.4.8). One line on what changed."
 *   node scripts/ledger-file.cjs --gh-sync --ref gh#201 --version 4.4.8 --ghstate partial \
 *     --note "Landed X, still open Y." --recommend "build — the second half"
 *
 * Read-only checks: `node scripts/ledger-stats.cjs --index` / `--open` / `--by-invariant`.
 * This script only ever appends. It never rewrites or deletes a line.
 */
const fs = require('fs')
const path = require('path')

const LEDGER = path.join(__dirname, '..', '.claude', 'agent-loop', 'ledger.jsonl')

const argv = process.argv.slice(2)
const argOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
const flag = (name) => argv.includes(name)

const die = (msg, extra) => {
  console.error(`\nREFUSED — ${msg}\n`)
  if (extra) console.error(`${extra}\n`)
  process.exit(1)
}

// Same shape as architect-file.cjs's own check, same reason: a closing claim or
// a rootCause with nothing checkable behind it is a claim nobody can re-derive.
const POINTS_SOMEWHERE = /(:\d+)|(\bwf_[a-z0-9-]+)|(\.(?:ts|tsx|js|cjs|mjs|md|jsonl|json|yaml|sql)\b)|(\bnode |\bgit |\bnpm )/i

const KNOWN_LANES = new Set(['matchmaker', 'registrar', 'gatekeeper', 'instructor', 'profiler', 'slackmaster', 'diplomat', 'handyman', 'architect', 'cleaner', 'editor', 'framer', 'bouncer'])
const KNOWN_SOURCES = new Set(['github', 'logs', 'both', 'owner', 'audit', 'verify', 'engine', 'manager chat', 'unrecorded'])
// Every verdict actually in live use, mirrored from the ledger itself (measured
// 2026-08-05) MINUS the one retired spelling (`flagged-for-owner` — X77 renamed
// it `queued-next-run` because the retired word could not be ruled on). A brand
// new verdict nobody taught a lane to return is exactly the silent-drift class
// this whole file exists against, so this set is closed, not a suggestion.
const KNOWN_VERDICTS = new Set([
  'built',
  'already-fixed',
  'confirmed-other-lane',
  'needs-dependency',
  'blocked-charter',
  'needs-owner-decision',
  'needs-shaping',
  'queued-next-run',
  'declined',
  'converted',
  'deferred',
  'resend',
  'no-change-needed',
  'audit',
  'wrapped',
])
const RETIRED_VERDICTS = { 'flagged-for-owner': 'queued-next-run' }

/** Read every existing row once. Malformed lines are skipped, never fatal —
 * this script only ever ADDS a line; it must not refuse to run because an
 * earlier line (that it did not write) is bad. */
const readRows = () => {
  if (!fs.existsSync(LEDGER)) return []
  return fs
    .readFileSync(LEDGER, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

const append = (obj) => {
  fs.appendFileSync(LEDGER, JSON.stringify(obj) + '\n')
}

// ── the invariant vocabulary, harvested live, never hand-maintained ──────────
// Same discipline as bugger.js's own KNOWN_INVARIANTS (X22): a tag only earns
// its keep if it is reused, and a hand-kept list would drift from the ledger
// the moment anyone used this tool instead of typing JSON by hand.
const invariantVocab = (rows) => [...new Set(rows.map((r) => r.invariant).filter((v) => v && v !== 'none'))]

const tokenize = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  )
const jaccard = (a, b) => {
  const inter = [...a].filter((x) => b.has(x)).length
  const union = new Set([...a, ...b]).size
  return union ? inter / union : 0
}
/** The closest existing slugs to a candidate, by token overlap — cheap, explainable,
 * and it is checking the IDENTITY string a filer chose on purpose, never the free-text
 * finding (which is exactly the signal the coordinator's own test showed does not work). */
const nearestInvariants = (candidate, vocab) => {
  const t = tokenize(candidate)
  return vocab
    .map((v) => ({ v, score: jaccard(t, tokenize(v)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
}

if (argv.includes('--targets') || argv.length === 0) {
  console.log(`\nUsage — see the file header, or:\n  node ${path.basename(__filename)} --ref "…" --lane <lane> --source <source> --finding "…" --verdict <verdict> --invariant "<slug>|none"\n`)
  console.log(`Lanes: ${[...KNOWN_LANES].join(', ')}`)
  console.log(`Sources: ${[...KNOWN_SOURCES].join(', ')}`)
  console.log(`Verdicts: ${[...KNOWN_VERDICTS].join(', ')}`)
  const vocab = invariantVocab(readRows())
  console.log(`\nKnown invariants (${vocab.length}), most-used first — reuse one of these before minting a new slug:`)
  const rows = readRows()
  const counts = new Map()
  for (const r of rows) if (r.invariant) counts.set(r.invariant, (counts.get(r.invariant) || 0) + 1)
  for (const [v, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}x  ${v}`)
  process.exit(0)
}

// ── WRAP_UP.md step 12, act 1: the built -> wrapped companion ────────────────
// X158 fixed the CHECK for this; nothing made the ACT of writing it easy, so it
// kept getting done by hand, inconsistently — the exact shape that produced the
// verdict:"built" + state:"wrapped" mutation on one line that X158 had to learn
// to detect. One command, one correct shape, every time.
if (flag('--wrap-companion')) {
  const ref = argOf('--ref')
  const version = argOf('--version')
  const sha = argOf('--sha')
  if (!ref) die('no --ref.', 'Name the same ref the built row used.')
  if (!version) die('no --version.', 'The wrap this ships in, e.g. 4.4.8.')
  if (!sha) die('no --sha.', 'The commit this ref actually shipped in — `git log -1 --format=%h`.')
  const row = { date: new Date().toISOString().slice(0, 10), runId: `wrap-${version}`, ref, verdict: 'wrapped', state: 'wrapped', note: `shipped in ${sha}` }
  append(row)
  console.log(`\nAppended — ${ref} now has a wrapped companion row (wrap-${version}, ${sha}).\n`)
  process.exit(0)
}

// ── WRAP_UP.md step 12, act 2: the GitHub <-> ledger sync row ────────────────
if (flag('--gh-sync')) {
  const ref = argOf('--ref')
  const version = argOf('--version')
  const ghstate = argOf('--ghstate')
  const note = argOf('--note')
  const recommend = argOf('--recommend')
  let verdict = argOf('--verdict')
  if (!ref || !/^gh#\d+$/.test(ref)) die('--ref must be a bare ticket, `gh#<n>`.', 'A sub-ref like gh#200-a is a FINDING, not the ticket-level sync row this command writes.')
  if (!version) die('no --version.')
  if (!ghstate || !['closed', 'partial'].includes(ghstate)) die('--ghstate must be `closed` or `partial`.', 'This is the FACT GitHub shows — not a judgement.')
  if (!note || note.length < 10) die('no --note, or too short.', 'The exact text `gh issue close/comment` sent, verbatim — WRAP_UP.md:230: never a second, independent copy of the prose.')
  // X158's own rule: state is the fact, verdict/recommend is the judgement, and a
  // closed ticket is `wrapped`, never `built` — `built` means a fresh atomic fix and
  // a bare ticket ref carrying it wrongly demands a companion row nothing will mint.
  if (ghstate === 'closed') {
    verdict = 'wrapped'
    if (recommend) die('a CLOSED ticket takes no --recommend.', 'It is done; nothing is left to route back to a lane.')
  } else {
    if (!verdict && !recommend) die('a PARTIAL ticket needs --recommend or --verdict needs-owner-decision.', 'WRAP_UP.md:230 — pick the verb the comment\'s own "why" supports. Do not leave it silent.')
    if (verdict && verdict !== 'needs-owner-decision') die(`--verdict "${verdict}" is not valid for a partial sync row.`, 'Only `needs-owner-decision` is — for everything else, state it as --recommend instead.')
  }
  const row = { date: new Date().toISOString().slice(0, 10), runId: `wrap-${version}`, ref, state: ghstate, note }
  if (verdict) row.verdict = verdict
  if (recommend) row.recommend = recommend
  append(row)
  console.log(`\nAppended — ${ref} synced (${ghstate}, wrap-${version}).\n`)
  process.exit(0)
}

// ── the ordinary path: file a finding ─────────────────────────────────────────
const ref = argOf('--ref')
const lane = argOf('--lane')
const source = argOf('--source')
const finding = argOf('--finding')
const rootCause = argOf('--rootCause')
const verdictRaw = argOf('--verdict')
const invariant = argOf('--invariant')
const note = argOf('--note') || ''
const recommend = argOf('--recommend') || ''
const severity = argOf('--severity')
const state = argOf('--state') || ''
const confirmNew = flag('--confirm-new-invariant')

if (!ref) die('no --ref.', 'The bug\'s own identity — a ledger `ref`, e.g. a slug or `gh#<n>`.')
if (!finding || finding.length < 20) die(finding ? `--finding is ${finding.length} chars.` : 'no --finding.', 'State the defect, not the area.')
if (!source) die('no --source.', `One of: ${[...KNOWN_SOURCES].join(', ')}`)
if (!KNOWN_SOURCES.has(source)) die(`--source "${source}" is not known.`, `One of: ${[...KNOWN_SOURCES].join(', ')}`)
if (lane && !KNOWN_LANES.has(lane)) die(`--lane "${lane}" is not a known lane.`, `One of: ${[...KNOWN_LANES].join(', ')}`)
if (!verdictRaw) die('no --verdict.', `One of: ${[...KNOWN_VERDICTS].join(', ')}`)
if (RETIRED_VERDICTS[verdictRaw]) die(`--verdict "${verdictRaw}" is retired.`, `Use "${RETIRED_VERDICTS[verdictRaw]}" instead.`)
if (!KNOWN_VERDICTS.has(verdictRaw)) die(`--verdict "${verdictRaw}" is not known.`, `One of: ${[...KNOWN_VERDICTS].join(', ')}`)

// ── THE GATE. This is the whole point of building this file. ─────────────────
if (!invariant) die('no --invariant.', 'Pass an existing slug, a new one (see the suggestion this refusal would otherwise have to give you — run with `--targets` to list all known slugs), or the literal word `none` for a genuinely local bug that fits no wider principle. Silence here is what produced 23% coverage on 415 refs.')

const rows = readRows()
const vocab = invariantVocab(rows)
if (invariant !== 'none' && !vocab.includes(invariant)) {
  const near = nearestInvariants(invariant, vocab)
  if (near.length && near[0].score >= 0.4 && !confirmNew) {
    die(
      `"${invariant}" looks close to an existing invariant: "${near[0].v}" (${Math.round(near[0].score * 100)}% token overlap).`,
      `If this is the SAME promise, re-file with --invariant "${near[0].v}" — a fresh slug for a promise already tracked is how 43 identities became 415. ` +
        `If it genuinely is a different principle, re-run with --confirm-new-invariant to mint it anyway.\n` +
        `Other candidates: ${near.slice(1, 4).map((x) => `${x.v} (${Math.round(x.score * 100)}%)`).join(', ') || '(none)'}`,
    )
  }
  if (!confirmNew)
    console.log(`  (note: "${invariant}" is a NEW invariant — ${vocab.length} existed before this row. No close match found, minting it.)`)
}

if (verdictRaw === 'built' && !rootCause) die('a `built` verdict needs --rootCause.', 'file:line — the place the fix actually went, same bar as a lane\'s return contract.')
if (rootCause && !POINTS_SOMEWHERE.test(rootCause)) die('that --rootCause does not point at anything checkable.', 'Needs a `file:line`, a filename, or a `wf_…` id.')
if (verdictRaw === 'converted' && !/gh#\d+/.test(note)) die('a `converted` verdict needs a destination in --note.', 'Name the GitHub issue it moved to, e.g. "-> gh#155". A converted row with no destination closes the item here and leaves it findable nowhere (the exact failure this rule fixed in architect-file.cjs first).')
if ((verdictRaw === 'needs-owner-decision' || verdictRaw === 'blocked-charter' || verdictRaw === 'declined' || verdictRaw === 'deferred') && !recommend && !note)
  die(`a "${verdictRaw}" row needs --recommend or --note.`, 'A row he cannot rule on without re-opening the finding is not a row this ledger should accept (X77).')
if (severity && !['high', 'medium', 'low'].includes(severity)) die('--severity must be high, medium or low.')

const row = { date: new Date().toISOString().slice(0, 10), ref, lane: lane || '', source, finding, verdict: verdictRaw }
if (rootCause) row.rootCause = rootCause
if (invariant !== 'none') row.invariant = invariant
if (state) row.state = state
if (severity) row.severity = severity
if (recommend) row.recommend = recommend
if (note) row.note = note

append(row)
console.log(`\nAppended — ${ref} [${verdictRaw}]${invariant !== 'none' ? ` · ${invariant}` : ' · (no invariant — declared local)'}\n`)
console.log(`  finding : ${finding.slice(0, 120)}`)
if (rootCause) console.log(`  root    : ${rootCause}`)
console.log(`\nCheck it landed: node scripts/ledger-stats.cjs --lane ${lane || '""'}\n`)
