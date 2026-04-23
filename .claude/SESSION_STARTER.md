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

---

## Where we are — v2.1.5 just shipped

The autonomy layer is real. `behavior.calendar_health_mode: 'passive' | 'active'` toggles `check_calendar_health` between detect-and-report (passive, default) and detect-and-execute-safe-fixes (active). Active mode auto-books missing floating blocks, tags uncategorized events with high-confidence classifier, reshuffles floating-block overlaps in-window, starts move-coords with attendees for internal-only double-bookings (cadence-aware — can't push weekly meetings into a week where the next cadence instance lives), auto-clears 1:1s from surprise-vacation days, DMs owner on busy days. All gated by deterministic protection rules (≥4 attendees / any external / matched by `meetings.protected[].name` or `.category`). Shadow DMs everywhere via `v1_shadow_mode`. Prior milestone — v2.0.0 closed issue #1 (Connection interface rollout); the four-layer model (core / skills / connections / utils) is honest and enforced.

v2.1.5 closed seven bugs from a day of external QA — big three: (1) `shadowNotify` no longer leaks into colleague threads (was gating on `startsWith('D')` which matches every Slack DM; now gated on cached owner-DM match); (2) the recovery pass is skipped entirely on colleague-facing turns so synthesized owner-narrative text can't land in a colleague's DM — colleague-facing text is only what Claude itself wrote; (3) `get_free_busy` in colleague-context now clips owner's availability to work hours via a new `buildOutOfHoursBusy` helper — 10:00 on an office day starting 10:30 literally isn't in the data Sonnet sees. Also: meetingReschedule counter auto-accept (mirrors v2.1.1 coord move-intent), outreach DM threading (new `dm_message_ts` + `dm_channel_id` columns), coord message dedup (MPIM bookings went from 3 messages to 1), built-in briefing visible in `get_routines`. Filed [#41](https://github.com/odahviing/AI-Executive-Assistant/issues/41) (investigate if recovery pass still earns its keep, Low).

Notable v2.1.x capabilities to remember:
- **Floating blocks** (v2.1.0) — `schedule.floating_blocks` YAML; lunch auto-promoted. Elastic within window, day-scoped via `days: []`. Moving OUT of window needs `create_approval(kind=lunch_bump)`.
- **Coord MOVE intent** (v2.1.1) — `coord_jobs.intent: 'schedule' | 'move'`. Move-coords reshuffle an existing event via `updateMeeting` on the occurrence id (series untouched for recurring).
- **Approval reminder + work-time expiry** (v2.1.3) — DM at halfway of approval window; expiry rebased off owner's next work time so 20:00 approvals don't lose 13 off-hours.
- **Smart health-check window** (v2.1.4) — `computeHealthCheckWindow(profile)` default; cadence cap via `getNextSeriesOccurrenceAfter`.
- **Attendee-only guards** (v2.1.4) — `update_meeting` / `move_meeting` refuse PATCH when owner isn't organizer. New `respond_to_invite` tool for accept/decline is filed as [#33](https://github.com/odahviing/AI-Executive-Assistant/issues/33), not built yet.
- **Third-party-booking verifier** (v2.1.4) — `outreach_jobs.proposed_slots` + `subject_keyword` columns; brief matches pending outreach against calendar events, narrates "Michal booked it" instead of "still waiting". Honors `await_reply=0`.
- **Colleague-surface hygiene** (v2.1.5) — `shadowNotify` requires cached owner-DM match before in-thread; recovery pass skipped on colleague turns; `get_free_busy` colleague-context synthesizes out-of-hours busy. Three independent guards, all code-enforced.
- **Social layer** (v2.1.2) — stale threshold dropped to 2, seed topics injected when pool empty, "MUST ask" when silent 72h+, VARIETY > recency.

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

1. **Autonomy refinement.** The autonomy layer works; next round is tightening: retry-on-refusal (#32), tentative-reservation lifecycle (#30), invite-response tool (#33).
2. **Transport additions.** Email + WhatsApp connectors sit behind the Connection interface built in v2.0.0. #22 gates real work on them.
3. **Daily QA from real use.** Every brief + every coord exposes bugs. Pattern from this session: owner sends a screenshot, I trace against code, propose, wait for green light.

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

### Version
- Bump patch (1.x.y → 1.x.y+1) when: bug fixes, small improvements, prompt tweaks, file rename/split without behavior change
- Bump minor (x.y → x.y+1) when: a meaningful new capability, a new skill, a significant behavior change, a schema migration that needs explaining
- Never bump major (x.0) without explicit instruction
- Update package.json version at the end of every session where code changed

### Version-bump workflow (what to do at each level)
- **PATCH** — keep it light. Update `package.json` version + add the `CHANGELOG.md` entry. THAT'S IT. Do NOT commit, do NOT push, do NOT touch memory files or README. The owner runs the patch locally and bundles when ready.
- **MINOR** — full wrap-up. Update `package.json` + `CHANGELOG.md` + `README.md` (if architecture/public behavior changed) + both memory files + run `npm run typecheck` + commit + push + update/open relevant GitHub issues.
- **MAJOR** — full wrap-up + explicit user instruction required.
- If unsure whether the work is patch- or minor-sized: ASK before doing the wrap-up.

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
