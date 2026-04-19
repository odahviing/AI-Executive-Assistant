## Maelle session context

We are working on the Maelle project at E:/Code/Maelle.
Current version: check package.json — it is the source of truth.

Read these two memory files before doing anything:
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_overview.md
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_architecture.md

---

## Where we are — v2.0.0 just shipped

Issue #1 (Connection interface rollout) is closed. The whole messaging layer is now abstracted: skills import only `connections/types` + `connections/registry`, and all three transports (Slack / email / WhatsApp — Slack is the only one wired up today, the other two are on the roadmap) will plug in through the same `Connection` interface. The coord state machine moved from `connectors/slack/coord*` to `src/skills/meetings/coord/`. `shadowNotify`, coord dispatchers, and every skill file are transport-agnostic — zero `@slack/bolt` imports outside `src/connectors/slack/` and `src/connections/slack/`.

## Focus for v2.x

Two priorities now that the framework is clean:

1. **Make sure the framework scales when needed.** The four-layer split is honest for the first time. Every new capability we add has to respect the boundary:
   - Skills speak through `Connection` primitives — never `app.client.*` anywhere under `src/skills/`.
   - New core modules go through `src/core/` + `CORE_MODULES` registry.
   - Transport additions (email, WhatsApp) implement the `Connection` interface in `src/connections/<name>/` and register themselves at startup in `connectors/<name>/app.ts` (or equivalent).
   - Task dispatchers that send messages MUST resolve their transport via `getConnection(ownerId, 'slack')` — don't reach for `app.client.*` directly.
   - If you're tempted to cross a boundary "just for this one thing," that's the signal to either extend the `Connection` interface or add a new layer-4 utility.

2. **Build new features now that v1 items are finally past us.** The roadmap is in the README:
   - WhatsApp owner-sync connector (second `Connection` implementation — biggest integration test of the port)
   - Email connector (third transport)
   - Inbound workflows (triggers that run skills end-to-end)
   - Meeting notes preparation (1:1 briefs + post-meeting summaries)
   - Plus anything else that comes up in day-to-day use.

## Bugs are expected

External QA starts now — more people testing, new usage patterns, new classes of bugs. When one lands, follow the usual flow (propose, don't fix; verify in code before trusting memory; code for determinism, prompts for judgment).

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
