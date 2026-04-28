## Maelle session context

We are working on the Maelle project at E:/Code/Maelle.
Current version: check package.json — it is the source of truth.

Read these two memory files before doing anything:
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_overview.md
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_architecture.md

Plus these feedback memories (cross-session rules the owner has set):
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/feedback_bundle_signals.md
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/feedback_ticket_titles.md
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/feedback_version_workflow.md
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/feedback_versioning.md

When the owner says "wrap up" / "close the patch" / "cut a version" / "day close" → follow `.claude/WRAP_UP.md` step-by-step.

When the owner says "test scenario N" / "run scenario N" / "simulate scenario N" (or similar) → open `.claude/test-scenarios.md`, read that scenario in full, then code-trace it against the current files on disk (do not trust memory) and produce a report: what works, what doesn't, what shouldn't happen, plus concrete fix suggestions. **This is a paper exercise — never execute the scenario for real. No live DMs, no real calendar writes, no DB writes, no tool calls against the running system.** The only allowed side effect is reading source files. No auto-fixing — owner decides fix-now vs file-a-ticket.

**Scenario report format (4 columns):** `# | What the scenario expects | What the code does today | Status` (✅ Works / ⚠️ Partial / ❌ Not working / 🚫 Shouldn't happen). One row per discrete checkpoint; each row self-contained with file:line citations so a reader doesn't need to re-read the scenario. After the table, a short **Fix suggestions** section covering ONLY the ❌ and ⚠️ rows. Skip the ✅ ones.

All 10 scenarios were paper-run against v2.2.3 (sessions through 2026-04-26). Surfaced gaps either fixed inline or filed (#43 + descendants, #51, #52, #53). When re-running scenarios, treat any ❌/⚠️ row identically to the first run — owner may have changed the underlying spec since (scenarios 1 + 2 were reframed mid-session). Always re-read the scenario text fresh, never trust prior reports.

**Edits to scenarios are owner-driven.** If a beat in a scenario reads as "wrong" to you, propose a rewrite — don't just rate it ❌. The owner has reframed scenarios mid-session multiple times when my analysis surfaced that the original scenario expectation didn't match his actual workflow.

---

## Where we are — v2.3.3 just shipped

**Operational state (v2.3.3):**
- **Auto-triage + auto-build are OFF.** Both workflows in tree but gated `if: false &&` (commit 13565e9). Reason: single-shot triage was missing the session/memory context that interactive Claude Code uses, and plans drifted (irrelevant data, wrong root causes, re-introducing already-rejected solutions). Owner is back to filing GitHub issues for INTERACTIVE fixing here. **GitHub remains the bug data source** — keep using `gh issue list/view` to read what owner has filed; just don't expect any auto-build pipeline to ship them.
- **PM2 + deploy watcher are OFF.** Owner runs `npm run dev` directly. Every change requires owner to restart his process — no auto-pull from origin/master. Plan accordingly when committing: changes don't take effect on his machine until he pulls + restarts.

**Default workflow when owner files / shows a bug:**
1. **Understand.** Read the issue body + screenshot. Code-trace against current files on disk. Don't guess.
2. **Propose.** Write up: what's broken, where (file:line), and the proposed fix. Code vs prompt — prefer code for determinism, prompt for judgment (per CLAUDE.md).
3. **Discuss.** Wait for owner to revise / push back / approve. He often re-frames or rejects the agent's first read — that iteration IS the value.
4. **Build.** Only after explicit approval. Typecheck. Stop.
Never auto-fix. Never bundle multiple fixes without owner saying so.

**Default version bump: PATCH** unless owner explicitly says minor. He has corrected this multiple times.

**v2.3.3 wave** (the most recent — wrapped same-day): owner-override-as-approval pattern across 5 surfaces, scheduling honesty, coda safety. The unifying principle that finally clicked: when owner asks for X and X has a soft-rule cost, FLAG the cost, don't reframe to "find different". Built: (a) `find_available_slots.relaxed: bool` (owner-only) bypasses focus / lunch / work-hours; KEEPS the 5-min between-meeting buffer (sacred). (b) `move_meeting` floating-block branch — owner-explicit hint in-window uses target as-is, no conflict refusal; out-of-window still refuses (lunch_bump territory). (c) `find_available_slots` auto-loads `attendeeAvailability` from people_memory (Brett in Boston no longer gets proposed 10:15 IL). (d) `coordinate_meeting` enriches missing emails for internals via Slack `users.info` through the existing `Connection.collectCoreInfo`. (e) `claimChecker` gains `mode: 'coda'` — validates against people_memory snapshot, drops invented facts ("kind of wild that she shares my name") and gossipy commentary about third parties. (f) Codas now log as Maelle initiations + schedule a `social_ping_rank_check` 48h out with `kind: 'coda'`; ignored codas drift colleagues toward rank 0. (g) `profile.meetings.office_location: { label, address, parking }` yaml field; `determineSlotLocation` + `create_meeting` body fill it in for physical meetings. (h) Several short prompt rules: owner-explicit time → ask "keep it?"; floating blocks Maelle's call vs colleague meetings owner's call (don't bundle); verify the goal before suggesting collateral moves; external online/in-person ASK with smart skip on remote signals. (i) textScrubber em-dash extended to `[-—]`; create_meeting body now scrubbed before Graph.

**v2.3.2 wave** (just before): brief redesign — events table no longer feeds the brief, tasks-spine + tasks.informed is the only dedup; brief leads with TODAY'S CALENDAR via `processCalendarEvents`. Deterministic brief routing (`core/briefIntent.ts` short-circuits owner-DM brief asks). Internal-coord fast-path in `coordinate_meeting` (`isAllInternalParticipants` + `annotateSlotsWithAttendeeStatus` → `action: 'present_slots_to_requester'`). `create_meeting` added to `COLLEAGUE_ALLOWED_TOOLS` with v2.2.1 trust-pattern guards + post-booking heads-up DMs to internal attendees. Shadow-DM threading per `conversationKey` (one owner-DM thread per Slack conversation; coord shadows keyed on `coord:${job.id}`).

**v2.3.1 wave**: 23 atomic bugs fixed across one long working session. 7 GitHub issues (#61-#67) closed. Coord state machine cluster, `move_meeting` deterministic floating-block alignment (closes the recurring "Sonnet does time math wrong" pattern), OOF detection trusts `showAs` only, `busy_day` issue type removed, TZ display fixes (parseGraphDateTime setZone + Prefer header on nextLink), proactive tick fixes, CHANNELS-you-can-reach block in system prompt, concision pass extended for self-contradiction, Oran error humanized.

**Earlier (still relevant):** action tape pinned to owner system prompt (v2.2.6); post-mutation verification for create + move (v2.2.6); travel-aware coord (v2.3.0); file attachments on `message_colleague` via Connection.SendOptions.attachments (v2.3.0); `normalizeForGraph` strips Z/offset before Graph mutations (v2.3.0). The autonomy layer (`behavior.calendar_health_mode: passive | active`, deterministic protection rules, shadow DMs via `v1_shadow_mode`) ships from v2.1.1; the Connection interface (four-layer model) from v2.0.0. Social Engine (30 fixed categories, per-person topics, three initiation paths) ships from v2.2.0.

v2.2.0 is the **Social Engine** — first real minor bump in the 2.x line. Two parallel subsystems that together make Maelle read as a person, not a service desk:

**Owner↔Maelle Social Engine** — 30 fixed categories seeded per owner (family/kids/gaming/tech/travel/etc). Pre-pass Sonnet classifier on every owner turn tags task|social|other. Task always wins; social turns produce a deterministic directive (celebrate|engage|revive_ack|continue|raise_new|none) injected into the prompt. Topics live in `social_topics_v2` with engagement_score 0-10, status active|dormant. Round-robin continuation prefers topics Maelle hasn't touched in 3+ days. Weekly decay drops -1 from untouched actives; score 0 → dormant (retained, owner can revive). Post-turn logger writes to `social_engagements` audit trail. Fixes the "One Axos down! → 'what do you need from me?'" bug class.

**Maelle→Colleague proactive outreach** — hourly system tick, owner-time-agnostic. Each hour sweeps known colleagues, picks one whose LOCAL time is in 13:00-15:00 work-day window, engagement_rank>0, 5-day cooldown not hit, prior interaction history. Sonnet generates a short warm ping; rank-check 48h later auto-adjusts `engagement_rank` 0-3 based on reply. Rank 0 = opt-out (never initiate). Owner override via `update_person_profile` tool ("never ping Ysrael" → rank 0). Gated on `behavior.proactive_colleague_social.enabled` (default off, opt-in per profile).

**Stress-test simulator** at `scripts/stress-test-social.mjs` — 3 scenarios (silent/chatty/dead topic). Sweet spot: 3-5 active topics per person natural equilibrium. Dead topics hit dormant in ~3 days.

Filed [#43](https://github.com/odahviing/AI-Executive-Assistant/issues/43) (timezone learning, Medium) — proactive outreach gates strictly on colleague timezone.

**Capabilities to remember (each was a previous wave; live and used):**
- **Owner-override pattern** (v2.3.3) — when owner-explicit input conflicts with a soft rule, narrate the cost and proceed. Wired in: `find_available_slots.relaxed: true` (bypass focus / lunch / work-hours, KEEP buffer); `move_meeting` floating-block in-window hint respected as-is; meetings prompt rules.
- **Coda safety** (v2.3.3) — `claimChecker(mode: 'coda')` validates social codas against people_memory before they're appended. Drops invented facts + gossipy commentary on third parties. Failed validation → coda dropped silently, no log, no rank-check.
- **Coda engagement tracking** (v2.3.3) — every coda calls `recordSocialMoment` + schedules `social_ping_rank_check` 48h out. Dispatcher's `kind: 'coda'` branch checks `last_social_at > coda_at_iso`; not engaged → -1 with reason `no_social_response_to_coda`. Ignored colleagues drift to rank 0 (opt-out).
- **Office address** (v2.3.3) — `profile.meetings.office_location: { label, address, parking }` yaml; `determineSlotLocation` + `create_meeting` body fill it in for physical meetings. Externals on the invite see the actual address.
- **Auto-loaded attendee availability** (v2.3.3) — `find_available_slots` reads each attendee's TZ + working hours from people_memory automatically; Sonnet doesn't have to pass `attendeeAvailability`. Opt-out via `ignore_attendee_availability: true`.
- **Email enrichment** (v2.3.3) — `coordinate_meeting` enriches missing emails for internals via people_memory → Slack `users.info` (`Connection.collectCoreInfo`). Externals stay missing-email and downgrade out of the v2.3.2 fast-path correctly.
- **Internal-coord fast-path** (v2.3.2) — `isAllInternalParticipants` gate → annotated slots returned to requester via `action: 'present_slots_to_requester'`. No DMs to attendees. Sonnet presents, requester picks, calls create_meeting.
- **Colleague-path `create_meeting`** (v2.3.2) — added to `COLLEAGUE_ALLOWED_TOOLS` with rule-compliance gate; post-booking heads-up DMs to internal attendees.
- **Shadow-DM threading** (v2.3.2) — `shadowNotify(conversationKey, conversationHeader)`. Process-wide cache. Inbound-colleague keyed on threadTs; coord-side keyed on `coord:${job.id}`. Security shadows + DM-failed stay top-level.
- **Brief redesign** (v2.3.2) — events table removed from brief; tasks-spine + tasks.informed only. Brief leads with TODAY'S CALENDAR via `processCalendarEvents`. `core/briefIntent.ts` short-circuits owner-DM brief requests to `sendMorningBriefing(force=true)`.
- **Floating blocks** (v2.1.0 + v2.3.1 / B1 + v2.3.3 / 3A) — `schedule.floating_blocks` YAML; lunch auto-promoted; elastic within window. `move_meeting` deterministic for colleague-path; owner-explicit in-window hints respected as-is; out-of-window refuses with `lunch_bump` pointer.
- **Action tape** (v2.2.6) — `ACTIONS YOU TOOK IN THIS THREAD` block in owner system prompt lists `[<tool> OK ...]` markers from this thread's history.
- **Post-mutation verification** (v2.2.6, #54) — `verifyEventCreated` + `verifyEventMoved` mirror v2.1.6 `verifyEventDeleted`. Wired into `create_meeting` + `move_meeting`.
- **Travel-aware coord** (v2.3.0, S8) — `coordinator.ts` reads `getCurrentTravel(slackId)` before building `colleagueTz` AND `attendeeAvailability`.
- **Connection attachments** (v2.3.0) — `Connection.SendOptions.attachments` on `message_colleague`. Slack downloads + re-uploads via `files.uploadV2`.
- **`normalizeForGraph(iso, tz)`** (v2.3.0) — strips Z/offset before Graph mutations; fixes UTC-stamping when Sonnet passes Z-suffixed timestamps.
- **OOF detection trusts `showAs === 'oof'` only** (v2.3.1 / B16) — no keyword matching.
- **Proactive social** (v2.2.0 + v2.3.1 fixes) — `social_outreach_tick` reads social topics + 15-question discovery pool. Hard ban on meeting/work/task references. Eligibility requires real `message_received` history. Disabled by default.
- **CHANNELS YOU CAN REACH PEOPLE THROUGH** block in system prompt (v2.3.1 / B22) — reads `listConnections(profileId)` at prompt-build; capability framing via what's available, not what's missing.
- **Concision + self-coherence pass** (v2.2.5 + v2.3.1 / B20+B21) — `looksSelfIncoherent` trigger added (≥2 question marks OR ≥2 if-then branches).
- **Autonomy layer** (v2.1.1) — `behavior.calendar_health_mode: 'passive' | 'active'` toggles autofix vs report-only.
- **Connection interface** (v2.0.0) — four-layer model (core / skills / connections / utils); skills NEVER import from connectors/slack.
- **Social Engine** (v2.2.0) — 30 fixed categories, per-person topics, round-robin continuation, weekly decay, `social_topics_v2`.
- **Persona skill** (v2.2.3) — togglable; off = no proactive social anywhere.

## Open improvement tickets (GitHub)

Consult before proposing anything that might already be filed:
- **[#3](https://github.com/odahviing/AI-Executive-Assistant/issues/3)** — Make persona memory toggleable skill (Low)
- **[#12](https://github.com/odahviing/AI-Executive-Assistant/issues/12)** — Improve Hebrew voice quality (Low)
- **[#22](https://github.com/odahviing/AI-Executive-Assistant/issues/22)** — Cross-connector skill architecture (High) — design-only, gates #4/#5
- **[#23](https://github.com/odahviing/AI-Executive-Assistant/issues/23)** — Unified contact across connections (Low, blocked)
- **[#30](https://github.com/odahviing/AI-Executive-Assistant/issues/30)** — Reserve slot on participant pick (Medium) — tentative reservation in verification window
- **[#31](https://github.com/odahviing/AI-Executive-Assistant/issues/31)** — Book travel buffer on offsite meetings (Low)
- **[#32](https://github.com/odahviing/AI-Executive-Assistant/issues/32)** — Retry move-coord on refusal (High) — participant refusal → earlier-bias round-2
- **[#33](https://github.com/odahviing/AI-Executive-Assistant/issues/33)** — Respond to invite on owner's side (Low) — accept/decline tool
- **[#41](https://github.com/odahviing/AI-Executive-Assistant/issues/41)** — Investigate if recovery pass still earns its keep (Low) — firing-rate + usefulness audit

## Focus going forward

1. **Bug stability sprint.** Owner is running interactive bug-test sessions (file → propose → discuss → build, no auto-anything) until the agent is stable. Expect more sessions like the v2.3.1 wave: lots of small atomic bugs, often with cross-cutting roots, often via screenshots.
2. **Autonomy refinement.** Tickets like #32 (retry-on-refusal), #30 (tentative reservations), #33 (invite responses) are queued.
3. **Transport additions.** Email + WhatsApp connectors sit behind the Connection interface (v2.0.0). #22 gates real work on them.

## Known dead fields worth cleaning

`behavior.rescheduling_style`, `behavior.adaptive_learning`, `behavior.escalate_after_days`, `behavior.can_contact_others_via_slack`, `behavior.autonomous_meeting_creation` — all declared in the yaml schema but NEVER read in the code. The only `behavior` fields actually wired are `v1_shadow_mode` and `calendar_health_mode`. Worth a cleanup ticket but not filed yet.

## Bugs are expected

External QA is active. When a bug lands, follow the usual flow (propose, don't fix; verify in code before trusting memory; code for determinism, prompts for judgment).

---

## Mission — what we're actually building

Maelle is an AI executive assistant that works **as a human EA**. The entire product premise is that colleagues and the owner experience her as a person — not a bot, not an "AI assistant," not a chat interface. A real member of the team who happens to run on code.

The filter test for every decision: **"Would a real human EA do this / say this / phrase it this way?"** If the honest answer is no, the behavior is wrong — even if it's technically correct. This filter outranks any other priority including speed, completeness, and elegance.

Concretely this means:
- Colleagues never see machine framings: "the system", "force the slot", "clear the threshold", "my tools/prompts", "I'm an AI."
- Errors surfaced to users sound human: "I got confused, can you clarify?" beats "Operation failed." Silence beats a fake "Done."
- The owner's preferences ARE the rules. They're phrased as his ("your usual 2h focus block"), not as a system ("the threshold").
- Out-of-band notifications (shadow notify, debug logs) stay out of live conversations. They live in logs, or in a dedicated audit surface.

---

## The four-layer model (architectural spine — DO NOT violate)

Maelle is built on four conceptually distinct layers. Every new file belongs to exactly one. When in doubt, ask which layer before writing.

### 1. Core (always on — required to run any agent)
Engine-level capabilities every profile needs. Cannot be toggled off.
- `src/core/assistant.ts` — **MemorySkill**: preferences, people memory, interactions, gender, notes.
- `src/core/outreach.ts` — historical location; **OutreachCoreSkill** now lives at `src/skills/outreach.ts` after the v1.8.11 port, but it stays in CORE_MODULES and cannot be toggled off. `message_colleague`, `find_slack_channel`. How Maelle speaks to people on the owner's behalf.
- `src/tasks/skill.ts` — **TasksSkill**: tasks CRUD, approvals, structured requests, briefings.
- `src/tasks/crons.ts` — **RoutinesSkill** (CronsSkill): create/list/update/delete recurring routines.
- Plus pure engine infra: `src/tasks/runner.ts`, `routineMaterializer.ts`, `lateness.ts`, `src/core/orchestrator/`, `src/core/background.ts`, `src/core/approvals/` (now includes `coordBookingHandler.ts` — the registry MeetingsSkill registers its booking handler on so core/ doesn't import from skills/).
- **Persona** is core too, but lives as data in the YAML profile + `orchestrator/systemPrompt.ts` — no dedicated module.

### 2. Skills (togglable — profile YAML `skills: { ... }`)
Opt-in capabilities. Some agents will do meetings, some will do research, some both. Toggled per profile.
- `src/skills/meetings.ts` — MeetingsSkill (direct calendar ops + multi-party coordination)
- `src/skills/meetings/coord/` — coord state machine internals (v2.0, moved from connectors/slack/coord). Files: `utils.ts`, `approval.ts`, `booking.ts`, `state.ts`, `reply.ts`. All transport-agnostic.
- `src/skills/meetings/ops.ts` — direct-op helper (former `_meetingsOps.ts`, relocated in v1.8.14). Still class `SchedulingSkill`, used only via MeetingsSkill's delegation.
- `src/skills/calendarHealth.ts` — CalendarHealthSkill (issues, lunch, categories)
- `src/skills/summary.ts` — SummarySkill (transcript → summary → share)
- `src/skills/knowledge.ts` — KnowledgeBaseSkill (markdown KB)
- `src/skills/general.ts` — SearchSkill (web_search, web_extract)
- `src/skills/research.ts` — ResearchSkill (owner-only, multi-step)
- `src/skills/outreach.ts` — OutreachCoreSkill (lives under `skills/` for code layout; stays always-on via `CORE_MODULES`)
- `src/skills/registry.ts` + `src/skills/types.ts` — the skills-system machinery itself

Legacy profile YAML keys `scheduling: true` / `coordination: true` auto-map to `meetings: true` at load time; `meeting_summaries` → `summary`; `knowledge_base` → `knowledge`; `calendar_health` → `calendar`.

### 3. Connections (comm-surface framework — v2.0 first-class layer)
How Maelle gets onto a given surface (Slack, email, WhatsApp, Graph). **Connection interface is fully implemented for Slack.** Email + WhatsApp pending.
- `src/connections/types.ts` — `Connection` interface (sendDirect, sendBroadcast, sendGroupConversation, postToChannel, findUserByName, findChannelByName). `SendOptions.threadTs` flows through to `chat.postMessage`.
- `src/connections/registry.ts` — per-profile `Map<profileId, Map<connectionId, Connection>>`. Skills resolve via `getConnection(ownerUserId, 'slack')`.
- `src/connections/router.ts` — 4-layer routing policy (inbound-context / person preference / per-skill / profile default). Not yet hot-path for skills, but in place.
- `src/connections/slack/messaging.ts` — raw Slack primitives with threadTs support.
- `src/connections/slack/index.ts` — `SlackConnection` that implements the interface over messaging.ts.
- `src/connectors/slack/` — Slack Bolt app, reply pipeline, outreach reply classifier. The SOCKET-side (inbound) of Slack lives here. App.ts registers a `SlackConnection` in the registry at startup.
- `src/connectors/graph/` — Microsoft Graph (calendar reads/writes, free/busy) — not a Connection (it's a calendar backend, not a messaging surface).
- `src/connectors/whatsapp.ts` — placeholder. Next concrete target.

**Rule:** skills import only from `src/connections/`. They NEVER import from `src/connectors/slack/*` or use `app.client.*`. This was the v1.8.12–14 port; protect it.

### 4. Tools & Utilities
Pure cross-cutting helpers. No domain state, no registered tools.
- `src/utils/` — logger, gender detection, security gate, claim checker, reply verifier, date verifier (with deterministic correction fallback), coord guard, rate limit, shadow notify (uses Connection registry now), Slack formatting, addressee gate, **workHours** (isWithinOwnerWorkHours + nextOwnerWorkdayStart — shared by outreach_expiry / coord_nudge / coord_abandon).
- `src/connectors/slack/processedDedup.ts` — process-global message ts dedup Set, shared between live handlers + catch-up (fixes the v1.8.14 duplicate-reply bug).
- `src/db/` — storage helpers per table
- `src/config/` — profile loader + env

---

## Standing rules — follow these every session without being asked

### Workflow: propose, don't fix
- When the user reports a bug or requests a new feature, DO NOT jump to code.
- Investigate, then propose a solution in plain words: what's wrong, why, and how you'd fix it.
- Wait for the user's feedback / QA / comments.
- Only after explicit go-ahead, implement.
- This applies to every bug and every feature, every session, regardless of how obvious the fix looks.

### Maelle is a human
- Maelle is a person, not a bot. The entire product premise is that colleagues and the owner experience her as a human executive assistant.
- Every answer, every DM, every option Maelle generates must be something a real human EA would plausibly say or do.
- Filter test: "Would a human EA ever send this message / offer this option / phrase things this way?" If no, it's wrong — regardless of technical correctness.
- This applies to tone, cadence, hedging, apologies, error messages surfaced to users, proposed slot phrasings, escalation wording, everything user-facing.
- Never expose tool names, bot framings, structured artifacts, or AI-ish tells ("I'm an AI", "as an assistant", "my prompt", "I was programmed to"). Already enforced for colleagues by securityGate — but the bar is higher: not just "doesn't leak AI" but "sounds like a human."

### Prompts vs code — use the layer that gives the right kind of correctness
Both are valid. The rule is: use CODE where we need determinism, use PROMPTS where we need judgment.
- **Truth-critical guards → CODE.** Anything where an LLM mistake would damage data or trust: idempotency on destructive tools (delete_meeting, create_meeting), schedule-rule enforcement in `findAvailableSlots`, date-weekday verification (with deterministic correction after one retry), action-claim verification (claim-checker runs AFTER the draft), approval-state sync on coord terminal transitions. These must behave identically across models and prompts.
- **Tone, interpretation, phrasing → PROMPT.** How Maelle describes a conflict to the owner, how she asks a clarifying question, how she formats a slot proposal, how she disambiguates a two-clause request. Code can't judge "what sounds human."
- **When a bug shows up:** first ask which kind it is. "She proposed 17:05 instead of 17:15" is a DETERMINISM bug — quarter-hour alignment belongs in code and in the tool contract. "She sounded robotic when the slot was blocked" is a JUDGMENT bug — fix in prompt.
- **Do not cram determinism into prompts.** A prompt rule saying "always align to :00/:15/:30/:45" rots under model swap. The tool that returns the slot should only return aligned slots.
- **Do not cram judgment into code.** A regex trying to detect "is this message a relay commitment" will miss 10% of cases and add false positives. An LLM pass over the draft can classify by meaning.
- **Short prompt rules beat long ones.** One sentence the model actually reads is worth ten it skims. When in doubt: delete a rule, don't add one.

### Version — owner is the gatekeeper
- **Default for the agent: PATCH only.** Even if work feels architectural or substantial, default to bumping patch (`x.y.z → x.y.z+1`). The owner has corrected this multiple times when the agent reached for minor.
- **Owner defines the version.** Minor / major bumps happen ONLY when the owner says so explicitly ("bump minor", "cut a 2.3 release", etc). Never decide the level autonomously.
- **Owner calls when to commit.** Tree changes stay in tree until the owner says "commit", "bundle", "ship", "wrap up", "let's finish for today" — only then commit + push. Never commit on your own initiative even after a patch bump.
- Never bump major (`x.0`) without explicit instruction.

### Version-bump workflow (what to do at each level)
- **PATCH** — keep it light. Update `package.json` version + add the `CHANGELOG.md` entry. THAT'S IT. Do NOT commit, do NOT push, do NOT touch memory files or README. The owner runs the patch locally and bundles when ready. If owner THEN says "commit + bundle", that's when memory files + README + commit + push happen.
- **MINOR** — full wrap-up, owner-initiated only. Update `package.json` + `CHANGELOG.md` + `README.md` (if architecture/public behavior changed) + both memory files + run `npm run typecheck` + commit + push + update/open relevant GitHub issues.
- **MAJOR** — full wrap-up + explicit user instruction required.
- If unsure whether the work is patch- or minor-sized: default to PATCH and let the owner upgrade.

### CHANGELOG.md
- **Every version** (patches AND minors) gets an entry — Maelle's history is the changelog, don't silently squash patches
- Add new version block at the top, above the previous one
- Format: sections (Added / Changed / Fixed / Removed / Migration / Not changed), plain text, no bold on topic labels
- Topic level: describe the idea, not the function
- Date stays implicit in git history — no date lines

### Memory files
- Update the two `memory/` files when something meaningful changed (new skill, new pattern, new architectural primitive, new security layer)
- Keep them punchy — one dense paragraph per file, latest state on top
- If a key fact changed (Haiku → Sonnet, tool renamed, skill merged), fix the line — don't just append

### README.md
- Update only when architecture or public-facing behavior changes; NOT for bug fixes

### Code conventions
- TypeScript strict, no `any` unless unavoidable
- Skill pattern: new togglable capability = new file in `src/skills/` implementing the `Skill` interface, registered in `registry.ts` under a YAML toggle
- Internal helpers in `skills/`: nest under the skill's folder (e.g. `src/skills/meetings/ops.ts`, `src/skills/meetings/coord/*.ts`). Underscore-prefix flat files are retired post-v1.8.14.
- Core module pattern: new core capability = new file in `src/core/` + added to `CORE_MODULES` in `registry.ts` + added to `CoreModuleId` union
- DB changes: idempotent migrations via `try { ALTER TABLE } catch {}` or `CREATE TABLE IF NOT EXISTS` in `db/client.ts` initSchema()
- All times: UTC in storage, Luxon for display in user timezone
- All LLM calls: `claude-sonnet-4-6` (no Haiku anywhere)
- Lazy skill loading: use `require()` inside `loader()` so one broken skill doesn't crash startup
- Every task creation, dispatch, and lifecycle transition: `logger.info` with `skill_origin`, `skill_ref`, `due_at`, preview fields
- Task system owns every async job — creating a background sweep that walks its own table is an anti-pattern; schedule a typed task instead
- **Skills speak through Connections.** Never import from `src/connectors/slack/*` or use `app.client.*` inside `src/skills/`. Resolve via `getConnection(ownerId, 'slack')` and call `conn.sendDirect` / `conn.postToChannel`. Task dispatchers follow the same rule.

### Before finishing any session
1. `npm run typecheck` — must pass
2. Update package.json version if code changed
3. Update CHANGELOG.md (entry per version, always)
4. Update README.md if architecture changed
5. Update the two memory files if something significant changed
