# Agent-loop report

**Empty — v4.4.2 wrapped. 0 rows await you.** Standing backlog: **30 open rows** across 30 bugs · 1 still-real · 28 need a re-read · 1 cite no file (`node scripts/ledger-stats.cjs --open`). **24 rulable · 6 waiting on a verb** · 10 are QUEUED for the next build and drain themselves. The usher now writes a verb for the six during its backlog pass.

**Built and uncommitted — this is what a wrap ships (0):** none. 4.4.2 is framework-only; the built rows the ledger still holds since the last stamp shipped in the two releases before it, whose wraps never wrote this line.

The re-read count jumped from 4 to 28 because this release reworded comments in 74 `src/` files, so almost every row's cited line moved. That is staleness in the citation, not in the finding.

- **Watch on the first run under the new engine:** a run now merges found + queued + backlog into one pile per lane. Check `manifest.carry` — `usherRan`, `fromUsher`, `fromQueue`, `fromBacklog`, and `newlyVerbedRows`, which names every row the usher gave a verb to on your behalf.
