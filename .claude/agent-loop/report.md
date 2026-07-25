# Agent-loop report

_Cumulative since the last wrap. Nothing here is committed until the owner says **wrap** — the agents build in the working tree and stop._

**Run `wf_2ace571f-ece` — 2026-07-24 ~19:00** · sources: github + logs · **1 finding → 2 atomic → 2 built** · 0 needs-owner · 0 flagged · 0 pending · ~346k tokens / 8 agents / 20 min

**Run `wf_61fa54c0-139` — 2026-07-25 20:02** · sources: github + logs · **2 findings → 2 atomic → 0 built** · 0 needs-owner · 2 flagged → **both closed by the owner as not-a-bug** · 0 pending · ~128k tokens / 3 agents / 66 sec
_GitHub: zero open `Bug` issues (independently verified `gh issue list --label Bug --state open` → `[]`). Both log findings came back `ambiguous` → shown, never auto-fixed, so no build agents ran. Owner reviewed both the same evening and judged both acceptable → closed, nothing built._

**No run 2026-07-25 ~20:22** — a second `run` was requested but **not fired**: both intake sources were provably empty (GitHub `[]`; last log line `16:58:21Z` predates the `17:02:39Z` watermark), so the pass would have been a guaranteed no-op whose "0 findings" would falsely read as a clean sweep.

**Run `wf_33ac7e9e-3db` — 2026-07-25 22:59** · sources: github + logs · **0 findings → 0 atomic → 0 built** · 0 needs-owner · 0 flagged · 0 pending · ~124k tokens / 3 agents / 32 sec
_A true no-op, verified: all three agents returned structurally valid empties (`{findings:[]}`, `{findings:[]}`, `{issues:[]}`) — no errors. The window genuinely held nothing: the only two post-watermark log entries were both `Catch-up: scanning DMs for missed messages` (idle ticks), and there were ZERO `Orchestrator invoked` events after the watermark. GitHub `[]`. **Manager correction:** the decision to fire was based on "there is new activity in the window" — those two entries were idle catch-up ticks, not conversations, so the earlier no-fire judgment had been the right one. **Tuning signal:** a zero-finding run still cost ~124k tokens (intake agents load context regardless), so the pre-flight activity check must distinguish real turns (`Orchestrator invoked`) from heartbeat ticks._

**Harness bug found + fixed (loop tooling, not Maelle):** `.claude/workflows/bugger.js:128` — the rewritten triage prompt wrapped five lane names in backticks *inside* a backtick template literal (10 unescaped backticks) → `Script parse error (128:134)`. This ALSO made `Workflow({name:'bugger'})` report **"bugger not found"** (an unparseable script cannot be registered — the misleading symptom looked like a stale registry/renamed workflow). Fixed by escaping the backticks (`` ` `` → `` \` ``); the prompt text delivered to the triage agent is byte-identical. Watch for this whenever those lane-description prompts are edited.

---

## ✅ Built — awaiting your review + wrap

### Luke Joas silently dropped from a multi-attendee meeting search  · lane: `meeting` · HIGH
- **Bug:** On the follow-up turn of Shayan's 3-person request, the availability search dropped required attendee **Luke Joas** — the 3 offered slots (Wed 5 Aug 17:30 / Thu 6 Aug 18:00 / Mon 10 Aug 17:30 Sydney) were validated against Idan + Shayan only, never Luke. (`logs/maelle-2026-07-24.log`, turn 2, lines 80/89.)
- **Reason:** `src/skills/meetings/resolveAttendeeEmails.ts:174` — `resolveNamedInternalAttendees` counted raw `people_memory` **rows** (`internal.length !== 1`). Luke has **two rows** for the one email `luke.j@reflectiz.com` (a calendar row + a Slack row) → counted as 2 → read as "ambiguous" → pushed to `unresolved` → never entered the deterministic search union (`findAvailableSlots.ts:354`). Turn 1 only worked because Sonnet happened to call `find_slack_user`; turn 2 it didn't, so Luke vanished.
- **Fixed by:** `meeting`
- **Fix:** `resolveAttendeeEmails.ts` (~+16 net) — collapse internal matches by **distinct email** before the ambiguity test (`distinctEmails.size !== 1`), so duplicate calendar+Slack rows for one email count as ONE person and resolve; two genuinely different emails still stay model-disambiguated. Narration name via canonical `getPersonByEmail` (one source of truth). `npm run typecheck` green; 9 scenarios paper-traced, no regression.
- **Risk (eyeball before wrap):** touches the **shared attendee-resolution chokepoint** (feeds both slot search *and* booking). The change resolves *more* people (dedupe of duplicate rows), so the one boundary to check is over-resolution — the agent traced that two *genuinely different* emails still stay unresolved/model-disambiguated, so it shouldn't over-resolve. Low risk, but it's a shared chokepoint — worth the one look.
- **Comments:**
  - The `guard` agent was also handed this (framed as a "missing backstop") and **correctly refused** to build a post-hoc guard — cited R1/R2/R4/R7/R8 and routed the real fix to the meeting lane. The charter held.
  - Out-of-lane observation (not built): the duplicate `people_memory` rows exist because `db/people.ts:742` also counts raw rows on the fuzzy-name branch. This fix makes the meeting resolver robust regardless, but a person-layer merge would remove the duplicate class at the source — **your call.**

### Person store minted TWO rows for one human (Luke) · lane: `general` · MEDIUM (root of the HIGH bug above)
_Owner-requested direct dispatch 2026-07-25 ~20:30 (not part of a scheduled run). Built by `general`, then **adversarially guard-verified → held**._
- **Bug:** one human, two `people_memory` rows on one email `luke.j@reflectiz.com` — `p_mq97pufr_00pi9w` (slack_id NULL, source=calendar, 2026-06-11) and `p_U07QVKMCMP0` (slack_id `U07QVKMCMP0`, source=slack, 2026-06-23). The only duplicate-email group in 76 rows. This duplicate is the ROOT of the meeting bug above.
- **Reason:** `upsertPersonMemory` ran its OWN `INSERT … ON CONFLICT(slack_id)` — deduping on slack_id **only**, never asking whether a row already owned the email → it forked around the `resolvePerson` chokepoint (a G3 violation). Jun 11: a booking → `resolvePerson({email,name})` created the calendar row. Jun 23: Luke appeared on Slack, a `users.info` upsert hit `upsertPersonMemory`, no row owned that slack_id, and `email` had only a plain index (the v3.2.0 migration deliberately declined a UNIQUE one) → second row minted. `resolvePerson` excluded as creator by elimination (its email match precedes its create). Confirms the falsified assumption in the old `resolvePerson` doc comment ("a company-domain person always arrives via Slack first").
- **Also found, unbriefed — the MIRROR order:** `resolvePerson` attached an email to a slack-matched row with a bare `UPDATE … SET email` without checking whether another row held it, so slack-first → calendar-row → email-learned produced the same split. Closed too.
- **Fixed by:** `general` · **verified by:** `guard` (could not refute)
- **Fix** (4 files, ~+606/−94): parallel INSERT **deleted**; `resolvePerson` restructured from a first-match-wins ladder to an up-front two-handle lookup so "one human, two rows" MERGES instead of being "left alone" (that branch + its silently-swallowed `catch` are gone). One `mergePersonRows` + one `setPersonEmail` (sole writer of the identity column). `mergePersonMdFiles` folds the loser's `<person_id>.md` into the survivor's. New generic migration `src/db/migrations/v4_0_4_dedupe_people_email.ts` delegates to the SAME `mergePersonRows`, so cleanup and prevention cannot drift. Post-fix greps confirm exactly ONE `INSERT INTO people_memory` and ONE `SET email` remain in the runtime path.
- **Verification:** `npm run typecheck` green (Manager re-ran independently). Proven on a **sandboxed copy** of the live DB + all 73 md files: 76→75 rows, md 73→72, zero remaining duplicates, zero orphans, `created_at` rolled back to 06-11, `interaction_log` unioned to 3 in date order, second sweep a clean no-op. Original bug sequence and the mirror order both replayed → one row each. **Live DB confirmed untouched by the Manager** (both Luke rows still present) — the merge fires on the owner's next boot.
- **Risk (eyeball before wrap):**
  - **First boot performs a destructive row delete against live data.** Backup written to `data/migrations/` BEFORE any mutation, and no-backup ⇒ no-merge verified in code. **Correction to the builder's claim:** it is NOT one whole-sweep transaction — each `mergePersonRows` is its own `.immediate()` transaction, so a throw mid-sweep leaves earlier groups merged and the next boot resumes the rest. Guard judged this *better* here (groups are disjoint humans, each unit atomic); the critical property holds — within a unit `DELETE` precedes the `UPDATE`, so a failure rolls back and **both rows survive intact**.
  - **Filename says `v4_0_4`** — rename if a different version is cut.
  - **Timezone precedence change = a BUG FIX, not a regression** (guard proved it): pre-fix was `timezone = COALESCE(@timezone, timezone)`, so the *incoming* value won, and `processMessage.ts:165` passes `timezone: u?.tz` on **every colleague message** — a Slack-profile zone was silently clobbering an owner-taught zone while `timezone_set_by` stayed `'owner'` (the row lied about its own provenance). **10 rows carry `timezone_set_by='owner'`**, 9 with a slack_id were live on that path. Auto→auto still updates (38 NULL + 28 auto rows unaffected).
  - **New never-observed branch:** two Slack accounts on one address stay separate rows, the second getting `email` NULL (3 of 76 rows already have NULL email, so not a new state). Such a person reads as unresolved/external rather than mis-resolved — a safe miss, logged at WARN. Likeliest trigger: deactivate-then-rehire.
  - `kind='self'` doubly protected (refused in `mergePersonRows` AND excluded in both migration queries); new create path derives the identical `p_SELF_…` id, so no md orphan.

### Latent follow-ups from the guard-verify (NOT blockers — none can fire on today's data)
Owner's call whether to harden these; nothing here fires on current rows.
1. **`people.ts:962` — md merge sits OUTSIDE the row transaction.** Process death between commit and the md fold leaves an orphan `<loserId>.md` the sweep never revisits (group already clean) — surfacing as exactly the duplicate catalog line this fix removes. The `catch` covers fs errors, not process death.
2. **`peopleMemory.ts:184` — mixed legacy-filename case.** If the *survivor*'s md lives under a legacy name-slug (6 such files exist) and the loser's is id-keyed, `renameSync` creates `<survivorId>.md`, after which `migrateLegacyMdIfNeeded` permanently no-ops → legacy file orphaned. Cannot fire on Luke (both id-keyed).
3. **`people.ts:911` — `gender_confirmed` is outside the provenance pick.** `confirmPersonGenderById` sets `gender_confirmed=1` without touching `gender_set_by`, so a merge could pick an `auto` gender while carrying confirmed=1. Only 1 confirmed row today, and it is `person`-set → inert. Cheap fix: treat confirmed=1 as rank ≥ person.
4. **Migration 66-78 — a `refused` group re-dumps a backup JSON every boot.** Two Slack accounts on one address never merge, so the group persists and re-WARNs + re-writes each boot, accumulating files. Gate the backup on "at least one mergeable pair," or persist a refusal marker.
5. **`peopleMemory.ts:129-146` — merge-time formatting loss.** For sections in BOTH files, blank lines inside the body are dropped, and loser text before the first `##` is discarded. Only reachable on owner-hand-edited files.

---

## ✔️ Reviewed by the owner — NOT a bug, closed (nothing built)

Both came from one thread: `logs/maelle-2026-07-25.log`, thread `1784960270.210219`, owner DM `D0ASFFYTCQ0`. Both were held as `ambiguous` (never auto-fixed); the owner reviewed them on 2026-07-25 and judged **both acceptable**. No code was changed. Recorded here so neither is re-litigated if the log window is ever widened (the `lastSeenIso` watermark already sits past these lines).

### F1 · Barber availability vs. an existing private/opaque block · lane: `meeting` · CLOSED — not a bug
- Owner asked *"I have time to go to the barber tomorrow?"* (line 68, 06:18:09Z); Maelle answered off `analyze_calendar` (line 80); owner later added *"Ahh. I see I already book time that day"* (line 96, 07:15:27Z) and *"The private block is the barber"* (line 114, 07:16:00Z).
- Never proven to be a defect: the corrections came **~57 min later** and read as the owner recognising his own prior booking. **Owner verdict: behaviour is fine** — an opaque block Maelle cannot see the purpose of is expected. No free/busy change made.

### F2 · Social coda carried a stale topic · lane: `general` · CLOSED — not a bug
- `Social coda appended to task turn` fired with `topic: "Bodyguard (BBC)"` on the barber turn (line 85, 06:18:31Z).
- The log proved only that the *topic value* was stale, not that the rendered reply read badly. **Owner verdict: acceptable** — reads as intentional social continuity. No change made.

---

## Process notes (tuning, not a bug)
- **Run 1 (07-24):** the meeting lane built the same fix **twice** — once in the build stage, once in the tail as the guard's dependency (same root). Both causes are now closed in the engine: `bugger.js` triage must merge same-root issues and is explicitly barred from splitting a flow defect into "the bug" + "a missing backstop guard."
- **Run 2 (07-25):** the hard bar did its job — 2 findings, 2 ambiguous, 0 builds, 0 tokens spent on build agents. Cheap (66 s / ~128k) precisely because nothing was certain enough to build.
- **Cron note:** the 19:00 cron (`dbb87f83`) did not fire tonight — cron only fires while the session is idle. This run was manual and covered the identical window, so nothing was missed.
