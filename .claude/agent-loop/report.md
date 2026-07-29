# Agent-loop report

**Everything is built, verified, and typecheck-green. Nothing is waiting on you except the wrap.**

## What shipped into the tree (uncommitted)

| # | What you'll notice | Status |
|---|---|---|
| gh#144 | **You can see colleague images now** — the file lands in your DM, threaded under that colleague's receipts. Also on catch-up after downtime | built |
| gh#52 | `audit_log` is owner-scoped (a real multi-tenant leak) · the "did you book that?" recall now actually fires — it never had · a move records where it *was* | built |
| gh#51 | Hebrew gender read from a person's own words. Opt-in, **default off** | built |
| 143 | Email turns stop being taught `delete_meeting` — **−27% tokens per email turn** | built |
| 145 | No more "you asked for EST" when the system guessed the zone | built |
| 144 | A wrong timezone can no longer stick at owner authority | built |
| 146 | A colleague no longer waits ~9 network calls to send a screenshot | built |
| 147 | Colleague images arriving after downtime are injection-scanned | built |
| 147a/b | Dead line removed · **catch-up now answers the text when an image fails to download** | built |

## The one thing the verify caught

The first version of 146 introduced a regression: a transient Slack failure would have **overwritten a colleague's real name with their raw Slack ID** in `people_memory` — and that name feeds the system prompt, outreach and invites. It self-heals on the next turn, so it would never have been noticed. Fixed at the root (one fetch, throw restored, `prefetchedSenderInfo` removed entirely). This is the whole reason a direct dispatch still owes a combined pass.

Also corrected: the "two round trips" claim in that row was wrong — there were three.

## Owner rulings recorded 2026-07-29

Catch-up **exempted** (text still answered on a download failure; a *suspicious* image still fails closed) · 144's residual **accepted**, no ticket · all nine proposed charter rules **declined** — not charter material · gh#24 stays **partial** · gh#144 **closes at the wrap**.

## AT WRAP

**Close gh#144** with a note that it was solved by ingestion-time forwarding rather than the ticket's items 2/3 (unbuilt), that channel/@mention colleague images are not forwarded, and that external/guest colleagues are excluded by the domain gate. **Close nothing else.**

## Known and deliberately left

Two discoveries, not built (building a discovery invalidates the pass that found it): **the image download/scan loop exists in two places and has drifted twice** — the replay copy losing its scan *was* row 147, and the DM copy now has an owner-forward the channel copy lacks, so the next image change will hit one and miss the other. And **the forward is one config field from silently inert** — no `user.email` means `getOwnerDomain` returns null and every colleague image is skipped with no error, which for a second tenant is a feature that looks built and does nothing.

Cosmetic, accepted: with four uploads in flight the forward can race the reply receipt and produce two owner DMs instead of one thread.

Still parked by your own call: gh#52's undo tool · gh#45 (the specified fix would silently fail) · gh#155 · rows 125/126.

**One thing I cannot check from code:** `files:write` scope for the *channel* upload path. The bot has it for DMs. If it's missing, uploads now fail visibly via `attachments_failed` rather than vanishing.
