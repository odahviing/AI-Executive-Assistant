# Agent-loop report

```
Wrap v4.6.1 — in: 1 GitHub investigation (gh#201, 4 sub-findings) + 1 parallel session's work
out: 10 built · 0 already-fixed · 0 built-with-gap · 2 bounced · 3/3 joint-traced · 0 converted · 0 queued
board: net 0 → 3 open rows — 3 still-real · 0 need a re-read · 0 cite no file · 3 rulable · 0 waiting on a verb   (node scripts/ledger-stats.cjs --open)
your 3 rows await you: 0 from tonight · 3 re-surfaced · 0 found by the loop
```

**Built and uncommitted — this is what a wrap ships (10):** `gh#201-b` owner-mediated colleague booking relay rule · `gh#201-c` outreach-reply job matching restored + thread anchor (bounced once) · `gh#201-d` proactive colleague re-engagement after an away period, output-gate routed (bounced once) · `persona-block-describes-dead-raise-new-mode` dead prompt mode deleted · `owner-memory-lookup-misses-own-row` full-name person-memory fix · `person-memory-tool-blind-to-social-store` social subjects surfaced in get_person_memory · `subject-running-summary` merged per-subject summary · `social-subject-summary-column` schema migration for the summary field · `note-about-person-save-replaces-reply` · `note-about-person-required-id-forces-hallucination`

### Pending owner (3)

| # · Lane · Status | The chat problem | The issue | The solution | Risk |
|---|---|---|---|---|
| `coda-ai-disclosure-non-english-gap` · gatekeeper · pending owner — recommend defer · re-surfaced (2026-08-14) | — (raised by the 4.5.8 wave, parked pending the coda rewrite) | `scanForLeaks`' `self_ai_claim*` patterns are English-only regex, so the same self-disclosure in Hebrew or French passes. `runHumanGate` is the only language-agnostic backstop. | `src/utils/guards/runOutputGates.ts:726-749` — its deferral condition fired when 4.6.0 shipped; re-read confirms the rewrite changed what a coda says, never what vets it. | Owner ruled 2026-08-16: *"no worry about the bot disclosures, we will handle it later."* Deferred by his decision, not by the loop's. Exposure did grow with 4.6.0 — a statement-shaped coda is a more natural place for a self-disclosure than a question. |
| `gh#187` · instructor · pending owner — recommend build · re-surfaced | "Closing a conversation kills tone guidance entirely — even when the sign-off line itself carries the real content." | `conversation_state === 'closing'` returns `noDirective()` outright, so a message like "heading out, but that's rough about your mom" gets no tone guidance at all. | Let a closing turn carry a brief acknowledgment of content already on the table, without introducing anything new. Unblocked by gh#198 — the surface it needs survived the rewrite. | `stateMachine.ts` was substantially rewritten in 4.6.0; a builder must re-read the current file rather than the line numbers in the ticket. |
| `gh#199` · handyman · pending owner — recommend defer · re-surfaced (2026-08-12) | — | Unchanged since it was raised. | Blocked on a console-side Google action only the owner can perform. | None. Nothing in the tree moves this. |
