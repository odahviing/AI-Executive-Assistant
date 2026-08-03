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
const REFS = Array.isArray(A.refs) ? A.refs : null // explicit issue numbers, skips the label query
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
const EFFORT = { matchmaker: 'xhigh', instructor: 'xhigh', slackmaster: 'high', diplomat: 'high', registrar: 'xhigh', handyman: 'high', profiler: 'high', gatekeeper: 'high', usher: 'xhigh', framer: 'xhigh', bouncer: 'xhigh' }
// X124 · Fail at LOAD, not mid-run. A half-finished rename — a lane changed in
// CODE_LANES and missed here — otherwise dispatches with `effort: undefined` to
// an agentType that does not exist, and reads as a perfectly normal run.
// charter-audit.js:16-17 has had this guard since it was written; the two
// engines that actually BUILD did not.
// `framer` and not `usher`: this engine's three intake/plan dispatches are the
// FEATURE door. bugger.js's list names `usher` instead, which is the only
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
  },
  required: ['ref', 'todayBehaviour', 'wantedBehaviour', 'gap', 'alreadyExists', 'openQuestions'],
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
          whatChanges: {
            type: 'string',
            description:
              'concrete and DETAILED — the file(s), what the code will do differently, and what a person would see change. Name what it REUSES and cite file:line where you have it; "reuses X" is the most valuable thing in this field.',
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
        },
        required: ['id', 'ref', 'lane', 'requirement', 'whatChanges', 'whyThisLane', 'dependsOn', 'risk'],
      },
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
  required: ['pieces', 'blockingQuestions'],
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
      // X126 · The FEATURE door is the `framer`, not the usher. Both read a
      // backlog, but the bug usher's charter is defect-shaped end to end — a
      // very hard "obvious defect" bar, one-root-one-issue, and "a product
      // decision means do not dispatch" — and every one of those is wrong here.
      // Effort and model stay as tuned: one shell command does not need more.
      { label: 'intake:backlog', phase: 'Intake', agentType: 'framer', effort: 'low', model: 'haiku', schema: RAW },
    )
    items = (raw && raw.items) || []
    log(`Intake: ${items.length} open item(s)${PRIORITY ? ` at ${PRIORITY}` : ''}.`)
  }
  if (!items.length) return { mode: 'plan', items: [], pieces: [], blockingQuestions: [], note: 'Nothing open.' }
  items.forEach((i) => log(`  • ${i.ref} [${i.priority || '?'}] ${(i.title || '').slice(0, 80)}`))

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
          { label: `recon:${it.ref}`, phase: 'Recon', agentType: 'framer', effort: 'high', model: 'opus', schema: UNDERSTOOD },
        ),
      ),
    )
  ).filter(Boolean)

  const stale = recon.filter((u) => u.alreadyExists)
  const live = recon.filter((u) => !u.alreadyExists)
  if (stale.length) log(`${stale.length} already built — stale issue(s): ${stale.map((s) => s.ref).join(', ')}`)

  // Decompose — one pass over ALL of them together, because the cross-improvement
  // view is the whole point: two improvements often want the same seam moved once.
  phase('Decompose')
  const plan = await agent(
    `Decompose these recon findings into per-lane pieces the owner can approve one by one.\n\n` +
      `LANES: ${LANE_MAP}\n\n` +
      `Rules that differ from bug triage — read these, they are the reason this is not the bugger loop:\n` +
      `• Split by CAPABILITY and SURFACE, not by root cause. One improvement legitimately landing in three lanes is normal and is NOT a merge candidate.\n` +
      `• Do the opposite too: where two improvements want the SAME seam moved, say so and emit ONE piece. That cross-view is why this is a single pass.\n` +
      `• **Every piece names its \`requirement\` — the product outcome it buys, in one line, from the point of view of whoever benefits.** This is the column the owner rules on. A piece described only as a mechanism is unrulable: he can tell you whether the code sounds right, but not whether he WANTS it. If you cannot state the requirement without restating the mechanism, the piece is not understood yet.\n` +
      `• **Every piece names its \`risk\`** — what could go wrong, what is unresolved, what he should eyeball before it ships. Never blank; "None" is a claim worth making, and a piece with no risk named reads as unexamined.\n` +
      `• \`whatChanges\` is DETAILED: the file(s), what the code will do differently, what a person would see change, and above all **what it REUSES** with a \`file:line\`. "Reuses X byte-for-byte" is worth more than any other sentence in that field.\n` +
      `• Every piece names the \`productDecision\` it embeds, or empty if genuinely mechanical. If you cannot name the decision, you have not understood the piece.\n` +
      `• Where a decision should outlive this wave, write it as a \`charterRule\`. **A bug never earns a charter rule — an improvement often should.** This is the only flow that produces them, so do not skip it.\n` +
      `• \`dependsOn\` is real ordering, not preference. \`context\` always lands last.\n` +
      `• \`blockingQuestions\` are things that must be settled BEFORE building. Do NOT guess to keep the list short — a guess here becomes built code the owner never chose.\n` +
      `• If a piece is not worth its cost, put it in \`notWorthBuilding\` with the reason. Declining is a result.\n\n` +
      `UNDERSTOOD:\n${JSON.stringify(live, null, 2)}`,
    // X126 · agentType framer — every bullet below is now one of its rules
    // (F5-F10), so the engine states the schema and the charter states the
    // standing duty. Effort stays xhigh; no model pin, so the tier comes from
    // the charter, which is where spend.cjs:293 says it belongs.
    { label: 'decompose', phase: 'Decompose', agentType: 'framer', effort: 'xhigh', schema: PLAN },
  )

  const pieces = (plan && plan.pieces) || []
  log(`Plan: ${pieces.length} piece(s) across ${new Set(pieces.map((p) => p.lane)).size} lane(s); ${((plan && plan.blockingQuestions) || []).length} blocking question(s).`)

  // Deliberately returns WITHOUT building. The owner approves in chat, then the
  // Manager re-invokes with {mode:'build', pieces:[approved]}.
  return {
    mode: 'plan',
    items,
    stale,
    recon: live,
    pieces,
    blockingQuestions: (plan && plan.blockingQuestions) || [],
    notWorthBuilding: (plan && plan.notWorthBuilding) || [],
    // Described items have no GitHub issue yet, and the Manager has to file one
    // ON APPROVAL — before the build, so the ledger row and the wrap have a real
    // `gh#N` to key on. Not before the plan: he may read the cost and decline,
    // and a ticket for a rejected idea is litter.
    needsTicket: DESCRIBED ? items.map((i) => ({ placeholderRef: i.ref, title: i.title, asks: i.asks, priority: i.priority })) : [],
    next:
      (DESCRIBED
        ? 'THESE ARE NOT ON GITHUB YET. If the owner approves, FILE the issue first (see `needsTicket`) — title from the item, body carrying his own words plus the decomposition below, labelled `Improvement`+priority or `Feature`+horizon — then replace the `new-N` placeholder ref on each piece with the real `gh#N` before building, so the ledger and the wrap have something to key on. If he declines, file nothing. Then: '
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
const describe = (p) =>
  `${p.id} [${p.ref}] ${p.whatChanges}` +
  (p.productDecision ? `\n  OWNER DECISION THIS EMBEDS: ${p.productDecision}` : '') +
  (p.charterRule ? `\n  DURABLE RULE: ${p.charterRule}` : '')

const WHERE_NOTE =
  `\n\nSome pieces carry \`_where\` — what the planning pass found this area does TODAY, with file:line. ` +
  `That is a STARTING POINT, not the truth: it was established before this dispatch, another lane may have moved the code since, ` +
  `and the planning pass can be wrong. **Open the file and read it.** Per Shared rule 6, re-derive it from the code before you build on it — ` +
  `if \`_where\` disagrees with what you find, the file wins and say so in your notes. What this saves you is hunting for the location, not verifying it.`

const buildLane = (lane, pcs, roundNote) =>
  agent(
    `You are dispatched APPROVED improvement work in your lane. This is a FEATURE wave, not a bug wave — there is no root cause to prove; the owner has decided he wants this.\n\n` +
      `For EACH piece: read the code first, build it within your charter, run \`npm run typecheck\` **ONCE at the END** (not after each edit — every run is a whole turn that re-reads your entire accumulated context, which is what a dispatch actually costs; batch the edits, then check), paper-trace to 100%, and **list every file you edited in \`filesTouched\`** so the verify can tell your change from work already sitting in the tree.` +
        // X73 · a number that bounds a duration is the one change that cannot be
        // settled from the code. Same sentence as bugger.js, same reason: gh#166
        // was "fixed" three times by picking a different number and the path was
        // never timed once.
        `\n\n**IF A PIECE IS A NUMBER THAT BOUNDS A DURATION** — a timeout, a budget, a retry window — your verdict must carry an OBSERVED figure for the path being bounded, or say plainly that the path was never observed. A different number with no measurement behind it is not a fix. If you cannot observe the path, that is \`needs-owner-decision\`.${pcs.some((p) => p._where) ? WHERE_NOTE : ''}\n\n` +
      `Where a piece names an OWNER DECISION, that call is already made — build it, do not re-litigate it. But if building reveals a CORRECTNESS problem with what was decided, say so plainly and return \`needs-owner-decision\` rather than shipping something broken.\n` +
      `Where a piece names a DURABLE RULE, that rule is the owner's product intent — it belongs in your charter. Say in your notes that it should be written there; do not edit charter files yourself.\n` +
      `If a piece needs another lane, return \`needs-dependency\` with the exact contract — do not reach across.${roundNote || ''}\n\n` +
      (Object.keys(answers).length ? `OWNER'S ANSWERS TO THE OPEN QUESTIONS:\n${JSON.stringify(answers, null, 2)}\n\n` : '') +
      `PIECES:\n${pcs.map(describe).join('\n')}\n\nFULL PAYLOAD:\n${JSON.stringify(pcs, null, 2)}`,
    // No `model` here: the tier is on the lane's charter, same as bugger.js.
    { label: `build:${lane}`, phase: lane === 'instructor' ? 'Context' : 'Build', agentType: lane, effort: EFFORT[lane], schema: VERDICTS },
  ).then((r) => (r && r.results) || [])

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
      `**One thing differs from a bug wave: also ask whether it DELIVERS WHAT WAS APPROVED.** A feature can be perfectly safe and still not do the thing. Check the built pieces against the intent below, not only against the code. And these pieces were split across lanes to serve ONE idea, so the joins are where they are most likely to disagree.\n\n` +
      (priorCleanKept.length
        ? `**ALREADY PROVEN by earlier passes — settled, do not re-audit.** Anything an earlier pass proved about code THIS wave changed has already been removed from this list:\n${priorCleanKept.map((c) => `  • ${c}`).join('\n')}\n\n`
        : '') +
      (waveFiles.length
        ? `**THIS WAVE'S FILES. Everything else in the diff is the environment:**\n${waveFiles.map((f) => `  • ${f}`).join('\n')}\n\n`
        : `**No lane reported which files it touched, so the whole diff is in scope.** Say in your return that you could not separate this wave from work already in the tree.\n\n`) +
      `APPROVED INTENT:\n${JSON.stringify(approved.map((p) => ({ id: p.id, whatChanges: p.whatChanges, productDecision: p.productDecision })), null, 2)}\n\n` +
      // X68 · one line, not a second pass.
      (claimedFixed.length
        ? `**SPOT-CHECK — ${claimedFixed.length} piece(s) a lane CLOSED as \`already-fixed\` without building anything.** Nobody has checked these. For each, open the code it names and answer one question: is it actually there at HEAD? **One read each — no trace, no budget.** Return a result per row: \`already-fixed\` if the lane was right, any other verdict if it was not. A row you do not return is reported as still unchecked.\n${JSON.stringify(claimedFixed, null, 2)}\n\n`
        : '') +
      (built.length ? `WHAT WAS BUILT:\n${JSON.stringify(built, null, 2)}` : `**NO PIECE WAS BUILT IN THIS WAVE** — the spot-check above is the whole job.`),
    // No `model` here: `bouncer.md` pins Opus, so neither the session model nor
    // a hand dispatch can downgrade the one agent that must not be downgraded.
    { label: `verify:wave(${built.length})`, phase: 'Verify', agentType: 'bouncer', effort: EFFORT.bouncer, schema: VERIFY_OUT },
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
  verified = results.map((r) =>
    overturned.has(r.id) ? { ...r, verdict: 'needs-owner-decision', notes: `${r.notes || ''} [wave-verify overturned: ${overturned.get(r.id)}]`.trim() } : r,
  )
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
