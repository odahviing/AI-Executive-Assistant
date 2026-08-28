# News-chat task — news-skill audit follow-ups (L-5, L-6, L-7 remain open)

Findings from the v3.3.0 audit, all in the news skill / news-adjacent brief code. **M-4 through M-8 and N-12 below are DONE — shipped in v3.3.1, confirmed by the version-tagged comment at each site.** Only L-5 and L-6 are still open; L-7 is a standing "recommend skip." **Propose-first per item**: read the cited file:line, confirm the claim against current code on disk, then either fix or come back to the owner.

**Hard rules carried over** (load-bearing from the main audit chat):
- **NEVER parse `news.md` free-text in code.** Owner source preferences live in the LLM compose pass, not a regex. The old `Preferred sources:` parser was deleted for this reason — see invariant #7 in `docs/AGENT_LOOP_INVARIANTS.md`. Do not re-introduce any code-side parsing of owner free text.
- No new DB tables. No regex on natural-language owner content. Haiku-first for any new classifier (don't add a Sonnet call without owner approval).

---

## M-4 — Cap meeting-driven news to ≤3 meetings/day — DONE
Shipped: `NEWS_MEETING_COMPANY_CAP = 3` in `src/tasks/briefs.ts:57`, enforced by the early return in `extractMeetingCompaniesFromEvents` (`briefs.ts:100-120`).

---

## M-5 — pruneSeenLog today-section merge — DONE
Shipped v3.3.1: the merge now matches the header with an anchored regex, not a literal substring — `src/skills/news.ts:633-639` (comment tagged `v3.3.1 (M-5)`).

---

## M-6 — Tavily error-log storm on a provider outage — DONE
Shipped v3.3.1: transient provider errors (429/5xx) log at `warn`, not `error` — `src/skills/general.ts:556-563` (comment tagged `v3.3.1 (M-6)`). A genuine 4xx still logs `error`.

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

## M-7 — Pref dedup blind to non-`-`-prefixed prior lines — DONE
Shipped: the dedup loop compares against any non-empty, non-header prior line, not only `-` bullets — `src/utils/skillPreferences.ts:229-236` (comment tagged `M-4 (v3.3)`; renumbered M-7 for this doc, same fix).

---

## M-8 — Jaccard ≥ 0.6 dedup threshold silently swallows refinements — DONE
Shipped: a near-dup match returns `{ duplicate: true, matchedLine }` instead of silently dropping — `src/utils/skillPreferences.ts:239-246` (comment tagged `M-5 (v3.3)`; renumbered M-8 for this doc, same fix).

---

## N-12 — news seen-log sits in the CACHED static prompt — DONE
Shipped: `getSystemPromptSection` scope-gates the seen-log + prefs block behind `inPlay` (general/news scopes only); the always-on part is just the routing rule — `src/skills/news.ts:756-780`.

---

## Posture
M-4 through M-8 and N-12 are shipped. L-5 and L-6 remain open (low priority, verify-before-fixing); L-7 stays a recommended skip.
