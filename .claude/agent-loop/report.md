# Agent-loop report

```
Run wf_5c89df46-081 — in: 1 ticket · 2 day(s) of logs · 15 backlog re-reads
out: 22 built · 1 already-fixed · 0 built-with-gap · 6 bounced · 3/3 joint-traced · 0 converted · 2 queued
board: 5 open rows — 1 still-real · 3 need a re-read · 1 cite no file · 5 rulable · 0 waiting on a verb   (node scripts/ledger-stats.cjs --open)
0 rows await you: 0 from tonight · 0 re-surfaced · 0 found by the loop
```

**Empty — v4.4.9 wrapped. 0 rows await you.** Two of the five open rows are QUEUED for the next build and drain themselves.

**Built and uncommitted — this is what a wrap ships (22):** `automove-revert-mid-sweep-unique-constraint-abort` dismissal survives every sweep, bounced once · `auto-move-reoccurs-after-revert-when-open-category-question-exists` same pair, same fix · `sibling-notes-narrate-off-hours-without-assumed-hedge` two more notes hedged · `find-slack-user-breadcrumb-jumps-history-order` ts-stamp added · `coordinator-fourth-scrubber-bypass-site` · `availability-narration-exposes-search-mechanism` · `assumed-attendee-hours-narrated-as-fact` · `email-leg-unresolved-attendee-strip-has-same-silent-confirm-shape` · `requester-is-attending-false-still-gets-narrow-roster` · `moving-event-ids-subtracts-from-busy-pool-with-no-membership-check` · `automove-revert-message-asserts-unread-state` · `defrag-path-swaps-failure-reason-silently` · `claimchecker-comment-overstates-tentative-handling` · `quarter-hour-grid-duplicated-across-two-files` · `createoutreachjob-idempotency-collision` · `anchored-booking-start-not-snapped-to-quarter-hour` · `bot-own-messages-reingested-in-thread-merge` · `bot-own-reply-duplicated-in-model-context-window` · `unverified-note-comment-duplicates-systemprompt-and-lacks-hasattendeestatus-gate` · `dismissal-row-select-has-no-order-by` · plus their dependency legs.

**The pair worth reading the note on:** the calendar-issues fix bounced hard. Attempt 1 cleared the reported abort and, in doing so, silently erased the owner's permanent "never auto-move this again" dismissal within one sweep — reopening gh#180 through a new door. Attempt 2 guards the approved status, bounds `event_end_ms` monotonically and refuses cross-axis overwrites; a second bouncer pass confirmed the dismissal now holds indefinitely, with one accepted trade-off (a category question cannot hold its own row while a permanent overlap dismissal occupies that event — degrades to ask-every-sweep, never a false suppression or a crash).

**Queued rather than smuggled into a patch:** `calendar_issues` has no axis column on its unique key, which is the root behind both dismissal bugs. A schema migration is the only fix that loses nothing, and it gets its own session.

**The ledger now has a memory, and it is the other half of this release.** 310 previously untagged bugs were backfilled with the promise each one broke — identity coverage 22% → 80%. `node scripts/ledger-stats.cjs --index` prints one line per recurring failure sorted by how often it has happened, and **the count is the finding**: a promise broken seven times across four lanes is one missing mechanism, not seven bugs. Two regressions were derived immediately, neither previously flagged by anyone.

**Charter work stays on gh#181** — the Editor's charter gained the ledger as territory and its finding bar is now validation rather than height, but the owner is writing the rest himself and the ticket stays open.
