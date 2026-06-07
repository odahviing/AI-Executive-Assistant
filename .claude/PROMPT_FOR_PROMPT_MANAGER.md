# Prompt-manager task — two prompt-caching wins (M-10 + M-17)

Two independent changes, both about Anthropic **prompt caching breakpoints**. Both are propose-first: read the cited code, confirm the current block structure, then design the split. Do NOT let any per-turn/volatile content drift into a cached block — see invariant #2 in `docs/AGENT_LOOP_INVARIANTS.md` ("cache_control attaches to the static block only; if static becomes dynamic, every turn invalidates the cache → cost explodes silently").

---

## ⚠ Heads-up — recent changes that affect BOTH tasks (de-tenant / memory-layer arc, v3.2.x→3.3)

A parallel arc reshaped several prompt sections and added a **learned-preference layer**. Read this before designing either split — it changes what lives in which block:

- **Skill prompt sections now carry owner-preference MD blocks.** `formatSkillPreferencesBlock(profile, <area>)` injects `config/users/<owner>_prefs/<area>.md` at the **bottom of a skill's `getSystemPromptSection`**. Wired today: **calendar** (`calendarHealth.ts`), the **brief** compose prompt (`briefs.ts` — directly relevant to M-17), and **news** (`news.ts`). These are read **fresh per compose**, are **scope-gated** (only ship when the area is active), and **mutate when the owner re-teaches a pref**. → Treat them as **semi-static** (stable within a session until an edit), NOT deploy-stable. Also note the skills section is *already* per-turn-variable via scope-gating — verify its real byte-stability across turns before treating "skills = the cached static block" (M-10 block 1) as safe.

- **M-17's brief prompt changed this arc:** it gained (a) a generic **LANGUAGE pin** (`Intl.DisplayNames` from `profile.user.language` — not hardcoded), and (b) a `${briefPrefs}` injection at the end (brief.md). When you split: the ~5KB composing rules are cacheable-static; **langName + briefPrefs + items are the dynamic tail** (keep them out of the cached block).

- **Principle now in force — keep owner-specific content OUT of cached prompt blocks.** Per-owner TASTE lives in the learned MD layer, not the static system prompt. Don't add owner-specific rules ("Israel", "15:00", magic numbers, "call him Mr. X") to any cached block — they belong in `config/users/<owner>_prefs/`. The de-tenant sweep already removed the worst offenders (the `meetings.ts` timezone-preferences block's Israel/15:00/UK hardcoding is gone, replaced by region-free prose that leans on the slot finder's overlap clip — don't reintroduce it).

- **Working-Elsewhere narration is tool-result-driven, not prompt-driven** — `find_available_slots` / `get_calendar` / candidate-validation attach `working_elsewhere` + `_working_elsewhere_note` to their RESULTS; there is no static WE prompt rule (and none is needed).

- **Hebrew language-drift is a known watch item** — if it recurs, the fix is a **code-side post-reply script-match guard**, NOT a prompt rule (the rule at `systemPrompt.ts:473` already exists and was ignored on one turn). Don't spend prompt budget on it.

---

## M-10 — Orchestrator system-prompt cache split (add a 2nd breakpoint)

**File**: `src/core/orchestrator/index.ts:892-910`

**Current state** (verified on disk):
```
systemBlocksDynamic = [
  priorOutboundBlock, availabilityPrecheckBlock, freeTimePrecheckBlock,
  recentCalendarIssuesBlock, promptParts.dynamic, threadContextBlock,
  actionTapeBlock, colleagueBookingBlock, socialBlock, socialDirectiveBlock,
].filter(Boolean).join('\n\n')

systemBlocks = [
  { text: promptParts.static, cache_control: ephemeral },   // ONLY cached block
  { text: systemBlocksDynamic },                            // everything else, uncached
]
```

Only ONE cache breakpoint today: `promptParts.static` (skills + hard rules — stable across the whole deploy).

**The opportunity**: the dynamic blob mixes two very different lifetimes:
- **Semi-static** (changes per-day / per-edit, stable within a session): `promptParts.dynamic` = date + people + owner prefs.
- **Turn-volatile** (different every turn): prechecks (availability / freeTime / recentCalendarIssues), priorOutbound, threadContext, actionTape, colleagueBooking, social, socialDirective.

Anthropic allows up to **4 cache breakpoints**, and a breakpoint caches everything *up to and including* its block. So if we order blocks **static → semi-static → volatile** and put a 2nd `cache_control` on the semi-static block, consecutive turns in the same session reuse BOTH the skills block AND the date/people/prefs block. Today the date/people/prefs get re-sent uncached every turn.

**The design to produce**:
1. Three text blocks in this order:
   - block 1 = `promptParts.static` (cache_control ephemeral) — unchanged
   - block 2 = `promptParts.dynamic` (date/people/prefs) — **new cache_control ephemeral**
   - block 3 = the turn-volatile concatenation (prechecks + priorOutbound + threadContext + actionTape + colleagueBooking + social + socialDirective) — no cache_control
2. **Hard constraint**: block 2 must be byte-identical across consecutive turns or the breakpoint is worse than useless. Confirm `promptParts.dynamic` holds ONLY date/people/prefs and nothing turn-specific. The date string rolls at local midnight (acceptable: one miss/day). People/prefs change on edit (acceptable: miss on edit). If ANY turn-volatile signal is currently concatenated into `promptParts.dynamic`, it must be peeled out into block 3 first.
3. Re-ordering note: today `promptParts.dynamic` sits in the *middle* of the blob (after the prechecks). For the breakpoint to help it must move *before* the volatile content. Check nothing in the prechecks textually depends on appearing before the date block (it shouldn't — it's all additive context) — flag if it does.

**Win**: every owner turn after the first in a session stops re-billing the date/people/prefs tokens. Compounds across every turn. Measurable via cache-hit ratio in the usage logs.

**Risk**: medium — purely a prompt-assembly refactor, no behavior change, but a botched split (volatile leaking into block 2) silently *raises* cost. Validate with a 2-turn manual run and confirm the 2nd-turn `cache_read_input_tokens` jumps.

---

## M-17 — Cache the brief's Sonnet system prompt

**File**: `src/tasks/briefs.ts:531-597` (the brief compose call's system prompt)

**What**: the brief's Sonnet system prompt has grown to ~5KB of static composing rules and is currently sent **uncached** on every brief. The brief fires ~daily per owner PLUS on-demand re-asks; the static rules are identical each time.

**Design**: split the brief system prompt into:
- a **static rules block** with `cache_control: { type: 'ephemeral' }` (the ~5KB of composing rules), and
- a **dynamic data block** (today's items/calendar/requests) — uncached.

Same invariant #2 discipline: nothing date- or item-specific in the cached rules block. Within the 5-min cache TTL, a brief + an immediate on-demand re-ask (or two owners' briefs close together) reuse the cached rules.

**Risk**: low. Pure assembly change.

---

## Out of scope for this chat
Do not touch the colleague/owner gate stack, the news compose pass, or any tool definitions. Both tasks are system-prompt **assembly** changes only.
