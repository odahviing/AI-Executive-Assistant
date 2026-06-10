# Guards handoff: colleague-facing replies leaked internal/bot/mixed-language content (Hebrew)

You own the gate stack. A colleague-facing coordination (Maelle talking to a colleague, Yael, in Hebrew) leaked internal/bot framing that the gates should have scrubbed. This is a writeup of exactly what happened, what the gates did, and the candidate solutions — **you decide the fix.** Propose-only context; nothing has been changed in the gates.

## What leaked (colleague-facing, Hebrew thread)

- **"הכלי" ("the tool")** — e.g. *"הכלי לא מצא slots"*, *"הכלי מחזיר slots מחוץ לחלון"* ("the tool didn't find slots", "the tool returns slots outside the window"). Maelle naming her own internal tooling to a colleague.
- **English technical words dropped into Hebrew** — "slots", "visibility" inside otherwise-Hebrew sentences.
- **Bot/infrastructure self-framing** — *"אין לי visibility מלאה על שעות הערב של עידן"* = "I don't have full visibility on Idan's evening hours." Maelle (Idan's own assistant) framing herself as lacking system access, to a colleague.

## What the gates actually did (from logs maelle-2026-06-09.log)

The colleague gate stack in `src/connectors/slack/postReply.ts` (~lines 280-323) **is intact** — both gates still run on the colleague path, in order: `securityGate` (Step 4) then `humanGate` (Step 4a, audience `'internal'`). 3.3.5's guard work did NOT remove or reorder them. So this is **not** a "guard was removed" regression. The gates are firing but not catching:

1. **securityGate is English-only and never triggered.** `src/utils/securityGate.ts` `scanForLeaks` (~lines 27-61) is ~11 English regexes (`my tools`, `tool call`, `system prompt`, …). None match "הכלי", "slots", or "visibility", and there is no Hebrew pattern. On a Hebrew reply it returns `{filtered:false}` with zero triggers and **never invokes its (good) Sonnet rewriter.** Confirmed: not a single "Security gate" log line in the whole thread. It has been Hebrew-blind since inception.

2. **humanGate ran every turn but under-rewrote.** It runs on **Haiku** (flipped from Sonnet in a latency pass, `humanGate.ts:~333`). Its prompt explicitly lists "the tool returns" as a fire case and claims to be language-agnostic. Live behavior:
   - On *"הכלי מחזיר slots…"* it flagged ok=false but its "rewrite" only added one connector word (ו) — it **left "הכלי" and "slots" in place** (log :550). A cosmetic no-op.
   - On the *"אין לי visibility…"* line it returned **ok=true** and passed the leak clean (log :572).
   - Separately, the deterministic fact-preservation net (`rewriteDroppedAFact`, humanGate.ts:~278) once discarded a real rewrite because a time token differed and kept the leaky original (log :526).
   - Haiku also intermittently returns prose instead of strict JSON → fail-open → leak passes (log :194).

3. **No language-consistency layer** exists on outbound colleague replies (no `detectMessageLanguage` enforcement), so English technical words ("slots", "visibility") mix into Hebrew freely.

**Most likely behavioral regression:** the humanGate **Sonnet→Haiku flip** — Haiku is materially worse at judging *and* rewriting Hebrew bot-tell than Sonnet was. (Uncertain without an older log showing Sonnet caught the same phrasing — but it's the strongest candidate.)

## Candidate solutions (you decide)

- **(Code) Flip humanGate back to Sonnet for the colleague/internal audience** (`humanGate.ts:~333`: use `claude-sonnet-4-6` when `audience !== 'owner'`). Colleague-facing leaks are higher-stakes than the latency saving. Directly addresses the weak-rewrite.
- **(Code) Make securityGate's Sonnet rewriter reachable on Hebrew.** Its rewriter is good; the bug is the English-only regex pre-filter never lets it run. Option: invoke the rewriter whenever a colleague-facing reply contains non-Latin script (or a known leak-noun), instead of only on an English-regex hit.
- **(Code) Widen securityGate triggers** to a few anchored language-agnostic patterns ("הכלי", "המערכת"). Caution: avoid a growing per-language regex list — the project's standing rule is "no regex on natural language; route to an LLM judge." So prefer the two options above over a Hebrew regex list.
- **(Reliability) humanGate Haiku JSON contract** — add a one-shot strict-JSON retry before fail-open, or fold into the Sonnet flip.
- **(Prompt) humanGate system prompt** — strengthen so that when ok=false the rewrite MUST actually delete the offending words (not return a near-identical string), in any language including Hebrew. Map the self-as-software words to human-EA phrasing:
  - "הכלי" / "the tool" / "המערכת" / "the system" (describing your own lookups) → "בדקתי ביומן של עידן" / "looking at Idan's calendar".
  - "אין לי visibility" / "I don't have visibility" → "אני לא רואה" / "I can't see" — framed as a person, never as system access.
  - Foreign technical words in a Hebrew reply ("slots", "visibility") → Hebrew equivalents ("שעות פנויות" / "אפשרויות"). Match the colleague's language fully; don't code-switch into English for system concepts.

A prompt nudge alone won't fully fix a model-capability gap — pair it with the Sonnet flip (or the securityGate-rewriter-on-Hebrew route).

## Key references
- `src/connectors/slack/postReply.ts` (~280-323) — colleague gate stack (intact).
- `src/utils/securityGate.ts` (~27-61) — English-only `scanForLeaks`; good Sonnet rewriter at ~236-296 never reached on Hebrew.
- `src/utils/humanGate.ts` (~217 fire-cases, ~278 fact-net, ~333 Haiku flip).
- logs `maelle-2026-06-09.log` lines 194, 474, 500, 525, 526, 549, 550, 572.
