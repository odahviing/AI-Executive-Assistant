---
name: audit
description: |
  Run a deep, parallel, propose-only code audit across the project to find bugs before they bite. Triggered when the owner says "audit", "deep audit", "full audit", "audit the project", "full workout", "bug sweep", "find all the bugs", "go find issues", "project analysis", "find me bugs", or similar phrases that mean: spawn parallel subagents to deep-read the codebase across subsystems, paper-trace realistic scenarios, return atomic bug findings with file:line citations. STRICT propose-only — never auto-fixes anything. Returns an atomic-bug list ranked by severity (production / dead code / config leak / bad description / stale comment), saves a handoff file for follow-up sessions, and recommends fix waves. Owner picks which waves to act on.
---

# Audit — parallel deep code analysis

The owner has asked for a full project audit. This is the same operation used to produce the v3 bug-wave handoff: dispatch parallel subagents, each owning a subsystem, each paper-tracing realistic scenarios + reading the source thoroughly, each returning atomic bug findings. Then synthesize into one ranked list and save a handoff file the owner can carry into a separate fix session.

## Strict rules — read before dispatching

- **PROPOSE-ONLY.** This skill never edits code, never bumps a version, never commits. The deliverable is a list. The owner picks what to fix.
- **Atomic bugs.** Each finding = one fix shape. Not a class of fixes, not a refactor proposal.
- **`file:line` citations required.** Every bug names the exact location. No "somewhere in approval flow" hand-waves.
- **Paper-trace expected.** Each subagent runs 2–3 realistic scenarios mentally and reports whether they pass. Real scenarios catch bugs grep can't.
- **Quality over quantity.** Better 4 real bugs in a subsystem than 15 nitpicks.
- **Categorize by category, then rank.** Owner's definition of "bug" includes: production bugs (top), dead code, config leaks (hardcoded names/emails/IDs in src/), bad tool descriptions (Sonnet reads these), stale comments (refs to deleted features or old version numbers).
- **No new prompts in the proposal.** Owner's standing direction: code-over-prompt, tooling-over-new-tools. When a fix has both code and prompt options, prefer code.

## Scope decision

Ask the owner what to audit (or infer from the recent session). Two common shapes:

1. **Full project sweep** — every subsystem listed below.
2. **Focused audit** — owner names the subsystems (e.g. "audit the booking pipeline and the approval flow").

If owner doesn't specify, default to full sweep.

## Subsystem map

Maelle's audit-friendly subsystems (each gets its own parallel subagent):

| # | Subsystem | Primary files |
|---|---|---|
| 1 | **Booking pipeline** | `src/skills/meetings.ts`, `src/skills/meetings/ops.ts`, `src/skills/meetings/planMeeting.ts`, `src/skills/meetings/bookingRequest.ts`, `src/skills/meetings/coord/*`, `src/skills/meetings/detectCategory.ts`, `src/skills/meetings/findMeetingOwner.ts`, `src/connectors/graph/calendar.ts`, `src/utils/scheduleRules.ts`, `src/utils/resolveLocation.ts`, `src/utils/meetingProtection.ts`, `src/utils/attendeeScope.ts` |
| 2 | **Approval pipeline** | `src/tasks/skill.ts`, `src/core/requests/resolver.ts`, `src/core/requests/deferredActionReplay.ts`, `src/core/requests/types.ts`, `src/core/approvals/*`, `src/db/requests.ts`, `src/db/approvals.ts`, `src/utils/threadBoundApprovalAutoResolve.ts`, `src/utils/judgeRequestDedup.ts`, `src/utils/requestDedup.ts`, dispatchers under `src/tasks/dispatchers/` |
| 3 | **Social engine** | `src/skills/social.ts`, `src/core/social/*`, `src/db/socialTopics.ts`, `src/db/socialSubjects.ts`, `src/db/engagementRank.ts`, social-related parts of `src/db/people.ts`, social dispatchers under `src/tasks/dispatchers/` |
| 4 | **Persona memory** | `src/core/assistant.ts`, `src/core/assistantSelf.ts`, `src/memory/peopleMemory.ts`, `src/memory/capturePass.ts`, `src/skills/social.ts` (note tools), `src/db/people.ts`, `src/db/conversations.ts`, `src/utils/resolveSlackId.ts` |
| 5 | **Venue skill** | `src/skills/venue.ts`, `src/utils/venueSearch.ts`, `src/db/venues.ts` |
| 6 | **Floating blocks** | `src/utils/floatingBlocks.ts`, `src/utils/rebalanceFloatingBlocks.ts`, floating-block call sites in `src/skills/meetings/ops.ts`, `src/skills/calendarHealth.ts`, `src/connectors/graph/calendar.ts` |
| 7 | **Working hours / late night** | `src/utils/workHours.ts`, `src/utils/effectiveToday.ts`, `src/config/userProfile.ts` (work_hours/night_shift/office_days schema), all consumers (slot finder, calendar-health, briefs, outreach/coord dispatchers) |
| 8 | **Cross-cutting (always run)** | `src/` whole-tree sweep for: hardcoded user data (names, emails, slack ids), dead code (retired paths still imported), bad tool descriptions Sonnet sees, stale comments referencing deleted features |

When a new subsystem matters (e.g. a future "research" skill, an "email connection"), extend this table.

## Dispatch — parallel agents

For each in-scope subsystem, spawn ONE general-purpose subagent in parallel (single message, multiple Agent tool calls). Each subagent gets a self-contained prompt of this shape:

```
Maelle is an AI executive assistant platform (Node.js/TypeScript, vX.Y.Z). Monorepo at E:\Code\Maelle. You are a subsystem auditor.

YOUR SCOPE: <subsystem name>

FILES TO READ THOROUGHLY:
- <file 1>
- <file 2>
...

KEY INVARIANTS TO VERIFY (from recent CHANGELOG):
- <list 3-6 critical invariants from recent versions, e.g. "v2.9.4 #107a: processCalendarEvents masks subjects via displaySubject covering BOTH paths">
- <these tell the agent what behavior is supposed to hold>

AUDIT GOALS (per owner direction):
- Production bugs that could bite under live load (TOP priority)
- Dead code: retired paths, unreachable branches, leftover functions
- Config leaks: hardcoded names like "Idan", "Reflectiz", emails, slack ids in src/
- Bad tool descriptions: unclear, contradictory, missing context (Sonnet reads these)
- Stale / irrelevant comments: refs to deleted features or wrong version numbers

REQUIRED:
- Read the files (use grep for targeted lookups in large files)
- Paper-trace 2-3 realistic scenarios mentally:
  - (A) <a happy path>
  - (B) <an edge case>
  - (C) <a recent-regression-class scenario>
- Identify ATOMIC bugs (each = one fix, not a class)
- DO NOT write code

OUTPUT FORMAT (concise, under 2500 words):
## <Subsystem>

### B-1 — <short imperative title>
- Where: `src/path/file.ts:LINE`
- What: <1-3 sentence description>
- Bite: <1 sentence on real-world impact>
- Fix: <1 sentence on direction, not code>

Group: production bugs first, then dead code, config leaks, bad descriptions, stale comments. Quality over quantity.
```

**Critical**: for each subagent, pre-load the KEY INVARIANTS section with the most-recent 2-3 version's relevant changes. Without this, agents flag "fixed in v2.X" behavior as bugs. Pull invariants from `CHANGELOG.md` (top of file) and `.claude/memory/project_overview.md` "Where v2.x landed" sections.

The cross-cutting agent gets a different prompt (whole-tree sweep) — see the v3 bug-wave handoff for the template, but in short: `grep -rn 'Idan\|Reflectiz\|reflectiz' src/` patterns for config leaks; deleted-file references for dead code; tool-description grep for promised-behavior-that-doesn't-match-code.

## Synthesize

Once all subagents return:

1. **Dedupe.** Some bugs appear in multiple agents (e.g. a note tool description issue shows up in persona AND cross-cutting). Pick the highest-cited single citation.
2. **Number atomically.** Sequential 1..N, stable. Owner references by number later.
3. **Rank by category**:
   - **TOP PRIORITY** — production bugs with real teeth: privilege escalation, silent data loss, regressions of bugs we already closed, race conditions, deadlocks. Aim for ~10 items, never inflate.
   - **HIGH** — real impact, definitely fix in next patch wave. ~15-20 items.
   - **MEDIUM** — opportunistic, fix when nearby code is touched. ~15-20 items.
   - **DEAD CODE** — retired paths, unused exports, file deletions. Group these — they often come out together.
   - **CONFIG LEAKS** — hardcoded user data in src/. Owner cares about cloneability.
   - **BAD DESCRIPTIONS** — tool descriptions Sonnet sees that mislead her or waste tokens.
   - **STALE COMMENTS** — low-priority but real per owner direction. Group as a single "comments sweep" item when many.
4. **Wave order.** Recommend the order to fix in (security/privilege first, then structural fixes, then dead code mass deletion, then leaks, then descriptions/comments).
5. **Output**: post the full list to chat AND save a handoff file at `.claude/<AUDIT_NAME>_HANDOFF.md` so the owner can carry it into a separate session. The handoff file should be self-contained (mission + operational context + full bug list + wave order + wrap criteria).

## Output to chat

Keep the chat output skim-friendly:
- **Headline summary** — N total atomic bugs, top 10 highlighted.
- **Recommended wave order** — show the suggested fix sequence.
- **Pointer to handoff file** — owner can read it and pass to a separate fix session.

The chat output can be long; the synthesis IS the value here. Don't truncate the bug list for brevity — owner asked for it.

## Token budget

Parallel subagents run concurrently and each returns ~5-15K of findings. With 8 agents in scope, expect ~80-120K of findings landing in the synthesizer's context. Comfortable. If you're running on a smaller context budget, scope down to 4-5 subsystems and tell the owner why.

## Edge cases

**What if a subsystem has no real bugs?** Say so explicitly: *"### Subsystem X — clean. Paper-traced 3 scenarios, no production bugs found. Two minor stale comments noted in the comments sweep."* Better an honest empty section than padded findings.

**What if an agent returns garbage / partial findings?** Re-dispatch with a sharper scope prompt. Don't ship synthesis with one subsystem half-cooked.

**What if the owner reviews and disagrees with a finding?** That's expected. Several "bugs" turn out to be intentional design choices on re-review. Keep the list, accept owner's call, move on. Don't argue.

**What if there's a clear top-1 bug that needs immediate fix?** Surface it at the top of the chat output explicitly: *"⚠️ #N is a privilege-escalation / data-loss / silent-failure pattern — recommend fixing tonight, not waiting for the wave."* Owner decides.

## The one-question test

Before posting the synthesis, ask: *"If the owner picks one finding and fixes only it, is that fix actually a single atomic edit?"* If no — split the finding further. Atomic granularity is the value.
