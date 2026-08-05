# Agent-loop report

**Empty — v4.4.9 wrapped. 0 rows await you.** Standing backlog: **5 open rows** across 5 bugs · 1 still-real · 3 need a re-read (never examined) · 1 cites no file · **5 rulable, all carrying a recommendation · 0 waiting on a verb** · 2 are QUEUED for the next build and drain themselves (`node scripts/ledger-stats.cjs --open`).

**Built and shipped in this wrap (4):** the calendar-issues dismissal pair (bounced once — the first attempt cleared the reported abort and erased the owner's standing "never auto-move this again" within one sweep; the second guards it permanently), two more sibling notes carrying the assumed-hours hedge, and the `find_slack_user` breadcrumb's missing timestamp.

**One thing queued rather than smuggled in:** `calendar_issues` has no axis column on its unique key, which is the root behind both dismissal bugs. A schema migration is the only fix that loses nothing — it gets its own session.

**The ledger now has a memory, and it is the other half of this release.** 310 previously untagged bugs were backfilled with the promise each one broke, taking identity coverage from 22% to 80%. `node scripts/ledger-stats.cjs --index` prints one line per recurring failure sorted by how often it has happened — **the count is the finding**: a promise broken seven times across four lanes is one missing mechanism, not seven bugs. Two regressions were derived immediately, neither previously flagged by anyone.

**Charter work stays on gh#181, not here** — the Editor's charter gained the ledger as territory and its finding bar is now validation rather than height, but the owner is writing the rest of that section himself and the ticket stays open.
