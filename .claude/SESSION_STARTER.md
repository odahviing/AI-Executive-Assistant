## Maelle session context

We are working on the Maelle project at E:/Code/Maelle.
Current version: check package.json — it is the source of truth.

Read these two memory files before doing anything:
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_overview.md
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_architecture.md

---

## Active work — issue #1 (Connection interface rollout)

We are mid-way through [issue #1](https://github.com/odahviing/AI-Executive-Assistant/issues/1). Each sub-phase ships as its own patch version so the owner can test incrementally; v1.9.0 is reserved for the milestone when every port is stable.

### Progress so far

- **Sub-phase A — v1.8.9** ✅ Shipped. Connection interface + PersonRef + RoutingPolicy + per-profile registry + Router with 4-layer policy + SlackConnection factory + `SkillContext.inboundConnectionId` plumbed through. Pure additions, zero behavior change.
- **Sub-phase B — v1.8.10** ✅ Shipped. SummarySkill ported to Connection interface (reference consumer). `findUserByName` / `findChannelByName` / `sendDM` / `sendMpim` / `postToChannel` all go through `slackConn.*` now.
- **Sub-phase C — v1.8.11** ✅ Shipped. OutreachCoreSkill moved from `src/core/outreach.ts` to `src/skills/outreach.ts`. `message_colleague` sends synchronously via Connection now (no more `_requires_slack_client` indirection). `outreach_send` dispatcher ported too. `send_outreach_dm` + `post_to_channel` SlackAction handlers removed from app.ts.

### NEXT — sub-phase D (coord.ts port) — HIGH RISK

**Start fresh.** Before writing any code for sub-phase D, do a full analysis pass:

1. Read `src/connectors/slack/coord.ts` top-to-bottom (1244 lines) and map every exported function + every internal helper
2. Categorize each piece:
   - **Pure domain logic** (state transitions, slot resolution, ping-pong decision) → moves to `src/skills/meetings/coord/`
   - **Slack transport logic** (DM sending, channel posts, thread management) → stays in `connectors/slack/` but refactored to implement a narrow transport interface
   - **Already in coord/utils.ts** (v1.6.3 split) → stays, but imports may shift
3. Catalogue the DB touchpoints (`coord_jobs` schema: proposed_slots JSON, participants JSON, requesters, external_event_id, winning_slot, etc.) — every one must be preserved byte-for-byte
4. Catalogue the integration points: background cron (coord_nudge + coord_abandon tasks), approvals layer (`emitWaitingOwnerApproval`), MPIM coord (contacted_via='group'), owner auto-include for colleague-initiated coord, intent-routed reschedule (v1.8.4 — hands off to meetingReschedule.ts already)
5. Propose the sub-sub-phase structure **before writing any code**. Getting this wrong causes regressions in the meeting coord flow — the most user-visible part of Maelle.

**Do not try to port coord.ts in one commit.** Break it into smaller verifiable steps. Ship each step as its own patch (1.8.12, 1.8.13, etc.) if it simplifies rollback.

**Key invariants to preserve:**
- Multi-party coord flow (propose slots → DM participants → collect → negotiate → book)
- MPIM coord flow (in-group variant, contacted_via='group')
- Reschedule intent flow (v1.8.4 — colleague replies yes → move existing meeting, not create new)
- `emitWaitingOwnerApproval` → approvals layer integration
- Booking confirmation posts in the original coord DM thread, not a new top-level DM (v1.8.6 fix)
- Owner auto-inclusion for colleague-initiated coord
- Coord state machine statuses: collecting / resolving / negotiating / waiting_owner / confirmed / booked / cancelled / abandoned

### Remaining sub-phases after D

- **E (v1.8.13):** port `coordinator.ts` outreach reply classifier → `skills/outreach/replyHandler.ts`
- **F (v1.9.0):** doc sweep — SESSION_STARTER.md four-layer model, memory files, README. Close #1.

### Core architectural principles for this work

Every sub-phase must respect:
- **Skills ↔ Connections orthogonality.** Skills import only `connections/types` (Connection interface) and `connections/registry` (getConnection). They MUST NOT import from `connectors/slack/*` or `connections/slack/*`. If a Slack-specific helper is needed, either expose it on the Connection interface or keep the usage inside `connectors/slack/` code.
- **Internal is always Slack by default.** Having email/WhatsApp capability does not mean internal messages migrate. Internal work stays on Slack. Email engages only when: (a) external recipient involved, (b) inbound message came from email. Sometimes overrides.
- **Context-driven replies.** If a message came in on transport X, the reply goes back on X. The router's Layer 1 handles this via `SkillContext.inboundConnectionId`.
- **Settings-driven routing.** Profiles carry `connections.default_routing` + optional `per_skill_routing` in YAML. Other owners may route differently; don't hardcode policy.

---

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
- `src/core/assistant.ts` — **MemorySkill**: preferences, people memory, interactions, gender, notes. *(future: person memory might become a skill)*
- `src/core/outreach.ts` — **OutreachCoreSkill**: `message_colleague`, `find_slack_channel`. How Maelle speaks to people on the owner's behalf.
- `src/tasks/skill.ts` — **TasksSkill**: tasks CRUD, approvals, structured requests, briefings.
- `src/tasks/crons.ts` — **RoutinesSkill** (CronsSkill): create/list/update/delete recurring routines.
- Plus pure engine infra that isn't a Skill: `src/tasks/runner.ts`, `routineMaterializer.ts`, `lateness.ts`, `src/core/orchestrator/`, `src/core/background.ts`, `src/core/approvals/`.
- **Persona** is core too, but lives as data in the YAML profile + `orchestrator/systemPrompt.ts` — no dedicated module.

### 2. Skills (togglable — profile YAML `skills: { ... }`)
Opt-in capabilities. Some agents will do meetings, some will do research, some both. Toggled per profile.
- `src/skills/meetings.ts` — MeetingsSkill (direct calendar ops + multi-party coordination)
- `src/skills/calendarHealth.ts` — CalendarHealthSkill (issues, lunch, categories)
- `src/skills/general.ts` — SearchSkill (web_search, web_extract)
- `src/skills/research.ts` — ResearchSkill (owner-only, multi-step)
- `src/skills/_meetingsOps.ts` — **internal** helper for MeetingsSkill (the underscore prefix = "not a loadable skill, don't register it")
- `src/skills/registry.ts` + `src/skills/types.ts` — the skills-system machinery itself

Legacy profile YAML keys `scheduling: true` / `coordination: true` auto-map to `meetings: true` at load time.

### 3. Connections (framework for a comm surface)
How Maelle gets onto a given surface (Slack, email, WhatsApp, Graph). Currently hand-wired per surface; a formal `Connection` interface + registry is planned but not yet built.
- `src/connectors/slack/` — Slack Bolt app, reply routing, outreach reply classifier, coord state machine
- `src/connectors/graph/` — Microsoft Graph (calendar reads/writes, free/busy)
- `src/connectors/whatsapp.ts` — WhatsApp (placeholder)

**Known muddling (1.7 target, not yet done):** `connectors/slack/coord.ts` still contains meetings-domain state-machine logic that happens to DM via Slack. It ought to live under `skills/meetings/` and call abstract `Connection` primitives like `connection.sendDM(user, text)`. Today it's hard-coupled to Slack's API. Same story for `coordinator.ts`'s outreach reply handler. 1.6.3's size-only split extracted utils / approval-emit / booking into `coord/*.ts` files — the architectural split comes next.

### 4. Tools & Utilities
Pure cross-cutting helpers. No domain state, no registered tools.
- `src/utils/` — logger, gender detection, security gate, reply verifier, coord guard, rate limit, shadow notify, slack formatting, addressee gate
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
- **Truth-critical guards → CODE.** Anything where an LLM mistake would damage data or trust: idempotency on destructive tools (delete_meeting, create_meeting), schedule-rule enforcement in `findAvailableSlots`, date-weekday verification, action-claim verification (claim-checker runs AFTER the draft), approval-state sync on coord terminal transitions. These must behave identically across models and prompts.
- **Tone, interpretation, phrasing → PROMPT.** How Maelle describes a conflict to the owner, how she asks a clarifying question, how she formats a slot proposal, how she disambiguates a two-clause request. Code can't judge "what sounds human."
- **When a bug shows up:** first ask which kind it is. "She proposed 17:05 instead of 17:15" is a DETERMINISM bug — quarter-hour alignment belongs in code and in the tool contract. "She sounded robotic when the slot was blocked" is a JUDGMENT bug — fix in prompt.
- **Do not cram determinism into prompts.** A prompt rule saying "always align to :00/:15/:30/:45" rots under model swap. The tool that returns the slot should only return aligned slots.
- **Do not cram judgment into code.** A regex trying to detect "is this message a relay commitment" will miss 10% of cases and add false positives. An LLM pass over the draft can classify by meaning.
- **Short prompt rules beat long ones.** One sentence the model actually reads is worth ten it skims. When in doubt: delete a rule, don't add one. Measure prompt size regularly (see 1.6.13-14 for how we cut ~40%).

### Version
- Bump patch (1.x.y → 1.x.y+1) when: bug fixes, small improvements, prompt tweaks, file rename/split without behavior change
- Bump minor (1.x → 1.x+1) when: a meaningful new capability, a new skill, a significant behavior change, a schema migration that needs explaining
- Never bump major (2.0) without explicit instruction
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
- Internal helpers in `skills/`: prefix filename with underscore (e.g. `_meetingsOps.ts`)
- Core module pattern: new core capability = new file in `src/core/` + added to `CORE_MODULES` in `registry.ts` + added to `CoreModuleId` union
- DB changes: idempotent migrations via `try { ALTER TABLE } catch {}` or `CREATE TABLE IF NOT EXISTS` in `db/client.ts` initSchema()
- All times: UTC in storage, Luxon for display in user timezone
- All LLM calls: `claude-sonnet-4-6` (no Haiku anywhere)
- Lazy skill loading: use `require()` inside `loader()` so one broken skill doesn't crash startup
- Every task creation, dispatch, and lifecycle transition: `logger.info` with `skill_origin`, `skill_ref`, `due_at`, preview fields
- Task system owns every async job — creating a background sweep that walks its own table is an anti-pattern; schedule a typed task instead

### Before finishing any session
1. `npm run typecheck` — must pass
2. Update package.json version if code changed
3. Update CHANGELOG.md (entry per version, always)
4. Update README.md if architecture changed
5. Update the two memory files if something significant changed
