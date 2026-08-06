export const meta = {
  name: 'feature',
  description:
    'Feature/improvement wave — the door bugger.js does not have. TWO invocations, deliberately: `mode:"plan"` reads open Improvement issues, works out what each actually means, and returns a DECOMPOSITION for the owner to approve — it builds nothing. `mode:"build"` takes the approved pieces, dispatches the lanes in dependency order, runs ONE combined-diff verify, and returns a report. Builds in the working tree; NEVER commits (the owner wraps).',
  phases: [
    { title: 'Intake' },
    { title: 'Recon' },
    { title: 'Decompose' },
    { title: 'Build' },
    { title: 'Context' },
    { title: 'Verify' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT bugger.js
//
// A bug has a right answer: the code should do X and does Y. The orchestrator can
// decompose it alone and show the owner the result, because "correct" is not a
// matter of taste. An improvement IS a product decision, so the decomposition
// itself needs the owner BEFORE anything is dispatched — approving builds after
// the fact means approving work already done.
//
// A workflow cannot pause to ask. So this is two invocations with the owner's
// judgment in between, rather than one run with a fake approval step inside it.
//
// Three more things bugger.js gets wrong for this shape, all load-bearing:
//   • Its intake is `--label Bug`. An improvement is not there.
//   • Its triage schema demands a root cause. An improvement has none.
//   • Manager rule M2 ("one root = one issue") is bug logic. Improvements split
//     by CAPABILITY and SURFACE — the same idea can legitimately land in three
//     lanes at once, and that is not a merge candidate.
//
// And one thing only this flow can produce: a bug never earns a charter rule, but
// an improvement often should. Every piece names the product decision it embeds
// so those rules get written down instead of being absorbed silently into code.
// ─────────────────────────────────────────────────────────────────────────────

// X6 · A MALFORMED ARG MUST NEVER BE INDISTINGUISHABLE FROM AN ABSENT ONE.
// The Workflow tool delivers a stringified object as ONE STRING, so every
// `A.<key>` below reads undefined and the `Array.isArray(...) ? ... : null`
// defaults swallow it in silence: a described item becomes null and the engine
// runs the FULL GitHub sweep instead of the one thing it was handed. Not a
// wrong answer — an expensive one. It cost 32 understand agents and 2.1M
// tokens on 2026-07-28, and the same line in bugger.js cost a full dispatch on
// 2026-07-27. This is the sixth instance of the class every silent failure in
// this engine belongs to: A STEP THAT DID NOTHING WHILE THE RUN REPORTED
// SUCCESS. So recover a string, and REFUSE a wrong shape rather than defaulting
// past it — a loud stop costs one re-invocation, a silent default costs a wave.
let A = args || {}
if (typeof A === 'string') {
  try {
    A = JSON.parse(A)
    log('! args arrived as a JSON string, not an object — recovered by parsing. Pass args as an actual JSON value, not an encoded string.')
  } catch (e) {
    throw new Error(`args arrived as a string and is not valid JSON, so nothing it named could be honoured: ${String((e && e.message) || e)}`)
  }
}
for (const [key, want] of [
  ['items', 'array'], ['refs', 'array'], ['pieces', 'array'],
  ['priorClean', 'array'], ['recon', 'array'], ['answers', 'object'], ['constraints', 'array'],
  // `cluster` is the design door's evidence payload, minted by
  // `scripts/design-cluster.cjs`. Same guard as every other arg for the same
  // reason: nine refs arriving as a stringified object would read as absent and
  // the design pass would plan the ticket with none of its history.
  ['cluster', 'object'],
]) {
  const v = A[key]
  if (v === undefined || v === null) continue
  const ok = want === 'array' ? Array.isArray(v) : typeof v === 'object' && !Array.isArray(v)
  if (!ok)
    throw new Error(
      `args.${key} is present but is a ${Array.isArray(v) ? 'array' : typeof v}, not ${want}. Refusing to fall back to a default that ignores what you passed.`,
    )
}
const MODE = A.mode === 'build' ? 'build' : 'plan'
const PRIORITY = A.priority || null // 'High' | 'Medium' | 'Low' — the Improvement axis
const REFS_ARG = Array.isArray(A.refs) ? A.refs : null // explicit issue numbers, skips the label query

// ─────────────────────────────────────────────────────────────────────────────
// THE DESIGN DOOR — `feature design gh#154`
//
// This engine was the FEATURE door: it handled whatever arrived through the
// Improvement/Feature label. It is the DESIGN door — ANY item whose answer is a
// product decision, whatever door it arrived through.
//
// The evidence: of the 13 rows ever `converted` in `ledger.jsonl`, NINE are the
// same design question. `gh#154` absorbed nine refs from five lanes over eight
// days and has never been designed. **`convert` is not an escape hatch, it is a
// waiting room** — and nothing surfaced the waiting room as one item.
//
// A MODE ON THIS COMMAND, not a verb of its own and not an Editor route. The
// plan → he rules → build path underneath is UNTOUCHED, with `A.constraints` as
// the feedback channel. The Editor is read-only, runs mid-wave, and routing a
// design question into a live bug wave is exactly what `needs-shaping` refuses.
//
// ONE DESIGN ITEM = ONE DESTINATION = ONE RECON + ONE PLAN, NEVER NINE. The
// clustering is `scripts/design-cluster.cjs`'s job (an engine has no `require`,
// so it cannot read the ledger); this side only refuses a shape that would fan
// one design question back out into the nine symptoms it was raised to replace.
const normRef = (v) => String(v || '').trim().toLowerCase().replace(/^(?:gh)?#/, '')
const DESIGN = A.design ? normRef(A.design) : null
if (DESIGN && !/^\d+$/.test(DESIGN))
  throw new Error(
    `args.design is "${A.design}", which is not a GitHub issue number. A design cluster is keyed on the ref the \`converted\` rows were routed TO — pass \`gh#154\`, \`#154\` or \`154\`.`,
  )
const DESIGN_REF = DESIGN ? `gh#${DESIGN}` : null
const CLUSTER = A.cluster && typeof A.cluster === 'object' && !Array.isArray(A.cluster) ? A.cluster : null
const CLUSTER_REFS = CLUSTER && Array.isArray(CLUSTER.refs) ? CLUSTER.refs.filter((r) => r && typeof r === 'object') : []
// A cluster keyed on a DIFFERENT issue than the one being designed would put nine
// other rows' history into this item's recon and read as a rich payload. Refuse.
if (DESIGN && CLUSTER && CLUSTER.ref && normRef(CLUSTER.ref) !== DESIGN)
  throw new Error(
    `args.cluster is keyed on ${CLUSTER.ref} but args.design is ${DESIGN_REF} — that payload is another item's history. Re-run \`node scripts/design-cluster.cjs ${DESIGN_REF}\` and paste its ARGS block.`,
  )
if (DESIGN && Array.isArray(A.items) && A.items.length)
  throw new Error(`args.design (${DESIGN_REF}) names a filed issue and args.items describes an unfiled one. Pass one or the other, never both.`)
if (DESIGN && A.sweep === true) throw new Error(`args.design (${DESIGN_REF}) is ONE design item by definition; args.sweep surveys the whole board. Pass one or the other.`)
if (DESIGN && REFS_ARG && !REFS_ARG.some((r) => normRef(r) === DESIGN))
  throw new Error(`args.refs (${REFS_ARG.join(', ')}) does not include args.design (${DESIGN_REF}). Drop \`refs\` — the design door sets it.`)
// Reuses the refs path BYTE FOR BYTE, in the spelling SKILL.md documents (`#154`),
// so the intake command, its agent, its model and its cost are unchanged.
const REFS = DESIGN ? [`#${DESIGN}`] : REFS_ARG
// An idea that is NOT on GitHub yet — described straight into the engine.
// Without this the only input was a ticket, so having an idea meant leaving the
// conversation to run `gh issue create` and coming back, which is the friction
// that makes someone skip the framework and hand-build instead. That costs the
// lanes, the bouncer and the record all at once.
//
// **The ticket is filed when the owner APPROVES the plan, not before** — at plan
// time he may read what it actually costs and decide against it, and a ticket
// for a rejected idea is litter. Filing at approval also means the issue arrives
// with the decomposition already in it. Until then the ref is a placeholder.
// Shape: [{title, asks, priority?}].
const DESCRIBED = Array.isArray(A.items) && A.items.length ? A.items : null
// The ONLY way to survey the whole board. Owner, 2026-07-28: "always do 1 unless
// I'M SAYING more." Without this flag the engine plans at most one unnamed item.
const SWEEP = A.sweep === true
const CODE_LANES = ['matchmaker', 'registrar', 'gatekeeper', 'profiler', 'slackmaster', 'diplomat', 'handyman']
const EFFORT = { matchmaker: 'xhigh', instructor: 'xhigh', slackmaster: 'high', diplomat: 'high', registrar: 'xhigh', handyman: 'high', profiler: 'high', gatekeeper: 'high', editor: 'xhigh', framer: 'xhigh', bouncer: 'xhigh' }
// X124 · Fail at LOAD, not mid-run. A half-finished rename — a lane changed in
// CODE_LANES and missed here — otherwise dispatches with `effort: undefined` to
// an agentType that does not exist, and reads as a perfectly normal run.
// charter-audit.js:16-17 has had this guard since it was written; the two
// engines that actually BUILD did not.
// `framer` and not `editor`: this engine's three intake/plan dispatches are the
// FEATURE door. bugger.js's list names `editor` instead, which is the only
// legitimate difference between the two — the EFFORT map above stays identical
// across all three engines so one table prices every agent.
const DISPATCHABLE = [...CODE_LANES, 'instructor', 'framer', 'bouncer']
const UNKNOWN = DISPATCHABLE.filter((l) => !EFFORT[l])
if (UNKNOWN.length) throw new Error(`Unknown lane(s): ${UNKNOWN.join(', ')} — they have no effort setting and no agent, so they would dispatch to nothing.`)

const LANE_MAP =
  '`matchmaker` the scheduling core — finding a time that fits several calendars and rules · ' +
  '`registrar` the async work-item spine (approvals, outreach, reminders, follow-ups, close-loop); nothing raised gets lost · ' +
  '`gatekeeper` the output-time gates — nothing leaves without passing them · `profiler` identity, person store, memory, social · ' +
  '`instructor` everything Maelle is TOLD (system prompt, tool descriptions, learned prefs) and it runs LAST · ' +
  '`slackmaster` INSIDE the workspace — Slack end to end (routing, threading, DM/MPIM/channel posture, ' +
  'authority-by-authenticated-sender, the postReply delivery pipeline, Slack\'s `Connection` implementation) · ' +
  '`diplomat` OUTSIDE the workspace — every channel reaching someone who is not in Slack. Mail is the live one ' +
  '(mailbox poll, the inbound sender gate, forwarded-header extraction, the one-address send cap, reply-not-compose, ' +
  'mail auth); WhatsApp/iMessage land here too when they open · `handyman` only where NO lane owns the subsystem ' +
  '(news, brief, routines, the Graph CLIENT layer only — calendar is matchmaker, mail is diplomat — core orchestrator, DB, health, config, scripts)'

// ---- schemas ----
const RAW = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'github issue #' },
          title: { type: 'string' },
          // Two tracks, two vocabularies: Improvement carries High/Medium/Low,
          // Feature carries Roadmap/Next/Idea. Both are read here, so both sets
          // are valid — an enum holding only one would reject half the backlog.
          priority: { type: 'string', enum: ['High', 'Medium', 'Low', 'Roadmap', 'Next', 'Idea', 'unlabelled'] },
          asks: { type: 'string', description: "what the issue literally asks for, in the owner's own framing" },
        },
        required: ['ref', 'title', 'asks'],
      },
    },
  },
  required: ['items'],
}

const UNDERSTOOD = {
  type: 'object',
  properties: {
    ref: { type: 'string' },
    todayBehaviour: { type: 'string', description: 'what the code ACTUALLY does now — cite file:line, do not assume' },
    wantedBehaviour: { type: 'string', description: 'what it would do instead' },
    gap: { type: 'string', description: 'the honest distance between the two — say if it is bigger than the issue implies' },
    alreadyExists: { type: 'boolean', description: 'true if this is already built and the issue is stale' },
    openQuestions: { type: 'array', items: { type: 'string' }, description: 'what only the owner can answer. Empty if genuinely none' },
    surfaces: { type: 'array', items: { type: 'string' }, description: 'the user-visible surfaces this touches' },
    // THE TICKET IS THE ARTEFACT HE EXECUTES FROM MONTHS LATER, and a design
    // question filed as "here is what is unresolved" is unbuildable by then unless
    // the routes and their prices travel with it. `openQuestions` asks him to
    // decide; these two give him something to decide BETWEEN. Required, because a
    // field that is optional here is simply absent — that is what happened to
    // `risk` on the first plan he ever read.
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          route: { type: 'string', description: 'the design, in one line — what would be true afterwards' },
          cost: { type: 'string', description: 'what it costs: which lanes, roughly how much surface moves, what it forces elsewhere' },
          why: { type: 'string', description: 'why this route rather than the others — or, for a rejected one, what rules it out' },
        },
        required: ['route', 'cost'],
      },
      description:
        'the routes actually available, each with its cost. ONE entry is a legitimate answer when the code leaves one route — say so in `why`. Zero entries is not: it means the pass costed a design nobody checked (F2).',
    },
    recommendation: {
      type: 'string',
      description:
        'which option you would take and the one reason why. NEVER blank — you read the code and he did not, so having no opinion hands the work back to him. If the choice is genuinely his, say which two options it is between and what the decision turns on.',
    },
  },
  required: ['ref', 'todayBehaviour', 'wantedBehaviour', 'gap', 'alreadyExists', 'openQuestions', 'options', 'recommendation'],
}

const PLAN = {
  type: 'object',
  properties: {
    pieces: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ref: { type: 'string', description: 'the improvement this serves' },
          lane: { type: 'string', enum: ['matchmaker', 'registrar', 'gatekeeper', 'instructor', 'profiler', 'slackmaster', 'diplomat', 'handyman'] },
          // WHY this piece exists, in product terms. Added on the owner's ask
          // 2026-07-28: the first plan he read gave him lane · change · deps ·
          // size, and he could not decide from it because nothing said what any
          // piece was FOR. A mechanism without a requirement is unrulable — he
          // can tell you whether the code sounds right, not whether he wants it.
          requirement: {
            type: 'string',
            description:
              'the product requirement this piece serves: the outcome it buys, one line, from the point of view of whoever gets the benefit. NOT the mechanism (that is whatChanges) and NOT the decision it embeds (that is productDecision).',
          },
          // THE FENCE. This field asked for "what the code will do differently",
          // which invites the violation: the framer authors the CONTRACT and the
          // lane that owns the file chooses the implementation inside it. A piece
          // that names its implementation has bypassed the charter meant to choose
          // it — and the framer holds no lane's product rules, so its choice is
          // the one nothing checks. The reuse citation stays: it is load-bearing,
          // and "reuses X byte-for-byte" is a fact about the code, not a design.
          whatChanges: {
            type: 'string',
            description:
              'the FILES and the SEAM — never the solution inside them. Name the file(s), the function or boundary that moves, and what a person would see change. Name what it REUSES and cite file:line where you have it; "reuses X" is the most valuable thing in this field. **Do NOT write the implementation**: the lane that owns the file chooses that under its own charter, and a piece that names its implementation has bypassed the charter meant to choose it.',
          },
          // ── THE CONTRACT. The framer authors it; a lane implements it. ────────
          // A cross-lane change does not break inside a piece, it breaks at the
          // join — and nothing in this schema asked about the join. `gh#154` is
          // nine refs from five lanes precisely because five lanes each patched
          // their own side of one seam.
          connection: {
            type: 'string',
            description:
              'the SEAM: what this piece calls, what calls it, and **what it must not bypass**. The third clause is the one that matters — name the gate, guard or resolver that stays in the path, because that is where a cross-lane change actually breaks.',
          },
          expectation: {
            type: 'string',
            description:
              'what the OTHER pieces are entitled to assume about this one once it lands — the guarantee it gives them, stated as something they may rely on. **This is the field that stops two lanes each assuming the other handled it.** It specifies up front exactly what the bouncer\'s joint-trace verifies at the end: same seam, both ends. "Nothing — no other piece depends on this" is a valid and useful answer.',
          },
          whyThisLane: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'piece ids that must land first' },
          productDecision: { type: 'string', description: 'the owner call this embeds — empty string if it is purely mechanical' },
          charterRule: { type: 'string', description: 'a durable rule this decision should become, or empty. Improvements CAN earn rules; bugs never do' },
          // Was optional, so it was simply absent from the first plan the owner
          // read — while `size` sat in `required` and is read by nothing at all.
          // He asked for this one by name and does not care about size.
          risk: {
            type: 'string',
            description:
              'what could go wrong, what is still unresolved, what he should eyeball before it ships. NEVER blank — "None" is a claim worth making, and a piece with no risk named reads as unexamined.',
          },
          // BUILD 2 · THE CENSUS. Optional — most pieces are genuinely single-site.
          // When a fix IS a re-keying or a repeated shape, this is the ONLY thing
          // that turns "how many sites" from per-lane diligence into a fact checked
          // once, before any lane starts. Filled by the SAME Decompose pass; the
          // grep itself runs after, in the decompose-check dispatch below.
          patternQuery: {
            type: 'string',
            description:
              "if this piece's fix is a RE-KEYING or a pattern that plausibly repeats across files — the exact search string or short regex a grep would use to find every site. Empty string when this is genuinely single-site. A census runs on every non-blank value before any lane is dispatched.",
          },
        },
        required: ['id', 'ref', 'lane', 'requirement', 'whatChanges', 'connection', 'expectation', 'whyThisLane', 'dependsOn', 'risk'],
      },
    },
    // ── WHO WRITES THE SHARED CODE. ──────────────────────────────────────────
    // The framer is read-only PERMANENTLY — his ruling: "it authors the contract,
    // and some lane writes the code that embodies it." So this line is the only
    // thing in the plan that says who writes a file no single piece owns, and
    // WITHOUT IT the answer is decided by whichever lane happens to run first.
    //
    // IT NAMES A FACT, NOT A CALL: the owner is whoever owns that file; a
    // genuinely new file goes to the lane whose subsystem the rule is about; and
    // `src/connections/{types,registry}.ts` is the shared spine nobody owns.
    sharedPiece: {
      type: 'string',
      description:
        'who writes the code no single piece owns — `<lane> — <file>`, or exactly `none`. Several go on one line separated by `;`. This is a FACT, not a choice: the owner is whoever owns that file; a genuinely new file goes to the lane whose subsystem the rule is about; `src/connections/{types,registry}.ts` is the shared spine nobody owns. Never blank — `none` is the answer when no piece touches shared code.',
    },
    blockingQuestions: {
      type: 'array',
      items: { type: 'string' },
      description: 'must be answered BEFORE any build. Do not guess to keep the list short',
    },
    notWorthBuilding: {
      type: 'array',
      items: { type: 'string' },
      description: 'pieces you judge not worth the cost, with the reason. Saying so is a result',
    },
  },
  required: ['pieces', 'blockingQuestions', 'sharedPiece'],
}

// ── BUILD 1 + BUILD 2 · THE DECOMPOSE CHECK ─────────────────────────────────
// `connection` names the seam a piece must not bypass; nothing ever verified the
// route it names was REACHABLE. o#223's escalation sat entirely behind a
// pre-existing `if (context.authority !== 'owner')` return (createMeeting.ts:462,
// and its sibling at moveMeeting.ts:526,710) and no pass caught it before a lane
// built dead code. This is a STATIC check in the compiler sense — it reads the
// code as it stands, executes nothing, and dispatches to no lane: a piece that
// fails it does not go to a lane, it goes back into the plan.
//
// The SAME dispatch runs the CENSUS: any piece naming a `patternQuery` gets a
// real grep across the whole repo, whichever lane owns each site — reading
// crosses no lane boundary, it always could. `gh#154`'s nine refs were nine
// pieces that each thought it was the only site.
const DECOMPOSE_CHECK = {
  type: 'object',
  properties: {
    reachability: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reachable: {
            type: 'boolean',
            description:
              "false if a pre-existing early return, guard or condition sits between the entry point `connection` names and the code `whatChanges` proposes to add, such that the piece's own trigger could never reach it",
          },
          blockingGate: { type: 'string', description: 'file:line of that gate — empty string when reachable' },
        },
        required: ['id', 'reachable', 'blockingGate'],
      },
      description: 'one entry per piece, always — a piece with no entry here reads as unconfirmed, not as cleared.',
    },
    census: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          sites: {
            type: 'array',
            items: { type: 'object', properties: { file: { type: 'string' }, lane: { type: 'string' } }, required: ['file', 'lane'] },
          },
        },
        required: ['query', 'sites'],
      },
      description: 'one entry per non-blank `patternQuery` on any piece — the COMPLETE grep result, every site, whichever lane owns it. Empty array if no piece named a pattern.',
    },
  },
  required: ['reachability', 'census'],
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
          // X66 · `confirmed-other-lane` — the piece is DONE and you are not the
          // one who did it. Same verdict and same reasoning as bugger.js; a lane
          // resumed to close out a dependency must not claim another lane's change
          // as its own, because the verify and the shipped count both double it.
          //
          // X95 · THIS ENUM MIRRORS THE CHARTERS; IT DOES NOT DEFINE THE VOCABULARY —
          // the long note in bugger.js holds the reasoning. Adding a member here without
          // adding it to all eight lane charters does nothing.
          verdict: {
            type: 'string',
            enum: ['built', 'confirmed-other-lane', 'needs-dependency', 'blocked-charter', 'needs-owner-decision', 'already-fixed'],
          },
          fix: { type: 'string', description: 'files touched, +/- lines, plain English' },
          // Structured, because the verify reads `git diff` and the tree
          // routinely holds another chat's work as well. Same field and same
          // reasoning as bugger.js — see the long note there.
          filesTouched: {
            type: 'array',
            items: { type: 'string' },
            description: 'repo-relative path of EVERY file you edited or created for this piece. A missing list makes the verify treat the whole tree as this wave: safe, wasteful.',
          },
          // Forwarded to the verify so it spends its budget on what you did NOT
          // cover, instead of re-deriving ground you already walked.
          traced: {
            type: 'string',
            description:
              'the scenarios you paper-traced and the ones you deliberately did NOT, one line each. Be honest about the gaps — an uncovered case named here gets checked by the bouncer; one you quietly omit gets checked by nobody.',
          },
          dependencyAgent: { type: 'string', enum: ['matchmaker', 'registrar', 'gatekeeper', 'instructor', 'profiler', 'slackmaster', 'diplomat', 'handyman', ''] },
          dependencyAsk: { type: 'string' },
          // X22 · same field, same words as bugger.js. It matters here because
          // `VERIFY_OUT.results` reuses this shape, so a feature wave's OVERTURN is a
          // finding about live work — and without the field on this path the tag
          // would be true on the bug engine and absent on the improvement engine,
          // which is the tier-in-the-engine failure again.
          invariant: {
            type: 'string',
            description:
              'OMIT unless this is an instance of a GENERAL rule that could break elsewhere. When it is, one short stable slug, and the SAME slug on every piece that breaks the same rule — that is what lets the root be fixed once instead of three times.',
          },
          notes: { type: 'string' },
        },
        required: ['id', 'verdict'],
      },
    },
  },
  required: ['results'],
}

// Verdicts PLUS what the pass settled, so the next run can be told not to
// re-audit it. The report is emptied at wrap, so nothing else carries this.
const VERIFY_OUT = {
  type: 'object',
  properties: {
    results: VERDICTS.properties.results,
    // An OVERTURN (a piece in this wave is broken) goes in `results`. A
    // DISCOVERY — a pre-existing problem noticed while reading — goes here and
    // is NOT built in-wave: building it changes the tree the verify just
    // examined, invalidating the pass that found it. Same reasoning as
    // bugger.js, where the loop was first observed.
    discoveries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          symptom: { type: 'string', description: 'what a person would see go wrong — not the mechanism' },
          // X65 · same words as bugger.js. A log line proves the symptom
          // happened; only the file proves it still would, and a discovery is the
          // only claim in the loop nothing checks for currency.
          evidence: {
            type: 'string',
            description:
              'REQUIRED, and it must be a `file:line` AS THE FILE STANDS AT HEAD — open it and point at the line that is still wrong. A log line is what made you look; it is not evidence the defect is still there. If the code has since been fixed, this is not a discovery.',
          },
          lane: { type: 'string', enum: ['matchmaker', 'registrar', 'gatekeeper', 'instructor', 'profiler', 'slackmaster', 'diplomat', 'handyman'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'], description: 'carried into the next run, where the severity-first cap orders the queue. Judge the harm, not whether it blocks this wave — it does not.' },
          // X22 · same field, same words as bugger.js' discoveries.
          invariant: {
            type: 'string',
            description:
              'OMIT unless this is an instance of a GENERAL rule that could break elsewhere. When it is, one short stable slug, and the SAME slug on every discovery that breaks the same rule — that is what lets the root be fixed once instead of three times.',
          },
        },
        // X30 · `lane` and `severity` are REQUIRED, same as bugger.js: a discovery
        // is the next run's INTAKE rather than a row on his desk, so it has to be
        // routable and rankable. Not blocking and not severe are different claims.
        required: ['symptom', 'evidence', 'lane', 'severity'],
      },
      description: 'problems found that are NOT about the pieces under review. Empty array if none — never in `results`, and never suppressed to keep the wave clean.',
    },
    // Same field and reasoning as bugger.js: work satisfies open tickets by
    // accident, and only the pass reading the finished diff can notice.
    ticketCoverage: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'the issue, e.g. `#160`' },
          state: { type: 'string', enum: ['satisfied', 'partial', 'contradicted'] },
          whatLanded: { type: 'string', description: 'the change in this wave that touches it' },
          whatIsMissing: { type: 'string', description: 'partial only: precisely what the ticket still asks for. Never a bare percentage.' },
        },
        required: ['ref', 'state', 'whatLanded'],
      },
      description: 'open GitHub issues this wave satisfied, partly satisfied, or contradicted — OTHER than the ones it was built from. Empty array if none. Never close one yourself.',
    },
    verifiedClean: {
      type: 'array',
      items: { type: 'string' },
      description:
        'what you PROVED and would not spend budget on again — one specific claim per line naming the file/behaviour and why it holds. Only what you actually established; a false entry here silences a future check.',
    },
  },
  required: ['results'],
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAN MODE — read, understand, decompose. Build NOTHING.
// ═══════════════════════════════════════════════════════════════════════════
if (MODE === 'plan') {
  phase('Intake')
  // BOTH tracks. Note the syntax: `--label A --label B` is an AND in gh and would
  // match nothing, so this uses search, where `label:A,B` is an OR. Reading only
  // `Improvement` was a trap — a design question filed as a `Feature` (which is
  // what the owner naturally calls it) became invisible to this engine forever.
  // The priority word narrows to whichever track uses it, which is the intent:
  // `High` finds Improvements, `Roadmap` finds Features.
  const query = REFS
    ? `Run ONLY: \`gh issue view <n> --json number,title,body,labels\` for each of these issue numbers: ${REFS.join(', ')}`
    : `Run ONLY this one command: \`gh issue list --search "is:open label:Improvement,Feature${PRIORITY ? ` label:${PRIORITY}` : ''}" --json number,title,body,labels\``

  // A described item needs no intake at all — the owner already said what he
  // wants, and re-reading it through an agent would only risk paraphrasing it.
  // His words go through verbatim, which is the same reason the GitHub path is
  // told not to reinterpret a body.
  let items
  if (DESCRIBED) {
    items = DESCRIBED.map((it, n) => ({
      ref: it.ref || `new-${n + 1}`, // placeholder; the real `gh#N` arrives when he approves and it is filed
      title: it.title || (it.asks || '').slice(0, 60),
      priority: it.priority || 'unlabelled',
      asks: it.asks || it.title || '',
    }))
    log(`Plan: ${items.length} described item(s), not on GitHub yet — intake skipped. A ticket is filed if you approve, not before.`)
  } else {
    const raw = await agent(
      `${query} (read-only). Do NOT orient, explore the codebase, or read other files — just the command. SKIP any issue already labelled \`Agent\`. ` +
        `Return each as {ref:"#<number>", title, priority:<whichever priority label it carries — High|Medium|Low on an Improvement, Roadmap|Next|Idea on a Feature, else unlabelled>, asks:<what it literally asks for, in the owner's own framing — do not reinterpret or improve it>}. ` +
        `If the list is empty return {items:[]} immediately.`,
      // X126 · The FEATURE door is the `framer`, not the editor. Both read a
      // backlog, but the bug editor's charter is defect-shaped end to end — a
      // very hard "obvious defect" bar, one-root-one-issue, and "a product
      // decision means do not dispatch" — and every one of those is wrong here.
      // Effort and model stay as tuned: one shell command does not need more.
      // X151 · the label names the agent first (framer, every dispatch in this
      // file) and the task second — `Intake` already says what phase this is.
      { label: 'framer:backlog', phase: 'Intake', agentType: 'framer', effort: 'low', model: 'haiku', schema: RAW },
    )
    items = (raw && raw.items) || []
    log(`Intake: ${items.length} open item(s)${PRIORITY ? ` at ${PRIORITY}` : ''}.`)
  }
  if (!items.length) return { mode: 'plan', items: [], pieces: [], blockingQuestions: [], note: 'Nothing open.' }
  items.forEach((i) => log(`  • ${i.ref} [${i.priority || '?'}] ${(i.title || '').slice(0, 80)}`))

  // ONE DESIGN ITEM, and this is the line that enforces it. The whole point of
  // clustering by destination is that nine symptoms become ONE recon and ONE plan;
  // a design run that arrived with two items would spend two Opus recons deciding
  // the same question twice and then hand him two half-designs to reconcile.
  if (DESIGN && items.length !== 1)
    throw new Error(
      `args.design (${DESIGN_REF}) is one design item, and intake returned ${items.length}: ${items.map((i) => i.ref).join(', ')}. Nothing was planned. One design question = one destination = one recon.`,
    )
  if (DESIGN)
    log(
      `Design door: ${DESIGN_REF} — ${CLUSTER_REFS.length} converted symptom ref(s)` +
        (CLUSTER_REFS.length ? ` from ${new Set(CLUSTER_REFS.map((r) => r.lane).filter(Boolean)).size} lane(s)` : '') +
        ` ride in as evidence. ONE item, one recon.` +
        (CLUSTER_REFS.length ? '' : ` No cluster passed — run \`node scripts/design-cluster.cjs ${DESIGN_REF}\` if this item has converted rows waiting on it.`),
    )

  // ── X12 · ONE ITEM IS THE DEFAULT. A SWEEP MUST BE ASKED FOR. ─────────────
  // Owner, 2026-07-28: "always do 1 unless I'M SAYING more."
  //
  // This was a LOG line: it printed "32 items means 32 agents" and then fanned
  // out anyway, costing ~2.1M tokens the first time it fired. **A message is not
  // a gate.** I named that exact hazard an hour before it happened and still
  // wrote the weak version, which is the lesson of the whole day in one line.
  //
  // Naming `refs` or `items` IS him saying more, so those paths pass through at
  // whatever count he chose. Reaching here means the ENGINE picked the list, and
  // it does not get to pick 32. Recon is one Opus agent per item.
  if (!REFS && !DESCRIBED && items.length > 1 && !SWEEP) {
    log(`! ${items.length} open item(s), none named — STOPPING before Recon. One is the default; a sweep must be asked for.`)
    return {
      mode: 'plan',
      needsChoice: true,
      items: items.map(({ ref, title, priority }) => ({ ref, title, priority })),
      pieces: [],
      blockingQuestions: [],
      note:
        `${items.length} items are open and none were named, so NOTHING was planned. Recon is one Opus agent per item — 32 of them cost ~2.1M tokens on 2026-07-28. ` +
        `Show the owner this list, ask which ONE he wants, and re-invoke with \`args.refs:['#<n>']\`. If he genuinely wants the whole board surveyed, re-invoke with \`args.sweep:true\`.`,
    }
  }

  // RECON each item against the CODE, in parallel. Named `Recon` (owner,
  // 2026-07-28) because the other phases are noun-shaped — Intake · Decompose ·
  // Build · Context · Verify — and because rule 9b in every lane charter already
  // says "RECON in 2-4 batched rounds", so it is vocabulary the framework speaks.
  // "Planner" was rejected: it would leak into Decompose's job and this phase
  // must establish what is TRUE before anyone proposes a shape.
  //
  // An improvement written months
  // ago is often already half-built, or asks for something the code makes
  // impossible — both are findings, and both are cheaper to learn now than after
  // a lane has been dispatched.
  // X19 · The owner's constraints, if he named any. `answers` is build-only — it
  // responds to openQuestions this pass has not produced yet — so until now a
  // constraint had no way to reach the one pass that decides what an item MEANS.
  // At plan time the ticket got a voice and he did not; the product chat hit this
  // and worked round it by holding four constraints in its own head and checking
  // recon's output for compliance afterwards, which is checking instead of telling.
  const CONSTRAINTS = (Array.isArray(A.constraints) ? A.constraints : []).filter((c) => typeof c === 'string' && c.trim())

  // The cluster, as evidence. NINE refs from five lanes are not nine items: they
  // are nine independent observations of ONE missing seam, which is the strongest
  // input this pass can be given and the one it never had. Each was closed
  // `converted` precisely to avoid a partial fix, so a per-ref patch is the one
  // shape that is wrong — that instruction is stated, not implied, because the
  // model's default given nine symptoms is nine remedies.
  const CLUSTER_NOTE = CLUSTER_REFS.length
    ? `**THIS IS A DESIGN ITEM, AND ${CLUSTER_REFS.length} BUG ROWS ARE WAITING ON IT.**\n` +
      `Each was closed \`converted\` onto ${DESIGN_REF || 'this item'} — taken off the bug track BECAUSE the owner refused a partial fix` +
      `${CLUSTER && CLUSTER.span && CLUSTER.span.first ? `, across ${CLUSTER.span.first}..${CLUSTER.span.last}` : ''}` +
      ` from ${new Set(CLUSTER_REFS.map((r) => r.lane).filter(Boolean)).size} lane(s). They are not nine items; they are nine observations of ONE missing seam, and the design is what unblocks all of them.\n\n` +
      `**Do NOT design a patch per row.** Produce ONE design and say plainly which rows it does NOT cover and why — an uncovered row named here gets ruled on; one quietly omitted gets fixed twice next month.\n\n` +
      `Their \`rootCause\` lines are the map of the seam: where several point at the same file, that is the seam, not a coincidence.\n\n` +
      `SYMPTOM ROWS ABSORBED BY THIS ITEM:\n${JSON.stringify(
        CLUSTER_REFS.map((r) => ({ ref: r.ref, lane: r.lane, date: r.date, finding: r.finding, rootCause: r.rootCause, closedBecause: r.note })),
        null,
        2,
      )}\n\n`
    : ''

  phase('Recon')
  const recon = (
    await parallel(
      items.map((it) => () =>
        agent(
          `Work out what this item ACTUALLY means against the code on disk. Read-only — build nothing.\n\n` +
            `Establish: what the code does TODAY (cite file:line — do not assume, and do not trust the issue's description of current behaviour); what it would do instead; and the honest gap between them. ` +
            `**Say so plainly if the gap is bigger than the issue implies** — an improvement that reads like one line and is really a subsystem is the single most useful thing you can surface here.\n\n` +
            `If it is ALREADY BUILT, set alreadyExists:true and say where. Issues go stale.\n\n` +
            `List openQuestions — things only the owner can decide. Be honest rather than tidy: an improvement is a product decision, so a short list is suspicious, not efficient. But do not manufacture questions the code already answers.\n\n` +
            // The ticket is the artefact he executes from months later, so the
            // routes and their prices have to be produced HERE, by the pass that
            // read the code. `openQuestions` asks him to decide; these give him
            // something to decide between.
            `**Return \`options\` — the routes actually available, each with its cost — and a \`recommendation\` naming the one you would take.** You read the code and he did not, so having no opinion hands the work back to him. One option is a legitimate answer when the code leaves one route; zero is not.\n\n` +
            CLUSTER_NOTE +
            // X20 · The `asks` are summarised from a ticket BODY, and those bodies
            // routinely pre-pick a mechanism — one names the file to create, another
            // decides "no new tool" before anyone read the code. Given a design this
            // pass prices that design; given an outcome it works out the how and says
            // when the gap is bigger than he thinks, which is the whole point of it.
            `**The \`asks\` below may describe an implementation. Treat it as a PROPOSAL to test against the code, never as a spec to cost.** It was written from a ticket body that often picked a mechanism months ago without reading the code. If a better route exists, name it; if the proposed one is wrong or already impossible, say that plainly. Costing a design nobody checked is the failure mode of this phase.\n\n` +
            (CONSTRAINTS.length
              ? `**THE OWNER'S CONSTRAINTS — read these BEFORE deciding what the item means:**\n${CONSTRAINTS.map((c) => `• ${c}`).join('\n')}\n\n` +
                `A constraint is not a hint. If one makes the item impossible, or forces a materially worse route than you would otherwise take, put that in \`openQuestions\` rather than quietly working round it — **a constraint he cannot have is the most valuable thing you can tell him**, and silently satisfying it hides the choice he needed to make.\n\n`
              : '') +
            `IMPROVEMENT ${it.ref}: ${it.title}\n${it.asks}`,
          // X15 · OPUS, on the owner's call. This pass establishes the ground
          // truth every later piece stands on, and NOTHING backstops it: the
          // bouncer checks the diff, not whether the premise was right, and a
          // bad code-read is the one thing he cannot spot by reading a plan. He
          // runs one feature at a time, so this is a single agent.
          // X126 · agentType framer — drafting the shape IS its charter (F1).
          // The explicit `model: 'opus'` STAYS and overrides framer.md's declared
          // sonnet: X15 above is an owner ruling on this specific call, and the
          // tier must not move as a side effect of giving the pass a charter.
          { label: `framer:${it.ref}`, phase: 'Recon', agentType: 'framer', effort: 'high', model: 'opus', schema: UNDERSTOOD },
        ),
      ),
    )
  ).filter(Boolean)

  const stale = recon.filter((u) => u.alreadyExists)
  const live = recon.filter((u) => !u.alreadyExists)
  if (stale.length) log(`${stale.length} already built — stale issue(s): ${stale.map((s) => s.ref).join(', ')}`)

  // Decompose — one pass over ALL of them together, because the cross-improvement
  // view is the whole point: two improvements often want the same seam moved once.
  // The CONTRACT bullets, in one place because the repair round below re-states
  // exactly these and a second copy would drift on the first edit.
  const CONTRACT_RULES =
    `• **Every piece names its \`connection\` — what it calls, what calls it, and WHAT IT MUST NOT BYPASS.** The third clause is the one that matters: name the gate, guard or resolver that stays in the path. This is where a cross-lane change actually breaks, and nothing else in this plan asks for it.\n` +
    `• **Every piece names its \`expectation\` — what the OTHER pieces are entitled to assume about this one once it lands.** This is the field that stops two lanes each assuming the other handled it, and it specifies up front exactly what the bouncer's joint-trace verifies at the end: same seam, both ends. "Nothing — no other piece depends on this" is a valid answer.\n` +
    `• **\`sharedPiece\` on the plan: \`<lane> — <file>\`, or exactly \`none\`.** You are read-only and permanently so — you author the contract, a lane writes the code that embodies it — so this line is the ONLY thing saying who writes a file no single piece owns. It names a FACT, not a call: the owner is whoever owns that file; a genuinely new file goes to the lane whose subsystem the rule is about; \`src/connections/{types,registry}.ts\` is the shared spine nobody owns.\n`

  phase('Decompose')
  const plan = await agent(
    `Decompose these recon findings into per-lane pieces the owner can approve one by one.\n\n` +
      `LANES: ${LANE_MAP}\n\n` +
      `Rules that differ from bug triage — read these, they are the reason this is not the bugger loop:\n` +
      `• Split by CAPABILITY and SURFACE, not by root cause. One improvement legitimately landing in three lanes is normal and is NOT a merge candidate.\n` +
      `• Do the opposite too: where two improvements want the SAME seam moved, say so and emit ONE piece. That cross-view is why this is a single pass.\n` +
      `• **Every piece names its \`requirement\` — the product outcome it buys, in one line, from the point of view of whoever benefits.** This is the column the owner rules on. A piece described only as a mechanism is unrulable: he can tell you whether the code sounds right, but not whether he WANTS it. If you cannot state the requirement without restating the mechanism, the piece is not understood yet.\n` +
      `• **Every piece names its \`risk\`** — what could go wrong, what is unresolved, what he should eyeball before it ships. Never blank; "None" is a claim worth making, and a piece with no risk named reads as unexamined.\n` +
      `• If a piece's fix is a RE-KEYING or a shape that plausibly repeats elsewhere — the same bug in more than one file, a copy-pasted check — name the exact search string in \`patternQuery\`. A census runs on it before any lane is dispatched, so the count is a fact and not per-lane diligence. Leave it empty when the fix is genuinely single-site.\n` +
      // THE FENCE. This bullet asked for "what the code will do differently",
      // which invites the violation it now forbids.
      `• \`whatChanges\` names **the files and the seam, never the solution inside them** — the file(s), the function or boundary that moves, what a person would see change, and above all **what it REUSES** with a \`file:line\`. "Reuses X byte-for-byte" is worth more than any other sentence in that field. **A piece that names its implementation has bypassed the charter meant to choose it**: the lane owns that call under its own product rules, and you hold none of them.\n` +
      CONTRACT_RULES +
      `• Every piece names the \`productDecision\` it embeds, or empty if genuinely mechanical. If you cannot name the decision, you have not understood the piece.\n` +
      `• Where a decision should outlive this wave, write it as a \`charterRule\`. **A bug never earns a charter rule — an improvement often should.** This is the only flow that produces them, so do not skip it.\n` +
      `• \`dependsOn\` is real ordering, not preference. \`context\` always lands last.\n` +
      `• \`blockingQuestions\` are things that must be settled BEFORE building. Do NOT guess to keep the list short — a guess here becomes built code the owner never chose.\n` +
      `• If a piece is not worth its cost, put it in \`notWorthBuilding\` with the reason. Declining is a result.\n\n` +
      (CLUSTER_REFS.length
        ? `**THIS IS ONE DESIGN ITEM WITH ${CLUSTER_REFS.length} BUG ROWS WAITING ON IT** (${DESIGN_REF || 'see the recon'}). Decompose the RECOMMENDED design, not the symptoms — each of those rows was closed \`converted\` to avoid a partial fix, so a piece per symptom is the one shape that is wrong. Name in \`notWorthBuilding\` any absorbed row the design does not cover.\n\n`
        : '') +
      `UNDERSTOOD:\n${JSON.stringify(live, null, 2)}`,
    // X126 · agentType framer — every bullet below is now one of its rules
    // (F5-F10), so the engine states the schema and the charter states the
    // standing duty. Effort stays xhigh; no model pin, so the tier comes from
    // the charter, which is where spend.cjs:293 says it belongs.
    { label: 'framer', phase: 'Decompose', agentType: 'framer', effort: 'xhigh', schema: PLAN },
  )

  let pieces = (plan && plan.pieces) || []
  let sharedPiece = String((plan && plan.sharedPiece) || '').trim()

  // ── THE CONTRACT GATE, AND WHY `required` IS NOT IT ────────────────────────
  // A schema's `required` stops a field being ABSENT. It does not stop `""`, and
  // that is why `risk`'s own description has carried "NEVER blank" in prose since
  // the day it was added. A blank `connection` is worse than a missing one: the
  // plan renders, he approves it, and the seam nobody specified is the seam two
  // lanes each assume the other handled — which is the exact failure `gh#154`
  // recorded nine times.
  //
  // ONE REPAIR ROUND, not a throw and not a warning. A throw here discards an
  // Opus recon and the whole decompose over a field a second sonnet pass fills in;
  // a warning is a message, and a message is not a gate (X12). The repair is sent
  // ONLY the incomplete pieces, so it costs a fraction of the pass it fixes.
  const blank = (p) => ['connection', 'expectation'].filter((k) => !String((p && p[k]) || '').trim())
  const gapsOf = (list) => list.map((p) => ({ id: p && p.id, missing: blank(p) })).filter((g) => g.missing.length)
  let contractRepaired = 0
  let gaps = gapsOf(pieces)
  if (gaps.length || !sharedPiece) {
    log(`! Contract incomplete: ${gaps.length} of ${pieces.length} piece(s) blank on ${[...new Set(gaps.flatMap((g) => g.missing))].join('/') || '(none)'}${sharedPiece ? '' : ', and `sharedPiece` is blank'} — ONE repair round.`)
    const fix = await agent(
      `Your plan came back with an INCOMPLETE CONTRACT. Fill only what is missing — do not re-plan, do not re-split, do not change any other field.\n\n` +
        CONTRACT_RULES +
        `\nReturn the SAME pieces with the same \`id\`s, every field carried through unchanged, and the blank ones filled. ` +
        (sharedPiece ? `\`sharedPiece\` is already \`${sharedPiece}\` — return it unchanged.\n\n` : `\`sharedPiece\` was blank: answer it, and \`none\` is the answer when no piece touches shared code.\n\n`) +
        (gaps.length ? `BLANK FIELDS:\n${gaps.map((g) => `• ${g.id}: ${g.missing.join(', ')}`).join('\n')}\n\n` : '') +
        `PIECES:\n${JSON.stringify(gaps.length ? pieces.filter((p) => blank(p).length) : [], null, 2)}\n\n` +
        `RECON (for the seam facts):\n${JSON.stringify(live, null, 2)}`,
      { label: 'framer:contract', phase: 'Decompose', agentType: 'framer', effort: 'high', schema: PLAN },
    )
    const filled = new Map(((fix && fix.pieces) || []).filter((p) => p && p.id).map((p) => [p.id, p]))
    pieces = pieces.map((p) => {
      const f = filled.get(p && p.id)
      if (!f) return p
      const merged = { ...p }
      for (const k of ['connection', 'expectation']) if (!String(merged[k] || '').trim() && String(f[k] || '').trim()) merged[k] = f[k]
      if (blank(p).length && !blank(merged).length) contractRepaired += 1
      return merged
    })
    if (!sharedPiece) sharedPiece = String((fix && fix.sharedPiece) || '').trim()
    gaps = gapsOf(pieces)
  }

  // ── BUILD 1 + BUILD 2 · ONE read-only dispatch, AFTER the repair round ─────
  // (so it checks the FINAL connection/whatChanges, not a draft the repair round
  // may have rewritten). See DECOMPOSE_CHECK above for the full reasoning.
  const patternQueries = [...new Set(pieces.map((p) => String((p && p.patternQuery) || '').trim()).filter(Boolean))]
  let unreachable = []
  let censusByQuery = new Map()
  let decomposeCheckRan = false
  if (pieces.length) {
    const check = await agent(
      `Two READ-ONLY checks on this decomposition. Build nothing, write nothing, run nothing — you are reading the code as it stands.\n\n` +
        `**1. REACHABILITY.** For EVERY piece below, open the file(s) its \`whatChanges\` and \`connection\` name. Confirm no pre-existing early return, guard or condition sits between the entry point \`connection\` names and the code \`whatChanges\` proposes to add, such that the piece could never run for its own stated trigger. A piece can be entirely correct on its own and still be dead code because of what already runs before it — that is the exact failure this check exists to catch. Set \`reachable:false\` and cite the \`file:line\` of that gate in \`blockingGate\` when one exists; \`reachable:true\` and empty \`blockingGate\` otherwise. Return one result per piece id, always.\n\n` +
        (patternQueries.length
          ? `**2. CENSUS.** ${patternQueries.length} pattern(s) below plausibly repeat across files. For EACH, \`grep\` the WHOLE repo (read-only) and return every site with its file and which lane owns it — ${LANE_MAP}\n\nQUERIES:\n${patternQueries.map((q) => `  • ${q}`).join('\n')}\n\n`
          : '**2. CENSUS.** No piece named a pattern to search for — return `census: []`.\n\n') +
        `PIECES:\n${JSON.stringify(pieces.map((p) => ({ id: p.id, lane: p.lane, whatChanges: p.whatChanges, connection: p.connection, patternQuery: p.patternQuery || '' })), null, 2)}`,
      { label: 'framer:decomposeCheck', phase: 'Decompose', agentType: 'framer', effort: 'high', schema: DECOMPOSE_CHECK },
    )
    decomposeCheckRan = !!check
    unreachable = ((check && check.reachability) || []).filter((r) => r && r.reachable === false && String(r.blockingGate || '').trim())
    censusByQuery = new Map(((check && check.census) || []).filter((c) => c && c.query).map((c) => [c.query, Array.isArray(c.sites) ? c.sites : []]))
  }
  if (pieces.length && !decomposeCheckRan)
    log('! DECOMPOSE CHECK DID NOT RUN — reachability and census are UNCONFIRMED for every piece. Not a block (this check did not exist before today), but nothing has verified the route is real.')

  // A failed reachability check FLAGS the piece, never drops it — the plan is
  // where he sees it and the framer redesigns around the named gate, not a lane.
  const unreachableById = new Map(unreachable.map((r) => [r.id, r.blockingGate]))
  pieces = pieces.map((p) => (unreachableById.has(p.id) ? { ...p, unreachable: true, blockingGate: unreachableById.get(p.id) } : p))
  if (unreachable.length)
    log(`! UNREACHABLE: ${unreachable.length} piece(s) name a route a pre-existing gate blocks — ${unreachable.map((r) => `${r.id}:${r.blockingGate}`).join(', ')}. They do NOT go to a lane; they go back into the plan.`)

  // The census total, as PLAIN TEXT on the piece — never a new structured field.
  // Owner-approved follow-ups leave the feature track and get built by bugger.js,
  // which has never heard of `expectation` or `connection`. Prose in a field
  // that already survives into a ticket body (`census`, rendered in `ticketFor`
  // exactly like `risk` below) is what reaches whatever engine builds it next.
  pieces = pieces.map((p) => {
    const q = String(p.patternQuery || '').trim()
    if (!q) return p
    const sites = censusByQuery.get(q) || []
    const mine = sites.filter((s) => s.lane === p.lane)
    const otherLanes = [...new Set(sites.filter((s) => s.lane !== p.lane).map((s) => s.lane).filter(Boolean))]
    return {
      ...p,
      census:
        `pattern "${q}" has ${sites.length} site(s) across ${new Set(sites.map((s) => s.lane).filter(Boolean)).size} lane(s)${otherLanes.length ? ` (also: ${otherLanes.join(', ')})` : ''}. ` +
        `${mine.length} of them are yours: ${mine.map((s) => s.file).join(', ') || '(none)'}. This piece is not done until all ${mine.length} are closed.`,
    }
  })
  if (censusByQuery.size) log(`Census: ${censusByQuery.size} pattern(s) — ${[...censusByQuery.entries()].map(([q, s]) => `"${q}":${s.length}`).join(', ')}.`)

  // The observable, and it is the number he can check: `blank` must be 0 and
  // `unreachable` must be 0 on a plan that is safe to render. Either surviving
  // the repair round says so out loud.
  const contract = {
    pieces: pieces.length,
    blank: gaps.length,
    repaired: contractRepaired,
    sharedPiece: sharedPiece || '(BLANK)',
    unreachable: unreachable.length,
    checked: decomposeCheckRan,
  }
  if (gaps.length)
    log(
      `! CONTRACT STILL INCOMPLETE after the repair round — ${gaps.map((g) => `${g.id}:${g.missing.join('+')}`).join(', ')}. Do NOT render this plan to the owner: an unspecified seam is what two lanes each assume the other handled.`,
    )
  if (!sharedPiece) log('! `sharedPiece` is BLANK after the repair round — nothing in this plan says who writes shared code, so the first lane to run decides it.')

  log(`Plan: ${pieces.length} piece(s) across ${new Set(pieces.map((p) => p.lane)).size} lane(s); ${((plan && plan.blockingQuestions) || []).length} blocking question(s); ${unreachable.length} unreachable; ${censusByQuery.size} pattern census(es); shared code → ${sharedPiece || '(BLANK)'}.`)

  // ── `needsTicket` CARRIES THE FINISHED BODY, NOT THE ASK ───────────────────
  // It used to be `{placeholderRef, title, asks, priority}` — the ingredients —
  // so the Manager recomposed the ticket by hand from four other fields of this
  // return. That is fatal for one reason: **the ticket is the artefact he executes
  // from months later.** `gh#154` is the proof — nine refs closed onto a body
  // nobody could build from, waiting eight days. Hand over the answer.
  //
  // COMPOSED IN THE ENGINE, deterministically, from what the passes already
  // produced. No extra dispatch and no extra tokens: every sentence below was
  // already paid for by Recon or Decompose.
  //
  // LABELS follow his own precedent — `Improvement` + High/Medium/Low (gh#154 is
  // Improvement+High); `Feature` + Roadmap/Next/Idea only when the capability does
  // not exist at all, which is what choosing a Feature-track word means. An
  // unlabelled item gets `Improvement` and NO priority guess: inventing one puts a
  // number he never chose on the surface he prioritises from.
  const FEATURE_AXIS = ['Roadmap', 'Next', 'Idea']
  const IMPROVE_AXIS = ['High', 'Medium', 'Low']
  const labelsFor = (p) => (FEATURE_AXIS.includes(p) ? ['Feature', p] : IMPROVE_AXIS.includes(p) ? ['Improvement', p] : ['Improvement'])
  const ticketFor = (it) => {
    const u = live.find((x) => x && x.ref === it.ref) || {}
    const own = pieces.filter((p) => p && p.ref === it.ref)
    const opts = Array.isArray(u.options) ? u.options : []
    const labels = labelsFor(it.priority)
    const body = [
      `**His words:** ${it.asks || '(none recorded)'}`,
      '',
      '## What breaks today',
      u.todayBehaviour || '(recon recorded no current behaviour — do not build from this ticket until it does)',
      '',
      `**Wanted:** ${u.wantedBehaviour || '(not recorded)'}`,
      `**The honest gap:** ${u.gap || '(not recorded)'}`,
      '',
      '## Options, with what each costs',
      ...(opts.length
        ? opts.map((o, n) => `${n + 1}. **${o.route}** — ${o.cost}${o.why ? ` · ${o.why}` : ''}`)
        : ['(recon returned none — that is a defect in the plan pass, not a design with one route)']),
      '',
      `## Recommendation`,
      u.recommendation || '(none — this ticket cannot be executed until somebody names the route)',
      '',
      '## The contract each piece is held to',
      ...(own.length
        ? own.flatMap((p) => [
            `- **${p.id} · ${p.lane}** — ${p.requirement}`,
            `  - changes: ${p.whatChanges}`,
            `  - connection: ${p.connection || '(BLANK)'}`,
            `  - expectation: ${p.expectation || '(BLANK)'}`,
            `  - risk: ${p.risk || '(BLANK)'}`,
            ...(p.census ? [`  - census: ${p.census}`] : []),
          ])
        : ['(no piece was decomposed for this item)']),
      '',
      `**Who writes the shared code:** ${sharedPiece || '(BLANK — nothing in the plan says, so the first lane to run decides it)'}`,
      '',
      ...(((plan && plan.blockingQuestions) || []).length
        ? ['## Settle before building', ...((plan && plan.blockingQuestions) || []).map((q) => `- ${q}`), '']
        : []),
      ...(CLUSTER_REFS.length
        ? [
            `## Bug rows this absorbs (${CLUSTER_REFS.length})`,
            'Each was closed `converted` onto this item to AVOID a partial fix. They stay closed; this design is what resolves them.',
            ...CLUSTER_REFS.map((r) => `- \`${r.ref}\` (${r.lane || '?'}, ${r.date || '?'}) — ${r.finding}${r.rootCause ? ` · ${r.rootCause}` : ''}`),
            '',
          ]
        : []),
    ].join('\n')
    return { placeholderRef: it.ref, title: it.title, labels, priority: it.priority, body, absorbs: CLUSTER_REFS.map((r) => r.ref) }
  }
  // ONE TICKET PER DESIGN ITEM, NEVER PER SYMPTOM REF — `items` is the item list,
  // and the absorbed refs are a section INSIDE one body, never a body each.
  // Nothing is filed here: the engine cannot, and it must not. He may read the
  // cost and decline, and a ticket for a rejected idea is litter.
  const needsTicket = DESCRIBED ? items.map(ticketFor) : []
  const needsPriority = needsTicket.filter((t) => t.labels.length < 2).map((t) => t.placeholderRef)
  if (needsPriority.length) log(`! ${needsPriority.length} ticket body(ies) carry no priority label — ask him for High/Medium/Low before filing: ${needsPriority.join(', ')}`)

  // Deliberately returns WITHOUT building. The owner approves in chat, then the
  // Manager re-invokes with {mode:'build', pieces:[approved]}.
  return {
    mode: 'plan',
    items,
    stale,
    recon: live,
    pieces,
    // The plan-level contract, so `sharedPiece` reaches his table as its own line
    // instead of being buried in a piece nobody owns.
    sharedPiece,
    contract,
    // The design door's own record: what it absorbed, and the command that writes
    // the decision back onto every one of those rows once he rules.
    design: DESIGN
      ? {
          ref: DESIGN_REF,
          absorbs: CLUSTER_REFS.map((r) => r.ref),
          lanes: [...new Set(CLUSTER_REFS.map((r) => r.lane).filter(Boolean))],
          joinBack: `node scripts/design-cluster.cjs ${DESIGN_REF} --decide "<the design he chose>"`,
        }
      : null,
    blockingQuestions: (plan && plan.blockingQuestions) || [],
    notWorthBuilding: (plan && plan.notWorthBuilding) || [],
    // Described items have no GitHub issue yet, and the Manager has to file one
    // ON APPROVAL — before the build, so the ledger row and the wrap have a real
    // `gh#N` to key on. Not before the plan: he may read the cost and decline,
    // and a ticket for a rejected idea is litter.
    needsTicket,
    needsPriority,
    next:
      (contract.blank
        ? `STOP: ${contract.blank} piece(s) have a BLANK \`connection\` or \`expectation\` after the repair round — see \`contract\`. Do not render this plan; re-invoke plan mode. An unspecified seam is what two lanes each assume the other handled. Then: `
        : '') +
      (contract.unreachable
        ? `STOP: ${contract.unreachable} piece(s) name a route a pre-existing gate makes unreachable — see \`pieces[].blockingGate\`. Do not approve these as written; they need a different route around the named gate. Then: `
        : '') +
      (DESCRIBED
        ? 'THESE ARE NOT ON GITHUB YET. If the owner approves, FILE the issue with `gh issue create --title <title> --label <each label> --body-file <temp .md>` using `needsTicket[].body` VERBATIM — it is the finished ticket, not ingredients; do not recompose it. Then replace the `new-N` placeholder ref on each piece with the real `gh#N` before building. If he declines, file nothing. Then: '
        : '') +
      (DESIGN
        ? `${DESIGN_REF} IS ALREADY FILED, so nothing is filed here. When he rules, run \`design.joinBack\` — it appends his decision onto all ${CLUSTER_REFS.length} absorbed row(s) under their existing \`converted\` verdict, so they stay closed and \`grep ${DESIGN}\` shows the design beside every symptom. Then: `
        : '') +
      'Owner approves/reshapes the pieces and answers the blocking questions, then re-invoke: Workflow({scriptPath:".claude/workflows/feature.js", args:{mode:"build", pieces:[...approved], answers:{...}, recon}}). PASS `recon` BACK — it carries what each area does today with file:line, and without it every builder re-derives ground this pass already covered. The join is by `ref`, so the refs in `pieces` and `recon` must match exactly.',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BUILD MODE — the owner has approved specific pieces. Dispatch in dep order.
// ═══════════════════════════════════════════════════════════════════════════
const raw = Array.isArray(A.pieces) ? A.pieces : []
if (!raw.length) {
  return { mode: 'build', error: 'No approved pieces. Run mode:"plan" first, get the owner\'s approval, then pass pieces:[...].' }
}
// X25 · THE READER FOR `awaitingOwner`, identical to bugger.js's guard on
// `args.issues`. The verify's deferred asks are shaped for a paste straight back
// into `args.pieces`, so the flag saying "the parent is still waiting on him" must
// be enforced at exactly that door. `pieces` means APPROVED; a row carrying this
// flag contradicts the container it arrived in. Deleting the flag is the approval.
const undecidedPieces = raw.filter((p) => p && p.awaitingOwner)
if (undecidedPieces.length)
  throw new Error(
    `args.pieces carries ${undecidedPieces.length} row(s) still flagged \`awaitingOwner\`: ` +
      `${undecidedPieces.map((p) => `${p.id || '(no id)'} (parent verdict ${p.fromVerdict || '?'})`).join(', ')}. ` +
      `Each is a dependency ask the verify raised on a piece that is waiting on the owner, so building it could implement a dependency of something he declines. ` +
      `Nothing has been dispatched. Get his ruling, delete \`awaitingOwner\` from the row, and re-invoke.`,
  )

// Plan mode already established, against the code, what each improvement's area
// does TODAY — with file:line. Passing `recon` back in hands that to the
// builder instead of making it re-derive the same ground from scratch. Same
// saving as bugger.js's Locate pass, except here the work is already done and was
// simply being thrown away between the two invocations.
const recon = Array.isArray(A.recon) ? A.recon : []
const approved = raw.map((p) => {
  const u = recon.find((x) => x && x.ref === p.ref)
  return u ? { ...p, _where: { todayBehaviour: u.todayBehaviour, surfaces: u.surfaces || [] } } : p
})

const answers = A.answers || {} // owner's answers to blockingQuestions, threaded to every builder
// The plan's `sharedPiece` line. Without it here the field is one he reads and the
// lane that must honour it never sees — which is the set-but-unread failure, and
// the whole reason the line exists is that shared code otherwise goes to whichever
// lane runs first.
const SHARED_PIECE = String(A.sharedPiece || '').trim()
// The CONTRACT reaches the builder or it was decoration. `whatChanges` names the
// files and the seam; these two name the join, and the join is where a wave split
// across lanes to serve one idea actually breaks.
const describe = (p) =>
  `${p.id} [${p.ref}] ${p.whatChanges}` +
  (p.connection ? `\n  SEAM — what it calls, what calls it, and WHAT IT MUST NOT BYPASS: ${p.connection}` : '') +
  (p.expectation ? `\n  WHAT EVERY OTHER PIECE IS ENTITLED TO ASSUME OF THIS ONE ONCE IT LANDS: ${p.expectation}` : '') +
  // BUILD 2 · the census travels to the lane too — its own files, but the total.
  (p.census ? `\n  CENSUS: ${p.census}` : '') +
  (p.productDecision ? `\n  OWNER DECISION THIS EMBEDS: ${p.productDecision}` : '') +
  (p.charterRule ? `\n  DURABLE RULE: ${p.charterRule}` : '')

const WHERE_NOTE =
  `\n\nSome pieces carry \`_where\` — what the planning pass found this area does TODAY, with file:line. ` +
  `That is a STARTING POINT, not the truth: it was established before this dispatch, another lane may have moved the code since, ` +
  `and the planning pass can be wrong. **Open the file and read it.** Per Shared rule 6, re-derive it from the code before you build on it — ` +
  `if \`_where\` disagrees with what you find, the file wins and say so in your notes. What this saves you is hunting for the location, not verifying it.`

// X168-parity · same fix as bugger.js, same reason: the panel showed a bare
// lane name and nothing else, so a chained wave — here, EITHER a `dependsOn`
// split across build waves or a cross-lane dependency ask — left the owner
// guessing why a lane came back a second time. `dispatchedLanesOnce` makes
// "second dispatch of this lane" checkable instead of inferred from wave or
// dep-round numbering, and it is shared across BOTH loops below because from
// the panel they are the same box: a lane appearing twice in `Build` is a
// dependency round regardless of which of the two mechanisms produced it.
const dispatchedLanesOnce = new Set()
const buildLane = (lane, pcs, roundNote, asBounce) => {
  const isDepRound = !asBounce && dispatchedLanesOnce.has(lane)
  if (!asBounce) dispatchedLanesOnce.add(lane)
  return agent(
    `You are dispatched APPROVED improvement work in your lane. This is a FEATURE wave, not a bug wave — there is no root cause to prove; the owner has decided he wants this.\n\n` +
      `For EACH piece: read the code first, build it within your charter, run \`npm run typecheck\` **ONCE at the END** (not after each edit — every run is a whole turn that re-reads your entire accumulated context, which is what a dispatch actually costs; batch the edits, then check), paper-trace to 100%, and **list every file you edited in \`filesTouched\`** so the verify can tell your change from work already sitting in the tree.` +
        // X73 · a number that bounds a duration is the one change that cannot be
        // settled from the code. Same sentence as bugger.js, same reason: gh#166
        // was "fixed" three times by picking a different number and the path was
        // never timed once.
        `\n\n**IF A PIECE IS A NUMBER THAT BOUNDS A DURATION** — a timeout, a budget, a retry window — your verdict must carry an OBSERVED figure for the path being bounded, or say plainly that the path was never observed. A different number with no measurement behind it is not a fix. If you cannot observe the path, that is \`needs-owner-decision\`.${pcs.some((p) => p._where) ? WHERE_NOTE : ''}\n\n` +
      // The framer authored the contract and is read-only; you implement it. The
      // split is deliberate: it holds no lane's product rules, so the design
      // INSIDE your files is yours and the seam BETWEEN them is not.
      `**A piece may carry a SEAM and an EXPECTATION. Those are the contract and they are binding — the implementation inside the named files is yours to choose under your own charter, the join is not.** "What it must not bypass" is a gate that stays in the path: if your fix would route around it, that is \`needs-owner-decision\`, never a quieter path. And whatever your piece's EXPECTATION promises, another piece is already built against — deliver exactly that, and say so in \`traced\`.\n` +
      (SHARED_PIECE && SHARED_PIECE !== 'none'
        ? `\n**WHO WRITES THE SHARED CODE: ${SHARED_PIECE}.** If that is not you, do not touch that file — return \`needs-dependency\` naming the lane. If it is you, other pieces are waiting on it.\n`
        : '') +
      `Where a piece names an OWNER DECISION, that call is already made — build it, do not re-litigate it. But if building reveals a CORRECTNESS problem with what was decided, say so plainly and return \`needs-owner-decision\` rather than shipping something broken.\n` +
      `Where a piece names a DURABLE RULE, that rule is the owner's product intent — it belongs in your charter. Say in your notes that it should be written there; do not edit charter files yourself.\n` +
      `If a piece needs another lane, return \`needs-dependency\` with the exact contract — do not reach across.${roundNote || ''}\n\n` +
      (Object.keys(answers).length ? `OWNER'S ANSWERS TO THE OPEN QUESTIONS:\n${JSON.stringify(answers, null, 2)}\n\n` : '') +
      `PIECES:\n${pcs.map(describe).join('\n')}\n\nFULL PAYLOAD:\n${JSON.stringify(pcs, null, 2)}`,
    // No `model` here: the tier is on the lane's charter, same as bugger.js.
    // X137-parity · a bounced re-attempt is `rebuild:<lane>(N)` inside THIS
    // SAME Verify phase — bugger.js removed the separate `Bounce` box (X151),
    // so there is no second box to add here either. The prefix, not the
    // phase, is what tells a rebuild apart from a first Build-phase dispatch
    // by the same lane; a bare lane name must never appear under Verify.
    // X168-parity · every other label carries its count, and `·dep` marks any
    // dispatch that is not this lane's first in the run — see the comment
    // above this function.
    {
      label: asBounce ? `rebuild:${lane}(${pcs.length})` : `${lane}(${pcs.length}${isDepRound ? '·dep' : ''})`,
      phase: asBounce ? 'Verify' : lane === 'instructor' ? 'Context' : 'Build',
      agentType: lane,
      effort: EFFORT[lane],
      schema: VERDICTS,
    },
  ).then((r) => (r && r.results) || [])
}

// Dependency-ordered waves. A piece runs only once everything it depends on has
// landed — computed, not assumed, so the plan's own ordering is what executes.
const done = new Set()
const remaining = approved.filter((p) => p.lane !== 'instructor')
let results = []
let wave = 0
let waveCapHit = false

phase('Build')
while (remaining.length && wave < 6) {
  wave += 1
  const ready = remaining.filter((p) => (p.dependsOn || []).every((d) => done.has(d)))
  if (!ready.length) {
    log(`! Wave ${wave}: ${remaining.length} piece(s) have unmet dependencies — a cycle, or a dependsOn id that does not exist. Dispatching them anyway so nothing is silently dropped.`)
    ready.push(...remaining)
  }
  log(`Wave ${wave}: ${ready.length} piece(s) — ${[...new Set(ready.map((p) => p.lane))].join(', ')}`)
  const out = await parallel(
    CODE_LANES.map((lane) => () => {
      const pcs = ready.filter((p) => p.lane === lane)
      return pcs.length ? buildLane(lane, pcs) : null
    }),
  )
  results = results.concat(out.filter(Boolean).flat())
  ready.forEach((p) => {
    done.add(p.id)
    const i = remaining.indexOf(p)
    if (i >= 0) remaining.splice(i, 1)
  })
}
// Silent truncation reads as "we did everything". If the wave cap stopped us
// with pieces still queued, that is a fact the owner has to be told, not a
// number to swallow.
if (remaining.length) {
  waveCapHit = true
  log(`! WAVE CAP: ${remaining.length} approved piece(s) were NEVER DISPATCHED after ${wave} waves — ${remaining.map((p) => p.id).join(', ')}. Re-invoke with just these to finish them.`)
}

// A dependency ask is real work regardless of what the lane concluded about its
// OWN piece. Requiring `needs-dependency` discarded every ask attached to a
// `built` verdict — and "I finished my piece, this adjacent bit is yours" is the
// common case. Six asks were lost that way in bugger.js on 2026-07-26 before
// anyone noticed, because their parents said `built`. Same shape, same fix.
const DISPATCHABLE_DEP = new Set(['built', 'confirmed-other-lane', 'needs-dependency', 'already-fixed'])
// X66 · a dep row is DELIVERED whether the lane built it or confirmed another
// lane had. Without this the new verdict would leave the originator looking
// blocked on a dependency that actually landed.
// X97 · and `already-fixed` is the third way a dependency lands: "the thing you
// asked for is already in the code" satisfies the ask exactly as building it
// would. Same one-token omission as bugger.js, same effect — the originator is
// never resumed and reads blocked for the rest of the run.
const DELIVERED_DEP = new Set(['built', 'confirmed-other-lane', 'already-fixed'])
const hasAsk = (r) => r.dependencyAgent && String(r.dependencyAsk || '').trim().length > 0
// Same set bugger.js keeps under this name — a lane outside it has nowhere to
// bounce to, so the bounce round below routes on it instead of re-deriving the
// inline check the dependency-round filter already uses.
const KNOWN_LANES = new Set([...CODE_LANES, 'instructor'])

// ---- Dependency rounds — the SAME loop bugger.js runs, for the same reasons ---
// This block previously had two bugs that only a real run would have shown, and
// tomorrow was going to be that run:
//
//   1. `satisfied` was computed BEFORE the cross-lane asks were dispatched, so a
//      lane that asked another lane for something never got resumed — the ask was
//      built and the originator was never told, which is the exact hole this code
//      was written to close.
//   2. It ran ONCE, so a chain deeper than one hop died silently. A → B → C lost C.
//
// Now: rounds of [code lanes in parallel → Instructor LAST], where each round's
// asks and newly-satisfied originators become the next round's work, capped, and
// loudly reported if the cap is hit. Ids encode depth: `p1` → `p1>dep` → `p1>dep>dep`.
const MAX_DEP_ROUNDS = 5
const dispatchedDepIds = new Set()
const resumedPieceIds = new Set()
// Every piece ever dispatched, by id. The resume lookup below read `approved`
// alone, which holds only the pieces the owner signed off — so a piece born
// mid-run (an ask that itself raised an ask) fell to the placeholder, got
// `lane: ''`, and was dropped by the round filter without a word. Same defect,
// same fix, as bugger.js: MAX_DEP_ROUNDS=5 exists to allow that depth.
const specById = new Map(approved.map((p) => [p.id, p]))
// Every originator whose dependency landed, accumulated ACROSS rounds. The
// closing warning below read the loop's own block-scoped `satisfied`, which does
// not exist outside it — a ReferenceError thrown after every lane had already
// built, losing the whole run's report while the work sat uncommitted in the
// tree. Same shape as the `resumes` scoping bug fixed on 2026-07-26.
const satisfiedIds = new Set()
let depRounds = 0
let depQueue = approved.filter((p) => p.lane === 'instructor') // context's own pieces seed round 1

for (;;) {
  // (a) asks raised by anything already returned, never dispatched before
  const asks = results
    .filter((r) => hasAsk(r) && DISPATCHABLE_DEP.has(r.verdict) && !dispatchedDepIds.has(`${r.id}>dep`))
    .map((r) => ({ id: `${r.id}>dep`, ref: '', lane: r.dependencyAgent, whatChanges: r.dependencyAsk, whyThisLane: 'raised by another lane', dependsOn: [] }))

  // (b) originators whose dependency has NOW landed — recomputed every round, which
  //     is the fix for bug 1: a dep built this round can resume its originator next.
  const satisfied = new Map()
  for (const r of results) {
    if (DELIVERED_DEP.has(r.verdict) && typeof r.id === 'string' && r.id.endsWith('>dep')) satisfied.set(r.id.slice(0, -'>dep'.length), r)
  }
  satisfied.forEach((_v, k) => satisfiedIds.add(k))
  const resumes = results
    .filter((r) => r.verdict === 'needs-dependency' && satisfied.has(r.id) && !resumedPieceIds.has(r.id))
    .map((r) => {
      const orig = specById.get(r.id) || { id: r.id, lane: '', whatChanges: r.notes || '', ref: '', whyThisLane: '', dependsOn: [] }
      const dep = satisfied.get(r.id)
      resumedPieceIds.add(r.id)
      return { ...orig, _dependencyResolved: { youAsked: r.dependencyAsk || '', theyDelivered: dep.fix || dep.notes || 'see the working tree' } }
    })

  const round = [...depQueue, ...asks, ...resumes].filter((p) => p.lane && (CODE_LANES.includes(p.lane) || p.lane === 'instructor'))
  depQueue = []
  if (!round.length) break
  if (++depRounds > MAX_DEP_ROUNDS) {
    log(`! DEP ROUND CAP: ${round.length} item(s) NOT dispatched after ${MAX_DEP_ROUNDS} rounds — ${round.map((p) => `${p.id}→${p.lane}`).join(', ')}`)
    break
  }
  const resumeNote = resumes.length
    ? `\n\nSome pieces carry \`_dependencyResolved\`: you returned \`needs-dependency\` on them earlier in this run and the lane you named has now delivered. FINISH your own piece. Per Shared rule 6, RE-DERIVE their change from the code before building on it — do not trust the summary.`
    : ''
  log(`Dep round ${depRounds}: ${round.length} item(s) — ${[...new Set(round.map((p) => p.lane))].join(', ')}${resumes.length ? ` (${resumes.length} resumed)` : ''}`)

  // code lanes in parallel, then context LAST within the round
  const codeRound = round.filter((p) => p.lane !== 'instructor')
  if (codeRound.length) {
    phase('Build')
    const out = await parallel(CODE_LANES.map((lane) => () => {
      const pcs = codeRound.filter((p) => p.lane === lane)
      return pcs.length ? buildLane(lane, pcs, resumeNote) : null
    }))
    results = results.concat(out.filter(Boolean).flat())
  }
  const ctxRound = round.filter((p) => p.lane === 'instructor')
  if (ctxRound.length) {
    phase('Context')
    results = results.concat(await buildLane('instructor', ctxRound, resumeNote))
  }
  round.forEach((p) => {
    dispatchedDepIds.add(p.id)
    specById.set(p.id, p)
  })

  // A resumed piece REPLACES its earlier needs-dependency row — same id.
  if (resumes.length) {
    const ids = new Set(resumes.map((p) => p.id))
    const seen = new Set()
    results = results.filter((r) => {
      if (!ids.has(r.id) || r.verdict !== 'needs-dependency') return true
      if (seen.has(r.id)) return true
      seen.add(r.id)
      return false
    })
  }
}

// ONE combined-diff verify — same reasoning as bugger.js: a per-piece pass cannot
// see the only class that needs an bouncer, which is two pieces that are each
// right alone and wrong together. Feature waves are MORE exposed to this than bug
// waves, because the pieces were deliberately split across lanes to serve one idea.
phase('Verify')
let verified = results
let verifiedClean = []
// `agent()` returns null when a subagent dies after its retries, and every read
// of `check` below is null-guarded — so a verify that never happened reported
// identically to one that found nothing. Record what actually came back.
let verifyRan = false
let waveFiles = []
let priorCleanDropped = []
let discoveries = []
let ticketCoverage = []
// X25 · The verify runs LAST, so an ask it raises cannot be dispatched in this run —
// same rule as `discoveries`, and until now the same rule with no destination.
// `dependencyAgent`/`dependencyAsk` are in the verify's schema, so the bouncer can
// fill them, and the only read below took `verdict` and `notes` and nothing else:
// accepted by the schema, dropped in silence. Kept SEPARATE from `discoveries`
// because merging loses which verdict is waiting on the owner.
let deferredDepAsks = []
const built = results.filter((r) => r.verdict === 'built')
// X68 · `already-fixed` closes a piece on the lane's own word and the verify
// payload was `built` only, so that bucket was never checked. Same spot-check
// as bugger.js: one read of the cited code per row, no trace, no budget.
const claimedFixed = results.filter((r) => r.verdict === 'already-fixed')
let spotCheckUnanswered = []
// ── X137-PARITY · THE BOUNCE COUNTER, stolen from bugger.js (X137/X143/X149),
// not reinvented. His ruling, 2026-08-03, is not engine-specific: "we can
// bounce stuff once, not twice." Here an OVERTURN is a piece whose own
// `expectation` was not met — the seam it promised the other pieces — and it
// goes back to the lane that built it ONCE before it reaches the owner. A
// DISCOVERY (something else worth doing, unrelated to this piece's own
// contract) never bounces — see `discoveries` above; that is what stops the
// wave recursing. `bounce` in the manifest is also the ENGINE MARKER for this
// change, same reasoning as bugger.js: a long-lived chat holding the old
// compiled engine cannot emit this key, so its absence means a stale engine,
// never a quiet wave.
const BOUNCE_LIMIT = 1
let bouncedIds = []
let bounceRecheckRan = false
let bounceCleared = []
let bounceStillWrong = []
let bounceAtLimit = []
let bounceUnroutable = []
let bounceDepAsks = []
// `eligible` and `escalated` make a ZERO readable: `bounced:0` alone cannot
// tell "nothing was overturned" from "rows were overturned and none could be
// sent back" — opposite facts. `eligible` is the first pass's overturn count.
let bounceEligible = 0
let bounceEscalated = 0
if ((built.length || claimedFixed.length) && A.verify !== false) {
  const priorClean = Array.isArray(A.priorClean) ? A.priorClean : []
  // Same two mechanisms as bugger.js, same reasoning — the tree holds more than
  // this wave, and a `priorClean` entry describing code this wave changed is a
  // stale "proven clean" that silences a real check.
  waveFiles = [...new Set(built.flatMap((r) => (Array.isArray(r.filesTouched) ? r.filesTouched : [])).filter(Boolean))]
  // X84 · keyed on the entry's INDEX in the array the Manager passed, never on the
  // text echoed back: a trimmed list in came back as trimmed names out, and 10 of 17
  // stale "proven clean" claims survived the drop in silence on wf_4bbfc750-1a9. One
  // silences a future check forever, so the key has to be the one thing the caller
  // cannot reshape.
  const touchedBases = new Set(waveFiles.map((f) => String(f).split('/').pop()).filter(Boolean))
  const dropsAt = (c) => [...touchedBases].some((b) => String(c).includes(b))
  priorCleanDropped = priorClean.map((c, i) => ({ i, entry: c })).filter(({ entry }) => dropsAt(entry))
  const priorCleanKept = priorClean.filter((c) => !dropsAt(c))
  if (priorCleanDropped.length)
    log(
      `priorClean: dropped ${priorCleanDropped.length} of ${priorClean.length} at index ${priorCleanDropped.map((d) => d.i).join(',')} — this wave changed the code they described.`,
    )

  const check = await agent(
    // Bar, standard, seams-first scope, trace sampling, budget,
    // overturn-vs-discovery and the return contract live in
    // `.claude/agents/bouncer.md`. Only the payload and the ONE thing that
    // differs from a bug wave stay here.
    `Verify this FEATURE wave's COMBINED change before the owner wraps it — ${built.length} piece(s). **Your charter holds the bar, the standard, the budget and the return contract.**\n\n` +
      `**One thing differs from a bug wave: also ask whether it DELIVERS WHAT WAS APPROVED.** A feature can be perfectly safe and still not do the thing. Check the built pieces against the intent below, not only against the code. Each piece named its own \`connection\` (what it must not bypass) and \`expectation\` (what the OTHER pieces are entitled to assume of it) at plan time. **A piece whose own \`expectation\` is not met is an OVERTURN** — change its verdict in \`results\` and it goes back to the lane that built it. **Something else worth doing, unrelated to this piece's own contract, is a \`discovery\`** — it never bounces. These pieces were split across lanes to serve ONE idea, so the seams named in \`connection\`/\`expectation\` are where they are most likely to disagree.\n\n` +
      (priorCleanKept.length
        ? `**ALREADY PROVEN by earlier passes — settled, do not re-audit.** Anything an earlier pass proved about code THIS wave changed has already been removed from this list:\n${priorCleanKept.map((c) => `  • ${c}`).join('\n')}\n\n`
        : '') +
      (waveFiles.length
        ? `**THIS WAVE'S FILES. Everything else in the diff is the environment:**\n${waveFiles.map((f) => `  • ${f}`).join('\n')}\n\n`
        : `**No lane reported which files it touched, so the whole diff is in scope.** Say in your return that you could not separate this wave from work already in the tree.\n\n`) +
      `APPROVED INTENT:\n${JSON.stringify(approved.map((p) => ({ id: p.id, whatChanges: p.whatChanges, connection: p.connection, expectation: p.expectation, productDecision: p.productDecision })), null, 2)}\n\n` +
      // X68 · one line, not a second pass.
      (claimedFixed.length
        ? `**SPOT-CHECK — ${claimedFixed.length} piece(s) a lane CLOSED as \`already-fixed\` without building anything.** Nobody has checked these. For each, open the code it names and answer one question: is it actually there at HEAD? **One read each — no trace, no budget.** Return a result per row: \`already-fixed\` if the lane was right, any other verdict if it was not. A row you do not return is reported as still unchecked.\n${JSON.stringify(claimedFixed, null, 2)}\n\n`
        : '') +
      (built.length ? `WHAT WAS BUILT:\n${JSON.stringify(built, null, 2)}` : `**NO PIECE WAS BUILT IN THIS WAVE** — the spot-check above is the whole job.`),
    // No `model` here: `bouncer.md` pins Opus, so neither the session model nor
    // a hand dispatch can downgrade the one agent that must not be downgraded.
    { label: `bouncer:wave(${built.length})`, phase: 'Verify', agentType: 'bouncer', effort: EFFORT.bouncer, schema: VERIFY_OUT },
  )
  verifyRan = !!check
  verifiedClean = (check && check.verifiedClean) || []
  discoveries = (check && check.discoveries) || []
  ticketCoverage = (check && check.ticketCoverage) || []
  if (discoveries.length) log(`Verify found ${discoveries.length} NEW problem(s) unrelated to this wave — reported, NOT built.`)
  ticketCoverage.forEach((t) => log(`  ticket ${t.ref}: ${t.state}${t.state === 'partial' && t.whatIsMissing ? ` — still missing: ${String(t.whatIsMissing).slice(0, 90)}` : ''}`))
  // X25 · Shaped to drop straight into the NEXT run's `args.pieces`, the way
  // `discoveries` drops into `args.issues`. It is deliberately NOT dispatchable
  // now: its parent piece is waiting on the owner, so a well-shaped ask must never
  // be read as an approved one.
  // X25 · REUSES the ask shape the dep loop already builds above, field for field.
  // It emitted `what` where every reader wants `whatChanges` and carried no `ref`,
  // so `describe()` rendered `158>dep [undefined] undefined` — the payload was
  // there and the one line the builder actually reads was empty. `awaitingOwner`
  // travels with the row and is refused at the `pieces` door, same as bugger.js.
  deferredDepAsks = ((check && check.results) || [])
    .filter((x) => x && hasAsk(x))
    .map((x) => ({
      id: `${x.id}>dep`,
      ref: '',
      lane: x.dependencyAgent,
      whatChanges: x.dependencyAsk,
      whyThisLane: 'raised by the wave verify',
      dependsOn: [],
      risk: '',
      from: x.id,
      fromVerdict: x.verdict || 'verify',
      awaitingOwner: true,
      fromVerify: true,
    }))
  if (deferredDepAsks.length)
    log(`Verify raised ${deferredDepAsks.length} dependency ask(s) — NOT dispatched this run (the verify runs last): ${deferredDepAsks.map((a) => `${a.from}→${a.lane}`).join(', ')}`)
  // X68 · keyed on what each row CLAIMED, so a spot-check answering
  // `already-fixed` is not misread as an overturn. Same map as bugger.js.
  const claimed = new Map([...built.map((r) => [r.id, 'built']), ...claimedFixed.map((r) => [r.id, 'already-fixed'])])
  const answered = new Set(((check && check.results) || []).map((x) => x && x.id))
  spotCheckUnanswered = claimedFixed.filter((r) => !answered.has(r.id)).map((r) => r.id)
  const overturned = new Map(
    ((check && check.results) || []).filter((x) => x.verdict && claimed.has(x.id) && x.verdict !== claimed.get(x.id)).map((x) => [x.id, x.notes || '']),
  )

  // ── X137-PARITY · ONE BOUNCE, THEN HIS DESK ──────────────────────────────
  // Same shape as bugger.js: ONE round, flat — an ask raised in here is
  // reported, never dispatched, so it cannot re-enter the build-time
  // dependency loop above and multiply with MAX_DEP_ROUNDS. THE RE-CHECK IS
  // MANDATORY AND FAILS CLOSED: a bounce nobody verifies is worse than none,
  // because the wave would then claim a fix that was never re-examined.
  const laneOf = (id) => (specById.get(id) || {}).lane || ''
  const bounceOf = (id) => Number((specById.get(id) || {}).bounces || 0)
  let finalOverturn = new Map(overturned)
  bounceEligible = overturned.size
  bounceAtLimit = [...overturned.keys()].filter((id) => bounceOf(id) >= BOUNCE_LIMIT)
  bouncedIds = [...overturned.keys()].filter((id) => bounceOf(id) < BOUNCE_LIMIT && KNOWN_LANES.has(laneOf(id)))
  bounceUnroutable = [...overturned.keys()].filter((id) => bounceOf(id) < BOUNCE_LIMIT && !KNOWN_LANES.has(laneOf(id)))
  if (bounceAtLimit.length)
    log(`  NOT bounced — already at the ${BOUNCE_LIMIT}-bounce limit, straight to the owner with both attempts: ${bounceAtLimit.join(', ')}`)
  if (bounceUnroutable.length) log(`  NOT bounced — no resolvable lane, straight to the owner: ${bounceUnroutable.join(', ')}`)
  if (bouncedIds.length) {
    const bounceItems = bouncedIds.map((id) => ({
      ...(specById.get(id) || {}),
      id,
      lane: laneOf(id),
      bounces: bounceOf(id) + 1,
      _bouncedBack: {
        youClaimed: claimed.get(id),
        theBouncerRefused: overturned.get(id) || '(no note returned)',
        thisIsAttempt: bounceOf(id) + 2,
        andItIsTheLast: `Your work is already in the tree — read your own diff first, then fix what the bouncer named. If you believe the bouncer is wrong, say so in \`notes\` and return your evidence: that is a legitimate answer and it goes to the owner. Do NOT rebuild from scratch, and do NOT widen the scope. This piece cannot be sent back again — a second refusal goes to the owner, not to a third attempt.`,
      },
    }))
    bounceItems.forEach((p) => specById.set(p.id, p))
    log(`Bounce: ${bounceItems.length} overturned piece(s) go back ONCE — ${bounceItems.map((p) => `${p.id}→${p.lane}`).join(', ')}.`)
    const bounceOut = await parallel(
      [...new Set(bounceItems.map((p) => p.lane))].map((lane) => () => buildLane(lane, bounceItems.filter((p) => p.lane === lane), '', true)),
    )
    const rebuilt = bounceOut.flat().filter((r) => r && bouncedIds.includes(r.id))
    const rebuiltIds = new Set(rebuilt.map((r) => r.id))
    if (rebuiltIds.size) results = results.filter((r) => !rebuiltIds.has(r.id)).concat(rebuilt)
    const silent = bouncedIds.filter((id) => !rebuiltIds.has(id))
    if (silent.length) log(`! ${silent.length} bounced piece(s) returned NOTHING from their lane: ${silent.join(', ')}. They keep the first overturn and go to the owner.`)

    // Asks raised during the bounce. This round does not chain, so a
    // dispatchable ask here has nowhere else to land — folded into
    // `deferredDepAsks` below, same complement bugger.js keeps.
    bounceDepAsks = rebuilt
      .filter((r) => hasAsk(r) && DISPATCHABLE_DEP.has(r.verdict))
      .map((r) => ({
        id: `${r.id}>dep`,
        ref: '',
        lane: r.dependencyAgent,
        whatChanges: r.dependencyAsk,
        whyThisLane: 'raised during the bounce round',
        dependsOn: [],
        risk: '',
        from: r.id,
        fromVerdict: r.verdict,
        awaitingOwner: true,
        fromBounce: true,
      }))

    // X149-PARITY · a pending dep-ask on a lane ALSO bounced this round may be
    // satisfied by that same rebuild — the only case where the bouncer is
    // already looking at the right files. Scoped exactly as bugger.js scopes it.
    const bouncedLanes = new Set(bounceItems.map((p) => p.lane))
    const askedDuringBounce = deferredDepAsks.filter((a) => bouncedLanes.has(a.lane))

    // ── THE RE-CHECK — the bounced pieces ONLY, never the whole wave again ──
    const rebuiltClaim = new Map(rebuilt.filter((r) => r.verdict === 'built' || r.verdict === 'already-fixed').map((r) => [r.id, r.verdict]))
    const recheck = rebuilt.length
      ? await agent(
          `**RE-CHECK — second and FINAL pass over ${rebuilt.length} piece(s) you already overturned once.** Your charter holds the bar and the return contract; this is the same job, narrowed.\n\n` +
            `**Scope is these pieces and nothing else.** Do not re-read the rest of the wave — you passed it moments ago and it has not moved. Do not open new questions on it, and do not raise standards findings outside these files: anything else you notice is a \`discovery\`, which never bounces and never blocks.\n\n` +
            `For each piece: **what you refused is quoted on it.** Answer the one question — is its own \`expectation\` met now? Trace from the seam, exactly as before. \`built\` if it holds; any other verdict if it does not, and say plainly what is still wrong.\n\n` +
            `**THERE IS NO THIRD ATTEMPT.** A piece you refuse here goes to the owner carrying both attempts and both of your notes. So refuse it if it is wrong — that is the correct outcome and it costs one decision, not another round — but do not refuse it for something you did not raise the first time.\n\n` +
            (waveFiles.length ? `**THIS WAVE'S FILES:**\n${waveFiles.map((f) => `  • ${f}`).join('\n')}\n\n` : '') +
            (askedDuringBounce.length
              ? `**ALSO ANSWER — ${askedDuringBounce.length} pending dependency ask(s) on a lane you are rebuilding this round.** Each was raised by the wave check above and is still unresolved on the owner's desk. You are already re-reading this lane's files for the rebuild above — check whether that SAME rebuild happens to also satisfy it. Return one \`results\` entry per id below: \`verdict:"already-fixed"\` if it is now closed, or \`verdict:"needs-dependency"\` (unchanged) if it is not. Do not build anything new for these — only answer whether they are already closed:\n${askedDuringBounce.map((a) => `  • ${a.id} → ${a.lane}: ${a.whatChanges}`).join('\n')}\n\n`
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
    // A discovery raised by the re-check is next run's intake like any other —
    // it NEVER bounces.
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
        deferredDepAsks = deferredDepAsks.filter((a) => !resolvedIds.has(a.id))
      }
    }
    const answeredAgain = new Set(recheckResults.map((x) => x.id))
    for (const id of bouncedIds) {
      const first = overturned.get(id) || ''
      if (!rebuiltIds.has(id)) continue // lane returned nothing — keeps its first overturn
      if (!bounceRecheckRan)
        finalOverturn.set(id, `${first} [BOUNCED ONCE; THE RE-CHECK DIED, so the second attempt is UNVERIFIED — do not read this as fixed]`)
      else if (!answeredAgain.has(id))
        finalOverturn.set(id, `${first} [BOUNCED ONCE; the re-check returned no verdict for this piece, so the second attempt is UNCHECKED]`)
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
        bounceRecheckRan ? '' : ' (THE RE-CHECK DID NOT RUN — every bounced piece is unverified)'
      }.`,
    )
  }
  // Every overturn still standing after the bounce and the re-check: what he
  // actually has to rule on. `finalOverturn`, not `overturned` — a piece the
  // bounce round fixed and the re-check confirmed is `built` and must not
  // reach his desk.
  bounceEscalated = finalOverturn.size
  deferredDepAsks = deferredDepAsks.concat(bounceDepAsks)
  verified = results.map((r) => {
    const b = Number((specById.get(r.id) || {}).bounces || 0)
    const row = b ? { ...r, bounces: b } : r
    return finalOverturn.has(r.id)
      ? { ...row, verdict: 'needs-owner-decision', notes: `${r.notes || ''} [wave-verify overturned: ${finalOverturn.get(r.id)}]`.trim() }
      : row
  })
}

// Charter rules the wave earned — surfaced, never written by an agent. The owner
// decides what becomes a permanent rule; this only makes sure none is lost.
const earnedRules = approved.filter((p) => p.charterRule).map((p) => ({ lane: p.lane, rule: p.charterRule, from: p.id }))

// Same reasoning as bugger.js: a step that quietly did nothing must show up as a
// number that is obviously wrong, not as a successful-looking run.
// X31 · THE DECISION BUDGET, the same one bugger.js carries and for the same
// reason: `capBuilds` caps builds and nothing capped DECISIONS, yet decisions are
// the only step that cannot be parallelised, batched or delegated. Measured
// refs-on-his-desk per engine run across the window: 4, 3, 8, 1, 4, 12, then 25 —
// and the 25 is the night he said he could not follow it. Default 12 is the
// highest any run reached on a night that worked, so it fires on 25 and on nothing
// that has ever been fine. It WARNS and proposes a deferral; it never truncates
// and never merges. `discoveries` is deliberately excluded — since X30 they are
// the next run's intake, not a row on his desk.
const DECISION_BUDGET = typeof A.capDecisions === 'number' ? A.capDecisions : 12
const onHisDesk =
  verified.filter((r) => r.verdict !== 'built' && r.verdict !== 'already-fixed' && r.verdict !== 'confirmed-other-lane').length +
  deferredDepAsks.length +
  remaining.length +
  earnedRules.length +
  ticketCoverage.filter((t) => t.state !== 'satisfied').length
const featureManifest = {
  approved: approved.length,
  decisions: { onHisDesk, budget: DECISION_BUDGET, overBudget: Math.max(0, onHisDesk - DECISION_BUDGET) },
  reconThreaded: approved.filter((p) => p._where).length,
  wavesRun: wave,
  // `neverDispatched` lives in `counts` ONLY, as a number. It was here as an id LIST
  // under the same name — one word meaning two shapes in one return object, which is
  // how a reader ends up doing arithmetic on an array. The ids are not lost: the
  // warning below prints every one of them, and it fires on exactly this condition
  // (`waveCapHit` is set true iff `remaining.length`, in the same block).
  crossLaneAsks: { attached: results.filter((r) => hasAsk(r)).length, dispatched: results.filter((r) => String(r.id).endsWith('>dep')).length },
  resumed: resumedPieceIds.size,
  depRounds,
  earnedRules: earnedRules.length,
  // X22 · the writer's own observable, same shape as bugger.js. No warning on a
  // zero: a wave of genuinely local work is meant to tag none.
  invariants: { tagged: verified.filter((r) => r.invariant).length, of: verified.length, slugs: [...new Set(verified.map((r) => r.invariant).filter(Boolean))] },
  verify:
    A.verify === false
      ? { ran: false, fixesToCheck: 0 }
      : {
          ran: verifyRan,
          fixesToCheck: built.length,
          waveFilesNamed: waveFiles.length, // 0 with pieces built = the verify could not tell this wave from the rest of the tree
          priorCleanDropped: priorCleanDropped.length,
          discoveries: discoveries.length, // NEW problems, deliberately not built this wave
          ticketsTouched: ticketCoverage.length, // open issues this wave satisfied, partly satisfied or contradicted
          overturned: results.filter((r, i) => verified[i] && r.verdict !== verified[i].verdict).length,
          verifiedCleanReturned: verifiedClean.length,
        },
  // X137-PARITY · same shape as bugger.js's `manifest.bounce`, ALWAYS an
  // object with explicit zeros — never omitted. `eligible` beside `bounced`
  // is what makes a zero readable: `eligible:0 bounced:0` is healthy silence,
  // `eligible:3 bounced:0` is a defect. This block's presence is also the
  // engine marker for this change — an old compiled copy of this file cannot
  // emit it, so absent means a stale engine, never a quiet wave.
  bounce: {
    verifyOff: A.verify === false,
    limit: BOUNCE_LIMIT,
    eligible: bounceEligible,
    bounced: bouncedIds.length,
    refs: bouncedIds,
    recheckRan: bounceRecheckRan,
    cleared: bounceCleared.length,
    clearedRefs: bounceCleared,
    toOwner: bounceStillWrong.length,
    toOwnerRefs: bounceStillWrong,
    notBouncedAtLimit: bounceAtLimit.length,
    notBouncedAtLimitRefs: bounceAtLimit,
    unroutable: bounceUnroutable.length,
    unroutableRefs: bounceUnroutable,
    escalated: bounceEscalated,
    depAsksRaised: bounceDepAsks.length, // reported, never dispatched — the round does not chain
  },
}
const featureWarnings = []
if (waveCapHit) featureWarnings.push(`WAVE CAP HIT — ${remaining.length} approved piece(s) never dispatched: ${remaining.map((p) => p.id).join(', ')}. They are NOT built.`)
if (recon.length === 0) featureWarnings.push('`recon` was not passed back from the plan run, so every builder re-derived what its area does today. Pass it next time.')
// The join is by `ref`. "Passed but nothing matched" used to be indistinguishable
// from "worked" — reconThreaded read 0 with no warning while every builder silently
// re-derived its area. Absent and non-joining are different failures; say which.
else if (!featureManifest.reconThreaded && approved.length)
  featureWarnings.push(
    `\`recon\` carried ${recon.length} entr${recon.length === 1 ? 'y' : 'ies'} but NONE joined an approved piece — so plan and build disagree on \`ref\`, and every builder re-derived its area anyway. Check the refs match exactly.`
  )
if (deferredDepAsks.length)
  featureWarnings.push(
    `The verify raised ${deferredDepAsks.length} dependency ask(s) that this run CANNOT dispatch — it runs last. They are in \`deferredDepAsks\`, pre-shaped for the next run's \`args.pieces\`: ${deferredDepAsks.map((a) => `${a.from}→${a.lane}`).join(', ')}. Report each as a row awaiting the owner; a wrap that drops them loses a named incomplete fix.`
  )
if (built.length && A.verify === false) featureWarnings.push('Verify was disabled on a run that built code.')
if (built.length && A.verify !== false && !verifyRan)
  featureWarnings.push(`THE VERIFY DID NOT RUN — ${built.length} built piece(s) are unchecked. Do NOT wrap without \`/manager verify\`.`)
if (results.some((r) => r.verdict === 'needs-dependency' && !satisfiedIds.has(r.id)))
  featureWarnings.push('A piece is still blocked on a dependency that never landed — it is unfinished, not built.')
if (onHisDesk > DECISION_BUDGET)
  featureWarnings.push(
    `DECISION BUDGET EXCEEDED — ${onHisDesk} refs need the owner against a budget of ${DECISION_BUDGET}. Prior runs put 1 to 12 on his desk; 25 is the night he could not follow. ` +
      `Nothing has been truncated. Propose DEFERRING the lowest-value rows to the next run and say which — never merge two rows to get under the number.`
  )
// X68 · a piece closed on a lane's own word that the verify never answered on is
// CLOSED AND UNCHECKED.
if (spotCheckUnanswered.length)
  featureWarnings.push(
    `${spotCheckUnanswered.length} \`already-fixed\` row(s) were sent for spot-check and came back with NO answer: ${spotCheckUnanswered.join(', ')}. Do not wrap them as verified.`,
  )
// X65 · the currency gate on a discovery, same as bugger.js.
if (discoveries.filter((d) => !/:\d+/.test(String(d.evidence || ''))).length)
  featureWarnings.push(
    `${discoveries.filter((d) => !/:\d+/.test(String(d.evidence || ''))).length} of ${discoveries.length} discovery(ies) cite no \`file:line\` at HEAD. A log line shows the symptom happened, not that the code is still wrong — do NOT carry them into the next run's intake without opening the file first.`,
  )
// X137-PARITY · same three bounce warnings bugger.js carries, for the same
// reasons — a re-check that died is the `verify.ran` failure one level in, and
// the partition assertion makes a silent drop arithmetically impossible to hide.
if (bouncedIds.length && !bounceRecheckRan)
  featureWarnings.push(
    `THE BOUNCE RE-CHECK DID NOT RUN — ${bouncedIds.length} piece(s) went back to their lane and NOTHING re-examined the second attempt: ${bouncedIds.join(', ')}. They are on your desk marked unverified. Do not wrap on this; run \`/manager verify\` by hand.`,
  )
if (bounceAtLimit.length)
  featureWarnings.push(
    `${bounceAtLimit.length} piece(s) were overturned having ALREADY used their one bounce, so they went straight to you with both attempts on them: ${bounceAtLimit.join(', ')}. Two failures on one item is a signal — read the item, not the diff.`,
  )
if (bounceEligible !== bouncedIds.length + bounceAtLimit.length + bounceUnroutable.length)
  featureWarnings.push(
    `BOUNCE ACCOUNTING IS WRONG — ${bounceEligible} overturn(s) were eligible but only ${
      bouncedIds.length + bounceAtLimit.length + bounceUnroutable.length
    } are accounted for (${bouncedIds.length} bounced · ${bounceAtLimit.length} at the limit · ${bounceUnroutable.length} with no lane). An overturn has gone somewhere this manifest does not name.`,
  )
featureWarnings.forEach((w) => log(`! ${w}`))

return {
  mode: 'build',
  manifest: featureManifest,
  warnings: featureWarnings,
  // X24 · The funnel, same reasoning as bugger.js: a run that dispatched nothing
  // must not read like a run that built nothing. `neverDispatched` was in the
  // manifest as a list and in no count.
  counts: {
    approved: approved.length,
    dispatched: approved.length - remaining.length,
    built: verified.filter((r) => r.verdict === 'built').length,
    // X66 · a piece another lane delivered. NOT added to `built` — one change
    // counted twice is what the Manager was correcting by hand in state.json.
    confirmedOtherLane: verified.filter((r) => r.verdict === 'confirmed-other-lane').length,
    // `already-fixed` is in the verdict enum, so a lane can and does return it —
    // and it landed in NO bucket here, which is the one drop a funnel exists to
    // name. It also costs a full dispatch, so a non-zero here is a signal in
    // itself: the plan asked for something that was already in the tree.
    alreadyFixed: verified.filter((r) => r.verdict === 'already-fixed').length,
    needsOwner: verified.filter((r) => r.verdict === 'needs-owner-decision' || r.verdict === 'blocked-charter').length,
    stillBlocked: verified.filter((r) => r.verdict === 'needs-dependency').length,
    neverDispatched: remaining.length,
  },
  results: verified,
  earnedRules,
  verifiedClean, // persist under "Verified clean" in report.md; pass back as `priorClean` next run
  priorCleanDropped, // X84 · `[{i, entry}]`. **DELETE BY `i`** — the index in the array you passed as `priorClean`; `entry` is the text as received, for reading only. Match on the text and a list you trimmed on the way in drops nothing. `state.verifiedClean` ends exactly this many entries shorter
  discoveries, // X30 · NEW problems unrelated to these pieces. NEXT RUN'S INTAKE, not rows on his desk — already lane-assigned and severity-ranked for `args.issues`. Never built this wave, and never softened: a `high` one arrives first in the next queue
  deferredDepAsks, // X25 · asks the VERIFY raised. Pre-shaped for the next run's `args.pieces` — paste them, do not recompose. NOT approved: each parent is waiting on the owner
  ticketCoverage, // open issues this wave landed on unasked — `satisfied` closes at the wrap, `partial` can go back to the lane for the remainder, `contradicted` is a decision about to be made by accident
  note: 'Uncommitted in the working tree. The owner wraps.',
}
