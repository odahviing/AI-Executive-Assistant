# Agent-loop report

_Cumulative since the last wrap. Nothing here is committed until the owner says **wrap** — the agents build in the working tree and stop._

**Last wrap: 2026-07-26 → `v4.2.0`** — the charter-conformance wave. Every lane audited its own area against its own charter (**77 rules · 22 already obeyed · 60 violated**), the owner reviewed all 68 findings individually, and the seven lanes built the ~40 he approved: 54 files, ≈ +3,500 / −1,100. A final adversarial pass over the combined diff caught **two HIGH defects no single lane could see** (the join tool refusing every same-day request and then dead-ending against the new approval gate, plus a "his calendar is clear" claim made while the owner was busy) — both fixed before the wrap. Previous wrap: `v4.1.0` (`6fe4251`) + `5fe321c`.

---

## ⏳ Carried forward — latent follow-ups, NOT yet built
Surfaced by the guard-verify of the person-store fix (v4.1.0). **None can fire on today's data**, so none blocked either wrap — but they were never built. Route: **`people`** lane (the two md-file items touch `peopleMemory.ts`).

1. **`src/db/people.ts` (~962) — md merge sits OUTSIDE the row transaction.** Process death between the row commit and the md fold leaves an orphan `<loserId>.md` the migration sweep will never revisit (the group is clean by then), surfacing as exactly the duplicate catalog line the fix removes. The `catch` covers fs errors, not process death. **The only non-self-healing residue of that change — fix this one first.**
2. **`v4_0_4` migration (66-78) — a `refused` group re-dumps a backup JSON every boot.** Two Slack accounts on one address never merge, so the group persists and re-WARNs + re-writes a dump each boot, accumulating files in `data/migrations/`. Gate the backup on "at least one mergeable pair", or persist a refusal marker.
3. **`src/memory/peopleMemory.ts` (~184) — mixed legacy-filename case.** If the *survivor*'s md lives under a legacy name-slug (6 exist) and the loser's is id-keyed, `renameSync` creates `<survivorId>.md`, after which `migrateLegacyMdIfNeeded` permanently no-ops → legacy file orphaned.
4. **`src/db/people.ts` (~911) — `gender_confirmed` outside the provenance pick.** `confirmPersonGenderById` sets `gender_confirmed=1` without touching `gender_set_by`, so a merge could pick an `auto` gender while carrying confirmed=1. One confirmed row today and it is `person`-set → inert.
5. **`src/memory/peopleMemory.ts` (129-146) — merge-time formatting loss.** Blank lines inside a shared section are dropped, and loser text before the first `##` is discarded. Only reachable on hand-edited files.

## 🕗 Deferred from the charter audit — rules stand, timing does not
- **#41 · R2** — a second work-item lifecycle rides alongside `requests`: every `message_colleague` also writes a `tasks` row nothing reads, swept by a runner with no dispatcher for it. Multi-lane (requests + outer).
- **#44 · R5** — the approval midpoint nag is raw arithmetic with no work-hours clamp; a Thursday approval can ping on a Saturday.
- **#48 · S8** — the abort-for-merge path drops the first message's text, so the "[follow-up Ns later]" framing is lost on every merge.
- **#56 · O1** — the DB bootstrap runs two `ALTER`s *before* the `CREATE` that should define those columns, copies forward from a column that can no longer exist, emits `CREATE TABLE events` twice, and runs two competing migration mechanisms. Nothing breaks today; schema work on a box upgraded in place since v1.x, so it wants care, not speed.

## ✔️ Closed as correct behaviour — do not re-litigate
#13 channel continuation · #46 the 20-message window (charter amended instead) · #47 DM queue coalescing (deliberate — keying by thread would break merging entirely) · #50 meaning-classifiers in the transport · #5 · #21 · #24 · #52. Plus F1 (barber vs. opaque block) and F2 (stale coda topic), both reviewed 2026-07-25.
**#14 internal/external boundary** is the one exception: genuinely unresolved, not declined. The workspace *has* guests, no code enforces the distinction anywhere, and the owner's read is that a guest may be internal or external — a product question, not a fix.

## 📌 Known and accepted
- `toolCallCache.ts:35` holds a **second `WRITE_TOOLS` with different membership**, driving cache TTL. Left deliberately; merging it changes TTLs. Worth its own finding.
- **Transitional gap:** threads whose history predates deploy carry `[<tool> OK]` with no `mutated=` marker, so a truthful prior-turn recap loses the shield for one thread-lifetime. No legacy fallback by design; self-heals.
- **Two areas were never audited because nobody owned them:** `src/utils/weekdayGuard.ts` (a gate with no lane) and `src/skills/outreach.ts` (30KB, six callers). Assigned 2026-07-26 to `guard` and `requests`. Expect drift.

## 🕳 Blind spots the audit structurally cannot see
Coverage is bounded by the charters, not the code. **`news` · `summary` · `venue` · `knowledge` · `search` · `brief` have no behavioural rules at all**, so nothing can check them — `outer` is now in **PROPOSE mode** there (diagnose, design, hand to the owner; never build alone). `src/llm/` is deliberately owner-only and unaudited. Roughly **38 of 60** `src/utils/` files are named in no charter.

## 📌 Standing notes for the next run
- **Pre-flight activity check must count real turns.** A zero-finding run still cost ~124k (intake loads context regardless). Count `Orchestrator invoked` events, NOT raw log lines — `Catch-up: scanning DMs…` is an idle heartbeat and was once misread as activity.
- **Backticks in `bugger.js` prompts must be escaped.** Unescaped backticks inside the triage template literal produce `Script parse error`, which surfaces misleadingly as **`Workflow "bugger" not found`**. Watch it whenever the lane-description prompts are edited.
- **Cron:** job `638d42b0` armed daily at **18:00**. Session-only; **auto-expires 2026-08-01** → re-run `/manager watch` before then.
- **Verify is not optional for hand-driven waves.** These lanes were dispatched directly, so the loop's Verify phase never ran; the pass that caught the two HIGH defects had to be requested by hand. If a wave is driven outside the Manager, run `guard` over the combined diff before wrapping.
