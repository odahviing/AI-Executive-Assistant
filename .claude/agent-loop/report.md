# Report — cumulative since the 4.8.5 wrap

```
Since 4.8.5 — 1 nightly cron pass · 3 owner-triggered builds · 1 owner-ruled deletion
out: 14 built · 0 confirmed-other-lane · 0 needs-owner-decision · 4 bounced · 0/0 joint-traced · 2 discoveries queued
board: 2 open rows — 0 still-real · 2 need a re-read · 0 cite no file · 2 rulable · 2 queued and self-draining   (node scripts/ledger-stats.cjs --open)
```
**2 rows await you** — both are queued citation fixes that drain themselves into the next build; nothing needs a decision.

**Built and uncommitted — this is what a wrap ships (14):** `asks-for-a-time-she-could-compute` she works out the time instead of asking for it · `availability-precheck-summary-carries-no-timezone` precheck verdicts and the checker that reads them now name the zone, so a workable slot is no longer rewritten into a refusal · `chat-derived-timezone-lost-on-next-auto-read-miss` the fourth provenance column dropped and the fabricated-UTC cleanup deleted as dead on arrival · `fabricated-permanent-utc-rows-never-self-expire` a fabricated permanent zone can be cleared at all · `persistence-ask-asserts-continuity-never-observed` and `>dep` the streak the owner is asked about is the one actually observed · `colleague-path-presents-a-guessed-zone-as-settled-fact` a guessed zone reaches a colleague with the same hedge the owner gets · `slackusersearchresult-tz-required-field-still-defaults-utc` a required field stops promising an invented zone · `createmeeting-failed-summary-drops-counter-offer-reason` a counter-offer keeps its reason · `stale-crossref-comment-in-slack-connector-tz-fix` · `whatsapp-doc-claims-a-people-memory-column-that-does-not-exist` · `line-number-citations-in-prose-are-a-recurring-tax` docs cite symbols, not line numbers · `backfill-librarian-2026-09-03` and `backfill-slackmaster-2026-09-03` two cron lane-days whose rows landed on the next UTC day

| Lane · ref | What happened | Your options | Risk |
|---|---|---|---|

2 queued for the next build, both citation repairs with no behaviour: `upsertpersonmemory-timezonereadingabsent-doc-misdirects` (already fixed in this diff as a side effect of the deletion, needs its row closing next run) and `postreply-replay-comment-wrong-handler`.

Golden battery 30/30 with 0 fails over this exact tree — run in three segments after the first attempt fanned out and terminated without compiling, which would have looked clean while verifying half. 4 stale anchors re-pinned, each checked against the file by hand, including one the two segments disagreed on (`Z18` points at the `owner_fact` path, not the action-claim path — settled by finding `mode: 'owner_fact'` at `runOutputGates.ts:1461`). One Fable pass over the full diff: sound, no overturn. It caught the sweep script being dead on arrival — its query had begun matching legitimately stated timezones — which the owner then ruled deleted rather than shipped. It also found 9 `verifiedClean` entries asserting code that no longer exists; those were dropped, since a stale proven-clean silences a real check.
