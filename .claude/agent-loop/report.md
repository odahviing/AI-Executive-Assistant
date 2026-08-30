# Report — cumulative since the 4.8.2 wrap

**4 rows await you** — v4.8.2 wrapped, 0 new from this wrap.

| Lane · ref | What happened | Your options | Risk |
|---|---|---|---|

**pending owner (4)**

| Lane · ref | What happened | Your options | Risk |
|---|---|---|---|
| librarian · `coda-no-suppression-on-unanswered-prose-followup` | re-surfaced (deferred 2026-08-28, due again) — a turn where a mutation succeeds and Maelle's own prose asks an unanswered follow-up question has no signal to hold the coda back on | Recommend: defer — same as last time: accepted low-severity, no live occurrence yet; revisit only if it actually fires | None — duplicate row `o#258` tracks the identical finding, no separate action needed |
| (no lane) · `gh#204` | re-surfaced (open since the 4.7.5 partial fix) — the pre-booking floating-block check now honestly reports `relocatable:false` instead of guessing; still undecided: how the owner should actually find out when a block can't be relocated | Recommend: defer — awaiting an owner design decision on the surfacing mechanism (`feature design gh#204` when ready) | None |
| registrar · `verify-create-approval-typeerror-region-still-fixed` | an Aug 24 production crash hit a region since rewritten for unrelated reasons; never re-verified whether the string-payload edge case it exposed is actually handled now | Recommend: defer — premise too vague to dispatch confidently; needs a concrete reproduction or more specifics before a lane can chase it | None |

4 verify discoveries queued for the next build (not owed to you now): `notified-flag-must-follow-confirmed-send` (matchmaker, medium — flagged stale by the pre-wrap pass, does not reproduce against the final tree; re-point or close on next re-read), `vanished-sweep-request-close-invisible` (matchmaker, low — a request-only vanished-meeting close reports cleaned=0 and logs nothing), `brief-narration-rule-matches-unwritten-value` (instructor, low — a brief narration rule matches a value nothing ever writes), `delete-approval-resolved-by-unrelated-positive-mutation` (registrar, low-medium — a pending cancel-approval can be silently resolved by an unrelated move/update on the same meeting; found by the pre-wrap adversarial pass).

This wrap shipped 21 fixes: two full bugger-workflow waves (8 items covering the live production incidents from this morning's debugging session plus their lane dependencies, then 5 more from that wave's own verify discoveries), a standalone Fable bouncer retrospective sweep over the already-shipped v4.8.1 diff (3 real findings, all ping-ponged and fixed), two owner-approved refinements (durable timezone write when the base was empty, a durable `email` field on `update_person_profile`), and one PII-leak fix found and closed same-session by the mandatory pre-wrap adversarial pass. See `CHANGELOG.md` for the full account.
