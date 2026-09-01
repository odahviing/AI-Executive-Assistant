# Report — cumulative since the 4.8.4 wrap

```
out: 0 built · 0 bounced · 0/0 joint-traced — nothing built since the wrap
board: 5 open rows — 4 still-real · 1 need a re-read · 0 cite no file · 5 rulable · 5 queued and self-draining   (node scripts/ledger-stats.cjs --open)
```
**5 rows await you** — v4.8.4 shipped in `dd0093a`; nothing new has been built since, and all 5 standing rows are queued discoveries that drain themselves into the next build.

| Lane · ref | What happened | Your options | Risk |
|---|---|---|---|

5 queued for the next build, detail in each ref's ledger row: `reverted-auto-reading-never-retires-temp-row` (librarian, medium — a hedge can name a Slack reading for up to a week after Slack stopped reading it) · `timezone-ask-retries-delivery-against-a-closed-row` (registrar, low) · `internal-colleague-travelling-to-owners-city-still-forced-online` (matchmaker, low — the internal half of a guest-facing fix that shipped in 4.8.4) · `hedge-suppression-is-trip-scoped-not-meeting-date-scoped` (matchmaker, low) · `whatsapp-timestamp-unit-mismatch-ms-vs-seconds` (diplomat, low — dormant transport). All four of the first were re-verified against the shipped tree during the wrap's phantom-candidate check and confirmed still open.

v4.8.4 shipped 30 refs across three owner-triggered runs, one hand dispatch and one unattended nightly run. Two adversarial Fable passes over the full tree, both PASS with zero overturns — the second re-run from scratch because the nightly cron landed ten more fixes after the first had already read the tree. Golden battery run twice, 30/30 both times, 0 fail, 16 stale anchors re-pinned. One owner ruling settled the release's shape: a stored timezone is always temporary unless he says otherwise, and he is the only door to promotion.
