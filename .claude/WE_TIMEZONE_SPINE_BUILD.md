# WE Timezone Spine — build plan + status (START HERE on resume)

**Owner decision (2026-06-29):** build the FULL spine, max effort, "run it all." If not fixed, Maelle is OFF until he returns to Israel — she's useless on a trip otherwise. My call on revert-vs-build: **just build** — the spine REPLACES the scattered deciders, so reverting first is wasted motion; ensure the harmful behaviors (#6, the #B auto-lock) are gone in the new code.

Discipline unchanged: code-first, one source of truth, delete the old path (no back-support layers), `trace` to 100% before "done." Owner restarts to load code.

---

## THE CORE DIAGNOSIS (proven by 3 parallel log+code audits, 2026-06-29)

**One root, many masks: timezone resolution for a Working-Elsewhere (WE) day has no single owner.** "What instant does the owner's stated time mean, and how is it shown" is re-decided independently across 6+ layers that don't have to agree, and the pivotal decision (which zone did he mean) is left to the model, which fails exactly when it matters.

Evidence (full day, owner in Boston `America/New_York`, home `Asia/Jerusalem`):
- **Model tagged "Israel time" 0 / 3 times** — it passes the clock BARE. Root: the tool description tells it to tag only NON-owner zones, so it treats "Israel/home" as default → no tag.
- On a WE day, BARE → trip zone (the bare-time fix). Correct for a truly bare time; but for an untagged "6:30 IL time" it became **6:30 PM Boston = 1:30 AM Israel next day** (booking #6, the disaster — wrong time AND wrong day).
- **4/7 bookings "worked" — 3 only by luck** (bare clock == home zone on a home-week date). **Zero cases where a named non-trip zone on a trip day worked.**
- Same stated time produced **up to 3 different instants** within one turn-chain; narrated as "11:00 EDT" + "18:00 Boston" + "04:00 Boston" simultaneously.
- **Safety nets backfired:** `dateVerifier` "corrects the reply to match where it landed" → rewrote narration to agree with the WRONG booked instant (reinforced it). `#B` (weConfirmStash) auto-acked the disputed instant across the owner's corrections → wrong-day meeting left on the calendar after 3 corrections.
- **Good news (narrows scope):** the stored *instant* is mostly consistent (owned by the ops.ts interpret block); **zero phantom bookings** — the gate held. Damage = detection + zone-decision + display + model-tagging, NOT the whole engine.

Non-timezone failures found same day (route OUT of meeting-core): mis-gendered a female colleague (Daniel) + social engine down-ranked her grievance as "deflection" (people/social lane); stale long-thread bleed conflated a new request with a past meeting (memory lane); requester-vs-attendee conflation added the relayer as an attendee (coordination lane). These are SEPARATE roots, not the TZ spine.

---

## THE SPINE (the owner's framing: "where am I is solved by ONE clear function, the rest follows" — like planMeeting)

1. **Detection = ONE call, threaded.** `resolveOwnerTravelContextForDate(dayIso, ownerSlackId, homeTz, events)` in `utils/workingElsewhere.ts:134` already returns `{isAway, effectiveTz, location}`. It's the "where am I" function. Today it's called 3× independently (ops.ts interpret via `getTravelContextForInstant`, planMeeting:398, calendar.ts search). The spine calls it ONCE per booking and threads the result to interpret/validate/book/narrate. No re-derivation.

2. **NEW resolver owns the INSTANT.** `resolveStatedInstant({ clockIso, statedZone, travel, homeTz }) → { instantIso, zoneUsed }`. Logic:
   - `isoHasExplicitZone(clockIso)` (already in `utils/timezoneConvert.ts`) → it's a fixed instant (search-emitted / already-converted) → use as-is, NEVER reinterpret.
   - else bare → pick source zone: `statedZone==='home'`→homeTz; `'local'`→`travel.effectiveTz`; an IANA string→that; **undefined → `travel.isAway ? effectiveTz : homeTz`** (owner's rule: bare on a trip = where he is). Then `reinterpretClockInZone(clockIso, sourceZone, homeTz)`.
   - This kills #6: "Israel time" → statedZone='home' → homeTz, regardless of model IANA knowledge.

3. **ONE renderer owns DISPLAY.** `renderWeDualClock(instantIso, travel, homeTz) → "<trip> where you are now / <home> your home time"` (single clock when `!isAway`). Built on the shared `renderClockInZone`. EVERY surface quotes it verbatim — kill all hand-rolled `toFormat` dual-clocks.

4. **Model contract change (the linchpin).** The model must convey which zone the owner named INCLUDING home. Change the meeting tool arg/description so it sets the zone for "Israel time"/"my time" too (not just foreign). Cleanest: a `stated_zone` signal accepting `home` | `local` | IANA | omitted; resolver maps it. Keep `start_timezone` working as the IANA escape hatch (back-compat). The model's job shrinks to echoing the owner's WORD; the resolver does all zone math.

5. **Guards stop reinforcing wrong instants** (guard lane, coordinate): `dateVerifier` should check narration against what the owner ASKED, not blindly against the booked instant; `#B` must not auto-lock a time the owner is correcting. With the resolver fixing the instant, #6 won't recur, but these are the backstop.

---

## MIGRATION CHECKLIST (delete the scattered decider as you migrate each)

- [ ] **Build** `resolveStatedInstant` + `renderWeDualClock` (new spine — likely `utils/weTimeResolver.ts`, or extend `workingElsewhere.ts`). Reuse `reinterpretClockInZone`, `renderClockInZone`, `isoHasExplicitZone`.
- [ ] **create_meeting interpret block** `ops.ts` ~2281-2336 (explicit-tz block + the bare-WE block I added this session) → replace with: detect once → `resolveStatedInstant`. Delete the inline bare-time logic.
- [ ] **move_meeting interpret block** `ops.ts` ~3899-3957 → same.
- [ ] **planMeeting WE confirm** `planMeeting.ts` ~398-448 — use the threaded travel ctx + `renderWeDualClock` for `tripTimeDisplay`; drop the hand-rolled owner dual-clock AND the colleague-escalate hand-rolled `dual` (line ~442). Both quote the one renderer.
- [ ] **booked-confirmation** `ops.ts` ~3542-3557 (`bookedWhen`) → `renderWeDualClock`. (I already made it a dual-clock this session, but hand-rolled — replace with the renderer.)
- [ ] **move action_summary** `ops.ts` ~4861-4865 → `renderWeDualClock`.
- [ ] **find_available_slots search window** `ops.ts` ~1110-1121 + slot labels `ops.ts` ~2096/2113 → route zone via resolver; labels via `renderWeDualClock`/`renderClockInZone`.
- [ROUTED → approval chat] **approval preview** `core/approvals/approvalCallbacks.ts:72-96` (`buildConsequenceText`/`fmtTime`) — HOME-zone only, WE-blind. A real fix needs async travel-context resolved at the call sites (`core/requests/resolver.ts:908`, `tasks/skill.ts:783`) and passed into `buildConsequenceText`, then swap `fmtTime` → `renderWeDualClock` (now exported from `utils/weTimeResolver.ts`, ready to use). Cross-lane (approval spine) + needs async plumbing — NOT done in this build. Display-only drift (post-approve booking uses the fixed instant + the migrated booked-confirmation), so low blast radius, but it should be picked up so a trip-day approval preview matches everything else.
- [ ] **normalizeForGraph** `connectors/graph/calendar.ts:1782` — the FINAL arbiter: a still-bare ISO is anchored in HOME zone unconditionally. After the resolver, args reaching Graph should already be offset-tagged instants, so this becomes a safe no-op — verify nothing reaches it bare on a trip day.
- [ ] **Model contract** `skills/meetings.ts` ~260-290 (`start`/`start_timezone` description) — require conveying the named zone incl. home; add `stated_zone` if going that route.
- [ ] `npm run typecheck` green after each phase.
- [ ] **`trace` skill to 100%**: scenario matrix MUST include — "6:30 IL time" on trip day (the #6 case), bare "11am" on trip day, "11am ET" on trip day, "2pm Israel time" on home-week day, search-emitted offset slot (no rollover), cloud server in UTC (zones never from server), move on trip day, colleague-escalate display, approval preview on trip day.

---

## SESSION STATUS (uncommitted — all on master working tree, 2026-06-29)

Committed at session start: `97619fd` resolveDuration (the dedup-kill; bookingRequest.ts dependency of 3.5.4 ops.ts). DONE/correct.

Uncommitted edits made THIS session (pre-spine):
- **#2 labels** — `planMeeting.ts` (one verbatim place-pinned dual-clock, no lodging name) + `ops.ts` (surfaces `plan.tripTimeDisplay` verbatim, strengthened `_trip_note`). KEEP — aligns with spine; will route through `renderWeDualClock`.
- **#B confirm-carry** — NEW `utils/weConfirmStash.ts` + `ops.ts` (record on WE confirm, auto-ack same-instant re-issue). KEEP the anti-loop intent, but FIX the auto-lock-across-correction (don't ack a disputed time). With the resolver correct, the #6 misuse won't recur.
- **bare-time WE read** — `utils/timezoneConvert.ts` (`isoHasExplicitZone`) + `ops.ts` create+move (bare→trip on WE). This is the thing that mis-fired on untagged "Israel time" (#6). It will be SUBSUMED by `resolveStatedInstant` (which keys off `statedZone`, not blind bare→trip). The `isoHasExplicitZone` helper stays (the resolver uses it).
- **booked-confirmation dual-clock** — `ops.ts` (hand-rolled dual-clock). KEEP intent; replace with `renderWeDualClock`.

Spine itself: **BUILT (uncommitted), typecheck-green, traced 14/14.** New `utils/weTimeResolver.ts` (resolveStatedInstant + renderWeDualClock + sourceZoneFor + ABBREV_TO_IANA). Migrated: create + move interpret blocks → resolveStatedInstant; planMeeting confirm + colleague escalate + booked-confirmation + move summary + idempotent message → renderWeDualClock; meetings.ts contract → `stated_zone` (home/local/IANA, set for ANY named zone incl. home — the 0/3 root) replacing start_timezone in the schema (resolver still reads start_timezone as back-compat fallback); weConfirmStash → consume-on-use (consumeWeConfirmShown) so it can't auto-lock a disputed time. normalizeForGraph verified safe (resolver always feeds it an offset-tagged instant). ONE item routed OUT: the approval-preview (approvalCallbacks.buildConsequenceText) stays WE-blind — needs async travel-context plumbed through the approval-spine call sites; renderer is ready for that chat. **Linchpin caveat:** scenarios 1/3 depend on the model setting `stated_zone`; if it omits it on a WE day, a bare time defaults to trip-zone and the dual-clock confirm is the net. RESTART loads the new tool schema + code.

Audit transcripts (findings already summarized above) were in scratchpad `tasks/` (a46edb02… booking trace, a6908a50… code map, abf6f77e… non-TZ) — ephemeral, don't need re-reading; this file has the conclusions.
