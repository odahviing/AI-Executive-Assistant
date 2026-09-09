# Report — cumulative since the 4.9.1 wrap

```
board: 3 open rows — 1 still-real · 2 need a re-read · 0 cite no file · 3 rulable · 0 waiting on a verb   (node scripts/ledger-stats.cjs --open)
```

**3 rows await you** — v4.9.1 wrapped (14d1c48), 0 new from this wrap. Two are queued discoveries that drain themselves into the next build and need no answer; the third has been waiting through three runs.

### pending owner (3)

| Lane · ref | What happened | Your options | Risk |
|---|---|---|---|
| handyman · stale-citation-checker-false-positives-on-body-anchored-citations | loop — the wrap-gating stale-citation checker flags a correct citation as stale when a comment names a symbol but deliberately points inside its body rather than at its declaration. Re-read twice, most recently 2026-09-07; still real. It earned its keep on this wrap: it caught seven genuine line drifts before the commit and all seven were re-pinned. | `Recommend: decline — the tool's own header already discloses this heuristic limit, and narrowing symbol-attribution would trade this rare false positive for more false negatives on every other citation.` | Low — costs a wasted lane dispatch or a "fix" that points a comment at a worse line; the checker still catches real drift everywhere else. |
| matchmaker · email-leg-still-carries-owner-scheduling-mechanics-prose | 4.9.1 — the email-leg fix stops a colleague's availability reaching an external reader, but a non-attendee refusal still carries your own scheduling-mechanics prose ("no room for your lunch", the free-time floor) out to someone you forward to. | `Recommend: build — the same one-line strip at the same chokepoint. Queued rather than assumed, because you may be relaxed about your own mechanics reaching a client in a way you are not about a colleague's calendar.` | Low — it is your information, not a third party's, and it reaches only people you choose to forward to. |
| gatekeeper · local-suffix-means-attendee-zone-on-one-line-and-requester-zone-on-another | 4.9.1 — the bracketed local-time suffix means the attendee's zone on a slot or booking line and the requester's zone on a precheck line. A draft stating a third zone matches no text, and whether the checker keeps or flags it is a coin flip. | `Recommend: build — either label which zone the suffix is in, or make both producers use the same rule.` | Low — rare for this tenant, and strictly better than the pre-4.9.1 behaviour, where the checker did the conversion itself and got it wrong. |

### deferred (0)

### declined (0)
