# News-chat task — news-skill audit follow-ups (M-4, M-5, M-6 + L-5, L-6, L-7)

Six findings from the v3.3.0 audit, all in the news skill / news-adjacent brief code. **Propose-first per item**: read the cited file:line, confirm the claim against current code on disk, then either fix or come back to the owner. Two of these I've already verified are PARTIALLY resolved or low — notes inline. Each item below carries: the owner's reaction, my finding, and a suggested fix.

**Hard rules carried over** (load-bearing from the main audit chat):
- **NEVER parse `news.md` free-text in code.** Owner source preferences live in the LLM compose pass, not a regex. The old `Preferred sources:` parser was deleted for this reason — see invariant #7 in `docs/AGENT_LOOP_INVARIANTS.md`. Do not re-introduce any code-side parsing of owner free text.
- No new DB tables. No regex on natural-language owner content. Haiku-first for any new classifier (don't add a Sonnet call without owner approval).

---

## M-4 — Cap meeting-driven news to ≤3 meetings/day
**Owner**: "keep it per meeting — one news search for each meeting — and cap it at no more than 3 meetings per day."
**Files**: `src/tasks/briefs.ts:70-101` (`extractMeetingCompaniesFromEvents` / `deriveMeetingCompanies`) + the `NEWS_MEETING_COMPANY_CAP` constant (find its definition).
**Current code** (verified): `extractMeetingCompaniesFromEvents` already caps OUTPUT at `NEWS_MEETING_COMPANY_CAP` (early `return out` once the cap is hit), so it isn't truly "unbounded" — the inner attendee loop is bounded by that early return. News runs ONE Tavily search per goal, and meeting companies become goals.
**Fix shape**: confirm `NEWS_MEETING_COMPANY_CAP` and set it to **3** if it's higher (so at most 3 meeting-company-driven searches/day). Owner wants the cap expressed as "≤3 meetings/day feeding news." If you want belt-and-suspenders, also short-circuit the outer event loop once 3 distinct companies are collected (the early return already does this) — verify, don't double-add.
**Risk**: trivial. **Cost**: 1-min (constant change) once the cap value is located.

---

## M-5 — pruneSeenLog: core already anchored; residual is the merge replace
**Owner**: "ok, do it."
**File**: `src/skills/news.ts:285-298` (`pruneSeenLog`) and `:404-405` (the today-section merge).
**What I verified**: `pruneSeenLog` itself is ALREADY safe — it splits per line and matches headers with an anchored regex `/^##\s*(\d{4}-\d{2}-\d{2})\s*$/`. The audit's "unanchored substring `.replace()`" no longer applies to `pruneSeenLog`. The only residual unanchored op is the merge at line 404-405:
```
if (pruned.includes(`## ${today}`)) {
  next = pruned.replace(`## ${today}`, `## ${today}\n${lines.join('\n')}`);
}
```
This is a **string** `.replace` (first literal occurrence of `## 2026-06-07`). Low risk because `pruneSeenLog` emits clean line-start headers, but a bullet whose text happens to contain the literal `## <today>` could be matched instead.
**Fix shape**: replace the string-match merge with an anchored regex insert (`/^## 2026-06-07\s*$/m`) or split-on-header + splice. Low priority — confirm it can actually misfire before spending effort.
**Risk**: low. **Cost**: 5-min.

---

## M-6 — Tavily error-log storm on a provider outage
**Owner**: "what does that mean?"
**Explanation**: news runs one Tavily search per goal **in parallel** (`src/skills/news.ts:209`, `Promise.all(goals.map(searchGoal))`). `searchGoal` (`news.ts:158-178`) swallows failures to `[]` via `withTimeout`, but the underlying `tavilySearch` (in `src/skills/general.ts`) logs the HTTP error itself. So when Tavily is 429/5xx, every one of N goals logs an error → N error lines per brief → log spam during an outage (the audit saw ~4×/brief).
**Fix shape**: in `general.ts` `tavilySearch`, downgrade transient 429/5xx to a single `warn` (not `error`), OR in `news.ts:gatherNews` detect the first hard failure and skip the remaining goals for that run. Don't change the fail-open behavior — just the logging volume. Verify the actual log level in `general.ts` first.
**Risk**: low (logging only). **Cost**: 5-min.

---

## L-5 (N-8) — Orphan goals not represented in the seen-log
**Owner**: "what is that?"
**Explanation**: a planned goal that returns zero sources never gets recorded anywhere, so the cross-day dedup can't know it was already attempted. Minor polish — re-running the same dry goal tomorrow costs another (empty) search.
**Fix shape**: optionally record attempted-but-empty goals so the planner can deprioritize them. Verify it's worth it; owner may decide skip.
**Risk**: low. **Cost**: 5-15 min.

---

## L-6 (N-9) — URL encoding for the Slack `<url|label>` form
**Owner**: "are you sure it's a bug?"
**Explanation**: if a news source URL contains a literal `|` or `>`, embedding it raw in Slack's `<url|label>` link markup breaks the link rendering. Whether it's a *real* bug depends on whether news links are emitted in `<url|label>` form anywhere (check the compose/render path) and whether Tavily ever returns such URLs (rare but possible with query strings). **Verify it actually occurs before fixing** — this may be a non-issue.
**Fix shape (if real)**: sanitize/encode `|` and `>` in the URL before wrapping, or use the bare-URL form.
**Risk**: low. **Cost**: 5-min.

---

## L-7 (N-11) — Leak scrubber doesn't list 'news' — RECOMMEND SKIP
**Owner**: "what?"
**Explanation**: the security/leak scrubber's term list doesn't include the word `'news'`. The audit itself flagged this as "probably skip" because `news` collides with ordinary English and scrubbing it would mangle normal replies. There is no privacy value in scrubbing `news`.
**Recommendation**: **skip.** Only act if the owner sees a concrete leak. Documenting here so it's not re-discovered later.

---

## M-7 — Pref dedup is blind to non-`-`-prefixed prior lines
**Owner**: "ok do it — but it's the news feature, so make sure it wasn't done already."
**File**: `src/utils/skillPreferences.ts:163-164` (the `add`-mode dedup loop).
**Note**: `skillPreferences.ts` is the SHARED owner-preference writer (news + calendar + brief all flow through it via `formatSkillPreferencesBlock`). News prefs are written here, so it's "the news feature" from the owner's seat, but the fix touches the shared module — verify it doesn't regress the other areas.
**FIRST: confirm it wasn't already fixed** (the prior wave added atomic-write + a mutex here; check whether the dedup loop was also touched).
**Bug**: the dedup loop compares the new bullet only against prior lines that `startsWith('-')` (`if (!pl.trim().startsWith('-')) continue;`). A preference written by a `replace` as prose or `*`-bullets is invisible to dedup → a near-duplicate can slip in. Low impact since `add` always writes `- ` bullets.
**Fix shape**: normalize the comparison so any non-empty prior line participates (strip a leading `-`/`*`/`•` OR drop the `startsWith('-')` filter and just skip blank lines). Keep it pure string work — no regex on owner free text beyond bullet-marker stripping.
**Risk**: low. **Cost**: 5-min.

---

## M-8 — Jaccard ≥ 0.6 dedup threshold silently swallows refinements
**Owner**: "ok — but same as M-7 (confirm it wasn't already done; it's the news feature)."
**File**: `src/utils/skillPreferences.ts:159-169` (same dedup block).
**Bug**: on `add`, token-set Jaccard ≥ 0.6 between the new bullet and an existing one → the new bullet is SILENTLY skipped as a duplicate. 0.6 is loose for short prefs: "prefer morning meetings" vs "prefer morning meetings **on Mondays only**" overlaps heavily → the refinement is dropped even though it adds a constraint.
**Fix shape** (audit's suggestion): instead of silently skipping, surface the near-dup + the prior line in the return `_note` so the compose pass can decide whether to ask the owner before dropping. Do NOT just raise the threshold blindly — surfacing is the better fix. Confirm not-already-done first.
**Risk**: low. **Cost**: 10-15 min (return-shape + caller wiring).

---

## Posture
80% of the v3.3.0 audit is still open in the main chat — these eight are the news-cluster slice. Fix the cheap, verified ones (M-4, M-6, M-7); discuss M-5/M-8/L-5/L-6 with the owner if effort > value; skip L-7.

---

## N-12 — news seen-log sits in the CACHED static prompt (from the prompt chat)
**Found by:** prompt-chat de-tenant / tier audit (`scripts/_dump-prompts.cjs`). Flagging, not fixing — it's your skill's domain.
**What:** the rolling seen-log renders as `## <date>` sections (e.g. `## 2026-06-24`) inside the **cached static block** of the system prompt — ~1K tokens of date-headed, owner-specific entries, on every owner turn.
**Why it's a smell (prompt-agent charter R3 tier + R9 de-tenant):**
- The static block is the *cached* tier — meant to stay stable so the 5-min prompt cache holds. The seen-log is owner-specific runtime data that **changes daily** (date rollover) and whenever news runs → it **busts the static cache** on rollover/refresh (fresh cache-create). Daily-changing data belongs in the **dynamic** block (uncached) or, better, **scope-gated to news turns only** — not baked into cached static.
- It's per-owner state shipping on every non-news turn too.
**Direction (verify first):** confirm whether news `getSystemPromptSection` (+ seen-log) is **scope-gated** (ships only when the `news` scope is active) or always-on. If always-on, gate it; if it must be present off-news-turns, move the seen-log into the *dynamic* block so it stops invalidating the cache.
**Priority:** low — ~1K tokens, cache-efficiency + correct tiering, not behavior. Prompt chat did NOT touch it (news owns the seen-log mechanism + scope wiring).
