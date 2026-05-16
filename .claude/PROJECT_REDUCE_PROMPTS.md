# Project — Reduce prompt size by moving rules to code

**Scope:** ongoing project (not a single version). Each module ships as its own patch when ready. Track progress against [GitHub #95](https://github.com/odahviing/AI-Executive-Assistant/issues/95).

**Trigger phrase for a new chat:** paste this whole file as the first message, then start with "let's work on module D" / "let's work on prompt reduction" / "let's continue #95."

---

## Read first (every session)

Before touching anything in this project, load context the normal way:

1. `C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/MEMORY.md` — auto-memory index (project state)
2. `C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_overview.md` — long-form state
3. `E:/Code/Maelle/.claude/SESSION_STARTER.md` — current version, recent waves, operational state
4. `E:/Code/Maelle/CLAUDE.md` — shell command rules (no `cd` prefix etc.)
5. **This file** — project-specific focus + plan

If anything in (1-3) contradicts this file, this file wins for this project's work.

---

## Why this project exists

Owner-DM turn cost was measured 2026-05-15 at ~50,900 tokens per turn:

```
Owner DM system prompt              ~27,886 tokens
  ├─ static (cached, 5min window)   ~24,624 tokens
  └─ dynamic (fresh every turn)      ~3,261 tokens
Owner tools JSON (NOT cached)       ~23,026 tokens
──────────────────────────────────────────────────
TOTAL per owner turn                ~50,912 tokens
```

The 2.7.5 cache restructure pushed ~7k tokens from dynamic to static — good win, no behavior change. The next wave is **shrinking the absolute total** by replacing prompt rules with deterministic code wherever possible.

**Owner direction (verbatim):**
> "I want to start killing the prompt. It's too long and you keep adding instructions that Sonnet ignores. We have high level prompt, we have skills specific prompt, and they together can't be millions of lines of prompt. We should trust Sonnet and have code to make her do less mistakes."
>
> "We are not building external tools solutions to check other tools — find_slot should just take the list of people to check if they are free or not."
>
> "Find options for reduction by moving to code, not removing prompt or merging stuff."

**Operating principle:** trust Sonnet's judgment; use code to PREVENT mistakes deterministically. Don't merge rules. Don't delete rules just to delete them. Find rules that code can enforce, build the code, then delete the rule.

---

## The plan — 7 modules, ~1,000 lines of code total

Build order — lowest-risk first. Each module ships as its own version bump (patch).

| # | Module | Lines | Token cut | Risk | Status |
|---|---|---|---|---|---|
| D | Auto-resolve thread-bound vague-yes | ~120 | ~150 | low | **✅ shipped 2.7.7** |
| A | Voice/tone post-draft scrubber | ~250 | ~450 | low | **TODO** |
| B | Hebrew output processor | ~200 | ~250 | low | **TODO** |
| F | Honesty rules → extended claimChecker | ~200 | ~625 | medium | **✅ shipped 2.8.1** |
| E | Length / repetition validator | ~120 | ~375 | medium | **✅ partial shipped 2.8.1** (re_asked_after_convergence + re_asked_own_question booleans; too_long_for_context deliberately skipped) |
| C | Refusal humanizer extension | ~150 | ~375 | medium | **✅ shipped 2.8.1** (humanGate MECHANICAL REFUSAL section) |
| G | Intent-aware tool selection | ~250 | ~11,000 | **high** | **✅ shipped 2.7.7** |

**Remaining: Modules A + B only.** Combined estimate: ~450 lines, ~700 token cut. Both low risk.

**Total expected reduction across all 7 modules: ~13,200 tokens per turn (~26% of the ~50,900 baseline).** To go further than 26% would require consolidating judgment-only rules (LANGUAGE / AUTHORIZATION colleague-side / ownerLearningSection) — separate decision when we get there.

### Module D — Auto-resolve thread-bound vague-yes (~120 lines, ~150 tokens cut)

**What:** when owner replies in a thread that matches an awaiting approval's `terminal_dm_msg_ts` AND the message is a short ack ("yes" / "go" / "ok" / "do it" / "כן" / "אישור"), call `resolveApproval(approve)` deterministically BEFORE invoking the orchestrator. The vague-yes never reaches Sonnet.

**Files:**
- New: `src/utils/threadBoundApprovalAutoResolve.ts` — detect + resolve.
- Edit: `src/connectors/slack/postReply.ts` (or inbound path) — call it early.

**Prompt deletion:** `PENDING APPROVALS Binding rules` block in `src/core/orchestrator/systemPrompt.ts` (~600 chars / ~150 tokens). Keep the listing of approvals; delete the prose about how to bind.

**Risk:** low. Pure code-side. Sonnet behavior unchanged for non-ack replies.

**Validation:** after deploy, owner replies "yes" in a thread with `← THIS THREAD` marker → approval resolves without an orchestrator turn. Watch logs for `auto-resolved thread-bound approval`.

### Module A — Voice/tone post-draft scrubber + retry (~250 lines, ~450 tokens cut)

**What:** post-draft regex pass on every reply.
- Em-dashes (`—`) → auto-replace with comma or period
- Separator-hyphens (`text - text`) at sentence level → auto-replace with period or comma
- Banned word detection (`the system`, `force`, `threshold`, `policy`, `rule`, `constraint`, `configuration`) → trigger retry via `humanGate`
- Internals leaks (`the X tool`, `_fieldName`, `the check`, `my tools`) → trigger retry
- Deliberation markers (`Actually wait`, `On second thought`, `Let me think`, `On the other hand`, `Per the instructions`) → trigger retry

**Files:**
- New: `src/utils/voiceScrubber.ts`.
- Edit: `src/connectors/slack/postReply.ts` — wire into existing post-draft chain (alongside `humanGate` and `claimChecker`).

**Prompt deletion:** in `src/core/orchestrator/systemPrompt.ts`:
- `PUNCTUATION` block
- `NEVER SOUND LIKE A MACHINE` (keep the principle as one sentence; delete the banned-words list + examples)
- `INTERNALS STAY INSIDE`
- `NO INTERNAL DELIBERATION`

Total: ~1,800 chars / ~450 tokens.

**Risk:** low. Regex-deterministic. Auto-fixes are reversible (no false positives that matter — em-dash to comma is universally fine).

**Validation:** `scripts/measure-prompts.cjs` should show owner-DM static block drop by ~450 tokens.

### Module B — Hebrew output processor (~200 lines, ~250 tokens cut)

**What:** detect reply language. When Hebrew:
- Strip markdown chars (`*` / `_` / `` ` ``) — RTL renders them garbled
- Substitute English names → `name_he` when known from people_memory
- Detect slash-gender forms (`את/ה`, `שואל/ת`) when target's gender is in DB → trigger retry to use the right form
- Detect Latin letters embedded in Hebrew text → trigger retry to transliterate

**Files:**
- New: `src/utils/hebrewProcessor.ts`.
- Edit: `src/connectors/slack/postReply.ts` — wire in.

**Prompt deletion:** `HEBREW OUTPUT` + `HEBREW GENDERED FORMS` blocks in `systemPrompt.ts` (~1,000 chars / ~250 tokens). Keep one short line: "Hebrew replies are post-processed for markdown stripping and known-name substitution."

**Risk:** low. Hebrew detection is deterministic (Unicode range U+0590–U+05FF). Auto-substitutions are reversible.

### Module F — Honesty rules → extended claimChecker (~200 lines, ~625 tokens cut)

**What:** extend `src/utils/claimChecker.ts` to catch each `RULE` variant as its own check:
- RULE 1 (never confirm un-fired action) — already covered, verify
- RULE 2 (never claim verified) — already covered, verify
- RULE 2b (re-asking known facts from prior replies) — NEW heuristic: scan prior assistant messages for facts the current draft asks about
- RULE 2c (recovery narrative invention) — already partially covered, tighten
- RULE 2d (close the loop) — already automated via `closeLoopOnOwnerHandled` scanner; PROMPT RULE IS REDUNDANT
- RULE 3 (relay promise without tool call) — extend regex for forward-looking commits ("I'll take care of", "I'll handle", "I'll update you", "I'll move the series") — closes the 2026-05-15 "I'll take care of the recurring series moves" hallucination
- RULE 5b (contradiction → admit, don't invent) — NEW heuristic
- RULE 9 (verify, don't echo for calendar reviews) — NEW: when reply is a calendar review AND `get_calendar` wasn't called this turn, retry

**Files:**
- Edit: `src/utils/claimChecker.ts` — extend rules.
- Possibly edit: `src/utils/closeLoopOnOwnerHandled.ts` (already covers 2d).

**Prompt deletion:** `HONESTY RULES 1, 2, 2b, 2c, 2d, 3, 5b, 9` in `systemPrompt.ts` (~2,500 chars / ~625 tokens). Keep RULE 4 / 5 / 8 (short, judgment-only — not code-replaceable).

**Risk:** medium. Each rule extension needs careful retry-instruction wording so Sonnet doesn't loop.

### Module E — Length / repetition validator (~120 lines, ~375 tokens cut)

**What:** post-draft heuristic check:
- Reply > 500 chars AND owner didn't ask for detail → retry with "be concise"
- Reply contains "Want me to..." AND prior user message was confirming ("yes / go / ok / do it / I already said yes") → retry (deterministic enforcement of `CONVERGENCE IS BINDING`)
- Reply re-asks a question already in the assistant's own recent history → retry

**Files:**
- New: `src/utils/replyValidator.ts`.
- Edit: `src/connectors/slack/postReply.ts`.

**Prompt deletion:** `TONE` + `CONCISION` + much of `RULE 7` in `systemPrompt.ts` (~1,500 chars / ~375 tokens).

**Risk:** medium. False positives on "want me to" patterns when owner DIDN'T just confirm — heuristic needs tuning.

### Module C — Refusal humanizer extension (~150 lines, ~375 tokens cut)

**What:** extend `src/utils/humanGate.ts` trigger list to catch mechanical phrasings in colleague-facing replies:
- "I don't have permission", "Access denied", "not_permitted"
- "tool" mentions ("the X tool")
- "approval required", "outside scope"
- Structured error codes echoed back verbatim

On hit, retry with explicit reframing instruction ("rephrase as if a human EA who's refusing politely").

**Files:**
- Edit: `src/utils/humanGate.ts` — extend trigger list.

**Prompt deletion:** `REFUSAL PHRASING` block + half of `CANNOT-REACH RULE` banned examples in `systemPrompt.ts` (~1,500 chars / ~375 tokens).

**Risk:** medium. Heuristic; tuning needed.

### Module G — Intent-aware tool selection (~250 lines, ~11,000 tokens cut)

**What:** the BIGGEST lever. Currently every owner turn ships all ~23k tokens of tool descriptions to Sonnet. Most turns don't need most tools. Pre-Sonnet pass via existing `classifyOwnerIntent` extended with a `tool_scope` output: `'meetings' | 'social' | 'tasks' | 'knowledge' | 'general'`.

`getSkillTools()` filters to relevant scope + an always-on core (`message_colleague`, `create_task`, `create_approval`, etc — the cross-cutting essentials).

**Recovery:** if Sonnet's reasoning hits `tool_use` with a tool not in scope (means classifyOwnerIntent misclassified), the orchestrator catches the implicit failure, widens scope to all tools, and retries one time.

**Files:**
- Edit: `src/core/social/classifyOwnerIntent.ts` — add `tool_scope` to output schema.
- Edit: `src/skills/registry.ts:getSkillTools()` — accept scope filter, apply.
- Edit: `src/core/orchestrator/index.ts` — pass scope, wire recovery on retry.

**Prompt deletion:** nothing from system prompt; cuts tools from ~23k → ~12k tokens per turn (~11,000 saved).

**Risk:** HIGH. Misclassification → Sonnet doesn't have the right tool → conversation breaks. Recovery path is the safety net. Build with extensive logging + a feature flag (`config.intent_aware_tools: true|false` in profile yaml) so we can flip off if it breaks anything.

---

## Build cadence

- **One module per patch.** Each ships its own version bump (patch). Don't bundle multiple modules into one wrap.
- **Order matters.** D → A → B → F → E → C → G. Earlier modules de-risk later ones (e.g. Module A's voice scrubber means Module F's claimChecker extensions have a working post-draft retry harness to plug into).
- **Measure after every module.** Run `node scripts/measure-prompts.cjs` before and after each module ships. Record the delta in the CHANGELOG entry. Real numbers, not estimates.
- **Wrap each module** via the standard `wrap` skill (PATCH unless owner says otherwise). Owner runs `npm run dev` locally; restart picks up.

---

## Standing rules — non-negotiable for this project

These come from `CLAUDE.md` + the owner's repeated corrections. Don't drift.

1. **Propose first, build after explicit approval.** Even when the change feels small/obvious. Don't write code in response to a chat message that didn't say "go" / "build" / "do it" — write the proposal, wait for approval. (Multiple corrections in 2026-05-14 / 15 sessions when the agent jumped to code.)
2. **Build-only words are NOT bundle words.** `go` / `yes` / `ok` / `do this` / `start building` / `build it` / `land it` / `fix it` → code + typecheck + STOP. Never bump version, never commit, never push without an explicit bundle word: `wrap` / `ship` / `commit` / `bundle` / `close the patch` / `cut a version` / `let's finish for today`.
3. **Default version bump is PATCH.** Owner has corrected `minor` overreach multiple times. Only bump minor if owner explicitly says so. New module = patch (unless it's a schema migration).
4. **No new prompt rules to "fix" things.** This whole project is about REDUCING prompt. Adding rules during code-replacement work would defeat it. Only exception: if a new short rule replaces a longer one being deleted (net negative).
5. **No personal info in code.** Owner names, company names, domains, durations all live in `profile.*`. Code reads from profile, never literals. Repo is public.
6. **`humanGate` is a separate concern from `securityGate`** (owner direction). Don't merge them. Each is single-purpose.
7. **Shadow DM is a passive log only.** Never design a flow that requires owner to read or act on a shadow DM.
8. **Slack: no `cd <path> &&` prefix on commands.** Use `git -C E:/Code/Maelle ...` or absolute paths. (See `CLAUDE.md`.)
9. **Trust the tool, not the prompt rule.** When in doubt about whether a rule belongs in prompt or code: if it's deterministic (regex, lookup, state check), it's code. If it's judgment (tone, interpretation, phrasing), it's prompt.

---

## How to validate progress

```bash
node scripts/measure-prompts.cjs
```

Records:
- Owner DM full system prompt (chars + tokens)
- Static / dynamic breakdown
- Tools JSON size
- Top 10 tools by size
- Sidecar Sonnet call prompt sizes

Re-run after every module ships. Record the delta in the CHANGELOG entry. Goal: each module's CHANGELOG entry says "owner-DM system prompt: BEFORE → AFTER (-N tokens)" with real measurements.

---

## Operational state (as of 2026-05-15, v2.7.5)

- **PM2 + deploy watcher are OFF.** Owner runs `npm run dev` directly; restart picks up changes.
- **Auto-triage + auto-build are OFF.** Both workflows gated `if: false &&` in tree. GitHub is still the bug data source; owner files issues / shows screenshots, we fix interactively.
- **processedDedup TTL is 10 min** — covers Slack socket-mode reconnect window after restart.
- **Catch-up icon** is `↩️` with U+FE0F variation selector.
- **Slack assistant-panel registry** is DB-backed (SQLite `assistant_threads` table, 24h TTL). Survives restart. First-time only: existing open panel threads need one close+reopen to register.

---

## Open questions for the new chat

These are things to surface to the owner early in the project (not before doing the work, but during):

1. **Module G feature flag location** — `config.intent_aware_tools` in profile yaml, or a global `.env` flag? Owner preference?
2. **Module D scope** — only "thread-bound vague yes" (single-approval), or also vague-yes when there's only ONE pending approval period (no thread match needed)?
3. **Module F retry budget** — claimChecker already has a retry counter. How many extensions per turn before we give up and ship the draft as-is?
4. **Cadence yaml description** (2026-05-15 leftover) — owner needs to tighten his yaml so "CISO as a Service" doesn't auto-tag Cadence. Not part of this project but worth checking on first session.

---

## Quick orientation: where things live

- **Owner-DM system prompt builder:** `src/core/orchestrator/systemPrompt.ts` (`buildSystemPromptParts`)
- **Skills prompt sections:** `src/skills/*.ts` (each skill's `promptSection()` is the cached static part)
- **Tool descriptions:** in each skill file's `tools()` return value (`description` field)
- **Post-draft gates:** `src/utils/{claimChecker,humanGate,securityGate,dateVerifier,coordGuard,addresseeGate,imageGuard}.ts`
- **Orchestrator entry:** `src/core/orchestrator/index.ts`
- **Slack inbound + post-reply:** `src/connectors/slack/{app.ts,postReply.ts,inboundQueue.ts}`
- **Measurement:** `scripts/measure-prompts.cjs`
- **This project's issue:** [#95](https://github.com/odahviing/issues/95)
