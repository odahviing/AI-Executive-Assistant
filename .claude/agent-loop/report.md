# Agent-loop report

```
Wrap 4.4.7 — in: 1 ticket · 0 day(s) of logs · 0 backlog re-reads
out: 11 built · 3 already-fixed · 0 built-with-gap · 0 bounced · 5/5 joint-traced · 0 converted · 9 queued
board: 17 open rows — 1 still-real · 15 need a re-read · 1 cite no file · 17 rulable · 0 waiting on a verb   (node scripts/ledger-stats.cjs --open)
0 rows await you: 0 from tonight · 0 re-surfaced · 0 found by the loop
```

**Built and uncommitted (0):** none — this wrap ships it all.

**Note:** most of this wrap's work arrived as live owner reports in chat, not through a github/logs/backlog pass — 5 bugs the owner watched happen in real time (relay-history, quarter-hour booking, the Erez autofix recurrence, the MPIM slack-id leak, plus one regression the pre-wrap bouncer pass caught inside the night's own diff before it shipped). All five traced to root cause and confirmed fixed by a dedicated bouncer pass before this wrap. Also backfilled: 8 ledger rows from the 4.4.6 wrap whose `state` field was never advanced from `built` to `wrapped` (X152) — corrected this wrap, no code change involved.

**`0 bounced` above is a ledger-position artifact, not the true count.** The 8 X152-correction rows just above were appended with `runId:"wrap-4.4.6"`, which the `--report` boundary scan reads as the most recent wrap stamp — pushing "since last wrap" to empty and hiding this wrap's own bounces from that one mechanical check. The real count, individually recorded on each row: **4 bounced this wrap** (`private-mask-is-not-a-narration-fallback-automove`, `relay-history-not-read-on-unthreaded-reply`, `mpim-reply-addresses-colleague-in-third-person-with-slackid`, `email-colleague-freebusy-failure-has-no-signal` — each caught and fixed on retry, none reached the owner unresolved). Self-inflicted by this wrap's own correction step; does not recur once `wrap-4.4.7`'s own stamp becomes the newest boundary.
