/**
 * Output-time gate stack — extracted from connectors/slack/postReply.ts.
 *
 * LANE BOUNDARY. postReply owns the DELIVERY pipeline (history save, mrkdwn
 * normalize, ack-reaction, shadow, audio-vs-text, threading, approval footer).
 * This module owns the GATE POLICY: what each check concludes, in what order
 * the checks run, and what may be done about a verdict (rewrite / retry).
 * The gate primitives themselves stay in their own guard files
 * (utils/claimChecker, utils/humanGate, utils/dateVerifier, utils/securityGate)
 * and are still dynamically imported — a clean reply never loads them twice.
 *
 * THREE entry points, because pipeline steps legitimately sit between them:
 *   1. runDeliberationGuard(draft, profile) — runs BEFORE postReply persists
 *      the draft to conversation history, so history stores what the user will
 *      actually see (the answer, not the deliberation chain).
 *   2. runOutputGates(draft, ctx) — the whole gate stack, on the already
 *      normalized Slack-mrkdwn draft; returns the text to send.
 *   3. runCodaGates(coda, ctx) — the SOCIAL CODA's own, much smaller gate. It is
 *      a separate entry point rather than a mode of (2) because the coda is a
 *      different kind of message (see its own doc comment): it answers nothing,
 *      claims nothing, and its safe failure is SILENCE, not a rewrite. It
 *      therefore returns a ship/drop verdict and cannot alter the text at all.
 *
 * Order inside runOutputGates:
 *   3/3a/3b  OWNER (or owner-in-group): claim-check + humanGate + date-verify,
 *            probed concurrently, exact serial chain on any flag.
 *   3b       NON-OWNER: date-verify.
 *   4/4a     NON-OWNER: security gate, then colleague humanGate.
 * Owner-only concerns (claim-checker) and colleague-only concerns (security
 * gate) are mutually exclusive by role, so there's no stage where both run.
 *
 * NOTHING here re-runs the orchestrator (G4). Every remedy is either a
 * deterministic edit or a single tool-less rewrite pass.
 *
 * Every gate FAILS OPEN: a throw anywhere leaves the draft it was handed.
 */

import { getAnthropicClient } from '../../llm/client';
import { SONNET, MODEL_SONNET } from '../../llm/models';

import type { UserProfile } from '../../config/userProfile';
import type { SenderRole } from '../../connectors/slack/postReply';
import type { HumanGateAudience } from '../humanGate';
import { appendToConversation } from '../../db';
import type { OrchestratorOutput } from '../../core/orchestrator';
import { formatForSlack } from '../../connections/slack/formatting';
import logger from '../logger';
import { logLlmUsage } from '../usageLog';

/**
 * Everything the gate stack reads. A subset of postReply's PostReplyInput —
 * the delivery-only fields (say / userMessageTs / voiceInput) are deliberately
 * NOT here: a gate must never be able to send.
 */
export interface OutputGateContext {
  profile: UserProfile;
  result: OrchestratorOutput;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  userMessage: string;
  senderId: string;
  channelId: string;
  threadTs: string;
  role: SenderRole;
  colleagueName?: string;
  isMpim?: boolean;
  isOwnerInGroup?: boolean;
  mpimMemberIds?: string[];
}

export async function runOutputGates(draft: string, ctx: OutputGateContext): Promise<string> {
  const {
    profile, result,
    role, colleagueName,
    senderId, threadTs,
    history, userMessage, isMpim, isOwnerInGroup, mpimMemberIds,
  } = ctx;
  let cleanReply = draft;

  // Steps 3 / 3a / 3b — owner-facing guard stack: claim-check + humanGate +
  // date-verify. v4.0.x PROBE/parallelize: these three are side-effect-free cores
  // (the rewrite + appendToConversation live in the wrappers below,
  // not the cores), and a rewrite is RARE. Run all three CONCURRENTLY on the
  // post-concision text; if NONE wants a change (>95% of turns) ship as-is —
  // byte- AND side-effect-identical to the serial chain, which on a clean turn
  // also rewrites nothing and appends nothing. If ANY flags, fall back to the
  // untouched serial chain → byte-identical to the pre-4.0 behavior (the probe's
  // Haiku calls are wasted on that rare turn). Fail-safe: a probe error falls
  // through to serial. Collapses 3 serial round-trips → 1 wall-clock on the
  // common path. NO coverage change — every guard still runs.
  if (role === 'owner' || isOwnerInGroup) {
    let ownerGuardsClean = false;
    try {
      const [{ checkReplyClaims }, { runHumanGate }, { verifyDates }] = await Promise.all([
        import('../claimChecker'),
        import('../humanGate'),
        import('../dateVerifier'),
      ]);
      const [claimV, humanV, dateV] = await Promise.all([
        checkReplyClaims({
          reply: cleanReply,
          toolSummaries: result.toolSummaries ?? [],
          bookingOccurred: result.bookingOccurred ?? false,
          ownerFirstName: profile.user.name.split(' ')[0],
          mpimContext: isMpim ? { isMpim: true, participantSlackIds: mpimMemberIds ?? [] } : undefined,
        }),
        runHumanGate(cleanReply, profile, 'owner'),
        verifyDates(cleanReply, profile, userMessage),
      ]);
      // Each flag mirrors EXACTLY its wrapper's "would this rewrite the text?"
      // condition, so "none flags" ⇒ the serial chain would have rewritten nothing.
      const claimFlags = claimV.claimed_action === true;
      const humanFlags = !humanV.ok && !!humanV.rewrite && humanV.rewrite.trim().length > 0;
      const dateFlags = !dateV.ok && dateV.mismatches.length > 0;
      ownerGuardsClean = !claimFlags && !humanFlags && !dateFlags;
    } catch (err) {
      logger.warn('Owner-guard probe threw — falling back to the serial chain', { err: String(err).slice(0, 200) });
    }

    if (!ownerGuardsClean) {
      // SERIAL FALLBACK — the exact pre-4.0 chain (claim → humanGate → date),
      // byte-identical on a flag turn. The wrappers own the rewrite + history append.
      cleanReply = await runClaimCheckAndMaybeRewrite(ctx, cleanReply);
      try {
        const { runHumanGate } = await import('../humanGate');
        const verdict = await runHumanGate(cleanReply, profile, 'owner');
        if (!verdict.ok && verdict.rewrite && verdict.rewrite.trim().length > 0) {
          cleanReply = formatForSlack(verdict.rewrite);
        }
      } catch (err) {
        logger.warn('humanGate threw — leaving draft unchanged', { err: String(err).slice(0, 200) });
      }
      cleanReply = await runDateVerifierAndMaybeRetry(ctx, cleanReply);
    }
  } else {
    // Step 3b — date-verifier for the NON-owner path (the owner's date-verify is
    // handled in the probe/serial above, so it runs exactly once either way).
    // Catches "Thursday 11 June" when the 11th is a Wednesday, in any language —
    // a wrong date to a colleague is just as bad.
    cleanReply = await runDateVerifierAndMaybeRetry(ctx, cleanReply);
  }

  // (v3.6.x — the "booked-date honesty" backstop that used to run here was
  // RETIRED. It was a 4th output-path LLM call on every booking reply, it
  // depended on a clean ISO instant it didn't reliably get (booked_start
  // sometimes arrives as a display string → a false correction of a correct
  // reply, 2026-07-05), and its job — the wrong-day WRITE — is already stopped
  // upstream by the meeting-core weekday guard. Backstop with a bad data source
  // + zero real catches + one false alarm = not worth the call. R1 / R9.)

  // (v4.1.x — the v1.8.4 colleague "mutation-contradiction" step that used to run
  // here is RETIRED, and it is the clearest G4 violation the stack had: its remedy
  // was `runOrchestrator(...)`, a SECOND full agentic turn on the reply path, to
  // reword a draft. G4 names re-running the orchestrator as never allowed — an
  // unbounded regeneration can differ from the vetted draft in any way, and it
  // cost seconds of latency plus a whole turn's tokens on the colleague path.
  // Its trigger was also English-only natural-language regex ("flagged it for",
  // "he'll decide") — G7-banned, and useless in Hebrew or Russian. And it never
  // caught anything: ZERO `Colleague draft defers to owner after mutation
  // succeeded` warns across every log on disk.
  //
  // The job it was doing is owned UPSTREAM, where it belongs (G1/G3): the mutation
  // tools return their own `action_summary` / `_must_reply_with` for the drafting
  // turn to narrate (skills/outreach.ts:348, :496) and the pinned action tape
  // replays confirmed mutations into the system prompt (turnHelpers.ts
  // extractActionTape). A draft that contradicts a mutation is a DRAFTING bug, so
  // it gets fixed where the draft is made, not policed afterwards.)

  // Step 4 — colleague-facing security gate (leak filter + identity-spoof).
  // v3.8.x — fail-closed on role: any non-owner (colleague, or a future 'unknown'
  // sender role) runs the strict leak gate. getSenderRole only returns owner|
  // colleague today so this is zero behavior change now, but it stops a future
  // 'unknown' path from shipping ungated (SenderRole allows 'unknown').
  if (role !== 'owner' && !isOwnerInGroup) {
    // v3.0.5 — pull verified colleague email from people_memory (written at
    // message-arrival in app.ts via users.info → upsertPersonMemory). Extract
    // the last few user-role turns from history for the spoof scan. Both feed
    // the new identity check inside filterColleagueReply.
    const { getPersonMemory } = await import('../../db');
    const verifiedSenderEmail = getPersonMemory(senderId)?.email ?? undefined;
    const recentUserMessages = history
      .filter(h => h.role === 'user')
      .slice(-5)
      .map(h => h.content);
    // v4.1.x — normalize the gate's output like every OTHER rewrite path in this
    // file does. This was the one rewrite that shipped raw: securityGate's Sonnet
    // rewriter and its Haiku identity-refusal composer both emit free text, and it
    // went straight to Slack without formatForSlack — so the scrubber never saw it.
    // The em-dash AI-tell in the 2026-07-21 rewrite (log :838) is exactly that, and
    // any raw id or tool name the rewriter emitted would have shipped unscrubbed
    // too. Running it through formatForSlack also makes textScrubber the LAST word
    // on the slack-id token on this path: whatever the rewriter did with an id, the
    // scrubber re-wraps it into a rendered mention.
    cleanReply = formatForSlack(await runSecurityGate({
      reply: cleanReply,
      colleagueName,
      senderId,
      assistantName: profile.assistant.name,
      ownerFirstName: profile.user.name.split(' ')[0],
      verifiedSenderEmail,
      ownerEmail: profile.user.email,
      recentUserMessages,
    }));

    // Step 4a (v2.6.5) — colleague-facing humanness gate. Same Sonnet-pass
    // gate that runs on owner-path (Step 3a above), now also on colleague-
    // path. Catches Maelle framing herself as having technical infrastructure
    // ("I have a technical issue preventing me", "my system can't process this"),
    // including the abdication shape ("you can send the invite directly")
    // worded as machine-state. Owner direction (2026-05-10): "it's ok if
    // Maelle gives up and comes to me — I rather that than nonsense — just
    // don't write it as bot." Honest escalation in human voice is fine; the
    // gate's prompt explicitly allows it. Fails open.
    try {
      const { runHumanGate } = await import('../humanGate');
      // v2.9 — Slack-side colleagues are same-domain by definition (workspace
      // membership). audience='internal'. When EmailConnection lands, its
      // sendReply path will pass 'external' for off-domain recipients.
      const verdict = await runHumanGate(cleanReply, profile, 'internal');
      if (!verdict.ok && verdict.rewrite && verdict.rewrite.trim().length > 0) {
        cleanReply = formatForSlack(verdict.rewrite);
      }
    } catch (err) {
      logger.warn('humanGate (colleague-path) threw — leaving draft unchanged', { err: String(err).slice(0, 200) });
    }
  }

  return cleanReply;
}

// ── Social-coda gate ────────────────────────────────────────────────────────

export interface CodaGateVerdict {
  /** True = post the coda EXACTLY as handed in. False = post nothing. */
  ship: boolean;
  /** Which check dropped it (for the caller's log). Null when ship=true. */
  droppedBy: string | null;
}

/**
 * The social coda's gate. Deliberately NOT `runOutputGates`.
 *
 * The coda is a one-line human aside Maelle posts on her OWN initiative, in its
 * own message, a beat after the reply already landed (postReply's
 * scheduleSocialCoda). It answers no question, states no date, claims no action
 * and carries none of the turn's tool activity — so most of the reply stack has
 * nothing to check, and several of its gates are actively HOSTILE to it:
 *
 *  - the claim-checker's remedy is rewriteOwningTheMiss, which on a false
 *    positive turns a social question into an apology about work;
 *  - securityGate's identity-spoof branch triggers off `recentUserMessages`, NOT
 *    the draft, so it would hand the SAME refusal to the person twice;
 *  - and the claim/date wrappers both appendToConversation, which would push a
 *    second assistant row for a turn history already recorded.
 *
 * What DOES apply is the pair of checks that judge the text itself. Both run in
 * DETECT-ONLY form: this function's return type carries no text, so it is
 * structurally incapable of corrupting a correct coda (G6). The only action is
 * DROP, and dropping a social aside costs nothing — that asymmetry is what makes
 * an LLM verdict safe to act on here (G4: tool-less + miss-safe).
 *
 *  1. scanForLeaks — the HARD-IDENTIFIER half: raw Slack ids, req_/task_ ids,
 *     provider tokens, JSON / tool-tag echoes. Those patterns are structured and
 *     language-neutral (G7); the handful of English self-AI-claim patterns in the
 *     same list are a bonus, not the coverage (a Hebrew "אני בוט" passes it — see
 *     2). Free, so it runs first and a hit costs no LLM call. It is NOT redundant
 *     with the coda's inputs being "just a topic label": those labels and topic
 *     beats are free text Haiku derived from the DM transcript (social_subjects /
 *     social_topics), and that transcript includes the PRE-gate draft plus the raw
 *     `[tool …]` markers (postReply Step 1b) — so a structured internal id CAN
 *     reach the generator's prompt, and this is the check that stops it leaving.
 *  2. runHumanGate — the VOICE half, and the language-agnostic one, in the coda's
 *     audience frame ('owner' vs 'internal'). Kept because the coda is the ONE
 *     message Maelle sends unprompted, most often to a COLLEAGUE (5 of the 6
 *     codas in the 2026-07-20..25 logs), and its generator's only defence against
 *     a bot-tell or a third-person-owner slip is a line in its own prompt — which
 *     is not enforcement. Its `rewrite` is read for nothing; ok=false means DROP.
 *
 * Fails CLOSED (drop) — the inverse of the reply gates' fail-open contract, and
 * right for the same reason: a reply must always land, a social aside never has
 * to. Nothing here can throw into the caller.
 */
export async function runCodaGates(
  coda: string,
  ctx: { profile: UserProfile; role: SenderRole },
): Promise<CodaGateVerdict> {
  const text = coda.trim();
  if (text.length === 0) return { ship: false, droppedBy: 'empty' };

  try {
    const { scanForLeaks } = await import('../securityGate');
    const leaks = scanForLeaks(text);
    if (leaks.length > 0) return { ship: false, droppedBy: `leak:${leaks.join(',')}` };
  } catch (err) {
    logger.warn('Coda gate — leak scan unavailable; dropping the coda (fail closed)', {
      err: String(err).slice(0, 200),
    });
    return { ship: false, droppedBy: 'leak_scan_threw' };
  }

  try {
    const { runHumanGate } = await import('../humanGate');
    // Fail-closed on role, same convention as the reply stack: anything that is
    // not the authenticated owner gets the colleague-strict frame.
    const audience: HumanGateAudience = ctx.role === 'owner' ? 'owner' : 'internal';
    const verdict = await runHumanGate(text, ctx.profile, audience);
    // verdict.rewrite is deliberately IGNORED. A fact-preserving rewrite is the
    // right remedy for a reply that must land; for an optional social line the
    // rewrite is pure downside — it can only produce a stranger second message
    // (humanGate's own safeFallback would post "Let me look into this and come
    // back to you" as a standalone aside, 10s after the work was already done).
    if (!verdict.ok) return { ship: false, droppedBy: 'human_gate' };
  } catch (err) {
    logger.warn('Coda gate — voice check unavailable; dropping the coda (fail closed)', {
      err: String(err).slice(0, 200),
    });
    return { ship: false, droppedBy: 'human_gate_threw' };
  }

  return { ship: true, droppedBy: null };
}

// ── Internal gates ──────────────────────────────────────────────────────────

/**
 * v1.6.2 — replaces the old reply verifier. Strict JSON classifier detects
 * false action claims. v3.4 — on detection, the remedy is a single TOOL-LESS
 * rewrite that makes the draft honestly own the un-done action (see
 * rewriteOwningTheMiss). The old orchestrator re-run + force-message_colleague
 * path is GONE: it auto-fired tools on a possibly-wrong verdict (the Amazia
 * duplicate-send) and forced the matchingToolAlreadyRan shield to keep growing.
 * No tool can fire from here now, so a false claim can never become a
 * duplicate action — only an honest "that didn't go through yet".
 *
 * Fails open: verifier errors, JSON parse errors, rewrite errors — all leave
 * the original draft in place. Never blocks a reply.
 */
async function runClaimCheckAndMaybeRewrite(ctx: OutputGateContext, initialReply: string): Promise<string> {
  const { profile, result } = ctx;
  let cleanReply = initialReply;

  try {
    const { checkReplyClaims } = await import('../claimChecker');

    // v3.0.6 — claim-checker is owner-path RULE A only (false action claim).
    // Module F + E extended-rule inputs (priorAssistantReply, currentUserMessage,
    // imagesInTurn) were removed in the latency pass; honesty rules 1/2/2b/2c/2d
    // /3/5b/9 stay in the system prompt per v2.8.5.
    const verdict = await checkReplyClaims({
      reply: cleanReply,
      toolSummaries: result.toolSummaries ?? [],
      bookingOccurred: result.bookingOccurred ?? false,
      ownerFirstName: profile.user.name.split(' ')[0],
      // v1.7.5 — pass MPIM context so the checker recognizes legitimate
      // in-room @-mentions vs phantom sends to outsiders.
      mpimContext: ctx.isMpim
        ? { isMpim: true, participantSlackIds: ctx.mpimMemberIds ?? [] }
        : undefined,
    });

    // v3.0.6 — Module F + E booleans were fully removed from the checker
    // (advisory-only since v2.8.5; cost ~5s of Sonnet on every owner turn for
    // a verdict no caller acted on). Honesty rules 1/2/2b/2c/2d/3/5b/9 stay
    // in the system prompt. Only RULE A (claimed_action — false action claim)
    // drives retries from here.
    if (!verdict.claimed_action) return cleanReply;

    // v1.7.4 — defense in depth. The claim-checker can false-positive (saw
    // it happen with "the message is on its way" being flagged even when
    // message_colleague ran). If the matching tool clearly DID run this turn,
    // the claim was honest — skip. v3.4: this shield no longer guards a
    // tool-re-firing retry (that's gone); it now prevents the own-the-miss
    // rewrite from corrupting an HONEST reply into a false "that didn't go
    // through" claim when the action actually DID happen.
    // v3.4.x (#recap, 2026-06-24) — the shield must see PRIOR turns, not just
    // this one. A TRUTHFUL recap of an action done last turn ("Yael moved to
    // 11:30 ✓") has no CURRENT-turn tool, so a current-turn-only check flagged
    // it and own-the-miss NEGATED a true statement (the crash-recovery recap).
    // Step 1b saves each turn's `[tool OK ...]` markers into the assistant's
    // conversation content, so the matching tool's marker is in ctx.history —
    // scan it too. Over-suppressing a genuinely-phantom claim in a thread where
    // a similar tool ran earlier is a safe MISS (R7); denying real work is not.
    const priorAssistantText = (ctx.history ?? [])
      .filter(h => h.role === 'assistant')
      .map(h => h.content)
      .join(' ');
    const toolSummariesText = [(result.toolSummaries ?? []).join(' '), priorAssistantText].join(' ');

    // v4.1.x (G2/G3) — READ the carried marker; do not re-derive it.
    //
    // This used to be four action_type branches over a 5-tool, a 2-tool and a
    // 14-tool name alternation, each one added after a distinct incident, and each
    // new mutating tool anywhere in the codebase had to be remembered here or the
    // guard would manufacture a false phantom-action flag. That is the exact
    // maintenance shape G2 exists to prevent, and it was the guard GUESSING at a
    // fact the tool layer already knew.
    //
    // summarizeToolCall now stamps `mutated=<domain>` on every call that actually
    // changed state, using the claim-checker's own action_type vocabulary — so the
    // shield is one field lookup and knows nothing about tool names. The marker is
    // OK-only by construction, which also closes a hole the name-matching had: the
    // old `book`/`task` alternations matched the tool-name PREFIX and so suppressed
    // the honesty rewrite even on `[create_meeting FAILED: …]`. A failed mutation
    // now correctly backs nothing (the same #137b convention the rest of the tool
    // log already follows).
    const mutationCarried = !!verdict.action_type
      && toolSummariesText.includes(`mutated=${verdict.action_type}`);

    // The one class where WHO matters: a DM sent to Yael does not make "already
    // flagged it to Simon" honest. The recipient is already in the summary
    // (`[message_colleague: <name>]`), so this reads existing data — it is not a
    // second list. A SKIPPED relay (`[message_colleague] <id> — … skipped`, pushed
    // straight to the tape by the orchestrator's idempotency guards) never carries
    // the marker, so it can no longer back a "sent it" claim either.
    const targetMatches = verdict.action_type !== 'message'
      || !verdict.target_name
      || toolSummariesText.toLowerCase().includes(verdict.target_name.toLowerCase());

    const matchingToolAlreadyRan = mutationCarried && targetMatches;

    // v2.6.1 — when the claim-checker LLM has named a SPECIFIC change the
    // tool that ran doesn't cover (e.g. "updated to 25 min" claim while only
    // `move_meeting` ran — start changed, duration didn't), bypass the
    // false-positive shield. The shield's coarse "any matching tool ran =
    // honest" was masking real specifics-mismatch claims (warn observed
    // 2026-05-06, draft said "updated to 25 min" with only [move_meeting OK]
    // in tool activity). When the LLM has explicitly identified the field
    // mismatch, trust the verdict — let the retry fire. Retry already carries
    // this turn's tool summaries (v2.3.4) so no duplicate-mutation risk.
    if (matchingToolAlreadyRan && !verdict.claim_specifics_mismatch) {
      // v3.8.x — accurate reason: matchingToolAlreadyRan scans THIS turn's
      // summaries AND prior-turn markers (the #recap shield). When NO tool ran
      // this turn, the match came from a prior turn — a truthful recap of an
      // earlier action (e.g. an active-mode auto-fix), NOT something that "ran
      // this turn". Say which, so the log doesn't contradict an empty tape.
      const viaPriorRecap = (result.toolSummaries ?? []).length === 0;
      logger.warn(viaPriorRecap
        ? 'Claim-checker flagged but a matching tool ran in a PRIOR turn (truthful recap) — skipping rewrite (false positive)'
        : 'Claim-checker flagged but matching tool already ran this turn — skipping rewrite (false positive)', {
        senderId: ctx.senderId,
        threadTs: ctx.threadTs,
        action_type: verdict.action_type,
        target_name: verdict.target_name,
        toolSummaries: result.toolSummaries,
        viaPriorRecap,
      });
      return cleanReply;
    }
    if (matchingToolAlreadyRan && verdict.claim_specifics_mismatch) {
      logger.warn('Claim-checker shield bypassed — specifics mismatch identified, rewrite will fire', {
        senderId: ctx.senderId,
        threadTs: ctx.threadTs,
        action_type: verdict.action_type,
        target_name: verdict.target_name,
        action_summary: verdict.action_summary,
        toolSummaries: result.toolSummaries,
      });
    }

    // v3.4 — confirmed false claim. DO NOT re-run the orchestrator or re-fire
    // a tool. The old retry (with forceToolOnFirstTurn=message_colleague)
    // auto-sent on a possibly-wrong verdict and caused the Amazia duplicate
    // DM — the whole reason the matchingToolAlreadyRan shield had to keep
    // growing. Instead, a single TOOL-LESS rewrite re-renders the prose so it
    // HONESTLY owns the miss and makes the non-completion visible to the
    // owner (so he can nudge). Tool-less ⇒ it can never duplicate an action.
    // Fails open: rewrite null/empty → keep the original draft.
    logger.warn('Claim-checker: false claim — rewriting to own the miss (no tool re-fire)', {
      senderId: ctx.senderId,
      threadTs: ctx.threadTs,
      action_type: verdict.action_type,
      target_name: verdict.target_name,
      action_summary: verdict.action_summary,
    });

    try {
      const { rewriteOwningTheMiss } = await import('../claimChecker');
      const rewritten = await rewriteOwningTheMiss({
        draft: cleanReply,
        actionSummary: verdict.action_summary,
        actionType: verdict.action_type,
        targetName: verdict.target_name,
        ownerFirstName: profile.user.name.split(' ')[0],
        // v3.7.x (#B2) — the rewriter must verify against the same tool activity
        // the checker read, so it can't invert a true completed action it can't see.
        toolSummaries: result.toolSummaries ?? [],
      });
      if (rewritten && rewritten.trim().length > 0) {
        cleanReply = formatForSlack(rewritten);
        // Record the honest version so the NEXT turn doesn't act on the
        // dishonest draft. Note this APPENDS (db/conversations.ts:26 pushes onto
        // the context blob) — it does not replace Step 1b's entry, so the turn
        // shows twice in history, with the honest line last. Acceptable on this
        // rare path: last-write-wins is what the next turn reads.
        appendToConversation(ctx.threadTs, ctx.channelId, { role: 'assistant', content: cleanReply });
      }
    } catch (rwErr) {
      logger.warn('Claim-checker rewrite errored — keeping original draft', { err: String(rwErr) });
    }
  } catch (err) {
    logger.warn('Claim-checker threw — sending original reply', { err: String(err) });
  }
  return cleanReply;
}

/**
 * v1.6.2 — security gate (colleague path only). Rewrites drafts that tripped
 * leak patterns. Full original/sent/triggers detail goes to WARN logs — never
 * to Slack (used to go through shadowNotify, which dumped it into the owner's
 * active thread).
 */
async function runSecurityGate(opts: {
  reply: string;
  colleagueName?: string;
  senderId: string;
  assistantName: string;
  ownerFirstName: string;
  // v3.0.5 — identity-spoof inputs (all optional; when absent, only leak
  // filter runs). See detectClaimedEmail + judgeIdentityClaim in securityGate.ts.
  verifiedSenderEmail?: string;
  ownerEmail?: string;
  recentUserMessages?: string[];
}): Promise<string> {
  const { filterColleagueReply } = await import('../securityGate');
  const gateResult = await filterColleagueReply({
    reply: opts.reply,
    colleagueName: opts.colleagueName,
    colleagueSlackId: opts.senderId,
    assistantName: opts.assistantName,
    ownerFirstName: opts.ownerFirstName,
    verifiedSenderEmail: opts.verifiedSenderEmail,
    ownerEmail: opts.ownerEmail,
    recentUserMessages: opts.recentUserMessages,
  });
  if (gateResult.filtered) {
    logger.warn('⚠ Security gate rewrote colleague reply', {
      senderId: opts.senderId,
      senderName: opts.colleagueName,
      triggers: gateResult.triggers,
      original: opts.reply.slice(0, 500),
      sent: gateResult.reply.slice(0, 500),
    });
  }
  return gateResult.reply;
}

// ── Date verifier + retry (v1.6.6) ─────────────────────────────────────────

/**
 * v3.4 (Option C) — verify weekday/date pairs in ANY language. verifyDates runs
 * a gated Haiku EXTRACTOR (reads the literal weekday+date pairs, never guesses a
 * date), then CODE judges each against the 14-day lookup. A mismatch is fixed by
 * a DETERMINISTIC literal swap of the wrong weekday word inside the exact matched
 * span — a no-op unless the lookup disagrees AND the span is literally present,
 * so it cannot corrupt a correct draft.
 *
 * Runs for BOTH owner and colleague paths — a date-wrong DM to a colleague
 * creates the same trust problem as one to the owner.
 *
 * Fails OPEN: extractor / parse errors or anything → return the original draft.
 */
async function runDateVerifierAndMaybeRetry(ctx: OutputGateContext, initialReply: string): Promise<string> {
  const { profile, userMessage } = ctx;
  let cleanReply = initialReply;

  try {
    const { verifyDates } = await import('../dateVerifier');
    const verdict = await verifyDates(cleanReply, profile, userMessage);
    if (verdict.ok || verdict.mismatches.length === 0) return cleanReply;

    logger.warn('Date verifier: draft has wrong weekday/date pairs — correcting deterministically', {
      senderId: ctx.senderId,
      threadTs: ctx.threadTs,
      mismatches: verdict.mismatches,
    });

    // v3.4 — correct with a DETERMINISTIC weekday-token swap only. The old
    // LLM rewrite (rewriteWithCorrectDates) was removed: its riskiest edit —
    // reflowing events under a corrected day header — was never verified, so
    // it could strand an event under the wrong day (exactly the corruption the
    // date detector exists to prevent). The swap only replaces the wrong
    // weekday WORD against the authoritative lookup; it never touches event
    // content, so it cannot corrupt. The detector already guarantees every
    // mismatch is real (lookup-backed), so the swap is always safe to apply.
    for (const mm of verdict.mismatches) {
      // Swap the weekday word INSIDE the exact span the detector matched, then
      // replace that literal span in the draft. Using the matched span (not a
      // reconstructed \b regex) is language-agnostic: it fixes Hebrew
      // ("יום ראשון 19 באפריל" → "יום שני 19 באפריל") and English alike, where
      // \b word-boundaries silently fail to match around non-ASCII letters. The
      // weekday token sits at the start of the span in both detector patterns,
      // and the span carries its own date so the replace can't mis-target.
      // split/join (not .replace) so a span carrying the weekday twice
      // ("Thursday — yes, Thursday the 11th") gets BOTH corrected, not just the
      // first. .replace(string) swaps only the first occurrence and would ship
      // a wrong weekday in the same span while the guard reports success.
      const corrected = mm.matchedText.split(mm.writtenWeekday).join(mm.correctWeekday);
      if (corrected !== mm.matchedText && cleanReply.includes(mm.matchedText)) {
        cleanReply = cleanReply.split(mm.matchedText).join(corrected);
      }
    }
    appendToConversation(ctx.threadTs, ctx.channelId, { role: 'assistant', content: cleanReply });
  } catch (err) {
    logger.warn('Date verifier threw — sending original reply', { err: String(err) });
  }
  return cleanReply;
}

// ── Deliberation guard (was the v2.2.5 "concision finalizer") ────────────────
//
// v4.1.x (G1) — this pass was NOT a backstop, it was a routine second drafting
// stage sitting on the critical path of every reply, and it was rewriting correct
// answers into shorter ones. It fired on three shape heuristics — ≥2 question
// marks, ≥2 English "if" branches, or >600 chars of non-list prose — sent the whole
// reply to Sonnet with "stay under 4 short sentences", and had NO fact check at
// all: the only safety net was "is the result shorter". Because it runs before
// postReply persists history, the trimmed version was also what history kept, so
// the fuller answer could not be recovered on the next turn. In the 07-19→07-23
// logs it fired 14 times, and only 2 of those were the deliberation case; the rest
// were length/shape — including a 193-char reply cut to 109 and a 983-char one cut
// to 157. G1: reply length is DRAFTING behavior and belongs to whatever writes the
// draft (prompt / orchestrator output policy), not to a guard.
//
// What survives is the one genuine output-time concern: Sonnet emitting her
// derivation into the user-facing text ("wait, that breaks the order", "let me
// find", "OK definitive clean proposal"). That is a REASONING LEAK — the same
// family as G5 — and the reader should never see it. So:
//   - the length and self-coherence triggers are GONE (with their helpers),
//   - the prompt no longer asks for compression, only for the journey to be cut,
//   - and a wrong fire is now a safe MISS: the rewrite must survive the same
//     fact-preservation veto humanGate uses (rewriteDroppedAFact), so a dropped
//     @mention / time / date / question throws the rewrite away and ships the
//     original. Worst case the reader sees a bit of deliberation — never a
//     deleted fact.
//
// Still fails open on any error, and still never blocks a reply.

const DELIBERATION_RE = /\b(actually wait\b|on second thought\b|let me (?:think|find|check|give|ask|see|try)\b|wait,?\s+(?:that|the|i|let|professional|no)\b|on the other hand\b|on the one hand\b|definitive (?:clean )?proposal\b|hmm,?\s|so the full corrected\b|i need to (?:also )?(?:move|find|give|check)\b|let me give you the clean\b)/i;

export async function runDeliberationGuard(rawReply: string, profile: UserProfile): Promise<string> {
  const trim = rawReply.trim();
  if (!trim) return trim;
  if (!DELIBERATION_RE.test(trim)) return trim;

  try {
    const anthropic = getAnthropicClient();
    const ownerFirst = profile.user.name.split(' ')[0];
    const resp = await anthropic.messages.create({
      ...SONNET,
      max_tokens: 400,
      tools: [{
        name: 'rewrite',
        description: 'Output the cleaned final reply for the user.',
        input_schema: {
          type: 'object' as const,
          properties: { final: { type: 'string' } },
          required: ['final'],
        },
      }],
      tool_choice: { type: 'tool', name: 'rewrite' },
      messages: [{
        role: 'user',
        content: `You wrote this draft for ${ownerFirst}'s assistant. It leaked your own thinking-out-loud into the text the reader will see. Output the SAME reply with only that narration removed. Strip:
- self-correction ("wait,", "actually,", "on second thought", "OK definitive...")
- planning narration ("I need to find", "let me check", "let me give you the clean")
- references to your own reasoning process, and the order you worked things out in

This is NOT an edit for brevity. Do not shorten, summarize, compress or tidy anything else. Every fact the draft states must still be there afterwards: every time, date, name, @mention, number and list item, and every question it asks. If the draft asks the reader something, your output asks the same thing.

That includes options you talked yourself out of mid-draft: keep the INFORMATION, drop the deliberation. "I could do 11:00 — wait, that clashes with the standup. 12:30 is clean." becomes "11:00 clashes with the standup, but 12:30 is clean." — not "12:30 is clean.". The reader still needs to know 11:00 was considered and why it's out.

If removing the narration changes nothing, return the draft unchanged.

Match the language of the draft.

Draft:
${trim}`,
      }],
    });
    logLlmUsage('deliberation_guard', MODEL_SONNET, resp);
    const tool = resp.content.find((b: { type: string }) => b.type === 'tool_use') as { input?: { final?: string } } | undefined;
    const final = tool?.input?.final;
    if (!final || !final.trim()) return trim;
    const cleaned = final.trim();
    // Removing narration can only make the text shorter; a longer or near-empty
    // result means the model did something else. Keep the original.
    if (cleaned.length >= trim.length || cleaned.length < 10) return trim;
    // G6 — the veto that makes a wrong fire a safe MISS. Same deterministic,
    // free, narrow check humanGate applies to ITS rewrites: an @mention, clock
    // time, numeric date or question that the original carried and the rewrite
    // does not means content was deleted, not narration. Ship the original.
    // Imported lazily like every other guard primitive in this file — a clean
    // reply never loads humanGate at all.
    const { rewriteDroppedAFact } = await import('../humanGate');
    if (rewriteDroppedAFact(trim, cleaned)) {
      logger.warn('Deliberation guard — rewrite dropped a load-bearing fact; shipping the original draft', {
        before: trim.length,
        after: cleaned.length,
        originalPreview: trim.slice(0, 160),
        rewritePreview: cleaned.slice(0, 160),
      });
      return trim;
    }
    logger.info('Deliberation guard stripped reasoning narration', {
      before: trim.length,
      after: cleaned.length,
    });
    return cleaned;
  } catch (err) {
    logger.warn('Deliberation guard threw — sending original draft', { err: String(err).slice(0, 200) });
    return trim;
  }
}
