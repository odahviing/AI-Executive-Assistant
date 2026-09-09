# Report — cumulative since the 4.9.1 wrap

```
Wrap 4.9.1 — in: 11 owner-approved rows · 2 nights of logs · 0 backlog re-reads
out: 32 built · 0 already-fixed · 0 built-with-gap · 3 bounced · 0/0 joint-traced · 0 converted · 2 queued
board: 3 open rows — 1 still-real · 2 need a re-read · 0 cite no file · 3 rulable · 0 waiting on a verb   (node scripts/ledger-stats.cjs --open)
your 3 rows await you: 2 from tonight · 1 re-surfaced · 0 found by the loop
```

**3 rows await you** — v4.9.1 wrapped, 0 new defects from this wrap. Two are queued discoveries that drain themselves into the next build and need no answer; the third has been waiting through three runs.

### pending owner (3)

| Lane · ref | What happened | Your options | Risk |
|---|---|---|---|
| handyman · stale-citation-checker-false-positives-on-body-anchored-citations | loop — the wrap-gating stale-citation checker flags a correct citation as stale when a comment names a symbol but deliberately points inside its body rather than at its declaration. Re-read twice, most recently 2026-09-07; still real. It earned its place on this wrap: it caught seven genuine drifts before the commit. | `Recommend: decline — the tool's own header already discloses this heuristic limit, and narrowing symbol-attribution would trade this rare false positive for more false negatives on every other citation.` | Low — costs a wasted lane dispatch or a "fix" that points a comment at a worse line; the checker still catches real drift everywhere else. |
| matchmaker · email-leg-still-carries-owner-scheduling-mechanics-prose | tonight — the email-leg leak fix stops a colleague's availability reaching an external reader, but a non-attendee refusal still carries your own scheduling-mechanics prose ("no room for your lunch", the free-time floor) out to someone you forward to. | `Recommend: build — same one-line strip at the same chokepoint. Queued rather than assumed, because you may be relaxed about your own mechanics reaching a client in a way you are not about a colleague's calendar.` | Low — it is your information, not a third party's, and it reaches only people you choose to forward to. |
| gatekeeper · local-suffix-means-attendee-zone-on-one-line-and-requester-zone-on-another | tonight — the bracketed local-time suffix now on tool lines means the attendee's zone on a slot or booking line and the requester's zone on a precheck line. A draft stating a third zone matches no text, and whether the checker keeps or flags it is a coin flip. | `Recommend: build — either label which zone the suffix is in, or make both producers use the same rule.` | Low — rare for this tenant, and strictly better than the pre-4.9.1 behaviour where the checker did the conversion itself and got it wrong. |

### deferred (0)

### declined (0)

**Built and uncommitted — this is what a wrap ships (32):** `relaxed-search-attendee-conflict-narration-flagged-invented` · `tag-outcome-tool-call-has-no-attendee-check-marker` · `log-move-meeting-blind-retry-loop` · `log-grounded-fallback-ignores-tool-failure` · `log-notify-requester-not-grounded-for-claimchecker` · `verify-flagged-fallback-treats-rate-limit-as-success` · `last-resort-fallback-english-only-non-english-thread` · `booking-line-carries-no-attendee-local-time` · `owner-fact-check-fires-on-scheduling-logistics-its-prompt-excludes` · `precheck-resolves-weekday-to-the-current-week` · `slot-grounding-rewrite-sources-times-from-a-non-search-line` · `slot-grounding-rewrite-drops-timezone-label-corrupts-time` · `self-refuting-verdict-can-still-trigger-a-rewrite` · `shadow-dm-tool-hint-has-never-rendered-a-tool-name` · `scrub-list-hand-typed-against-a-tool-set-in-another-file` · `registry-pushes-the-canonical-tool-set-down-to-the-scrubber` · `update-person-profile-confirms-hours-scheduling-never-reads` · `person-row-merge-has-no-command-line-path` · `email-leg-carries-a-colleagues-availability-to-an-external-reader` · `confirm-success-return-does-not-name-who-was-booked-over` · `checkslot-verdict-translator-answers-owner-busy-for-anything-it-does-not-know` · `ops-email-strip-comment-states-a-leak-rationale-it-does-not-deliver` · `search-path-book-it-directly-note-collides-with-the-new-guard` · `attendee-conflict-docs-understate-their-own-residual` · `explicit-location-string-never-re-detects-the-category` · `failed-create-line-carries-marker-but-no-finding-text` · `requester-notified-boolean-ignores-failed-relay` · `systemprompt-instructs-the-model-to-call-a-tool-retired-in-v2-9` · `preferences-index-injects-a-tool-retired-in-v2-9` · `owner-said-done-scanner-comment-names-a-retired-tool-and-a-retired-prefilter` · `update-meeting-load-failure-names-an-action-that-was-not-requested` · `grounded-fallback-filter-speaks-on-a-silent-turn-and-misreads-a-task-title`
