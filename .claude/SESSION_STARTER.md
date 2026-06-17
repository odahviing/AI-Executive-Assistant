# Maelle session context

We're working on the Maelle project at `E:/Code/Maelle`. **Current version: v3.4.1** — check `package.json` if unsure; it is the source of truth.

## 🔭 v3.4.1 — slot blocker SHIPPED; NEXT: #129 + the close-loop reconnection (Daniel-B / 2.2)

The **slot blocker (#30) is built and shipped** (data → `hold_slot` tool → expiry sweep → find_available_slots deprioritize+annotate → owner-confirm/colleague-approval hold gate on create AND move → release+DM → brief overuse surface). Dedicated `slot_holds` table (not the spine — storage analysis in `.claude/RESERVE_SLOT_PROJECT.md`). The parallel **audit chat's hardening wave** (P-1…P-6, `.claude/V3_4_0_AUDIT_HANDOFF.md`) landed in the same 3.4.1 bundle. **RESTART (`npm run deploy`)** to load the new table + tool + tick wiring; confirm the boot stamp shows 3.4.1.

**NEXT CHAT, in order:** **(1) #129** — LinkedIn/research routine asserts unverified owner-self facts ("you have a webinar"); the news module is healthy, the gap is no grounding gate on owner-self claims (regression of the v3.1.8 class). Likely fix: feed the LinkedIn routine from the grounded news pipeline + a rule that owner-activity claims come from his records. Research comment is on the issue. **(2) The close-loop reconnection (Daniel-B + 2.2, deferred)** — a freeform approval CLOSES at approve, so a later booking/cancel can't reconnect to notify the requester (Daniel never heard "booked Mon 17:00"; Yael's follow-up lost the just-cancelled state). Same family: the requester-facing close-loop assumes approve==done, breaks when the action is separate. Fix needs reconnecting the booking/cancel to the resolved requester request (or keeping it open until the action lands). **(3) Remaining audit items** (P-7+ in the handoff, beyond the TOP-6 already landed) — owner picks.

**Watch the slot blocker live** (first real-day use): does a held slot stay out of others' offers (deprioritize), does the owner-book-over-hold confirm fire, does expiry DM the holder at 2 workdays, does the brief show holds. It's a soft-gated feature (annotate + confirm/route), not a hard lock — `find_available_slots` deprioritizes but the owner can always override.

## 🔭 v3.4.0 — Boston/real-day bug-bash (create-vs-move slop, owner override one-step)

A GitHub real-day bug-bash (#127–#132) capped the 3.3.x arc. **Next up, in order: (1) #129** — the LinkedIn-ideas routine asserted an unverified "you have a webinar" about the owner; news module is healthy, the gap is **no grounding gate on owner-self claims** (regression of the v3.1.8 researchPreCheck class). Research comment is on the issue; the likely fix is feeding the LinkedIn routine from the grounded **news pipeline** + a rule that owner-activity claims must come from his records. **(2) The slot blocker (#30)** — plan is at `.claude/RESERVE_SLOT_PROJECT.md`, owner decisions locked (memory not Outlook · 2-workday TTL · 3 holds/person, VIP-gated later · brief shows holds · only on explicit pick-and-defer). **Storage decision recommended = a dedicated `slot_holds` table (NOT the requests spine)** — owner leaning that way; confirm before building. A handful of open build questions remain (see the doc's "Open questions" + the chat where they were enumerated).

**What v3.4.0 shipped (this bug-bash):** **#127** owner own-day overrides book in ONE step + heads-up (focus floor / hours / lunch / his own busy-collision) — no more 2nd/3rd "yes"; only double-booking a *colleague* still asks once. **#128** urgent colleague MUST-BE requests route to owner `create_approval(policy_exception)` with surfaced soft-blocked options (reuses relaxed-recovery + soft-block-hint, no new pass; `must_be` flag, colleague-only) + `within_lead_time` is now a labeled (not silent) rejection. **#131** prior user messages carry their send-time so "tomorrow" anchors to when it was said. **#132** `get_person_memory` returns the stored email/identity (was hidden). Calendar `overlap` issues self-heal (re-validated vs live calendar before surfacing — kills the stale "Yael vs El Al flight" nag after an Outlook move). **#130** humanGate question-inversion fix (guard chat). **Decided not to fix now:** #129 (above); 130a duration-enum snap + slot-count narration are prompt-chat items.

## 🔭 v3.3.12 — Boston-trip rescheduling bug-bash (create-vs-move slop)

Real-day wave: "move my Israeli weekly 1:1s around my Boston trip" → Maelle **created one-time duplicates** next to the live recurring series (wrong 25-min duration on the fresh creates), and resolved "the Sunday **after** the trip" to **June 21** (nearest upcoming Sunday from today) instead of **July 5**. Root cause was **tool-selection, not a missing capability**: move_meeting exists and works (single-occurrence exception, inherits duration — proven by the in-thread recovery), but the **tool-description contracts pushed create over move** (create = "THE booking tool" / the find_available_slots endpoint; move framed only against delete+recreate). Owner chose the **description-contract fix over a code guard** (a horizon-widened guard would risk blocking legit new bookings). Both contracts + a trip-relative-date confirm rule landed in `meetings.ts` (prompt chat). **It's a soft fix — watch the next real reschedule; the code-guard fallback is documented at `.claude/SLOP_BLOCKER_PROJECT.md`.** Also: the v3.3.10 10-min catch-up heartbeat log is now throttled to ≤1/hr (scan still runs every tick).

**Correction worth remembering:** the initial read of this incident was "she lied / the honesty layer was silenced." That was WRONG — the claim-checker performed correctly (its flags were false-positives, correctly suppressed); every "done/moved" was a truthful report of a wrong action. This was a wrong-ACTION bug, not a dishonesty one. Don't re-litigate the honesty layer for this class.

## 🔭 v3.3.11 — NEXT CHAT: more real-day bugs + the SLOT PICKER

The owner is bringing **more bugs** (he has a queue) AND wants to take on **the slot picker** — both the `find_available_slots` regressions and the **reserve-slot-on-pick build (#30)**, whose plan is written and waiting at **`.claude/RESERVE_SLOT_PROJECT.md`** (3 open decisions flagged: hold TTL 1-vs-2 workdays, brief visibility, owner-side visibility). Standing mode unchanged: trace `logs/maelle-YYYY-MM-DD.log`, **propose-first, code-first**, wait for a per-bug **"fix it"**.

**⚠️ WRAP DISCIPLINE (I drifted on this — don't repeat):** "done", "ok", "fix it", "include chat" are **build/ack words, NOT wrap signals.** Build → typecheck → STOP → summarize ("tree shows X, your call when to bundle"). Only bump `package.json` / CHANGELOG / commit / push on an explicit **"wrap / ship / commit / cut a version"**. I bumped 3.3.11 on a bare "done" this session — the owner corrected it.

**⚠️ RESTART to load v3.3.11** — `npm run deploy` (build → `pm2 restart maelle` → tail). She runs under **PM2 fork** now; the boot log prints `version` + `gitSha` — confirm it matches HEAD (she has repeatedly run a stale `dist`/process). Watchdog self-heals a cleanly-dead socket; a **half-dead socket** (Bolt says `connected=true` while deaf) is covered by the 10-min **periodic catch-up** (proven live on Dina, 2026-06-14) — but only after a restart loads it.

### Regression watchlist — the clusters that keep biting (fix at root, never re-patch)
- **The slot picker (`find_available_slots`) is the hot zone.** This arc alone: merged-free/busy carve (the "Michal still there" / vacated-slot class — `carveRangeFromBusy`), `checkSlot` as the ONE validator for verdicts AND bookings (no more search-vs-book whipsaw), the phantom **5-min buffer** (gone from search + checkSlot + check_join — keeps trying to resurface; buffer lives in meeting LENGTHS), focus-floor surfaced as "loaded, want override?" not "no time", **requester-flexibility** (3.3.11: a colleague who REQUESTED a meeting flexes; owner is the constraint; reuse `annotateSlotsWithAttendeeStatus`), offered-slots stash so a pick binds to the offered instant (the wrong-Tuesday class). Expect more here.
- **Recovery / socket.** 3 layers now: startup + reconnect-watchdog + 10-min periodic catch-up (HTTP, covers the half-dead socket). Watermark = "last socket-alive", scoped to the real gap (no 24h cap), one reply per distinct unread thread, registry-free panel discovery. Watch restart/quiet-period logs.
- **Language.** Inbound mirrors the sender's current message (detectMessageLanguage re-stamps Latin too); stored `language_preference` is OUTBOUND-only (compose/outreach), surfaced as `language_pref` on the owner-path contact line. The capture over-eagerly saves a pref from a one-time "do you speak X?" (Dina/Dirk/Ayala) — owner watching whether it's one-off or recurring before we touch capture.
- **Claim-checker false-positives.** Proposals/offers flagged as phantom actions → the own-the-miss rewriter has an `UNCHANGED` veto (runs on Sonnet). Still on Haiku for the classifier itself.
- **Coord is demoted** (colleague-path): colleagues book via the DIRECT path; coord is owner-path/explicit only. FUTURE: external transports (WhatsApp/email) re-enable coord for calendar-invisible requesters.
- **Social coda on transactional/urgent turns** (Dina "do you have any pets?" on an urgent webinar escalation) — owner said **ignore for now**, but it's a known rough edge (deferred #4).
- **Guards Hebrew leak — STILL OPEN.** Colleague-facing Hebrew leaks ("הכלי", "slots", "visibility", bot-framing). Handoff at `.claude/GUARDS_LEAK_HANDOFF.md`; the claim-checker-veto handoff at `.claude/CLAIM_CHECKER_FALSE_POSITIVE_HANDOFF.md`. The parallel **guards chat** owns these — confirm landed before assuming fixed.

**Parallel chats on the same repo:** a **prompt chat** (owns the system-prompt — language rules, scheduling narration "name the blocker", RULE-7 override; Bug 2 narration was sharpened there this wave) and the **guards chat**. At wrap: `git fetch` + check origin/master + the tree for their edits before committing.

### What shipped 3.3.7 → 3.3.11 (this arc — read CHANGELOG for detail)
- **3.3.7** colleague-availability truth: one validator, slot-finder carve, guards stop corrupting clean drafts.
- **3.3.8** conversation-state: offered-slots stash (picks bind), per-day travel TZ, **coord demoted from colleague path**, content-dedup 90s→5s, #126 coord-requester threading.
- **3.3.9** ops: single-process PM2, `npm run deploy`, startup build stamp, **`trace` skill** (post-build scenario matrix at 100%).
- **3.3.10** recovery rewrite (decoupled from startup: watermark + registry-free discovery + socket watchdog + periodic catch-up) + language inbound/outbound split + bot self-mention slack_id leak closed.
- **3.3.11** colleague-requested scheduling: requester flexes (reuse annotation), requester close-loop subject-leak filter.

---

## 🔁 v3.3.6 — real-day bug wave, and the theme is: WE KEEP HITTING THE SAME BUGS

Next chat is **another reactive bug wave** (same standing mode: trace `logs/maelle-YYYY-MM-DD.log`, propose-first, **code-first**, wait for a per-bug "fix it"). The owner's framing this session: *we keep repeating the same bugs.* The recurring clusters to expect — and to fix at the **root**, not patch again:
- **Cross-timezone scheduling.** Inverted ET↔Israel labels, an ET time searched as Israel time, an organizer's own hours clipping the search. v3.3.6 added the deterministic tools (`present_in_timezone` output, `search_window_timezone` input, per-day time clamp, `requester_is_attending`) — but they depend on Sonnet **setting the flags**; the Yael-determinism prompt block is queued for the prompt chat. Watch for cross-TZ asks still going wrong = flags not set.
- **Lunch / floating blocks.** "Ask instead of move" (fixed: rule-8 skips movable blocks) and the active sweep silently doing nothing (fixed: `rebalanceFloatingBlocks` ±24h date-guard). Watch for lunch not auto-sliding.
- **On-restart catch-up / recovery.** v3.3.6 routed catch-up **through the live path** (`inboundReplayRegistry`) and fixed the `file_share` filter so voice/video/image are recovered. Watch the restart logs: a missed message of any type should now be detected → replayed → answered.
- **Guard leaks (STILL OPEN).** Colleague-facing Hebrew leaks ("הכלי", "slots", "visibility", bot-framing) — securityGate is English-only regex + humanGate is on Haiku. The fix is the **parallel guards chat's** job; handoff at `.claude/GUARDS_LEAK_HANDOFF.md`. **It is NOT in the repo yet** — confirm the guards chat landed it before assuming it's fixed.

What v3.3.6 shipped (see CHANGELOG): cross-TZ tool set; **morning brief now folds in a today-scoped active calendar-health pass** and the **07:00 standalone health routine is retired** (it's `13:00`-only — full this-week+next-week sweep); lunch rule-8 + rebalance date-guard; catch-up via live path; Eli false-close referent backstop. (Earlier this arc, folded into **3.3.5** by the guards chat: claimChecker `other`-tool shield, dateVerifier bare-weekday-pass deletion, reminder/follow_up/research spine consolidation, Bug8 image-to-text, booking thread-match.)

**Owner must RESTART `npm run dev`** to load v3.3.6 (briefs/app/background changed). **Parallel chats on the same repo:** guards chat (#4/#5 leak) + a prompt chat (Yael TZ-flag reinforcement, persona/phrasing fixes). At wrap: `git fetch` + check origin/master + the working tree for their commits/uncommitted edits before committing — heavy cross-chat overlap this arc (3.3.5 bundled multiple chats' work).


## 📰 NEWS — delivered (v3.3.4); now we want to TRACK it in real use

The personalized news brief (#17) is feature-complete. The latest change (v3.3.4) is a **re-pull model**: the daily edition shows up to ~6–7 **relevant** items (relevance is the bar — never padded to a count), and the seen-log now records only what was **shown** (cited in the brief), not everything gathered — so an article that didn't make today's cut **resurfaces on a later day's re-pull** instead of being silently buried. Source steer ("prefer Stratechery, skip tabloids") is LLM-emitted into Tavily include/exclude; topics + sources are taught via `update_my_preferences(skill='news')` → `config/users/<owner>_prefs/news.md` (code never parses that file). **What we want to track now (next sessions):** does it surface ~6–7 *genuinely relevant* items/day · do unshown-but-recent ones come back the next day (not repeats of what was seen) · does the seen-log hold only shown items · is the source steer honored. Open follow-up: **#123** (importance-*ordering* of the daily edition — deferred, low). Watch `logs/` for the news gather/`writeSeenLog` lines.

## ✅ THIS ARC IS DONE — next chat = bugs + improvements; PARALLEL chats: WhatsApp + news

A long multi-feature + bug-bash arc just wrapped (v3.2.5 → v3.3.3): the **proactive-social rework** (cold-open killed, coda-only — see the v3.2.5 section below; its two "deferred follow-ups" both SHIPPED this arc — the coda `+1`/`−1`/revival rank scoring **and** the work-vs-social capture-pass exclusion), the v3.3.0 **news brief + thread actions**, the v3.3.x **audit waves**, and a real-day **bug-bash (v3.3.3)**: calendar-health window narrowed to *this week + next week*, full-day-OOF lunch skip, **no social coda on system reports** (routine/research run `interactive: false`), colleague-booking location/approval fix, **duration-snap verify** (no silent 2h→55), dateVerifier stops guessing weekdays, a **shared robust JSON parser across 10 gates** (`utils/extractJson.ts`), and news within-batch dedup.

**Next chat = reactive bugs + improvements** — the standing mode: trace `logs/maelle-YYYY-MM-DD.log`, propose-first, **code-first**, wait for a per-bug "fix it". **Preference changes go to the owner's Slack memory via `update_my_preferences`, NOT code/prompt** (owner sets them; the prompt is a budget). Two PARALLEL chats run alongside this one: **(1) WhatsApp** — first non-Slack `Connection` implementation (architecture's ready; skills speak through `getConnection`, never import `connectors/slack/*`); **(2) finish the news work** (close remaining gaps in the v3.3.0 news brief). At wrap: `git fetch` + check for parallel-chat commits/uncommitted edits before committing — this arc had heavy cross-chat overlap.

**Still-open deferred bugs (from the v3.3.3 bash — NOT built):**
- **Wrong-week copy/move** — copying a meeting to "weds" resolves to the next *calendar* Wednesday, not the referenced event's week. Accepted as irreducible (no clean guard without false-firing on routine single-occurrence edits / doubling request cost); owner catches it manually.
- **Disconnected owner reminder** — colleague-initiated approvals don't capture `owner_dm_thread_ts`, so reminders land as standalone DMs (thread-continuity class, same family as the Dina 2-DM bug). Deferred ("too complicated").
- **Daily re-flag (residual)** — conflicts *inside* the 2-week health window still re-narrate each morning until resolved (6.1 shrank the window but added no per-issue informed-suppression).

## 🧩 v3.2.5 — proactive social reworked: ONE engine, ONE surface

The two-system split was collapsed. The **cold-open** hourly tick (`social_outreach_tick`) is **deleted** — no more out-of-the-blue social DMs (investigation showed it pinged the same 1–3 people, qualified by *work* topics mis-filed as social, who ignored it → ranks ratcheted down). Proactive social now happens **only as an in-conversation coda** riding a live turn (the 3-category picker is the single decision engine). On a work/scheduling turn the coda fires at the **end of the process** (resolved, or handed off to coord/approval/outreach), **suppressed mid-exchange** via `turnLeftWorkPending` (option A). Bundled with parallel-chat latency + brief + preference work (see CHANGELOG 3.2.5).

**Deferred follow-ups (designed, NOT built — these are the next social work):**
1. **Coda RANK scoring is asymmetric** — `social_ping_rank_check kind='coda'` only does `−1`, never `+1`. With cold-open gone it's the sole scoring path; needs `+1` on engagement, one-vs-three rank-path reconciliation (`adjustRankFromColleagueResponse` overlaps it), and a **rank-0 revival** (retry once after 30d of no contact + prior interaction).
2. **Work-vs-social at the capture pass** — `runSubjectReconciliation` (`capturePass.ts`) still files work content ("Idan call scheduling" → `partner`) as social subjects, so a `continue` coda can still raise a work topic. Needs a work-exclusion rule in the reconcile classifier + a one-time cleanup of polluted rows. `people_memory.proactive_pending` is now vestigial (sweep it here).

## 🚨 v3.2.4 — STABILIZATION WAVE. NOT STABLE YET — next session is ANOTHER BUG WAVE.

Maelle is in daily real use and **broke hard this stretch** — she crashed mid-day on a transient Slack socket event and, with PM2 off, **stayed down all day**; then on restart didn't replay the missed DMs. The big builds are done; the job now is **keep her alive and correct under real load.** Default mode = reactive, code-first bug-bashing (trace `logs/`, propose-first, no auto-fix, wait for a per-bug "fix it").

**Shipped in 3.2.4 (this wave + the parallel de-tenant chat — one bundle):**
- **Crash resilience** (`index.ts`) — a transient `@slack/socket-mode` / finity error (e.g. *"Unhandled event 'server hello' in state 'connected'"*) no longer kills the process: socket-transients are matched by **stack + message** and survived, and a stray `unhandledRejection` **no longer `process.exit(1)`s**. This is what took her down all day.
- **Recovery diagnostics + broadened scan** (`background.ts`) — catch-up now scans **all 1:1 DMs** (was owner-only) and logs a per-DM decision. **STILL INCOMPLETE — see #122:** the real fix (same-thread answered-check + reading inside Slack AI-assistant threads + the colleague-panel storage question) is deferred.
- **Slot finder won't clip the work day** (`meetings.ts`) — a timed `search_from/search_to` is now **soft by default** (`time_window_is_hard` flag); the search spans the full work day incl **night shift**, so a US-colleague's afternoon overlap (= owner's night shift) is no longer dropped. Code-enforced, not prompt-dependent (the de-tenant prompt alone didn't stop the narrowing).
- **De-tenant continuation (parallel chat)** — neutral `free_time_per_office_day_hours` default (2→0), locale-aware date/time (`user.language`), internationalized gender classifier, US `MM/DD` date parsing for `America/*`, and Working-Elsewhere surfacing in `get_calendar`/`analyze_calendar` + an `owner_working_elsewhere` slot label.

**FIRST THING NEXT SESSION — it's a bug wave, assume instability:**
1. Confirm she **stayed up** since the crash fix (no all-day silence again); skim `logs/` for `Unhandled rejection (kept alive` warnings (means a transient was survived — good).
2. Verify the **night-shift slot fix** held on a real cross-TZ scheduling ask.
3. Take whatever real-day bugs the owner brings — they interrupt and get folded in.

**Open tickets (deferred, by owner):** **#121** cross-turn calendar cache (arch); **#122** on-restart recovery rebuild (same-thread answered-check + assistant-panel storage — the colleague-panel messages aren't in scannable `im` channels; likely needs `assistant.threads`). The 3.2.3 de-tenant "open threads" below are mostly **resolved** in 3.2.4 (timezone overlap now computed, free-time default neutralized, date-locale/parsing/gender de-tenanted).

## 🧭 v3.2.3 — DE-TENANT / MEMORY-LAYER arc started (this is a DESIGN arc, not just bugs)

A design session kicked off the "de-Idan-ification" work: Maelle has owner-specific logic leaked into prompts/code dressed as "general." The framework — every leak sorts into **(1) genuinely general → YAML**, **(2) computable → derive in code**, **(3) taste/judgment → learned per-user store**. Sharper test the owner added: *"would every employer teach a human secretary this?"* No → it's his agenda, not universal. The store layer must be **free-text, per-user data the LLM reads — never in the shipped binary**; deterministic gates stay code/config.

**SHIPPED in 3.2.3 (built, typecheck-clean, NOT live-verified):**
- **Per-skill learned-preference layer** — free-text `config/users/<owner>_prefs/<skill>.md` injected at the bottom of each skill's prompt (owner-path, scope-gated). Write via `update_my_preferences(skill, mode, text)` (always-on, owner-only). Live for calendar-health. The owner tested the capture loop live (Comeet-duplicate pref saved correctly).
- **Working Elsewhere mode** (`.claude/WORKING_ELSEWHERE_MODE.md` = spec). All-day Outlook `workingElsewhere` marker → rules suspended that day, availability tentative in the away-TZ (location→TZ resolved off-loop via static→Sonnet, cached, **fails loud**), bookings → approval, active-mode auto-fix skipped. `manage_working_elsewhere(set|clear)` creates/clears the marker from chat. **Invariant: no all-day WE marker → byte-identical behavior.**

**FIRST THING NEXT SESSION — verify both live** (owner restarts `npm run dev`): (a) prefs loop honored in a real calendar review; (b) WE-mode on the real **week of 2026-06-28** (`scripts/check-calendar-period.mjs 2026-06-28 2026-07-04` — there's a real "Boston placeholder" all-day WE marker; expect Boston-time tentative slots, the 10:00-Israel/03:00-Boston ones excluded).

**OPEN THREADS from this session (proposed, NOT built):**
- **De-tenant audit findings** (propose-only, bucket-sorted): the poster-child **timezone_preferences prompt leak** (`meetings.ts:~1970-1990` hardcodes "Israel"/"15:00"/"UK/AU" around YAML-driven labels → bucket 2, compute the overlap window from owner-TZ × attendee-TZ); plus `en-IL` date locale (`systemPrompt.ts:64`), EU-only date parsing (`availabilityPreCheck.ts:38`), Hebrew-culture gender prior (`genderDetect.ts:96`).
- **Free-time-floor parameter bridge** — the Tier-1 recovery: `free_time_per_office/home_day_hours` (+ the office/home asymmetry) is Idan-psychology baked as a YAML default a 2nd tenant silently inherits; move behind `getEffective*` (neutral default + learned override). (Owner set both to 2h this session.)
- **`min_slot_buffer` / `planMeeting` hole** — the lead-time buffer is enforced in `find_available_slots` search but NOT in `planMeeting`/`checkSlot`, so a direct named-time `create_meeting` bypasses it. Add a lead-time gate in `planMeeting` (colleague-path, owner 1h).
- **OOO "quiet the proactive paths"** — a full-day `oof` should pause the morning brief / proactive social pings / non-urgent reminders (none check owner OOO today). The only genuinely-new use of OOO vs busy (OOF-conflict flagging already exists). Plus a one-line tightening: OOF detector → `isAllDay && showAs==='oof'` (owner: OOO is always full-day, never per-event).
- **Tentative status** — future: coord temp-holds + "which events Maelle accepted" once she has Outlook write/accept access.

## ✅ SHIPPED v3.2.0 — Person Store + grounded research, hardened by a real-day bug bash

Minor that caps a multi-session arc (foundation across 3.1.7–3.1.8; polish + root-cause fixes in 3.2.0).

## 🎯 CURRENT MODE — real-day bug waves (this is the main work now)

Maelle is in **daily real-world use** at work, and the big builds are done (Person Store ✅, requests spine ✅, grounded research ✅). So the default mode now is **reactive, code-first bug-bashing**: the owner brings **waves of bugs from actual usage** (often pasted Slack chats + screenshots), usually after a work session. Expect several at once. How to run it:

- **Don't assume — trace.** Read `logs/maelle-YYYY-MM-DD.log` + the code; state root cause as `file:line — what happens`. The owner has zero patience for guessing and will call it out.
- **Propose first, never auto-fix.** Bug reports / frustration / screenshots are diagnostic signals, not build signals. Mark each atomic bug → what happened / issue / suggested change / risk → wait for an explicit per-bug "fix it / do D5 / build that".
- **Code-first, root-cause, no patch-on-patch.** Fix at the chokepoint; remove the rotting layer rather than stack a new one. Prompt is a last resort — and the owner manages the system prompt in a **separate "prompt chat"**: for prompt-class fixes, *write him a clean prompt block to move there* (explain issue + code context so the block is good), don't bloat the in-repo prompt.
- **Couple of small upgrades will fall out of the bugs** — quarter-snap, vacated-slot, status texts were all bug-driven. Take those when a bug points at them; don't go hunting for big new features.
- **Wrap when he says** ("wrap / ship / cut a version"); default patch, minor only on his call. He often runs **parallel chats** on the same repo — at wrap time, `git fetch` + check for other-chat commits/uncommitted edits in the shared tree before committing.

Parked until a bug wave or owner pivot points there: GitHub #22 (external social), WhatsApp transport, fully dropping the vestigial `coord_jobs.status`/`outreach_jobs.status` columns.

What 3.2.0 added on top of the Person Store (below): in-flight guard no longer orphans on confirm-override pauses (killed the "still working on booking Dana & Max" brief nag) + dead subject-match fallback removed; `move_meeting` returns `vacated` (the freed slot) so "move X into the open slot" resolves; floating-block move snaps to the quarter grid (lunch :40→:45); claim-checker no longer flags a proposal as a phantom action (the screenshot-reply degradation); full per-tool Slack status coverage (internal pre-passes skip, no "Working" placeholder). **Prompt-side fixes (D1–D3: relax-vs-working-day, answer-the-question, don't-cite-day-conflicts; + move_meeting vacated-slot narration) were handed to the prompt chat by the owner — not in the repo.** CHANGELOG has the full 3.2.0 entry.

## ✅ Unified Person Store (`.claude/PERSON_STORE_PROJECT.md` = the build spec)

Done, all phases, one build. `people_memory` rebuilt onto a surrogate **`person_id` PK** (migration `src/db/migrations/v3_2_0_person_store.ts` — backup + row-count assertion + idempotent; verified live 36/36); `slack_id`/`email` nullable identity attrs; `kind` internal|external|self. **`resolvePerson({slackId?,email?,name?})`** in `db/people.ts` is THE find-or-create+merge chokepoint; write helpers have `*ById` workers (slack variants delegate). `recordBooking` persists EVERY attendee (externals included, slack_id threaded as the dedup handle, room mailbox skipped) → externals recalled next booking. Write-tools (`note_about_person`/`log_interaction`/`confirm_gender`/`update_person_profile`) route through `resolvePersonTarget` so email-only externals are writable (owner-path). Md files re-keyed name-slug → `person_id` (collision fix; legacy migrates on touch). Capability-gating not storage-gating: proactive social + free/busy stay internal-only. **Known limits (owner-accepted):** external→Slack convert makes a 2nd row (no inbound merge; rare); booking history lives in md "What we've discussed", not the structured `recent_interactions` recall (by design). **Future:** opens GitHub #22.

## PATH 2 IS COMPLETE (v3.1.0 → v3.1.2). Requests spine owns status, end to end.

The `requests` table is the single source of truth for lifecycle. Side tables (`coord_jobs`/`outreach_jobs`/`approvals`) hold DATA only — their `status` columns are VESTIGIAL (transition signals to updateCoord/OutreachJob, never persisted; reads go through `getCoordLifecycle`/`getOutreachLifecycle`). `approvals.status` retained intentionally (payload lives in `approvals`; request owns `awaiting_owner`). **One timer sweep** (`sweepDueRequests`, wired at `tasks/runner.ts:39` inside `runDueTasks`) owns ALL lifecycle timing. Reconciliation (`core/requests/reconcile.ts`) closes orphaned coord requests; 30-day retention prune. Architecture doc current: `project_architecture.md`.

## What shipped 3.1.3 → 3.1.6 (real-day bug-bash, code-first)

Read CHANGELOG.md top-to-bottom for detail. Highlights by theme:

- **3.1.3 — timezone-is-never-a-location.** Root cause was `textScrubber.humanizeIanaToken` converting IANA strings → city names ("Asia/Jerusalem" → "Jerusalem") on every outbound post; now emits the TZ abbreviation, never a city. Location for narration comes from `people_memory.state`; timezone is for math only. Plus: shared daily-free-time floor (`computeDayQualityFreeMinutes` in `scheduleRules`, enforced at BOTH search + `checkSlot` write via rule `focus_time_floor`); free-time questions run `analyzeCalendar` deterministically (classifyTurn `freeTimeInquiry`); brief closure narration stopped fabricating "I told her" on owner-side closures.
- **3.1.4 — colleague-scheduling correctness (Yossi wave) + tool-scope reduction.** Requester-controls model: whoever REQUESTED a meeting controls it (add/rename/move/location) via `findMeetingOwner`; `update_meeting` now colleague-allowed behind a requester gate; direct colleague bookings record a requester-link on the spine. Shared `resolveAttendeeEmails` helper (name→email, never ask a colleague for a teammate's email). Pick-of-offered-slot books directly (no window-collapse retract). Tool-scope Block 2: ALWAYS_ON 22→12, new `coord`/`people` scopes.
- **3.1.5 / 3.1.6 — prompt-reduction regressions + scheduling quality.** Floating-block self-rejection on packed days (rule 6 skips the block being booked when `isFloatingBlock`); humanGate catches "the tool is telling me"; date-correction is now a cheap tool-less rewrite (`rewriteWithCorrectDates`, ~30s→~1-2s, no orchestrator re-run); `pickSpreadSlots` fill-pass won't offer overlapping slots; duration defaults to `default_meeting_duration` when unspecified (no more "interview → 55"); rename-on-thanks guard (strip write tools when a non-task ack follows a completed mutation); morning-brief no longer opens with "Morning —" (Slack preview leads with the calendar); delete-confirm no longer double-asks.

**The bugs SKILL was rewritten this wave (`.claude/skills/bugs/SKILL.md`):** CODE-FIRST is now explicit — fix at the core in code (chokepoint guard / a return-value the model reacts to / a tool that owns the decision); prompt rules are a LAST resort for judgment/tone/format/language only, never enforcement; avoid regex on natural-language text (Maelle is multilingual). Same discipline lives in the "How we fix bugs" section below.

**Open bug filed:** [#119](https://github.com/odahviing/AI-Executive-Assistant/issues/119) — active-mode calendar health never auto-books next-week lunch (detection doesn't fire for the forward window; deferred, not fixed).

**FIRST THING NEXT SESSION:** confirm Maelle runs clean on v3.1.6 (owner restarts `npm run dev`; PM2 off). Then start the Person Store project (above) — or take whatever real-day bugs the owner brings first.

## How we fix bugs — CODE-FIRST, root-cause, no patch-on-patch (standing principle)

The prompt is a budget, not a junk drawer. We've pulled the common owner turn from ~59k → ~36k tokens by moving rules into code; **never regress that to fix a bug.** Adding a prompt rule to patch behavior is the v2.x habit that bloated the prefix and produced patch-on-patch — Sonnet ignores rules under load, and every rule is billed on every turn forever.

The loop for any bug:
1. **Reproduce / trace, don't guess.** Read `logs/maelle-YYYY-MM-DD.log` and the code. State the root cause as `file:line — what actually happens`. If you're guessing, say so.
2. **Fix at the core, in code.** The durable fix is deterministic enforcement at the chokepoint (a handler guard, a return-value the model reacts to, a tool that owns the decision). Code fixed once stays fixed; it costs zero prompt tokens. This is the location-tree / `resolveLocation`, the slot-alignment / `alignNearestQuarter`, the `detectMessageLanguage` pattern — the rule lives in code, the prompt at most points at it.
3. **No stacking.** Most of our bugs are well-understood by now. If a prior fix didn't stick, it patched a symptom — **remove or replace the rotting layer; never add a new layer on top** (RULE 2e v2.1.0→2.2.6 cautionary tale). Use existing systems (requests spine, approvals payload, category flags) before inventing new state.
4. **Prefer DELETING prompt + adding code** over editing prompt. Net prompt should go down, not up.

**When prompt IS the right tool:** judgment, tone, format, reasoning, audience-awareness, language/voice — things code genuinely can't decide. The prompt may *guide where* the solution is ("the tool returns `broken_rule_label` — paste it"), but it must not *be* the enforcement. If you're tempted to add an enforcement rule to the prompt, that's the signal the fix belongs in code.

## What just shipped (3.0.4 → 3.0.7)

Four patch versions in two days of real-day-bug-bashing. Read CHANGELOG.md top-to-bottom for the full picture; highlights:

- **3.0.4** — identity-spoof guard in security gate, v3.0.4 schema-defaults pass, `message_colleague` silent-fail kill (Path 2 stages 0+1: deleted the duplicate `createRequest` block in outreach.ts that idempotency_key-collided)
- **3.0.5** — endless-approval root cause (`#` prefix on approval IDs in prompt → resolver silent-fail), identity-spoof redesigned (email-mismatch trigger + Haiku composer), attendee-memory write on booking, lunch-gap preemptive dismiss via `manage_calendar_issue(date, block_name)`, `<URL|text>` strip deleted (#113), startup version DM removed
- **3.0.6** — 54-atomic-fix V3 audit bug-bash (phantom-confirmed bookings, force-book winning_slot leak, recheckFreeBusyForBooking shared helper, owner override truly total, capture-pass timezone gated by isStrictIana, ~400 LOC dead code removed) + claim-checker covers action-based verb tools (manage_routine/manage_calendar_issue/update_task/etc.)
- **3.0.7** — slot-finder ↔ rule-engine consistency on lunch feasibility, close-loop DM to colleague-requester via requests spine (broadened subject match), `coordinate_meeting` HARD STOP when owner just picked a slot, `_slot_results_now_stale` flag on slot-relevant profile/memory writes, `find_available_slots` date-only `search_to` expansion (was collapsing to 0-minute window when search_from === search_to), `create_meeting` array guard on `args.attendees`, claim-checker pruned to RULE A + coda mode (Module F/E extended-rule plumbing removed per v2.8.5)

## Work queue — Person Store FIRST, then deferred bugs, then WhatsApp

Owner direction: propose-first per item, smaller/verified moves win. **Order: (1) Unified Person Store — see the ⭐ section at top + `.claude/PERSON_STORE_PROJECT.md`; (2) the still-open deferred bugs below (#3/#4/#5/#8); (3) WhatsApp.** Plus whatever real-day bugs the owner brings — those interrupt and get folded in.

**Resolved during Path 2 (v3.0.8–v3.1.2):** #1 Dina thread-continuity, #2 shadow-mirrors-pre-gate, #6 coord auto-cancel on direct create, #7 reply-routing priority. **Still open: #3, #4, #5, #8** (below). (#5 may be partly covered now — verify against current securityGate before building.)

### Deferred bug list (from 3.0.7 session — all real-day-observed)

1. **Dina 2-DMs (thread continuity)** — `message_colleague` opens a new top-level DM every call, even when there's a recent open conversation with the same colleague. Slack sidebar shows two parallel threads on the same topic. Fix is Path 2 stage 2 work: add `target_dm_channel` + `target_dm_thread_ts` to `requests` (or details_json), then in message_colleague send path: look up open colleague-initiated request for same `target_slack_id` within last N hours, post as thread reply if found.

2. **Shadow mirrors pre-gate draft** — `shadowNotify` fires from `core/orchestrator/index.ts:1867` BEFORE postReply.ts runs humanGate/securityGate/claim-checker. When humanGate rewrites a draft (e.g. scrubs a leaked `req_` ID), the shadow shows owner the LEAKY pre-gate version while the colleague gets the CLEAN post-gate version. Move shadow into `postReply.ts` after the gate stack, using the post-gate `cleanReply` variable.

3. **Multi-lang drift (L1)** — language-match rule is in the static prompt, Sonnet follows for turn 1 then drifts back to English on subsequent turns. Fix: code-side `detectMessageLanguage(text)` using Unicode-block ranges (Cyrillic/Hebrew/Arabic/Latin+diacritics), inject fresh per-turn LANGUAGE block into the dynamic prompt section.

4. **Social coda on FYI outreach (L3)** — when colleague replies to a transactional outreach (`intent='fyi'`/`'reminder'`/`'meeting_confirmation'`/etc.), Maelle still adds chatty social codas. Fix: gate `chooseSocialDirective` on `priorOutreachIntent` from the matched outreach row; skip engagement directive entirely for transactional intents. Pure DB enum check, no regex.

5. **Request-ID securityGate backstop** — Sonnet drafted `"There's already a pending approval for this exact request (#req_1779794031248_b3w7l)…"` and humanGate caught it. If humanGate ever fails open (Sonnet timeout, non-JSON), the leak ships. Add pattern `\b#?(req|task|coord|out|ci)_[a-z0-9_]+\b` to securityGate's trigger set. Regex on structured IDs is fine (different from regex on natural language).

6. **Coord auto-cancel on `create_meeting` success** — when a meeting gets booked outside the coord state machine (owner-direct create_meeting) AND there's an in-flight `coord_job` for the same subject/attendees, the coord_job stays alive and keeps DMing participants for slot selection. Add to `closeMeetingArtifacts`: detect orphaned coord_jobs by subject+attendees overlap, transition them to `cancelled` with `closure_reason='superseded_by_direct_create'`.

7. **Reply routing priority (Isaac msg_colleague vs coord)** — `recentOutboundContext` LLM classifier matched Isaac's "I can only do Monday and Thursday" reply to the message_colleague outreach instead of the coord_job that had also DM'd him 12 seconds later. Classifier should prefer coord over outreach when both have open context for the same colleague.

8. **planMeeting `propose_alternative` verdict for colleague-soft-rule slots** — currently when a colleague-proposed slot violates a soft rule (lunch/focus/work-hours), planMeeting returns `escalate_approval` and the colleague waits for owner approval. Owner direction: should first try to find alternatives nearby (same day, ±1 day). New verdict + handler path.

### Path 2 — DONE (no remaining stages)

All stages shipped (v3.1.0–v3.1.2). Requests spine owns status; one timer sweep; side tables data-only. The physical `coord_jobs.status` / `outreach_jobs.status` columns are retained but vestigial (no risky table rebuild) — fully dropping the columns is the only crumb left, and it's optional (they're unread). Nothing here blocks new work.

### WhatsApp build (parked — after the Person Store + open deferred bugs)

v3 was originally framed as the WhatsApp build — first non-Slack `Connection` implementation. Architecture is ready (skills never import from `connectors/slack/*`; everything routes through `getConnection(ownerId, 'slack')`). WhatsApp slots in as a parallel transport.

Read these two memory files at session start:
- `C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_overview.md`
- `C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_architecture.md`

Plus the feedback memories (cross-session rules the owner has set) — they auto-load via `MEMORY.md`.

---

## The two principles that govern every change

**1. Code over prompt.** Determinism belongs in code (rule checks, idempotency, location decisions, date alignment, approval sync, honesty signals). Judgment and tone belong in the prompt. When something can be code-enforced, code-enforce it; when something is judgment-class, leave it to the LLM. **The work direction is constant: prompt shorter, code more deterministic, let the LLM reason within fewer rails — not against them.**

**2. Tooling over new tools.** Before proposing a new tool or a new long prompt section: look first at the existing tooling. Can we extend a current tool's action enum? Can we replace a prompt rule with a code-side guard (claim-checker check, deterministic helper)? New tools and long prompts are the last resort, not the first.

---

## Bug-fix flow — never auto-fix

Every bug report follows the same four steps:

1. **Understand.** Read the screenshot / issue / chat report. Code-trace against current files on disk. Don't guess.
2. **Plan.** Identify root cause (file + line + mechanism). Map to the fewest possible changes.
3. **Suggest.** Write up the proposal: what's broken, where, what the fix is. Prefer prompt-tweak over new-rule; prefer extending an existing helper over a new file; prefer code-side determinism over a new prompt rule. Wait for owner feedback — he often re-frames or rejects the agent's first read, and that iteration IS the value.
4. **Build.** Only after explicit approval. Run typecheck. Stop. Summarize the uncommitted tree.

**Never bundle multiple fixes without owner saying so.** Default version bump is PATCH unless the owner explicitly says minor.

### The build-signal trap

The most-recurring drift pattern: the agent treats "owner is reporting/talking about bugs" as approval to fix them. **It is not.** Frustration, ALL-CAPS, "this is disappointing", "still broken" — these are **diagnostic signals**, not build signals. They mean **propose more thoroughly**, not **start typing code**.

Hard rules:
- **Only these are build signals**: "fix it" / "fix N" / "go build that" / "land it" / "do it" / "do A" / "build B" — applied to a SPECIFIC bug or fix shape. Never "OK", "yes", "go ahead" with no referent — those are ambiguous, ask.
- **NOT build signals**: bug reports, frustration, screenshots, "this should have been fixed yesterday", "doesn't make sense", "isn't it X?". When in doubt, propose and wait.
- **Reads are free, writes are not**: `gh issue view`, DB queries, log greps, code reads — never ask permission. But code edits, even small, need explicit per-bug build signal.

---

## Bundle signals — the loud rule

Do NOT bump `package.json`, write CHANGELOG, update memory, commit, or push unless the owner has explicitly said one of: **"wrap up" / "ship it" / "close the patch" / "cut a version" / "bundle" / "commit" / "push" / "let's finish for today"**.

These look like approval but are **NOT** bundle signals — they're build-only:

- "go" / "go ahead" / "go for all"
- "yes" / "ok" / "do this"
- "land it" / "fix it" / "build it" / "start building"

On those words: write code, typecheck, stop. Close with *"Built and typecheck clean. Tree shows: [files]. Your call when to bundle."* — never with *"Shipped 2.x.y, restart npm run dev."*

The full release checklist lives at `.claude/WRAP_UP.md`. It runs only when the owner triggers it.

---

## GitHub workflow

- **GitHub is the bug data source.** When the owner asks for a "bug pass" / "go over the github bugs" / etc., the `github` skill handles the triage flow.
- **NEVER open a GitHub issue unless the owner explicitly asks.** Surface bugs in chat or via the spawned-task chip; the owner files tickets himself.
- **Label axes**: Improvement uses High/Medium/Low; Feature uses Roadmap/Next/Idea. Never mix.
- **`gh` body files**: for any non-trivial issue/PR body, write to `C:/Users/idanc/AppData/Local/Temp/` first then pass `--body-file`. Inline HEREDOCs spam the chat.

The auto-triage GitHub Action exists but is currently **OFF** (gated `if: false &&`). Owner files issues / shows screenshots; we fix interactively.

---

## Slash-command skills

Procedures the owner runs frequently are wired as skills under `.claude/skills/`:

- **`github`** — bug triage. Pulls Bug-labeled open issues, code-traces, proposes fixes. Propose-first; never auto-fix.
- **`wrap`** — finish the session. Runs the full `.claude/WRAP_UP.md` checklist.
- **`scenario`** — paper-trace a numbered test scenario from `.claude/test-scenarios.md`. STRICT paper exercise — no live DMs, no calendar writes.
- **`bugs`** — analyze bugs the owner describes directly in chat. Propose-only.
- **`audit`** — deep parallel project audit. Spawns parallel subagents per subsystem. Returns an atomic-bug list with `file:line` citations. Propose-only.

---

## Operational state

- **PM2 + auto-deploy watcher are OFF.** Owner runs `npm run dev` directly. Restart needed to pick up code changes.
- **Auto-triage GitHub Action is OFF.** Bugs flow through chat.
- **`processedDedup` TTL is 10 minutes** — covers Slack socket-mode reconnect retry windows.
- **assistant.threads.setStatus** ("Working…" indicator) only fires in registered AI-panel threads on Slack DESKTOP. Mobile + regular DMs don't render it.

---

## Typecheck gotcha (still relevant)

When running from a Claude Code worktree under `.claude/worktrees/`, `npm run typecheck` checks the **worktree's stale source**, not the main repo. To get real coverage, always run project-mode tsc against the main repo:

```bash
npx tsc --noEmit -p E:/Code/Maelle/tsconfig.json
```

Bigger architectural facts (Connection interface, requests spine, planMeeting / resolveLocation single-decision functions, four-layer model) live in `project_architecture.md`.
