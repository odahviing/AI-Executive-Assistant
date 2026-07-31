export const meta = {
  name: 'bugger',
  description:
    'Bugger — builds a set of atomic issues across SEVERAL lanes, with dependency hand-off and ONE combined verify. Pass `args.issues` (already lane-assigned, e.g. rows the owner approved from report.md) and it goes straight to work — the scout is SKIPPED. Pass `args.sources` for a run that has to FIND its work — the default is all three: `github` + `logs` find new work, and `backlog` re-reads the open rows whose code has moved and builds nothing. For ONE lane whose items are already known, do NOT use this at all — dispatch that lane directly with the Agent tool; the pipeline buys nothing and costs a full intake. Core loop: rounds of [code lanes in parallel -> context last] until no dependency asks remain, then one adversarial verify over the combined diff. Builds in the working tree; NEVER commits (the owner wraps).',
  phases: [
    { title: 'Scout' },
    { title: 'Build' },
    { title: 'Context' },
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

// N10 · GUARD THE CONTAINER, NOT ONLY THE VALUES. The Workflow tool can deliver
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
    argWarnings.push('`args` arrived as a JSON STRING rather than an object — recovered by parsing it. Pass args as an actual JSON value in the tool call, not an encoded string.')
  } catch (e) {
    throw new Error(`args arrived as a string and is not valid JSON, so nothing it named could be honoured: ${String((e && e.message) || e)}`)
  }
}

// N11 · STOP where a silent default is EXPENSIVE; warn where it is cheap.
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
// may be: a preset skips the scout, so it must never default a source in.
const presetArg = asArray('issues', A.issues, true) // critical: the silent default is a full discovery pass
const sourcesArg = asArray('sources', A.sources)
// A discovery run does ALL THREE. Owner, 2026-07-30: *"put backlog in every run"* —
// new bugs and old bugs all need resolving and the difference between them is
// bookkeeping. What makes it affordable is X38's staleness marking: only the rows
// whose code has MOVED need re-reading, so the set is small by construction, and a
// re-read produces a closure or a confirmation rather than a decision.
// Empty on a preset: `args.issues` skips the scout, so a source named there could
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
// no scout, no counts, no manifest, no `inFlight` and no report persistence.
//
// The scout ALREADY does this class of work — it matches findings against
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
      `Valid: ${[...KNOWN_SOURCES].join(', ')}. An unknown source produces a scout brief with nothing in it, so the run would find nothing and report success. Nothing has been dispatched.`,
  )
const BACKLOG = SOURCES.includes('backlog')
const SINCE = A.sinceIso || 'the last run' // watermark for the log review
// The watermark in UTC, so the manifest can check the scout compared against the
// right instant rather than guessing from a line number. Empty when no ISO
// watermark was passed (the first run, or a manual one).
const WATERMARK_UTC = Number.isFinite(Date.parse(SINCE)) ? new Date(Date.parse(SINCE)).toISOString() : ''
const WATERMARK_DAY = WATERMARK_UTC ? SINCE.slice(0, 10) : '' // local day — log files are named by local date
const CAP = typeof A.capBuilds === 'number' ? A.capBuilds : 100 // severity-first build cap per run
// X42 · `sources` and `issues` are different doors, and `backlog` must never be
// passed through both: a preset SKIPS the scout, so the re-read would never run
// while `manifest.backlog` reported a backlog pass with zero rows — a mechanism
// that did nothing and looked like success. Refused before anything spawns. Only
// an EXPLICIT `sources:['backlog']` can reach this now — the default cannot, since
// a preset defaults to no sources at all.
if (BACKLOG && presetArg.length)
  throw new Error(
    `args.sources names \`backlog\` and args.issues carries ${presetArg.length} row(s). A preset skips the scout, so the backlog re-read could not run. ` +
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
// Items that LEFT the bug track — `converted` into a GitHub issue where the design
// question is being worked. Distinct from ALREADY_BUILT in the way that matters:
// nothing is fixed, so the symptom recurs INDEFINITELY rather than only until the
// next deploy. Without this list a settled decision comes back every night as a
// fresh bug, which is the failure that re-raised 24 of his rulings on 2026-07-26.
//
// X51 · a `deferred` row is NOT one of these and must never be passed here. His
// ruling, 2026-07-30: *"defer for tomorrow or anything like this means defer to
// next run — the only thing we need is don't do it now."* A deferral is a ONE-RUN
// skip, and since the ledger is only appended during and after a run, every
// `deferred` row standing when a run starts was deferred by an earlier one and is
// due by definition. Listing it here tells the scout to drop work he asked for.
// If he never wants it, the verdict is `declined` — that is the parking state.
// Shape: [{ref, symptom, state, note}].
//
// ENFORCED here, not only written in SKILL.md and scout.md. The rule that lived in
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
      .join(', ')}. A deferral is a ONE-RUN skip, so ${openKnownDeferred.length === 1 ? 'it is' : 'they are'} due NOW and the scout must see ${openKnownDeferred.length === 1 ? 'it' : 'them'} as work. \`openKnown\` is \`converted\` rows only — derive it that way next time, or record \`declined\` if he never wants ${openKnownDeferred.length === 1 ? 'it' : 'them'}.`,
  )
// X22 · THE SLUG VOCABULARY, harvested rather than passed. A tag only earns its
// keep if three lanes name one principle the SAME way — otherwise `--by-invariant`
// groups nothing and the writer produces noise, which is the decoration A5 forbids.
// No new arg for it: both lists above are already derived from `ledger.jsonl`, so
// carrying each row's `invariant` through makes them the vocabulary too. Empty on a
// run that passes neither, and then the lanes coin new slugs — correct, that is how
// a first one gets created.
const KNOWN_INVARIANTS = [...new Set([...ALREADY_BUILT, ...OPEN_KNOWN].map((r) => r && r.invariant).filter(Boolean))]
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
// preset, so draining overflow into a discovery run would skip the scout and lose
// the log review (SKILL.md:385). Passed without `issues`, it is ignored and SAYS so.
//
// The drop is `openKnown` — the same list the scout drops against — because the one
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
const carriedDropped = overflowArg.filter((i) => i && parkedRefs.has(refKey(i.id || i.ref)))
const carriedBuilt = overflowArg.filter((i) => i && !carriedDropped.includes(i) && builtRefs.has(refKey(i.id || i.ref)))
const carriedIn = presetArg.length ? overflowArg.filter((i) => i && !carriedDropped.includes(i) && !carriedBuilt.includes(i)) : []
if (overflowArg.length && !presetArg.length)
  argWarnings.push(
    `\`pendingOverflow\` carried ${overflowArg.length} entr${overflowArg.length === 1 ? 'y' : 'ies'} but no \`issues\` were passed, so this is a DISCOVERY run and they were IGNORED — draining them here would make the run a preset and skip the scout, losing the log review. Carry them on the next \`build\`.`,
  )
if (carriedDropped.length)
  argWarnings.push(
    `${carriedDropped.length} \`pendingOverflow\` entr${carriedDropped.length === 1 ? 'y was' : 'ies were'} matched a parked \`openKnown\` ref and DROPPED, not built: ${carriedDropped.map((i) => i.id || i.ref || '(no id)').join(', ')}. He has already ruled on those.`,
  )
if (carriedBuilt.length)
  argWarnings.push(
    `${carriedBuilt.length} \`pendingOverflow\` entr${carriedBuilt.length === 1 ? 'y' : 'ies'} matched an \`alreadyBuilt\` ref and were DROPPED, not re-built: ${carriedBuilt
      .map((i) => i.id || i.ref || '(no id)')
      .join(', ')}. They shipped — most likely through a one-lane hand dispatch — and were never deleted from \`state.pendingOverflow\`. **Delete them now**, or they ride into the next build too.`,
  )
// X25's guard reads the MERGED list below, so a carried row still flagged
// `awaitingOwner` is refused exactly like a pasted one.
const PRESET = presetArg.length ? [...carriedIn, ...presetArg] : null
if (carriedIn.length) log(`Carried in ${carriedIn.length} item(s) from state.pendingOverflow — they head this build's queue: ${carriedIn.map((i) => i.id || i.ref).join(', ')}`)
// X25 · THE READER FOR `awaitingOwner`. The deferred dependency asks below are
// shaped for a copy-paste straight back into `args.issues` — that is the whole
// point of the shape — so the flag that says "he has not ruled on the parent yet"
// has to be enforced at the door it makes easy to walk through. Building one of
// these could implement a dependency of something he is about to decline.
// Refused HERE because nothing has spawned yet: a loud stop costs one
// re-invocation (N11), and once he rules, DELETING the flag from the row is the
// approval. Without this read the field was decoration, which A5 forbids.
const undecidedPreset = (PRESET || []).filter((i) => i && i.awaitingOwner)
if (undecidedPreset.length)
  throw new Error(
    `args.issues carries ${undecidedPreset.length} row(s) still flagged \`awaitingOwner\`: ` +
      `${undecidedPreset.map((i) => `${i.id || '(no id)'} (parent verdict ${i.fromVerdict || '?'})`).join(', ')}. ` +
      `Each is a dependency ask whose PARENT is waiting on the owner, so building it could implement a dependency of something he declines. ` +
      `Nothing has been dispatched. Get his ruling, delete \`awaitingOwner\` from the row, and re-invoke.`,
  )
const describeOpen = (o) =>
  typeof o === 'string'
    ? `  • ${o}`
    : `  • **${o.ref || '(no ref)'}** — ${o.symptom || '(no symptom)'}${o.state ? ` [${o.state}]` : ''}` + `${o.note ? `\n      ${o.note}` : ''}`
const describeBuilt = (b) =>
  typeof b === 'string'
    ? `  • ${b}`
    : `  • ${b.ref ? `**ref ${b.ref}** — ` : ''}${b.symptom || '(no symptom)'}` +
      `${b.rootCause ? `\n      root cause already fixed at: ${b.rootCause}` : ''}` +
      `${b.state === 'awaiting-owner' ? `\n      **state: awaiting-owner — DROP any finding for this ref, even if more work looks available**` : ''}`
// COLLECT mode — find and record, build nothing. **Explicit opt-in only.**
// Building every night the owner is away IS the product: he leaves, the loop
// fixes, and the work is waiting for approval when he opens his laptop. An
// earlier version of this flag switched on automatically after two unreviewed
// nights "to save tokens" — which meant a three-day absence produced one night
// of fixes and two nights of homework, converting finished work back into a
// to-do list. Never select it from a timer or a staleness heuristic. Use it
// only when the owner asks for findings without work.
const MODE = A.mode === 'collect' ? 'collect' : 'full'
const VERIFY = A.verify !== false // one combined verifier pass over the wave, unless explicitly off
const CODE_LANES = ['matchmaker', 'shepherd', 'gatekeeper', 'profiler', 'transporter', 'outrider'] // run in parallel; context runs LAST, separately
// Reasoning effort per lane (owner-set). Keys are agent names, renamed 2026-07-28.
const EFFORT = { matchmaker: 'xhigh', instructor: 'xhigh', transporter: 'xhigh', shepherd: 'xhigh', outrider: 'high', profiler: 'high', gatekeeper: 'high' }

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
const SCOUT = {
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
        'the ref of every finding you dropped because it matched a row on the `openKnown` list the brief handed you. X51 · THAT LIST ONLY — a row you saw in `ledger-stats --open` is corroboration, never grounds to drop. Empty array if none; do NOT omit the field, an omission is indistinguishable from "the check did not run".',
    },
    droppedAsAlreadyBuilt: {
      type: 'array',
      items: { type: 'string' },
      description: 'the ref or symptom of every finding you dropped because it is already fixed. Empty array if none — do NOT omit the field, an omission is indistinguishable from "the check did not run".',
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
        },
        required: ['ref', 'complaintsFound', 'issuesEmitted'],
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
        'the count `ledger-stats --open` printed as `cite no file`. Do NOT re-read those rows and do not go hunting for their code — they need the owner, not a lane. Backlog runs only.',
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
              'REQUIRED on `still-real` and `moved`; write `fixed — no action` on a `fixed` row. One of his five verbs and ONE clause of why: `build — <why now>` · `decline — <why never>` · `defer — <what it waits on>` · `resend — <what the lane got wrong>` · `convert — <the design question>`. He rules on this sentence; without it he has to read the whole finding to rule at all.',
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
          source: { type: 'string', enum: ['github', 'logs', 'both'] },
          lane: { type: 'string', enum: ['matchmaker', 'shepherd', 'gatekeeper', 'instructor', 'profiler', 'transporter', 'outrider'] },
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
              "`atomic` = known root, ONE lane, one edit — dispatch it. `needs-shaping` = it touches TWO OR MORE lanes, or the fix is a product decision rather than a repair, or the issue's premise does not survive contact with the code. A `needs-shaping` item is NOT dispatched: it goes to the owner with a proposed shape so he rules before a lane spends anything. Dispatching one as a bug does not fail loudly — it ping-pongs across lanes, burns the night, and still ends up needing his judgement afterwards, which is the most expensive possible order.",
          },
          shapingQuestion: {
            type: 'string',
            description: 'needs-shaping only: the ONE thing the owner must decide, in a sentence he can answer. Plus what you checked in the code that the issue got wrong, if anything.',
          },
          evidence: { type: 'string' },
          clarity: { type: 'string', enum: ['clear', 'ambiguous'] },
          // Filled ONLY when the issue cites a code location. This was its own
          // Haiku pass; the scout is already holding the issue, so it resolves
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
          // `built` for a change gatekeeper had made (wf_0cebe938-c81, shepherd
          // a2602ac7: 21 turns, 13 tools, ZERO edits, fix text opening "Not built
          // by me"), so the verify was handed 3 rows for 2 changes and spent a
          // result saying so, and the Manager typed the de-duplication into
          // state.json by hand. Use it whenever you did not edit a file: it does
          // not reach the verify, it is not counted as a fix, and it still closes
          // the dependency. Claiming someone else's work as `built` inflates every
          // count downstream.
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
          // cover. Without it the verifier re-derives ground you already walked.
          traced: {
            type: 'string',
            description:
              'the scenarios you paper-traced and the ones you deliberately did NOT, one line each. Be honest about the gaps — an uncovered case named here gets checked by the verifier; one you quietly omit gets checked by nobody.',
          },
          dependencyAgent: { type: 'string', enum: ['matchmaker', 'shepherd', 'gatekeeper', 'instructor', 'profiler', 'transporter', 'outrider', ''] },
          dependencyAsk: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['id', 'verdict'],
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
    // A DISCOVERY is a pre-existing bug the verifier happened to notice while
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
          lane: { type: 'string', enum: ['matchmaker', 'shepherd', 'gatekeeper', 'instructor', 'profiler', 'transporter', 'outrider'] },
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
    // Work lands on open tickets by accident constantly: a bug fix turns out to
    // be most of an Improvement nobody scheduled, the ticket sits open for
    // months, and eventually it is built a second time. The verifier reads the
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
// it, and Shared rule 6 (never build on a claim you have not verified) applies to
// it exactly as it does to a hand-off from another lane. What the Locate pass
// removes is the SEARCH, not the reading.
const WHERE_NOTE =
  `\n\nSome issues carry \`_where\` — the cited location resolved for you, with an excerpt and its immediate neighbours. ` +
  `That is a STARTING POINT, not the truth: it is a snapshot taken before this dispatch, another lane may have moved the code since, ` +
  `and the citation itself came from the scout and can be wrong. **Open the file and read it.** Per Shared rule 6, re-derive the defect from ` +
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

// X73 · A NUMBER THAT BOUNDS A DURATION IS THE ONE FIX THAT CANNOT BE SETTLED
// FROM THE CODE. gh#166's news budget went 20s → 8s → 14s across three runs and
// nobody ever timed the path: the outrider dispatch that changed it made ZERO
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
  `\n\n**IF YOUR FIX IS A NUMBER THAT BOUNDS A DURATION** — a timeout, a budget, a retry window — your verdict must carry an OBSERVED figure for the path being bounded (\`the on-demand gather ran 6.2s at logs/maelle-2026-07-30.log:812\`), or say plainly that the path was never observed. ` +
  `A different number with no measurement behind it is the same fix again: gh#166 has been "fixed" three times that way. If you cannot observe the path, that is \`needs-owner-decision\`, not a fourth guess.`

const dispatch = (lane, issues) =>
  agent(
    `You are dispatched a batch of atomic issues in your lane. For EACH: **name the root cause with a \`file:line\`** — the place the fix must GO, not where the symptom showed. That is a patch-vs-root judgement, not an evidence exercise: settle it from the code, and reach for the logs only when timing or frequency is genuinely in question. Then build the deep fix within your charter, run \`npm run typecheck\` **ONCE at the END** (not after each edit — every run is a whole turn that re-reads your entire accumulated context, which is what a dispatch actually costs; batch the edits, then check), paper-trace to 100%. If unsure, do NOT build — return the right escalation verdict. Return one verdict per issue per your return contract, and **list every file you edited in \`filesTouched\`** — the tree may hold work from other chats, and that list is how the verify tells your change apart from theirs.${issues.some((i) => i._where) ? WHERE_NOTE : ''}${INVARIANT_NOTE}${TIMEOUT_NOTE}\nISSUES:\n${JSON.stringify(issues, null, 2)}`,
    // No `model` here: the tier lives on the lane's charter frontmatter, so a
    // hand-dispatched lane gets it too. Setting it in the engine only made it
    // true on the engine path, which is the shape of failure this framework
    // keeps repeating. Three things to watch, all instrumented here: turns per
    // dispatch (a lighter model may explore more), `overturned` at verify (did
    // fix quality drop), and the pushback ratio in `ledger-stats` — a lane that
    // stops returning `blocked-charter` and `needs-owner-decision` has stopped
    // being governed and is just building, which would NOT announce itself.
    { label: `build:${lane}`, phase: lane === 'instructor' ? 'Context' : 'Build', agentType: lane, effort: EFFORT[lane], schema: VERDICTS },
  )

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
const DELIVERED_DEP = new Set(['built', 'confirmed-other-lane'])
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

// ---- 1. Scout — find the work AND shape it, in one pass -------------------
// This was three agents: a GitHub pull, a log review, and a triage that routed
// from their combined output. The split meant the agent making the run's most
// consequential call — which lane owns this, and is it safe to dispatch at all —
// worked from a one-line symptom and a quoted fragment, while the agent that had
// actually read the transcript was already gone. Merging recovers that context.
//
// The routing and shaping DOCTRINE now lives in `.claude/agents/scout.md`, so
// this prompt carries only the mechanics and the payload — the same split the
// lane dispatches use, and the fix for two engines each holding their own
// drifting copy of the lane map.
//
// SKIPPED entirely for a preset list: the owner has already named and routed it.
let allIssues = []
let triageDropped = []
let openKnownDropped = []
let scoutReport = {}
let findingsSeen = 0
let locationsResolved = 0
let ticketComplaints = []
let backlogSeen = 0
let backlogNoCite = 0
let backlogReread = []
if (PRESET) {
  log(`Preset: ${PRESET.length} pre-triaged issue(s) from the owner's review — skipping the scout.`)
  allIssues = PRESET
} else {
phase('Scout')
const scout = await agent(
  `Find this run's work and shape it for the lanes. Sources: **${SOURCES.join(' + ')}**. Your charter holds the bar for a finding, the routing map, the merge rules and the \`kind\` call — this brief carries only the mechanics and the payload.\n\n` +
    (SOURCES.includes('logs')
      ? `## The log review\n\n` +
        `**0. ESTABLISH THE CUTOFF MECHANICALLY, BEFORE READING ANYTHING.** The watermark is \`${SINCE}\`.\n` +
        `  a. **Convert it to UTC first.** The watermark carries a local offset (e.g. \`+0300\`); every log line is UTC with a \`Z\`. \`2026-07-26T18:22:00+0300\` is \`2026-07-26T15:22:00Z\`. Comparing the two as text without converting silently reviews the whole day — measured at ~430k wasted on 2026-07-26, when an 18:22 watermark let 04:32Z lines through.\n` +
        `  b. **READ EVERY DATED FILE FROM THE WATERMARK'S DATE THROUGH TODAY — not just today's.** Logs are one file per day (\`logs/maelle-YYYY-MM-DD.log\`) and the watermark is normally ~24h back, so it lands in YESTERDAY's file. Reviewing only today's leaves the previous evening unreviewed on every single run, which is exactly when she is used. \`ls logs/\` first, then take every dated file at or after the watermark's date. (\`logs/maelle.log\` is a stale legacy file — ignore it.)\n` +
        `  c. In the EARLIEST of those files, start at the first entry whose \`"timestamp"\` is >= that UTC instant; everything above it is already reviewed and re-finding it produces a duplicate the owner has seen. Every later file is read from the top.\n` +
        `  d. **ACTIVITY CHECK:** count \`Orchestrator invoked\` events after the cutoff, across all those files. If ZERO, she handled no turns since the last review — return \`{issues: []}\` immediately and stop. Do not scan, do not reason further. Count that event specifically: \`Catch-up: scanning DMs\` is an idle heartbeat that fires whether or not anyone spoke, and reading it as activity is what made a zero-finding run cost 124k.\n` +
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
        `  • **Report \`ticketComplaints\`: one \`{ref, complaintsFound, issuesEmitted}\` per ticket you read.** The manifest checks it, so 3-in-1-out is a number rather than something nobody notices for a week.\n\n`
      : '') +
    (BACKLOG
      ? `## The backlog re-read\n\n` +
        `Run \`node scripts/ledger-stats.cjs --open\` (read-only) and take **ONLY the rows printed with the \`RE-READ\` prefix** — nobody has stood behind those rows: either the code they cite **moved** after they were written, or **nobody has ever re-read them** (X59, and that second reason is the large half — 28 of 52 on 2026-07-30 against 0 that had moved). **Report \`backlogSeen\`**: how many the command printed. This pass exists to make the list SHORTER, honestly.\n` +
        `  • **The rows it lists under \`cite no file\` are NOT yours.** They cite nothing, so there is nothing to re-read; hunting for their code is unbounded work with no answer at the end. **Report the count as \`backlogNoCite\` and move on** — they go to the owner as a named hand-read list.\n` +
        `  • Open the file each row cites and rule: **\`fixed\`** (the defect is gone), **\`moved\`** (still real, elsewhere — give the current \`file:line\` in \`whereNow\`), **\`still-real\`** (still there, as described).\n` +
        `  • **A bare \`fixed\` is REFUSED. Name the commit or the code that proves it** — \`git log -1 --format=%h -- <file>\`, or the branch that now handles the case. A restructured file looks fixed when the defect has only MOVED, and a false close is worse than a stale row because nothing ever looks again.\n` +
        `  • **Emit NO issue for a row you RE-READ here, not even a \`still-real\` one.** You triage; the owner rules and dispatches what he wants through \`build <ids>\`. A re-read that quietly re-dispatches 28 old rows is a wave nobody approved.\n` +
        `  • **This list is NOT a drop list.** When a GitHub complaint or a log moment you found matches an open row on it, that match CONFIRMS the row is still real — **emit the issue** and name the row in \`whyHypothesis\`. Never drop an intake because the backlog already tracks it, and never report such a match in \`droppedAsOpenKnown\`: on wf_6852af85-afc that is how four complaints the owner had ruled DUE were lost, absent from every count in the funnel. The only drop lists are the two the brief hands you below.\n` +
        `  • Work them in the order printed, and if you run out of room say how many you did NOT reach. \`backlogSeen\` against the length of \`backlogReread\` is how a half-finished pass shows up as a number instead of reading as a clean sweep.\n\n`
      : '') +
    `## Then shape it\n\n` +
    `Merge the two sources, split into ATOMIC issues, route each to the lane that owns the FIX, and classify \`kind\` — all four per your charter. Carry \`clarity\` forward. Give a one-line \`whyHypothesis\`; do NOT prove root causes or design fixes, because the lane does that properly and will re-derive anything you assert anyway.\n\n` +
    `**Where an issue cites a code location, resolve it once and fill \`where\`.** Open the file, take the cited line with ~30 lines either side verbatim, and name who calls it and what it calls. Six lanes otherwise each pay the same hunt for a location you are already looking at. **Never guess** — omit \`where\` rather than send a builder somewhere plausible with false confidence, which is worse than sending it nowhere. Most log findings cite no file; skip those, and do not go exploring for a citation an issue does not make.\n\n` +
    `Report \`findingsSeen\` — the raw count before merging — so the manifest can show how much collapsed.\n` +
    (ALREADY_BUILT.length
      ? `\n## Already fixed, not yet deployed — DROP these\n\n` +
        `Production keeps emitting these symptoms until the owner deploys, so an honest review re-finds them every night. Match them per your charter — **the \`ref\` exactly first** (\`#147\` = \`gh#147\` = \`147\`), then the root cause, then the same user-visible failure described differently. Dispatching one costs a full lane turn to be told "already-fixed": the entire price of the bug, paid again, for nothing.\n\n` +
        `**Report every ref you drop in \`droppedAsAlreadyBuilt\`, and return an empty array if you drop none.** Omitting the field is indistinguishable from never running the check, which is how this check silently failed before.\n\n${ALREADY_BUILT.map(describeBuilt).join('\n')}\n`
      : '') +
    (OPEN_KNOWN.length
      ? `\n## Left the bug track — DROP these too\n\n` +
        `Each of these was CONVERTED into a GitHub issue where the design question is being worked. **Nothing is fixed**, so unlike the list above these do not stop recurring after a deploy — the symptom can reappear indefinitely and you WILL find it again. That is expected. It is not news.\n\n` +
        `**Drop any finding that matches one, and list the refs in \`droppedAsOpenKnown\` (empty array if none).** Filing one as new puts a decision he has already made back on his desk as a fresh bug.\n\n` +
        `**One exception — and report it under the SAME ref, never as a new issue:** if the recurrence carries materially new information (it now hits colleagues rather than only him, the frequency has jumped, or it fails in a way the parked description does not cover), say so in \`whyHypothesis\` against that ref. A change in severity is worth knowing; a duplicate row is not.\n\n${OPEN_KNOWN.map(describeOpen).join('\n')}\n`
      : ''),
  { label: 'scout', phase: 'Scout', effort: 'medium', agentType: 'scout', schema: SCOUT },
)
allIssues = (scout && scout.issues) || []
triageDropped = (scout && scout.droppedAsAlreadyBuilt) || []
openKnownDropped = (scout && scout.droppedAsOpenKnown) || []
findingsSeen = (scout && scout.findingsSeen) || allIssues.length
ticketComplaints = (scout && scout.ticketComplaints) || []
backlogSeen = (scout && typeof scout.backlogSeen === 'number' ? scout.backlogSeen : 0)
backlogNoCite = (scout && typeof scout.backlogNoCite === 'number' ? scout.backlogNoCite : 0)
backlogReread = (scout && scout.backlogReread) || []
scoutReport = scout || {}
log(`Scout: ${findingsSeen} raw finding(s) from ${SOURCES.join(' + ')} → ${allIssues.length} atomic issue(s)`)
if (BACKLOG) log(`Backlog: ${backlogReread.length} of ${backlogSeen} stale row(s) re-read — ${backlogReread.filter((b) => b.state === 'fixed').length} fixed, ${backlogReread.filter((b) => b.state === 'moved').length} moved, ${backlogReread.filter((b) => b.state === 'still-real').length} still real`)
}

// A lane name outside the known set means the issue matches no lane in the Build
// phase and no `context` pass either — it is silently dropped. That happened on
// 2026-07-25: the router emitted lane `general`, which does not exist. It was
// harmless only because that issue was flagged for the owner and never
// dispatched. Route the unknown to `outer` (the catch-all, by definition) and
// SAY SO, rather than losing the issue to a typo.
const KNOWN_LANES = new Set([...CODE_LANES, 'instructor'])
const misrouted = allIssues.filter((i) => !KNOWN_LANES.has(i.lane))
if (misrouted.length) {
  log(`! Scout emitted ${misrouted.length} unknown lane(s): ${misrouted.map((i) => `${i.id}→"${i.lane}"`).join(', ')} — re-routed to outer so they are not silently dropped.`)
  misrouted.forEach((i) => {
    i.notes = `[re-routed from unknown lane "${i.lane}"] ${i.notes || ''}`.trim()
    i.lane = 'outrider'
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
// gate on it. The two are not orthogonal in practice — a scout that judges an
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
const flagged = allIssues.filter((i) => i.clarity === 'ambiguous' && !shapingAll.includes(i))
let buildable = allIssues.filter((i) => i.clarity === 'clear' && !shapingAll.includes(i))
if (needsShaping.length) {
  log(`${needsShaping.length} item(s) need SHAPING before anyone builds — not dispatched:`)
  needsShaping.forEach((i) => log(`  ? ${i.id} [${i.lane}] ${i.shapingQuestion}`))
}
if (unshaped.length) {
  log(`! ${unshaped.length} needs-shaping item(s) carry NO shapingQuestion — nobody has read the code yet, so these are homework, not decisions:`)
  unshaped.forEach((i) => log(`  ? ${i.id} [${i.lane}] ${(i.symptom || '').slice(0, 90)}`))
}

// Severity-first cap so a heavy day cannot overrun the window; the rest is reported as pending.
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

// ---- 2b. Locations — resolved by the scout, in the same turn ---------------
// Every builder used to open with the same hunt: grep, read a 1,400-line file,
// read the wrong one, find the thing, then read it properly. Six lanes each
// paying that discovery tax — ~5,300 lines across the five files the scheduling
// lanes keep re-reading, most of it read several times in one run.
//
// That used to be a separate Haiku pass. It could only fire when `evidence`
// happened to carry a file path, and when it did it re-opened from scratch the
// very issue the router had just been holding. The scout is already there with
// the issue body and the transcript in hand, so it fills `where` as it goes and
// the pass is gone.
//
// This removes the SEARCH, never the reading: the builder still opens the file
// and re-derives (see WHERE_NOTE), because an excerpt trusted blind is the relay
// bug at framework scale.
buildable = buildable.map((i) => (i.where && i.where.excerpt ? { ...i, _where: i.where } : i))
locationsResolved = buildable.filter((i) => i._where).length
if (locationsResolved) log(`Locations: ${locationsResolved} citation(s) resolved by the scout — the lanes skip the hunt.`)

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
const MAX_ROUNDS = 6
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
// reason, so both now read from here. MAX_ROUNDS=6 exists precisely to allow
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
// needs a verifier — two lanes whose fixes are each correct alone and wrong
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
let waveFiles = []
let priorCleanDropped = []
let discoveries = []
let ticketCoverage = []
let spotCheckUnanswered = [] // X68 · already-fixed rows the verify never answered on
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
  verifyAttempted = built.length
  if (built.length || claimedFixed.length) {
    // Two things are forwarded so nothing is derived twice:
    //   • each fix's own `traced` — what the builder already walked, so the
    //     verifier attacks the GAPS instead of re-covering covered ground.
    //   • `priorClean` — what earlier verifies proved, carried in by the Manager
    //     from the report. Without it every pass re-audits settled ground.
    // Both are leads, not truth: a builder's coverage claim and a past pass's
    // conclusion are exactly the kind of relay Shared rule 6 exists for, and the
    // prompt says so. Spot-check cheaply; spend the budget on what is NOT there.
    const priorClean = asArray('priorClean', A.priorClean)

    // ── N2: which files are THIS wave's ────────────────────────────────────
    // `git diff` shows every uncommitted change in the tree, and on a normal
    // night that includes another chat's work — seven `src/` files and five
    // `.claude/` files were already modified before the 2026-07-27 run wrote a
    // line. Naming the wave's own files lets the verify attribute correctly
    // instead of overturning a row for a change this run never made. A lane that
    // reports nothing costs waste, not correctness: the fallback is "treat the
    // whole tree as ours", which over-checks rather than under-checks.
    waveFiles = [...new Set(built.flatMap((r) => (Array.isArray(r.filesTouched) ? r.filesTouched : [])).filter(Boolean))]

    // ── N3: drop the `priorClean` entries this wave invalidated ────────────
    // A stale "proven clean" silences a real check, which is strictly worse than
    // having no list — hence the charter's rule to drop when in doubt: re-proving
    // costs one pass, missing a regression costs a person. Until now this was the
    // Manager remembering by hand. Matching is on basename, deliberately loose in
    // the DROP direction for exactly that reason.
    const touchedBases = new Set(waveFiles.map((f) => String(f).split('/').pop()).filter(Boolean))
    priorCleanDropped = priorClean.filter((c) => [...touchedBases].some((b) => String(c).includes(b)))
    const priorCleanKept = priorClean.filter((c) => !priorCleanDropped.includes(c))
    if (priorCleanDropped.length)
      log(`priorClean: dropped ${priorCleanDropped.length} of ${priorClean.length} — this wave changed the code they described.`)

    const check = await agent(
      // The bar, the standard, the seams-first scope, the trace sampling, the
      // budget, overturn-vs-discovery and the return contract all live in
      // `.claude/agents/verifier.md` now. Restating them here would be a second
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
        (claimedFixed.length
          ? `**SPOT-CHECK — ${claimedFixed.length} row(s) a lane CLOSED as \`already-fixed\` without building anything.** Nobody has checked these. For each, open the code it names and answer one question: is it actually fixed at HEAD? **One read each — no trace, no budget.** Return a result per row: \`already-fixed\` if the lane was right, any other verdict if it was not. A row you do not return is reported as still unchecked.\n${JSON.stringify(
              claimedFixed,
              null,
              2,
            )}\n\n`
          : '') +
        (built.length ? `FIXES IN THIS WAVE:\n${JSON.stringify(built, null, 2)}` : `**NO FIX WAS BUILT IN THIS WAVE** — the spot-check above is the whole job.`),
      // No `model` here either — `verifier.md` pins Opus. Same reasoning as the
      // lanes, one rung stronger: this is the single highest-judgment step, the
      // only pass that sees the whole diff, and the backstop for Sonnet lanes'
      // traces. Pinning it on the charter means neither the session model nor a
      // hand dispatch can downgrade the one agent that must not be downgraded.
      { label: `verify:wave(${built.length})`, phase: 'Verify', agentType: 'verifier', effort: 'xhigh', schema: VERIFY_OUT },
    )
    verifyRan = !!check
    verifiedClean = (check && check.verifiedClean) || []
    discoveries = (check && check.discoveries) || []
    ticketCoverage = (check && check.ticketCoverage) || []
    if (discoveries.length) log(`Verify found ${discoveries.length} NEW problem(s) unrelated to this wave — reported, NOT built (building them would invalidate the pass that found them).`)
    ticketCoverage.forEach((t) => log(`  ticket ${t.ref}: ${t.state}${t.state === 'partial' && t.whatIsMissing ? ` — still missing: ${String(t.whatIsMissing).slice(0, 90)}` : ''}`))
    // The verify's OWN dependency asks were being discarded here — the overturn
    // read only `verdict` and `notes`, so when the verifier said "this needs the
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
    spotCheckUnanswered = claimedFixed.filter((r) => !answered.has(r.id)).map((r) => r.id)
    verified = results.map((r) =>
      overturned.has(r.id)
        ? {
            ...r,
            verdict: 'needs-owner-decision',
            notes: `${r.notes || ''} [wave-verify overturned: ${overturned.get(r.id)}]`.trim(),
          }
        : r,
    )
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
const deferredNow = [...deferredDepAsks(verified), ...verifyDepAsks]
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
        cutoffUtcUsed: scoutReport.cutoffUtc ?? '(not reported)',
        filesRead: scoutReport.filesRead ?? '(not reported)',
        turnsAfterCutoff: scoutReport.turnsAfterCutoff ?? '(not reported)',
      },
  alreadyBuilt: { passedIn: ALREADY_BUILT.length, droppedByTriage: triageDropped.length, dropped: triageDropped },
  // No warning on a zero here, deliberately. Unlike `alreadyBuilt` — where
  // production keeps emitting until deploy, so a recurrence is near-certain — a
  // parked item may simply not have come up tonight. Zero is a normal answer,
  // and a warning that fires on the healthy path is the thing being fixed
  // everywhere else in this file.
  // X51 · `deferredRejected` is the derivation error made visible. Non-zero means the
  // Manager put a due row on the drop list and the engine took it back off.
  openKnown: { passedIn: OPEN_KNOWN.length, deferredRejected: openKnownDeferred.length, dropped: openKnownDropped.length, refs: openKnownDropped },
  // X43 · what the build picked up out of `state.pendingOverflow`. Zero on a
  // discovery run is correct — the carry is build-only. Zero on a build while the
  // field holds entries is the failure this reader exists to end, and the arg
  // warning above says so in words. **The Manager must DELETE `carry.refs` AND
  // `carry.droppedAsBuiltRefs` from `state.pendingOverflow`** — the engine cannot
  // write state, and an entry left there rides into every future build.
  carry: {
    carriedIn: carriedIn.length,
    refs: carriedIn.map((i) => i.id || i.ref || '(no id)'),
    droppedAsParked: carriedDropped.length,
    // X46 · non-zero means the field did not drain on a hand dispatch. The refs are
    // named so he can see WHICH stale entry rode in, and delete them from state.
    droppedAsBuilt: carriedBuilt.length,
    droppedAsBuiltRefs: carriedBuilt.map((i) => i.id || i.ref || '(no id)'),
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
      }
    : 'n/a (not a backlog run)',
  // X32 + X33 · the ticket funnel. `complaintsFound` against `issuesEmitted` per
  // ticket, so three-in-one-out is a number here instead of something the owner
  // discovers by re-reading his own ticket at midnight.
  tickets: PRESET ? 'n/a (preset)' : { read: ticketComplaints.length, complaints: ticketComplaints.reduce((n, t) => n + (t.complaintsFound || 0), 0), emitted: ticketComplaints.reduce((n, t) => n + (t.issuesEmitted || 0), 0), perTicket: ticketComplaints },
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
}
// Known-shape sanity checks. These are the exact failures already paid for.
// Arg problems go FIRST: an input that never arrived invalidates everything
// reported below it, so it cannot be buried under the log-review tells.
const warnings = [...argWarnings]
const REVIEWED_LOGS = !PRESET && SOURCES.includes('logs')
// This used to ask "did the review start at line 1?" — which is the CORRECT
// answer whenever the watermark predates today's file, i.e. every normal night.
// So it fired on the healthy path and stayed silent on the real failure. Ask the
// question that actually matters: did the scout compare against the right instant?
if (REVIEWED_LOGS && WATERMARK_UTC && typeof scoutReport.cutoffUtc === 'string') {
  const got = Date.parse(scoutReport.cutoffUtc)
  if (!Number.isFinite(got)) warnings.push(`Log review reported an unparseable cutoff (\`${scoutReport.cutoffUtc}\`) — its watermark cannot be verified.`)
  else if (Math.abs(got - Date.parse(WATERMARK_UTC)) > 60000)
    warnings.push(`LOG WATERMARK SLIPPED — the scout compared against ${scoutReport.cutoffUtc}, but the watermark ${SINCE} is ${WATERMARK_UTC}. A timezone slip here re-reviews the whole day; it cost ~430k on 2026-07-26.`)
}
if (REVIEWED_LOGS && scoutReport.cutoffUtc === undefined)
  warnings.push('Log review did not report the instant it compared against, so its watermark cannot be verified. Treat any log finding as possibly already-reviewed.')
// The watermark is normally ~24h back, so it lands in YESTERDAY's file. A review
// that never opened that file skipped the previous evening — every night, in the
// window she is actually used.
if (REVIEWED_LOGS && WATERMARK_DAY && Array.isArray(scoutReport.filesRead) && scoutReport.filesRead.length && !scoutReport.filesRead.some((f) => String(f).includes(WATERMARK_DAY)))
  warnings.push(`Log review never opened the watermark's own day (${WATERMARK_DAY}); it read ${scoutReport.filesRead.join(', ')}. Everything between ${SINCE} and midnight went unreviewed.`)
if (REVIEWED_LOGS && !Array.isArray(scoutReport.filesRead))
  warnings.push('Log review did not report which files it opened, so a single-file review — which skips the previous evening — cannot be ruled out.')
if (VERIFY && verifyAttempted > 0 && verifyRan && waveFiles.length === 0)
  warnings.push(
    `No lane reported \`filesTouched\`, so the verify could not tell this wave from anything else uncommitted in the tree. It checked everything, which is safe but wasteful — and any overturned row may belong to work this run did not do.`,
  )
if (VERIFY && verifyAttempted > 0 && !verifyRan)
  warnings.push(`THE VERIFY DID NOT RUN — ${verifyAttempted} built fix(es) are unchecked. \`agent()\` returns null when a subagent dies after its retries, and every read downstream is null-guarded, so this was previously indistinguishable from a clean pass. Do NOT wrap this run without \`/manager verify\`.`)
if (ALREADY_BUILT.length > 0 && triageDropped.length === 0)
  warnings.push(`alreadyBuilt passed ${ALREADY_BUILT.length} entries and triage dropped NONE — either genuinely all-new, or ref matching failed again (gh#147 vs #147).`)
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
if (misrouted.length) warnings.push(`${misrouted.length} issue(s) carried an unknown lane and were re-routed to outer.`)
// X31 · say it out loud at 17:20 instead of leaving him to discover it at 23:50.
if (onHisDesk > DECISION_BUDGET)
  warnings.push(
    `DECISION BUDGET EXCEEDED — ${onHisDesk} refs need the owner against a budget of ${DECISION_BUDGET}. Prior runs put 1 to 12 on his desk; 25 is the night he could not follow. ` +
      `Nothing has been truncated. Propose DEFERRING the lowest-severity rows to the next run and say which — never merge two rows to get under the number, which buys a smaller list and a worse one.`,
  )
// X32 · three complaints in, one issue out, and no drop to explain it.
if (!PRESET && SOURCES.includes('github')) {
  if (!ticketComplaints.length) warnings.push('The scout reported no `ticketComplaints`, so a ticket whose complaints were collapsed into one issue cannot be seen. Treat every ticket in this run as coverage-unknown.')
  // X64 · SUBTRACT THE SCOUT'S OWN DROP LISTS. `complaintsFound > issuesEmitted`
  // alone treats a complaint the scout deliberately dropped — already built, or
  // parked as a converted GitHub issue — as an unexplained gap, so the warning
  // named 7, 8 and 8 tickets across three consecutive runs when only 5, 3 and 4
  // had actually lost a complaint with no reason. A warning that fires on the
  // healthy path is the `startedAtLine: 1` mistake this file names at :1145, and
  // it fired on more tickets than it skipped. The inputs were already read at
  // :739-740 and used nowhere.
  const ticketNum = (s) => (String(s || '').match(/\d+/) || [''])[0]
  const dropRefs = [...triageDropped, ...openKnownDropped].map(ticketNum)
  const droppedFor = (ref) => { const n = ticketNum(ref); return n ? dropRefs.filter((d) => d === n).length : 0 }
  const under = ticketComplaints
    .map((t) => ({ t, unexplained: (t.complaintsFound || 0) - (t.issuesEmitted || 0) - droppedFor(t.ref) }))
    .filter((x) => x.unexplained > 0)
  if (under.length)
    warnings.push(
      `${under.length} ticket(s) lost complaints with NO reason given: ${under
        .map(({ t, unexplained }) => `${t.ref} ${t.complaintsFound}→${t.issuesEmitted}, ${droppedFor(t.ref)} dropped, ${unexplained} unexplained`)
        .join('; ')}. ` +
        `Those tickets are PARTIAL by arithmetic — do not close them, and the unexplained complaints are not on any list unless you put them there.`,
    )
  // X33 · the silent half. A merged row that drops the ticket ref leaves the
  // coverage check with nothing to fire on, and a ticket with no coverage row
  // looks exactly like a ticket with nothing wrong.
  const orphanTickets = ticketComplaints
    .map((t) => String(t.ref || '').replace(/\D/g, ''))
    .filter((n) => n && !allIssues.some((i) => String(i.id || '').includes(n)))
  if (orphanTickets.length)
    warnings.push(
      `${orphanTickets.length} ticket(s) named in the scout's input appear in NO issue id: ${orphanTickets.map((n) => `#${n}`).join(', ')}. ` +
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
// X42 · a cleanup pass that closes a row on an unevidenced "fixed" is worse than
// the stale row it replaced: the row disappears and nothing ever looks again. The
// brief refuses it; this counts the ones that got through, because a brief is a
// request and a count is an observable.
if (BACKLOG) {
  const unevidenced = backlogReread.filter((b) => b.state === 'fixed' && !/(:\d+)|(\b[0-9a-f]{7,40}\b)/i.test(String(b.evidence || '')))
  if (unevidenced.length)
    warnings.push(
      `${unevidenced.length} backlog row(s) were called \`fixed\` WITHOUT naming a commit or a line: ${unevidenced.map((b) => b.ref).join(', ')}. ` +
        `A restructured file looks fixed when the defect has only moved. Treat these as unconfirmed — do NOT remove them from the report or close them in the ledger.`,
    )
  // X71 · the count of rows the pass called still-real WITHOUT opening anything.
  // They stay flagged; this says how many, so a pass that re-read nothing cannot
  // look like a pass that re-read everything.
  const unopened = backlogReread.filter(
    (b) => b.state !== 'fixed' && !/(:\d+)|(\b[0-9a-f]{7,40}\b)|(\b[\w./-]+\.(?:ts|tsx|js|cjs|mjs|md|jsonl|json|yaml|log)\b)/i.test(String(b.evidence || '')),
  )
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
  `Manifest — cutoff:${(!PRESET && scoutReport.cutoffUtc) || 'n/a'} files:${(Array.isArray(scoutReport.filesRead) && scoutReport.filesRead.length) || 0}` +
    ` alreadyBuilt:${triageDropped.length}/${ALREADY_BUILT.length} parked:${openKnownDropped.length}/${OPEN_KNOWN.length}` +
    ` depAsks:${allDepAsks} deferred:${deferredNow.length} misrouted:${misrouted.length} verify:${verifyRan ? 'ran' : 'no'}` +
    ` carried:${carriedIn.length}${BACKLOG ? ` backlog:${backlogReread.length}/${backlogSeen}+${backlogNoCite}nocite` : ''}` +
    ` decisions:${onHisDesk}/${DECISION_BUDGET} tickets:${ticketComplaints.reduce((n, t) => n + (t.complaintsFound || 0), 0)}→${ticketComplaints.reduce((n, t) => n + (t.issuesEmitted || 0), 0)}`,
)
warnings.forEach((w) => log(`! ${w}`))

// ---- N16 · WHAT MUST BE WRITTEN DOWN, pre-shaped -------------------------
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
    closeInLedger: backlogReread
      .filter((b) => b.state === 'fixed' && /(:\d+)|(\b[0-9a-f]{7,40}\b)/i.test(String(b.evidence || '')))
      .map((b) => ({ ref: b.ref, source: 'audit', verdict: 'already-fixed', note: `backlog re-read: ${b.evidence}` })),
    // Still real. KEEP them as report rows.
    keepInReport: backlogReread
      .filter((b) => b.state !== 'fixed')
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
    // X77 · AND THE SAME GATE ON `recommend`, for the reason X71 gave about
    // evidence: a row that is confirmed but unrulable reads as HANDLED, and it will
    // never be flagged RE-READ again, so the one pass that could have written the
    // sentence never looks at it twice. Empty recommendation → it stays in
    // `keepInReport`, still flagged, which is the honest state. A false block costs
    // one re-read; a false confirm costs the row.
    confirmInLedger: backlogReread
      .filter(
        (b) =>
          b.state !== 'fixed' &&
          String(b.recommend || '').trim().length >= 10 &&
          /(:\d+)|(\b[0-9a-f]{7,40}\b)|(\b[\w./-]+\.(?:ts|tsx|js|cjs|mjs|md|jsonl|json|yaml|log)\b)/i.test(String(b.evidence || '')),
      )
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
  // are STILL his rows and still rendered — but as `pending owner — nobody has
  // read the code yet`, never as a shaping question, because asking him to rule
  // on an unexamined row is how gh#164 spent two runs on his desk unchanged.
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
