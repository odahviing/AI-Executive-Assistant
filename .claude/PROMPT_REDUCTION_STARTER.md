# Prompt-reduction — session starter & standing guard (updated 2026-05-31)

**How to use:** paste this file as the first message of a new chat, then say
"let's keep cutting the prompt" / "prompt-reduction guard". You are the **guard
that keeps Maelle's prompt small and keeps shrinking it** — without breaking
behavior. Read MEMORY.md, project_overview.md, SESSION_STARTER.md, CLAUDE.md the
normal way first; this file is the project-specific focus and wins for this work.

---

## The mission, in one line

Cut the per-turn token cost of Maelle's orchestrator prompt by **moving rules
into code**, not by deleting judgment — and never let it grow back.

## The goal & non-negotiable principles

- **MODIFY, don't INCREASE.** The prompt is a fixed budget, not a junk drawer.
  Net prompt should go *down* every session. If you must touch it, delete or
  tighten an existing rule — don't add a new one. Returning a little back is OK
  *if you write it better/smaller* (we've done that twice; see below).
- **CODE-FIRST, always.** The durable fix is deterministic enforcement at the
  chokepoint (a handler guard, a tool return-value the model reacts to, a tool
  that owns the decision). Code is fixed-once, zero-prompt-cost, language-
  agnostic. Prompt is the LAST resort, and ONLY for judgment / tone / format /
  language / narration — never to *enforce* something code can.
- **No regex on natural language.** Maelle is multilingual (Hebrew, Russian,
  Spanish, English…). Word-count/length gates and structured-field checks are
  fine; pattern-matching *meaning* in message text is not.
- **Measure with real numbers, before and after every cut.** Never cut on an
  estimate. Record before→after in the CHANGELOG.
- **Structured data > prose.** When a convention must reach the model, prefer a
  structured field surfaced as one compact line (e.g. category `title_hint`)
  over a multi-sentence prose block.

---

## Current status (as of 3.1.8, 2026-05-31)

**Common owner scheduling turn: ~59K → ~36K tokens (−39%).** Breakdown of a
typical `meetings`-scoped turn now:
- static (skills prose, cached): **~18–19K** (was ~27.7K)
- tools JSON (scoped): **~15K** (was ~25K all-tools; ~22.7K on the old meetings scope)
- dynamic (fresh every turn): **~2.9K** (was ~8.9K)

Note: a turn that widens to `general` (ambiguous/short replies) still ships all
~25K of tools — that's the safe fallback, not the common case.

Version trail: 3.1.4 (tool-scoping landed), 3.1.5 (prose lazy-load + dedup +
off-grid slot-align fix), 3.1.6 (regression fixes). 3.1.7/3.1.8 were *other*
projects (Person Store, search rebuild) — not ours.

---

## What's shipped (the levers, biggest first)

1. **Dynamic contacts → roster + on-demand pull.** The WORKSPACE CONTACTS block
   used to inline every contact's ★notes + ↳history every turn (~6K, fresh
   billed). Now: one compact identity line per contact + a "N notes on file"
   hint; `get_person_memory` was extended to return the ★notes + recent ↳history
   so the data loads on demand. Dynamic 8.9K → 2.9K. (`db/people.ts`, `assistant.ts`)
2. **Tool scoping (Module G).** `ALWAYS_ON` slimmed 22 → 12. New scopes:
   `coord` (rare multi-party — `coordinate_meeting` et al., barely fires),
   `calendar` (review/health), `people` (person-writes). Rare/expensive tools
   demoted off the every-turn surface. Gated by `behavior.intent_aware_tools`.
   (`skills/registry.ts`, `core/social/classifyTurn.ts`)
3. **Prose lazy-loading.** Coordination ROUTE-1 details, SUMMARIES, KNOWLEDGE
   BASE, EXTERNAL VENUES, and CALENDAR-HEALTH prose render only when their scope
   is active. `scopes` is plumbed through `buildSystemPromptParts` → each skill's
   `getSystemPromptSection(profile, scopes, isOwner, channel)`. (The intermediate
   `buildSkillsPromptSection` helper was DELETED on 2026-07-28: once the assembly
   loop gained a reachability filter and a `news` exception, the exported copy was a
   second spelling of one job that no longer matched what production rendered — and
   `scripts/measure-prompt.ts` was sizing the budget against that phantom.)
   `coord`/`calendar` deterministically union `meetings`; `freeTimeInquiry` unions `calendar`.
4. **Static dedup/trim.** Removed the duplicate EVENT CATEGORIES block (kept the
   richer MeetingsSkill copy), collapsed the dead location decision tree
   (`resolveLocation` owns it), category descriptions → first-sentence cues
   (`detectCategory` reads the full text server-side), about-you self-notes
   deduped, several meetings prose blocks deduped against their canonical copy.
5. **Tool-description dedup (small).** `rank_venue` legend, `create_meeting`
   LANGUAGE restatement, `colleague_slack_id` warning — ~150t. (Descriptions are
   mostly *distinct*, so this lever is small.)

---

## Hard-won lessons & risks (don't relearn these)

- **Scoping has NO mid-turn recovery.** If the Haiku scope-classifier misroutes,
  a needed tool is simply absent and the turn breaks — there's no widen-on-miss
  retry. Real bug (2026-05-31): a 1-3 word reply "meeting" was tagged
  `knowledge`, which dropped `set_event_category` → "I can't from my end."
  Mitigations shipped: **low-signal short replies (≤3 words) widen to `general`**;
  the classifier already gets the thread (`recentContext`) but can still be
  confidently wrong. **Building a real widen-on-miss recovery is the prerequisite
  for any *more* aggressive scoping.**
- **Prose dedup over-cuts twice.** Removing "redundant" prose lost a unique
  nuance: (a) zero-slot narration ("she's booked" misattribution when the real
  blocker was the owner's own calendar), (b) bare-"Interview" subject (the
  category first-sentence trim dropped the discretion convention). Both restored
  — as a **sharpened compact line** and a **structured `title_hint` field**, not
  the original block. A re-audit of the other 5 dedups found only 1 minor
  over-cut. Lesson: a multi-sentence block often carries one load-bearing
  sentence the "covered elsewhere" copy doesn't.
- **`calendar` scope is the riskiest** (no graceful fallback if a review turn
  misroutes). Mitigated by keeping the health *tools* in `meetings` (always
  present on a scheduling turn) and gating only the *prose*.
- **Cache fragmentation.** Per-turn scope subsets fragment the cached prefix
  (each distinct subset = a fresh $3.75/M cache-create). Keep scopes FEW and
  STABLE; widening to `general` is cheap *correctness* insurance but a *different*
  cache prefix.
- **The original "it's all prose" estimate was wrong.** Tool definitions +
  the dynamic contacts dump were the real mass. Measure first, every time.

## The kill-switch

`behavior.intent_aware_tools: false` in `config/users/idan.yaml` → `toolScopes`
stays undefined → the **entire scoping + prose-lazy-load layer fail-opens**
(every tool + all prose ship). It does NOT revert the pure dedups. This is the
A/B test and the panic button for any scoping-caused regression.

---

## Remaining work (ranked — what's still on the table)

1. **MEETINGS SKILL static prose (~12–13K) — the big remaining mass.** Paper-
   traced across 4 agents: **most is KEEP** (genuine judgment — audience-aware
   narration, reporting style, honesty, soft scheduling preferences with zero
   code backstop). Realistic trim ≈ **2–4K**, mostly dedups + moving tool-enforced
   rules into (scoped) tool descriptions. Only the first dedup batch (~640t +
   restores) is done. This is the careful, paper-trace-each-block round — code-
   verify each rule is enforced before cutting; restore unique nuance as
   structured data.
2. **Build the widen-on-miss recovery** for scoping. Until this exists, don't
   scope more aggressively — fragility outweighs the savings.
3. **Tool-description trim** of the big tools (`find_available_slots` ~2.7K,
   `create_meeting` ~1.6K, `message_colleague` ~1.5K, `book_floating_block`
   ~1.3K). They're mini-prompts with embedded rules/examples — push rules into
   scoped skill prose, keep schema + one example. ~3K, but verify each (the
   description is the tool's contract; trimming the wrong line breaks behavior).
4. **Dynamic block** is mostly done (~2.9K). Diminishing returns.

**Target:** the dream is **< 25K** on the common turn (we're at ~36K). Getting
there means #1 + #3 done carefully, and likely #2 first to make further scoping
safe. Don't force it — a trust regression costs more than the tokens.

---

## Measurement & key files

- **Measure:** `node scripts/measure-prompts.cjs` (static/dynamic/tools split,
  top-10 tools). `node scripts/_dump-prompts.cjs` (dumps the rendered blocks +
  **per-scope** tool/prose sizes — use this to see what a `meetings` vs
  `general` turn actually ships). Run before/after every cut.
- **Prompt builder:** `src/core/orchestrator/systemPrompt.ts`
  (`buildSystemPromptParts` — static at ~line 270+, returns {static, dynamic};
  threads `toolScopes`).
- **Scopes:** `src/skills/registry.ts` (`ALWAYS_ON_TOOLS`, `SCOPE_TO_TOOLS`,
  `filterToolsByScope` — coord/calendar→meetings unions) +
  `src/core/social/classifyTurn.ts` (the Haiku scope classifier + scope
  descriptions + the low-signal short-reply widen).
- **Skill prose:** each `src/skills/*.ts` `getSystemPromptSection(profile, scopes)`.
  Meetings is the big one (`src/skills/meetings.ts`).
- **Code that already owns rules** (cite these when arguing "move to code"):
  `resolveLocation`, `detectCategory`, `scheduleRules.checkSlot`,
  `alignNearestQuarter` (floatingBlocks), `findAvailableSlots` returns
  `day_summary`/`broken_rule_label`/`per_attendee_local`.

## Standing rules (from CLAUDE.md + this project)

- Propose first; build only on an explicit per-item "go". Bundle/version only on
  "wrap/ship". Default bump = PATCH.
- No personal info in code (repo is public) — read from `profile.*`; `idan.yaml`
  is gitignored.
- No `cd <path> &&` prefix on shell commands; one logical command per Bash call.
- The bug-fixing philosophy now lives in `SESSION_STARTER.md` ("How we fix bugs")
  and the `bugs`/`github` skills (code-first ranking, no-regex, verify-already-
  fixed-first). Reuse it — many "regressions" are over-cuts to restore compactly,
  and some "open bugs" are already fixed.
