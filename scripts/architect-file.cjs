#!/usr/bin/env node
/**
 * architect-file — file a FRAMEWORK finding for the architect agent.
 *
 * Any chat that hits a problem in the framework itself — an engine that did
 * nothing while reporting success, a manifest that lied, a skill instruction
 * that contradicts the code — files it here instead of telling the owner and
 * hoping he relays it. He is not a message bus.
 *
 * This is for the FRAMEWORK, never for Maelle. A Maelle bug is a GitHub issue
 * or a report row and belongs to a lane. If your finding is about scheduling,
 * timezones, guards, email or anything a user experiences, you are in the wrong
 * script.
 *
 * Why a script rather than "append a JSON line":
 *   • It assigns the next A-number, so two chats filing at once cannot collide.
 *   • It REFUSES a row with no evidence. The bug ledger has the scout as a
 *     filter; this ledger has none, so the only defence against it filling with
 *     half-formed notes is that a bad row cannot be created in the first place.
 *   • One shape, so `ledger-stats` can read it.
 *
 * Append-only. Never rewrites an existing row — a completed row is TWO lines, the
 * filing and the closing, and `ledger-stats --architect` collapses them by id.
 *
 * Usage:
 *   node scripts/architect-file.cjs --close A29 \
 *     --built "no new mode — bugger.js PRESET path already is it; SKILL.md routes rulings back through `build`"
 *
 *   node scripts/architect-file.cjs --close A22 --declined "his words: not worth the second index"
 *
 *   node scripts/architect-file.cjs --recheck A26 --checked "read architect.md frontmatter — still session-cached"
 *
 *   node scripts/architect-file.cjs \
 *     --finding "the manifest reports plumbing health, not yield" \
 *     --evidence "wf_33541300-121: misroutedLanes 0 and waveFilesNamed 1 while 1 of 4 findings was dispatchable" \
 *     --target both-engines \
 *     --source "product chat" \
 *     [--note "fix shape: a yield line"] \
 *     [--amends A8 | --amends none]
 *
 *   node scripts/architect-file.cjs --targets     # list valid targets
 */
const fs = require('fs')
const path = require('path')

const LEDGER = path.join(__dirname, '..', '.claude', 'agent-loop', 'architect-ledger.jsonl')

const TARGETS = [
  'bugger.js',
  'feature.js',
  'charter-audit.js',
  'both-engines',
  'SKILL.md',
  'SESSION_STARTER.md',
  'charter',
  'ledger',
  'scripts',
  'state',
  'process',
]

const argv = process.argv.slice(2)
const argOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}

if (argv.includes('--targets')) {
  console.log(`\nValid --target values:\n  ${TARGETS.join('\n  ')}\n`)
  process.exit(0)
}

const finding = argOf('--finding')
const evidence = argOf('--evidence')
const target = argOf('--target')
const source = argOf('--source') || 'unnamed chat'
const note = argOf('--note') || ''
const amends = argOf('--amends') || ''
const closeId = argOf('--close')
const built = argOf('--built')
const declined = argOf('--declined')
const recheckId = argOf('--recheck')
const checked = argOf('--checked')

const die = (msg, extra) => {
  console.error(`\nREFUSED — ${msg}\n`)
  if (extra) console.error(`${extra}\n`)
  process.exit(1)
}

// Evidence must POINT somewhere — for a filing, and for a closing row too. The
// owner is exempt on a FILING: when he reports a problem his account IS the
// evidence and demanding a file:line from him is nonsense. There is no exemption
// on a CLOSING: "it is done" with nothing to check is the row this ledger keeps
// producing.
const POINTS_SOMEWHERE = /(:\d+)|(\bwf_[a-z0-9-]+)|(\.(?:js|cjs|ts|md|log|jsonl|json|yaml)\b)|(\bnode |\bgit |\bnpm )/i

// ---- read what exists, collapsing each id to its LATEST state ---------------
// A41 · append-only means one id legitimately has several lines: the filing, then
// the closing. Every check below asks "what is this row's state NOW", so it reads
// the collapsed view — otherwise a built row still matches the OPEN clash check
// and every re-file is refused with "still open" about work that shipped. Same
// merge `ledger-stats --architect` does, for the same reason.
let rows = []
if (fs.existsSync(LEDGER)) {
  const latest = new Map()
  fs.readFileSync(LEDGER, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .forEach((l) => {
      let r = null
      try {
        r = JSON.parse(l)
      } catch {
        return
      }
      if (r && r.id) latest.set(r.id, { ...(latest.get(r.id) || {}), ...r })
    })
  rows = [...latest.values()]
}
const CLOSED = new Set(['built', 'declined'])
const stillOpen = (rs) => rs.filter((r) => !CLOSED.has(r.verdict)).length

// ── A41 · CLOSE A ROW. The ledger had no way to record that work was DONE ────
// A44 · and no way to record that the owner said NO. `--built` was the only
// closing, so the two `declined` rows in this ledger (A4, A13) were typed in by
// hand at migration and every decline since would have been too — which is the
// same hole one direction along: a ruling nobody can write down gets re-raised,
// and re-raising a decision he already made is the failure the whole ledger
// exists to stop. A decline takes `--declined "<his reason>"` and is deliberately
// NOT held to `POINTS_SOMEWHERE`: his ruling IS the evidence, exactly as it is on
// a filing, and demanding a file:line from a "no" is nonsense.
// Sixteen rows read `open` on 2026-07-30 with their mechanisms shipped, because
// nothing could write a completion — the 19 rows that read `built` had that value
// typed in by hand at migration. So `--open` counted finished work as live
// decisions, and every number built on it (the report headline, the decision
// budget, the confirmed-vs-re-read split) was computed off a set that was 84%
// done.
//
// It APPENDS. Rewriting the filing row would delete the finding, the evidence and
// the analysis that are the whole point of keeping a ledger.
//
// `--built` is REQUIRED and must point somewhere, because a completion with no
// evidence is worse than an open row: it closes the item here and leaves the
// proof nowhere. Name what shipped and WHERE.
if (closeId) {
  if (!rows.length) die('the ledger is empty — there is nothing to close.')
  const row = rows.find((r) => r.id === closeId)
  if (!row) die(`--close ${closeId} is not a row in this ledger.`, `Read it with: node scripts/ledger-stats.cjs --architect`)
  if (CLOSED.has(row.verdict))
    die(
      `${closeId} is already ${row.verdict} (${row.date}).`,
      `It says: ${String(row.built || row.declined || row.note || '(no closing evidence recorded)').slice(0, 200)}\n` +
        `If the work has MOVED or come undone, that is a new finding — file it with --amends ${closeId}.`,
    )
  if (built && declined) die('--close takes --built OR --declined, never both.', 'Work that shipped is `built`. A ruling against it is `declined`. One row cannot be each.')
  if (!built && !declined)
    die(
      `no --built and no --declined.`,
      'A build closing names what shipped and WHERE. A closing row with no evidence destroys the history this ledger exists for.\n' +
        'Cite the FILE AND THE THING — `bugger.js manifest.carry`, `SKILL.md the wrap step` — not only a line number.\n' +
        'A line drifts with the next edit: nineteen rows closed on 2026-07-30 went 9 lines stale the same hour, from one later edit above them.\n' +
        'If the OWNER ruled against it, that is `--declined "<his reason>"` — his words, no citation needed.',
    )
  if (built && built.length < 20) die(`--built is ${built.length} chars.`, 'Too short to check. Cite the file and the symbol, the command, or the commit.')
  if (built && !POINTS_SOMEWHERE.test(built))
    die(
      'that --built does not point at anything checkable.',
      `It needs at least one of: a \`file:line\`, a filename, a run id (\`wf_…\`), or the command that proves it.\n` +
        `"done" and "shipped" are not closings — the next reader must be able to open the thing you built.`,
    )
  if (declined && declined.length < 20)
    die(`--declined is ${declined.length} chars.`, 'Give his reason, not just "no". The next reader must be able to tell a decline from a deferral without asking him again.')
  const closing = built
    ? { id: closeId, date: new Date().toISOString().slice(0, 10), verdict: 'built', built }
    : { id: closeId, date: new Date().toISOString().slice(0, 10), verdict: 'declined', declined }
  fs.appendFileSync(LEDGER, JSON.stringify(closing) + '\n')
  const openNow = stillOpen(rows.map((r) => (r.id === closeId ? closing : r)))
  console.log(`\nClosed ${closeId} — ${closing.verdict}\n`)
  console.log(`  was    : ${String(row.finding || '(no finding)').slice(0, 120)}`)
  console.log(`  ${built ? 'built  ' : 'declined'}: ${built || declined}`)
  console.log(`\n${openNow} row(s) still open. Check with: node scripts/ledger-stats.cjs --architect\n`)
  process.exit(0)
}

// ── A47 · RECORD THAT SOMEBODY LOOKED ────────────────────────────────────────
// A38 flags a row RE-READ when a commit touched the file it cites after the row
// was written. Nothing could record the answer "I opened it, it is still real",
// so a row re-read today was flagged again tomorrow and the re-read had to be
// paid again — which is what makes a nightly backlog pass unaffordable rather
// than cheap.
//
// It is the row's own DATE that the staleness check compares, so the confirmation
// is simply a later date: `{id, date, recheck}` and nothing else. NO verdict, on
// purpose — the reader merges by id, so omitting it keeps the row's real state
// (`open` stays open) instead of a confirmation quietly re-writing the verdict.
// `recheck` is what you read, so the next reader can tell a real look from a
// rubber stamp.
if (recheckId) {
  const row = rows.find((r) => r.id === recheckId)
  if (!row) die(`--recheck ${recheckId} is not a row in this ledger.`, `Read it with: node scripts/ledger-stats.cjs --architect`)
  if (CLOSED.has(row.verdict)) die(`${recheckId} is already ${row.verdict} (${row.date}).`, 'A closed row is not re-read. If the work has come undone, file it with --amends ' + recheckId + '.')
  if (!checked) die('no --checked.', 'Name what you OPENED. A confirmation nobody can check is worse than the stale flag it clears.')
  if (checked.length < 20) die(`--checked is ${checked.length} chars.`, 'Cite the file and the symbol you read, and what you found there.')
  if (!POINTS_SOMEWHERE.test(checked))
    die('that --checked does not point at anything.', 'Name the file you opened — `bugger.js the PRESET branch`, `SKILL.md the wrap step`. "still real" alone is a rubber stamp.')
  const confirm = { id: recheckId, date: new Date().toISOString().slice(0, 10), recheck: checked }
  fs.appendFileSync(LEDGER, JSON.stringify(confirm) + '\n')
  console.log(`\nConfirmed ${recheckId} — still ${row.verdict}, re-read ${confirm.date}\n`)
  console.log(`  finding : ${String(row.finding || '(no finding)').slice(0, 120)}`)
  console.log(`  checked : ${checked}`)
  console.log(`\nIt stays OPEN and will no longer print as RE-READ until the code it cites moves again.\n`)
  process.exit(0)
}

if (!finding) die('no --finding.', 'One sentence: what is wrong. Not a topic — a defect.')
if (finding.length < 25) die(`--finding is ${finding.length} chars.`, 'Too short to act on. State the defect, not the area.')
if (!target) die('no --target.', `One of:\n  ${TARGETS.join('\n  ')}`)
if (!TARGETS.includes(target)) die(`--target "${target}" is not a known target.`, `One of:\n  ${TARGETS.join('\n  ')}`)
if (!evidence) die('no --evidence.', 'A framework finding without evidence is a hunch, and the architect has no scout to filter it.')
if (evidence.length < 30) die(`--evidence is ${evidence.length} chars.`, 'Cite the thing you actually saw.')

if (!/owner/i.test(source) && !POINTS_SOMEWHERE.test(evidence)) {
  die(
    'that --evidence does not point at anything checkable.',
    `It needs at least one of: a \`file:line\`, a run id (\`wf_…\`), a filename, or the command you ran.\n` +
      `The architect must be able to re-derive your finding rather than take it on trust.\n` +
      `If you are the owner reporting what you saw, pass --source owner.`
  )
}

// ---- assign the next id, check for an obvious re-file ----
const maxId = rows.reduce((n, r) => {
  const m = String(r.id || '').match(/^A(\d+)$/)
  return m ? Math.max(n, Number(m[1])) : n
}, 0)
const id = `A${maxId + 1}`

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
const head = norm(finding).slice(0, 45)

// ── A40 · THE CLASH CHECK, both directions ──────────────────────────────────
// It used to skip `built` and `declined` rows entirely, which is exactly
// backwards for the most expensive mistake this ledger can hold. Re-filing an
// OPEN row wastes a triage slot. Re-filing a BUILT one sends a lane to build a
// mechanism that already exists — and it happened: A30 was filed on 2026-07-30
// claiming the verify's discovery routing did not exist, while A8 had shipped
// exactly that on 2026-07-27. The filer said nothing, because A8 was built. This
// ledger has no scout in front of it, so this check IS the filter, and its hole
// sat precisely where the framework's memory lives.
//
// An open clash still REFUSES — that is unchanged and it is right.
// A closed clash is usually an AMENDMENT: the mechanism exists and the policy on
// top of it is wrong, which is what A30 turned out to be. So it asks for the link
// instead of refusing outright, because refusing outright would lose real rows.
const openClash = rows.find((r) => !CLOSED.has(r.verdict) && norm(r.finding).slice(0, 45) === head)
if (openClash) {
  console.error(`\nREFUSED — this looks like a re-file of ${openClash.id} (still ${openClash.verdict}):\n`)
  console.error(`  ${openClash.id}: ${String(openClash.finding).slice(0, 140)}\n`)
  console.error(`If it is genuinely new, say what is different in --finding. If it is the same problem`)
  console.error(`recurring with new information, that belongs on ${openClash.id} — hand it to the owner to add.\n`)
  process.exit(1)
}

// TWO detectors, one destination. The 45-char head is exact and catches a
// near-verbatim re-file; it could never have caught A30 against A8, which share
// no opening at all. So the second detector is by DISTINCTIVE TERM: a word this
// ledger rarely uses, shared between the new finding and a closed row.
//
// A45 · the corpus is the closed row's `finding` + `note` + **`built`** — what
// shipped, not only what was wrong. The question this detector exists to answer is
// "does that mechanism already EXIST", and the sentence that describes the
// mechanism is the closing one; `built` did not exist as a field until 2026-07-30,
// so it could only ever match the complaint. MEASURED across all 43 rows: adding
// it leaves the flag rate identical at 87 total flags, and moves WHICH rows are
// named — A30's text now also reaches A41 and A11's stops matching A30 on
// `bugger/warned`. Same cost, better aim.
//
// Both thresholds are MEASURED, not chosen, and they are the ONLY pair that still
// works: `df <= 10% of rows` with `>= 2 shared` names A8 for A30's exact text, and
// every tightening measured on 2026-07-30 (shared >= 3, or df <= 7%, or df <= 5%)
// loses A8 — the one case this detector was built for. So the rate is what it is:
// **2.02 flags per filing, 32 of 43 filings refused once.** The comment here used
// to claim 0.6, measured when 19 rows were closed; 40 are closed now and the pool
// it matches against doubled. A refusal costs one re-run with `--amends none`.
// The 10% is relative so it does not decay further as the ledger grows.
const STOP = new Set(
  ('the a an and or of to in on for it its is are was were be been that this those these so no not but with as at by from into than then when where which who whom whose what while has have had do does did can could may might must shall should will would if else there their they them his her our your my me we us you i one two also only even just about after before over under again more most less least other another same such per via yet own too very'.split(
    ' ',
  )),
)
const terms = (s) => new Set((String(s || '').toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w)))
// One corpus function, used for the rarity count AND for the per-row match, so a
// word cannot be "rare" by one definition and matched by another.
const corpusOf = (r) => `${r.finding} ${r.note} ${r.built || ''} ${r.declined || ''}`
const df = new Map()
for (const r of rows) for (const w of terms(corpusOf(r))) df.set(w, (df.get(w) || 0) + 1)
const RARE = Math.max(2, Math.ceil(rows.length * 0.1))
const mine = [...terms(finding)].filter((w) => (df.get(w) || 0) <= RARE)
const related = []
for (const r of rows) {
  if (!CLOSED.has(r.verdict)) continue
  const theirs = terms(corpusOf(r))
  const shared = norm(r.finding).slice(0, 45) === head ? ['the same opening sentence'] : mine.filter((w) => theirs.has(w))
  if (shared.length >= 2 || shared[0] === 'the same opening sentence') related.push({ r, shared })
}
if (related.length && !amends) {
  console.error(`\nREFUSED ONCE — ${related.length} row(s) already CLOSED cover ground this finding names:\n`)
  for (const { r, shared } of related)
    console.error(`  ${r.id} [${r.verdict} ${r.date}] shares ${shared.slice(0, 4).join(', ')}\n     ${String(r.finding).slice(0, 130)}`)
  console.error(`\nA match against a built row is usually an AMENDMENT — the mechanism exists and the`)
  console.error(`POLICY on top of it is wrong. Read the row, then re-run with ONE of:`)
  console.error(`  --amends <id>    it amends that row; the link is recorded and stays greppable`)
  console.error(`  --amends none    you read them and it is genuinely unrelated\n`)
  process.exit(1)
}
if (amends && amends !== 'none' && !rows.some((r) => r.id === amends)) die(`--amends ${amends} is not a row in this ledger.`, 'Pass an existing A-number, or `--amends none`.')

const row = {
  id,
  date: new Date().toISOString().slice(0, 10),
  source,
  target,
  finding,
  evidence,
  verdict: 'open',
  note,
}
// A11 · an id names its parent. Recorded as a field rather than left in the
// terminal output, so the link survives the chat that noticed it.
if (amends && amends !== 'none') row.amends = amends

fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n')

console.log(`\nFiled ${id} — target ${target}, from ${source}\n`)
console.log(`  finding : ${finding}`)
console.log(`  evidence: ${evidence}`)
if (row.amends) console.log(`  amends  : ${row.amends}`)
if (note) console.log(`  note    : ${note}`)
console.log(`\nIt is OPEN. The architect reads its own ledger, triages, and proposes —`)
console.log(`nothing gets built off this row until the owner approves it.\n`)
console.log(`When it IS built, close it here — an open row that shipped is why this ledger read 19 open when 3 were:`)
console.log(`  node scripts/architect-file.cjs --close ${id} --built "<what shipped, with the file:line>"\n`)
