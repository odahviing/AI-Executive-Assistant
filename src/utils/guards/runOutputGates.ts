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
 * TWO entry points, because a pipeline step legitimately sits between them:
 *   1. runConcisionPassIfNeeded(draft, profile) — runs BEFORE postReply persists
 *      the draft to conversation history, so history stores what the user will
 *      actually see (the clean answer, not the deliberation chain).
 *   2. runOutputGates(draft, ctx) — the whole gate stack, on the already
 *      normalized Slack-mrkdwn draft; returns the text to send.
 *
 * Order inside runOutputGates (unchanged from the in-postReply version):
 *   3/3a/3b  OWNER (or owner-in-group): claim-check + humanGate + date-verify,
 *            probed concurrently, exact serial chain on any flag.
 *   3b       NON-OWNER: date-verify.
 *   3c       NON-OWNER: mutation-contradiction retry.
 *   4/4a     NON-OWNER: security gate, then colleague humanGate.
 * Owner-only concerns (claim-checker) and colleague-only concerns (security
 * gate) are mutually exclusive by role, so there's no stage where both run.
 *
 * Every gate FAILS OPEN: a throw anywhere leaves the draft it was handed.
 */

import { getAnthropicClient } from '../../llm/client';
import { SONNET, MODEL_SONNET } from '../../llm/models';

import type { App } from '@slack/bolt';
import type { UserProfile } from '../../config/userProfile';
import type { ChannelId } from '../../skills/types';
import type { SenderRole } from '../../connectors/slack/postReply';
import { appendToConversation } from '../../db';
import { runOrchestrator, type OrchestratorOutput } from '../../core/orchestrator';
import { formatForSlack } from '../../connections/slack/formatting';
import logger from '../logger';
import { logLlmUsage } from '../usageLog';

/**
 * Everything the gate stack reads. A subset of postReply's PostReplyInput —
 * the delivery-only fields (say / userMessageTs / voiceInput) are deliberately
 * NOT here: a gate must never be able to send.
 */
export interface OutputGateContext {
  app: App;
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
    app, profile, result,
    role, colleagueName,
    senderId, channelId, threadTs,
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

  // Step 3c (v1.8.4) — colleague-path mutation-contradiction check. When a
  // calendar-mutating tool succeeded this turn AND the draft tells the
  // colleague something like "I'll flag it for <owner>" or "he'll decide,"
  // Maelle is contradicting her own action — she did mutate the calendar,
  // she shouldn't defer it back to the owner. Retry once with a nudge so
  // the reply acknowledges the action. Code-only check, no Sonnet call.
  // Addresses the Bug C pattern from issue #26 aftermath (owner saw audit
  // log "Meeting booked" while the colleague was told "flagged for Idan").
  // v3.8.x — fail-closed on role: a non-owner (colleague / future 'unknown')
  // gets the full colleague-strict treatment, not an ungated pass.
  if (role !== 'owner' && !isOwnerInGroup) {
    const toolSummariesText = (result.toolSummaries ?? []).join(' ');
    // v3.7.x (#137b) — require the SUCCESS marker, not just the tool name. The
    // tool log renders `[<tool> OK …]` on success and `[<tool> FAILED: …]` on
    // failure (summarizeToolCall). Matching the bare name treated a FAILED
    // booking as done: Oran's create_meeting FAILED (rule_check_failed) then
    // escalated via create_approval, and the name-only regex fired the retry —
    // inverting the CORRECT "flagged it for Idan" escalation into a false
    // "booking it now". A failed mutation means she did NOT act, so deferring to
    // the owner is honest and must not be rewritten. Same OK-only convention as
    // MUTATION_OK_RE in the orchestrator.
    const mutationSucceeded = /\[(?:move_meeting|create_meeting|update_meeting|delete_meeting) OK\b/i.test(toolSummariesText);
    const ownerFirstName = profile.user.name.split(' ')[0];
    const ownerFnRe = new RegExp(`\\b${ownerFirstName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i');
    const draftDefersToOwner =
      /\bflag(?:ged|ging)?\s+(?:it|this|that)?\s*for\b/i.test(cleanReply) ||
      (/\blet\s+\S+\s+know\b/i.test(cleanReply) && ownerFnRe.test(cleanReply)) ||
      (/\bcheck\s+with\s+\S+/i.test(cleanReply) && ownerFnRe.test(cleanReply)) ||
      /\bhe'?ll\s+(?:likely|probably|need|decide|confirm|jump)/i.test(cleanReply);
    if (mutationSucceeded && draftDefersToOwner) {
      logger.warn('Colleague draft defers to owner after mutation succeeded — retrying', {
        senderId, threadTs,
        toolSummaries: result.toolSummaries,
        draftPreview: cleanReply.slice(0, 160),
      });
      const nudge = `Your previous reply to this colleague said you'd flag / check with ${ownerFirstName}, but a calendar action (move / create / update / delete / book) already SUCCEEDED this turn. Do not defer to ${ownerFirstName} — acknowledge the action to the colleague directly. If the tool returned an action_summary, use it verbatim or paraphrase. Write one short honest sentence that matches what actually happened.`;
      try {
        const retry = await runOrchestrator({
          userMessage,
          conversationHistory: history,
          threadTs,
          channelId,
          userId: senderId,
          senderRole: role as 'owner' | 'colleague',
          senderName: colleagueName,
          channel: 'slack' as ChannelId,
          app,
          profile,
          extraInstruction: nudge,
          // v3.2.1 (#120 bug 1) — this retry exists ONLY to fix the DRAFT TEXT
          // (the "I deferred but actually acted" contradiction). It must NOT
          // re-execute tools: the original turn already ran create_approval /
          // move_meeting, and a full re-run created a SECOND, differently-worded
          // approval that slipped past the subject-string dedup (the Dina
          // double-request). proseOnly strips every write tool (incl.
          // create_approval) so the re-run can only re-narrate what already
          // happened — reads stay available so it can ground the wording.
          proseOnly: true,
          isMpim,
          isOwnerInGroup,
          mpimMemberIds,
        });
        if (retry?.reply) {
          cleanReply = formatForSlack(retry.reply);
          logger.info('Colleague mutation-contradiction retry produced new draft', { previewAfter: cleanReply.slice(0, 160) });
        }
      } catch (err) {
        logger.warn('Colleague mutation-contradiction retry failed — leaving original draft', { err: String(err) });
      }
    }
  }

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
    cleanReply = await runSecurityGate({
      reply: cleanReply,
      colleagueName,
      senderId,
      assistantName: profile.assistant.name,
      ownerFirstName: profile.user.name.split(' ')[0],
      verifiedSenderEmail,
      ownerEmail: profile.user.email,
      recentUserMessages,
    });

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
    const matchingToolAlreadyRan =
      verdict.action_type === 'message'
        // v4.0.x (G1) — require the SUCCESS form `[message_colleague: <name>]`
        // (the colon). A SKIPPED (`[message_colleague] <id> — … skipped`) or FAILED
        // (`[message_colleague FAILED: …]`) summary is NOT a sent message and must
        // not back a "flagged it to X" claim — that shipped a false "already flagged
        // it to Simon" when the relay was dropped (2026-07-23). resolve_approval is
        // also NO LONGER an unconditional backer here: it relays only the DECISION
        // to the requester, not arbitrary content, so it wrongly backed a specific
        // question ("whether it has to be him or Rita") that never went out. A
        // genuine "I told the requester the decision" claim is handled by the
        // claim-checker's own resolve_approval prompt rule (→ claimed_action=false),
        // and if that still flags, rewriteOwningTheMiss's Sonnet veto keeps it — so
        // dropping it here can't corrupt an honest relay. (The old double-DM concern
        // is moot: the tool-firing retry that caused it is gone; the remedy is now a
        // tool-less rewrite.)
        ? (/\[message_colleague:/.test(toolSummariesText) &&
            (!verdict.target_name || toolSummariesText.toLowerCase().includes(verdict.target_name.toLowerCase())))
        : verdict.action_type === 'book'
          // v2.3.4 — `book` covers any calendar mutation, not just
          // create+finalize. The narrower regex let a move_meeting + correct
          // confirmation get retried after a false-positive verdict, and the
          // retry — which doesn't see THIS turn's tool calls in
          // conversationHistory — re-read the calendar and narrated her own
          // move as someone else's ("looks like it was moved at some point
          // during our conversation"). All five mutation tools should
          // satisfy a book-type claim.
          ? /\[(create_meeting|move_meeting|update_meeting|delete_meeting|book_floating_block)/.test(toolSummariesText)
          : verdict.action_type === 'task'
            ? /\[(create_task|create_approval)/.test(toolSummariesText)
            // Extend the false-positive shield to the memory/pref action-verb
            // family. The claim-checker classifies "saved / noted / updated"
            // claims as `other`, and these tools were never in the shield — so
            // a legitimate update_my_preferences save that Sonnet narrated as
            // "Saved" got flagged + retried (a wasted orchestrator turn; only
            // the tool-call cache prevented a double-write). Same trust
            // contract as book/task: the tool literally ran this turn ⇒ the
            // claim is honest. The specifics-mismatch bypass below still fires
            // for genuine over-claims, and an `other` claim with NONE of these
            // tools present still retries (phantom-claim protection intact).
            : verdict.action_type === 'other'
            ? /\[(update_my_preferences|manage_preference|note_about_person|note_about_self|log_interaction|confirm_gender|update_person_profile|update_person_memory|manage_routine|manage_calendar_issue|update_task|update_summary_draft|manage_knowledge|resolve_approval)/.test(toolSummariesText)
            : false;

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
        // Overwrite the history entry with the honest version so the NEXT
        // turn doesn't see the dishonest draft.
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

// ── v2.2.5 — Concision finalizer ─────────────────────────────────────────────
//
// Sonnet sometimes emits a single text block with the entire derivation
// embedded ("wait, that breaks the order", "let me find", "OK definitive clean
// proposal"). The base-prompt anti-deliberation rule asks Sonnet to skip that;
// when she ignores it, this pass catches it. Triggers on either deliberation
// patterns OR length > 600 chars on a non-list reply. Asks Sonnet to rewrite
// keeping only the final answer, capped tight. Falls back to the original on
// any error — never blocks a reply.

const DELIBERATION_RE = /\b(actually wait\b|on second thought\b|let me (?:think|find|check|give|ask|see|try)\b|wait,?\s+(?:that|the|i|let|professional|no)\b|on the other hand\b|on the one hand\b|definitive (?:clean )?proposal\b|hmm,?\s|so the full corrected\b|i need to (?:also )?(?:move|find|give|check)\b|let me give you the clean\b)/i;

function looksLikeAList(text: string): boolean {
  // List-style replies (numbered or bulleted) are legitimate even when long;
  // don't trim them. Detect any of: "1." "2." line starts, several "-" line
  // starts, or several lines starting with a digit.
  const lines = text.split('\n');
  const numberedLineCount = lines.filter(l => /^\s*\d+[.)]\s/.test(l)).length;
  const bulletLineCount = lines.filter(l => /^\s*[-•]\s/.test(l)).length;
  return numberedLineCount >= 2 || bulletLineCount >= 3;
}

// v2.3.1 (B20 + B21) — self-coherence trigger. Counts question marks and the
// kind of "if-then" hedges that indicate Sonnet wrote a question AND answered
// every possible variant. Both are signs of a reply that asks the same thing
// twice or contradicts itself within one breath. Trigger is shape-based; the
// rewrite Sonnet judges whether to actually fix.
function looksSelfIncoherent(text: string): boolean {
  // Two or more "?" (multiple questions in one message — usually duplicates
  // or a question that gets re-asked at the end of the same reply).
  const questionCount = (text.match(/\?/g) || []).length;
  if (questionCount >= 2) return true;
  // Hedge-then-answer pattern: "If X is Y... If X is Z..." in the same reply.
  // Cheap shape detector — if the same topic appears with multiple "if"
  // branches, the reply is fanning out instead of committing.
  const ifBranches = (text.match(/\b[Ii]f\s+(it'?s|that's|the|this|you|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/g) || []).length;
  if (ifBranches >= 2) return true;
  return false;
}

export async function runConcisionPassIfNeeded(rawReply: string, profile: UserProfile): Promise<string> {
  const trim = rawReply.trim();
  if (!trim) return trim;

  const tooLong = trim.length > 600 && !looksLikeAList(trim);
  const hasDeliberation = DELIBERATION_RE.test(trim);
  // v2.3.1 (B20 + B21) — broaden the concision pass to also catch
  // self-contradiction (asks question + answers it in same reply) and
  // duplicate questions. Shape-detected here; Sonnet decides what to do.
  const isIncoherent = looksSelfIncoherent(trim);
  if (!tooLong && !hasDeliberation && !isIncoherent) return trim;

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
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
        content: `You wrote this draft for ${ownerFirst}'s assistant. Rewrite it as ONLY the final user-facing answer. Strip:
- self-correction ("wait,", "actually,", "on second thought", "let me", "OK definitive...")
- planning narration ("I need to find", "let me check", "let me give you the clean")
- intermediate proposals you rejected mid-thought
- references to your reasoning process

v2.3.1 ADDITIONS:
- Self-contradiction: if the draft asks a question AND also answers it ("what date? — That's a Tuesday, so it fits..."), pick ONE. Either ask cleanly and stop, OR commit to the answer and skip the question. Never both.
- Duplicate questions: if the same question is asked more than once in the draft (top + bottom, restated, etc.), keep one — the cleanest version, usually at the end.
- Hedging branches: "If A then X. If B then Y. If C then Z." over the SAME unknown is fanning out instead of committing. Pick the most likely branch and act, OR ask which one and stop. Don't enumerate all of them.

Keep the answer; drop the journey. Stay under 4 short sentences unless the draft is a numbered/bulleted list, in which case keep the list intact and trim only the prose around it. Match the language of the draft (Hebrew/English).

Draft:
${trim}`,
      }],
    });
    logLlmUsage('concision_pass', MODEL_SONNET, resp);
    const tool = resp.content.find((b: { type: string }) => b.type === 'tool_use') as { input?: { final?: string } } | undefined;
    const final = tool?.input?.final;
    if (!final || !final.trim()) return trim;
    const cleaned = final.trim();
    // Safety: if the rewrite is somehow LONGER than the original, the pass
    // didn't help — return original. Same if rewrite is suspiciously short
    // (< 10 chars) which probably means the model truncated.
    if (cleaned.length >= trim.length || cleaned.length < 10) return trim;
    logger.info('Concision pass trimmed deliberation', {
      before: trim.length,
      after: cleaned.length,
      triggered: isIncoherent ? 'incoherent' : (hasDeliberation ? 'pattern' : 'length'),
    });
    return cleaned;
  } catch (err) {
    logger.warn('Concision pass threw — sending original draft', { err: String(err).slice(0, 200) });
    return trim;
  }
}
