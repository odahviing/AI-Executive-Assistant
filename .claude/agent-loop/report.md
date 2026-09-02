# Report — cumulative since the 4.8.5 wrap

```
Since the 4.8.5 commit — 3 owner-triggered builds + 1 chained dependency + 1 run by another chat
out: 12 built · 0 confirmed-other-lane · 0 needs-owner-decision · 2 bounced · 0/0 joint-traced · 4 discoveries queued
board: 5 open rows — 1 still-real · 4 need a re-read · 0 cite no file · 5 rulable · 4 queued and self-draining   (node scripts/ledger-stats.cjs --open)
```
**5 rows await you** — but only one needs a decision: the documentation-convention question (`o#268`). The other 4 are queued discoveries that drain themselves into the next build.

**Built and uncommitted — this is what a wrap ships (12):** `slack-tz-fabricated-no-real-signal` Slack's silence is no longer stored as UTC · `slack-tz-utc-default-still-reaches-the-model-on-read` and no longer handed to the model either · `slack-absent-reading-signal-not-wired-at-any-call-site` the retirement path now has callers at all 7 Slack-read sites instead of being dead code · `pre-existing-fabricated-utc-temp-rows-still-feed-the-ask` a stale fabricated temp row is retired when a real read reports no zone · `people-contact-block-travel-not-from-gated` a trip that has not started is no longer narrated as where someone is now · `owner-own-trip-read-is-not-date-scoped-books-online-after-trip-ends` booking after your trip ends lands in the office · `outreach-model-supplied-tz-written-as-a-slack-reading` a model-guessed zone is no longer tagged as Slack's · plus the travel-reader consolidation, the `runner.ts` ask-state split, the dead `categoryRules` branch (`categoryrules-owner-worded-colleague-explanation-is-dead`), and the quote-strip in the bound-approval note (`boundhint-note-does-not-strip-quotes-from-colleague-text`) · `internal-colleague-travelling-to-owners-city-still-forced-online` · `people-ts-scope-header-cites-an-unreachable-path`

| Lane · ref | What happened | Your options | Risk |
|---|---|---|---|

**4 queued for the next build.** The one that matters: `fabricated-permanent-utc-rows-never-self-expire` (librarian, medium) — **your accept-the-window ruling does not cover this class.** You accepted the residual because those rows self-expire by 2026-09-08; a fabricated `UTC` in the PERMANENT column never expires, and since Slack still reports nothing for those people nothing will ever correct it. Needs a separate ruling. Then `persistence-ask-asserts-continuity-never-observed` (the 7-day streak is asserted, not observed) · `colleague-path-presents-a-guessed-zone-as-settled-fact` · `slackusersearchresult-tz-required-field-still-defaults-utc`.

Golden battery 30/30 with 0 fails over this exact tree, 5 stale anchors re-pinned and each verified by hand. One Fable pass over the full accumulated diff: PASS, no overturn, and it independently verified the `timezoneReadingAbsent` caller set is complete at 14 sites — 7 wired, 7 correctly left unwired. It also caught `state.json` and this report lagging a completed run for the second time tonight; both were reconciled before this commit, and both were found by an adversarial pass rather than by me.
