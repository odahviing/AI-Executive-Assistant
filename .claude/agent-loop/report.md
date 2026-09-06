# Report — cumulative since the 4.8.7 wrap

```
Run — nothing since the wrap · in: 0 tickets · 0 day(s) of logs · 0 backlog re-reads
out: 0 built · 0 already-fixed · 0 built-with-gap · 0 bounced · 0/0 joint-traced · 0/0 outcome-traced · 0 converted · 0 queued
board: net 0 → 4 open rows — 4 still-real · 0 need a re-read · 0 cite no file · 4 rulable · 0 waiting on a verb   (node scripts/ledger-stats.cjs --open)
your 1 row awaits you: 0 from tonight · 0 re-surfaced · 1 found by the loop
```
**1 row awaits you** — v4.8.7 wrapped and deployed, 0 new from this wrap. The standing backlog is 4 rulable and all four were re-read at the wrap; three are queued discoveries that drain themselves into the next build and need no decision. This one is a genuine product question.

### pending owner (1)

| Lane · ref | What happened | Your options | Risk |
|---|---|---|---|
| matchmaker · o#273 | loop — (nobody complained; surfaced while closing the 4.8.7 release blocker). `create` and `move` disagree about whether a colleague may book over *another* colleague's busy time. `move` blocks it and asks you; `create` allows it and never even looks. Not a decision anyone made — two guards written separately. | `Recommend: decline — your own rule already says a colleague booking around another colleague is their call, annotate don't block.` If that is right, `create` is correct and **`move`** is the odd one out, so the question may be whether to relax move rather than tighten create. | None either way today. Changing `create` would add a hard gate where there is none; changing `move` would remove one. Both are behaviour changes, neither is a repair. |

### deferred (0)

### declined (0)

Queued and self-draining, no decision needed: the recovery-path search turn still carries no attendee signal (the branch where conflicts matter most) · the failed-book tool line carries its marker but not its finding · the email-leg strip comment states a rationale the code does not deliver.
