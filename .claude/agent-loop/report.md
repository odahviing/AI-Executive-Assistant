# Agent-loop report

**Empty — v4.3.1 wrapped and pushed (`b7a4a8b`).** Nothing is waiting on you.

## Carried forward (not rows — context for the next run)

**Deploy when ready.** The commit is under the owner's author, so the deploy watcher does not auto-pull it. `npm run deploy` and confirm the boot stamp reads `version: 4.3.1 / gitSha: b7a4a8b`.

**Watch on first real use:**
- A colleague sends you a picture → the file itself should land in your DM, threaded under that colleague's other receipts, with the receipt line reading `[Image — …]` rather than `(image attached, no caption)`.
- Same after a restart/outage — catch-up images are forwarded too now, and a colleague message whose *image* fails to download should still get its text answered.
- Hebrew gender inference is **off** until `advanced.self_declared_gender_detection: true` is set in `idan.yaml`.

**Two discoveries deliberately not built** (building a discovery invalidates the pass that found it):
- The image download/scan loop exists in more than one place and has drifted twice — the replay copy losing its scan *was* the 4.3.1 fix, and the DM copy now has a forward the channel copy lacks. The next image change will land on one and miss the other.
- The colleague-image forward is one config field from silently inert: no `user.email` → `getOwnerDomain` returns null → every image skipped with no error. Fine here, a dead feature on a clone.

**One thing unverifiable from code:** `files:write` scope for the *channel* upload path. The bot has it for DMs. If it is missing, uploads now fail visibly via `attachments_failed` rather than vanishing.

**Accepted knowingly:** 144's residual (the predicate proves the owner wrote the zone token, not that he asserted it about that person) · the shadow-anchor race that can produce two owner DMs instead of one thread when four uploads are in flight.

**Still parked by owner decision:** gh#52's undo tool (substrate decided — the requests spine; revertibility follows spine membership) · gh#45 (the specified fix would silently fail; belongs with gh#155) · gh#155 · rows 125/126.

**Open and NOT closed at this wrap:** gh#24 (confirmed partial), gh#51, gh#52, gh#45, gh#155.
