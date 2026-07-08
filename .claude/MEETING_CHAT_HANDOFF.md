# Meeting-agent chat — START HERE (handoff, 2026-07-06 · v3.6.2)

You are the **meeting-planner deterministic-core agent** for Maelle. The prior meeting chat got long; this is your cold-start. Read this file, then the two docs in §0, then work the open items in §4. Propose-first — build only on an explicit "build it".

---

## 0. Read these first (your constitution)
1. **`.claude/MEETING_PLANNER_AGENT.md`** — THE CHARTER: your mandate, the **11 owner rules** (load-bearing — every fix is checked against them), the diagnostic discipline, the subsystem map, the recurring bug clusters. Non-negotiable. **Consolidated this session** (15→11: near-duplicate rules merged, and *leave-no-dead-code* moved to the shared working-rules memory since it's general dev discipline, not meeting-domain). New concepts baked in: **Rule 11** (time comes from config + calendar, never the server clock) and the **Rule 4 corollary** (one resolver/spine for a recurring instability — each symptom-patch is another voice in a judge-less argument).
2. **`.claude/WE_TIMEZONE_SPINE_BUILD.md`** — the WE timezone spine: the diagnosis, design, and exactly what shipped. The through-line of recent work.
3. **`CHANGELOG.md`** 3.6.0 → 3.6.2 — what's in the code now (canonical; not duplicated here).

Subsystem map is in the charter. **coord was removed in 3.5.0** — ignore charter refs to `coord/*`.

---

## 1. How to work (owner's standing rules — honor them)
- **Propose-first, NEVER auto-fix.** Root-cause each bug to `file:line — what happens` from the log, prove it, then propose. Build only on a per-bug "build it" / "fix it." "do it" / "go" / "ok" = make the edit, leave it UNCOMMITTED (stop at typecheck).
- **NEVER commit / bump / wrap without an explicit ship word** ("wrap" / "commit" / "ship" / "bundle"). `git push` is pre-authorized *after* a commit. `git add -A` sweeps other chats' WIP — fine ONLY at a coordinated wrap where the owner says "take them all / include the other chats," never on an unrequested commit (check `git status` first; stage explicitly if unsure).
- **Code-first; fix at the chokepoint; ONE source of truth per decision; reduce LOC; no dedup (extract one fn); no NL regex (multilingual); `trace` to 100% before "done."**
- **Shell:** never prepend `cd`; one logical command per Bash call; `gh … --body-file`. Reads (logs, `node scripts/db-query.cjs`, grep, code) are free.
- **Your lane = the meeting deterministic core** (search / validate / book-decision / TZ / WE / floating-blocks / Graph + cache). **Route OUT:** approval→booking→relay (approval chat); systemPrompt narration/judgment (prompt chat); tool *descriptions* + tenancy (tenancy chat); the gate stack (guard chat). When a "meeting bug" is really prompt/tone/tool-description → hand it a paste-block, don't build it here.

---

## 2. The WE timezone SPINE — SHIPPED (3.6.0), the source of truth. DON'T re-scatter it.
For months, "what instant does the owner's stated time mean, and how is it shown" was re-decided across 6+ layers that disagreed — the recurring instability. Now there is ONE spine (`src/utils/weTimeResolver.ts`):
- **`resolveStatedInstant`** — stated clock + `stated_zone` + travel ctx → canonical instant. An offset-tagged input is a fixed instant (left as-is); a bare clock is read in the zone the owner NAMED (`stated_zone`: `home`/`local`/IANA, `ABBREV_TO_IANA` maps "ET"/"IL"/…), else where he physically is on a trip day.
- **`renderWeDualClock`** — the ONE display string ("… where you are now / … your home time"), quoted verbatim by confirm / booked-confirmation / move summary / colleague-escalate / approval-preview. Clocks pinned by meaning (can't invert); lodging never named (it's not a venue).
- **`resolveOwnerTravelContextForDate`** — the ONE "where am I / what zone" detector.
- **`weConfirmStash.consumeWeConfirmShown`** — the WE trip-time confirm carries once (consume-on-use); a re-issue of the same instant books, and it can't re-lock a time the owner is correcting.
- **Rule 11:** zones come from config (home) + the WE marker (trip) — NEVER the server clock (the v3.5.4 drift root; cloud-safe).
- **Model contract:** `stated_zone` replaced `start_timezone` on create/move (the model conveys the named zone INCLUDING home — the old 0/3 "Israel time" root); handler still reads `start_timezone` as back-compat; `find_available_slots` keeps it.
- **Residual BY DESIGN:** when the owner NAMES a zone, first-pass correctness routes through the model setting `stated_zone` — backstopped by the visible dual-clock confirm + consume-on-use (a mistag is visible + one-step correctable, never a silent wrong-day book). No-zone-named → deterministic trip default; home-week dates → deterministic.

---

## 3. What else shipped 3.6.0 → 3.6.2 (see CHANGELOG for detail)
- **Create-vs-move slop guard** (`findReschedulableSibling`, calendar.ts): "move X" → create_meeting duplicating a live series is caught — surface-and-ask redirect to `move_meeting`, `force_new` escape, ~3-week window, subject + shared-attendee match (structured, no NL).
- **Requester ≠ attendee** (Bug 4): `requester_is_attending` / `requester_slack_id` scrub in create_meeting — a relayer isn't booked as an attendee (one in-place scrub covers event + recordBooking).
- **Free-time floor = one source** (`requiredFreeMinutesForWorkDay`, scheduleRules) + label renamed "free-time floor" (was the misleading "focus-time protection"). `work_hours_per_free_hour` ratio knob.
- **Teams online meetings** (3.6.2): removed the post-create `teamsUrlAsLocation` stamp (create + move) — a native Teams meeting is defined by `isOnlineMeeting` + `onlineMeetingProvider` at create; never stamp the join URL into location.
- **Sibling chats** (bundled): gender (name-guess removed; `auto` gender doesn't steer Hebrew; unknown→neutral), social (a grievance is engagement, not a deflection), stale-context (1:1 DM no longer re-merges Slack history), approval-preview WE-aware, retired the output-path `verifyReplyMatchesBooking` honesty check.

---

## 4. Open / pending — pick up here
- **Relative-week resolution + empty-window fallback (ROUTED to the prompt chat, not yet shipped).** 2026-07-06 Mike incident: colleague asked "next week, 3 slots"; the model resolved "next week" to 7–11 Jul (this week's tail + weekend, empty) despite a correct WEEK BOUNDARIES table, then fell back to a SINGLE day → 2 same-day options. Paste-block sent to the prompt chat: (1) empty-window fallback = the next coherent WORK-WEEK as a day-spread, never one day; (2) echo the searched window so a wrong week is visible + one-round correctable; (3) offer the count asked for. **Meeting-core is NOT at fault** (`pickSpreadSlots` spreads correctly given a multi-day window; the tool already returns the searched window + daySummary). **Optional code nudge OFFERED, not built** (owner chose prompt-first): on 0 results, return the next-work-week's dates in the tool result so the model's right next move is in the tool output, not a static table it can ignore. Revisit if the prompt fix doesn't hold.
- **Teams toggle-off in Outlook (NOT our bug — know this before "fixing" it again).** After 3.6.2 the location is clean; the meeting IS a valid Teams meeting (join link / Meeting ID / passcode all real, attendees join fine). The organizer-view "Teams meeting" toggle showing OFF is a **Microsoft behavior for Graph-API-created online meetings**, not something our create params corrupt (we removed the one thing that was ours — the URL-stamp). Possible tenant factor the OWNER checks as admin: Teams "Outlook add-in" / Meeting Scheduling policy. Don't re-open this as a create-code bug.

## Carried-forward watch items (from the charter's open list)
- `checkSlot` is still WE-blind (callers pass relaxed/away); the spine relaxes home rules on a WE day upstream — fine, but if a WE validation bug appears, check the naive-parse-in-server-tz class FIRST (Rule 11), not the WE markers.
- Shadow-DM duplicate after restart (in-memory anchor) — persist if it recurs.
- Google-Maps-link → venue resolution (needs the name typed) — feature, not a bug.

Discipline: reproduce from the log → root-cause to `file:line` → fix at the chokepoint, code-first, ONE source → `trace` to 100% → propose-first. Check every fix against the 11 charter rules.
