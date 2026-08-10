#!/usr/bin/env node
/**
 * check-closing-claims — gh#196.
 *
 * Nothing checked a GitHub closing/partial comment's factual claims against
 * what the ledger actually proves before it shipped. gh#194's closing
 * comment said *"the three live rows already corrupted by this bug were
 * cleaned up directly (data-only correction, no new sends)"* — the fix's own
 * ledger row (`approval-amend-routes-through-reschedule-not-merge`) says the
 * opposite, in its own words: *"Does NOT retroactively fix the 3 live rows
 * already corrupted before this fix landed... those need the owner's own
 * action."* Nothing backed the cleanup claim, and it was then copied
 * verbatim into the ledger's own gh-sync row too, so two false copies looked
 * corroborated.
 *
 * SCOPE — this is not general claim verification (that needs a reader who
 * understands the code; that is what the bouncer is for). It catches the ONE
 * mechanically checkable failure that actually produced gh#194's false
 * claim: the closing text POSITIVELY asserting something a ledger row for
 * the SAME ticket already states, in its own words, did NOT happen. A ticket
 * with no such negation on record is not checked by this at all — that gap
 * (a ticket with no ledger row whatsoever) is `ledger-stats.cjs --wrap`'s
 * GITHUB <-> LEDGER SYNC check, a different mechanism for a different gap.
 *
 * HOW THE MATCH WORKS, and why it is a heuristic rather than a proof: two
 * differently-phrased sentences about the same fact often share few words in
 * common, so this is scored by CONTAINMENT (shared content-word count over
 * the SMALLER side, after stripping stopwords and light suffix-stemming),
 * not a stricter measure — and it can be wrong in both directions. Per A7
 * ("bias toward blocking — a false block costs one pass, a false pass
 * ships"), a coincidental match costs one re-read; a real one caught here is
 * the whole reason this file exists. It ALSO isolates the negated CLAUSE on
 * the ledger side (splitting on `--`/`;` too, not only sentence stops)
 * before scoring — a ledger note's trailing "...those need the owner's own
 * action" clause is a SEPARATE claim from the negated one and dilutes the
 * match if left attached.
 *
 * Usage:
 *   node scripts/check-closing-claims.cjs --issue 194 --body-file <path>
 *   node scripts/check-closing-claims.cjs --issue 194 --body "<text>"
 * Exit 0  no contradiction found (or nothing on record to contradict).
 * Exit 1  the comment asserts something a ledger row for this ticket denies.
 */
const fs = require('fs')
const path = require('path')

const LEDGER = path.join(__dirname, '..', '.claude', 'agent-loop', 'ledger.jsonl')

const argv = process.argv.slice(2)
const argOf = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
}

const issue = argOf('--issue')
const bodyFile = argOf('--body-file')
const bodyArg = argOf('--body')
const explicitRefs = (argOf('--refs') || '').split(',').map((s) => s.trim()).filter(Boolean)
if (!issue || !/^\d+$/.test(issue)) {
  console.error('\nREFUSED — pass --issue <n>, a bare ticket number.\n')
  process.exit(1)
}
if (!bodyFile && !bodyArg) {
  console.error('\nREFUSED — pass --body-file <path> or --body "<text>", the exact comment about to ship.\n')
  process.exit(1)
}
const body = bodyArg || fs.readFileSync(bodyFile, 'utf8')

const rows = fs.existsSync(LEDGER)
  ? fs
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
  : []

// This ticket's own rows — TWO ways in, because a hand-run wave does not
// always tag a row's `ref` with the ticket number it closes (measured on
// gh#194 itself: `approval-amend-routes-through-reschedule-not-merge`, the
// exact row this check exists to catch, carries no "gh#194" anywhere in it —
// it is tied to the ticket only by the WRAP's own closing prose, which is a
// human judgement no script should re-derive). So:
//   (1) AUTO — ref is gh#<n> or gh#<n>-<slug>, or the note/finding names
//       gh#<n> explicitly. Free when the wave tagged things well.
//   (2) --refs — an explicit, comma-separated list of the OTHER ledger refs
//       this closing comment is actually about, named by whoever is drafting
//       it (they already know this from composing the comment in the first
//       place). Required whenever (1) alone would miss a row like the one
//       above — this script cannot guess a link the ledger itself never recorded.
const REF_RE = new RegExp(`^gh#${issue}(\\b|-)`)
const MENTIONS = new RegExp(`gh#${issue}\\b`)
const autoMatched = rows.filter((r) => REF_RE.test(String(r.ref || '')) || MENTIONS.test(String(r.note || '')) || MENTIONS.test(String(r.finding || '')))
const explicitMatched = explicitRefs.length ? rows.filter((r) => explicitRefs.includes(String(r.ref || ''))) : []
const ticketRows = [...new Map([...autoMatched, ...explicitMatched].map((r) => [JSON.stringify(r), r])).values()]

if (explicitRefs.length) {
  const found = new Set(explicitMatched.map((r) => r.ref))
  const notFound = explicitRefs.filter((r) => !found.has(r))
  if (notFound.length) {
    console.error(`\nREFUSED — --refs named ${notFound.length} ref(s) with NO row in the ledger: ${notFound.join(', ')}\n`)
    process.exit(1)
  }
}

if (!ticketRows.length) {
  console.log(`\ncheck-closing-claims — no ledger rows found for gh#${issue}. Not checked (a ticket with NO row at all is the GITHUB<->LEDGER SYNC check's job, not this one). If this ticket's rows are not tagged with "gh#${issue}", pass them explicitly: --refs "ref-one,ref-two".\n`)
  process.exit(0)
}

// ── cheap heuristic text matching — see the header for why this is scored
// by containment, not jaccard, and why the ledger side is clause-split. ──
const STOP = new Set([
  'a','an','the','and','or','but','if','then','than','this','that','these','those','is','was','were','are','be','been','being',
  'to','of','in','on','at','for','with','by','from','as','it','its','they','them','their','he','she','his','her','we','our','you','your','i',
  'not','no','nor','do','does','did','done','doing','have','has','had','having','will','would','can','could','should','must','may','might','shall',
  'up','down','out','off','over','under','again','further','once','here','there','when','where','why','how','all','any','both','each','few','more',
  'most','other','some','such','only','own','same','so','too','very','s','t','just','don','now','before','after','got',
])
const stem = (w) => w.replace(/(ing|edly|ed|ly)$/, '').replace(/s$/, '')
const tokenize = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2)
      .map(stem)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  )
const overlap = (a, b) => [...a].filter((x) => b.has(x)).length
const containment = (a, b) => (Math.min(a.size, b.size) ? overlap(a, b) / Math.min(a.size, b.size) : 0)

// Ledger clauses split harder than the comment: `--`/`;` too, so a trailing
// recommendation clause doesn't dilute the negated one it follows.
const splitClauses = (s) => String(s).split(/(?<=[.!?])\s+|\n+|\s*--\s*|;\s*/).map((x) => x.trim()).filter(Boolean)
const splitSentences = (s) => String(s).split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean)
const NEGATION = /\b(does not|doesn't|did not|didn't|never|has not|hasn't|have not|haven't|won't|will not|isn't|wasn't|were not|weren't|no such|not yet|still need|still needs|still open|not fix|not clean|not resolv|not retroactiv|remains? open|remains? uncorrect)\b/i

// Every negated CLAUSE from the ledger, across this ticket's own rows —
// `note` ONLY, deliberately. `finding` describes the BUG (the broken state
// BEFORE the fix), so it is negation-shaped by nature — "X never happens" is
// what a bug report IS — and an honest closing comment describing a fix
// necessarily echoes that same vocabulary while resolving it, not
// contradicting it (measured: scanning `finding` too flagged a truthful
// description of gh#194-c's own fix against gh#194-c's own bug report as a
// contradiction). `note` is where a lane records what it actually did and
// what it deliberately left standing — the ONLY field the real gh#194 defect
// lived in, and the only one this is scoped to.
const CONTAINMENT_MIN = 0.45
const OVERLAP_MIN = 5
const negatedClaims = []
for (const r of ticketRows) {
  if (!r.note) continue
  for (const clause of splitClauses(r.note)) {
    if (NEGATION.test(clause)) negatedClaims.push({ ref: r.ref, field: 'note', clause, tokens: tokenize(clause) })
  }
}

if (!negatedClaims.length) {
  console.log(`\ncheck-closing-claims — gh#${issue}: ${ticketRows.length} ledger row(s) checked, none carries an explicit "does not / still needs" clause to contradict. Nothing to check.\n`)
  process.exit(0)
}

// Every comment SENTENCE that is itself a positive assertion (no hedge/negation
// of its own) — only these can contradict a ledger negation. Quoted spans are
// blanked FIRST: this codebase's own convention (CLAUDE.md, every ledger note
// above) is to quote text VERBATIM to attribute or discuss it, never to assert
// it as the writer's own new claim — a correction comment that quotes the false
// claim in order to REFUTE it must not be read as repeating it.
const QUOTE_SPAN = /["“][^"”]*["”]/g
const commentSentences = splitSentences(body.replace(QUOTE_SPAN, ' ')).filter((s) => !NEGATION.test(s))
const hits = []
for (const c of commentSentences) {
  const ct = tokenize(c)
  for (const n of negatedClaims) {
    const ov = overlap(ct, n.tokens)
    const cont = containment(ct, n.tokens)
    if (ov >= OVERLAP_MIN && cont >= CONTAINMENT_MIN) hits.push({ comment: c, ledger: n, overlap: ov, containment: cont })
  }
}

if (hits.length) {
  console.error(`\nREFUSED — gh#${issue}'s closing text asserts something a ledger row for this ticket explicitly denies:\n`)
  for (const h of hits.sort((a, b) => b.containment - a.containment)) {
    console.error(`  COMMENT says : "${h.comment}"`)
    console.error(`  LEDGER (${h.ledger.ref}) says: "${h.ledger.clause}"  (${h.overlap} shared word(s), ${Math.round(h.containment * 100)}% containment)\n`)
  }
  console.error(`Do not post this comment as-is. Either the claim is wrong (fix the comment) or the ledger row is stale (re-read it and correct THAT first, then re-run this check).\n`)
  process.exit(1)
}

console.log(`\ncheck-closing-claims — gh#${issue}: ${ticketRows.length} ledger row(s), ${negatedClaims.length} negated claim(s) checked against ${commentSentences.length} comment sentence(s). No contradiction found.\n`)
process.exit(0)
