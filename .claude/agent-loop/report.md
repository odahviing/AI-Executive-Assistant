# Report — cumulative since the 4.8.7 wrap

```
Run wrap-4.8.7 — in: 0 tickets · 0 day(s) of logs · 0 backlog re-reads
out: 20 built · 0 already-fixed · 0 built-with-gap · 8 bounced (6 cleared / 2 ruled by you) · 4/4 joint-traced (0 disagree) · 18/18 outcome-traced · 0 converted · 3 queued
board: net +3 → 4 open rows — 0 still-real · 4 need a re-read · 0 cite no file · 4 rulable · 0 waiting on a verb   (node scripts/ledger-stats.cjs --open)
your 1 row awaits you: 0 from tonight · 0 re-surfaced · 1 found by the loop
```
**1 row awaits you** — v4.8.7 wrapped. The standing backlog is 4 rulable, and the other three are queued discoveries that drain themselves into the next build and need no decision. This one is a genuine product question.

**Built and uncommitted — this is what a wrap ships (20):** `check-claimed-that-never-ran` a real check reported as the wrong finding is caught · `check-claimed-that-never-ran>dep` the booking path carries who was busy · `check-claimed-that-never-ran>dep>dep` the stamper reads it on a failed call · `check-claimed-that-never-ran>dep>dep>dep` and on a combined ask · `owner-office-start-narrated-as-colleague-hours` your hours stop being read as theirs · `noted-and-dropped-claims-write-nothing` "noted, dropping it" needs a write behind it · `notification-claim-retracted-no-backing-tool` a true cancellation notice stops being taken back · `log-deletemeeting-notified-via-dropped-from-summary` the notice reaches the checker at all · `deletemeeting-first-attempt-event-not-found-on-occurrence>dep` the viewed-meeting list works again after being dead since 4.0.0 · `elan-hold-survives-the-move-that-resolved-it>dep` a hold closes when the move resolves it · `elan-hold-survives-the-move-that-resolved-it>dep>dep` the cascade reports who it notified · `news-brief-admits-owner-own-published-sources` your own posts stop counting as coverage · `movemeeting-off-hours-narration-ignores-assumed-flag` a colleague with no stored zone is no longer dropped from the move check · `slots-returned-turn-carries-no-attendee-rejection-reason` a true "outside their hours" survives a search that found slots · `slots-returned-turn-carries-no-attendee-rejection-reason>dep` that field is scrubbed off the email leg · `slots-returned-turn-carries-no-attendee-rejection-reason>dep>dep` the renderer reads it · `closemeetingartifacts-fulfillingrequestid-doc-names-one-stamper` a comment this work made false · `postreply-capturepass-comment-wrong-target` a stale citation · `postreply-replay-comment-wrong-handler` another · `wrap-4-8-7-stale-citations-from-own-edits` three more this day made stale

### pending owner (1)

| Lane · ref | What happened | Your options | Risk |
|---|---|---|---|
| matchmaker · o#273 | loop — (nobody complained; surfaced while closing the 4.8.7 release blocker). `create` and `move` disagree about whether a colleague may book over *another* colleague's busy time. `move` blocks it and asks you; `create` allows it and never even looks. Not a decision anyone made — two guards written separately. | `Recommend: decline — your own rule already says a colleague booking around another colleague is their call, annotate don't block.` If that is right, `create` is correct and **`move`** is the odd one out, so the question may be whether to relax move rather than tighten create. | None either way today. Changing `create` would add a hard gate where there is none; changing `move` would remove one. Both are behaviour changes, neither is a repair. |

### deferred (0)

### declined (0)

Queued and self-draining, no decision needed: the recovery-path search turn still carries no attendee signal (the branch where conflicts matter most) · the failed-book tool line carries its marker but not its finding · the email-leg strip comment states a rationale the code does not deliver.
