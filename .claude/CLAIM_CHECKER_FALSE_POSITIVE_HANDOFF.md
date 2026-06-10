# Guards handoff: claim-checker false-positives corrupt clean proposals (3 real cases, 2026-06-10)

You own the gate stack. The claim-checker (RULE A: phantom-action detection) false-positived **three times in one day** on drafts that were clearly proposals or future commitments — and the 3.3.5 own-the-miss rewrite then CORRUPTED each good draft into a confusing "Actually, hold on, I haven't done that yet" message. The owner filed both incidents as GitHub #124 / #125 ("Maelle wrong in calendar and lying"). Propose-only context for everything except the agreed fix at the bottom — the owner approved the **rewrite-veto** shape; you own the implementation and any further hardening of the classifier itself.

## The three misfires (all in `logs/maelle-2026-06-10.log`)

1. **05:43:16 — a proposal flagged as a phantom booking.** Draft: *"Monday 11:00 is blocked on your side (Michal's BiWeekly is still there). If we move Michal first, that slot opens up. Want me to move Michal to Wed 17 at 12:15 and then put Elinor at Mon 11:00?"* — ends in an explicit ask-before-acting question. Haiku's own verdict text betrays the error: `action_summary: "Draft PROPOSES moving Michal's meeting and booking Elinor, but no booking/move tools ran this turn."` It used the word "proposes" and still set `claimed_action=true`. The rewrite shipped as *"Actually, hold on, I haven't done that yet..."* — the owner read it as Maelle being confused ("ofc Michal is still there! until she is moving", #124).

2. **07:48:17 — an offer flagged as a phantom message.** Draft (apology turn): *"...Want me to reach out to her now and clarify that 13:30 is actually open?"* → `action_summary: "Draft proposes reaching out to Yael... but no message_colleague ran"`. Rewrite injected *"Actually, I haven't reached out to her yet to fix this"* — in the middle of an apology about something else, making the reply incoherent (owner quoted it verbatim in #125 as evidence of "lying").

3. **07:48:56 — a future commitment flagged as a phantom move.** Draft: *"...Which works for you? Once you pick, I'll get that 17:00 moved over."* → flagged `action_type=book`. This is the explicitly-exempt "on it / I'll handle that" form.

## Why the existing defenses didn't hold

- The exemptions EXIST in the classifier prompt and are explicit: [src/utils/claimChecker.ts:225](../src/utils/claimChecker.ts) ("Proposing / offering / recommending a future action — EVEN when it names a specific meeting, time, or person... is claimed_action=false no matter how specific") and :227 ("on it / I'll handle that — in-progress commitments, not completed claims"). **Haiku ignored them three times in one day.** The checker was flipped Sonnet→Haiku in v3.0.6 (latency pass) — same model-tier weakness family as the humanGate findings in `GUARDS_LEAK_HANDOFF.md`.
- The own-the-miss rewriter (`rewriteOwningTheMiss`, claimChecker.ts:390-433, added 3.3.5) **blindly trusts the verdict**: its prompt asserts "The draft claims an action is done... that DID NOT actually happen" as fact and instructs the model to make the non-completion unmistakable. Given a false verdict, it manufactures the "hold on, that didn't go out yet" framing on a draft that never claimed anything. There is no escape hatch.
- History: v3.2.0 fixed this exact class ("claim-checker no longer flags a proposal as a phantom action" — the screenshot-reply degradation) with prompt-only exemptions; v3.3.5 replaced the destructive retry with the tool-less rewrite, which is safer but amplifies surviving classifier false-positives into owner-visible nonsense.

## Agreed fix (owner-approved shape): give the rewriter a VETO

In `rewriteOwningTheMiss` (claimChecker.ts:402-415), change the prompt contract from "rewrite this dishonest draft" to "FIRST verify, THEN rewrite or refuse":

- Instruct the rewriter: *Before rewriting, check the draft yourself. If the draft only PROPOSES, OFFERS, ASKS PERMISSION ("Want me to...?", "Should I...?"), or commits to a FUTURE action conditional on the owner's answer ("once you pick, I'll move it"), it is NOT claiming a completed action — output exactly the single token `UNCHANGED` and nothing else.*
- In the caller, treat an output of `UNCHANGED` (trimmed, case-insensitive) the same as the existing `null` fail-open path: keep the original draft, log a `claim_checker_rewrite_vetoed` line (so we can count how often the classifier is wrong — that data decides whether the classifier itself needs the Sonnet flip).
- Zero new LLM calls — the rewriter already runs only on flagged drafts. Deterministic guard at the chokepoint; shields every future classifier false-positive, not just these phrasings.

Optional hardening you may add on top (your call, same file): two-stage confirm — when Haiku flags `claimed_action=true`, re-ask once on Sonnet before rewriting (cost only on flags, a few per day). The veto alone covers the observed cases; the two-stage covers a hypothetical false-positive that also fools the rewriter.

Use the three drafts above as your test cases — all three must ship UNCHANGED after the fix. A true positive for regression-testing: a draft saying "Done — booked Wed 12:15" with no `create_meeting`/`move_meeting` in tool activity must still get rewritten.

## Key references
- `src/utils/claimChecker.ts` — RULE A prompt :180-254 (exemptions at :225-227), Haiku model pin :273, `rewriteOwningTheMiss` :390-433.
- `src/connectors/slack/postReply.ts` — caller; the `matchingToolAlreadyRan` shield lives there (didn't help here: the tools genuinely didn't run — the drafts just never claimed they had).
- Logs: `maelle-2026-06-10.log` 05:43:16, 07:48:17, 07:48:56 (search "Claim-checker: draft claims an action").
