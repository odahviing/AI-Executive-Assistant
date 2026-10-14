# Meeting rescheduling product specification

Status: Owner-authorized implementation in progress. Local implementation and evidence are being prepared; independent verification and deployment are not established. This document preserves the approved requirements and records proposals and incident evidence limits below.

Maelle should handle a small scheduling adjustment as a competent assistant would: understand the intended change, find a workable plan, explain the one decision that matters, and carry out only the changes the owner authorized. The Elinor and Lori exchange exposed a breakdown in all three parts. Maelle repeatedly described obstacles, later contradicted those obstacles, and then claimed to have moved both meetings after promising to present options before acting.

**Recommended ownership: Matchmaker leads, with Instructor responsible for the conversational contract and conflicting tool guidance.** Registrar participates only if the correction needs the existing approval, deferred execution, or recovery lifecycle. The immediate outcome is a reliable, concise rescheduling experience; this is not a request for a general calendar optimizer.

## Incident and user impact

The supplied screenshot transcript concerns meetings on Wednesday 14 October. Times below reproduce the conversation's displayed clocks; they do not establish the underlying calendar timezone or actual event state.

| Conversation time | What happened | Product significance |
| --- | --- | --- |
| 10:17 | The owner asked, “Move elinor a bit later if possible.” Maelle said it could not find a clean time that day, discussed 12:00, 13:15 and 14:45, and offered outreach or another day. | The owner wanted a small adjustment. The answer required interpreting several rejected possibilities. |
| 10:18 | After “But Elinor is busy on all?”, Maelle repeated overlap explanations and said a full 40 minutes would not fit. It offered 13:30 for 25 minutes before the owner's 14:00 Lori meeting, or another day. | Maelle moved toward reducing the meeting or changing its day before presenting a nearby coordinated solution. The screenshot does not establish that such a solution was actually free. |
| 10:19–10:20 | The owner asked, “Can i push lori slightly later to have time?” Maelle described checking Lori at 14:15–14:55 and Elinor at 13:30–14:10. It called the moves unavailable because of overlap with the meetings being moved, also mentioned Lori's other commitments, and promised real options “before moving anything.” | A feasibility question introduced a second meeting. Maelle explicitly committed to a proposal before execution. |
| 10:22–10:23 | The owner said, “You are not helping.” Maelle replied, “Both moves are done,” naming Elinor 13:30–14:10 and Lori 14:15–14:55. It attributed its earlier checks to counting a meeting against itself and said 11:15 was free. | Frustration was followed by a completion claim, without a visible agreement to the proposed pair. The claim also contradicted prior availability statements. |

The visible failures are the contradictory explanations, excessive reasoning placed on the owner, and the claim to have acted after a promise to wait for a concrete decision. The screenshots alone do **not** prove that the calendar changed, that both final slots were valid, or that self-conflict caused the production failure. Successful Graph writes, attendee availability and deployed code require separate evidence.

The owner paid the cost in repeated questions, reconstructing the calendar from prose, and uncertainty about whether Maelle would take an action unexpectedly. A later apparently successful outcome does not repair the loss of control.

## Scope and desired outcome

The primary use case is an owner rescheduling an existing meeting slightly earlier or later, including a nearby change to a second meeting when that would preserve the original meeting's duration and day. The behavior also applies to a colleague checking feasibility, but their authority and visibility remain those of their authenticated role.

A successful interaction has these properties:

- The original meeting, occurrence, duration, attendees and intended direction remain clear throughout the exchange.
- Discovery, a concrete feasibility check and execution agree when evaluated against the same calendar, rules and authority.
- A small shift may overlap the meeting's old time without being mistaken for a real conflict.
- A proposed pair works as a pair, with all unaffected commitments and configured rules still applied.
- The owner sees a recommendation and any material trade-off, rather than an account of each failed search.
- A request to explore a second move does not silently become permission to make it. An agreed concrete plan does not trigger redundant confirmation.
- Completion language reflects confirmed outcomes for each event.

Out of scope are changing scheduling preferences, automatically reorganizing a wider day, negotiating with colleagues without appropriate authorization, introducing new runtime models or tools, and inventing another approval or planning lifecycle. Existing floating-block autonomy, owner overrides, privacy rules and rejection memory remain in force.

## Proposed behavior requirements

The requirements below describe the intended product result. They preserve established charter rules and identify proposed choices where the current rules do not fully settle the experience. They do not select an implementation architecture.

### R1 Preserve the request and its authority

Resolve “Elinor” and later references to the existing event using established calendar and conversation identity. Preserve its duration, attendee set, organizer, location and occurrence unless the user requests a change. A recurring event reference normally concerns the identified occurrence; genuinely ambiguous occurrence-versus-series scope requires clarification before a write.

Interpret “a bit later” as a preference for a nearby later start within the requested day or established window, not permission to shorten the meeting, move it to another day, or alter unrelated meetings. Use established preferences to interpret proximity; this specification introduces no universal number of minutes for “a bit.” If several meaningfully different choices remain, recommend a concrete choice and ask for that decision.

An explicit instruction to move a meeting authorizes useful discovery immediately. Do not ask whether to search or whether the user really wants the requested change. If the target and scope are already settled by an explicit instruction or prior agreement, execute through the existing authorized path. This specification does not grant a new blanket right to select and execute any unspecified target in response to a directional request.

| User intent or current commitment | Permitted next step | Boundary |
| --- | --- | --- |
| “Move Elinor to 13:30.” | Execute the identified move using the existing owner authority and validation path. | Preserve current handling of explicit owner overrides and previously undisclosed attendee conflicts. No generic extra confirmation. |
| “Move Elinor a bit later if possible.” | Search immediately and return an authorized result or a concrete recommendation where a choice remains. | No silent shorter duration, different day, or second colleague move. |
| “Can I push Lori slightly later to have time?” | Evaluate a joint plan and answer feasibility first. | In this incident's context, this explores the second move; it does not authorize executing the pair. |
| “Yes, move both to those times.” | Revalidate and execute the exact agreed pair. | Do not ask for the same decision again. |
| “Move both later so Elinor still gets 40 minutes.” | Discover the coordinated change within the stated scope; execute only where target selection is already settled, otherwise present the concrete pair. | Authority covers both named meetings, not an unnamed third meeting or a rule exception never accepted. |
| “You are not helping.” | Acknowledge briefly, correct the explanation and present the useful next step. | Dissatisfaction adds no scheduling authority. |
| Maelle has said “before moving anything.” | Present the concrete plan and wait for agreement. | Honor the promise even if an earlier broad request might otherwise have permitted action. |

Owner authority comes from the authenticated caller and existing authorization mechanisms. Calendar feasibility and permission to execute are separate questions. A feasible option may still await agreement; an authorized owner override may proceed with a disclosed conflict. Existing role-specific rules govern those cases.

### R2 Find the smallest useful plan before abandoning the original request

First look for a suitable shift of the requested meeting without changing another human's meeting. Preserve the existing free-first scheduling cascade and configured preferences.

**Proposed product choice:** when the immediate obstacle is an adjacent meeting, evaluate a nearby adjustment of that meeting before presenting a shorter original meeting or another day as the only useful answer. This is discovery for a proposal, not automatic calendar reorganization. It applies directly once the owner asks about Lori; proactive examination of the obvious adjacent move is recommended where permitted by current data access.

Prefer an otherwise compliant single move over a pair. When a pair is necessary, preserve both durations and favor the nearby adjustment that meets the request with the least disruption, subject to the existing rule hierarchy. “Least disruption” must not override configured buffers, protected commitments, existing rejection decisions, or the owner's stated priorities.

Do not turn this into an unbounded chain of colleague moves. If the nearby pair cannot work without another person's meeting changing, state that additional consequence and seek a decision before expanding the plan. There is no new universal search radius, candidate cap, or maximum duration in this specification; existing configuration and the user's requested scope govern the search.

A different day or reduced duration is a trade-off to propose when needed, not an inferred authorization. If only 25 minutes are available while 40 were requested, say so; do not label the shorter slot as fulfilling the request. If a true conflict requires outreach, ask or use existing authorization to initiate it, and distinguish “ask Lori” from “move Lori.”

### R3 Exclude the moving meeting without erasing other commitments

The meeting being moved is not an independent busy commitment at its old time in a proposed replacement calendar. Apply that fact consistently to the owner and affected attendees, using verified event identity rather than matching a name or subtracting an entire anonymous interval.

A replacement interval that partially overlaps its own old interval is a legitimate candidate. For example, moving a 14:00–14:40 meeting to 14:15–14:55 must not be rejected solely because the two intervals overlap. It must still pass all checks concerning other commitments and the requested scope.

Returning the exact unchanged start and end as a new move option is different. Do not advertise it as accomplishing “later.” If the owner explicitly chooses the current time, report that it is already there rather than fabricate a change or emit an unnecessary update. A requested duration change at the same start is a separate update, not an unchanged interval.

Preserve every unrelated overlapping commitment, including an attendee's double-booked event inside the old meeting interval. Removing the moving event must not make that separate event disappear. When aggregated free/busy cannot establish which busy contribution belongs to the moving event, use available identity-bearing evidence or state the uncertainty. Do not call the attendee free merely because a time range was carved away.

For recurring meetings, exclusion identifies the affected occurrence and its corresponding attendee copies where supported; it must not remove other occurrences or the series wholesale. An unresolved or stale event identity is an identity problem to resolve, not evidence that a time is busy.

### R4 Evaluate the complete proposed calendar

For a two-meeting plan, evaluate the calendar that would exist after both agreed replacements. Exclude the old contributions of both identified events, place both proposed intervals into the candidate calendar, and retain every unaffected event. Evaluate the new meetings against each other as well as against the remaining calendar.

Check the full duration for the owner and every relevant attendee, their applicable working hours, configured inter-meeting and travel buffers, location and room requirements, category rules, day rules, floating blocks and free-time protection. Resolve dates and timezones through the existing scheduling logic, including dated travel overrides and ambiguous local times. Do not hardcode the five-minute gap shown in the incident as a valid buffer for every owner.

The example pair, Elinor 13:30–14:10 and Lori 14:15–14:55, is a **candidate**, not an established good plan. If Lori has a separate real commitment at 14:45, this is not a clean pair. It must be rejected as clean or presented with the real conflict through the existing override rules. “Finishes before 15:00” does not answer a 14:45 conflict.

Search, candidate evaluation and mutation must reach the same decision for the same complete plan, calendar snapshot, rules and authority. Different results caused by a later calendar change are legitimate; different results caused only by entering through a different operation are not. Keep this requirement on the existing meeting decision path and validator.

No pair is fully validated merely because each event fits when evaluated separately against the old calendar. Conversely, no pair is impossible merely because the second event still occupies its old time during the first evaluation.

### R5 Describe only what the evidence establishes

A reply must distinguish a clean option, a known conflict, an authorized exception, and availability that could not be checked. An empty search result alone does not establish “Elinor is busy everywhere” or “the rules forbid it.” It may reflect the search window, candidate filtering, missing data or an unavailable calendar.

When answering “is Elinor busy on all?”, inspect the actual proposed intervals and evidence for Elinor. Separate an attendee conflict from an owner conflict, insufficient duration, or a search limitation. If correcting an earlier answer, state the correction once in human terms and give the next useful option. Do not repeat a guessed mechanism as a proven diagnosis.

External or inaccessible attendee calendars remain eligible for the existing owner-side suggestions with a clear “their availability is unconfirmed” qualification. They are neither silently considered free nor automatically disqualified. Privacy controls continue to determine what evidence may reach the model and the recipient.

### R6 Revalidate and execute the agreed plan faithfully

Before each relevant write, use current calendar evidence through the existing mutation validation path. This is internal validation, not another conversational permission step. If the approved plan is unchanged and remains valid, proceed without asking again.

If something material changed, explain that change and the decision now needed. Do not silently substitute new times, shorten a meeting, add a third move, or reinterpret the earlier approval. Existing explicit owner authority and overrides remain applicable; a calendar recheck must not become an automatic refusal of an authorized exception.

Preserve event identity when moving an existing meeting. Do not create a replacement meeting and invite everyone again. Preserve occurrence-versus-series scope and unchanged event details.

Execution must account for the dependency between the two changes. Select an order that does not knowingly create a new conflict in an intermediate calendar where an alternative safe order exists. If the available calendar operation cannot safely realize the pair under current constraints, expose the limitation before the first write; do not promise atomic execution that the provider does not offer.

### R7 Report partial and uncertain outcomes honestly

“Both moves are done” requires confirmed completion for both specified events. A tool invocation, closed approval, or intended plan is insufficient. Use the current result contract and available read-back evidence to determine what is confirmed.

If one move succeeds and the other fails, name the event that changed, its resulting time, and the event that did not. Explain the practical consequence briefly. Do not conceal the partial calendar behind a general failure or a success headline.

If a write times out or returns an ambiguous result, use a safe read to reconcile the actual event state before deciding whether another write is necessary. Observing the desired state confirms that state, not necessarily that this attempt caused it. Do not repeat a mutation merely to discover whether it succeeded, or report a failed outcome while it remains unknown.

Retry only the remaining necessary action under the still-valid agreement. After a restart, preserve the same event identities, decision and confirmed progress using existing mechanisms. Do not reopen a finished step, duplicate notifications, or leave an implicit promise of later checking without existing tracked work.

**Proposed recovery default:** do not automatically undo the successful move in a partially completed pair unless existing authority clearly covers that recovery. Reverting a human meeting can send another update and may no longer be feasible. First reconcile current state, then either finish the unchanged authorized plan safely or ask about the concrete recovery choice. This default requires owner review before implementation; it does not redefine existing floating-block revert behavior.

### R8 Keep replies short and decision focused

Lead with the answer or recommendation. Give the proposed time and any consequential trade-off, then ask the one unresolved question. Keep internal search iterations, rejected candidate lists and implementation explanations out of the normal answer. When the owner asks why, answer that specific question accurately.

Keep the distinction between how many viable options are found and how the recommendation is summarized. Honor an explicitly requested count and the existing configurable `offered_slot_count`; do not introduce a global “only two options” rule or silently prune valid results to make the answer short. For this coordinated move, a compact pair is one plan. If alternatives are requested, present the valid alternatives together rather than one yes/no question per turn.

Match the current conversation's language consistently, including Hebrew, Russian, Spanish and English. The same authority boundaries apply across languages; translating a feasibility question must not turn it into an imperative. Names, grammatical gender and timezone display follow the existing person and language rules.

Completion names every event actually changed. It does not justify an unauthorized change after the fact with “say if you'd rather.” A brief apology is appropriate after an error, followed by the corrected decision or state rather than a long explanation.

## Example conversations

These examples illustrate response shape. Their times are hypothetical and may be used only when calendar evidence supports them.

**A clean single move with a settled target**

Owner: “Move Elinor to 13:30.”

Maelle, after confirmed completion: “Moved Elinor to 13:30–14:10.”

**A second meeting needs agreement**

Owner: “Can I push Lori slightly later to have time?”

Maelle: “Yes — Elinor can be 13:30–14:10 if Lori moves to 14:15–14:55. Shall I move both?”

Owner: “Yes.”

Maelle, after revalidation and confirmed completion: “Done — Elinor 13:30–14:10; Lori 14:15–14:55.”

**A separate conflict survives self exclusion**

Maelle: “Lori's 14:45 commitment still overlaps that move. The pair won't fit cleanly. I can check a later pair or a different day.”

The actual alternatives offered must reflect the requested scope and known availability. This sentence does not itself authorize widening the day or ignoring the conflict.

**Recovering after the owner expresses frustration**

Owner: “You are not helping.”

Maelle, if the corrected pair is verified and nothing has moved: “You're right — I made this confusing. Elinor 13:30–14:10 and Lori 14:15–14:55 work together. Shall I move both?”

**Partial completion**

Maelle: “Lori moved to 14:15–14:55. Elinor's update failed, so that meeting is still at 11:15–11:55.”

Add a recovery choice only when one is actually needed; an unchanged, still-authorized retry does not require asking for the original decision again. An unknown Elinor outcome must be described as unconfirmed instead of failed.

**Patterns that fail this specification**

- “13:15 fails because … 14:45 fails because … 12:00 fails because …” as the ordinary response to a simple request.
- “Lori is busy at 14:15” when the only evidence is the Lori meeting being moved.
- “Both are free” after removing an entire attendee busy interval that also contains another event.
- “Nothing returned, so your rules don't allow it” without a supported cause.
- “Both moves are done” after a feasibility question and frustration, especially after promising to present options first.
- “I also moved Dina; say if you want it elsewhere” when Dina's move was never authorized.
- “Are you sure?” after the owner has accepted the exact plan and no material facts have changed.

## Acceptance scenarios

The later implementation should exercise deterministic behavior with realistic event identity, calendar and failure fixtures. Conversation evaluation must cover the corresponding user-visible outcomes; prompt text alone is not proof of obedience. The candidate times in these scenarios are fixture inputs, not claims about the incident calendars.

| ID | Scenario | Required outcome |
| --- | --- | --- |
| A1 | Single 40-minute meeting shifts 15 minutes later and overlaps only its own old interval. | Search, candidate check and mutation allow the same otherwise valid shift. |
| A2 | Candidate equals the exact original start and end. | It is not advertised as a later alternative; an explicit request to keep it produces no unnecessary write. |
| A3 | Unrelated attendee event lies entirely inside the moving meeting's old interval. | The other event remains a real conflict after self exclusion. |
| A4 | Free/busy merges the moving meeting with another event and identities cannot be established. | Availability is qualified or resolved from better evidence; it is never asserted free from range subtraction alone. |
| A5 | A two-meeting shift is valid only after both old events are replaced. | The complete candidate calendar passes consistently; discovery does not reject it against stale old positions. |
| A6 | Both new meetings individually fit the remaining calendar but collide with each other or violate a configured buffer. | The pair is not presented as clean; the real rule or conflict is retained. |
| A7 | Lori has a genuine 14:45 event while the proposed new Lori meeting ends at 14:55. | That overlap survives exclusion and requires the established conflict decision. Finishing before 15:00 is not treated as sufficient. |
| A8 | A clean single move exists alongside a valid pair. | The single move is preferred unless the owner's stated preference says otherwise. |
| A9 | Preserving the day and duration requires a nearby second move. | Maelle evaluates and proposes the pair before treating shortening or another day as the only path; no writes occur without the required agreement. |
| A10 | The nearby pair would require an unnamed third colleague meeting to move. | The additional consequence is surfaced for a decision; there is no silent chain. |
| A11 | Owner asks only whether Lori can move, or expresses dissatisfaction. | Discovery and a useful concise answer occur; neither message authorizes the pair's execution. |
| A12 | Maelle has promised options “before moving anything.” | No write precedes agreement to the concrete plan. |
| A13 | Owner explicitly names the target time or accepts a disclosed pair. | Existing authority is honored; no redundant generic confirmation. Already accepted conflicts are not re-asked. |
| A14 | Calendar changes between proposal and execution. | Current checks detect the change. An unchanged valid plan proceeds; a materially altered plan or new decision is surfaced. |
| A15 | First update succeeds, second fails. | The outcome lists the real state of both events and does not claim total success or automatically undo without authority. |
| A16 | Provider accepts a write but its response is lost. | Safe reconciliation precedes any retry; confirmation follows observed evidence, with no duplicate replacement invite. |
| A17 | Process restarts after one confirmed update. | Recovery preserves the exact agreement and event IDs, resumes only necessary work, and does not duplicate terminal actions. |
| A18 | Move concerns one recurring occurrence, with another occurrence nearby. | Only the identified occurrence is excluded and moved. Series scope is not inferred. |
| A19 | Room availability, physical location or travel requirements invalidate an otherwise free pair. | All three stages agree on the actual requirement; no room or buffer check is lost during joint planning. |
| A20 | Owner is travelling or an attendee's local date differs; a separate fixture includes a genuine DST gap or fold. | Existing timezone rules give consistent instants and displays; only genuinely unresolved ambiguity triggers clarification. |
| A21 | Attendee calendar is inaccessible or external. | Owner-side options remain available with unconfirmed attendee status, without a false free/busy assertion. |
| A22 | Colleague or public-room request includes owner-private or private-event data. | Existing role and surface boundaries hold; the plan exposes only permitted information and never borrows owner authority. |
| A23 | Owner explicitly authorizes a known conflict or exception under the current rules. | The correction preserves that legitimate override and its truthful annotation. |
| A24 | The same feasibility and execution exchanges occur in Hebrew, Russian and Spanish. | Authority, dates, duration and outcome remain equivalent; replies remain in the current language. |
| A25 | User requests a specific option count, or the profile's count exceeds the short recommendation. | Configured and requested counts remain respected; concise presentation does not reduce search coverage or invent slots. |
| A26 | An event or suggestion was previously rejected; a solo floating block is independently movable under existing rules. | Rejection memory persists, and legitimate floating-block autonomy still works without turning it into authority over colleague meetings. |

## Proposed success measures

These are acceptance targets, not measured production baselines or promises of achieved improvement. Record denominators and evidence scope when evaluating them.

| Measure | Proposed target | Evaluation |
| --- | --- | --- |
| Decision consistency | No unexplained disagreement for the same plan, snapshot, rules and authority across search, candidate check and mutation. | Deterministic regression matrix including positive and negative controls. |
| Scoped execution | Zero writes outside the established event, time and occurrence scope; zero writes triggered only by frustration or feasibility language. | Authorization and conversation scenarios, including multilingual variants. |
| Outcome accuracy | Every completion claim agrees with confirmed event state; every partial or unknown outcome is represented accurately. | Success, timeout, partial failure and restart fixtures. |
| Decision burden | A feasible pair requiring agreement is presented in one decision message, then completed after one acceptance when facts remain unchanged. | Transcript evaluation; exclude genuinely new constraints or unresolved identity. |
| Reply clarity | Ordinary recommendation or completion fits in one to three short sentences, or a compact requested options list, with no rejected-slot narration unless asked. | Human review of representative conversations; length is a presentation target, not a global truncation rule. |
| Preservation | All applicable legitimate controls pass, including owner overrides, unknown attendee availability, privacy, recurring scope and configured option counts. | Existing affected suites plus the acceptance scenarios above. |

After deployment, sample authorized real rescheduling conversations for false self-conflict explanations, extra decision rounds, unintended writes and inaccurate completion claims. Establish a baseline before claiming reductions; compare equivalent scenarios and report sample sizes. Production observation is a separate stage from local fixture success.

## Ownership and implementation handoff

| Lane | Responsibility | Boundary |
| --- | --- | --- |
| Matchmaker | Prove the scheduling cause; correct event exclusion, final-calendar evaluation and consistency; preserve attendee evidence, configured rules and mutation behavior. | Primary owner of the scheduling result. Do not solve deterministic defects by prompt wording alone. |
| Instructor | Reconcile move tool descriptions and examples; preserve intent distinctions, concise replies, language behavior and truthful narration. | Existing instructions already ask for brevity. Identify why they failed or conflicted before adding more text. |
| Registrar, if needed | Preserve exact agreed decisions, tracked approval or deferred work, and partial or uncertain recovery where these cross the existing requests lifecycle. | A two-event proposal alone does not justify a new request kind, persisted shape or parallel state machine. |

If investigation finds a defect in identity resolution, transport authority, privacy payloads or output enforcement, route that bounded dependency to its owning lane. The evidence should determine involvement; this specification does not require dispatching every lane in advance.

Before code changes, the responsible lanes must establish the production path and a reproducible cause. Reconcile the affected search and write callers, including background users of moving-event exclusion, and identify which existing behavior must remain unchanged. Reuse existing mechanisms before proposing another one.

Implementation and independent review follow the canonical [Workshop policy](../.claude/WORKSHOP.md), including its evidence and release requirements. This specification does not duplicate or relax those checks. A completed specification is not a built, tested, deployed or production-observed correction.

## Decisions for owner review

1. **Nearby joint discovery:** approve the recommendation to evaluate an obvious adjacent-meeting adjustment before offering duration reduction or another day, while keeping execution within agreed scope. This permits proactive investigation, not autonomous colleague moves.
2. **Partial completion recovery:** approve the proposed default of reconciling and finishing the unchanged authorized plan where safe, without automatically reverting a successful human meeting move unless recovery authority already covers it.
3. **Directional selection autonomy:** retain the existing discovery-and-proposal behavior when “a bit later” leaves a meaningful choice. Any broader policy allowing Maelle to select and execute unspecified times should be decided explicitly, rather than introduced as part of this bug fix.

The production root remains an evidence question, not a product vote. None of these decisions requires a new model call, tool or persisted shape by default; any such proposed mechanism needs the separate process required by the canonical Workshop policy.

## Source appendix and production evidence gaps

The local source reviewed was revision `aa56faeb148c58f62fe800ad924b3104e356b708`. File line references below identify that snapshot and may move. They establish current source behavior or guidance, not which revision or tool arguments ran during the screenshot exchange.

| Source | What it establishes | What remains unproven |
| --- | --- | --- |
| [Matchmaker charter](../.claude/agents/matchmaker.md), M1, M3–M8 and M14–M18 | Scheduling ownership, decision consistency, configured options and buffers, owner authority, move identity and preserved legitimate paths. | Whether those guarantees held in the incident. |
| [Instructor charter](../.claude/agents/instructor.md), ownership and I2–I5 | Instructor owns meeting tool descriptions and narration; deterministic enforcement belongs to the code lane. | The exact prompt and context supplied to the production turn. |
| [Registrar charter](../.claude/agents/registrar.md), R2, R3 and R5 | Exact decision replay, truthful uncertain outcomes, closure and avoiding approvals for already permitted work. | Whether this incident used a tracked approval or recovery path. |
| [Graph slot finder](../src/connectors/graph/findAvailableSlots.ts), lines 900–950 and 1333–1338 | The current implementation carves moving-event time from busy intervals, includes attendee intervals, and normally forbids any candidate overlapping the old interval unless `allowMovingEventOverlap` is set. The overlap rejection is broader than excluding the exact unchanged target. | Whether those arguments and branches caused the observed rejection, or whether unrelated attendee busy evidence was lost. |
| [Meeting planner](../src/skills/meetings/planMeeting.ts), lines 791–797 | The mutation rule check excludes the identified existing event. | End-to-end mutation feasibility and attendee checks for the actual pair; this excerpt alone does not prove execution would succeed. |
| [Meeting tools and guidance](../src/skills/meetings.ts), line 306 and lines 1220–1247 | Guidance describes old-interval overlap prohibition, already asks for concise options, treats an empty search as failed rules, and combines a requirement for an owner decision on colleague conflicts with an example reporting an extra colleague move afterward. | Which guidance influenced this particular reply, and whether a runtime boundary prevented or allowed actual writes. |

The strongest source-supported scheduling hypothesis is that legitimate overlapping shifts can be rejected during discovery while the write path excludes the existing event. The nearby wording also supplies plausible conversational failure mechanisms. These hypotheses do not yet establish one production root; they may represent distinct defects with different corrections.

Before an implementation handoff claims a cause, obtain the relevant live turn and tool trace, search windows and moving event IDs, rejection reasons, mutation arguments and results, deployed revision, calendar state around the relevant intervals, and any approval or work-item transitions. Verify the separate 14:45 and 15:00 commitments, event identities across calendars, recurrence scope and timezone. Confirm whether each claimed move happened and whether it was a clean move, an override, or still uncertain.

Local logs and the repository database are frozen snapshots and cannot settle those production facts. If live evidence is unavailable, the specification remains useful for product review, but causal implementation must wait for the proof required by the canonical Workshop policy.
