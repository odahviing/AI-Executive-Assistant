# Person-memory spine — audit + repair wave, handoff

> Historical incoming handoff, completed in the 4.9.6 release preparation. The red-tree and unstarted-work statements below describe arrival state, not current status. See CHANGELOG.md for release scope; section 6 product decisions remain parked in the ledger.

Wave id: `person-memory-20260912`. Written 2026-09-12 by the Claude session that ran the audit and the first build round, for the session that finishes it. Nothing here is committed. **Every number a command can print is named by its command, never copied — this file goes stale otherwise.**

---

## 0. Before you touch anything

```
git -C E:/Code/Maelle status --porcelain
git -C E:/Code/Maelle log --oneline -3
npx tsc --noEmit -p E:/Code/Maelle/tsconfig.json
node E:/Code/Maelle/scripts/ledger-stats.cjs --open
```

HEAD at handoff time is `edd2433` (v4.9.5). Everything this wave produced is **uncommitted working-tree state**. The typecheck is RED when you arrive — see §4, the partially-finished person-store refactor. Greening it is your first job.

No agents are running. Two dispatches (Librarian batch 1, Registrar) were stopped before they edited anything, so §5a and §5b are entirely unstarted.

---

## 1. The goal, in the owner's words

> "I want you to test our entire spine of person memory — what we are storing, when how we update, what i know what other knows how can we add and remove and to make sure the goal of the person memory kept (we have 2 layers i think, the core items and the extra data)
> 1. librarian is mostly runs this area — so see and fix anything that break the charters
> 2. fix bugs in the process, stuff that not working as intent
> 3. flag to me product issues that you see as expert that maybe need my feedback and update charter"

And on closing it out:

> "base of the results we might do patch version and close the person memory part as we did to the approval, request, code before"

So: **fix what the charter already settles, flag what it does not.** The version and wrap decision is his and has not been made.

---

## 2. How work is done in this repo — read these first

| Read | Why |
|---|---|
| `.claude/SESSION_STARTER.md` | Current state, the lane-routing map, operational truth (VM, logs, typecheck) |
| `.claude/WORKSHOP.md` | W1–W12, the rules every builder carries; the evidence-before-handoff contract |
| `.claude/agents/librarian.md` | L1–L14 — the charter this whole wave is measured against |
| `.claude/memory/project_architecture.md` | The "Person store / social engine" section |
| `.claude/WRAP_UP.md` | The wrap checklist, if and when the owner says wrap |

Non-negotiables from those files: **agents never commit** (only the owner wraps) · **code before guard before prompt** · **security and privacy in code, never prompt** · **no regex on natural language** (she is multilingual) · **one root = one fix, no symptom patches** · **a behavioural change ships with an executed regression that fails before and passes after**, plus a legitimate control · **stay in the owning lane** — the file decides who edits it, and work needing another lane's file is a `needs-dependency`, not a quiet edit.

Maelle runs on the GCP VM `maelle-agent-vm`, not locally. Live logs: `powershell -File scripts/vm-logs.ps1 [term] [lines]`. The repo's own `data/maelle.db` and `logs/` are FROZEN snapshots from 2026-07-31 — never report them as production. For the live database run `node scripts/db-query.cjs "<SELECT …>"` **on the VM** via `gcloud compute ssh maelle-agent-vm --zone=europe-west4-b --tunnel-through-iap`.

---

## 3. What the audit found

Seven parallel read-only auditors: identity and rows · core facts and provenance · the extra layer and the markdown mirror · read surfaces and access · writes, capture and lifecycle · self rows and hygiene · a Librarian rule-by-rule L1–L14 conformance pass. Every finding is traced to `file:line` and was checked against the live VM database.

- **The write side is largely sound.** The core-field provenance chain (owner > person > auto) held in every traced scenario; the Slack privacy wall holds where gh#154 put it; codas and the social lifecycle conform.
- **The read side and the identity binder are where it breaks.** A name-only resolve binds on a single substring hit and mints a keyless row on a miss; `profile_json`, notes and the markdown mirror carry no provenance and no author; the mirror is a second record that disagrees with the row by construction.
- **Three live-data incidents proved it.** (a) "chris ray — we fired him" minted a keyless external row `p_mtxjgd6k_e3lj3e` while the real person is **"Christian Ray"** `p_U0A69S95N1E` — nothing suppresses him and Maelle reported the save as done. (b) Sharon Duret has two rows: her Slack row plus an email-keyed booking row `sduret@umass.edu` from before she was hired. (c) Production carries `SELF:U12345TEST` and a `Test User` row from a local test run on 2026-05-24 that hit the real database.

---

## 4. What is already built — verify, do not redo

All uncommitted. Each finished lane wrote an evidence package at `artifacts/workshop-verification/person-memory-20260912/<lane>/evidence.json` (schema: `evidenceSchema` in `scripts/workshop-verification.cjs`).

**Diplomat — done.** Forwarded-mail participants now carry the display name into the person mint, so a mail-keyed row is no longer named by the address local-part. `src/connectors/email/extractParticipants.ts` (participants became `{email, name|null}` pairs — same single Haiku pass, schema extended, no new model call) and `src/connectors/email/inbound.ts` (`resolvePerson({email, name, ownerDomain})`). Sender gate and silent-drop posture untouched. `scripts/test-email-participant-names.cjs`: 9/9 after, 6/9 before.

**SlackMaster — done.** `src/connections/slack/index.ts`: a projection chokepoint `projectDirectoryMatch` scopes `find_slack_user`'s payload by surface (room → identity only; DM → today's shape), and the loop that upserted **every** directory-search match into people_memory is gone (L1: a search is not engagement). `src/connectors/slack/app/processMessage.ts`: the owner's own row now gets its `last_seen` stamped. `scripts/test-slack-directory-tool.cjs`: 20/20 after, 12/20 before.

**Handyman — done.** `surface` now reaches Connection tools, which is what makes SlackMaster's projection live: `src/connections/types.ts` (`executeToolCall?(toolName, args, scope: { surface })`, still optional) and `src/skills/registry.ts` (passes `context.surface`). `scripts/test-connection-tool-scope.cjs`: 11/11 after, 5 failing before.

**Librarian — PARTIAL, and this is why the typecheck is red.** `git -C E:/Code/Maelle diff src/db/people.ts` (~393 lines) contains: `findPersonByName` (whole-name gate via `nameGenuinelyMatches`, returns `{match, candidates}`), `updatePersonProfileById(personId, updates, by)` with per-field `_set_by` provenance inside `profile_json` returning `ProfileWriteOutcomes`, `appendPersonNoteById(personId, note, by)` stamping `set_by` on notes, `authoritativeGender()`, `logRefusedLowerAuthority()`, `touchPersonSeenById()`, travel expiry via a last-calendar-day zone fallback, `canonicalSurvivor()`, a provenance-aware profile merge, and the `gender` param removed from `upsertPersonMemory`. **The callers were never updated.** The 8 errors are in `src/core/assistant.ts`, `src/core/assistantSelf.ts`, `src/memory/capturePass.ts` and `src/skills/social.ts`; each needs the TRUE writer tier, not a placeholder: capture pass = `'auto'`, the owner memory tools = the `setBy` from item I4 below, `note_about_self` = owner, `recordBooking` = auto. Read that diff, verify each piece rather than trusting it, keep what is right, and finish it — do not revert it wholesale.

---

## 5. What is left to build

### 5a. Librarian batch 1 — identity and provenance

Files: `src/db/people.ts`, `src/core/assistant.ts`, `src/core/assistantSelf.ts`, `src/core/ownerSelf.ts`, `src/memory/{capturePass,recordBooking,resolveAttendeeEmails}.ts`, `src/skills/social.ts`, `src/utils/{resolvePersonTarget,genderDetect,locationTz,resolveSlackId}.ts`.

**Do the typecheck-green step first**, then the items. Every fix direction below is a suggestion to verify, never a mandate — own the root and the design.

- **I1 · Name resolution mints and mis-binds (L11, L1) — the headline fix.** `resolvePerson`'s name step binds an exact match or a single `LIKE '%q%'` hit ("Dan" → "Idan Cohen"), binds a same-name row even when it already carries a DIFFERENT email or slack_id (silently dropping the incoming address as `kept_existing`, so two humans become one record), and on a miss mints a keyless `source='manual'` external. `src/memory/peopleMemory.ts:306-308` re-implements the same pick. `update_person_memory` (`assistant.ts:1014-1021`) ignores `resolved.created` and returns no `created` flag — which is why she narrated "noted" on a person who does not exist. **Observable when fixed:** an owner name-only write never creates a row and never binds a conflicting-key row; a miss returns unresolved WITH whole-name candidates so the model can ask ("Christian Ray?"); every person-write result says when a row was created; ONE name-pick helper used by `resolvePerson`, `resolvePersonTarget.ts` and the `peopleMemory.ts` pick.
- **I2 · `last_seen` is stamped only by the Slack sync and INSERT (L1/L3).** The resolve hit path and `appendPersonInteractionById` touch `updated_at` only, so every external's `last_seen` equals `created_at` forever and they drop off the 25-row / 90-day roster 90 days after first contact even if booked yesterday. Closes the narrow ledger row `external-profile-write-does-not-bump-last-seen`.
- **I3 · `setPersonEmail` picks the merge survivor by caller, not by the canonical rule (L11)** — `getPersonByEmail` says Slack wins, then most recent. One rule, never re-implemented.
- **I4 · Person-write tools gate on the room-clamped `senderRole`, not `authority` (L5, gh#154).** `assistant.ts:496` feeds the self-only gate, `setBy`, and vip/rank. `senderRole` is clamped to colleague for the OWNER in any MPIM or channel; `authority` never is. Move WRITE authority and provenance to `context.authority`; **keep the L6 read refusals** (`get_person_memory`, `recall_interactions`, markdown reads) keyed on `surface === 'room'`. Today the owner in a room is refused as "a colleague" and his own travel is stored with false provenance.
- **I5 · A legacy NULL `gender_set_by` is read as human-confirmed (L2).** Writers rank NULL as weakest; both prompt renderers treat `!== 'auto'` as confirmed, so pre-provenance guesses steer gendered Hebrew. Use `authoritativeGender` in both.
- **I6 · The self row's gender is written raw (L2)**, and `note_about_self` re-upserts the SELF row without owner provenance (its timezone then hits the auto path the seed deliberately bypasses) and stamps `last_social_at` / `last_initiated_at` on Maelle herself.
- **I7 · L10's "written by the same tools" is false.** Owner-path `update_person_profile(colleague_name="Maelle")` and `note_about_person` mint a NEW external "Maelle" because resolution excludes self rows; `formatAssistantSelfForPrompt` renders profile fields no writer can set. Either make the owner path resolve her row, or return this as an owner decision to amend L10 — say which and why.
- **I8 · A pronouns declaration is lost after an auto guess (L2).** `genderDetect.ts detectAndSaveGender` early-returns on ANY stored gender, so a person-tier declaration never lands over an `auto` value. **Do not remove the image tier** — that is a separate owner decision already on his desk.
- **I9 · An unresolvable-location trip blocks every later trip forever (L2)** — verify the last-calendar-day fallback in both the writer and `getTravelRecordById`.
- **I10 · `profile_json` and notes carry no provenance (L2, L14.2).** Confirm: auto never overwrites an owner- or person-stated field; legacy untagged reads as unknown authority and is never invented; notes carry `set_by`. State the shape in one sentence for the reviewer.
- **I11 · An owner name correction has nowhere to land (L2).** `people.ts:1170-1178` says so in its own comment; `update_person_profile` has no `name` field. "Call me Yoni" is L2's own example. The tool-description sentence belongs to Instructor.
- **I12 · The colleague-self field drop is silent (L5).** Owner-curated fields are deleted before the switch and the result still returns `updated:true` with no `not_saved`, so "my role is X" gets "noted".
- **I13 · Auto-tier refusals are unlogged (L2's "visible why")** — the capture pass and the Slack sync discard the chokepoint outcome.
- **I14 · A malformed profile capture is indistinguishable from "nothing to learn"** — `parseDelta → null` logs as "no new deltas" and hallucinated keys vanish silently. UNKNOWN stays social-side per L12.
- **I15 · Dead code and duplication:** unreachable branches in `writeCurrentTravelById`; `recordBooking.ts:57-64` dead `moved`/`updated` mutations (the sole caller passes `'booked'`); `locationTz.ts:134` hand IANA regex while `isStrictIana` is imported; `assistantSelf.ts:111` reads the retired `engagement_level`.
- **I16 · Stale comments (W10):** `people.ts:80-81` (self-writable list missing `working_hours_structured` and `email`), `people.ts:1042` and `resolveAttendeeEmails.ts:195-199` ("legitimately two rows for one human" — post-4.0.4 that is a bug the sweep heals), `resolveSlackId.ts:78-80`, `ownerSelf.ts:21-23`, `social.ts:14-15`, `assistantSelf.ts:7-8,90-92`, `assistant.ts:510-514`, and `people.ts:7-8` ("auto-populated … found via find_slack_user" — SlackMaster removed that persist loop).

**Evidence owed:** `scripts/test-person-memory-identity.cjs` in the repo's style (real `src` transpiled in a `vm` sandbox, in-memory SQLite, I/O mocked) covering at minimum I1 (Chris Ray vs Christian Ray → unresolved, no mint, candidate offered; same name with a different email → no bind; "Dan" → no bind), I2, I4 (owner in a room writes with owner provenance; a colleague in a room is still refused; room READS still refused), I5, I8, I10 and I12 — each failing at `edd2433` (`git show edd2433:<path>` for the before) and passing after, plus legitimate controls.

### 5b. Registrar — the outreach consequence of SlackMaster's change

Files: `src/skills/outreach.ts`, `src/core/requests/*`, `src/db/jobs.ts`, `src/utils/responseDeadline.ts`.

- **R-a ·** `outreach.ts:436-441` still cites the removed directory-persist loop as the recipient-timezone source (W10).
- **R-b ·** Verify the invariant **`colleague-sends-respect-recipient-work-hours`** for a recipient who was never engaged. Before SlackMaster's change the directory search had pre-populated an auto-tier timezone for anyone searched. If the send path now silently falls back to the owner's zone or to "no window", this wave introduced a regression — fix it at the root. The natural shape is to pull core info at the moment of engagement (the send) through the existing `Connection.collectCoreInfo` (currently zero callers), so the row is created by the engagement itself (L1) carrying an auto-tier timezone the store already ranks. If the trace shows no regression, say so with the deciding lines and write no test.

### 5c. SlackMaster — two follow-ups raised by Handyman

- `src/connections/slack/index.ts:294-302` says the contract "does not pass it yet / has no third parameter" — false since Handyman's change (W10); `scope?` may now become required.
- `scripts/test-slack-directory-tool.cjs` fails at import because `src/db/people.ts` now imports `../memory/resolveAttendeeEmails` — add that mock.

### 5d. Librarian batch 2 — the extra layer and retention (NOT YET DISPATCHED)

Held back from batch 1 because it shares files. **Fix the data-loss and staleness edges; do not delete the mirror** — whether the mirror should exist at all is an owner decision (§6).

- **The 32 KB read cap silently destroys the newest history.** `peopleMemory.ts:340-344,366-369` truncate on read; both appenders (`capturePass.ts:375-388`, `recordBooking.ts:143-156`) then rebuild the "What we've discussed" section from that truncated body and write it back, so once a file crosses the cap every write drops the most recent entries and keeps the oldest. Warn-logged, otherwise silent. The largest live file is ~21 KB and growing, with no write cap anywhere.
- **One `update_person_memory` call can wipe the whole timeline** — the history section is offered as a normal writable section and its body is replaced.
- **One booking is recorded twice with two different dates** — the markdown bullet is dated by the meeting day, the interaction log by now; the mirror sorts on that mixed-meaning date, and `get_person_memory` hands the model both copies.
- **Partial capture deltas erase sibling facts** — each section is replaced from the delta alone while `updatePersonProfileById` merges, so the two layers disagree by construction.
- **Owner corrections never reach the mirror the colleague reads** — `update_person_profile` writes columns only; on that person's own DM turn the stale markdown line can be the only statement of the fact in the prompt.
- **Nothing owns or ages the Travel section** — a June trip is still served in future tense, while `get_person_memory` returns no structured `currently_traveling` at all. `update_person_memory` already detects "travel"; route it to the structured record.
- **Type-blind retention caps** — notes `slice(-50)` and interaction log `slice(-200)` evict oldest-first regardless of kind, so a chatty colleague's social pings evict `meeting_booked` entries. L3 says work history is what survives.
- **Six legacy name-slug markdown files** still render in the catalog beside their `p_<id>` twins; their content is unreachable via `get_person_memory`.
- **An explicit "clear this field" is silently dropped** and reported as saved (the merge filters empty values).
- **Work facts are filed under social** — `note_about_person` routes language preference and how someone likes to be addressed into `notes`, which the colleague block never renders and which are hidden when social is off. L3 says these are first-class work data.
- **Contradictory truth claims in comments** about which layer is the source of truth.

### 5e. Instructor — LAST, after every code lane (tool descriptions and prompt wording only)

- `note_about_person`'s description says work facts go to `manage_preference(action='set')`; `assistant.ts:152` says that tool is NOT for facts about people. One of them is wrong.
- Nothing the model can see states that a person record cannot be deleted, so "forget X" has no stated refusal and she improvises. The owner asked to delete a person's file on 2026-09-11.
- `update_person_profile`'s description never mentions the colleague-path refusal or the silent field drop (I12).
- The owner-lookup descriptions say "display name or first name" while the handler short-circuits on the full configured name only.
- Plus whatever the code lanes return as a dependency on Instructor — I11's `name` field is expected.

### 5f. Then: one adversarial review, then bookkeeping

1. **One independent reviewer over the combined product diff** (the `bouncer` charter, `.claude/agents/bouncer.md`) — it owns no code and must not have authored any of it. Its first question is *did this actually fix the reported problem*, then *is it safe to ship* and *does it meet our standard*.
2. **Ledger rows** — one per built ref through `node scripts/ledger-file.cjs` (never hand-compose the JSON), each carrying its evidence file; the independent review is appended separately with `--review`. Check with `node scripts/ledger-stats.cjs --verification`, which exits 1 and blocks a wrap.
3. **`.claude/agent-loop/report.md`** — the owner's decision surface. The format spec and its hard rules live in the Manager skill; `node scripts/ledger-stats.cjs --report` must exit 0.
4. **Wrap only on the owner's explicit word**, then `.claude/WRAP_UP.md` start to finish. He has not ruled on a version bump for this wave.

---

## 6. Parked for the owner — do NOT build these

Filed as `needs-owner-decision` ledger rows in this wave; `node scripts/ledger-stats.cjs --open` prints them with their recommendations. Each is a product or charter question, not a defect with a settled answer:

`person-departure-has-no-home` (should a person have a "left the company" state, and what should it suppress?) · `sharon-duret-duplicate-person-row` (one human, two keys — may an exact whole-name match bridge them?) · `owner-assessments-render-to-the-person` (charter L4 says owner-only; two of his own rulings say otherwise) · `person-markdown-mirror-is-a-second-record` (should the mirror become a generated view?) · `two-owner-preference-stores` · `attendee-travel-city-in-colleague-slot-search` · `email-leg-unclamped-person-memory-read` · `gender-image-tier-yields-unrenderable-guesses` (a per-person vision call whose result every reader renders as unknown) · `no-way-to-retract-a-note-or-clear-a-field` · `owner-tier-email-zone-on-model-chosen-row` · `language-preference-read-precedence` · `fixture-self-and-test-rows-in-production` (a production data deletion — his word required).

Two hygiene rows are queued for Handyman and are not part of this wave: `known-contacts-dropped-every-boot`, `registry-and-turncontext-cite-moved-lines`.

---

## 7. Hazards

- **A separate framework session holds uncommitted edits in the same tree** — `.claude/**` (the Workshop rules, the Manager skill split into `OPERATIONS.md`, WRAP_UP), `scripts/ledger-*.cjs`, `scripts/workshop-*.cjs`, `scripts/test-approval-*.cjs`, and `package.json` (a new `npm run test:release`). **Do not edit those files**, and expect them in the bundle at wrap time. The ledger writer now stores evidence and reviews as content-addressed attachments under `.claude/agent-loop/evidence/` — commit those objects together with their events.
- **Four approval-spine harnesses were red at `edd2433`** (ledger row `approval-spine-test-harnesses-red-on-shipped-tree`); the framework session appears to have repaired them. Re-run before blaming your own change. There is no single command that runs every `scripts/test-*.cjs` unless the new `test:release` runner provides one.
- **Never write to the live database.** Every duplicate-row cleanup named here is the owner's decision and an out-of-band operation on the VM.
- **Do not re-derive `authority` or `surface`** anywhere — they are resolved once at each transport front door (gh#154), and a third flag is forbidden.
- **The owner's standing preferences:** answer first and briefly, no preamble; propose before building anything he has not asked for; never wrap or bump a version without an explicit ship word.

---

## 8. The test before you call it done

Ask her, as the owner, on a live turn: *"what do you know about Christian Ray?"* and *"who has non-standard hours?"* The first must not invent or mint a person; the second must answer from the store rather than from the last twenty messages.
