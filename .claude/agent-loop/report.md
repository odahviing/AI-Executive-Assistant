# Report — cumulative since the 4.8.3 wrap

```
Session work (owner-driven, hand-dispatched — no editor run) — in: 0 tickets · 0 days of logs · 0 backlog re-reads
out: 2 built · 0 already-fixed · 0 built-with-gap · 0 bounced since last wrap · 0/0 joint-traced · 0 converted · 4 queued
```
**7 open rows** (6 still-real, 1 need a re-read, 0 cite no file) — 7 rulable, 0 waiting on a verb.

3 rows await you: 0 from tonight · 3 re-surfaced · 0 found by the loop

**Built and uncommitted — this is what a wrap ships (2):** `claimchecker-class2-reverted-broke-availability-questions` CLASS 2 excised, restored single-class personal-fact framing · `availability-precheck-not-grounded-for-checkers` precheck verdicts now thread into toolSummaries as real grounding for both output-time checkers

| Lane · ref | What happened | Your options | Risk |
|---|---|---|---|

**pending owner (3)**

| Lane · ref | What happened | Your options | Risk |
|---|---|---|---|
| librarian · `coda-no-suppression-on-unanswered-prose-followup` | re-surfaced (deferred 2026-08-28, due again) — a turn where a mutation succeeds and Maelle's own prose asks an unanswered follow-up question has no signal to hold the coda back on | Recommend: defer — same as last time: accepted low-severity, no live occurrence yet; revisit only if it actually fires | None |
| librarian · `o#258` | re-surfaced (deferred 2026-08-28, due again) — same finding as the row above, filed as a duplicate before the canonical ref was found | Recommend: defer — duplicate of `coda-no-suppression-on-unanswered-prose-followup`; no separate action needed | None |
| (no lane) · `gh#204` | re-surfaced (open since the 4.7.5 partial fix) — the pre-booking floating-block check now honestly reports `relocatable:false` instead of guessing; still undecided: how the owner should actually find out when a block can't be relocated | Recommend: defer — awaiting an owner design decision on the surfacing mechanism (`feature design gh#204` when ready) | None |

4 verify discoveries queued for the next build (not owed to you now, unchanged from last wrap): `notified-flag-must-follow-confirmed-send`, `vanished-sweep-request-close-invisible`, `brief-narration-rule-matches-unwritten-value`, `delete-approval-resolved-by-unrelated-positive-mutation`.

This wrap: a live regression fixed same-day as found — the claim-checker's CLASS 2 rule (shipped this morning) broke the single most common colleague availability question; reverted, then root-cause fixed properly (the availability precheck's output now reaches both output-time checkers as real grounding). Verified by a new 30-item golden-path regression battery (all pass) plus a full-tree Fable pass (one framework reference bug found and fixed pre-wrap). See `CHANGELOG.md` for the full account.
