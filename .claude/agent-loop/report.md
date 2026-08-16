# Agent-loop report

```
Run wf_05b7d7cc-4d6 — in: 1 tickets · 0 day(s) of logs · 1 backlog re-reads
out: 5 built · 9 already-fixed · 0 built-with-gap · 0 bounced · 0/0 joint-traced · 0 converted · 0 queued
board: net -9 → 5 open rows — 2 still-real · 3 need a re-read · 0 cite no file · 5 rulable · 0 waiting on a verb   (node scripts/ledger-stats.cjs --open)
your 5 rows await you: 1 from tonight · 2 re-surfaced · 2 found by the loop
```

### Pending owner (5)

| # · Lane · Status | The chat problem | The issue | The solution | Risk |
|---|---|---|---|---|
| `coda-grounding-not-shown-to-validator` · librarian · pending owner — recommend build · loop | — (verify discovery, nobody complained) | The coda's grounding reaches the composer but never the validator that vets the finished sentence, so a real claim can be dropped as invented and an invented one is never compared against a source. | `src/core/social/generateCoda.ts:456` — pass the search snippet and past-message excerpt into the coda claim-check alongside the composed text. | Sharper after 4.6.0 than before it: a coda may now be a statement, and a statement asserts facts a question did not. |
| `coda-ai-disclosure-non-english-gap` · gatekeeper · pending owner — recommend build · re-surfaced (2026-08-14) | — (raised by the 4.5.8 wave, parked pending this rewrite) | `scanForLeaks`' `self_ai_claim*` patterns are English-only regex, so the same claim in Hebrew or French passes. `runHumanGate` is the only language-agnostic backstop. | `src/utils/guards/runOutputGates.ts:726-749` — its deferral condition has fired; re-read confirms 4.6.0 changed what a coda says, never what vets it. | The exposure grew with 4.6.0: lifting the must-be-a-question rule makes a self-disclosure statement more natural to produce. |
| `persona-block-describes-dead-raise-new-mode` · instructor · pending owner — recommend build · loop | — (verify discovery) | The PERSONA block still tells Sonnet the in-turn directive can be `raise_new`, a mode the picker can no longer produce outside the coda. | `src/skills/social.ts:267` — delete the `raise_new` description, matching what INS-1 already did in the mode rules. | Low. Describes an unreachable mode rather than authorising a wrong action, but it is the second-copy class this wave's one-system rule exists to remove. |
| `gh#187` · instructor · pending owner — recommend build · tonight | "Closing a conversation kills tone guidance entirely — even when the sign-off line itself carries the real content." | `conversation_state === 'closing'` returns `noDirective()` outright, so a message like "heading out, but that's rough about your mom" gets no tone guidance at all. | Let a closing turn carry a brief acknowledgment of content already on the table, without introducing anything new. Unblocked by gh#198 — the surface it needs survived the rewrite. | `stateMachine.ts` was substantially rewritten in 4.6.0; a builder must re-read the current file rather than the line numbers in the ticket. |
| `gh#199` · handyman · pending owner — recommend defer · re-surfaced (2026-08-12) | — | Unchanged since it was raised. | Blocked on a console-side Google action only the owner can perform. | None. Nothing in the tree moves this. |

**Built and shipped in 4.6.0 (5):** `gh#198` social/coda subsystem rewrite · `gh#198-librarian` grounding, picker, scoring, reject path · `gh#198-handyman` schema, two migrations, decay retirement · `gh#198-instructor` mode rules, taxonomy, coda shape, fourth surface · `gh#198-slackmaster` variable beat, conversation read helper
