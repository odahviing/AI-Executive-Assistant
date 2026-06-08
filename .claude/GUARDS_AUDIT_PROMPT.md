# Audit mandate: are Maelle's "guards" a sound design or a recurring liability?

You are an **external auditor**. You did not build this system and you owe it no loyalty. Your job is to judge a whole architectural pattern — *be willing to conclude it's the wrong approach.* Do **not** propose code fixes or patches. Produce a reasoned verdict.

## The system

Maelle is an AI executive assistant (TypeScript, at `E:/Code/Maelle`). Her main reply loop is: the model (Claude) drafts a reply → a stack of **"guards"** runs on that draft before it's sent → the reply goes out. The guards are mostly **LLM-based post-hoc verifiers**: a second model call judges the first model's output against a rule, and on a flag the turn is often **retried** or the text **deterministically rewritten**.

The guard roster and where they live:

- `src/utils/dateVerifier.ts` — checks weekday/date consistency; corrects mismatches.
- `src/utils/claimChecker.ts` — detects "false action claims" (draft says "booked it" but no tool ran); forces a retry.
- `src/utils/humanGate.ts` — catches Maelle framing herself as software ("the routine fired").
- `src/utils/securityGate.ts` — rewrites colleague-facing replies that leak AI/bot identity or internal IDs.
- `src/utils/addresseeGate.ts`, `src/utils/coordGuard.ts`, `src/utils/imageGuard.ts` — addressing, injection, and image-injection checks.
- The orchestration that runs/retries them: `src/connectors/slack/postReply.ts` (the gate stack, the retry paths, and a `matchingToolAlreadyRan` "shield" that suppresses retries when a tool already ran).

Start by **reading these files** and mapping: what each guard does, whether it's LLM or deterministic, what action it takes on a flag (rewrite / retry / block), and how they're chained in `postReply.ts`.

## What happened (the case study that triggered this audit)

A user asked to book a 25-min meeting Thursday June 11 at 11:30. The booking engine was correct throughout (it booked June 11). But the **dateVerifier's LLM sub-check** (the "bare-weekday context pass") fired with no basis: the user's message had no relative-day anchor, yet the model **hallucinated a date and rewrote the correct weekday** — "Thursday" → "Monday", then on a later turn "Thursday" → "Friday". Worse, the corrupted text was **persisted into conversation history**, so a confirming "ok" from the user could have driven a *wrong-day booking*. The model-judge had an explicit prompt rule ("NO ANCHOR, NO FLAG — never guess a date") and **ignored it**. (That sub-check has since been deleted.)

## The repeat pattern (this is the real subject of the audit)

This class of failure recurs across the guards, and each time it has been **patched rather than reconsidered**:

- The same dateVerifier sub-check previously caused a **wrong meeting to be deleted** (the "Michal" incident) — a post-filter was added; the failure returned in a new form (above).
- The claimChecker **false-positive-retries** on honest replies (e.g. a preference save narrated as "Saved"), wasting turns; a `matchingToolAlreadyRan` shield was added, then had to be extended tool-by-tool as gaps surfaced.
- The pattern underneath: **one LLM judging another LLM's output against a rule the judge then ignores under load**, producing *false positives that corrupt correct output*, plus latency, cost, and history pollution. The fixes are layers on layers (shields, post-filters, anchor-gates), each patching the previous patch.

## Your mandate

Step back from any individual bug and judge the **concept**:

1. **Is post-hoc LLM self-checking (a model grading the model, then retrying/rewriting) a sound pattern here — or is it structurally fragile?** Make the strongest case both ways.
2. For each guard, classify: **keep / kill / redesign**, and *why* — distinguishing the **deterministic** guards (regex / lookup / rule-engine — generally trustworthy) from the **LLM-judgment** guards (the recurring offenders).
3. Where a guard exists to enforce *determinism* (dates, honesty about actions, ID leaks), should that determinism move **upstream** — into the tools / decision functions / data Maelle reads — so the post-hoc guard becomes unnecessary? The project's own stated principle is "determinism in code at the chokepoint; judgment/tone in the prompt." Assess how well the guards honor or violate that.
4. What is the **failure-direction** of each guard — does a mistake cause a *miss* (safe) or a *corruption of correct output* (dangerous)? Flag every guard whose failure mode is "corrupts correct output."
5. A blunt recommendation: **how many of these should exist at all**, and what is the minimal trustworthy set.

## Deliverable

A written verdict with per-guard classification and an overall judgment on the pattern. Propose-only — no code. Be adversarial; the owner has lost trust in these guards and wants an honest outside read on whether the whole idea is worth keeping.
