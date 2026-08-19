export const meta = {
  name: 'bugger',
  description:
    'Bugger — builds a set of atomic issues across SEVERAL lanes, with dependency hand-off and ONE combined verify. Pass `args.issues` (already lane-assigned, e.g. rows the owner approved from report.md) and it goes straight to work — the editor is SKIPPED. Pass `args.sources` for a run that has to FIND its work — the default is all three: `github` + `logs` find new work, and `backlog` re-reads the open rows whose code has moved and builds nothing. For ONE lane whose items are already known, do NOT use this at all — dispatch that lane directly with the Agent tool; the pipeline buys nothing and costs a full intake. Core loop: rounds of [code lanes in parallel -> context last] until no dependency asks remain, then one adversarial verify over the combined diff. Builds in the working tree; NEVER commits (the owner wraps).',
  phases: [
    { title: 'Intake' },
    { title: 'Build' },
    { title: 'Context' },
    // X151 · the bounce round and its re-check live INSIDE Verify, not a fifth
    // box of their own — they are the same stage (the gate reads, sends back,
    // re-reads), and a separate 'Bounce' title read as an empty box on every
    // clean run, which looks like a run that did not finish. What still needs
    // to be readable once they share a box: `rebuild:<lane>(N)` names a lane's
    // second attempt, `bouncer:wave(N)` the first pass, `bouncer:recheck(N)`
    // the second — distinct from a first-time `Build`/`Context` dispatch,
    // which (X168) carries its own item count and a `dep:` PREFIX on any
    // round after the first: `matchmaker(5)` is fresh, `dep:matchmaker(2)` is
    // the same lane answering a dependency round, never guessed at from the
    // panel.
    { title: 'Verify' },
  ],
}

// ---- args (all optional; the Manager passes them) ----
// ---- arg hygiene: a MALFORMED arg must never look like an ABSENT one -------
// Every array arg used to be read as `Array.isArray(x) ? x : []`, which converts
// "the caller passed something broken" into "the caller passed nothing" and says
// nothing at all. On 2026-07-27 the Manager passed 11 `alreadyBuilt` refs, the
// manifest printed `passedIn: 0`, and a lane was dispatched in full to answer
// "already-fixed" — the entire price of a bug, paid for a shape error.
const argWarnings = []

// X6 · GUARD THE CONTAINER, NOT ONLY THE VALUES. The Workflow tool can deliver
// the whole `args` OBJECT as one string — and then every `A.<key>` below reads
// `undefined`, nothing is "present but wrong-shaped", the per-key guard has
// nothing to fire on, and the engine takes its default path in total silence.
// That is how one described item became a 32-agent sweep in feature.js on
// 2026-07-28. The first version of this fix guarded the values and missed the
// container, which is why the bug survived a day after being "fixed".
let A = args || {}
if (typeof A === 'string') {
  try {
    A = JSON.parse(A)
    // X147 · NOT a warning. Two separate real Workflow invocations (wf_386bf586-bf1,
    // wf_ad941677-935) both hit this path despite the Manager passing a normal
    // object in the tool call each time — the TOP-LEVEL `args` container arrives
    // pre-serialized on this specific boundary, which the caller cannot avoid by
    // writing the call differently. A warning that fires on every dispatch
    // regardless of what the caller does is not diagnostic, it is noise — and
    // noise trains the reader to stop reading the channel it rides on. Recovery
    // stays (this container really can be malformed, and that case still throws
    // below); only the "you did something wrong" framing is gone. Contrast the
    // PER-KEY case in `asArray` below, which stays a warning: a caller CAN
    // stringify one array while leaving the rest of the object normal, so that
    // one distinguishes a real mistake from a structural harness behaviour.
  } catch (e) {
    throw new Error(`args arrived as a string and is not valid JSON, so nothing it named could be honoured: ${String((e && e.message) || e)}`)
  }
  // X162 · a string that PARSES cleanly to a non-object (a number, an array, null,
  // a bare string) is exactly as unusable as a parse failure — every `A.<key>` below
  // would read `undefined` (or crash outright on `null`) and the engine would take
  // its default path in total silence, which is the exact failure X6 guards the
  // CONTAINER against. Refuse it the same way, before anything spawns.
  if (A === null || typeof A !== 'object' || Array.isArray(A))
    throw new Error(
      `args arrived as a string that parsed to ${A === null ? 'null' : Array.isArray(A) ? 'an array' : `a ${typeof A}`}, not an object — nothing it might have named could be honoured. Pass the args object directly, not a JSON-encoded scalar or array.`,
    )
}

// X11 · STOP where a silent default is EXPENSIVE; warn where it is cheap.
// Owner, 2026-07-28: don't abort a wave, it is slow and costly. Correct — but
// this runs before a single agent spawns, so stopping HERE is free, and the one
// arg worth stopping for is `issues`: malformed, it silently becomes null and the
// engine runs a FULL GitHub pull plus a log review instead of the rows he named.
// That is the 76k-on-intake failure, reachable by a typo. Everything else
// degrades cheaply — a lost `priorClean` only re-verifies settled ground — so it
// warns and continues. Abort before the wave, never during it.
const asArray = (name, v, critical) => {
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      if (Array.isArray(parsed)) {
        argWarnings.push(`\`${name}\` arrived as a JSON STRING rather than an array — recovered ${parsed.length} entr${parsed.length === 1 ? 'y' : 'ies'} by parsing it. Pass it as a real array in the tool call.`)
        return parsed
      }
    } catch {
      /* fall through */
    }
  }
  if (critical)
    throw new Error(
      `args.${name} is present but is a ${typeof v}, not an array — refusing to fall back to a default that ignores it. ` +
        `For \`${name}\` that default would run a full discovery pass instead of the work you named. Nothing has been dispatched; re-invoke with a real array.`,
    )
  argWarnings.push(`\`${name}\` was PASSED but is not an array (got ${typeof v}) — IGNORED, and whatever it held never reached the run.`)
  return []
}

// A pre-triaged list — the door from `report.md` back INTO the builder. Without
// it the parked items had no path in at all: intake reads GitHub and the logs,
// and neither can see the report. The owner would have had to re-file 30 issues
// by hand to act on his own review, which makes the review pointless.
// These are already lane-assigned, so intake and triage are skipped entirely —
// paying to re-derive routing he has already approved is pure waste.
// Read BEFORE `sources`, because what this holds decides what the source default
// may be: a preset skips the editor, so it must never default a source in.
const presetArg = asArray('issues', A.issues, true) // critical: the silent default is a full discovery pass
const sourcesArg = asArray('sources', A.sources)
// A discovery run does ALL THREE. Owner, 2026-07-30: *"put backlog in every run"* —
// new bugs and old bugs all need resolving and the difference between them is
// bookkeeping. What makes it affordable is X38's staleness marking: only the rows
// whose code has MOVED need re-reading, so the set is small by construction, and a
// re-read produces a closure or a confirmation rather than a decision.
// Empty on a preset: `args.issues` skips the editor, so a source named there could
// only be a source that never ran.
const SOURCES = sourcesArg.length ? sourcesArg : presetArg.length ? [] : ['github', 'logs', 'backlog']
// ── X42 · THE THIRD INPUT ────────────────────────────────────────────────────
// Owner, 2026-07-30: *"its make sense that the input can be github/logs or just
// reports overview, isnt it smarter."* The engine had three possible inputs and two
// were wired. GitHub is what he filed, logs are what she did, and the BACKLOG is
// what we already know and have not settled — the largest of the three (52 open
// rows, 28 of them flagged RE-READ once X59 widened the trigger from *the code
// moved* to *nobody has ever looked*) and the only one with no door. So the
// input that needs the funnel most was the one worked by hand, and a hand pass gets
// no editor, no counts, no manifest, no `inFlight` and no report persistence.
//
// The editor ALREADY does this class of work — it matches findings against
// `alreadyBuilt` and `openKnown` and drops what is settled — so re-reading a
// flagged row is the same skill pointed inward. One new SOURCE, not a new mode.
//
// It runs WITH `logs`, every night. There was a refusal here that forbade the
// pair, and its comment credited the owner — wrongly: he gave the third input, and
// the "never with logs" half was the architect's own reasoning filed under his
// name. His actual ruling, 2026-07-30, is the opposite: *"put backlog in every
// run."* A re-read does not compete with a discovery pass for his attention
// because it does not produce decisions — it produces closures, confirmations, and
// only occasionally a question. The two guards that DO earn their place are kept
// below: an unevidenced `fixed` never reaches `closeInLedger`, and a row citing no
// file is named for a hand read instead of burning a lane every night.
//
// The set is VALIDATED now. It never was, so `sources:['gihub']` produced a brief
// with no source block at all — a run that finds nothing while reporting success,
// which is the exact class every other guard in this file exists for. Adding a
// third value to an unchecked set is what makes that typo reachable.
const KNOWN_SOURCES = new Set(['github', 'logs', 'backlog'])
const unknownSources = SOURCES.filter((s) => !KNOWN_SOURCES.has(s))
if (unknownSources.length)
  throw new Error(
    `args.sources names ${unknownSources.length} unknown source(s): ${unknownSources.map((s) => `"${s}"`).join(', ')}. ` +
      `Valid: ${[...KNOWN_SOURCES].join(', ')}. An unknown source produces an editor brief with nothing in it, so the run would find nothing and report success. Nothing has been dispatched.`,
  )
const BACKLOG = SOURCES.includes('backlog')
const SINCE = A.sinceIso || 'the last run' // watermark for the log review
// The watermark in UTC, so the manifest can check the editor compared against the
// right instant rather than guessing from a line number. Empty when no ISO
// watermark was passed (the first run, or a manual one).
const WATERMARK_UTC = Number.isFinite(Date.parse(SINCE)) ? new Date(Date.parse(SINCE)).toISOString() : ''
const WATERMARK_DAY = WATERMARK_UTC ? SINCE.slice(0, 10) : '' // local day — log files are named by local date
// Severity-first build cap per run. 250, his call 2026-08-02, raised from 100:
// the cap protects against runaway COST, which he has explicitly said he does
// not care about for a wave that fixes the bugs — and one reported bug legitimately
// decomposes into several atomic issues, so ten tickets plus a backlog can reach
// three figures without anything being wrong. The round cap below is the guard
// that actually matters, and it came DOWN in the same change.
const CAP = typeof A.capBuilds === 'number' ? A.capBuilds : 250
// X42 · `sources` and `issues` are different doors, and `backlog` must never be
// passed through both: a preset SKIPS the editor, so the re-read would never run
// while `manifest.backlog` reported a backlog pass with zero rows — a mechanism
// that did nothing and looked like success. Refused before anything spawns. Only
// an EXPLICIT `sources:['backlog']` can reach this now — the default cannot, since
// a preset defaults to no sources at all.
if (BACKLOG && presetArg.length)
  throw new Error(
    `args.sources names \`backlog\` and args.issues carries ${presetArg.length} row(s). A preset skips the editor, so the backlog re-read could not run. ` +
      `Pick one: \`sources:['backlog']\` to re-read the stale rows, or \`issues:[…]\` to build the ones he approved. Nothing has been dispatched.`,
  )
// Bugs already FIXED but not yet in the running build. Production keeps
// emitting the same tape until a fix is deployed, so every unattended night the
// log review honestly re-finds work the previous run already did. The lane does
// catch it and return `already-fixed` — but only after a full dispatch, which is
// the whole cost of the bug paid again for no result.
//
// Read from `ledger.jsonl`, which is why each line carries a `ref` and a proven
// `rootCause`: prose alone makes this a fuzzy guess, a ref makes it a lookup.
// Shape: [{ref, symptom, rootCause, state}].
const ALREADY_BUILT = asArray('alreadyBuilt', A.alreadyBuilt)
// Items that LEFT the bug track and settled as a DECISION rather than a fix —
// two verdicts, both belong here: `converted` into a GitHub issue where the
// design question is being worked, or `declined` — he ruled directly that it is
// not a bug, or not worth fixing. Distinct from ALREADY_BUILT in the way that
// matters: nothing is fixed, so the symptom recurs INDEFINITELY rather than only
// until the next deploy. Without this list a settled decision comes back every
// night as a fresh bug, which is the failure that re-raised 24 of his rulings on
// 2026-07-26 — and until X190, `declined` specifically: it sat on NEITHER this
// list (converted only) NOR `openBacklog` (which correctly excludes it), so a
// declined bug rediscovered by an automated pass had no dedup surface at all and
// could be built as if brand new.
//
// His rule on a decline's durability: it must never resurface on its own —
// "otherwise it will be surfacing again and again" — UNLESS the owner himself
// restates it (his own act, not an automated rediscovery). So a `declined` entry
// here is not a pure drop like `converted`: the editor branches on the MATCHING
// finding's own `source` (see the dispatch brief below and editor.md E12/E2) — a
// bare `logs` rediscovery can never override it; anything else (`github`,
// `owner`, `both`) is his own act reaching the editor again and does.
//
// `state` on every entry is the row's own VERDICT WORD (`'converted'` or
// `'declined'`) — set that explicitly when deriving this list, never copy the
// ledger row's raw `state` column, which tracks something else entirely (a
// `converted` row can carry `state:'built'`, a `declined` row `state:'open'`)
// and would tell the editor nothing about which behaviour applies.
//
// X51 · a `deferred` row is NOT one of these and must never be passed here. His
// ruling, 2026-07-30: *"defer for tomorrow or anything like this means defer to
// next run — the only thing we need is don't do it now."* A deferral is a ONE-RUN
// skip, and since the ledger is only appended during and after a run, every
// `deferred` row standing when a run starts was deferred by an earlier one and is
// due by definition. Listing it here tells the editor to drop work he asked for.
// Shape: [{ref, symptom, state, note}].
//
// ENFORCED here, not only written in SKILL.md and editor.md. The rule that lived in
// prose alone is the rule that broke: the derivation said `deferred` + `converted`,
// the engine took whatever it was handed, and nothing could tell that a due row had
// been listed as droppable. So a `deferred` entry is REMOVED from the drop list and
// NAMED — the run continues with it as ordinary due work, which is his ruling.
const openKnownRaw = asArray('openKnown', A.openKnown)
const isDeferredRow = (o) => o && typeof o === 'object' && /^deferred/i.test(String(o.state || o.verdict || ''))
const openKnownDeferred = openKnownRaw.filter(isDeferredRow)
const OPEN_KNOWN = openKnownRaw.filter((o) => !isDeferredRow(o))
if (openKnownDeferred.length)
  argWarnings.push(
    `${openKnownDeferred.length} \`openKnown\` entr${openKnownDeferred.length === 1 ? 'y was' : 'ies were'} \`deferred\` and ${openKnownDeferred.length === 1 ? 'was' : 'were'} REMOVED from the drop list: ${openKnownDeferred
      .map((o) => o.ref || '(no ref)')
      .join(', ')}. A deferral is a ONE-RUN skip, so ${openKnownDeferred.length === 1 ? 'it is' : 'they are'} due NOW and the editor must see ${openKnownDeferred.length === 1 ? 'it' : 'them'} as work. \`openKnown\` is \`converted\` and \`declined\` rows — derive it that way next time.`,
  )
// X176 · A THIRD LIST, WITH A THIRD BEHAVIOUR. `alreadyBuilt` and `openKnown` are
// DROP lists — a match means the finding is already handled and must not reach a
// lane. Neither ever carried a row that is simply still OPEN: not yet built, not
// converted, just sitting on his desk or in the backlog. So a bug he already
// reported, unbuilt, was invisible to intake and got re-found under a BRAND-NEW
// ref every time it recurred — `dateverifier-hebrew-false-positive` (open since
// 2026-07-28) and `log-dateverifier-falsepos-confirmed` (built 2026-08-03, same
// rootCause `src/utils/dateVerifier.ts:187`) were the same bug under two ledger
// identities, reconciled only by the owner noticing by hand.
//
// His shape, and it deliberately does NOT mirror the two drop lists: intake NAMES
// a match here, it NEVER DROPS one. A fresh finding matching an open backlog row is
// evidence that row is still real, carrying tonight's fresh proof — the exact
// treatment `editor.md` E12 already gives a `backlog`-source RE-READ match, now
// extended to every finding on every run, because the general open backlog was
// never visible to intake at all outside a `backlog` source.
//
// Shape: [{ref, symptom, rootCause, invariant, state}] — same as the two lists
// above, and it is meant to be the WHOLE open ledger (`ledger-stats --open`),
// which already excludes anything built/converted/declined/audited. Parsed here,
// before the drop lists' ref sets exist below, so it can be checked against them.
const OPEN_BACKLOG_RAW = asArray('openBacklog', A.openBacklog)
// X22 · THE SLUG VOCABULARY, harvested rather than passed. A tag only earns its
// keep if three lanes name one principle the SAME way — otherwise `--by-invariant`
// groups nothing and the writer produces noise, which is the decoration A14 forbids.
// No new arg for it: all three lists above are already derived from `ledger.jsonl`,
// so carrying each row's `invariant` through makes them the vocabulary too. Empty on
// a run that passes none, and then the lanes coin new slugs — correct, that is how
// a first one gets created.
const KNOWN_INVARIANTS = [...new Set([...ALREADY_BUILT, ...OPEN_KNOWN, ...OPEN_BACKLOG_RAW].map((r) => r && r.invariant).filter(Boolean))]
// ── X43 · THE READER FOR `state.pendingOverflow` ─────────────────────────────
// The field was WRITE-ONLY. `grep pendingOverflow` returned SKILL.md:67, :231,
// :385, :391 and state.json:20 — and nothing in either engine. X30 then made it
// LOAD-BEARING: every verify discovery now routes ledger row → `pendingOverflow` →
// the head of the next build, so the one link with no mechanism behind it became
// the link the whole route depends on. A documented read is an instruction, and
// nothing failed when it was skipped: a carried finding stopped here while its
// ledger row read FLAGGED, which looks exactly like handled.
//
// It carries on a BUILD invocation only. `args.issues` is what makes a run a
// preset, so draining overflow into a discovery run would skip the editor and lose
// the log review (SKILL.md:385). Passed without `issues`, it is ignored and SAYS so.
//
// The drop is `openKnown` — the same list the editor drops against — because the one
// thing this route must never do is re-dispatch something he parked or declined.
//
// X46 · and `alreadyBuilt` too, which is what makes the field DRAIN on the path it
// never drained on. Most of his rulings are executed as a single direct `Agent`
// dispatch (SKILL.md, the one-lane branch of `build`), where no engine runs, so
// nothing there could read this field or delete an entry: an item carried once,
// built by hand, then sat in `state.pendingOverflow` and rode into every later
// build as duplicate work. The Manager now deletes what it hand-dispatches, and
// this is the backstop for the night it forgets — the ledger already knows what
// shipped, and `alreadyBuilt` is passed on every invocation.
const refKey = (v) => String(v || '').toLowerCase().replace(/^gh#|^#/, '').trim()
const overflowArg = asArray('pendingOverflow', A.pendingOverflow)
const parkedRefs = new Set(OPEN_KNOWN.map((o) => refKey(typeof o === 'string' ? o : o.ref)).filter(Boolean))
const builtRefs = new Set(ALREADY_BUILT.map((b) => refKey(typeof b === 'string' ? b : b.ref)).filter(Boolean))
// X-CLOSEDREFS · a SECOND, narrower ref set — `ledger-stats.cjs --closed-refs`,
// never `--already-built`. `alreadyBuilt`'s whole design (X186-188) SWEEPS a
// ref the moment any wrap has landed since it shipped, because a FRESH
// github/logs finding rediscovering an old symptom past a wrap might be a
// real regression — correct caution for intake, where the match is fuzzy.
// `state.pendingOverflow` never carries a fuzzy match: every entry is the
// EXACT ref of one specific tracked bug, re-injected verbatim, so there is no
// "maybe it's a new regression" question to protect — a closed ref is closed,
// however many wraps have landed since. Reusing `builtRefs` for both jobs is
// what went blind: measured 2026-08-19 (wf_b3690654-f4b), 5 of 11 queued
// items had shipped via a hand-dispatched backlog run on 2026-08-14 and were
// swept out of `alreadyBuilt` by the 4.6.0/4.6.1 wraps that landed after —
// so `carriedBuilt` below could not catch any of them and all 5 rode into a
// full lane dispatch that came back `already-fixed`. `closedRefs` is deliberately
// bare (`[ref, ref, …]`, no shape) — an exact-match screen needs nothing else.
const closedRefsArg = asArray('closedRefs', A.closedRefs)
const closedRefSet = new Set(closedRefsArg.map(refKey).filter(Boolean))
// A9 · ONE lookup for "does this ref carry a `built` ledger row", reused at
// every door an item can enter through — the editor's own triage match below,
// and the preset/paste door further down — so `regression`/`rootCause`/`lane`
// travel with a match instead of the bare yes/no `builtRefs` gives. Fields
// come from `ledger-stats.cjs --already-built --json`, which is the only
// producer of `regression`/`lane` on this shape; an older caller that has not
// upgraded simply omits them, and every consumer below already treats a
// missing `regression` as false and a missing `lane` as "leave it dropped".
const builtByKey = new Map(ALREADY_BUILT.filter((b) => b && typeof b === 'object' && b.ref).map((b) => [refKey(b.ref), b]))
// A regression match must never just vanish, wherever it entered: the ledger's
// own [REGRESSION] signal (`ledger-stats --index`, surfaced on this shape by
// `--already-built --json`'s `regression` field) means the OLD fix has already
// proven incomplete once. Dropping tonight's rediscovery of it a second time
// would let the same promise break forever with nothing ever re-opening it.
// Reframes the investigation per editor.md E11: not "what is the root cause"
// but "why did the previous fix not hold" — the old fix's proven line travels
// forward instead of being re-derived from zero.
const regressionNote = (entry) =>
  `[REGRESSION — matches alreadyBuilt ref ${entry.ref}${entry.invariant ? `, identity ${entry.invariant}` : ''}] ` +
  `The earlier fix at ${entry.rootCause || '(unknown line)'} is proven incomplete — \`ledger-stats --index\` marks this identity closed-and-open-again. ` +
  `Investigate WHY it did not hold before writing a new one; do not re-derive the root cause from scratch.`
// X176 · a Manager mistake handing the SAME ref to a DROP list and this CONFIRM
// list would tell the editor two contradictory things about one bug in one brief
// — drop it here rather than leave it to whichever instruction gets read last.
const openBacklogOverlap = OPEN_BACKLOG_RAW.filter((o) => o && (parkedRefs.has(refKey(o.ref)) || builtRefs.has(refKey(o.ref))))
const OPEN_BACKLOG = OPEN_BACKLOG_RAW.filter((o) => !openBacklogOverlap.includes(o))
if (openBacklogOverlap.length)
  argWarnings.push(
    `${openBacklogOverlap.length} \`openBacklog\` entr${openBacklogOverlap.length === 1 ? 'y' : 'ies'} also appear${openBacklogOverlap.length === 1 ? 's' : ''} on \`alreadyBuilt\`/\`openKnown\` and ${openBacklogOverlap.length === 1 ? 'was' : 'were'} REMOVED from the confirm list: ${openBacklogOverlap
      .map((o) => o.ref || '(no ref)')
      .join(', ')}. A ref cannot be both DROP and CONFIRM in the same brief.`,
  )
const carriedDropped = overflowArg.filter((i) => i && parkedRefs.has(refKey(i.id || i.ref)))
const carriedBuilt = overflowArg.filter((i) => i && !carriedDropped.includes(i) && (builtRefs.has(refKey(i.id || i.ref)) || closedRefSet.has(refKey(i.id || i.ref))))
// X88 · A DEFERRAL HE MAKES ON A CARRIED ITEM. A queued discovery drains at the
// head of the next build by construction, so his `defer` on one had NOWHERE to be
// expressed and was silently ignored — the item rode into that build anyway. Same
// marker as a ledger row (`isDeferredRow` above reads `state` or `verdict`), same
// meaning: skip exactly ONE run. Held here, NAMED, and NOT dispatched.
//
// The marker must be CLEARED once the skip has been served, and the engine cannot
// write state — so the warning says so, and X88's `--report` gate is the backstop
// for the night it is forgotten: the deferral's ledger row goes OVERDUE after one
// run and blocks the report until it is back on his desk.
const carriedDeferred = overflowArg.filter((i) => i && !carriedDropped.includes(i) && !carriedBuilt.includes(i) && isDeferredRow(i))
// X128 · A DISCOVERY RUN DRAINS THE QUEUE TOO — but AFTER the editor, never
// INSTEAD of it. The old rule ignored `pendingOverflow` on every non-preset run
// because the only way to inject items was `args.issues`, and that flag makes a
// run a PRESET and skips discovery. That is a property of the DOOR, not of the
// goal: merging the queue into `buildable` once the editor has already returned
// loses nothing. `args.issues` is untouched and still throws on a run (:137) —
// this ADDS a path, it does not loosen the guard.
// Only pre-authorized rows are in here. `queued-next-run` means "found, not
// built, already lane-assigned and shaped for args.issues" and drains itself by
// his X30 ruling; a row awaiting his decision never reaches `pendingOverflow`.
const carriedIn = overflowArg.filter((i) => i && !carriedDropped.includes(i) && !carriedBuilt.includes(i) && !carriedDeferred.includes(i))
if (carriedDropped.length)
  argWarnings.push(
    `${carriedDropped.length} \`pendingOverflow\` entr${carriedDropped.length === 1 ? 'y was' : 'ies were'} matched a parked \`openKnown\` ref and DROPPED, not built: ${carriedDropped.map((i) => i.id || i.ref || '(no id)').join(', ')}. He has already ruled on those.`,
  )
if (carriedBuilt.length)
  argWarnings.push(
    `${carriedBuilt.length} \`pendingOverflow\` entr${carriedBuilt.length === 1 ? 'y' : 'ies'} matched an \`alreadyBuilt\` or \`closedRefs\` ref and were DROPPED, not re-built: ${carriedBuilt
      .map((i) => i.id || i.ref || '(no id)')
      .join(', ')}. They shipped — most likely through a one-lane hand dispatch — and were never deleted from \`state.pendingOverflow\`. **Delete them now**, or they ride into the next build too.`,
  )
// X128 · fires on a DISCOVERY run too, now that one drains the queue. A deferral
// is a one-run skip and this run is the skip, whichever door the items came in.
if (carriedDeferred.length)
  argWarnings.push(
    `${carriedDeferred.length} \`pendingOverflow\` entr${carriedDeferred.length === 1 ? 'y is' : 'ies are'} marked \`deferred\` and ${carriedDeferred.length === 1 ? 'was' : 'were'} HELD, not built: ${carriedDeferred
      .map((i) => i.id || i.ref || '(no id)')
      .join(', ')}. A deferral is a ONE-RUN skip and this run is the skip. **Now delete \`"state":"deferred"\` from those entries in \`state.pendingOverflow\`** — the skip has been served, so the next build takes them. An uncleared marker parks the item forever, which is the failure this reads for.`,
  )
// 2026-08-16 · THE PRESET DOOR HAD NO SCREEN AT ALL. `overflowArg` above is
// checked against `parkedRefs`/`builtRefs` before it drains; `presetArg` —
// `args.issues`, the SAME door a raw paste and an owner-approved report row
// both walk through, structurally identical on arrival — was concatenated raw.
// A cheap ref-match costs nothing (a Set lookup, never an LLM call), so there
// is no "needless re-triage" cost to weigh against running it on every preset
// item, screened or not.
//
// The two lists get OPPOSITE treatment, same as everywhere else in this file:
// `builtRefs` is a pure engineering fact (the code exists, just not deployed)
// — always drop, unless the match is flagged REGRESSION (see `regressionNote`
// above), in which case it is reframed and kept rather than silently lost a
// second time. `parkedRefs` (openKnown: converted/declined) is a past DECISION
// — naming it directly in a preset is his own current act, which per E12/E2 is
// exactly what overrides a decline, so it is never dropped here, only NAMED so
// the override is visible.
const presetParked = presetArg.filter((i) => i && parkedRefs.has(refKey(i.id || i.ref)))
if (presetParked.length)
  argWarnings.push(
    `${presetParked.length} preset item(s) match an \`openKnown\` (parked/declined) ref and were KEPT, not dropped: ${presetParked.map((i) => i.id || i.ref || '(no id)').join(', ')}. Naming it directly in a preset is his own act and overrides a decline/conversion (E12) — this was never checked before now.`,
  )
const presetBuiltAll = presetArg.filter((i) => i && builtRefs.has(refKey(i.id || i.ref)))
const presetRegression = presetBuiltAll.filter((i) => {
  const e = builtByKey.get(refKey(i.id || i.ref))
  return e && e.regression
})
const presetSettled = presetBuiltAll.filter((i) => !presetRegression.includes(i))
if (presetSettled.length)
  argWarnings.push(
    `${presetSettled.length} preset item(s) match an \`alreadyBuilt\` ref and were DROPPED, not (re)dispatched: ${presetSettled
      .map((i) => i.id || i.ref || '(no id)')
      .join(', ')}. A raw paste and an owner-approved report row are structurally identical on this door, so both are now checked — dispatching either would have cost a full turn to be told "already-fixed".`,
  )
if (presetRegression.length)
  log(
    `Preset: ${presetRegression.length} item(s) match an \`alreadyBuilt\` ref flagged [REGRESSION] — kept, reframed to "why did the fix not hold" rather than dropped: ${presetRegression
      .map((i) => i.id || i.ref)
      .join(', ')}`,
  )
const presetClean = presetArg
  .filter((i) => !presetSettled.includes(i))
  .map((i) => {
    if (!presetRegression.includes(i)) return i
    const e = builtByKey.get(refKey(i.id || i.ref))
    return { ...i, notes: `${i.notes ? `${i.notes} ` : ''}${regressionNote(e)}`.trim() }
  })
// X25's guard reads the MERGED list below, so a carried row still flagged
// `awaitingOwner` is refused exactly like a pasted one.
const PRESET = presetArg.length ? [...carriedIn, ...presetClean] : null
if (carriedIn.length)
  log(
    presetArg.length
      ? `Carried in ${carriedIn.length} item(s) from state.pendingOverflow — they head this build's queue: ${carriedIn.map((i) => i.id || i.ref).join(', ')}`
      : `Queue: ${carriedIn.length} item(s) from state.pendingOverflow will MERGE into this run's buildable list AFTER the editor: ${carriedIn.map((i) => i.id || i.ref).join(', ')}`,
  )
// X25 · THE READER FOR `awaitingOwner`. The deferred dependency asks below are
// shaped for a copy-paste straight back into `args.issues` — that is the whole
// point of the shape — so the flag that says "he has not ruled on the parent yet"
// has to be enforced at the door it makes easy to walk through. Building one of
// these could implement a dependency of something he is about to decline.
// Refused HERE because nothing has spawned yet: a loud stop costs one
// re-invocation (X11), and once he rules, DELETING the flag from the row is the
// approval. Without this read the field was decoration, which A14 forbids.
const undecidedPreset = (PRESET || []).filter((i) => i && i.awaitingOwner)
if (undecidedPreset.length)
  throw new Error(
    `args.issues carries ${undecidedPreset.length} row(s) still flagged \`awaitingOwner\`: ` +
      `${undecidedPreset.map((i) => `${i.id || '(no id)'} (parent verdict ${i.fromVerdict || '?'})`).join(', ')}. ` +
      `Each is a dependency ask whose PARENT is waiting on the owner, so building it could implement a dependency of something he declines. ` +
      `Nothing has been dispatched. Get his ruling, delete \`awaitingOwner\` from the row, and re-invoke.`,
  )
// X146 · `invariant` is the STRONGER signal and used to reach neither
// description at all — the editor matched on `ref`/`rootCause`/`symptom` prose
// only, even though a shared identity slug is exactly what
// `ledger-stats --index` now uses to prove two refs are the same underlying
// bug. Surfacing it costs one line and is silent where an entry carries none
// (most still do not — X146's own re-check found real duplicate-build cases,
// e.g. `dateverifier-hebrew-false-positive` vs `log-dateverifier-falsepos-confirmed`,
// sharing `src/utils/dateVerifier.ts:187` and the `one-fact-one-derivation`
// identity, built independently two days apart because nothing showed the
// editor the identity to match on).
const describeOpen = (o) =>
  typeof o === 'string'
    ? `  • ${o}`
    : `  • **${o.ref || '(no ref)'}** — ${o.symptom || '(no symptom)'}${o.state ? ` [${o.state}]` : ''}` +
      `${o.invariant ? `\n      identity: ${o.invariant}` : ''}` +
      `${o.note ? `\n      ${o.note}` : ''}`
const describeBuilt = (b) =>
  typeof b === 'string'
    ? `  • ${b}`
    : `  • ${b.ref ? `**ref ${b.ref}** — ` : ''}${b.symptom || '(no symptom)'}` +
      `${b.rootCause ? `\n      root cause already fixed at: ${b.rootCause}` : ''}` +
      `${b.invariant ? `\n      identity: ${b.invariant}` : ''}` +
      `${
        b.regression
          ? `\n      **[REGRESSION] this identity is closed AND open again elsewhere (\`ledger-stats --index\`) — drop it in \`droppedAsAlreadyBuilt\` as usual; a REF match is reinstated by the engine automatically, reframed to "why did the fix not hold" (E11). If your match is by symptom only, with no clean ref, reinstate it yourself instead of a silent drop.**`
          : ''
      }` +
      `${b.state === 'awaiting-owner' ? `\n      **state: awaiting-owner — DROP any finding for this ref, even if more work looks available**` : ''}`
// X176 · shares `describeOpen`'s shape (ref/symptom/state/invariant/note) but adds
// the root-cause line `describeBuilt` shows for a built row — a still-open row
// commonly names one too (the lane or pass that raised it usually settled the root
// before escalating), and `rootCause` is X176's second match key after identity.
const describeOpenBacklog = (o) =>
  typeof o === 'string'
    ? `  • ${o}`
    : `  • **${o.ref || '(no ref)'}** — ${o.symptom || '(no symptom)'}${o.state ? ` [${o.state}]` : ''}` +
      `${o.rootCause ? `\n      cites root cause at: ${o.rootCause}` : ''}` +
      `${o.invariant ? `\n      identity: ${o.invariant}` : ''}` +
      `${o.note ? `\n      ${o.note}` : ''}`
// COLLECT mode — find and record, build nothing. **Explicit opt-in only.**
// Building every night the owner is away IS the product: he leaves, the loop
// fixes, and the work is waiting for approval when he opens his laptop. An
// earlier version of this flag switched on automatically after two unreviewed
// nights "to save tokens" — which meant a three-day absence produced one night
// of fixes and two nights of homework, converting finished work back into a
// to-do list. Never select it from a timer or a staleness heuristic. Use it
// only when the owner asks for findings without work.
const MODE = A.mode === 'collect' ? 'collect' : 'full'
const VERIFY = A.verify !== false // one combined bouncer pass over the wave, unless explicitly off
const CODE_LANES = ['matchmaker', 'registrar', 'gatekeeper', 'librarian', 'slackmaster', 'diplomat', 'handyman'] // run in parallel; context runs LAST, separately
// Reasoning effort per agent (owner-set). Keys are agent names, renamed 2026-07-28.
// The non-lane agents live here too, so every dispatch in this engine reads its
// effort from ONE table — a hardcoded effort at the call site is invisible to
// anyone tuning the run, which is how the editor sat at `medium` unnoticed.
const EFFORT = { matchmaker: 'xhigh', instructor: 'xhigh', slackmaster: 'high', diplomat: 'high', registrar: 'xhigh', handyman: 'high', librarian: 'high', gatekeeper: 'high', editor: 'xhigh', framer: 'xhigh', bouncer: 'xhigh' }
// X124 · Fail at LOAD, not mid-run. A half-finished rename — a lane changed in
// CODE_LANES and missed here — otherwise dispatches with `effort: undefined` to
// an agentType that does not exist, and reads as a perfectly normal run.
// charter-audit.js:16-17 has had this guard since it was written; the two
// engines that actually BUILD did not.
const DISPATCHABLE = [...CODE_LANES, 'instructor', 'editor', 'bouncer']
const UNKNOWN = DISPATCHABLE.filter((l) => !EFFORT[l])
if (UNKNOWN.length) throw new Error(`Unknown lane(s): ${UNKNOWN.join(', ')} — they have no effort setting and no agent, so they would dispatch to nothing.`)

// ---- schemas (force structured returns) ----
// ── SELF-REPORT ─────────────────────────────────────────────────────────────
// Every silent failure this engine has had was a mechanism that did nothing and
// looked like success: the watermark never filtered, the activity exit never
// fired, the Agent label never matched, dependency asks vanished into a `built`
// verdict, `alreadyBuilt` never matched `gh#147` against `#147`. None was caught
// for weeks because nothing ever asserted that the step had happened.
//
// So the step REPORTS ITS OWN WORK, and the run manifest prints it. A no-op
// stops being invisible and becomes a zero in a column where zero is obviously
// wrong. Diagnostics only — nothing branches on them.
const EDITOR = {
  type: 'object',
  properties: {
    filesRead: {
      type: 'array',
      items: { type: 'string' },
      description:
        'every log file you opened, by name. The watermark routinely predates today, so a review that opened only one file has skipped the tail of the previous day — on a watermark older than this morning, a single-entry list IS that failure.',
    },
    cutoffUtc: {
      type: 'string',
      description: 'the UTC instant you compared against, after converting the watermark. Checked against the watermark the engine passed you, so a timezone slip is visible rather than silent.',
    },
    turnsAfterCutoff: { type: 'number', description: '`Orchestrator invoked` events counted AFTER the cutoff, across every file you read' },
    findingsSeen: { type: 'number', description: 'raw findings from both sources before merging — the count that used to come back from a separate intake pass' },
    droppedAsOpenKnown: {
      type: 'array',
      items: { type: 'string' },
      description:
        'the ref of every finding you dropped because it matched a row on the `openKnown` list the brief handed you — a `converted` match (always dropped) or a `declined` match whose OWN source is a bare `logs` rediscovery (stays declined; see `overriddenDeclined` for the one case that proceeds instead). X51 · THAT LIST ONLY — a row you saw in `ledger-stats --open` is corroboration, never grounds to drop. Empty array if none; do NOT omit the field, an omission is indistinguishable from "the check did not run".',
    },
    // X190 · the ONE case an `openKnown` match does NOT drop. A `declined` row
    // matched by anything but a bare `logs` rediscovery is the owner's own act
    // reaching the editor again — a ticket, a direct restatement — and his rule
    // is that only his own act can undo a decline. This is the trace for that
    // reversal, kept separate from `droppedAsOpenKnown` because it is a state
    // CHANGE, not a routine drop, and needs its own visibility in the manifest.
    overriddenDeclined: {
      type: 'array',
      items: { type: 'string' },
      description:
        "the ref of every `openKnown` row you matched that was `declined`, where the matching finding's OWN `source` is anything but a bare `logs` rediscovery — the owner's own act overriding his prior decline. Also tagged per-issue via `overridesDeclined`. Empty array if none; do NOT omit — an omission is indistinguishable from the check never running.",
    },
    droppedAsAlreadyBuilt: {
      type: 'array',
      items: { type: 'string' },
      description: 'the ref or symptom of every finding you dropped because it is already fixed. Empty array if none — do NOT omit the field, an omission is indistinguishable from "the check did not run".',
    },
    // X176 · the CONFIRM list — the opposite instruction from the two drop lists
    // above. A match here is NOT a reason to drop anything: the finding is still
    // emitted, and it also carries `matchesOpenBacklog` on the issue itself (see
    // below) so the ref survives on the row, not only in this summary array.
    matchedOpenBacklog: {
      type: 'array',
      items: { type: 'string' },
      description:
        "the ref of every `openBacklog` row a finding matched tonight — the same refs set on those issues' `matchesOpenBacklog`. Never a drop list: matched findings are still emitted and dispatched normally. Empty array if you checked and found none — do NOT omit the field, an omission is indistinguishable from `openBacklog` never being checked.",
    },
    // X32 + X33 · ONE field for both halves of the ticket problem, because both
    // are invisible in the same way. gh#156 carried three numbered complaints and
    // one issue came back; gh#158 carried three and one came back. Neither was a
    // drop — `droppedAsOpenKnown` was gh#155/gh#154 only and `droppedAsAlreadyBuilt`
    // was empty — so two of every three complaints were never surfaced by any run,
    // and nothing could tell. Worse, the one row that MERGED a ticket with a log
    // moment came back as `flow-narrates-unexecuted-actions` with no 156 in it, so
    // the ticket-coverage check had no row to fire on and gh#156 read exactly like
    // a ticket with nothing wrong.
    ticketComplaints: {
      type: 'array',
      description:
        'one entry per GitHub ticket you read, ALWAYS — empty array only when you pulled no tickets. This is how 3-complaints-in / 1-issue-out becomes visible instead of silent.',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'the ticket, as `#<number>`' },
          complaintsFound: { type: 'number', description: 'how many distinct complaints the BODY explicitly lists. Count what is listed; never infer a list that is not there.' },
          issuesEmitted: { type: 'number', description: 'how many issues you emitted whose id names this ticket' },
          // X80 · X32 gave this funnel its two endpoints and no accounting between
          // them, so `emitted 1 of 3` and `emitted 1 of 3 because 2 were already
          // built` were the same return — and the unexplained two landed on no list
          // at all, recoverable only by the Manager re-reading a ticket the editor had
          // already read and discarded. #156 collapsed 3→0 on wf_4bbfc750-1a9 after
          // 3→3 and 3→0 on the two runs before it. Every complaint now comes back as
          // an issue OR as a named drop with its reason, so the arithmetic closes in
          // the return instead of being reconstructed.
          dropped: {
            type: 'array',
            description:
              'One entry per complaint you did NOT emit an issue for. `complaintsFound` must equal `issuesEmitted` + this length — the manifest checks it and names any shortfall. Empty array when you emitted one for every complaint; never omit it.',
            items: {
              type: 'object',
              properties: {
                complaint: { type: 'string', description: "the complaint in the ticket's own words, enough to recognise it" },
                why: {
                  type: 'string',
                  description:
                    'why no issue: `already-built <ref>` · `parked <ref>` · `open row <ref>` · `not a bug — <what the transcript shows instead>` · `too vague to act on`. A reason he can rule on, not "skipped".',
                },
              },
              required: ['complaint', 'why'],
            },
          },
        },
        required: ['ref', 'complaintsFound', 'issuesEmitted', 'dropped'],
      },
    },
    // X42 · the backlog re-read. Its product is FEWER rows on his desk, so the two
    // numbers that matter are how many stale rows the list held and how many were
    // actually examined — a pass that reached 8 of 22 must not read like a finished
    // one, which is the `ticketComplaints` lesson applied to the third intake.
    backlogSeen: {
      type: 'number',
      description: 'how many rows `ledger-stats --open` printed with the RE-READ prefix. 0 only when it printed none. Backlog runs only.',
    },
    // X47 · the rows no pass can ever reach. `--open` names them under "cite no
    // file"; without this number `reread: 22 of 22` reads as a finished backlog
    // while a third of it was never checkable at all.
    backlogNoCite: {
      type: 'number',
      description:
        'the count `ledger-stats --open` printed as `cite no file`, MINUS any UNTOUCHED `source:owner` row (no `recommend` yet) you pulled out and emitted into `issues` instead (see the backlog re-read brief\'s EXCEPTION). Do NOT re-read the rest and do not go hunting for their code — they need the owner, not a lane. Backlog runs only.',
    },
    backlogReread: {
      type: 'array',
      description: 'one entry per RE-READ row you actually opened the code for. Empty array when `backlog` was not a source — never omit it on a backlog run.',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'the row ref exactly as `--open` printed it, so it collapses onto the row it came from' },
          state: {
            type: 'string',
            enum: ['fixed', 'moved', 'still-real'],
            description: '`fixed` = the defect is gone. `moved` = still real, in a different place. `still-real` = still real where the row says it is.',
          },
          evidence: {
            type: 'string',
            description:
              'what you READ. For `fixed`: the commit that removed it (`git log -1 --format=%h -- <file>`) or the code that now handles the case. A bare "already fixed" is a FALSE CLOSE — a restructured file looks fixed when the defect has only moved, and once a row is closed nothing looks again.',
          },
          whereNow: { type: 'string', description: '`moved` only: the current `file:line`. This is what stops the row being flagged stale again tomorrow.' },
          // X77 · THE FIELD THAT MAKES A ROW RULABLE, written by the only pass that
          // reads the code without building anything. His invariant: every open row
          // is one of five verbs away from closed, and a row none of them can act on
          // must not exist. 56 open rows carried no recommendation on 2026-07-31
          // because the recommendation lived in `report.md` and the wrap empties it.
          // This is the drain — a re-read is already opening the file, so naming the
          // verb costs one clause and clears the row for good.
          recommend: {
            type: 'string',
            description:
              'REQUIRED on `still-real` and `moved`; write `fixed — no action` on a `fixed` row. One of his five verbs and ONE clause of why: `build — <why now>` · `decline — <why never>` · `defer — <what it waits on>` · `resend — <what the lane got wrong>` · `convert — <the design question>`. **X129 · `build` is now ACTED ON, not just advice** — his ruling 2026-08-02: *"everything that is able to build should be build."* A `build` verb sends this row to a lane in THIS run, so write it only when you would dispatch it; `convert` and `decline` and `defer` do not build, and a row that genuinely needs him gets no recommendation at all.',
          },
          // X129 · a backlog row that BUILDS has to be dispatchable, and the two
          // fields a dispatch needs were never on this shape. The editor already
          // makes exactly this call on every fresh issue — same routing table,
          // same judgement, applied to a row it has just re-read.
          lane: {
            type: 'string',
            enum: ['matchmaker', 'registrar', 'gatekeeper', 'instructor', 'librarian', 'slackmaster', 'diplomat', 'handyman'],
            description: 'REQUIRED when `recommend` starts with `build` — the lane that owns the FIX, routed exactly as you route a fresh issue. Omit on any other verb. A `build` row without this cannot be dispatched and is reported as dropped.',
          },
          severity: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'REQUIRED when `recommend` starts with `build` — it orders the shared severity-first cap against this run\'s fresh findings. Judge the harm, not the age of the row.',
          },
          // X130 · which rows had no `recommend` before this run. They are the
          // ones the editor verbed on his behalf, so they are named separately in
          // the manifest and he can overturn any of them in one word.
          verbAdded: {
            type: 'boolean',
            description: 'true ONLY for a row that came off the "carry NO `recommend`" list — i.e. this run wrote its first verb. Omit or false for a normal RE-READ row that already had one.',
          },
        },
        required: ['ref', 'state', 'evidence', 'recommend'],
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          symptom: { type: 'string' },
          // Where this came from, carried all the way to the ledger. Without it
          // "is the log review earning its keep?" can only be answered by
          // digging through old workflow journals — which is how it was
          // answered on 2026-07-27 (4 log findings ever, against 8 from
          // GitHub, and all four were real bugs nobody had reported). A merged
          // issue takes `both`; that IS the interesting case, because the
          // owner's words carry the ask and the transcript carries the proof.
          // `owner` is the one no-cite backlog row the editor pulls into this list
          // itself (see the backlog re-read brief's EXCEPTION) — everything else
          // still arrives via the GitHub pull or the log review.
          source: { type: 'string', enum: ['github', 'logs', 'both', 'owner'] },
          lane: { type: 'string', enum: ['matchmaker', 'registrar', 'gatekeeper', 'instructor', 'librarian', 'slackmaster', 'diplomat', 'handyman'] },
          whyHypothesis: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          // KIND is what drives cost, not count. 15-20 atomic items is a normal
          // night; ONE product-shaped item can dominate it — issue 41 cost 411k
          // across four lanes on 2026-07-26, and #147 arrived as a bug but was a
          // design change whose stated premise was false in the code.
          kind: {
            type: 'string',
            enum: ['atomic', 'needs-shaping'],
            description:
              "`atomic` = known root, ONE lane, one edit — dispatch it. `needs-shaping` = it touches TWO OR MORE lanes, or the fix is a product decision rather than a repair, or the issue's premise does not survive contact with the code. NOT knowing the call site yet is none of those three — that is ordinary root-cause tracing, the lane's job inside an atomic dispatch, not a reason to escalate (measured 2026-08-03: gh#179-a/179-b were shaped this way and each closed in one dispatch once a lane opened the logs). A `needs-shaping` item is NOT dispatched: it goes to the owner with a proposed shape so he rules before a lane spends anything. Dispatching one as a bug does not fail loudly — it ping-pongs across lanes, burns the night, and still ends up needing his judgement afterwards, which is the most expensive possible order.",
          },
          shapingQuestion: {
            type: 'string',
            description: 'needs-shaping only: the ONE thing the owner must decide, in a sentence he can answer. Plus what you checked in the code that the issue got wrong, if anything.',
          },
          evidence: { type: 'string' },
          clarity: { type: 'string', enum: ['clear', 'ambiguous'] },
          // X176 · the annotation, not a suppression. Set this instead of dropping
          // the finding when it matches a row on the `openBacklog` list the brief
          // hands you — the finding is still emitted and dispatched exactly as any
          // other, this only records which already-open row it corroborates.
          matchesOpenBacklog: {
            type: 'string',
            description:
              "the ref of an `openBacklog` row this finding matches — same bug, still open, getting fresh evidence tonight. Never a reason to drop; the finding ships normally. Omit when it matches nothing on that list.",
          },
          // X190 · the reversal tag. Set only when this issue's own `source`
          // overrode a PRIOR `declined` verdict on the matched `openKnown` ref —
          // never when it merely matches an open or converted row. Omitting this
          // on an override makes the issue indistinguishable from ordinary new
          // work, which is exactly the ambiguity his rule (only his own act
          // reopens a decline) needs to be visibly resolved against.
          overridesDeclined: {
            type: 'string',
            description:
              "the ref of a `declined` `openKnown` row this issue explicitly overrides. Set ONLY when this finding's own `source` is anything but a bare `logs` rediscovery — a ticket or a direct restatement is the owner's own act, the one thing that can reopen a decline (editor.md E12, E2). Omit entirely otherwise; a bare `logs` match against a `declined` row is DROPPED into `droppedAsOpenKnown`, never overridden.",
          },
          // Filled ONLY when the issue cites a code location. This was its own
          // Haiku pass; the editor is already holding the issue, so it resolves
          // the citation in the same turn instead of a second agent re-opening
          // what the first just read.
          where: {
            type: 'object',
            description: 'the cited code location, resolved. Omit entirely when the issue cites no file — most log findings do not.',
            properties: {
              file: { type: 'string', description: 'repo-relative path' },
              line: { type: 'number' },
              excerpt: { type: 'string', description: 'the cited line with ~30 lines either side, VERBATIM' },
              neighbours: { type: 'string', description: 'who calls this and what it calls — names and file:line only, no prose' },
            },
          },
        },
        required: ['id', 'symptom', 'source', 'lane', 'severity', 'clarity', 'kind'],
      },
    },
  },
  required: ['issues'],
}

const VERDICTS = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          // X66 · `confirmed-other-lane` — the row is DONE, and you are not the
          // one who did it. A lane resumed to close out a dependency returned
          // `built` for a change gatekeeper had made (wf_0cebe938-c81, registrar
          // a2602ac7: 21 turns, 13 tools, ZERO edits, fix text opening "Not built
          // by me"), so the verify was handed 3 rows for 2 changes and spent a
          // result saying so, and the Manager typed the de-duplication into
          // state.json by hand. Use it whenever you did not edit a file: it does
          // not reach the verify, it is not counted as a fix, and it still closes
          // the dependency. Claiming someone else's work as `built` inflates every
          // count downstream.
          //
          // X95 · THIS ENUM MIRRORS THE CHARTERS; IT DOES NOT DEFINE THE VOCABULARY. The
          // dispatch brief below says "return one verdict per issue per your return
          // contract", so the eight lane charters' return-contract list IS the contract
          // and this line only enforces it. Adding a member here without adding it to all
          // eight does nothing: a lane cannot choose a verdict it has never been told
          // exists, and `confirmed-other-lane` proved it — 0 uses in 537 ledger rows while
          // it lived only here. Payload FIELDS are the opposite and correctly live here
          // alone (`filesTouched`, `traced`, `invariant`): they are mechanics carried by
          // the schema description and the brief, one of them is computed per run, and
          // they mean nothing off the engine path. Verdicts are judgments a lane must be
          // taught; fields are attachments the dispatch asks for.
          verdict: {
            type: 'string',
            enum: ['built', 'confirmed-other-lane', 'needs-dependency', 'blocked-charter', 'needs-owner-decision', 'already-fixed'],
          },
          rootCause: { type: 'string', description: 'file:line — proven, not guessed' },
          // X22 · THE COMPLEMENT TO `rootCause`, and until now it had a reader and
          // no writer. `rootCause` answers "is this the same BUG"; nothing answered
          // "is this the same RULE", so one principle broken in three files read as
          // three unrelated findings and the chat reading them proposed three
          // separate charter rules. `ledger-stats --by-invariant` has grouped by
          // this field since it was added — and saw 16 of 344 rows, all 16 typed by
          // hand in a single run, because no return schema ever asked for it. This
          // is the ask. `knownInvariants` in the dispatch carries the slugs already
          // in use so three lanes cannot name one principle three ways.
          invariant: {
            type: 'string',
            description:
              'OMIT unless this bug is an instance of a GENERAL rule that could break somewhere else. When it is, a short stable slug — `tier-follows-structure-not-classification`, `payload-scoped-to-caller` — reused VERBATIM from the slugs the dispatch names if one fits. A slug invented for one row groups nothing and is noise; a local bug is meant to carry none.',
          },
          fix: { type: 'string', description: 'files touched, +/- lines, plain English' },
          // The STRUCTURED version of the same fact, and it is load-bearing in a
          // way the prose is not. The verify reads `git diff`, which on a normal
          // night also holds work from other chats — on 2026-07-27 seven `src/`
          // files and five `.claude/` files were already modified before this
          // engine wrote a line. Without knowing which files are its own, the
          // verify can overturn a row for a change the wave never made, and the
          // owner cannot tell which. `fix` is prose and cannot be parsed; this
          // can. It also drives the `priorClean` prune below.
          filesTouched: {
            type: 'array',
            items: { type: 'string' },
            description:
              'repo-relative path of EVERY file you edited or created for this issue. Omit only if you edited nothing — a missing list makes the verify treat the entire tree as this wave, which is safe but wasteful.',
          },
          // Forwarded to the verify so it spends its budget on what you did NOT
          // cover. Without it the bouncer re-derives ground you already walked.
          traced: {
            type: 'string',
            description:
              'the scenarios you paper-traced and the ones you deliberately did NOT, one line each. Be honest about the gaps — an uncovered case named here gets checked by the bouncer; one you quietly omit gets checked by nobody.',
          },
          // 2026-08-06, three repairs in one wave: each built EXACTLY what its
          // brief described and delivered NONE of the outcome the brief existed
          // for — a symptom's file:line got fixed while the cost sat one call
          // site up, a field was added with nothing to backfill the rows already
          // on disk, a gate compared against reason-code strings that occur zero
          // times in the live table. Common cause, his own diagnosis: no brief
          // ever asked the lane to check real data, so none did. `traced` proves
          // you walked the CODE; this proves you checked the WORLD it acts on —
          // the mechanism is not the same claim as the outcome.
          observable: {
            type: 'string',
            description:
              "REQUIRED on `built` and `already-fixed`: the MEASURABLE check you ran against REAL, LIVE data — a query against the table, a grep of a live log, a re-run against production input — that shows this fix's actual effect, not merely that the code path changed. If the state you fixed already exists on disk (an existing row, a stored counter, a config value written before your fix), check THAT now; a new field or branch does not retroactively reach data already there. If there is genuinely nothing to observe outside the code itself, say so explicitly — never leave this blank.",
          },
          dependencyAgent: { type: 'string', enum: ['matchmaker', 'registrar', 'gatekeeper', 'instructor', 'librarian', 'slackmaster', 'diplomat', 'handyman', ''] },
          dependencyAsk: { type: 'string' },
          notes: { type: 'string' },
          // The Workshop reversal (2026-08-07) deleted the eight hand-copied
          // Shared-charter blocks in favour of ONE source, `.claude/WORKSHOP.md`,
          // that every lane charter now tells the agent to read FIRST and STOP if
          // it cannot. A charter instruction to stop is invisible to this engine —
          // it only sees what comes back — so the read needs its own field, or a
          // lane silently unbound from W1-W12 looks byte-identical to one that
          // read them. REQUIRED, not optional: an omitted field is indistinguishable
          // from a check that never ran, the same reasoning `filesTouched`/`traced`
          // already carry here.
          workshopRead: {
            type: 'boolean',
            description:
              'true once you have read .claude/WORKSHOP.md this dispatch. If you could not read it, you should already have stopped and returned your escalation verdict instead of building — this field is not where that failure is reported, it is the proof the read happened before this result was produced.',
          },
        },
        required: ['id', 'verdict', 'workshopRead'],
      },
    },
  },
  required: ['results'],
}

// The verify returns its verdicts AND what it settled, so the next run can be
// told not to re-audit it. Nothing else persists that: the report is emptied at
// wrap, so today every pass starts from zero on ground an earlier one proved.
const VERIFY_OUT = {
  type: 'object',
  properties: {
    results: VERDICTS.properties.results,
    // ── OVERTURNS vs DISCOVERIES — two different things, and conflating them
    // traps the run in a loop it cannot exit.
    //
    // An OVERTURN says a fix in THIS wave is broken: it belongs to this wave and
    // must be settled before shipping. It goes in `results`.
    //
    // A DISCOVERY is a pre-existing bug the bouncer happened to notice while
    // reading. It has nothing to do with the fixes under review — and building
    // it here would change the tree the verify just examined, invalidating the
    // very pass that found it, which then justifies another pass. That is the
    // loop: verify -> new row -> build -> re-verify -> new row. Observed
    // 2026-07-27 with a cached-reads finding in checkSlot.
    //
    // So a discovery is REPORTED, never built in-wave. It is next run's INTAKE —
    // shaped to drop straight into `args.issues`, and it does NOT go on the
    // owner's decide list (X30, his words: "if i do want to fix discoveries, its
    // not blocker, its bonus"). `lane` and `severity` are REQUIRED for exactly
    // that reason: an item that is going to be dispatched as intake has to be
    // routable and rankable, and severity has to survive the trip because
    // blocking and severity are different axes — the wave that found it cannot be
    // held for it, and a `high` one can still put a person on a real invite.
    discoveries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          symptom: { type: 'string', description: 'what a person would see go wrong — not the mechanism' },
          // X65 · AT HEAD, and that word is the whole field. A discovery is the
          // only claim in this loop nothing checks for currency: on
          // wf_0cebe938-c81 the night's headline HIGH discovery was already fixed
          // at HEAD by 4.3.2, and the pass that raised it had 17 log reads and
          // zero reads of the current file. A log line proves the symptom
          // happened; only the file proves it still would.
          evidence: {
            type: 'string',
            description:
              'REQUIRED, and it must be a `file:line` AS THE FILE STANDS AT HEAD — open it and point at the line that is still wrong. A log line is what made you look; it is not evidence the defect is still there. If the code has since been fixed, this is not a discovery.',
          },
          lane: { type: 'string', enum: ['matchmaker', 'registrar', 'gatekeeper', 'instructor', 'librarian', 'slackmaster', 'diplomat', 'handyman'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'], description: 'carried into the next run, where the severity-first cap orders the queue. Judge the harm, not whether it blocks this wave — it does not.' },
          // X22 · a DISCOVERY is the highest-value place for this tag and the only
          // one where it was ever set: you read the whole diff, so you are the pass
          // most likely to see one principle broken in three files. All three slugs
          // in the ledger were typed by hand onto discovery rows in wf_33541300-121.
          invariant: {
            type: 'string',
            description:
              'OMIT unless this is an instance of a GENERAL rule that could break elsewhere. When it is, one short stable slug, and the SAME slug on every discovery that breaks the same rule — that is what lets the root be fixed once instead of three times. Reuse a slug the dispatch already named if one fits.',
          },
        },
        required: ['symptom', 'evidence', 'lane', 'severity'],
      },
      description:
        'problems you found that are NOT about the fixes under review. Return an empty array if none — do NOT put them in `results`, and do NOT stay quiet about one to keep the wave clean.',
    },
    // ── X182 · THE OUTCOME TRACE, question 1, AND ITS DENOMINATOR ─────────────
    // Question 1 was made "the whole pass now" (his ruling, 2026-08-03) with a
    // stated 100% bar, and 1b got a real mechanism for its own coverage the
    // same week (X144) — but Q1 itself stayed PROSE ONLY: nothing recorded
    // which rows were even traced, so a pass that traced 3 of 15 and one that
    // traced all 15 produced byte-identical artefacts, exactly the class of
    // check this file is written against.
    //
    // THE ENGINE NAMES THE DENOMINATOR, never the bouncer: every row this wave
    // marks `built` is a candidate, because every issue this engine ever
    // dispatches carries a `symptom` field (schema-required on `issues` above)
    // — bouncer.md B1's own words are "everything a person reported, and
    // everything carrying a `Seen:` line, gets traced". The one thing left to
    // judgement is B1's own carve-out (a one-line comment fix has no
    // behavioural symptom) — and that must be STATED as `no-symptom`, never a
    // silent omission, exactly as an un-traceable 1b pair is `unproven` and
    // never just missing.
    outcomeTraces: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'the row id, exactly as it appears in `results`' },
          verdict: {
            type: 'string',
            enum: ['traced', 'no-symptom'],
            description:
              '`traced` = you walked the bug forward from the reported symptom (or the report\'s `Seen:` line for a loop-born row) to the line where behaviour now diverges from before. `no-symptom` = this row has no behavioural outcome to trace — a one-line comment correction is the named example — and you are SAYING so rather than skipping it.',
          },
          evidence: { type: 'string', description: 'REQUIRED when verdict is `traced`: `file:line`, as the file stands at HEAD, where behaviour now diverges from before.' },
          notes: { type: 'string', description: 'REQUIRED when verdict is `no-symptom`: why this row has no behavioural outcome. Optional otherwise.' },
        },
        required: ['id', 'verdict'],
      },
      description:
        'ONE ENTRY PER ROW THIS WAVE CLAIMS FIXED — question 1, the outcome trace. A row you leave out is reported as UNTRACED and named to the owner. A row whose symptom cannot be established at all is not this field\'s job — refuse it as an overturn in `results` instead (B1\'s third case). Empty array only when no row was built this wave.',
    },
    // ── X144 · THE JOINT TRACE, question 1b, AND ITS DENOMINATOR ──────────────
    // 1b exists for his stated fear: *"if a bug had two lanes, two agents, and for
    // some reason they both went a different way of fixing it, we get a bug that's
    // not working."* It was PROSE ONLY in `bouncer.md` — this schema named no
    // field, so the pass could trace every pair, or none, and the artefacts were
    // byte-identical. A check with no observable is indistinguishable from a check
    // that is not there, which is the class this whole file is written against.
    //
    // THE ENGINE NAMES THE DENOMINATOR. It already knows every multi-lane
    // candidate — a `>dep` chain is its own marker, a `confirmed-other-lane`
    // verdict means a second lane was in the same place, and two lanes citing one
    // `rootCause` file is the third case `bouncer.md` names. So the candidates are
    // computed and handed over, and what comes back is compared against them
    // rather than against this array merely being non-empty: a required field
    // invites one token line per pair that proves nothing.
    jointTraces: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'the row ids you traced together, exactly as the candidate list names them — two or more.',
          },
          sharedRootCause: {
            type: 'string',
            description: 'the `file:line` where the two halves MEET, as the file stands at HEAD. Not each half\'s own root — the place the composed behaviour is decided.',
          },
          verdict: {
            type: 'string',
            enum: ['composes', 'disagrees', 'unproven'],
            description:
              '`composes` = you walked the bug once, end to end, across both diffs and the whole is what the report claims. `disagrees` = the two halves pull against each other — that is an OVERTURN AGAINST THE WAVE, not against either lane, so also return the row you want changed in `results`. `unproven` = you could not establish it; say why in `notes`.',
          },
          notes: { type: 'string', description: 'one line. On `disagrees` or `unproven`, what specifically does not hold.' },
        },
        required: ['ids', 'verdict'],
      },
      description:
        'ONE ENTRY PER CANDIDATE PAIR THE BRIEF NAMES — trace the bug once across both diffs as a single path, never lane A\'s half then lane B\'s. Return an empty array ONLY when the brief named no candidates; a candidate you skip is reported as untraced.',
    },
    // Work lands on open tickets by accident constantly: a bug fix turns out to
    // be most of an Improvement nobody scheduled, the ticket sits open for
    // months, and eventually it is built a second time. The bouncer reads the
    // FINISHED diff, so it is the only pass positioned to notice. `partial` is
    // the valuable state — the owner can send it back for the remainder.
    ticketCoverage: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'the issue, e.g. `#160`' },
          state: { type: 'string', enum: ['satisfied', 'partial', 'contradicted'] },
          whatLanded: { type: 'string', description: 'the change in this wave that touches it — point at it, do not assert it' },
          whatIsMissing: { type: 'string', description: 'partial only: precisely what the ticket still asks for. Never a bare percentage.' },
        },
        required: ['ref', 'state', 'whatLanded'],
      },
      description: 'open GitHub issues this wave satisfied, partly satisfied, or contradicted. Empty array if none. You never close an issue yourself — that is outward-facing and happens at the wrap.',
    },
    verifiedClean: {
      type: 'array',
      items: { type: 'string' },
      description:
        'what you PROVED correct and would not spend budget on again — one specific claim per line, each naming the file/behaviour and why it holds. Not "the meeting lane is fine": "checkSlot rule ordering is verdict-preserving — reordering a first-violation-wins ladder cannot change passes". Only claims you actually established; a false entry here silences a future check.',
    },
  },
  required: ['results'],
}

// ---- helpers ----
// `_where` is a STARTING POINT, never a substitute for reading the code. The
// framing below is load-bearing: an excerpt is a snapshot, the tree moves under
// it, and W2 (never build on a claim you have not verified) applies to
// it exactly as it does to a hand-off from another lane. What the Locate pass
// removes is the SEARCH, not the reading.
// X-workshop · was "Shared rule 6" — wrong even before the Workshop migration:
// the never-relay-unverified-claim clause has always lived in rule 2 (now W2),
// never rule 6 (stay in your lane). Re-derived from the charter text itself
// rather than copied, since that is the exact citation-drift class this fixes.
const WHERE_NOTE =
  `\n\nSome issues carry \`_where\` — the cited location resolved for you, with an excerpt and its immediate neighbours. ` +
  `That is a STARTING POINT, not the truth: it is a snapshot taken before this dispatch, another lane may have moved the code since, ` +
  `and the citation itself came from the editor and can be wrong. **Open the file and read it.** Per W2, re-derive the defect from ` +
  `the code on disk before you build on it — if \`_where\` disagrees with what you find, the file wins and say so in your notes. ` +
  `What this saves you is hunting for the location, not verifying it.`

// X22 · Named in the dispatch, not left to the schema description alone: the slug
// only groups if it is reused verbatim, and a lane cannot reuse a vocabulary it
// has never been shown. Printed only when there IS one, so a run with no history
// does not carry an empty instruction.
const INVARIANT_NOTE = KNOWN_INVARIANTS.length
  ? `\n\nINVARIANTS ALREADY IN USE — if an issue is an instance of one of these, set \`invariant\` to that slug VERBATIM: ${KNOWN_INVARIANTS.join(', ')}. ` +
    `If it is an instance of a general rule NOT in that list, coin one short slug and use it for every issue in this batch that breaks the same rule. Leave it out for a genuinely local bug.`
  : ''

// 2026-08-16 · printed only when THIS batch actually carries one, same gating
// as WHERE_NOTE above. `source: 'regression'` is the engine's own marker (see
// `regressionNote`/`builtByKey`) — never emitted by a lane, only read by one.
const REGRESSION_NOTE =
  `\n\nAn issue carrying \`source: "regression"\` was reinstated from the \`alreadyBuilt\` list because its identity is marked [REGRESSION] in \`ledger-stats --index\` — closed once, open again. ` +
  `Its \`whyHypothesis\`/\`notes\` name the PRIOR fix's \`file:line\`: investigate WHY that fix did not hold, never re-derive the root cause from zero (editor.md E11).`

// X73 · A NUMBER THAT BOUNDS A DURATION IS THE ONE FIX THAT CANNOT BE SETTLED
// FROM THE CODE. gh#166's news budget went 20s → 8s → 14s across three runs and
// nobody ever timed the path: the handyman dispatch that changed it made ZERO
// log accesses in 17 turns on an issue whose entire content is a duration, and
// the verify escalated it saying verbatim that it had not measured a real
// on-demand gather either. So the third number was a guess dressed as a fix.
//
// This is NOT a widening of the log clause above — measured across five
// consecutive runs, exactly one build lane per run opens the logs, always the
// one holding a timing question, so the clause is not what suppresses this. It
// is one extra thing to CARRY on the narrow class where the code cannot answer,
// and `needs-owner-decision` already exists for the honest negative.
const TIMEOUT_NOTE =
  `\n\n**IF YOUR FIX IS A NUMBER THAT BOUNDS A DURATION** — a timeout, a budget, a retry window — your verdict must carry an OBSERVED figure for the path being bounded (\`the on-demand gather ran 6.2s at maelle-2026-07-30.log:812\`), or say plainly that the path was never observed. ` +
  `A different number with no measurement behind it is the same fix again: gh#166 has been "fixed" three times that way. If you cannot observe the path, that is \`needs-owner-decision\`, not a fourth guess.`

// 2026-08-06 · THE MECHANISM IS NOT THE OUTCOME. Three repairs in one wave each
// built exactly what their brief specified and changed nothing that mattered:
// one fixed the symptom's file:line while the cost was incurred one call site
// up, one stamped a new field going forward with nothing to backfill the rows
// already on disk, one gated on reason-code strings that occur zero times in
// the live table. His own diagnosis: no brief ever asked the lane to check
// real data, so none did — all three failures were visible ONLY in real rows.
const OBSERVABLE_NOTE =
  `\n\n**BEFORE YOU RETURN \`built\` OR \`already-fixed\`** — name the MEASURABLE observable you checked in the \`observable\` field: a check against REAL, LIVE data (query the table, grep a live log, re-run against production input), not a re-read of the code you changed. ` +
  `If the state you are fixing already exists on disk — an existing row, a stored counter, a config value written before your fix — check IT now; a new field or branch does not retroactively reach data already there. If there is genuinely nothing to observe outside the code itself, say so — never leave this blank.`

// X168 · his ask, 2026-08-05: the panel showed a bare lane name and nothing
// else, so a chained run had no way to tell "matchmaker(5), fresh" from
// "matchmaker again, and here's why" without asking. Every label below now
// carries its item count, and any SECOND dispatch of a lane already seen this
// run gets a `dep:` PREFIX (2026-08-07 fix — it shipped as a `·dep` SUFFIX,
// which broke the `<why>:<agent>(<count>)` pattern every other marker
// follows) — because by construction that can only be a dependency round:
// `buildable` is queued whole in round 1, so nothing fresh reaches a lane a
// second time. `dispatchedLanesOnce` is the one bit of state that makes
// "second" checkable instead of inferred from which round number we happen
// to be in — it stays correct whether the second dispatch is a raised ask or
// a resumed originator, without either case being named specially.
const dispatchedLanesOnce = new Set()
// X137 · `asBounce` is the other variation: a re-attempt shows on the
// `/workflows` panel as `rebuild:<lane>(N)` inside the `Verify` phase (X151
// collapsed the old separate `Bounce` box into it), so a second cycle reads
// as a second cycle — the `rebuild:` prefix, not the phase, is what tells it
// apart from a first `Build`-phase attempt by the same lane. A bounce never
// touches `dispatchedLanesOnce`: it already carries its own marker and must
// never also read as a dependency round.
const dispatch = (lane, issues, asBounce) => {
  const isDepRound = !asBounce && dispatchedLanesOnce.has(lane)
  if (!asBounce) dispatchedLanesOnce.add(lane)
  return agent(
    `You are dispatched a batch of atomic issues in your lane. For EACH: **name the root cause with a \`file:line\`** — the place the fix must GO, not where the symptom showed. That is a patch-vs-root judgement, not an evidence exercise: settle it from the code, and reach for the logs only when timing or frequency is genuinely in question. Then build the deep fix within your charter, run \`npm run typecheck\` **ONCE at the END** (not after each edit — every run is a whole turn that re-reads your entire accumulated context, which is what a dispatch actually costs; batch the edits, then check), paper-trace to 100%. If unsure, do NOT build — return the right escalation verdict. Return one verdict per issue per your return contract, and **list every file you edited in \`filesTouched\`** — the tree may hold work from other chats, and that list is how the verify tells your change apart from theirs.${issues.some((i) => i._where) ? WHERE_NOTE : ''}${INVARIANT_NOTE}${TIMEOUT_NOTE}${OBSERVABLE_NOTE}${issues.some((i) => i.source === 'regression') ? REGRESSION_NOTE : ''}\nISSUES:\n${JSON.stringify(issues, null, 2)}`,
    // No `model` here: the tier lives on the lane's charter frontmatter, so a
    // hand-dispatched lane gets it too. Setting it in the engine only made it
    // true on the engine path, which is the shape of failure this framework
    // keeps repeating. Three things to watch, all instrumented here: turns per
    // dispatch (a lighter model may explore more), `overturned` at verify (did
    // fix quality drop), and the pushback ratio in `ledger-stats` — a lane that
    // stops returning `blocked-charter` and `needs-owner-decision` has stopped
    // being governed and is just building, which would NOT announce itself.
    {
      // X151/X168 · the label's job is to name the agent AND how much work it
      // was handed. `Build`/`Context` already say what stage this is, so a
      // bare lane name would be enough there; the count is what the round
      // comment above explains, and `·dep` is the reason a repeat is never
      // fresh work. `Verify` does not say "this is a rebuild", so that prefix
      // stays — see the comment above `dispatch`.
      label: asBounce ? `rebuild:${lane}(${issues.length})` : `${isDepRound ? 'dep:' : ''}${lane}(${issues.length})`,
      phase: asBounce ? 'Verify' : lane === 'instructor' ? 'Context' : 'Build',
      agentType: lane,
      effort: EFFORT[lane],
      schema: VERDICTS,
    },
  )
}

// A dependency ask is real work REGARDLESS of what the lane concluded about its
// own issue. This filter used to require `verdict === 'needs-dependency'`, which
// silently discarded any ask attached to a `built` verdict — and "I finished my
// part, and this adjacent piece belongs to another lane" is the COMMON case, not
// the rare one.
//
// Measured on run wf_6b869440-ef7: five asks were attached, ONE was dispatched.
// The four dropped included a dead-code deletion, a tool-tape rendering fix, a
// prompt-guidance gap that materially strengthened the fix it belonged to, and
// the verify's own prescription for a harm it had just proved. All four looked
// like success in the report because their parent issues said `built`.
const DISPATCHABLE_DEP = new Set(['built', 'confirmed-other-lane', 'needs-dependency', 'already-fixed'])
// X66 · a dep row is DELIVERED whether the lane built it or confirmed another
// lane had. Without this the new verdict would leave the originator looking
// blocked on a dependency that actually landed.
// X97 · and `already-fixed` is the third way a dependency lands: "the thing you
// asked for is already in the code" satisfies the ask exactly as building it
// would. It was the one delivering verdict missing here, so an originator whose
// dep came back already-fixed was never resumed and read `needs-dependency` for
// the rest of the run — verbatim the failure the X66 comment above describes.
const DELIVERED_DEP = new Set(['built', 'confirmed-other-lane', 'already-fixed'])
const hasAsk = (r) => r.dependencyAgent && String(r.dependencyAsk || '').trim().length > 0
const depAsksFor = (lane, rs) =>
  rs
    .filter((r) => hasAsk(r) && r.dependencyAgent === lane && DISPATCHABLE_DEP.has(r.verdict))
    .map((r) => ({ id: `${r.id}>dep`, symptom: r.dependencyAsk, lane, severity: 'high', clarity: 'clear', from: r.id, fromVerdict: r.verdict }))

// Asks the engine must NOT auto-dispatch: the parent verdict is itself waiting
// on the owner (`needs-owner-decision` / `blocked-charter`), so building the
// dependency could implement something he is about to decline. These are
// RETURNED rather than executed — which is the actual fix here. The bug was
// never that they went undispatched; it was that they went unmentioned.
//
// X25 · The SHAPE now matches `depAsksFor` above, field for field. It did not, and
// that was the whole remaining defect: `{from, fromVerdict, lane, ask}` has no `id`,
// no `severity`, no `clarity`, and `ask` where the engine reads `symptom` — so the
// Manager had to recompose every one by hand into `args.issues`. That is the
// compose-instead-of-copy failure X16 exists to remove.
//
// `awaitingOwner` travels WITH the row rather than living only in the array's name,
// because the array name does not survive a copy-paste. Nothing in this engine
// dispatches from here — the dispatch loop reads `depAsksFor`, which filters on
// `DISPATCHABLE_DEP` — but a well-shaped row must never be mistaken for an approved
// one by whatever reads it next.
const deferredDepAsks = (rs) =>
  rs
    .filter((r) => hasAsk(r) && !DISPATCHABLE_DEP.has(r.verdict))
    .map((r) => ({
      id: `${r.id}>dep`,
      symptom: r.dependencyAsk,
      lane: r.dependencyAgent,
      severity: 'high',
      clarity: 'clear',
      from: r.id,
      fromVerdict: r.verdict,
      awaitingOwner: true,
    }))

// ---- 1. Editor — find the work AND shape it, in one pass -------------------
// This was three agents: a GitHub pull, a log review, and a triage that routed
// from their combined output. The split meant the agent making the run's most
// consequential call — which lane owns this, and is it safe to dispatch at all —
// worked from a one-line symptom and a quoted fragment, while the agent that had
// actually read the transcript was already gone. Merging recovers that context.
//
// The routing and shaping DOCTRINE now lives in `.claude/agents/editor.md`, so
// this prompt carries only the mechanics and the payload — the same split the
// lane dispatches use, and the fix for two engines each holding their own
// drifting copy of the lane map.
//
// SKIPPED entirely for a preset list: the owner has already named and routed it.
let allIssues = []
let triageDropped = []
let openKnownDropped = []
let declinedOverridden = []
// X176 · `reported` is the omission guard, separate from the count: `[]` means
// either "checked, found none" or "never checked", and only the editor's own
// return can tell those apart — a missing field must not read as a clean zero.
let matchedOpenBacklog = []
let openBacklogReported = false
let editorReport = {}
let findingsSeen = 0
let locationsResolved = 0
let ticketComplaints = []
let backlogSeen = 0
let backlogNoCite = 0
let backlogReread = []
if (PRESET) {
  log(`Preset: ${PRESET.length} pre-triaged issue(s) from the owner's review — skipping the editor.`)
  allIssues = PRESET
} else {
phase('Intake')
const editor = await agent(
  `Find this run's work and shape it for the lanes. Sources: **${SOURCES.join(' + ')}**. Your charter holds the bar for a finding, the routing map, the merge rules and the \`kind\` call — this brief carries only the mechanics and the payload.\n\n` +
    (SOURCES.includes('logs')
      ? `## The log review\n\n` +
        `**0. ESTABLISH THE CUTOFF MECHANICALLY, BEFORE READING ANYTHING.** The watermark is \`${SINCE}\`.\n` +
        `  a. **Convert it to UTC first.** The watermark carries a local offset (e.g. \`+0300\`); every log line is UTC with a \`Z\`. \`2026-07-26T18:22:00+0300\` is \`2026-07-26T15:22:00Z\`. Comparing the two as text without converting silently reviews the whole day — measured at ~430k wasted on 2026-07-26, when an 18:22 watermark let 04:32Z lines through.\n` +
        `  b. **READ EVERY DATED FILE FROM THE WATERMARK'S DATE THROUGH TODAY — not just today's — AND READ THEM OFF THE VM.** She runs on the GCP VM: the local \`logs/\` dir is STALE (frozen at the 2026-07-31 cutover), and reviewing it returns a clean zero-finding pass over a window nobody read. Same winston file per day (\`maelle-YYYY-MM-DD.log\`), now at \`/mnt/disks/maelle/app/logs/\`, and the watermark is normally ~24h back so it lands in YESTERDAY's file — reviewing only today's leaves the previous evening unreviewed on every single run, which is exactly when she is used. Reach it over IAP SSH:\n` +
        `     \`"C:\\Users\\idanc\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd" compute ssh maelle-agent-vm --zone=europe-west4-b --tunnel-through-iap --quiet --command "<bash to run on the VM>"\`\n` +
        `     \`ls /mnt/disks/maelle/app/logs/\` as that command lists the days; take every dated file at or after the watermark's date, and run your greps as further remote commands so the filtering happens ON the VM and only matches cross the wire. (No \`>\`, \`<\` or bare \`%\` inside a remote command — cmd.exe mangles them. \`powershell -File scripts/vm-logs.ps1 [term] [lines]\` is the quick reader, but it tails only the LATEST file and cannot cover a multi-day window. \`maelle.log\` is a stale legacy file — ignore it.)\n` +
        `     **If the connection fails — \`Reauthentication failed\` means the owner must run \`gcloud auth login\` — STOP and report the log review as UNREACHABLE. Never return \`{issues: []}\` for a log you could not read:** that is indistinguishable from a quiet night, and it is exactly the wrong negative this step exists to prevent.\n` +
        `  c. In the EARLIEST of those files, start at the first entry whose \`"timestamp"\` is >= that UTC instant; everything above it is already reviewed and re-finding it produces a duplicate the owner has seen. Every later file is read from the top.\n` +
        `  d. **ACTIVITY CHECK:** count \`Orchestrator invoked\` events after the cutoff, across all those files. If ZERO **from a successful read** (see b), she handled no turns since the last review — return \`{issues: []}\` immediately and stop. Do not scan, do not reason further. Count that event specifically: \`Catch-up: scanning DMs\` is an idle heartbeat that fires whether or not anyone spoke, and reading it as activity is what made a zero-finding run cost 124k.\n` +
        `  **Report \`filesRead\`, \`cutoffUtc\` and \`turnsAfterCutoff\`.** The manifest prints them and checks \`cutoffUtc\` against the watermark, so a conversion slip or a one-file review shows up instead of passing silently.\n\n` +
        `1. Grep for HARD trouble signals (language-neutral): error and exception lines, guard fires (claimChecker / humanGate / dateVerifier / securityGate flagged or rewrote), "truncated at max_tokens", tool retries and failures, findAvailableSlots rejection breakdowns, approval-escalation misfires, abnormally long threads.\n` +
        `2. Scan shallowly for SOFT signals that leave no error: a reply that does not match what was asked, an attendee or time that silently changed between turns, a confidently-worded answer on a partial result.\n` +
        `3. DEEP-read full turns ONLY for conversations that tripped step 1 or looked off in step 2.\n\n`
      : '') +
    (SOURCES.includes('github')
      ? `## The GitHub pull\n\n` +
        `Run \`gh issue list --label Bug --state open --json number,title,body,labels\` (read-only). One command — do not explore the repo for more. Do not filter by label beyond \`Bug\` — de-duplication is the ledger's job below, not yours.\n\n` +
        `**ENUMERATE THE BODY'S COMPLAINTS FIRST, THEN EMIT ONE ISSUE PER COMPLAINT.** The title is a LABEL for the group, not the symptom. He writes a ticket as a pasted transcript followed by a numbered list of what went wrong — gh#156 ends \`1. why first going to online or person 2. why she lied 3. what does getting back to you mean\` — and **that list IS the work.** Read the title as the symptom and all three collapse into one title-shaped issue: measured on 2026-07-29, gh#156 and gh#158 each carried three complaints and each came back as one issue, so two of every three were never surfaced by any run and every ticket ended PARTIAL.\n` +
        `  • **Count what is explicitly listed. Never infer a list that is not there** — a body that is only a transcript has one complaint, and manufacturing three from it is worse than missing two.\n` +
        `  • **Every emitted issue's \`id\` NAMES ITS PARENT TICKET: \`156-a\`, \`156-b\`, \`156-c\`.** The evidence is that complaint's own words plus any \`file:line\` quoted verbatim, because a citation you do not carry through cannot be used downstream.\n` +
        `  • **A MERGED issue keeps the ticket ref too.** \`source: 'both'\` means both sources are NAMED, not that the log slug wins: on 2026-07-29 the one merged row came back as \`flow-narrates-unexecuted-actions\` with no \`156\` anywhere in it, so gh#156 got no coverage row at all while gh#158 got one — and a ticket with no coverage row is indistinguishable from a ticket with nothing wrong.\n` +
        `  • **Report \`ticketComplaints\`: one \`{ref, complaintsFound, issuesEmitted, dropped}\` per ticket you read, and the arithmetic must close — \`complaintsFound\` = \`issuesEmitted\` + \`dropped.length\`.** Every complaint you do not emit an issue for gets a \`dropped\` entry naming it and WHY (already built, parked, an open row, not a bug, too vague). A complaint that is neither emitted nor named is on no list anywhere: #156 has come back 3→0 twice in three runs, and the manifest now names the shortfall per ticket.\n\n`
      : '') +
    (BACKLOG
      ? `## The backlog re-read\n\n` +
        `Run \`node scripts/ledger-stats.cjs --open\` (read-only) and take **ONLY the rows printed with the \`RE-READ\` prefix** — nobody has stood behind those rows: either the code they cite **moved** after they were written, or **nobody has ever re-read them** (X59, and that second reason is the large half — 28 of 52 on 2026-07-30 against 0 that had moved). **Report \`backlogSeen\`**: how many the command printed. This pass exists to make the list SHORTER, honestly.\n` +
        `  • **The rows it lists under \`cite no file\` are NOT yours.** They cite nothing, so there is nothing to re-read; hunting for their code is unbounded work with no answer at the end. **Report the count as \`backlogNoCite\` and move on** — they go to the owner as a named hand-read list.\n` +
        `  • **EXCEPTION — pull an UNTOUCHED \`source:owner\` row out of that skip, first.** \`--open\`'s no-cite list now prints each row's \`source:<value>\` next to it. A row tagged \`source:owner\` **with no \`recommend\` yet** is not a stale row with nowhere to point — it is a FRESH flag he logged directly in some other chat, outside any run, on purpose (\`.claude/SESSION_STARTER.md\`'s "flag a bug directly" section), and it cites nothing only because nobody has looked yet. **Check \`recommend\` before you touch it — re-run \`node scripts/ledger-stats.cjs --open --json\` and pull the row by its \`ref\`**, which also gives you the FULL \`finding\` text the console line truncates at 88 chars. **A \`source:owner\` row that already carries a \`recommend\` is NOT this case** — it has already been triaged and parked (his own past ruling may be sitting in it, e.g. a \`defer\`) — leave it in the ordinary hand-read list untouched. Only for the untouched ones, **treat it exactly like a raw GitHub or log finding**: validate it against the code from scratch (E1), classify \`atomic\`/\`needs-shaping\` as usual, route it to the owning lane, and emit it into \`issues\` — \`source: 'owner'\`, and its own ledger \`ref\` as the issue's \`id\` (never renumber it, never fold it into a ticket suffix). **Only a row you actually pulled out this way is excluded from \`backlogNoCite\`** — every other no-cite row, owner-sourced or not, keeps today's behavior exactly: not yours, count it, move on.\n` +
        `  • Open the file each row cites and rule: **\`fixed\`** (the defect is gone), **\`moved\`** (still real, elsewhere — give the current \`file:line\` in \`whereNow\`), **\`still-real\`** (still there, as described).\n` +
        `  • **A bare \`fixed\` is REFUSED. Name the commit or the code that proves it** — \`git log -1 --format=%h -- <file>\`, or the branch that now handles the case. A restructured file looks fixed when the defect has only MOVED, and a false close is worse than a stale row because nothing ever looks again.\n` +
        `  • **Emit NO issue for a row you RE-READ here** — it rides on its own row, not as a duplicate. **X129 · your \`recommend\` verb is now ACTED ON in this same run:** a \`build\` verb sends that row to the lane you name in \`lane\`, so write it only where you would dispatch a fresh atomic bug. Every other verb keeps the row on his desk and builds nothing.\n` +
        `  • **THE BAR FOR \`build\`, and erring toward WAITING is correct.** Write \`build\` ONLY when the fix is unambiguous from the finding **and** lands in ONE lane — the same bar you already apply to an atomic issue. **If the answer is a product decision, if it spans two lanes, or if the finding's own premise still needs checking, write a verb that WAITS FOR HIM** (\`resend\` / \`defer\`, or \`convert\` where it has left the bug track). A wrong \`build\` spends a lane on something he never chose; a wrong \`defer\` costs him one word in the morning.\n` +
        `  • **This list is NOT a drop list.** When a GitHub complaint or a log moment you found matches an open row on it, that match CONFIRMS the row is still real — **emit the issue** and name the row in \`whyHypothesis\`. Never drop an intake because the backlog already tracks it, and never report such a match in \`droppedAsOpenKnown\`: on wf_6852af85-afc that is how four complaints the owner had ruled DUE were lost, absent from every count in the funnel. The only drop lists are the two the brief hands you below.\n` +
        `\n### The rows that carry NO \`recommend\` — X130, and this is the valuable half\n\n` +
        `The same \`--open\` output ends with a list headed **"open row(s) carry NO \`recommend\` — he cannot rule on one without reading the whole finding"**. **Take those rows too.** They are the only rows on the board he cannot act on at all: every other row is one word from closed, these need him to read the whole finding first, so they sit for weeks.\n` +
        `  • **Treat each exactly like a RE-READ row** — open the file it cites, judge \`fixed\` / \`moved\` / \`still-real\`, and return it in \`backlogReread\` in the same shape. **Set \`verbAdded: true\` on these**, so the manifest can show what was decided on his behalf and he can overturn it.\n` +
        `  • **Your job here is to make the row RULABLE IN ONE WORD, never to rule it.** The bar for \`build\` above binds hardest here, because nobody has ever looked at these: unambiguous fix, one lane, no product decision — otherwise a verb that waits for him. **His condition, verbatim: fill them "as long as it doesn't hurt my ability to take decisions on places that need me."** A row that needs him must come back still needing him, just with a sentence he can answer.\n` +
        `  • **A bare verb is not rulable, it is a different kind of blank.** Always \`<verb> — <one clause of why>\`.\n` +
        `  • If you cannot reach them all, that is fine and expected — say how many you did not reach. Leaving one unverbed is exactly the status quo and costs nothing.\n\n` +
        `  • Work them in the order printed, and if you run out of room say how many you did NOT reach. \`backlogSeen\` against the length of \`backlogReread\` is how a half-finished pass shows up as a number instead of reading as a clean sweep.\n\n`
      : '') +
    `## Then shape it\n\n` +
    `Merge the two sources, split into ATOMIC issues, route each to the lane that owns the FIX, and classify \`kind\` — all four per your charter. Carry \`clarity\` forward. Give a one-line \`whyHypothesis\`; do NOT prove root causes or design fixes, because the lane does that properly and will re-derive anything you assert anyway.\n\n` +
    `**Where an issue cites a code location, resolve it once and fill \`where\`.** Open the file, take the cited line with ~30 lines either side verbatim, and name who calls it and what it calls. Six lanes otherwise each pay the same hunt for a location you are already looking at. **Never guess** — omit \`where\` rather than send a builder somewhere plausible with false confidence, which is worse than sending it nowhere. Most log findings cite no file; skip those, and do not go exploring for a citation an issue does not make.\n\n` +
    `Report \`findingsSeen\` — the raw count before merging — so the manifest can show how much collapsed.\n` +
    (ALREADY_BUILT.length
      ? `\n## Already fixed, not yet deployed — DROP these\n\n` +
        `Production keeps emitting these symptoms until the owner deploys, so an honest review re-finds them every night. Match them per your charter — **the \`ref\` exactly first** (\`#147\` = \`gh#147\` = \`147\`), **then a shared \`identity\` slug where one is shown below — that is a stronger signal than prose, a rule already proven to break the same way**, then the root cause, then the same user-visible failure described differently. Dispatching one costs a full lane turn to be told "already-fixed": the entire price of the bug, paid again, for nothing.\n\n` +
        `**Report every ref you drop in \`droppedAsAlreadyBuilt\`, and return an empty array if you drop none.** Omitting the field is indistinguishable from never running the check, which is how this check silently failed before.\n\n${ALREADY_BUILT.map(describeBuilt).join('\n')}\n`
      : '') +
    (OPEN_KNOWN.length
      ? `\n## Already settled — DROP or HOLD, per state\n\n` +
        `Each of these left the bug track as a DECISION, not a fix. Its own \`state\` says which: \`converted\` (moved to a GitHub issue where the design question is being worked) or \`declined\` (the owner ruled directly it is not a bug, or not worth fixing). Neither is fixed, so unlike \`alreadyBuilt\` above these do not stop recurring after a deploy — the symptom can reappear indefinitely and you WILL find it again. That is expected. It is not news.\n\n` +
        `**Match on \`ref\` first, then a shared \`identity\` slug where one is shown below, then the description** — same order as \`alreadyBuilt\`.\n\n` +
        `**A \`converted\` match: always DROP it.** List the ref in \`droppedAsOpenKnown\`.\n\n` +
        `**A \`declined\` match: branch on THIS finding's own \`source\` (E2's rule, applied here).** A bare \`logs\` source is a pure automated rediscovery — it can NEVER override a decline: DROP it, but list the ref in \`droppedAsOpenKnown\` all the same, so it is held with a trace rather than silently discarded. Any other source (\`github\`, \`owner\`, \`both\`) is the owner's own act reaching you again — a ticket, a direct restatement — and OVERRIDES the decline: keep the issue, proceed exactly as new work, set \`overridesDeclined\` to the matched ref, and also list that ref in \`overriddenDeclined\`. A decline must never resurface on its own; it comes back only on his own act.\n\n` +
        `**One exception on either state — report it under the SAME ref, never as a new issue:** if the recurrence carries materially new information (it now hits colleagues rather than only him, the frequency has jumped, or it fails in a way the parked description does not cover), say so in \`whyHypothesis\` against that ref. A change in severity is worth knowing; a duplicate row is not.\n\n${OPEN_KNOWN.map(describeOpen).join('\n')}\n`
      : '') +
    (OPEN_BACKLOG.length
      ? `\n## Still open, not yet built or converted — CONFIRM these, never drop\n\n` +
        `Each of these is a bug he already knows about: reported, triaged, and sitting open — not fixed, not converted, not declined. **A fresh finding that matches one is evidence the row is still real, not a new bug.** Unlike the two lists above, do NOT drop it: emit the issue exactly as you would any other, and set \`matchesOpenBacklog\` to the matching row's ref.\n\n` +
        `**Match in this order:** the shared \`identity\` slug where one is shown below — the strongest signal there is — then \`rootCause\` at its \`file:line\`, then the same user-visible failure described differently. **Your own hypothesis about the cause differing from theirs is not evidence of a different bug** — that is the exact trap that let \`dateverifier-hebrew-false-positive\` (open since 2026-07-28) and \`log-dateverifier-falsepos-confirmed\` (built 2026-08-03, same file:line) stand as two unrelated rows for eleven days until he noticed by hand.\n\n` +
        `**Report every match in \`matchedOpenBacklog\`, and return an empty array if you found none.** Omitting the field is indistinguishable from never running the check.\n\n${OPEN_BACKLOG.map(describeOpenBacklog).join('\n')}\n`
      : ''),
  { label: 'editor', phase: 'Intake', effort: EFFORT.editor, agentType: 'editor', schema: EDITOR },
)
allIssues = (editor && editor.issues) || []
triageDropped = (editor && editor.droppedAsAlreadyBuilt) || []
openKnownDropped = (editor && editor.droppedAsOpenKnown) || []
declinedOverridden = (editor && editor.overriddenDeclined) || []
// X176 · `Array.isArray`, not `|| []` — the whole point is telling "reported
// empty" apart from "field omitted", and `||` erases exactly that distinction.
openBacklogReported = Boolean(editor && Array.isArray(editor.matchedOpenBacklog))
matchedOpenBacklog = openBacklogReported ? editor.matchedOpenBacklog : []
findingsSeen = (editor && editor.findingsSeen) || allIssues.length
ticketComplaints = (editor && editor.ticketComplaints) || []
backlogSeen = (editor && typeof editor.backlogSeen === 'number' ? editor.backlogSeen : 0)
backlogNoCite = (editor && typeof editor.backlogNoCite === 'number' ? editor.backlogNoCite : 0)
backlogReread = (editor && editor.backlogReread) || []
editorReport = editor || {}
log(`Editor: ${findingsSeen} raw finding(s) from ${SOURCES.join(' + ')} → ${allIssues.length} atomic issue(s)`)
if (declinedOverridden.length) log(`Reopened ${declinedOverridden.length} previously-declined item(s) by the owner's own act: ${declinedOverridden.join(', ')}`)
if (BACKLOG) log(`Backlog: ${backlogReread.length} of ${backlogSeen} stale row(s) re-read — ${backlogReread.filter((b) => b.state === 'fixed').length} fixed, ${backlogReread.filter((b) => b.state === 'moved').length} moved, ${backlogReread.filter((b) => b.state === 'still-real').length} still real`)
if (OPEN_BACKLOG.length) log(`Open backlog: ${matchedOpenBacklog.length} of ${OPEN_BACKLOG.length} row(s) matched by tonight's fresh findings — confirmed, not dropped.`)
// 2026-08-16 · A REGRESSION MATCH IS NEVER A PURE DROP, same carve-out as the
// preset door above. `droppedAsAlreadyBuilt` entries are bare strings (ref OR
// symptom, per the editor's own schema), so only a REF match is checkable
// here — a symptom-only drop stays a drop, the same limitation `builtRefs`
// already has everywhere else in this file.
const regressionReinstated = triageDropped
  .map((d) => builtByKey.get(refKey(String(d))))
  .filter((entry) => entry && entry.regression)
  .map((entry) => ({
    id: `${entry.ref}>regression`,
    lane: entry.lane || '',
    severity: 'high',
    clarity: 'clear',
    source: 'regression',
    kind: 'atomic',
    symptom: entry.symptom || `${entry.ref} recurring`,
    evidence: entry.rootCause || '',
    whyHypothesis: regressionNote(entry),
    notes: regressionNote(entry),
  }))
if (regressionReinstated.length) {
  allIssues = allIssues.concat(regressionReinstated)
  log(
    `Regression: ${regressionReinstated.length} \`alreadyBuilt\` match(es) marked [REGRESSION] in the ledger index — reinstated instead of dropped: ${regressionReinstated
      .map((r) => r.id)
      .join(', ')}`,
  )
}
}

// X98 · a backlog re-read that comes back `fixed` CLOSES a ledger row with no
// diff behind it — the same no-evidence closure `already-fixed` is, arriving on
// a different path. The X68 spot-check read lane results only, so this path was
// checked by nothing but the editor's own sentence: measured 2026-07-31, 18 of
// the 33 `already-fixed` rows in ledger.jsonl carry `source:'audit'`, which is
// this path and the largest single population of no-diff closures.
//
// `backlogClosable` is the row that WOULD close — `fixed` AND naming a line or a
// commit. It is ONE predicate for the three places that used to spell the same
// regex separately: the unevidenced-fixed warning, this spot-check, and
// `persist.backlog.closeInLedger`. A row the spot-check refuses or never answers
// does not close; it stays a report row, which is the honest state.
const CLOSABLE_CITE = /(:\d+)|(\b[0-9a-f]{7,40}\b)/i
const backlogClosable = (b) => b.state === 'fixed' && CLOSABLE_CITE.test(String(b.evidence || ''))
// `>backlog` mirrors the `>dep` suffix: a derived id, so a backlog ref can never
// be mistaken for a wave issue that happens to carry the same ticket number.
const backlogClaims = backlogReread.filter(backlogClosable).map((b) => ({ id: `${b.ref}>backlog`, ref: b.ref, claim: 'fixed at HEAD', evidence: b.evidence, whereNow: b.whereNow || '' }))

// A lane name outside the known set means the issue matches no lane in the Build
// phase and no `context` pass either — it is silently dropped. That happened on
// 2026-07-25: the router emitted lane `general`, which does not exist. It was
// harmless only because that issue was flagged for the owner and never
// dispatched. Route the unknown to `handyman` (the catch-all, by definition) and
// SAY SO, rather than losing the issue to a typo.
const KNOWN_LANES = new Set([...CODE_LANES, 'instructor'])
const misrouted = allIssues.filter((i) => !KNOWN_LANES.has(i.lane))
if (misrouted.length) {
  log(`! Editor emitted ${misrouted.length} unknown lane(s): ${misrouted.map((i) => `${i.id}→"${i.lane}"`).join(', ')} — re-routed to handyman so they are not silently dropped.`)
  misrouted.forEach((i) => {
    i.notes = `[re-routed from unknown lane "${i.lane}"] ${i.notes || ''}`.trim()
    i.lane = 'handyman'
  })
}

// Ambiguous findings are shown to the owner, NEVER auto-built.
// A `needs-shaping` item is NOT dispatched. It spans lanes, or its fix is a
// product call, or the issue's premise did not survive the code — so the owner
// rules on the SHAPE before a lane spends anything. Dispatching one as a bug
// does not fail loudly: it ping-pongs, burns the night, and still lands on his
// desk needing judgement, which is the most expensive possible order.
// A PRESET item is exempt — he has already approved that routing by naming it.
// X63 · `kind` DECIDES THE BUCKET; `clarity` is a property of the item, not a
// gate on it. The two are not orthogonal in practice — an editor that judges an
// item undecidable marks it `ambiguous` AND `needs-shaping` — so requiring
// `clear` here put all five of wf_27f03aca-0dd's needs-shaping items in
// `flagged`, and `mustAlsoAppear.needsShaping` reported 0 on a run where five
// needed him. The one sentence he must answer reached no surface.
//
// X70 · and a `needs-shaping` item with NO `shapingQuestion` is not a decision,
// it is an un-triaged row. Three of those same five carried none and their
// `whyHypothesis` read "nobody has looked at the code yet". Both go to him
// either way — but SEPARATED and named, so a ruling is visibly a ruling and
// homework is visibly homework. gh#164 came back needs-shaping on two
// consecutive runs, still unexamined, because nothing told them apart.
const shapingAll = PRESET ? [] : allIssues.filter((i) => i.kind === 'needs-shaping')
const needsShaping = shapingAll.filter((i) => String(i.shapingQuestion || '').trim().length >= 15)
const unshaped = shapingAll.filter((i) => !needsShaping.includes(i))
// ── X133 · A PIECE WITH NO `clarity` FELL BETWEEN THE TWO FILTERS ───────────
// `flagged` takes `ambiguous` and `buildable` takes `clear`, so ANY other value
// — absent, empty, a typo, `unclear` — landed in neither set, reached no lane,
// and produced no warning. That is how an approved piece (`gh#51 I1`) vanished
// out of `args.issues` and read as a clean run.
// A PRESET row is normalised rather than warned about: `args.issues` is by
// definition rows the owner already approved and routed, which is the same
// reasoning that exempts a preset from `needs-shaping` above — his approval IS
// the clarity signal, so a missing field cannot be a reason to drop his work.
if (PRESET) {
  const noClarity = allIssues.filter((i) => i.clarity !== 'clear' && i.clarity !== 'ambiguous')
  if (noClarity.length) {
    noClarity.forEach((i) => { i.clarity = 'clear' })
    log(`${noClarity.length} preset piece(s) carried no usable \`clarity\` and were read as CLEAR — he approved them by naming them: ${noClarity.map((i) => i.id || i.ref || '(no id)').join(', ')}`)
  }
}
const flagged = allIssues.filter((i) => i.clarity === 'ambiguous' && !shapingAll.includes(i))
let buildable = allIssues.filter((i) => i.clarity === 'clear' && !shapingAll.includes(i))
// The accounting that makes a silent drop impossible on EVERY path: every issue
// must land in exactly one of the three buckets. A row in none of them has been
// lost, and losing it quietly is the failure this whole file keeps paying for.
const unaccounted = allIssues.filter((i) => !buildable.includes(i) && !flagged.includes(i) && !shapingAll.includes(i))
if (unaccounted.length)
  argWarnings.push(
    `${unaccounted.length} issue(s) reached NO bucket — not buildable, not flagged, not needs-shaping — so they would have been dropped with no trace: ${unaccounted
      .map((i) => `${i.id || i.ref || '(no id)'} [clarity=${JSON.stringify(i.clarity)}]`)
      .join(', ')}. This is X133. They are NOT built; re-dispatch them with a valid \`clarity\`.`,
  )
if (needsShaping.length) {
  log(`${needsShaping.length} item(s) need SHAPING before anyone builds — not dispatched:`)
  needsShaping.forEach((i) => log(`  ? ${i.id} [${i.lane}] ${i.shapingQuestion}`))
}
if (unshaped.length) {
  log(`! ${unshaped.length} needs-shaping item(s) carry NO shapingQuestion — nobody has read the code yet, so these are homework, not decisions:`)
  unshaped.forEach((i) => log(`  ? ${i.id} [${i.lane}] ${(i.symptom || '').slice(0, 90)}`))
}

// ── X128 · MERGE THE QUEUE, AFTER THE EDITOR ─────────────────────────────────
// The whole reason the old prohibition existed is a run that quietly skips
// discovery, so the merge is gated on PROOF the editor actually ran and its
// result is reported as its OWN number, never folded into one total.
// `editorRan` is the observable: on a discovery run the editor block above either
// produced a report or it did not, and "did not" must stop the run rather than
// read as a quiet night with a full queue.
const editorRan = PRESET ? null : Boolean(editorReport && Object.keys(editorReport).length)
const fromEditor = buildable.length
let fromQueue = 0
let fromBacklog = 0

// ── X129 · A RE-READ BACKLOG ROW THAT SAYS `build` BUILDS ────────────────────
// His ruling, 2026-08-02: *"editor build also need to be build. everything that
// is able to build should be build. the stuff that are not to build is the ones
// waiting for me, or the one decline/deferred/moved to github and then there are
// there only for history."* So BUILD is the default and the exclusions are
// explicit — the editor's `recommend` verb IS the authority, the same trust it
// already carries for the atomic-vs-needs-shaping call on every fresh issue.
// Gate on the VERB, never on the display bucket: `--open` prints some rows as
// DECIDE and some as QUEUED, and that column describes where the row sits on his
// desk, not whether the editor would dispatch it.
const BUILD_VERB = /^\s*build\b/i
// X130 · rows that carried no `recommend` until this run. Tracked separately so
// the manifest can name what was decided on his behalf, whichever verb it got.
const newlyVerbed = backlogReread.filter((r) => r && r.verbAdded === true)
const backlogBuildable = []
const backlogUndispatchable = []
if (!PRESET && BACKLOG) {
  for (const r of backlogReread) {
    if (!r || r.state === 'fixed') continue // fixed closes the row; nothing to build
    // `decline` / `defer` / `resend` / `convert` / no recommendation at all — a
    // row waiting on him, or parked, or headed for GitHub. The verb is the whole
    // gate; there is no second list to keep in sync with it.
    if (!BUILD_VERB.test(String(r.recommend || ''))) continue
    if (!r.lane || !KNOWN_LANES.has(r.lane)) {
      backlogUndispatchable.push(r)
      continue
    }
    backlogBuildable.push({
      id: r.ref,
      lane: r.lane,
      severity: r.severity || 'medium',
      clarity: 'clear',
      source: 'backlog',
      symptom: String(r.evidence || '').slice(0, 300),
      evidence: r.whereNow || r.evidence || '',
      notes: `[backlog re-read ${r.state}] ${r.recommend}`,
    })
  }
}
// A row the editor told us to build and then made undispatchable is NOT a quiet
// skip — it is the one case where its own recommendation cannot be honoured.
if (backlogUndispatchable.length)
  argWarnings.push(
    `${backlogUndispatchable.length} backlog row(s) recommend \`build\` but carry no usable \`lane\`, so they could NOT be dispatched: ${backlogUndispatchable
      .map((r) => r.ref || '(no ref)')
      .join(', ')}. They stay open and reach him as usual.`,
  )

if (!PRESET) {
  if (!editorRan)
    throw new Error(
      `The editor returned nothing on a DISCOVERY run, so this run found no work of its own — and ${carriedIn.length} queued item(s) are waiting. Building only the queue here would skip the GitHub pull and the log review while reading as a normal night. Nothing has been dispatched. Re-run, or drain the queue deliberately with \`build\`.`,
    )
  // One de-dupe pass over BOTH extra sources, in order, so a row that is in the
  // queue AND was re-read from the backlog AND was independently re-found by
  // tonight's intake is added exactly once.
  const seen = new Set(buildable.map((i) => refKey(i.id || i.ref)))
  const take = (items) => {
    const out = []
    for (const i of items) {
      const k = refKey(i.id || i.ref)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(i)
    }
    return out
  }
  const mergedQueue = take(carriedIn)
  const mergedBacklog = take(backlogBuildable)
  fromQueue = mergedQueue.length
  fromBacklog = mergedBacklog.length
  buildable = buildable.concat(mergedQueue, mergedBacklog)
  if (fromQueue || fromBacklog)
    log(`Merged: ${fromEditor} from the editor + ${fromQueue} from state.pendingOverflow + ${fromBacklog} from the backlog re-read = ${buildable.length} buildable.`)
}

// Severity-first cap so a heavy day cannot overrun the window; the rest is reported as pending.
// X128 · the merged queue rides the SAME sort and the SAME cap — a carried item
// is not privileged, it just joins the list.
const RANK = { high: 0, medium: 1, low: 2 }
buildable.sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3))
const pending = buildable.slice(CAP)
buildable = buildable.slice(0, CAP)
if (pending.length) log(`Cap ${CAP}: ${pending.length} lower-severity issues deferred to next run.`)
// X77 · `flagged-for-owner` was a LEDGER VERDICT as well, meaning the opposite of
// this — a verify discovery that is explicitly NOT for him. That verdict is now
// `queued-next-run`, and these rows keep the state they always had: ambiguous
// intake, genuinely his, and they reach him as `pending owner` report rows.
log(`Queue: ${buildable.length} clear to build, ${flagged.length} ambiguous for owner, ${pending.length} pending.`)
buildable.forEach((i) => log(`  • build [${i.lane}/${i.severity}] ${i.id} — ${(i.symptom || '').slice(0, 90)}`))
flagged.forEach((i) => log(`  • ambiguous — pending owner ${i.id} — ${(i.symptom || '').slice(0, 90)}`))

// ---- 2c. COLLECT mode stops here — found and recorded, nothing built ----
// Reached ONLY when the owner explicitly asked for findings without work. The
// default is and must stay `full`: he is away, so the fixes should exist by the
// time he is back. See the MODE comment above for why this must never be
// selected automatically.
if (MODE === 'collect') {
  log(`Collect mode: ${buildable.length} issue(s) recorded, ${flagged.length} flagged. NOTHING built — the owner batches these when he is back.`)
  return {
    mode: 'collect',
    // X24 · THE SAME KEY SET as the full-run funnel at the bottom of this file, and
    // this is the path that needs it MOST: it is the one mode that builds nothing by
    // design, so `built: 0` here is a CORRECT zero and must be legible as one. The old
    // literal had six keys against the full run's ten, so the two modes could not be
    // read the same way and a collect run looked like a failed full run.
    // `dispatched: 0` is stated rather than omitted — the reason nothing was built is
    // the mode, not the yield.
    counts: {
      findings: findingsSeen,
      atomic: allIssues.length,
      buildable: buildable.length + pending.length,
      // X-BUILDABLEMIX · `buildable` is a SUM of three sources with three very
      // different meanings — tonight's own intake, a stale queue re-injecting
      // itself, and a backlog row promoted by its own `recommend`. Printed as
      // one opaque number, "buildable: 12" cannot be told apart from "12 fresh
      // bugs tonight", and wf_b3690654-f4b was the former (1 fresh, 11 carried)
      // read as if it were the latter. These three ALWAYS sum to `buildable`
      // by construction (the dedup pass above assigns each item to exactly one).
      fromEditor,
      fromQueue,
      fromBacklog,
      dispatched: 0, // by design: collect mode records and returns, it never dispatches
      built: 0,
      alreadyFixed: 0,
      needsShaping: needsShaping.length,
      needsShapingUnexamined: unshaped.length, // X70 · needs-shaping with no question — homework, not a decision
      flagged: flagged.length,
      needsOwner: 0,
      pending: pending.length,
    },
    results: [],
    collected: buildable, // pass straight back as `args.issues` to build them
    flagged,
    unshaped,
    // The over-cap rows, not `[]`. They were computed above and then dropped from
    // BOTH the return and the count, so a capped collect run silently lost them —
    // and a funnel that names a number while withholding its rows is a worse lie
    // than the zero it replaced.
    pending,
    // X42 · a collect run over the backlog would otherwise drop the only thing it
    // produced, since this return happens before the manifest is built.
    backlogReread,
    verifiedClean: [],
  }
}

// ---- 2b. Locations — resolved by the editor, in the same turn ---------------
// Every builder used to open with the same hunt: grep, read a 1,400-line file,
// read the wrong one, find the thing, then read it properly. Six lanes each
// paying that discovery tax — ~5,300 lines across the five files the scheduling
// lanes keep re-reading, most of it read several times in one run.
//
// That used to be a separate Haiku pass. It could only fire when `evidence`
// happened to carry a file path, and when it did it re-opened from scratch the
// very issue the router had just been holding. The editor is already there with
// the issue body and the transcript in hand, so it fills `where` as it goes and
// the pass is gone.
//
// This removes the SEARCH, never the reading: the builder still opens the file
// and re-derives (see WHERE_NOTE), because an excerpt trusted blind is the relay
// bug at framework scale.
buildable = buildable.map((i) => (i.where && i.where.excerpt ? { ...i, _where: i.where } : i))
locationsResolved = buildable.filter((i) => i._where).length
if (locationsResolved) log(`Locations: ${locationsResolved} citation(s) resolved by the editor — the lanes skip the hunt.`)

// ---- 3. THE BUILD LOOP — rounds until nothing is pending ------------------
// Replaces a fixed Build → Context → single-tail sequence, which capped
// dependency chains at DEPTH TWO: a lane raised an ask, the tail round built it,
// and if that lane raised a NEW ask nothing ever read it. With six asks already
// lost tonight to a filter, a silent depth limit is the next quiet loss waiting.
//
// Each round: every lane with pending work builds in parallel, `context` runs
// LAST within the round, then the asks and resumes that round produced become the
// next round's pending work. `feature.js` already proved this shape; bugger kept
// the older fixed one, so the two engines behaved differently for no reason.
//
// Ids encode depth and stay unique: `1` → `1>dep` → `1>dep>dep`. A RESUME reuses
// the original id (it replaces that row) and is tracked separately so it cannot
// re-fire forever.
// 4, his call 2026-08-02, down from 6: a chain needing six hand-offs is not a
// dependency, it is a decomposition that was wrong, and six rounds spend a full
// lane dispatch each to discover that. Four still allows `1 > dep > dep > dep`.
const MAX_ROUNDS = 4
let results = []
let queue = buildable
const dispatchedIds = new Set()
const resumedIds = new Set()
// Every dependency ask ever MINTED. Counting them off the surviving rows does
// not work: a resume deletes the `needs-dependency` row that carried the ask,
// so an ask that WORKED erases its own evidence before the manifest runs.
const asksMinted = new Set()
let rounds = 0
// Every item ever dispatched, keyed by id. The resume lookup used to read
// `[...buildable, ...nextAsks]` — round ONE plus the current round — so an
// originator born in round two (an ask that itself raised an ask) resolved to
// `{}`, lost its lane, and was silently dropped by the queue filter below,
// AFTER the log line had already announced it would finish next round. The
// manifest's `lanesDispatched` had the identical blind spot for the identical
// reason, so both now read from here. `MAX_ROUNDS` exists precisely to allow
// that depth; the lookup and the cap disagreed.
const specById = new Map(buildable.map((i) => [i.id, i]))

while (queue.length && rounds < MAX_ROUNDS) {
  rounds += 1
  queue.forEach((i) => specById.set(i.id, i))
  const codeWork = queue.filter((i) => i.lane !== 'instructor')
  const ctxWork = queue.filter((i) => i.lane === 'instructor')
  log(`Round ${rounds}: ${codeWork.length} code-lane + ${ctxWork.length} context item(s) — ${[...new Set(queue.map((i) => i.lane))].join(', ')}`)

  // Code lanes in parallel — disjoint files, safe together.
  if (codeWork.length) {
    phase('Build')
    const out = await parallel(
      CODE_LANES.map((lane) => () => {
        const b = codeWork.filter((i) => i.lane === lane)
        return b.length ? dispatch(lane, b).then((r) => (r && r.results) || []) : null
      }),
    )
    results = results.concat(out.filter(Boolean).flat())
  }

  // `context` LAST within the round — including asks the code lanes just raised
  // at it, so a prompt change lands in the same round as the code it describes.
  const ctxAsks = depAsksFor('instructor', results).filter((a) => !dispatchedIds.has(a.id))
  ctxAsks.forEach((a) => asksMinted.add(a.id))
  const toContext = ctxWork.concat(ctxAsks)
  if (toContext.length) {
    phase('Context')
    const cr = await dispatch('instructor', toContext)
    results = results.concat((cr && cr.results) || [])
    ctxAsks.forEach((a) => dispatchedIds.add(a.id))
  }
  queue.forEach((i) => dispatchedIds.add(i.id))

  // ── what this round produced becomes next round's pending work ──
  // (a) fresh asks aimed at a code lane, never dispatched before.
  const nextAsks = CODE_LANES.flatMap((lane) => depAsksFor(lane, results)).filter((a) => !dispatchedIds.has(a.id))
  nextAsks.forEach((a) => asksMinted.add(a.id))

  // (b) originators whose dependency has now LANDED, re-dispatched to finish.
  // Without this an issue sat at `needs-dependency` forever: the other lane built
  // exactly what was asked and nobody ever told the originator, so a finished
  // wave read as blocked.
  const satisfied = new Map()
  for (const r of results) {
    if (DELIVERED_DEP.has(r.verdict) && typeof r.id === 'string' && r.id.endsWith('>dep')) satisfied.set(r.id.slice(0, -'>dep'.length), r)
  }
  const resumes = results
    .filter((r) => r.verdict === 'needs-dependency' && satisfied.has(r.id) && !resumedIds.has(r.id))
    .map((r) => {
      const dep = satisfied.get(r.id)
      const orig = specById.get(r.id) || {}
      resumedIds.add(r.id)
      return {
        ...orig,
        id: r.id,
        lane: orig.lane || '',
        symptom: orig.symptom || r.notes || '',
        severity: orig.severity || 'high',
        clarity: 'clear',
        _dependencyResolved: {
          youAsked: `${r.dependencyAgent}: ${r.dependencyAsk || ''}`,
          theyDelivered: dep.fix || dep.notes || 'see the working tree',
          rootCause: dep.rootCause || '',
        },
      }
    })
  if (resumes.length) log(`  dependencies closed: ${resumes.length} originator(s) will finish next round`)

  // A resumed issue REPLACES its earlier needs-dependency row — same id.
  const replaced = new Set(resumes.map((i) => i.id))
  if (replaced.size) results = results.filter((r) => !(replaced.has(r.id) && r.verdict === 'needs-dependency'))

  // A dropped item here used to vanish in silence — and worse, the "dependencies
  // closed" line above had already claimed it would be finished. Say it instead.
  const unroutable = [...nextAsks, ...resumes].filter((i) => !KNOWN_LANES.has(i.lane))
  if (unroutable.length)
    log(`! ${unroutable.length} item(s) NOT carried into the next round — no resolvable lane: ${unroutable.map((i) => `${i.id}→"${i.lane || 'none'}"`).join(', ')}`)
  queue = [...nextAsks, ...resumes].filter((i) => KNOWN_LANES.has(i.lane))
}
// Silent truncation reads as "everything got done". If the cap stopped us with
// work still queued, that is a fact the owner must be told.
if (queue.length) {
  log(`! ROUND CAP: ${queue.length} item(s) still pending after ${MAX_ROUNDS} rounds — ${queue.map((i) => `${i.id}→${i.lane}`).join(', ')}. NOT built.`)
}

// ---- 5. Verify — ONE adversarial pass over the COMBINED diff, never one per fix ----
// This used to fan out N per-fix verifies. That shape is both more expensive and
// strictly blinder: a per-fix pass cannot see the only defect class that actually
// needs an bouncer — two lanes whose fixes are each correct alone and wrong
// together. Every cross-lane defect this framework has caught came from a
// combined-diff pass (the 4.2.0 wrap; the 2026-07-26 checkSlot wave, where a
// combined pass caught a regression a fix had introduced ONE ROUND earlier).
// None came from a per-fix one. Going from N calls to 1 also pays for the
// strongest model on the single highest-judgment step in the loop, which is why
// `opus` is PINNED below rather than inherited — and why it matters more now
// that the lanes themselves run on Sonnet.
phase('Verify')
let verified = results
let verifiedClean = []
let verifyDepAsks = []
// `ran` used to be hardcoded `true` whenever the VERIFY flag was on. But
// `agent()` returns null when a subagent dies after retries, and every read of
// `check` below is null-guarded — so a verify that never happened produced
// exactly the manifest of one that found nothing: `ran:true, overturned:0`.
// The single thing the operator checklist watches for is a skipped verify, and
// the field it watches could not report it. Now it reports what happened.
let verifyRan = false
let verifyAttempted = 0
// ── X137 · THE BOUNCE COUNTER ───────────────────────────────────────────────
// His ruling, 2026-08-03: *"we can bounce stuff once, not twice."* An OVERTURN
// now goes back to the lane that built it instead of straight to his desk — but
// exactly once, because a second failure on one item is a signal, not something
// to retry. `bounces` rides on the item, so a row he re-sends next run carries
// its history in and cannot be bounced a second time.
//
// WHAT BOUNCES AND WHAT DOES NOT, and getting this wrong is what makes a wave
// never terminate: an **overturn** is *"the thing we said we fixed, we did not
// fix"* — a failed claim about THIS wave's own work, so it goes back. A
// **discovery** is *"here is something else worth doing"* — new work, and it
// queues for the next run exactly as before. Bouncing discoveries would make
// every pass generate its own next round forever.
const BOUNCE_LIMIT = 1
let bouncedIds = []
let bounceRecheckRan = false
let bounceCleared = []
let bounceStillWrong = []
let bounceAtLimit = []
let bounceUnroutable = []
let bounceDepAsks = []
// X143 · `eligible` and `escalated` are what make a ZERO readable. `bounced: 0`
// alone cannot tell "the bouncer overturned nothing, so the round correctly did
// not fire" from "rows were overturned and none of them could be sent back" —
// and those are opposite facts. `eligible` is the first pass's overturn count,
// so `eligible:0 bounced:0` is the healthy silence and `eligible:3 bounced:0` is
// a defect. `escalated` is what actually reached his desk after everything.
let bounceEligible = 0
let bounceEscalated = 0
// X182 · question 1's denominator and numerator — same reasoning as X144's
// pair below, one question earlier. `outcomeCandidates` is what the ENGINE
// derived (every row this wave marks `built`); `outcomeTraces` is what came
// back. Recorded even at zero, for the reason X143 gives.
let outcomeCandidates = []
let outcomeTraces = []
let outcomeUntraced = []
// X144 · question 1b's denominator and numerator. `jointCandidates` is what the
// ENGINE derived and handed over; `jointTraced` is what came back matching one.
// Both are recorded even at zero, for the reason X143 gives: a mechanism that
// reports nothing when it does nothing looks exactly like one that is absent.
let jointCandidates = []
let jointTraces = []
let jointUntraced = []
let waveFiles = []
let priorCleanDropped = []
let discoveries = []
let ticketCoverage = []
let spotCheckUnanswered = [] // X68 · already-fixed rows the verify never answered on
let backlogConfirmed = new Set() // X98 · backlog refs the spot-check agreed are fixed at HEAD — the only ones that close
// X98 · the one test for "this backlog row is closed", read by `persist.backlog`
// below and by the warning that counts what did not survive. It is deliberately
// ONE function rather than the same conjunction written twice, because the two
// lists it feeds must partition the re-read exactly.
const backlogCloses = (b) => backlogClosable(b) && (!VERIFY || backlogConfirmed.has(b.ref))
if (VERIFY) {
  const built = results.filter((r) => r.verdict === 'built')
  // X68 · `already-fixed` is the one bucket that CLOSES a row on a lane's own
  // word, and it was the one bucket the verify never saw — the payload was
  // `built` only. On wf_27f03aca-0dd a severity-HIGH row
  // (gh#158-availability-asserted-unsearched) closed that way with `filesTouched`
  // empty and nobody checked it. The lane's evidence there was good, which is the
  // point: nothing distinguished it from a bad one. These are SPOT-CHECKED, not
  // re-verified — one read of the cited code each, no trace, no budget.
  const claimedFixed = results.filter((r) => r.verdict === 'already-fixed')
  // X98 · the backlog's `fixed` rows join them. Same claim, same one-read answer,
  // one list — a second spot-check block would be a second copy of the same prose.
  const spotCheck = [...claimedFixed, ...backlogClaims]
  verifyAttempted = built.length
  if (built.length || spotCheck.length) {
    // Two things are forwarded so nothing is derived twice:
    //   • each fix's own `traced` — what the builder already walked, so the
    //     bouncer attacks the GAPS instead of re-covering covered ground.
    //   • `priorClean` — what earlier verifies proved, carried in by the Manager
    //     from the report. Without it every pass re-audits settled ground.
    // Both are leads, not truth: a builder's coverage claim and a past pass's
    // conclusion are exactly the kind of relay W2 exists for, and the
    // prompt says so. Spot-check cheaply; spend the budget on what is NOT there.
    const priorClean = asArray('priorClean', A.priorClean)

    // ── X2: which files are THIS wave's ────────────────────────────────────
    // `git diff` shows every uncommitted change in the tree, and on a normal
    // night that includes another chat's work — seven `src/` files and five
    // `.claude/` files were already modified before the 2026-07-27 run wrote a
    // line. Naming the wave's own files lets the verify attribute correctly
    // instead of overturning a row for a change this run never made. A lane that
    // reports nothing costs waste, not correctness: the fallback is "treat the
    // whole tree as ours", which over-checks rather than under-checks.
    waveFiles = [...new Set(built.flatMap((r) => (Array.isArray(r.filesTouched) ? r.filesTouched : [])).filter(Boolean))]

    // ── X3: drop the `priorClean` entries this wave invalidated ────────────
    // A stale "proven clean" silences a real check, which is strictly worse than
    // having no list — hence the charter's rule to drop when in doubt: re-proving
    // costs one pass, missing a regression costs a person. Until now this was the
    // Manager remembering by hand. Matching is on basename, deliberately loose in
    // the DROP direction for exactly that reason.
    // X84 · KEYED ON POSITION, not on the entry's text. The drop list used to echo
    // back the strings it was handed, and the Manager then matched those strings
    // against `state.verifiedClean` — so a list that was trimmed or reformatted on
    // the way in came back unmatchable: on wf_4bbfc750-1a9, 17 named drops matched 7
    // entries and the other 10 stale "proven clean" claims survived in silence. One
    // of them was `conflictingEvent has exactly ONE writer`, falsified by gh#165-d in
    // that same wave, so it would have told a future verify to SKIP auditing the
    // branch the fix had just added. A stale entry silences a real check, which is
    // strictly worse than having no list — so the key is the index in the array the
    // Manager passed, which is the one thing it cannot reshape.
    const touchedBases = new Set(waveFiles.map((f) => String(f).split('/').pop()).filter(Boolean))
    const dropsAt = (c) => [...touchedBases].some((b) => String(c).includes(b))
    priorCleanDropped = priorClean.map((c, i) => ({ i, entry: c })).filter(({ entry }) => dropsAt(entry))
    const priorCleanKept = priorClean.filter((c) => !dropsAt(c))
    if (priorCleanDropped.length)
      log(
        `priorClean: dropped ${priorCleanDropped.length} of ${priorClean.length} at index ${priorCleanDropped.map((d) => d.i).join(',')} — this wave changed the code they described.`,
      )

    // ── X182 · QUESTION 1'S CANDIDATES — every row this wave claims fixed ─────
    // Every `built` row's own dispatched issue carries a `symptom` (required on
    // `issues` above), so the wave's own claim IS the candidate list — no
    // structural tell to derive, unlike 1b. `specById` still holds the original
    // issue, so the symptom text travels into the brief without the bouncer
    // having to re-find it.
    outcomeCandidates = built.map((r) => ({ id: r.id, symptom: String((specById.get(r.id) || {}).symptom || '').slice(0, 200) }))
    log(
      outcomeCandidates.length
        ? `Outcome-trace candidates (question 1): ${outcomeCandidates.length} row(s) claim a fix — every one is owed a trace or an explicit \`no-symptom\`.`
        : `Outcome-trace candidates (question 1): 0 — nothing was built this wave.`,
    )

    // ── X144 · WHICH ROWS ARE A MULTI-LANE PAIR — derived, never asked for ────
    // `bouncer.md` 1b names three tells and the engine can compute all three, so
    // the pass is handed the list instead of being trusted to find it. Deriving it
    // here also makes the denominator a FACT: `candidates: 0` is readable silence,
    // `candidates: 3, traced: 0` is a defect, and the two used to look identical.
    //
    // A pair needs two DIFFERENT lanes to be worth the name — two rows the same
    // lane built are covered by its own trace and by question 1.
    {
      const laneFor = (id) => (specById.get(id) || {}).lane || ''
      const byId = new Map(results.map((r) => [r.id, r]))
      const seen = new Set()
      const add = (ids, why) => {
        const u = [...new Set(ids)].filter((i) => byId.has(i))
        if (u.length < 2) return
        if (new Set(u.map(laneFor)).size < 2) return // one lane, one trace — question 1 covers it
        const key = [...u].sort().join('+')
        if (seen.has(key)) return
        seen.add(key)
        jointCandidates.push({ ids: u, why })
      }
      // 1 · a `>dep` chain: the engine's own marker that one lane handed the item on.
      for (const r of results) {
        const id = String(r.id || '')
        if (!id.endsWith('>dep')) continue
        add([id.slice(0, -'>dep'.length), id], 'a `>dep` hand-off — one lane asked, another delivered')
      }
      // 2 · `confirmed-other-lane`: by definition a second lane was in the same place.
      for (const r of results) {
        if (r.verdict !== 'confirmed-other-lane') continue
        const file = String(r.rootCause || '').split(':')[0]
        const partners = results.filter((o) => o.id !== r.id && file && String(o.rootCause || '').startsWith(file))
        for (const p of partners) add([r.id, p.id], '`confirmed-other-lane` — a second lane delivered this')
        if (!partners.length) add([r.id, r.id], '`confirmed-other-lane` with no partner found — identify the lane that built it')
      }
      // 3 · two lanes citing one file. The `file:line` may differ; the FILE is the seam.
      const byFile = new Map()
      for (const r of results) {
        const file = String(r.rootCause || '').split(':')[0].trim()
        if (!file || !/\.(?:ts|tsx|js|cjs|mjs)$/.test(file)) continue
        if (!byFile.has(file)) byFile.set(file, [])
        byFile.get(file).push(r.id)
      }
      for (const [file, ids] of byFile) if (ids.length > 1) add(ids, `two lanes cite \`${file}\` as the root — the seam is in that file`)
      if (jointCandidates.length)
        log(`Joint-fix candidates: ${jointCandidates.length} — ${jointCandidates.map((c) => c.ids.join('+')).join(', ')}. The verify must trace each ONCE across both diffs (1b).`)
      else log(`Joint-fix candidates: 0 — no \`>dep\` chain, no \`confirmed-other-lane\`, and no file cited by two lanes. Question 1b has nothing to trace this wave.`)
    }

    const check = await agent(
      // The bar, the standard, the seams-first scope, the trace sampling, the
      // budget, overturn-vs-discovery and the return contract all live in
      // `.claude/agents/bouncer.md` now. Restating them here would be a second
      // copy that drifts — the same mistake the two engines made with the lane
      // map. This brief carries the PAYLOAD only.
      `Verify this wave's COMBINED change before the owner wraps it — ${built.length} fix(es) across the lanes below. **Your charter holds the bar, the standard, the budget and the return contract.**\n\n` +
        (priorCleanKept.length
          ? `**ALREADY PROVEN by earlier passes — settled, do not re-audit.** Anything an earlier pass proved about code THIS wave changed has already been removed from this list, so what remains still stands:\n${priorCleanKept.map((c) => `  • ${c}`).join('\n')}\n\n`
          : '') +
        (waveFiles.length
          ? `**THIS WAVE'S FILES. Everything else in the diff is the environment:**\n${waveFiles.map((f) => `  • ${f}`).join('\n')}\n\n`
          : `**No lane reported which files it touched, so the whole diff is in scope.** Say in your return that you could not separate this wave from work already in the tree.\n\n`) +
        // Your charter tells you to refuse an unfinished wave. On this path the
        // engine KNOWS whether it finished, so it says so rather than leaving
        // you to infer it from a report file — the round loop is the ping-pong,
        // and hitting its cap is the one way it ends with work still owed.
        (queue.length
          ? `**THIS WAVE IS NOT FINISHED.** The dependency loop hit its ${MAX_ROUNDS}-round cap with ${queue.length} item(s) still owed: ${queue.map((i) => `${i.id}→${i.lane}`).join(', ')}. Verify what IS here, and open your return by saying plainly that the wave was truncated and which lanes still owe work — the owner must not read this as a finished pass.\n\n`
          : `The dependency loop closed cleanly in ${rounds} round(s) with nothing owed, so this wave is complete.\n\n`) +
        // X68 · ONE LINE, not a second pass. The cost of a spot-check is one file
        // read per row; the cost of skipping it is a high-severity row closed on
        // an unchecked claim, which is what happened.
        (spotCheck.length
          ? `**SPOT-CHECK — ${spotCheck.length} row(s) CLOSED without building anything.** Nobody has checked these. For each, open the code it names and answer one question: is it actually fixed at HEAD? **One read each — no trace, no budget.** Return a result per row: \`already-fixed\` if the claim was right, any other verdict if it was not. A row you do not return is reported as still unchecked.${
              backlogClaims.length
                ? ` **${backlogClaims.length} of them came from the BACKLOG re-read, not from a lane** — their ids end \`>backlog\` and the claim is that an OPEN ledger row is fixed at HEAD. Answer them in exactly the same way: one confirmed here is deleted from the backlog, one you refuse stays open.`
                : ''
            }\n${JSON.stringify(spotCheck, null, 2)}\n\n`
          : '') +
        // X182 · question 1's denominator, handed over the same way 1b's is —
        // the wave's own claim is the candidate list, so an empty `outcomeTraces`
        // against a non-empty list here is visibly a refusal, not an oversight.
        (outcomeCandidates.length
          ? `**QUESTION 1 — ${outcomeCandidates.length} ROW(S) THIS WAVE CLAIMS FIXED.** Trace each from its reported symptom (or the report's \`Seen:\` line for a loop-born row) to the line where behaviour now diverges — your charter's B2, 100% bar, no sampling. **Return one \`outcomeTraces\` entry per row below**: \`traced\` with the \`file:line\` that proves it, or \`no-symptom\` with why for the rare row with no behavioural outcome (a comment-only fix). A row you leave out is reported as UNTRACED and named to the owner:\n${outcomeCandidates
              .map((c) => `  • ${c.id} — ${c.symptom || '(no symptom text)'}`)
              .join('\n')}\n\n`
          : '') +
        // X144 · 1b's denominator, handed over rather than left to be found. The
        // count is stated in the brief so an empty `jointTraces` is visibly a
        // refusal rather than an oversight.
        (jointCandidates.length
          ? `**QUESTION 1b — ${jointCandidates.length} MULTI-LANE PAIR(S). Trace each ONCE, end to end, across both diffs as a single path** (not lane A's half then lane B's — that is what their own traces already did and it is exactly what misses the seam). **Return one \`jointTraces\` entry per pair below.** A pair you leave out is reported as UNTRACED and named to the owner, so refuse it explicitly with \`verdict:"unproven"\` and a reason rather than omitting it. Where the two halves pull against each other that is an overturn against the WAVE, not against either lane:\n${jointCandidates
              .map((c) => `  • ${c.ids.join(' + ')} — ${c.why}`)
              .join('\n')}\n\n`
          : `**QUESTION 1b: no multi-lane pair in this wave** — no \`>dep\` chain, no \`confirmed-other-lane\`, and no file cited as the root by two different lanes. Return \`jointTraces: []\`.\n\n`) +
        (built.length ? `FIXES IN THIS WAVE:\n${JSON.stringify(built, null, 2)}` : `**NO FIX WAS BUILT IN THIS WAVE** — the spot-check above is the whole job.`),
      // No `model` here either — `bouncer.md` pins Opus. Same reasoning as the
      // lanes, one rung stronger: this is the single highest-judgment step, the
      // only pass that sees the whole diff, and the backstop for Sonnet lanes'
      // traces. Pinning it on the charter means neither the session model nor a
      // hand dispatch can downgrade the one agent that must not be downgraded.
      { label: `bouncer:wave(${built.length})`, phase: 'Verify', agentType: 'bouncer', effort: EFFORT.bouncer, schema: VERIFY_OUT },
    )
    verifyRan = !!check
    verifiedClean = (check && check.verifiedClean) || []
    discoveries = (check && check.discoveries) || []
    ticketCoverage = (check && check.ticketCoverage) || []
    if (discoveries.length) log(`Verify found ${discoveries.length} NEW problem(s) unrelated to this wave — reported, NOT built (building them would invalidate the pass that found them).`)
    // ── X182 · MATCHED AGAINST THE CANDIDATES, never counted on its own ───────
    // Same discipline as 1b: never trust `outcomeTraces` being non-empty by
    // itself — that invites one token line per row that proves nothing. The
    // test is whether every row the engine named is actually accounted for,
    // by id, with EITHER verdict — `traced` or the explicit `no-symptom`.
    outcomeTraces = ((check && check.outcomeTraces) || []).filter((t) => t && t.id)
    {
      const coveredIds = new Set(outcomeTraces.map((t) => t.id))
      outcomeUntraced = outcomeCandidates.filter((c) => !coveredIds.has(c.id))
      const tracedCount = outcomeTraces.filter((t) => t.verdict === 'traced').length
      const noSymptomCount = outcomeTraces.filter((t) => t.verdict === 'no-symptom').length
      log(
        `Outcome traces (question 1): ${outcomeCandidates.length - outcomeUntraced.length} of ${outcomeCandidates.length} row(s) accounted for · ${tracedCount} traced · ${noSymptomCount} no-symptom`,
      )
    }
    // ── X144 · MATCHED AGAINST THE CANDIDATES, never counted on its own ────────
    // A returned trace covers a candidate only when its `ids` contain ALL of that
    // candidate's ids — so one line mentioning one half of a pair does not clear
    // it. This is the whole point of the field: `traced: 3` against
    // `candidates: 3` is coverage, and `traced: 3` against `candidates: 7` is a
    // number that would have read as success.
    jointTraces = ((check && check.jointTraces) || []).filter((t) => t && Array.isArray(t.ids))
    {
      const covers = (cand) => jointTraces.some((t) => cand.ids.every((i) => t.ids.includes(i)))
      jointUntraced = jointCandidates.filter((c) => !covers(c))
      const disagreed = jointTraces.filter((t) => t.verdict === 'disagrees')
      log(`Joint traces: ${jointCandidates.length - jointUntraced.length} of ${jointCandidates.length} candidate pair(s) traced · ${disagreed.length} disagree · ${jointTraces.filter((t) => t.verdict === 'unproven').length} unproven`)
      // A `disagrees` verdict is an overturn against the WAVE. It is surfaced here
      // and warned about below rather than auto-flipping a row: the pass names
      // which row it wants changed in `results`, and that is already read above.
      disagreed.forEach((t) => log(`  ! JOINT FIX DISAGREES — ${t.ids.join(' + ')}${t.sharedRootCause ? ` at ${t.sharedRootCause}` : ''}: ${String(t.notes || '').slice(0, 120)}`))
    }
    ticketCoverage.forEach((t) => log(`  ticket ${t.ref}: ${t.state}${t.state === 'partial' && t.whatIsMissing ? ` — still missing: ${String(t.whatIsMissing).slice(0, 90)}` : ''}`))
    // The verify's OWN dependency asks were being discarded here — the overturn
    // read only `verdict` and `notes`, so when the bouncer said "this needs the
    // owner, and here is precisely what would fix it", the prescription was
    // thrown away and only the objection survived. That happened on
    // wf_6b869440-ef7 to the one finding that mattered most. The verify runs
    // last so its asks cannot be dispatched in this run — they must be reported.
    //
    // X25 · SAME LITERAL as `deferredDepAsks` above, field for field. It was the
    // old four-key shape, and `deferredNow` below CONCATENATES the two arrays — so
    // one heterogeneous list went to the Manager, and a verify-raised row pasted
    // into `args.issues` carried no `clarity`, joined neither `flagged` nor
    // `buildable`, and was dropped without a word. A mixed array is worse than the
    // old shape: half its rows work.
    verifyDepAsks = ((check && check.results) || [])
      .filter((x) => x && hasAsk(x))
      .map((x) => ({
        id: `${x.id}>dep`,
        symptom: x.dependencyAsk,
        lane: x.dependencyAgent,
        severity: 'high',
        clarity: 'clear',
        from: x.id,
        fromVerdict: x.verdict || 'verify',
        awaitingOwner: true,
        fromVerify: true,
      }))
    // X68 · ONE map for both populations, keyed on what each row CLAIMED. A `built`
    // row the verify does not call `built` is an overturn, as before; an
    // `already-fixed` row the verify does not call `already-fixed` is the lane
    // having closed a live bug on its own word. Keying on the claim also fixes a
    // latent bug in the old line: it flipped ANY non-`built` result, so a
    // spot-check answering `already-fixed` would have been read as an overturn.
    const claimed = new Map([...built.map((r) => [r.id, 'built']), ...claimedFixed.map((r) => [r.id, 'already-fixed'])])
    const overturned = new Map(
      ((check && check.results) || [])
        .filter((x) => x.verdict && claimed.has(x.id) && x.verdict !== claimed.get(x.id))
        .map((x) => [x.id, x.notes || '']),
    )
    const answered = new Set(((check && check.results) || []).map((x) => x && x.id))
    spotCheckUnanswered = spotCheck.filter((r) => !answered.has(r.id)).map((r) => r.id)
    // X98 · the backlog half of the answer. A `>backlog` row the spot-check calls
    // `already-fixed` is confirmed and closes; anything else — a different verdict,
    // or no answer at all — leaves the ledger row OPEN. The lane half is handled by
    // `overturned` above, which only reaches rows that live in `results`.
    backlogConfirmed = new Set(
      backlogClaims
        .filter((c) => ((check && check.results) || []).some((x) => x && x.id === c.id && x.verdict === 'already-fixed'))
        .map((c) => c.ref),
    )
    if (backlogClaims.length) log(`  backlog spot-check: ${backlogConfirmed.size} of ${backlogClaims.length} \`fixed\` claim(s) confirmed at HEAD — only these close.`)

    // ── X137 · ONE BOUNCE, THEN HIS DESK ─────────────────────────────────────
    // Until now an overturn went straight to `needs-owner-decision`: the bouncer
    // proved the wave had not fixed what it claimed, and the answer was to wake
    // him up about it. Measured on wf_e2b7aeeb-325's aftermath, that is also the
    // EXPENSIVE answer — its overturns came back the next morning as two whole
    // extra runs (wf_e2fd1caf-c84 $53, wf_94e9e397-06a $20, both measured by
    // `scripts/spend.cjs --runs`), each paying a fresh intake and a fresh full
    // bouncer pass to do what one round inside the wave does.
    //
    // ONE round, and it is FLAT — deliberately not the `while` loop above. A
    // dependency ask raised in here is REPORTED, never dispatched, so this can
    // never re-enter the round machinery and multiply with `MAX_ROUNDS`. The
    // whole ceiling is: ≤MAX_ROUNDS build rounds · 1 bouncer · 1 bounce round ·
    // 1 scoped re-check. Nothing here can add a second bounce to anything.
    //
    // THE RE-CHECK IS MANDATORY AND IT FAILS CLOSED. A bounce nobody verifies is
    // worse than no bounce, because the wave would then claim a fix that was
    // never re-examined — which is precisely the `verify.ran` hardcoded-true
    // failure this engine already paid for. If the re-check does not return,
    // every bounced row goes to his desk saying so.
    const laneOf = (id) => (specById.get(id) || {}).lane || ''
    const bounceOf = (id) => Number((specById.get(id) || {}).bounces || 0)
    let finalOverturn = new Map(overturned)
    // X143 · the denominator, recorded whether or not anything bounces. These
    // three PARTITION the first pass's overturns, so `eligible` always equals
    // `bounced + atLimit + unroutable` and a silent drop is arithmetically
    // impossible to hide.
    bounceEligible = overturned.size
    bounceAtLimit = [...overturned.keys()].filter((id) => bounceOf(id) >= BOUNCE_LIMIT)
    bouncedIds = [...overturned.keys()].filter((id) => bounceOf(id) < BOUNCE_LIMIT && KNOWN_LANES.has(laneOf(id)))
    bounceUnroutable = [...overturned.keys()].filter((id) => bounceOf(id) < BOUNCE_LIMIT && !KNOWN_LANES.has(laneOf(id)))
    if (bounceAtLimit.length)
      log(`  NOT bounced — already at the ${BOUNCE_LIMIT}-bounce limit, straight to the owner with both attempts: ${bounceAtLimit.join(', ')}`)
    if (bounceUnroutable.length) log(`  NOT bounced — no resolvable lane, straight to the owner: ${bounceUnroutable.join(', ')}`)
    if (bouncedIds.length) {
      // X151 · no `phase('Bounce')` here anymore — the round runs inside the
      // same `Verify` phase entered above; there is no box to transition into.
      const bounceItems = bouncedIds.map((id) => ({
        ...(specById.get(id) || {}),
        id,
        lane: laneOf(id),
        clarity: 'clear',
        severity: (specById.get(id) || {}).severity || 'high',
        bounces: bounceOf(id) + 1,
        // Named fields rather than prose, so the lane cannot read this as a
        // fresh issue and rebuild what it already built.
        _bouncedBack: {
          youClaimed: claimed.get(id),
          theBouncerRefused: overturned.get(id) || '(no note returned)',
          thisIsAttempt: bounceOf(id) + 2,
          andItIsTheLast: `Your work is already in the tree — read your own diff first, then fix what the bouncer named. If you believe the bouncer is wrong, say so in \`notes\` and return your evidence: that is a legitimate answer and it goes to the owner. Do NOT rebuild from scratch, and do NOT widen the scope. This item cannot be sent back again — a second refusal goes to the owner, not to a third attempt.`,
        },
      }))
      bounceItems.forEach((i) => specById.set(i.id, i))
      log(`Bounce: ${bounceItems.length} overturned row(s) go back ONCE — ${bounceItems.map((i) => `${i.id}→${i.lane}`).join(', ')}.`)
      const bounceOut = await parallel(
        [...new Set(bounceItems.map((i) => i.lane))].map((lane) => () => dispatch(lane, bounceItems.filter((i) => i.lane === lane), true).then((r) => (r && r.results) || [])),
      )
      const rebuilt = bounceOut.filter(Boolean).flat().filter((r) => r && bouncedIds.includes(r.id))
      // The second attempt REPLACES the first — one row per item, same id, so the
      // manifest cannot count one bug as two fixes.
      const rebuiltIds = new Set(rebuilt.map((r) => r.id))
      if (rebuiltIds.size) results = results.filter((r) => !rebuiltIds.has(r.id)).concat(rebuilt)
      const silent = bouncedIds.filter((id) => !rebuiltIds.has(id))
      if (silent.length) log(`! ${silent.length} bounced row(s) returned NOTHING from their lane: ${silent.join(', ')}. They keep the first overturn and go to the owner.`)

      // Asks raised during the bounce. This round does not chain, so a
      // DISPATCHABLE ask here would fall into neither the loop nor
      // `deferredDepAsks` (which takes only NON-dispatchable verdicts) and
      // vanish — the exact silent-drop class this file keeps paying for. The two
      // filters are complements, so every ask lands in exactly one list.
      bounceDepAsks = rebuilt
        .filter((r) => hasAsk(r) && DISPATCHABLE_DEP.has(r.verdict))
        .map((r) => ({
          id: `${r.id}>dep`,
          symptom: r.dependencyAsk,
          lane: r.dependencyAgent,
          severity: 'high',
          clarity: 'clear',
          from: r.id,
          fromVerdict: r.verdict,
          awaitingOwner: true,
          fromBounce: true,
        }))

      // ── X149 · A PENDING DEP-ASK ON A BOUNCED LANE GETS RE-ASKED HERE ────────
      // `verifyDepAsks` was frozen before this round ran, so it cannot know the
      // round's own rebuild happened to satisfy the exact gap it named. Observed
      // 2026-08-03: a pending ask for gatekeeper to import a canonical regex was
      // satisfied by that same round's gatekeeper rebuild (for an unrelated
      // overturn), confirmed only by a human reading the recheck's own
      // `verifiedClean` line — the ask itself still rode to the owner's desk as
      // unresolved. Scoped to asks whose target lane is ALSO bounced this round:
      // the only case where the bouncer is already looking at the right files.
      const bouncedLanes = new Set(bounceItems.map((i) => i.lane))
      const askedDuringBounce = verifyDepAsks.filter((a) => bouncedLanes.has(a.lane))

      // ── THE RE-CHECK — the bounced rows ONLY, never the whole diff again ────
      const rebuiltClaim = new Map(rebuilt.filter((r) => r.verdict === 'built' || r.verdict === 'already-fixed').map((r) => [r.id, r.verdict]))
      const recheck = rebuilt.length
        ? await agent(
            `**RE-CHECK — second and FINAL pass over ${rebuilt.length} row(s) you already overturned once.** Your charter holds the bar and the return contract; this is the same job, narrowed.\n\n` +
              `**Scope is these rows and nothing else.** Do not re-read the rest of the wave — you passed it an hour ago and it has not moved. Do not open new questions on it, and do not raise standards findings outside these files: anything else you notice is a \`discovery\`, which never bounces and never blocks.\n\n` +
              `For each row: **what you refused is quoted on it.** Answer the one question — is the reported problem fixed now? Trace from the symptom, exactly as before. \`built\` if it holds; any other verdict if it does not, and say plainly what is still wrong.\n\n` +
              `**THERE IS NO THIRD ATTEMPT.** A row you refuse here goes to the owner carrying both attempts and both of your notes. So refuse it if it is wrong — that is the correct outcome and it costs one decision, not another round — but do not refuse it for something you did not raise the first time.\n\n` +
              (waveFiles.length ? `**THIS WAVE'S FILES:**\n${waveFiles.map((f) => `  • ${f}`).join('\n')}\n\n` : '') +
              (askedDuringBounce.length
                ? `**ALSO ANSWER — ${askedDuringBounce.length} pending dependency ask(s) on a lane you are rebuilding this round.** Each was raised by an earlier pass and is still unresolved on the owner's desk. You are already re-reading this lane's files for the rebuild above — check whether that SAME rebuild happens to also satisfy it. Return one \`results\` entry per id below: \`verdict:"already-fixed"\` if it is now closed, or \`verdict:"needs-dependency"\` (unchanged) if it is not. Do not build anything new for these — only answer whether they are already closed:\n${askedDuringBounce.map((a) => `  • ${a.id} → ${a.lane}: ${a.symptom}`).join('\n')}\n\n`
                : '') +
              `WHAT YOU REFUSED, AND WHAT CAME BACK:\n${JSON.stringify(
                rebuilt.map((r) => ({ ...r, _youRefused: overturned.get(r.id) || '(no note)' })),
                null,
                2,
              )}`,
            { label: `bouncer:recheck(${rebuilt.length})`, phase: 'Verify', agentType: 'bouncer', effort: EFFORT.bouncer, schema: VERIFY_OUT },
          )
        : null
      bounceRecheckRan = !!recheck
      const recheckResults = ((recheck && recheck.results) || []).filter((x) => x && rebuiltClaim.has(x.id))
      // A discovery raised by the re-check is next run's intake like any other.
      // It NEVER bounces — that is the loop with no exit.
      discoveries = discoveries.concat((recheck && recheck.discoveries) || [])
      verifiedClean = verifiedClean.concat((recheck && recheck.verifiedClean) || [])
      if (askedDuringBounce.length) {
        const resolvedIds = new Set(
          ((recheck && recheck.results) || [])
            .filter((x) => x && x.verdict === 'already-fixed' && askedDuringBounce.some((a) => a.id === x.id))
            .map((x) => x.id),
        )
        if (resolvedIds.size) {
          log(`Bounce re-check also closed ${resolvedIds.size} pending dependency ask(s), satisfied by this round's own rebuild: ${[...resolvedIds].join(', ')}.`)
          verifyDepAsks = verifyDepAsks.filter((a) => !resolvedIds.has(a.id))
        }
      }
      const answeredAgain = new Set(recheckResults.map((x) => x.id))
      for (const id of bouncedIds) {
        const first = overturned.get(id) || ''
        if (!rebuiltIds.has(id)) continue // lane returned nothing — keeps its first overturn
        if (!bounceRecheckRan)
          finalOverturn.set(id, `${first} [BOUNCED ONCE; THE RE-CHECK DIED, so the second attempt is UNVERIFIED — do not read this as fixed]`)
        else if (!answeredAgain.has(id))
          finalOverturn.set(id, `${first} [BOUNCED ONCE; the re-check returned no verdict for this row, so the second attempt is UNCHECKED]`)
        else {
          const again = recheckResults.find((x) => x.id === id)
          if (again.verdict !== rebuiltClaim.get(id)) finalOverturn.set(id, `${first} [ATTEMPT 2 ALSO REFUSED: ${again.notes || ''}] — two attempts, no third; this is yours to rule on.`)
          else finalOverturn.delete(id)
        }
      }
      bounceCleared = bouncedIds.filter((id) => !finalOverturn.has(id))
      bounceStillWrong = bouncedIds.filter((id) => finalOverturn.has(id))
      log(
        `Bounce result: ${bounceCleared.length} cleared on the second attempt, ${bounceStillWrong.length} still wrong and going to the owner${
          bounceRecheckRan ? '' : ' (THE RE-CHECK DID NOT RUN — every bounced row is unverified)'
        }.`,
      )
    }
    // X143 · what actually reached his desk, after the bounce and the re-check.
    bounceEscalated = finalOverturn.size
    // `finalOverturn`, not `overturned`: a row the bounce round fixed and the
    // re-check confirmed is `built` and must not reach his desk. `bounces` rides
    // out on EVERY row that was sent back, whichever way it ended, because the
    // Manager writes it onto the ledger row and it is what stops a second bounce
    // on a future run.
    verified = results.map((r) => {
      const b = Number((specById.get(r.id) || {}).bounces || 0)
      const row = b ? { ...r, bounces: b } : r
      return finalOverturn.has(r.id)
        ? {
            ...row,
            verdict: 'needs-owner-decision',
            notes: `${r.notes || ''} [wave-verify overturned: ${finalOverturn.get(r.id)}]`.trim(),
          }
        : row
    })
  }
}

// ---- RUN MANIFEST — what each mechanism ACTUALLY did ---------------------
// Not decoration. Every silent failure this engine has had was a step that did
// nothing while the run reported success, and each one survived for weeks
// because no number was ever printed next to it. The manifest exists so a
// no-op shows up as a zero in a column where zero is obviously wrong, and
// `warnings` says so in words for the ones we already know the shape of.
//
// Nothing here is an input to any decision — it is purely a record.
// X137 · `bounceDepAsks` is the bounce round's own asks. It is a FLAT round with
// no chaining, so a dispatchable ask raised there has nowhere else to land —
// `deferredDepAsks` takes only NON-dispatchable verdicts, so the two filters are
// exact complements and no ask falls out of both.
const deferredNow = [...deferredDepAsks(verified), ...verifyDepAsks, ...bounceDepAsks]
// Counted from what was MINTED, not from what survived. This used to read
// `verified.filter(hasAsk).length` — but a resume deletes the row carrying the
// ask, so every ask that CLOSED had already erased its own evidence, and a run
// whose dependency machinery worked perfectly reported `attached: 0`. That also
// disabled the Manager's only tell for lost asks
// (`attached > routedAndBuilt + deferredToOwner`): with a structural zero on the
// left it could never fire. The counter was broken in the one direction that
// hides the failure it exists to catch.
const allDepAsks = asksMinted.size + deferredNow.length
// Moved above the manifest so the decision budget can count it (X31); `persist`
// below reuses the same list rather than recomputing it.
// X66 · `confirmed-other-lane` is DONE, so it never lands on his desk — it is
// excluded here for the same reason `already-fixed` is.
const notBuilt = verified
  .filter((r) => r.verdict !== 'built' && r.verdict !== 'already-fixed' && r.verdict !== 'confirmed-other-lane')
  .map((r) => ({ id: r.id, verdict: r.verdict, lane: (specById.get(r.id) || {}).lane || '', why: r.notes || r.fix || '' }))
// ---- X31 · THE DECISION BUDGET -------------------------------------------
// `capBuilds` caps BUILDS and nothing capped DECISIONS, yet decisions are the
// scarce resource: they are the only step that cannot be parallelised, batched or
// delegated, because there is one owner. Measured refs-on-his-desk per engine run
// across the window: 4, 3, 8, 1, 4, 12, then 25 — and the 25 is the night he said
// he could not follow it. His pushback RATE was normal; the number of items each
// pushback had to be spent on was not, and the engine could not tell a run that
// dispatched 100 fixes and asked nothing from one that dispatched 8 and asked 25.
//
// Default 12 is measured, not chosen: it is the highest any run reached on a night
// that worked, so this fires on 25 and on nothing that has ever been fine. A
// warning that fires on the healthy path is the `startedAtLine: 1` mistake.
//
// It WARNS and proposes a deferral. It never truncates — silently keeping the
// first N is the no-silent-caps failure — and it never merges, because merging
// unrelated rows to stay under a budget is worse than 25 honest rows.
const DECISION_BUDGET = typeof A.capDecisions === 'number' ? A.capDecisions : 12
const onHisDesk =
  notBuilt.length + deferredNow.length + needsShaping.length + unshaped.length + flagged.length + pending.length + ticketCoverage.filter((t) => t.state !== 'satisfied').length
// 2026-08-06 · MEASURED OBSERVABLE — o#227/o#228/o#229: three repairs each
// built exactly what their brief specified and delivered none of the outcome
// it existed for, because nothing asked the lane to check the change against
// LIVE data. Computed on `verified` (the FINAL, post-bounce verdicts), not
// `results`, so a row the bounce round rebuilt with a real check clears here
// too. `already-fixed` counts as a close exactly like `built` — either way the
// row is leaving the report on a claim nobody but the lane has checked.
const closedRows = verified.filter((r) => r.verdict === 'built' || r.verdict === 'already-fixed')
const noObservable = closedRows.filter((r) => String(r.observable || '').trim().length < 10)
const manifest = {
  mode: MODE,
  preset: !!PRESET,
  // X31 · the one number that predicts whether he can close the run tonight.
  // `discoveries` is deliberately NOT counted: since X30 they are the next run's
  // intake rather than a row on his desk, which is what brings a night like
  // 2026-07-29 back under budget without dropping anything.
  decisions: { onHisDesk, budget: DECISION_BUDGET, overBudget: Math.max(0, onHisDesk - DECISION_BUDGET) },
  logReview: PRESET
    ? 'skipped (preset issues)'
    : {
        watermarkGiven: SINCE,
        watermarkUtc: WATERMARK_UTC || '(not an ISO watermark)',
        cutoffUtcUsed: editorReport.cutoffUtc ?? '(not reported)',
        filesRead: editorReport.filesRead ?? '(not reported)',
        turnsAfterCutoff: editorReport.turnsAfterCutoff ?? '(not reported)',
      },
  alreadyBuilt: { passedIn: ALREADY_BUILT.length, droppedByTriage: triageDropped.length, dropped: triageDropped },
  // No warning on a zero here, deliberately. Unlike `alreadyBuilt` — where
  // production keeps emitting until deploy, so a recurrence is near-certain — a
  // parked item may simply not have come up tonight. Zero is a normal answer,
  // and a warning that fires on the healthy path is the thing being fixed
  // everywhere else in this file.
  // X51 · `deferredRejected` is the derivation error made visible. Non-zero means the
  // Manager put a due row on the drop list and the engine took it back off.
  openKnown: {
    passedIn: OPEN_KNOWN.length,
    deferredRejected: openKnownDeferred.length,
    dropped: openKnownDropped.length,
    refs: openKnownDropped,
    // X190 · non-zero means a `declined` row was reopened this run — correct
    // ONLY when the matching finding's own source was the owner's own act (a
    // ticket, a direct restatement), never a bare `logs` rediscovery. Named so
    // he can check each ref before the wrap rather than discover it after.
    declinedOverridden: declinedOverridden.length,
    declinedOverriddenRefs: declinedOverridden,
  },
  // X176 · a CONFIRM list, never a drop list — a match means tonight's finding is
  // the SAME bug as an already-open row, so it is emitted as normal, annotated
  // with the ref it matches. Zero matches on an ordinary night warns of nothing,
  // same reasoning as `openKnown` above; `reported: false` is the one that
  // matters, because the field never coming back at all is indistinguishable
  // from the check never running.
  openBacklog: { passedIn: OPEN_BACKLOG.length, matched: matchedOpenBacklog.length, refs: matchedOpenBacklog, reported: openBacklogReported },
  // X43 · what the run picked up out of `state.pendingOverflow`. **The Manager
  // must DELETE `carry.refs` AND `carry.droppedAsBuiltRefs` from
  // `state.pendingOverflow`** — the engine cannot write state, and an entry left
  // there rides into every future run.
  // X128 · a DISCOVERY run drains it too now, so zero-while-the-field-holds-rows
  // is a failure on BOTH doors, not just on a build. `editorRan` and the two
  // source counts below are the proof that the merge did not replace discovery:
  // `fromEditor` is what tonight's GitHub pull + log review actually found, and
  // `fromQueue` is what the queue contributed, and X129's `fromBacklog` is what
  // the re-read sent to a lane. They are never summed into one number, because
  // one total cannot show a run that skipped the editor.
  carry: {
    editorRan,
    fromEditor,
    fromQueue,
    fromBacklog,
    backlogUndispatchable: backlogUndispatchable.map((r) => r.ref || '(no ref)'),
    // X130 · the rows that had NO recommendation until this run, and the verb
    // each was given. This is the engine deciding on his behalf, so it is named
    // per row rather than counted: the morning read shows exactly what was
    // filled in, and any of it is one word to overturn. `newlyVerbedBuild` is
    // the subset that actually went to a lane tonight.
    newlyVerbed: newlyVerbed.length,
    newlyVerbedBuild: newlyVerbed.filter((r) => BUILD_VERB.test(String(r.recommend || ''))).length,
    newlyVerbedRows: newlyVerbed.map((r) => `${r.ref || '(no ref)'} → ${String(r.recommend || '(none)').slice(0, 80)}`),
    carriedIn: carriedIn.length,
    refs: carriedIn.map((i) => i.id || i.ref || '(no id)'),
    droppedAsParked: carriedDropped.length,
    // X46 · non-zero means the field did not drain on a hand dispatch. The refs are
    // named so he can see WHICH stale entry rode in, and delete them from state.
    droppedAsBuilt: carriedBuilt.length,
    droppedAsBuiltRefs: carriedBuilt.map((i) => i.id || i.ref || '(no id)'),
    // X88 · non-zero means he deferred a carried item and this build honoured the
    // skip. The refs are named because the marker has to be cleared by hand now.
    heldAsDeferred: carriedDeferred.length,
    heldAsDeferredRefs: carriedDeferred.map((i) => i.id || i.ref || '(no id)'),
  },
  // X42 · the backlog re-read. `seen` against `reread` is the half-finished tell;
  // `fixed` is the only state that removes a row, so it is the one that has to be
  // evidenced.
  backlog: BACKLOG
    ? {
        seen: backlogSeen,
        reread: backlogReread.length,
        notReached: Math.max(0, backlogSeen - backlogReread.length),
        // X47 · rows no pass can reach, because they cite no file. Printed beside the
        // re-read counts so `22 of 22` cannot read as a finished backlog.
        noCitation: backlogNoCite,
        fixed: backlogReread.filter((b) => b.state === 'fixed').length,
        moved: backlogReread.filter((b) => b.state === 'moved').length,
        stillReal: backlogReread.filter((b) => b.state === 'still-real').length,
        // X98 · the three numbers that say whether the close was checked. `claimed`
        // is the `fixed` rows citing something, `confirmed` is what the spot-check
        // stood behind, `closed` is what actually leaves the backlog. `confirmed`
        // sitting at 0 while `closed` is not is the verify-off run, and it is a
        // warning as well — the shape of no-op this manifest exists to expose.
        fixedClaimed: backlogClaims.length,
        fixedConfirmed: backlogConfirmed.size,
        closed: backlogReread.filter(backlogCloses).length,
      }
    : 'n/a (not a backlog run)',
  // X32 + X33 · the ticket funnel. `complaintsFound` against `issuesEmitted` per
  // ticket, so three-in-one-out is a number here instead of something the owner
  // discovers by re-reading his own ticket at midnight.
  // X80 · `dropped` closes the arithmetic: complaints = emitted + dropped, and every
  // drop in `perTicket` names the complaint and why. A shortfall is a warning below.
  tickets: PRESET
    ? 'n/a (preset)'
    : {
        read: ticketComplaints.length,
        complaints: ticketComplaints.reduce((n, t) => n + (t.complaintsFound || 0), 0),
        emitted: ticketComplaints.reduce((n, t) => n + (t.issuesEmitted || 0), 0),
        dropped: ticketComplaints.reduce((n, t) => n + (Array.isArray(t.dropped) ? t.dropped.length : 0), 0),
        perTicket: ticketComplaints,
      },
  locationsResolved: PRESET ? 'n/a (preset)' : locationsResolved,
  lanesDispatched: [...new Set(verified.map((r) => (specById.get(r.id) || {}).lane).filter(Boolean))],
  misroutedLanes: misrouted.length,
  // X22 · the writer's OWN observable. The field had a reader for a week and no
  // writer, and nothing anywhere said so. This is the number that makes a dead
  // writer visible on the run it dies, instead of in a query a month later:
  // `tagged` against `vocabulary`, so "nobody tagged" and "everybody coined a new
  // slug" read differently. NO warning on a zero, deliberately — a wave of
  // genuinely local bugs is meant to tag none, and a check that fires on the
  // healthy case is the `startedAtLine: 1` mistake.
  invariants: { tagged: verified.filter((r) => r.invariant).length, of: verified.length, vocabulary: KNOWN_INVARIANTS.length, slugs: [...new Set(verified.map((r) => r.invariant).filter(Boolean))] },
  dependencyAsks: { attached: allDepAsks, routedAndBuilt: verified.filter((r) => String(r.id).endsWith('>dep')).length, deferredToOwner: deferredNow.length },
  verify: VERIFY
    ? {
        ran: verifyRan,
        fixesToCheck: verifyAttempted,
        waveFilesNamed: waveFiles.length, // 0 with fixes present = the verify could not tell this wave from the rest of the tree
        priorCleanDropped: priorCleanDropped.length,
        discoveries: discoveries.length, // NEW problems, deliberately not built this wave — next run's input
        ticketsTouched: ticketCoverage.length, // open GitHub issues this wave satisfied, partly satisfied or contradicted

        overturned: results.filter((r, i) => r.verdict !== verified[i].verdict).length,
        verifiedCleanReturned: verifiedClean.length,
      }
    : { ran: false, fixesToCheck: 0 },
  // ── X137 · THE BOUNCE COUNTER · X143 · AND IT EMITS ITS ZERO ───────────────
  // He can SEE the bouncer sending work back rather than take the word for it.
  // `cleared` against `toOwner` is whether bouncing buys anything;
  // `recheckRan:false` with `bounced` non-zero is the one shape that must never
  // read as a clean wave, and the warning below says so.
  //
  // X143 · ALWAYS AN OBJECT, ALWAYS WITH EXPLICIT ZEROS — never omitted, and
  // deliberately NOT the `'n/a (…)'` string the rest of this manifest uses for a
  // skipped mechanism. Two reasons, and the second is the load-bearing one:
  //
  //   1. `bounced: 0` on its own is ambiguous, so `eligible` is beside it. The
  //      three buckets partition `eligible`, so `eligible:0 bounced:0` is the
  //      healthy silence and `eligible:3 bounced:0` is a defect. A mechanism that
  //      reports nothing when it does nothing is indistinguishable from one that
  //      is not there — the exact failure class this file was written against.
  //
  //   2. **THIS BLOCK IS THE ENGINE MARKER FOR THIS CHANGE.** A framework edit
  //      loads once per session, so a long-lived chat runs the OLD engine
  //      silently, and nothing in a run's persisted artefacts records which copy
  //      executed — measured 2026-08-03: `agent-*.meta.json` holds only
  //      `{agentType, spawnDepth}`, the journal holds only agent results, and the
  //      engine's own `log()` output is returned to the chat and persisted
  //      NOWHERE. So the presence of `manifest.bounce` is the proof: the old
  //      engine cannot emit this key. **`bounce` absent = a stale engine, not a
  //      quiet wave.** That is a capability marker rather than a hand-kept
  //      version number, so it cannot go stale and cannot lie.
  bounce: {
    verifyOff: !VERIFY, // true = the round could not have run; every count below is a structural zero
    limit: BOUNCE_LIMIT,
    // eligible = bounced + notBouncedAtLimit + unroutable, always.
    eligible: bounceEligible,
    bounced: bouncedIds.length,
    refs: bouncedIds,
    recheckRan: bounceRecheckRan,
    cleared: bounceCleared.length,
    clearedRefs: bounceCleared,
    toOwner: bounceStillWrong.length,
    toOwnerRefs: bounceStillWrong,
    // Already spent their one bounce on an earlier run, so they went straight to
    // him carrying both attempts. Non-zero is the counter doing its job.
    notBouncedAtLimit: bounceAtLimit.length,
    notBouncedAtLimitRefs: bounceAtLimit,
    // Overturned with no resolvable lane — nowhere to send it, so it escalates.
    unroutable: bounceUnroutable.length,
    unroutableRefs: bounceUnroutable,
    // Every overturn still standing after the bounce and the re-check: what he
    // actually has to rule on.
    escalated: bounceEscalated,
    depAsksRaised: bounceDepAsks.length, // reported, never dispatched — the round does not chain
  },
  // ── X182 · QUESTION 1, MADE OBSERVABLE ─────────────────────────────────────
  // Same shape as `joint` below, one question earlier. `candidates` is the
  // engine's own derivation (every row this wave marks `built`), so it is a
  // fact rather than a claim; `traced` is what the pass actually accounted
  // for, by either verdict. Always present, zeros written — `candidates:0` is
  // readable silence (nothing built), and ABSENT means a stale engine.
  outcome: {
    candidates: outcomeCandidates.length,
    candidateIds: outcomeCandidates.map((c) => c.id),
    traced: outcomeCandidates.length - outcomeUntraced.length,
    untraced: outcomeUntraced.length,
    untracedIds: outcomeUntraced.map((c) => c.id),
    noSymptom: outcomeTraces.filter((t) => t.verdict === 'no-symptom').length,
  },
  // ── 2026-08-06 · THE MEASURED OBSERVABLE, MADE OBSERVABLE ──────────────────
  // `closed` is every row THIS run marked `built` or `already-fixed`; `checked`
  // is how many actually name a real-data check rather than a re-read of the
  // code that changed. Always present, zeros written — `closed:0` is readable
  // silence (nothing closed), ABSENT means a stale engine, same as `outcome`
  // and `joint` above.
  observable: {
    closed: closedRows.length,
    checked: closedRows.length - noObservable.length,
    missing: noObservable.length,
    missingIds: noObservable.map((r) => r.id),
  },
  // ── X144 · QUESTION 1b, MADE OBSERVABLE ────────────────────────────────────
  // `candidates` is the engine's own derivation, so it is a fact rather than a
  // claim; `traced` is what the pass returned that actually covers one. Always
  // present, zeros written — `candidates:0 traced:0` is readable silence, and
  // ABSENT means a stale engine, exactly as `bounce` does. `untracedPairs` names
  // by id what nobody walked, because a count he cannot turn into a list is a
  // number he scrolls past.
  joint: {
    candidates: jointCandidates.length,
    candidatePairs: jointCandidates.map((c) => ({ ids: c.ids, why: c.why })),
    traced: jointCandidates.length - jointUntraced.length,
    untraced: jointUntraced.length,
    untracedPairs: jointUntraced.map((c) => c.ids.join('+')),
    // The verdict split. `disagrees` is an overturn against the WAVE — two halves
    // each correct alone, pulling against each other — and it is the single defect
    // class 1b exists for.
    composes: jointTraces.filter((t) => t.verdict === 'composes').length,
    disagrees: jointTraces.filter((t) => t.verdict === 'disagrees').length,
    unproven: jointTraces.filter((t) => t.verdict === 'unproven').length,
    disagreePairs: jointTraces.filter((t) => t.verdict === 'disagrees').map((t) => `${t.ids.join('+')}${t.sharedRootCause ? ` @ ${t.sharedRootCause}` : ''}`),
  },
}
// Known-shape sanity checks. These are the exact failures already paid for.
// Arg problems go FIRST: an input that never arrived invalidates everything
// reported below it, so it cannot be buried under the log-review tells.
const warnings = [...argWarnings]
// The Workshop fail-closed proof (2026-08-07): W1-W12 live in ONE file now,
// `.claude/WORKSHOP.md`, and every lane charter's first instruction is to read
// it or stop. A charter instruction to stop is invisible to this engine — it
// only sees what a dispatch returns — so `workshopRead` is the one signal that
// makes a silent miss loud instead of looking like an ordinary clean result.
const workshopUnread = results.filter((r) => r.workshopRead === false)
if (workshopUnread.length)
  warnings.push(
    `WORKSHOP NOT READ — ${workshopUnread.length} result(s) report workshopRead:false (${workshopUnread.map((r) => r.id).join(', ')}). That lane built without W1-W12 in context. Do NOT wrap on this; re-dispatch it having confirmed \`.claude/WORKSHOP.md\` is readable.`,
  )
const REVIEWED_LOGS = !PRESET && SOURCES.includes('logs')
// This used to ask "did the review start at line 1?" — which is the CORRECT
// answer whenever the watermark predates today's file, i.e. every normal night.
// So it fired on the healthy path and stayed silent on the real failure. Ask the
// question that actually matters: did the editor compare against the right instant?
if (REVIEWED_LOGS && WATERMARK_UTC && typeof editorReport.cutoffUtc === 'string') {
  const got = Date.parse(editorReport.cutoffUtc)
  if (!Number.isFinite(got)) warnings.push(`Log review reported an unparseable cutoff (\`${editorReport.cutoffUtc}\`) — its watermark cannot be verified.`)
  else if (Math.abs(got - Date.parse(WATERMARK_UTC)) > 60000)
    warnings.push(`LOG WATERMARK SLIPPED — the editor compared against ${editorReport.cutoffUtc}, but the watermark ${SINCE} is ${WATERMARK_UTC}. A timezone slip here re-reviews the whole day; it cost ~430k on 2026-07-26.`)
}
if (REVIEWED_LOGS && editorReport.cutoffUtc === undefined)
  warnings.push('Log review did not report the instant it compared against, so its watermark cannot be verified. Treat any log finding as possibly already-reviewed.')
// The watermark is normally ~24h back, so it lands in YESTERDAY's file. A review
// that never opened that file skipped the previous evening — every night, in the
// window she is actually used.
if (REVIEWED_LOGS && WATERMARK_DAY && Array.isArray(editorReport.filesRead) && editorReport.filesRead.length && !editorReport.filesRead.some((f) => String(f).includes(WATERMARK_DAY)))
  warnings.push(`Log review never opened the watermark's own day (${WATERMARK_DAY}); it read ${editorReport.filesRead.join(', ')}. Everything between ${SINCE} and midnight went unreviewed.`)
if (REVIEWED_LOGS && !Array.isArray(editorReport.filesRead))
  warnings.push('Log review did not report which files it opened, so a single-file review — which skips the previous evening — cannot be ruled out.')
if (VERIFY && verifyAttempted > 0 && verifyRan && waveFiles.length === 0)
  warnings.push(
    `No lane reported \`filesTouched\`, so the verify could not tell this wave from anything else uncommitted in the tree. It checked everything, which is safe but wasteful — and any overturned row may belong to work this run did not do.`,
  )
// ── X182 · QUESTION 1's GATE, and it compares against the DENOMINATOR ────────
// Same discipline as 1b's, one question earlier: never against `outcomeTraces`
// being non-empty — that invites one token line per row that proves nothing.
// The test is whether every row the engine named as `built` is actually
// accounted for. His ruling made Q1 "the whole pass now"; this is the warning
// that makes that claim checkable instead of self-reported.
if (VERIFY && verifyRan && outcomeUntraced.length)
  warnings.push(
    `QUESTION 1 IS UNCOVERED — ${outcomeUntraced.length} of ${outcomeCandidates.length} row(s) this wave claims fixed were NOT traced: ${outcomeUntraced
      .map((c) => c.id)
      .join(', ')}. A fix that cannot be traced back to its reported symptom IS the finding (bouncer.md B1) and nothing else in the loop checks it. Do not wrap on this; send the verify back for these rows.`,
  )
// ── 2026-08-06 · THE MEASURED OBSERVABLE'S GATE ──────────────────────────────
// Build-time, not verify-time: whether the verify ran or not, a lane that
// closed a row without naming what it actually checked against live data is
// the o#227/o#228/o#229 failure repeating — three repairs that each built
// exactly what their brief specified and changed nothing that mattered,
// because nobody queried real data. This fires independent of VERIFY because
// the discipline belongs to the lane's own dispatch, not to the pass that
// reads its diff afterward.
if (noObservable.length)
  warnings.push(
    `MEASURED OBSERVABLE MISSING — ${noObservable.length} of ${closedRows.length} closed row(s) name no real-data check: ${noObservable
      .map((r) => r.id)
      .join(', ')}. The code may be correct and the real-world effect unchecked — this is o#227/o#228/o#229 repeating, where each brief's mechanism was built and nobody queried the live data it was meant to fix. Do not wrap these as confirmed.`,
  )
// ── X144 · 1b's GATE, and it compares against the DENOMINATOR ────────────────
// Never against `jointTraces` being non-empty: a required field invites one token
// line per pair that proves nothing, so the test is whether every candidate the
// engine named is actually covered. This is the warning that makes 1b real — it
// is the only thing standing between "the joint fix was traced" and prose.
if (VERIFY && verifyRan && jointUntraced.length)
  warnings.push(
    `QUESTION 1b IS UNCOVERED — ${jointUntraced.length} of ${jointCandidates.length} multi-lane pair(s) were NOT traced together: ${jointUntraced
      .map((c) => `${c.ids.join('+')} (${c.why})`)
      .join(' · ')}. Two lanes fixing one bug two different ways is the defect this pass exists for, and nothing else in the loop looks for it. Send the verify back for these pairs before wrapping.`,
  )
if (VERIFY && verifyRan && manifest.joint.disagrees)
  warnings.push(
    `A JOINT FIX DISAGREES WITH ITSELF — ${manifest.joint.disagrees} pair(s): ${manifest.joint.disagreePairs.join(' · ')}. Each half is correct alone, which is why neither lane found it. This is an overturn against the WAVE; do not wrap on it.`,
  )
// X143 · the partition, asserted. `eligible` must equal the three buckets it
// splits into; anything else means an overturn went somewhere this manifest does
// not name, which is the silent-drop class rather than a counting slip.
if (VERIFY && bounceEligible !== bouncedIds.length + bounceAtLimit.length + bounceUnroutable.length)
  warnings.push(
    `BOUNCE ACCOUNTING IS WRONG — ${bounceEligible} overturn(s) were eligible but only ${
      bouncedIds.length + bounceAtLimit.length + bounceUnroutable.length
    } are accounted for (${bouncedIds.length} bounced · ${bounceAtLimit.length} at the limit · ${bounceUnroutable.length} with no lane). An overturn has gone somewhere the manifest does not name.`,
  )
// X137 · a bounce whose re-check died is the `verify.ran` failure one level in:
// the lane re-attempted, nothing re-examined it, and without this the row would
// read as an ordinary overturn on his desk instead of an UNVERIFIED second try.
if (VERIFY && bouncedIds.length && !bounceRecheckRan)
  warnings.push(
    `THE BOUNCE RE-CHECK DID NOT RUN — ${bouncedIds.length} row(s) went back to their lane and NOTHING re-examined the second attempt: ${bouncedIds.join(', ')}. They are on your desk marked unverified. Do not wrap on this; run \`/manager verify\` by hand.`,
  )
if (VERIFY && bounceAtLimit.length)
  warnings.push(
    `${bounceAtLimit.length} row(s) were overturned having ALREADY used their one bounce, so they went straight to you with both attempts on them: ${bounceAtLimit.join(
      ', ',
    )}. Two failures on one item is a signal — read the item, not the diff.`,
  )
if (VERIFY && verifyAttempted > 0 && !verifyRan)
  warnings.push(`THE VERIFY DID NOT RUN — ${verifyAttempted} built fix(es) are unchecked. \`agent()\` returns null when a subagent dies after its retries, and every read downstream is null-guarded, so this was previously indistinguishable from a clean pass. Do NOT wrap this run without \`/manager verify\`.`)
if (ALREADY_BUILT.length > 0 && triageDropped.length === 0)
  warnings.push(`alreadyBuilt passed ${ALREADY_BUILT.length} entries and triage dropped NONE — either genuinely all-new, or ref matching failed again (gh#147 vs #147).`)
// X176 · never fires on `matched: 0` — a normal night confirms nothing, same
// reasoning as `openKnown`'s zero above. It fires only when the field never came
// back at all, which is the one state that is genuinely a check that did not run.
if (!PRESET && OPEN_BACKLOG.length > 0 && !openBacklogReported)
  warnings.push(
    `\`openBacklog\` passed ${OPEN_BACKLOG.length} row(s) and the editor never reported \`matchedOpenBacklog\` — the confirm check may not have run at all. Treat tonight's findings as unchecked against the open backlog.`,
  )
if (verified.some((r) => r.verdict === 'already-fixed'))
  warnings.push('A lane returned `already-fixed` — a duplicate reached a full dispatch. alreadyBuilt should have caught it earlier and cheaper.')
// X68 · the close itself, not the waste. A row closed on a lane's own word that
// the verify never answered on is CLOSED AND UNCHECKED, which is the state a
// severity-high row sat in on wf_27f03aca-0dd.
if (spotCheckUnanswered.length)
  warnings.push(
    `${spotCheckUnanswered.length} \`already-fixed\` row(s) were sent for spot-check and came back with NO answer: ${spotCheckUnanswered.join(', ')}. ` +
      `Those rows are closed on the lane's own word and nobody has checked them — do not wrap them as verified.`,
  )
if (!VERIFY && verified.some((r) => r.verdict === 'already-fixed'))
  warnings.push('`already-fixed` row(s) closed with the verify OFF, so nothing checked the claim. That is the only bucket that closes a row without producing a diff anyone can read.')
// X98 · the same sentence for the same closure arriving on the backlog path, plus
// the count of `fixed` claims the spot-check would not stand behind. Both are
// observables the run had no way to state before: the close was unconditional.
if (!VERIFY && backlogClaims.length)
  warnings.push(
    `${backlogClaims.length} backlog row(s) close as \`already-fixed\` with the verify OFF, so nothing opened the code they cite: ${backlogClaims.map((c) => c.ref).join(', ')}.`,
  )
if (VERIFY && backlogClaims.length && backlogConfirmed.size < backlogClaims.length)
  warnings.push(
    `${backlogClaims.length - backlogConfirmed.size} of ${backlogClaims.length} backlog \`fixed\` claim(s) were NOT confirmed by the spot-check and stay OPEN: ${backlogClaims
      .filter((c) => !backlogConfirmed.has(c.ref))
      .map((c) => c.ref)
      .join(', ')}. They are in \`keepInReport\`, not \`closeInLedger\` — do not delete them from the report.`,
  )
if (misrouted.length) warnings.push(`${misrouted.length} issue(s) carried an unknown lane and were re-routed to handyman.`)
// X31 · say it out loud at 17:20 instead of leaving him to discover it at 23:50.
if (onHisDesk > DECISION_BUDGET)
  warnings.push(
    `DECISION BUDGET EXCEEDED — ${onHisDesk} refs need the owner against a budget of ${DECISION_BUDGET}. Prior runs put 1 to 12 on his desk; 25 is the night he could not follow. ` +
      `Nothing has been truncated. Propose DEFERRING the lowest-severity rows to the next run and say which — never merge two rows to get under the number, which buys a smaller list and a worse one.`,
  )
// X32 · three complaints in, one issue out, and no drop to explain it.
if (!PRESET && SOURCES.includes('github')) {
  if (!ticketComplaints.length) warnings.push('The editor reported no `ticketComplaints`, so a ticket whose complaints were collapsed into one issue cannot be seen. Treat every ticket in this run as coverage-unknown.')
  // X64 · SUBTRACT THE COMPLAINTS THE EDITOR DELIBERATELY DROPPED. `complaintsFound
  // > issuesEmitted` alone treats an already-built or parked complaint as an
  // unexplained gap, so the warning named 7, 8 and 8 tickets across three
  // consecutive runs when only 5, 3 and 4 had really lost one. A warning that fires
  // on the healthy path is the `startedAtLine: 1` mistake this file names at :1145.
  //
  // X80 · IT READS THE EDITOR'S PER-COMPLAINT ACCOUNT, not a guess assembled from
  // the engine's ticket-number drop lists. That inference could only count drops,
  // never say WHICH complaint or WHY — so a dropped complaint stayed unnamed and the
  // recovery was the Manager re-reading a ticket the editor had already discarded.
  // `dropped` is required in the schema and carries the reason, so the shortfall is
  // now the true one and every drop is readable in `manifest.tickets.perTicket`.
  const dropCount = (t) => (Array.isArray(t.dropped) ? t.dropped.length : 0)
  const under = ticketComplaints
    .map((t) => ({ t, unexplained: (t.complaintsFound || 0) - (t.issuesEmitted || 0) - dropCount(t) }))
    .filter((x) => x.unexplained > 0)
  if (under.length)
    warnings.push(
      `${under.length} ticket(s) lost complaints with NO reason given: ${under
        .map(({ t, unexplained }) => `${t.ref} ${t.complaintsFound}→${t.issuesEmitted}, ${dropCount(t)} dropped with a reason, ${unexplained} unexplained`)
        .join('; ')}. ` +
        `Those tickets are PARTIAL by arithmetic — do not close them. Each unexplained complaint is on NO list: read that ticket's body and either emit it next run or record why not.`,
    )
  // X33 · the silent half. A merged row that drops the ticket ref leaves the
  // coverage check with nothing to fire on, and a ticket with no coverage row
  // looks exactly like a ticket with nothing wrong.
  const orphanTickets = ticketComplaints
    .map((t) => String(t.ref || '').replace(/\D/g, ''))
    .filter((n) => n && !allIssues.some((i) => String(i.id || '').includes(n)))
  if (orphanTickets.length)
    warnings.push(
      `${orphanTickets.length} ticket(s) named in the editor's input appear in NO issue id: ${orphanTickets.map((n) => `#${n}`).join(', ')}. ` +
        `Nothing downstream can compute coverage for them — this is the gh#156 failure, where a merged row kept the log slug and dropped the ticket number.`,
    )
}
if (deferredNow.length) warnings.push(`${deferredNow.length} dependency ask(s) were NOT dispatched and MUST be rendered in the report — an unreported ask is indistinguishable from one that never happened.`)
// X65 · the same gate `closeInLedger` applies to a backlog `fixed` at :1309,
// pointed at the one claim that had none. A discovery becomes the NEXT run's
// intake without passing any check, so an unevidenced one spends a whole lane
// turn next run to be told `already-fixed`.
{
  const uncited = discoveries.filter((d) => !/:\d+/.test(String(d.evidence || '')))
  if (uncited.length)
    warnings.push(
      `${uncited.length} of ${discoveries.length} discovery(ies) cite no \`file:line\` at HEAD: ${uncited.map((d) => String(d.symptom || '').slice(0, 60)).join(' | ')}. ` +
        `A log line shows the symptom happened, not that the code is still wrong — wf_0cebe938-c81's headline discovery was already fixed at HEAD. Do NOT carry these into the next run's intake without opening the file first.`,
    )
}
// X79 · ONE citation test for a re-read row, and it reads `whereNow` as well as
// `evidence`. The schema tells a `moved` row to put its new `file:line` in
// `whereNow`, so X71's gate — which read `evidence` only — scored a row that
// answered exactly as asked as having opened nothing: on wf_4bbfc750-1a9 two rows
// carrying `createMeeting.ts:1409-1428` and `:144-166` in that field were reported
// unconfirmed and stayed flagged RE-READ, so a re-read that WAS paid for is charged
// again every run — the cost X59 exists to remove. Used by the warning below AND by
// `persist.confirmInLedger`, which is what actually clears the flag; one helper so
// the two cannot answer differently.
const CITES_LOCATION = /(:\d+)|(\b[0-9a-f]{7,40}\b)|(\b[\w./-]+\.(?:ts|tsx|js|cjs|mjs|md|jsonl|json|yaml|log)\b)/i
const backlogCites = (b) => CITES_LOCATION.test(String(b.evidence || '')) || (b.state === 'moved' && CITES_LOCATION.test(String(b.whereNow || '')))
// X42 · a cleanup pass that closes a row on an unevidenced "fixed" is worse than
// the stale row it replaced: the row disappears and nothing ever looks again. The
// brief refuses it; this counts the ones that got through, because a brief is a
// request and a count is an observable.
if (BACKLOG) {
  const unevidenced = backlogReread.filter((b) => b.state === 'fixed' && !backlogClosable(b))
  if (unevidenced.length)
    warnings.push(
      `${unevidenced.length} backlog row(s) were called \`fixed\` WITHOUT naming a commit or a line: ${unevidenced.map((b) => b.ref).join(', ')}. ` +
        `A restructured file looks fixed when the defect has only moved. Treat these as unconfirmed — do NOT remove them from the report or close them in the ledger.`,
    )
  // X71 · the count of rows the pass called still-real WITHOUT opening anything.
  // They stay flagged; this says how many, so a pass that re-read nothing cannot
  // look like a pass that re-read everything.
  const unopened = backlogReread.filter((b) => b.state !== 'fixed' && !backlogCites(b))
  if (unopened.length)
    warnings.push(
      `${unopened.length} backlog row(s) were called \`${unopened[0].state}\` with evidence that names no file, line or commit: ${unopened.map((b) => b.ref).join(', ')}. ` +
        `They are NOT confirmed and stay flagged RE-READ — "still real" with nothing opened is the same claim as "nobody looked".`,
    )
  // X77 · the count of re-reads that opened the code and did not say what to DO
  // about it. Same shape as the two above: they stay flagged rather than being
  // confirmed into a state he cannot rule on.
  const unruled = backlogReread.filter((b) => b.state !== 'fixed' && String(b.recommend || '').trim().length < 10)
  if (unruled.length)
    warnings.push(
      `${unruled.length} backlog row(s) came back with no \`recommend\`: ${unruled.map((b) => b.ref).join(', ')}. ` +
        `They stay flagged RE-READ — a row he cannot build, decline, defer, resend or convert must not be recorded as confirmed.`,
    )
  const notReached = Math.max(0, backlogSeen - backlogReread.length)
  if (notReached)
    warnings.push(`The backlog pass re-read ${backlogReread.length} of ${backlogSeen} stale row(s) — ${notReached} were never opened and are still unconfirmed. Run it again for the rest.`)
  if (!backlogSeen && !backlogReread.length)
    warnings.push(`\`backlog\` was a source and the pass reported NOTHING — either \`--open\` printed no RE-READ rows, or the re-read never ran. Check with \`node scripts/ledger-stats.cjs --open\` before reading this as a clean backlog.`)
  if (backlogNoCite)
    warnings.push(
      `${backlogNoCite} open row(s) cite no file, so no backlog pass will ever re-read them — they are named at the end of \`node scripts/ledger-stats.cjs --open\` and need YOUR read, not a lane's. The backlog is not clean until that list is worked down too.`,
    )
}
log(
  `Manifest — cutoff:${(!PRESET && editorReport.cutoffUtc) || 'n/a'} files:${(Array.isArray(editorReport.filesRead) && editorReport.filesRead.length) || 0}` +
    ` alreadyBuilt:${triageDropped.length}/${ALREADY_BUILT.length} parked:${openKnownDropped.length}/${OPEN_KNOWN.length}` +
    // X176 · a CONFIRM count, not a drop — `matched/passedIn`, printed with zeros
    // included so a run that never checked (`reported:false`) is distinguishable
    // from one that checked and found nothing.
    `${OPEN_BACKLOG.length ? ` openBacklog:${matchedOpenBacklog.length}/${OPEN_BACKLOG.length}${openBacklogReported ? '' : ',NOT-REPORTED'}` : ''}` +
    ` depAsks:${allDepAsks} deferred:${deferredNow.length} misrouted:${misrouted.length} verify:${verifyRan ? 'ran' : 'no'}` +
    // X143 · printed on EVERY run, zeros and all. `bounce:0/0` says the round ran
    // and had nothing to do; the line missing entirely says a stale engine.
    ` bounce:${bounceEligible}elig/${bouncedIds.length}sent${bouncedIds.length ? `(${bounceCleared.length}ok/${bounceStillWrong.length}owner${bounceRecheckRan ? '' : ',RECHECK-DEAD'})` : ''}` +
    `${bounceAtLimit.length ? ` atLimit:${bounceAtLimit.length}` : ''}${bounceUnroutable.length ? ` noLane:${bounceUnroutable.length}` : ''}` +
    // X182 · printed on EVERY run, zeros included. `outcome:0/0` says nothing
    // was built this wave; the field missing says a stale engine.
    ` outcome:${outcomeCandidates.length - outcomeUntraced.length}/${outcomeCandidates.length}${outcomeUntraced.length ? ` UNTRACED:${outcomeUntraced.length}` : ''}` +
    // 2026-08-06 · printed on EVERY run, zeros included. `observed:0/0` says
    // nothing closed this wave; the field missing says a stale engine.
    ` observed:${closedRows.length - noObservable.length}/${closedRows.length}${noObservable.length ? ` MISSING:${noObservable.length}` : ''}` +
    // X144 · printed on EVERY run, zeros included. `joint:0/0` says there was no
    // multi-lane pair to trace; the field missing says a stale engine.
    ` joint:${jointCandidates.length - jointUntraced.length}/${jointCandidates.length}${manifest.joint.disagrees ? ` DISAGREE:${manifest.joint.disagrees}` : ''}${jointUntraced.length ? ` UNTRACED:${jointUntraced.length}` : ''}` +
    ` carried:${carriedIn.length}${BACKLOG ? ` backlog:${backlogReread.length}/${backlogSeen}+${backlogNoCite}nocite` : ''}` +
    `${backlogClaims.length ? ` fixedOk:${backlogConfirmed.size}/${backlogClaims.length}` : ''}` +
    ` decisions:${onHisDesk}/${DECISION_BUDGET} tickets:${ticketComplaints.reduce((n, t) => n + (t.complaintsFound || 0), 0)}→${ticketComplaints.reduce(
      (n, t) => n + (t.issuesEmitted || 0),
      0,
    )}+${ticketComplaints.reduce((n, t) => n + (Array.isArray(t.dropped) ? t.dropped.length : 0), 0)}dropped`,
)
warnings.forEach((w) => log(`! ${w}`))

// ---- X16 · WHAT MUST BE WRITTEN DOWN, pre-shaped -------------------------
// The engine physically cannot write its own result — workflow scripts have no
// filesystem access — so every run's durability depends on the Manager choosing
// to persist it. That makes this the most load-bearing prompt-only step in the
// whole framework, and on 2026-07-28 it failed: the verify overturned four
// fixes, the engine returned them correctly as `needs-owner-decision`, and the
// Manager reported them as PROSE IN CHAT while `report.md` still said "nothing
// is waiting on you" and the ledger still had all eleven rows as `built`. Not a
// missing row — a FALSE one, which is worse, because the owner acts on it.
//
// The write cannot be made structural. So it is made SMALL: hand over the
// finished list plus a sentence that directly contradicts the wrong report,
// instead of the ingredients and an instruction to compose. A copy happens far
// more reliably than a composition — and when it does not, the finished text is
// still sitting here for anyone to recover. Same doctrine as "don't return it"
// for security and "carry, don't guess" for guards: hand over the answer.
const persist = {
  notBuilt,
  // Quote this VERBATIM in the chat. It is written to be impossible to reconcile
  // with a report that says nothing is pending.
  assertion: notBuilt.length
    ? `${notBuilt.length} of ${verified.length} row(s) are NOT built — ${notBuilt
        .map((r) => `${r.id} (${r.verdict})`)
        .join(', ')}. report.md MUST carry each as a row awaiting the owner and MUST NOT say nothing is waiting. The ledger MUST record each with its real verdict, never \`built\`.`
    : `All ${verified.length} row(s) are built. report.md may say nothing is waiting.`,
  // Counts of everything else that must reach the report, so an omission is
  // countable rather than a matter of someone remembering the list.
  mustAlsoAppear: {
    deferredDepAsks: deferredNow.length,
    needsShaping: needsShaping.length,
    needsShapingUnexamined: unshaped.length, // X70 · these reach him too, labelled as unexamined, never merged into the line above
    ambiguousForOwner: flagged.length, // X77 · was `flaggedForOwner`, one letter from re-minting the verdict this run retired

    ticketCoverage: ticketCoverage.length,
    pendingOverCap: pending.length,
    backlogReread: backlogReread.length, // X42 · a re-read nobody wrote down leaves the same 22 rows flagged tomorrow
  },
  // X42 · THE CLEANUP'S RESULT, pre-shaped both ways. Owner, 2026-07-30: a cleanup
  // pass must leave the report UPDATED — dead rows gone, real ones kept. A pass that
  // returns prose leaves the backlog exactly as long as it found it, which is the
  // one outcome that makes it not worth running.
  backlog: {
    // X50 · NO `date` FIELD HERE, and do not add one: `new Date()` and `Date.now()`
    // THROW in a workflow script (they break resume), and the two that sat in these
    // two `.map()`s killed the return of a finished 4-agent wave on 2026-07-30 — all
    // the work paid for, the payload lost. The engine has no clock; the Manager has
    // one and stamps every other ledger row already. So it is handed the act instead.
    stamp: 'As you append each row below, add `"date":"<today, YYYY-MM-DD>"` to it. The engine has no clock and cannot fill it in. A `confirmInLedger` row whose date is not LATER than the commit that moved the code does not clear the RE-READ flag, so the same rows come back tomorrow.',
    // Append each to `ledger.jsonl` — dated, otherwise unchanged — then DELETE that
    // row from report.md. Collapse-by-ref does the rest: it leaves `--open` for good.
    // X98 · AND the spot-check has to have agreed. `backlogClosable` is the CLAIM;
    // `backlogConfirmed` is the second read standing behind it. Keyed on `VERIFY`,
    // not on `verifyRan`: with the verify switched off nothing can confirm, so the
    // claim closes alone and the warning below says nothing checked it — the same
    // treatment a lane's `already-fixed` gets. With the verify ON, an bouncer that
    // died confirms nothing, so nothing closes and `spotCheckUnanswered` names them.
    closeInLedger: backlogReread
      .filter(backlogCloses)
      .map((b) => ({ ref: b.ref, source: 'audit', verdict: 'already-fixed', note: `backlog re-read: ${b.evidence}` })),
    // Everything the pass did NOT close stays a report row — still-real, moved, a
    // `fixed` claim citing nothing, and (X98) a `fixed` claim the spot-check would
    // not confirm. The two lists now PARTITION the re-read: before this, a `fixed`
    // row with no citation fell out of both and the only trace it had existed was a
    // warning. `state` is still what the pass claimed, so a `fixed` row appearing
    // here is precisely one whose claim did not survive.
    keepInReport: backlogReread
      .filter((b) => !backlogCloses(b))
      .map((b) => ({ ref: b.ref, state: b.state, whereNow: b.whereNow || '', evidence: b.evidence, recommend: b.recommend || '' })),
    // X47 · AND append each of these to `ledger.jsonl` too, dated — this is what
    // records that somebody looked. Without it the same row is flagged RE-READ again
    // tomorrow and re-read again the night after, which is what made a nightly
    // backlog pass unaffordable: the staleness check compares the citing commit's
    // date against the ROW's date, so a confirmation is simply a later date.
    // Deliberately carries NO verdict — `--open` merges by ref, so omitting it keeps
    // the row's real state instead of a re-read quietly overwriting his ruling.
    // `rootCause` is written only for a `moved` row, where the location genuinely
    // changed.
    // X71 · THE SAME EVIDENCE GATE `closeInLedger` has one field above, and it had
    // none. Every non-fixed row was stamped `confirmed` unconditionally, so a row
    // whose own evidence read verbatim "Not independently re-read this pass" was
    // relabelled as re-read and stopped being flagged. Measured on wf_f0cfd84d-5f5:
    // 4 of 24 said exactly that, all 4 got a recheck line, and `--open` moved
    // confirmed from 11 to 35. A confirmation nobody made is worse than the stale
    // flag it cleared — the row is now invisible to the very pass that would catch it.
    //
    // It accepts a NAMED FILE as well as a `file:line`, deliberately: two genuine
    // re-reads (gh#144 T2, gh#51 profiler) were proved by a grep returning zero
    // matches, which has no line number to cite. Everything that fails stays in
    // `keepInReport` and stays flagged, which is the honest state — nobody looked.
    //
    // X79 · and it reads `whereNow` on a `moved` row, through the same helper the
    // warning uses. The field the schema demands for a new location is a citation.
    //
    // X77 · AND THE SAME GATE ON `recommend`, for the reason X71 gave about
    // evidence: a row that is confirmed but unrulable reads as HANDLED, and it will
    // never be flagged RE-READ again, so the one pass that could have written the
    // sentence never looks at it twice. Empty recommendation → it stays in
    // `keepInReport`, still flagged, which is the honest state. A false block costs
    // one re-read; a false confirm costs the row.
    confirmInLedger: backlogReread
      .filter((b) => b.state !== 'fixed' && String(b.recommend || '').trim().length >= 10 && backlogCites(b))
      .map((b) => ({
        ref: b.ref,
        recheck: `${b.state}: ${b.evidence}`,
        recommend: b.recommend,
        ...(b.whereNow ? { rootCause: b.whereNow } : {}),
      })),
  },
  // X30 · `discoveries` USED TO BE COUNTED ABOVE, and that is what put a bonus
  // finding on his decide list. His ruling: "if i do want to fix discoveries, its
  // not blocker, its bonus." The label and the array have existed since X8 shipped
  // them on 2026-07-27 — only the routing was wrong, and it was wrong in the
  // policy, not the code. They do NOT become report rows at `pending owner`; they
  // are the NEXT run's first intake items, already lane-assigned and severity-ranked
  // so they drop straight into `args.issues`. He can still promote one by naming it.
  carryToNextRun: { discoveries: discoveries.length },
}

// ---- return the structured report; the Manager persists it (workflow scripts have no filesystem) ----
return {
  manifest,
  warnings,
  // Write `report.md` from THIS, before anything else, and quote `assertion`.
  persist,
  // X24 · THE FUNNEL, not just its endpoints. `buildable` is computed at :482,
  // logged at :494, and was returned in NOTHING — so a run where the work arrived
  // and something legitimately stopped it read identically to a run that found
  // nothing, and `already-fixed` was counted nowhere at all. Every drop between
  // `findings` and `built` now has a named bucket. `buildable` is BEFORE the
  // severity cap, `dispatched` is after it.
  //
  // Deliberately NOT a reconciliation assertion in code: a `>dep` row is dispatched
  // without ever being an intake issue, so the arithmetic does not close on a
  // healthy run and a check would cry wolf every time — the `startedAtLine: 1`
  // mistake. The buckets are for the reader; the missing-bucket question is his.
  counts: {
    findings: findingsSeen,
    atomic: allIssues.length,
    buildable: buildable.length + pending.length,
    // X-BUILDABLEMIX · the same three-way split as the collect-mode return
    // above — see that comment. Always sums to `buildable`.
    fromEditor,
    fromQueue,
    fromBacklog,
    dispatched: buildable.length,
    built: verified.filter((r) => r.verdict === 'built').length,
    // X66 · a row another lane delivered. NOT added to `built` — one change
    // counted twice is what the Manager was correcting by hand in state.json.
    confirmedOtherLane: verified.filter((r) => r.verdict === 'confirmed-other-lane').length,
    alreadyFixed: verified.filter((r) => r.verdict === 'already-fixed').length,
    needsShaping: needsShaping.length,
    needsShapingUnexamined: unshaped.length, // X70
    flagged: flagged.length,
    needsOwner: verified.filter((r) => r.verdict === 'needs-owner-decision' || r.verdict === 'blocked-charter').length,
    pending: pending.length,
  },
  results: verified,
  flagged,
  // Deliberately NOT built — the owner rules on the shape first. Render these in
  // the report as `pending owner` with the shapingQuestion, and dispatch whatever
  // he approves via `args.issues`, where the preset path exempts them.
  needsShaping,
  // X70 · needs-shaping items whose `shapingQuestion` is missing or a stub. They
  // are STILL his rows and still rendered (Pending owner group) — but with
  // `Recommend: unclear — nobody has read the code yet` in the Your-options
  // cell, never a shaping question, because asking him to rule on an
  // unexamined row is how gh#164 spent two runs on his desk unchanged.
  unshaped,
  pending,
  // Persist under "Verified clean" in report.md and pass straight back as
  // `priorClean` next run. It is the only thing that stops each verify starting
  // from zero on ground an earlier one already proved.
  verifiedClean,
  // `priorClean` entries this wave invalidated, already excluded from the verify
  // it just ran. **The Manager must delete these from `state.verifiedClean`** —
  // the engine cannot, and an entry left there silences a real check on every
  // future run. This is the pruning that used to depend on remembering.
  // X84 · `[{i, entry}]`. **DELETE BY `i`** — the index in the array you passed as
  // `priorClean`. `entry` is the text as the engine received it, for reading only:
  // match on it and a list you trimmed on the way in silently drops nothing.
  // `state.verifiedClean` must end up exactly this many entries shorter.
  priorCleanDropped,
  // NEW problems the verify found that are NOT about this wave's fixes. **These
  // are NEXT RUN'S INTAKE, not rows on his desk** (X30) — carry them into the
  // next invocation's `args.issues`, which they are already shaped for, lane
  // included and severity included. **Do not build them tonight** — that changes
  // the tree the verify just examined, invalidates the pass that found them, and
  // justifies another pass that can discover something else. And do not soften
  // one by calling it a bonus: not blocking and not severe are different claims,
  // so a `high` discovery arrives first in the next queue.
  discoveries,
  // X43 · what this build took out of `state.pendingOverflow` — the discoveries and
  // over-cap items an earlier run parked there. **DELETE these from
  // `state.pendingOverflow` when you persist**: the engine cannot write state, and
  // an entry that stays rides into every future build as a duplicate dispatch.
  carriedIn,
  // X42 · the stale rows this pass re-read, with what it found. `persist.backlog`
  // holds the same result pre-shaped for the ledger and the report — use that; this
  // is the raw list for anything else you need to read.
  backlogReread,
  // Open GitHub issues this wave landed on without being asked to. **Render
  // these** — `satisfied` closes at the wrap with everything else; `partial`
  // is the one that matters, because the owner can send it back for the
  // remainder while the lane still has the area in mind; `contradicted` is a
  // decision he is about to make by accident. Never close one from here.
  ticketCoverage,
  // Dependency asks that were deliberately NOT dispatched, because their parent
  // verdict is waiting on the owner. **The Manager MUST render these in the
  // report** — every one is a lane naming specific work in another lane's files,
  // with a file:line. Dropping them silently is the bug this field exists to
  // close, and an unreported ask is indistinguishable from one that never
  // happened. Route the ones he approves via `args.issues` next run.
  deferredDepAsks: deferredNow,
}
