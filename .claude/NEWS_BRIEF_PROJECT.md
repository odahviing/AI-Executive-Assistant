# Personalized news brief — build spec

> Status: SPEC (design complete, not built). Authored by the feature/design chat.
> GitHub #17. Build in a focused build chat; verification plan at the bottom.
> Shape mirrors `.claude/WHATSAPP_PROJECT.md` / `.claude/PERSON_STORE_PROJECT.md`.

---

## 1. Problem

Maelle's morning brief today carries the owner's **calendar + tasks + approvals +
outreach/coord** (`collectBriefingData`, `tasks/briefs.ts:278`). It does NOT carry
the outside world. A great EA also walks in knowing the news that matters to the
principal that day — his industry, his competitors, **the companies of the people
he's meeting today**. Generic feeds are noise; the value is *personalized +
calendar-aware + grounded*.

The owner's framing: *"during the brief I can get my calendar, my tasks, and
updates."* So this is not a separate product — it's a **news section folded into
the existing brief**, plus an on-demand `news` tool.

The engine already exists: `web_research(goal, recency_days)` →
`runResearch(goal, recency)` (`skills/general.ts:271`) does PLAN→GATHER→READ and
returns grounded, citable `{sources, readings}`. We are not building a crawler;
we are pointing the existing grounded-research engine at the owner's interests
and today's calendar.

---

## 2. Owner decisions (locked — build to these)

1. **Topics live in the learned-MD memory, not config.** Reuse the per-skill
   preference layer: `update_my_preferences(skill='news', …)` →
   `config/users/<owner>_prefs/news.md`. Taught conversationally ("follow EU AI
   regulation", "track Acme + Globex", "skip crypto"). No YAML, no schema.
2. **Sources: Maelle discovers them (search-driven), steered by liked/disliked
   domains.** No curated website list, no site crawling. The owner tells Maelle
   *"I like theinformation.com / stratechery.com"* (preferred) or *"ignore
   tabloid.example"* (blocked); these persist and map to Tavily
   `include_domains` / `exclude_domains` (a HARD filter). Requires extending
   `runResearch`/`tavilySearch` to accept domain filters.
3. **Dedup is topic-level via a rolling MD log — NOT URL-keyed.** (The same story
   runs across many publishers, so URL dedup misses it.) Maelle keeps a rolling
   **7-day MD log of short per-article summaries, grouped by day**; writing a new
   day prunes the day from 7 days ago. At gather time this log is in context and
   the compose step skips topics already covered — the LLM does the semantic
   "already covered?" match (cheap + strong; storing short summaries, never full
   articles).
4. **Delivery: in-brief by default + on-demand tool.** A `news` tool can run
   standalone in chat ("what's the latest on X?"); the brief routine calls the
   **same shared core function** programmatically and includes its results in
   most firings. (The brief is a direct Sonnet compose, not a tool loop — see
   §4.1 — so the brief cannot "call the tool"; both call a shared core fn.)

---

## 3. Design

### 3.1 Why news must be gathered programmatically (not as a brief tool call)

`generateBriefingText` (`briefs.ts:423`) is a **single direct Sonnet
`messages.create` compose pass** (model `claude-sonnet-4-6`, `:517`) — it has no
tool loop. It already injects skill-preferences (`formatSkillPreferencesBlock`,
`:17`) and pins language to the owner's profile (`:437–450`). Therefore news must
be **gathered before compose** and **injected into the compose context** as
grounded readings the brief writes from + cites.

### 3.2 The shared core: `gatherNews(profile, opts)`

One function, two callers (the `news` tool + the brief). Lives in the news skill
module (`src/skills/news.ts`).

Inputs it assembles:
- **Stored interests** — parsed from `news.md` (free text; Maelle's topics).
- **Derived topics** — companies/orgs of the people on **today's** calendar
  (from the brief's `collectBriefingData` calendar items / attendee → person
  store org). Derived fresh each morning, never stored. This is the calendar
  tie-in (#17's differentiator).
- **Source steer** — preferred/blocked domains parsed from `news.md` →
  `include_domains` / `exclude_domains`.
- **Recency** — short window (1–3 days for the morning edition).
- **Dedup context** — the rolling 7-day seen-log MD.

Pipeline:
1. Build a **capped** set of research goals (≈3–5: top interests + today's
   meeting companies). Cap is a constant in code (cost control).
2. For each goal, call `runResearch(goal, recency, { includeDomains,
   excludeDomains })` — **best-effort, per-goal timeout**, in parallel with a
   small concurrency cap. A goal that fails/times out is dropped, not retried.
3. Collect `{sources, readings}` across goals; dedupe sources by URL within the
   run (runResearch already does this per call).
4. Return `{ goals, readings, sources }` for the caller to compose from. **Never
   throws** — returns an empty bundle on total failure.

### 3.3 Dedup — the rolling seen-log (owner's design)

- File: `config/users/<owner>_news_seen.md` (per-user, MD).
- Format: a section per day (date header), each day a handful of one-line
  summaries — `• <topic/headline> — <1-line gist> [<source domain>]`.
- **Write path (after a brief/news send):** a cheap Haiku pass turns the
  *surfaced* items into one-line summaries, appends today's section, and
  **prunes any day older than 7 days** (same write).
- **Read path (at gather/compose):** the last 7 days of the log are injected into
  the compose prompt with the rule: *"These topics were already covered in the
  last 7 days — do NOT repeat a story already covered, even from a different
  outlet; only include genuinely new developments."* Topic-level match, LLM-owned.
- This is the ONLY new persistent state, and it's MD (the owner's call), so no
  migration.

### 3.4 Source steer → Tavily domain filters (the one engine extension)

`tavilySearch` (`general.ts:328`) builds a request body; Tavily supports
`include_domains` / `exclude_domains`. Extend:
- `tavilySearch(query, depth, timeRangeDays, opts?: { includeDomains?, excludeDomains? })`
  → add the arrays to `body` when present.
- `runResearch(goal, recencyOverride?, opts?: { includeDomains?, excludeDomains? })`
  → thread `opts` to every `tavilySearch` call.
- **Backward-compatible:** no opts → byte-identical to today. The existing
  `web_research` tool path is unchanged (it just never passes opts).
- Domain prefs are parsed from `news.md` by a small code parser (Maelle maintains
  a clearly-delimited "Preferred sources:" / "Blocked sources:" area in the file
  when told). Code reads the domain lines; the LLM owns the file. Guard against
  over-narrowing: if an include-filter returns nothing, fall back to an unfiltered
  search for that goal (so a too-tight pin never produces an empty brief).

### 3.5 The `news` skill

New togglable `NewsSkill` (`src/skills/news.ts`), registered in
`skills/registry.ts` under a `news` loader key (YAML `skills: { news: true }`).
- **Memory:** its `news.md` via the per-skill prefs layer (skill id `news`),
  injected into the skill's prompt section (owner-path, scope-gated → zero tokens
  when news isn't in play; nothing for a fresh user).
- **Tool:** `news(topic?)` — runs `gatherNews` (optionally narrowed to `topic`)
  and returns the grounded bundle for Maelle to write from in chat. (Consider
  whether a dedicated tool is even needed vs. leaning on `web_research` + a prompt
  section; a thin `news` tool is justified because it also applies the
  dedup-log + domain-steer + interest defaults that `web_research` doesn't.)
- **Prompt section:** teaches how to turn topics into a brief, honor the source
  steer, cite sources, and respect the seen-log. Judgment/voice in prompt;
  gathering + capping + dedup-IO in code.
- **Teaching tool:** reuse `update_my_preferences(skill='news', …)` for topics +
  source domains (already always-on). No new write tool.

### 3.6 Brief integration

In `sendMorningBriefing` (`briefs.ts:546`), after `collectBriefingData`:
- Call `gatherNews(profile, { meetingCompanies, recencyDays: <morning window> })`
  under a **global timeout** (e.g. a few seconds) — **fail-open**: if it's slow
  or empty, the brief composes calendar+tasks as today.
- Pass the bundle into `generateBriefingText`, which adds an **"Updates" section**
  written grounded + cited, in the owner's profile language, honoring the
  seen-log dedup rule.
- After send, fire-and-forget the seen-log write (§3.3).
- The news section is **additive** and **gated**: empty `news.md` AND no derived
  topics → no Updates section → brief is byte-identical to today.

---

## 4. Layer placement

- **Code (determinism):** topic capping, goal assembly, per-goal timeout +
  concurrency, domain-filter plumbing, seen-log read/write/prune, fail-open
  wiring, today's-meeting-company derivation.
- **Prompt (judgment):** what's worth surfacing, the "already covered?" call,
  tone/voice, citation. No enforcement rules in the prompt.
- **Learned memory (taste):** `news.md` — topics + preferred/blocked domains,
  taught conversationally. The seen-log MD is code-maintained state (not taste).
- **Config/YAML (structural):** only `skills: { news: true }` toggle + (optional)
  a morning recency-window default. No topics, no sources, no locale in config.
- **Connection:** none — owner-facing DM via the existing brief delivery.

---

## 5. Invariants (must hold)

1. **News disabled / empty → byte-identical brief.** No `news.md` content and no
   derived topics → no Updates section; the brief is unchanged.
2. **News never breaks or delays the brief.** Gather is best-effort, timed-out,
   fail-open. Calendar + tasks always ship.
3. **Grounded or silent.** Every news claim cites a returned source; on empty
   research, say so — never fabricate (the `runResearch` "NO sources" note already
   enforces this; keep it).
4. **No repeats.** A topic covered in the last 7 days isn't re-surfaced, even from
   a different publisher (topic-level dedup via the seen-log).
5. **Multi-tenant by construction.** No hardcoded topic, source, or locale;
   language follows `profile.user.language`; a fresh user starts empty.
6. **Privacy.** Research queries use public entity names (a company), never the
   owner's private schedule framing ("Idan is meeting Acme"). Cost is bounded by
   the topic cap.
7. **`web_research` unchanged.** The domain-filter extension is opt-in; the
   existing tool path passes no opts and behaves exactly as before.

---

## 6. Code touch-points (file:line — verified)

- `src/skills/news.ts` — NEW: `NewsSkill` + `gatherNews` core + seen-log IO.
- `src/skills/general.ts:271,328` — extend `runResearch` + `tavilySearch` with
  optional `{ includeDomains, excludeDomains }` (backward-compatible).
- `src/tasks/briefs.ts:278,423,517,546` — `collectBriefingData` (source of
  today's calendar/companies), `generateBriefingText` (inject Updates section),
  `sendMorningBriefing` (call gatherNews fail-open + fire seen-log write).
- `src/utils/skillPreferences.ts` + `src/core/assistant.ts:326,766` —
  `update_my_preferences(skill='news')` reuse; confirm `news` is a recognized
  skill key for the prefs block injection.
- `src/skills/registry.ts` — register `NewsSkill` under a `news` loader key;
  per-skill prefs injection keyed on skill id.
- `src/config/userProfile.ts` — add `skills.news` toggle (+ optional morning
  recency-window default). Nothing else.
- `config/users/<owner>_prefs/news.md` — topics + source domains (taught).
- `config/users/<owner>_news_seen.md` — rolling 7-day seen-log (code-maintained).

---

## 7. Build phases (ship + verify each)

1. **Domain-filter extension + grounded gather.** Extend `runResearch` /
   `tavilySearch` with include/exclude domains (backward-compatible).
   Build `gatherNews` core: read `news.md` topics, cap goals, per-goal timeout,
   return the grounded bundle. *Verify: web_research path unchanged; gatherNews
   returns cited readings for a sample news.md; empty news.md → empty bundle.*
2. **`NewsSkill` + on-demand tool + memory.** Register the skill, the `news` tool
   wrapping `gatherNews`, and `news.md` prefs injection + the
   `update_my_preferences(skill='news')` teach loop. *Verify: "track Acme" gets
   stored; "what's new on Acme?" returns a grounded, cited answer in chat.*
3. **Seen-log dedup.** Read/write/prune the rolling 7-day MD; inject into the
   compose; topic-level skip. *Verify: same story from two outlets on consecutive
   days is not repeated; log prunes >7d.*
4. **Brief integration.** Wire `gatherNews` into `sendMorningBriefing` (fail-open,
   timed-out) + the Updates section in `generateBriefingText` + derived
   today's-meeting-company topics + seen-log write after send. *Verify: §8.*

Phases 1–3 are low-risk and independently shippable; phase 4 is where the
cron-cost + fail-open discipline matters most.

---

## 8. Messy-scenario paper-trace (failure modes named)

**S1 — Normal morning.** news.md = "EU AI regulation; competitors Acme, Globex;
skip crypto." Calendar has a 3pm with someone @acme.com. gatherNews builds goals
[EU AI reg, Acme news, Globex news] + derived [Acme — already covered, dedup].
runResearch (recency 2d) returns cited readings; brief writes an Updates section,
3–5 bullets with links, crypto excluded. Seen-log appended. ✅

**S2 — Research is slow / Tavily down.** gatherNews hits the global timeout (or
every goal errors). Returns empty bundle. Brief composes calendar + tasks exactly
as today — **no delay, no error, no empty "Updates" heading**. ✅ (Invariant 2.)

**S3 — Same story, two publishers, two days.** Day 1 surfaces "Acme raises $40M"
from TechCrunch (logged). Day 2 the same raise is on Reuters with a new URL. URL
dedup would miss it; the seen-log says "Acme $40M raise — covered," so the compose
skips it and only surfaces genuinely new Acme developments. ✅ (Owner's design.)

**S4 — Over-tight domain pin.** Owner pinned only one preferred domain; today it
published nothing on his topics → include-filter returns empty. The per-goal
fallback re-runs that goal unfiltered so the brief isn't blank on that topic; the
preferred domain still wins when it has coverage. ✅ (§3.4 guard.)

**S5 — Fresh tenant / news off.** Empty news.md, no marked meetings, skill toggle
off → no goals, no Updates section, brief identical to a calendar+tasks brief. ✅
(Invariant 1 + 5.)

**S6 — Fabrication pressure.** A topic has buzz but no extractable source (all
paywalled). runResearch returns the "NO sources" note; the compose says "couldn't
find a solid source on X" rather than writing from memory. ✅ (Invariant 3.)

---

## 9. Open decisions for the build chat (surface to owner if material)

1. **Goal cap + recency window** for the morning edition (suggest ≈3–5 goals,
   1–3 days). Tune after measuring cost.
2. **Seen-log granularity** — one line per surfaced item vs per topic-cluster.
   Lean per surfaced item; the compose clusters.
3. **`news` tool vs prompt-only** — confirm the thin `news` tool earns its place
   (it applies dedup-log + domain-steer + interest defaults that bare
   `web_research` doesn't). Likely yes.
4. **Domain prefs storage** — a delimited section inside `news.md` (one memory
   surface, recommended) vs a small structured companion file. Build detail.

---

## 10. Verification fixture

- **Engine (phase 1):** call `web_research` the old way → identical output; call
  `runResearch` with a blocked domain → that domain absent from sources; empty
  news.md → empty gather bundle.
- **Skill (phase 2):** teach a topic via chat → it persists in news.md; ask for
  it → grounded, cited chat answer.
- **Dedup (phase 3):** seed the seen-log with a story; same story (different URL)
  is not re-surfaced; a day >7d old is pruned on the next write.
- **Brief (phase 4):** a morning brief with news.md populated shows a cited
  Updates section in the profile language; with Tavily disabled the brief still
  ships calendar+tasks (fail-open); a meeting with an @company attendee surfaces
  that company's news that day.
- **Typecheck:** `npx tsc --noEmit -p E:/Code/Maelle/tsconfig.json` (project-mode,
  worktree gotcha).
