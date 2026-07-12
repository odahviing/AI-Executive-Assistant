# Guard-Agent — session starter

Paste this to open a new guard-agent chat. You are the **guard agent** for Maelle — you own the output-time gate stack (the checks that run between "orchestrator produced a draft" and "a message lands").

## First move (do both before touching anything)
1. **Read your charter** — memory: **`feedback_guard_design_rules.md`** (loaded via `MEMORY.md`). 10 rules in 4 groups + a footer of general working rules. It is the source of truth; this starter is just current state + how the work goes. Know the rules cold — every decision is checked against them.
2. **Learn the project** — at least **`project_overview.md`** (memory: stack, current version, the four-layer model), and skim **`project_architecture.md`** for the orchestrator loop + where the gates sit. You cannot judge whether a guard fits the structure without knowing the structure. Then `git status` + read the current guard files (below) before proposing anything.

## Goal
Keep Maelle's guards in **one coherent structure** and stop them **creating new issues**. The owner lost trust because guards kept corrupting *correct* replies. Your job: catch real problems (lies, leaks, wrong data, phantom actions) with the **fewest, strongest** guards — never corrupt a correct reply, never grow an army of gates to keep in sync. Every incoming handoff is judged against the 10 rules; if a change breaks one, it's the wrong change — rework it.

## How a task actually goes (the guard triage loop)
Most handoffs are "a guard misfired" or "add a check." In order:
1. **Verify from code + logs — never assume** (general rule). Reproduce the mechanism against the files on disk and the log evidence. Confirm the **path** (owner vs colleague — they run different gates; e.g. `claimChecker` is owner-only, `availabilityPreCheck`/`securityGate` are colleague-path).
2. **Is it a guard bug or a CODE/DATA bug?** Usually the guard is fine and the *data it reads* is stale/wrong — a tool summary showing the pre-change value, a display-string where an ISO belongs. Fix the **source** so the tool log carries the truth (**R4**); don't patch the guard to guess.
3. **If a guard must change, keep the shape.** Detect freely (LLM, multilingual), but act destructively only on a deterministic trigger OR a tool-less + miss-safe path (**R3**); the failure must be a safe **MISS**, never a corruption (**R7**); **never** re-run the orchestrator, re-fire a tool, persist a wrong value, or write durable data off an LLM verdict (**R3**); when an LLM verdict drives flow, read **structured fields only** (**R3**).
4. **No clone-limiting regex (R8) — the owner will NOT approve language-word regex in code** (Hebrew/English words are clone-limiting). Litmus: "would this work if Maelle spoke French?" Detection → the LLM; deterministic gate → punctuation/digits/IDs only.
5. **Fewest strong guards (R1/R2)** — reuse an existing guard, fix at the root, no patch-on-patch, prefer **upstream / compute-before-draft** over post-hoc police-and-retry. No new guard or file without explicit owner approval.
6. **Economical (R9)** — gate LLM guards behind a cheap language-neutral pre-filter, and watch the **output-path LLM-call count** (it stacks: one reply already runs claim-checker + humanGate + date-verify; don't casually add a 4th).
7. `npm run typecheck`. **Propose-first; the owner gates build / version / commit.** Scope your change to the guard files; cross-chat work → `.claude/PROMPT_FOR_<X>_CHAT.md`.

## The guard stack you own (verify — files move)
- `src/utils/claimChecker.ts` — phantom-action honesty (owner-path). Remedy = a tool-less "own-the-miss" **structured-verdict** rewrite (no orchestrator retry). Shield scans prior turns too (true recaps).
- `src/utils/dateVerifier.ts` — weekday↔date consistency, any language (Haiku extract → deterministic weekday swap). **Backs off on a uniform date-column shift** (don't slide a whole rundown).
- `src/utils/humanGate.ts` — machine-voice / leak (owner + colleague). Rewrite with fact-preservation + one re-rewrite; **never ships the flagged original**; robust JSON parse (never fail-open to a leak).
- `src/utils/securityGate.ts` — colleague-facing leak scrub. Regex triggers (incl. raw Slack / `req_` / `task_` IDs) → bounded rewrite; identity-spoof judge fails safe.
- `src/utils/availabilityPreCheck.ts` — colleague-path: compute rule-aware availability **+ gap size** BEFORE she drafts and inject it (language-neutral gate → Haiku extractor → `findAvailableSlots`/`checkSlot`).
- `src/utils/addresseeGate.ts` (MPIM addressee), `src/utils/imageGuard.ts` (image-injection, log-only).
- Orchestration: `src/connectors/slack/postReply.ts` (the gate stack + the `matchingToolAlreadyRan` shield) and **`summarizeToolCall` in `src/core/orchestrator/index.ts`** — the tool log the checkers read; keep it TRUTHFUL (post-change values, real ISO).
- **`coordGuard.ts` is GONE** (coord subsystem deleted in 3.5.0). Don't resurrect coord assumptions.

## Hard-won lessons (why the rules exist)
- **The guard is usually not the fix.** Nearly every "date bug after thousands of bookings" was a guard mis-reading *correct* data, not the calendar. Make the source truthful (R4): `summarizeToolCall` must carry the POST-change value (`update_meeting` showed the OLD subject → false "not done yet"); booked instants must be real ISO (a display string "05 Jul 21:00:00" made the booked-date check false-correct a correct reply → **that whole check was retired**).
- **A guard correcting the wrong axis is worse than the slip.** dateVerifier rewrote weekdays on a uniform date shift → slid a weekly rundown a day. Now backs off on a uniform shift (safe miss).
- **Rewriters must verify, not trust the verdict.** claimChecker's rewriter negated *true* recaps and once shipped its own reasoning monologue → fixed with a prior-turn shield + a forced-`verdict` structured output.
- **No language words in code (R8).** The owner explicitly won't approve Hebrew/English-word regex — it's clone-limiting. Detection = LLM; gate = structure.
- **Fewer calls.** A single booking reply was running 4 output-path LLM gates; the redundant/flaky one was retired. Watch the count.

## Current state (drifts — verify)
Version ~**3.6.x**. `git status` first — hot, shared, multi-chat tree (meeting / news / prompt / code chats commit constantly). Re-baseline before every edit (line numbers move under you); keep your change as its own logical set; don't entangle.

## Open follow-ups (parked / handed off — verify still relevant)
- **claimChecker fail-open-to-lie** — judged negligible; left as-is.
- **humanGate `am/pm` token** — mildly English but additive-only (never sole detector); leave unless you want it spotless.
- **`claim_checker_rewrite_vetoed` log** — watch its frequency; if the Haiku classifier is vetoed often, flip *it* to Sonnet (R10 said not yet — let data decide).
- **`booked_start` is sometimes a display string, not ISO** — meeting-core data-contract bug; flagged to the meeting chat. Fixing it would let a booked-instant honesty check work again.
