# Agent-loop report

```
Run wf_05b7d7cc-4d6 — in: 1 tickets · 0 day(s) of logs · 1 backlog re-reads
out: 7 built · 9 already-fixed · 0 built-with-gap · 0 bounced · 0/0 joint-traced · 0 converted · 0 queued
board: net -11 → 4 open rows — 3 still-real · 1 need a re-read · 0 cite no file · 4 rulable · 0 waiting on a verb   (node scripts/ledger-stats.cjs --open)
your 4 rows await you: 1 from tonight · 2 re-surfaced · 1 found by the loop
```

### Pending owner (4)

| # · Lane · Status | The chat problem | The issue | The solution | Risk |
|---|---|---|---|---|
| `coda-ai-disclosure-non-english-gap` · gatekeeper · pending owner — recommend defer · re-surfaced (2026-08-14) | — (raised by the 4.5.8 wave, parked pending the coda rewrite) | `scanForLeaks`' `self_ai_claim*` patterns are English-only regex, so the same self-disclosure in Hebrew or French passes. `runHumanGate` is the only language-agnostic backstop. | `src/utils/guards/runOutputGates.ts:726-749` — its deferral condition fired when 4.6.0 shipped; re-read confirms the rewrite changed what a coda says, never what vets it. | Owner ruled 2026-08-16: *"no worry about the bot disclosures, we will handle it later."* Deferred by his decision, not by the loop's. Exposure did grow with 4.6.0 — a statement-shaped coda is a more natural place for a self-disclosure than a question. |
| `persona-block-describes-dead-raise-new-mode` · instructor · pending owner — recommend build · loop | — (verify discovery) | The PERSONA block still tells Sonnet the in-turn directive can be `raise_new`, a mode the picker can no longer produce outside the coda. | `src/skills/social.ts:267` — delete the `raise_new` description, matching what INS-1 already did in the mode rules. | Low. Describes an unreachable mode rather than authorising a wrong action, but it is the second-copy class this wave's one-system rule exists to remove. |
| `gh#187` · instructor · pending owner — recommend build · tonight | "Closing a conversation kills tone guidance entirely — even when the sign-off line itself carries the real content." | `conversation_state === 'closing'` returns `noDirective()` outright, so a message like "heading out, but that's rough about your mom" gets no tone guidance at all. | Let a closing turn carry a brief acknowledgment of content already on the table, without introducing anything new. Unblocked by gh#198 — the surface it needs survived the rewrite. | `stateMachine.ts` was substantially rewritten in 4.6.0; a builder must re-read the current file rather than the line numbers in the ticket. |
| `gh#199` · handyman · pending owner — recommend defer · re-surfaced (2026-08-12) | — | Unchanged since it was raised. | Blocked on a console-side Google action only the owner can perform. | None. Nothing in the tree moves this. |

Everything built this run is shipped: `gh#198` and its four lane rows in `025f6b5`, the two coda-grounding rows in `fbf9f9a`. Both commits are v4.6.0 — the owner ruled no second bump.
