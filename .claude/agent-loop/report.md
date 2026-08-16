# Agent-loop report

**4 rows await you** — v4.6.0 wrapped, 2 new from this wrap. Standing backlog: **4 open rows** across 4 bugs · 2 still-real · 2 need a re-read · 0 cite no file · **4 rulable · 0 queued for the next build** (`node scripts/ledger-stats.cjs --open`).

out: 1 built · 0 already-fixed · 0 built-with-gap · 3 bounced (2 cleared, 1 resolved by owner ruling) · 0 converted · 2 discoveries filed

**Built and shipped in 4.6.0 (1):** `gh#198` — the social/coda subsystem rewrite, 17 pieces across 4 lanes (librarian · handyman · instructor · slackmaster) over four build rounds.

This was a FEATURE wave (`feature.js`), not a nightly bug loop: plan mode ran twice — once against the raw ticket, then again with sixteen owner constraints folded in after the first decomposition proved to be built on a deferred-scoring assumption the owner reversed. The owner ruled every design question in-session and then verified the finished plan against the product goal himself, which added three pieces the decomposition had missed (coda shape no longer forced to be a question, bootstrap from a search result alone, variable delivery beat).

Two verify overturns were resolved by owner rulings rather than by a lane guessing. The work-gate brief contained a genuine contradiction — it demanded a code-level guarantee while forbidding every code-level mechanism — and the lane correctly escalated instead of shipping a prompt rule; resolved by reusing `classifyTurn`'s already-computed per-turn `kind`. The resolve-on-read ordering took three attempts: two used a fixed grace window and were both refused, because the bookkeeping that erased the evidence runs ~23 hours before the check that needed it; the owner chose a stored-fact check over a clock.

The wave also surfaced a fourth origination surface nobody had named — `systemPrompt.ts`'s SOCIAL LAYER block, telling her *"if you never start, you're a transaction surface"* on every turn, owned by no piece because no Librarian piece may edit that file and none of the three Instructor pieces covered it.

**Awaiting you (4):**
- `coda-grounding-not-shown-to-validator` (librarian, medium) — the coda's grounding is handed to the composer but never to the validator that vets the finished sentence. Sharper after 4.6.0, since a coda may now be a statement. Recommend build.
- `coda-ai-disclosure-non-english-gap` (gatekeeper) — deferred in 4.5.8 pending this rewrite; the condition has now fired and it is DUE. Re-read confirmed it is untouched by 4.6.0 and the exposure is larger.
- `persona-block-describes-dead-raise-new-mode` (instructor, low) — a second copy of the dead-mode text INS-1 removed. Recommend build.
- `gh#199` (handyman) — unchanged, blocked on a console-side Google action. Recommend defer.
