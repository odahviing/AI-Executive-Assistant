# Agent-loop report

**Empty — v4.3.5 wrapped, pushed, and deployed. Nothing in this table awaits you.**

That is not the same claim as nothing is owed. The standing backlog is **56 open rows** (35 confirmed, 14 needing a re-read, 7 citing no file) — `node scripts/ledger-stats.cjs --open`. This file holds only what a run put in front of you, and it was emptied at the wrap after every row was appended to the ledger.

## What shipped, and what of it was verified

**Six product rows. Five verified by the pre-wrap pass.** It overturned one — the approval-relay text, whose second clause contradicted the requester rule on the always-on prompt tier — and that was corrected before release rather than shipped or deferred. **Three text corrections shipped on targeted re-reads rather than a second full pass**: the overturned clause, a false *"same as a calendar read here"*, and a comment three times the size of the deletion it described. All three are text in files the pass had already opened.

## Next run's first items

1. **`owner-memory-injected-into-clamped-mpim` · instructor · the one to look at first.** `systemPrompt.ts:779-791` and `:799-810` gate on `if (isOwner || !senderId) return ''` — in a clamped MPIM `isOwner` is false while `senderId` is yours, so **"MEMORY ON IDAN"** plus your full `.md` renders into a colleague-readable thread. Latent, not live. **The guard already exists** at `buildTurnContext.ts:575-578` and these siblings never got it. Queued, not built — I want your word first.
2. **`honest-refusal-rule-is-mpim-only` · instructor · medium.** B157-c's rule lives in the `isOwnerInGroup` branch, so a clamped owner in a **channel** takes `:439` and can still fabricate the exact gh#157 negative. Same code path, owner as the victim. Connects to gh#154's parked per-surface question.
3. **`nested-news-timeout-not-derived-from-inner-budget` · outrider · medium.** Three magic numbers, two files, the relation held in a comment. gh#166 has now been fixed twice by adjusting a number.
4. **`prompt-budget-grew-1836-chars-unmeasured-by-anything` · outrider.** Nothing tracks rendered prompt growth per tier. This wave counted it by hand for the first time.
5. Plus `create-approval-desc-contradicts-requester-grant` (now fixed, keep the row for the pattern), `order-violation-subject-unmasked` (low, latent), `movemeeting-comment-still-says-self-only` (low), and **B168-a — deferred, therefore DUE**, since a deferral is a one-run skip.

## Deploy

Done. Boot stamp confirmed below in the wrap summary.

## Watch on first real use

A colleague asking to book over a private recurring meeting → the refusal should say `[Private]`, not the real subject · a **requester** asking to add a third person to their own meeting → she should just do it, no approval · a **non**-requester asking → routed to you · an availability question about a named colleague in a group chat → *"I can't check or share that from here"*, never *"no history"* · an on-demand *"send the brief"* → news should survive the wait now · and if a slot she offered goes stale, she should **name what moved** rather than sounding like she changed her mind.
