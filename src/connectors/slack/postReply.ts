import { getAnthropicClient } from '../../llm/client';
/**
 * Reply pipeline (v1.6.2 split from app.ts).
 *
 * The stage between "runOrchestrator returned a draft" and "a message lands in
 * Slack". Lives in its own file so changes to the pipeline (claim-checker,
 * security gate, audio branch) don't force re-reading a 1200-line app.ts.
 *
 * Steps, in order:
 *   1. Save the raw draft to conversation history (so Claude's next turn sees
 *      what she did).
 *   2. Normalize markdown artefacts (** → *, etc) for Slack rendering.
 *   3. OWNER PATH: run the claim-checker. On a false-claim verdict, a single
 *      tool-less rewrite makes the draft honestly surface that the action
 *      hasn't gone through (v3.3.5 — no orchestrator re-invoke, no forced
 *      tool; a guard can no longer fire a tool, so a false claim can't become
 *      a duplicate action).
 *   4. COLLEAGUE PATH: run the security gate. Rewrites leaking drafts, logs
 *      details to WARN only (never to Slack).
 *   5. Audio vs text branch based on the input modality + TTS availability.
 *   6. Optional approval footer when the orchestrator flagged a pending ask.
 *
 * Owner-only concerns (claim-checker) and colleague-only concerns (security
 * gate) are mutually exclusive by role, so there's no stage where both run.
 */

import type { App } from '@slack/bolt';
import type { UserProfile } from '../../config/userProfile';
import type { ChannelId } from '../../skills/types';
import { appendToConversation } from '../../db';
import { runOrchestrator, type OrchestratorOutput } from '../../core/orchestrator';
import { formatForSlack } from '../../connections/slack/formatting';
import { config } from '../../config';
import { textToSpeech, sendAudioMessage, shouldRespondWithAudio } from '../../voice';
import logger from '../../utils/logger';
import { logLlmUsage } from '../../utils/usageLog';

export type SenderRole = 'owner' | 'colleague' | 'unknown';

export interface PostReplyInput {
  app: App;
  profile: UserProfile;
  result: OrchestratorOutput;
  say: (msg: { text: string; thread_ts?: string; unfurl_links?: boolean; unfurl_media?: boolean }) => Promise<unknown>;
  role: SenderRole;
  colleagueName?: string;
  senderId: string;
  channelId: string;
  threadTs: string;
  // v2.6.2 — the user's actual message ts (NOT the parent thread anchor when
  // it's a thread reply). Used for ack-class emoji replacement: when Maelle's
  // reply is a pure short ack ("Got it" / "On it" / "Done"), suppress the
  // text and react 👍 on the user's message instead. Optional for back-compat;
  // when omitted, ack-replacement is skipped and the reply posts as text.
  userMessageTs?: string;
  // Inputs the claim-checker retry path needs to re-invoke the orchestrator
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  userMessage: string;
  isMpim?: boolean;
  isOwnerInGroup?: boolean;
  mpimMemberIds?: string[];
  voiceInput?: boolean;
}

/**
 * v2.6.2 — pure-ack reply detector for the emoji-replacement path.
 *
 * A reply qualifies as a pure ack when it's short AND matches one of a small
 * set of single-phrase acknowledgments — "Got it", "On it", "Done", "Noted",
 * "Sure", "Okay", "Will do", and minor variants (case-insensitive, with
 * trailing . / !). When the reply has any actual content (a name, a time, a
 * follow-up question, a clarification), it does NOT qualify and posts as
 * text.
 *
 * Conservative by design — false negatives (a real ack posts as text) are
 * fine; false positives (a content reply gets swallowed into a reaction) are
 * the failure mode to avoid. Owner direction: "no free spirit for now."
 */
function isPureAckReply(reply: string): boolean {
  const trimmed = reply.trim();
  if (trimmed.length === 0 || trimmed.length > 30) return false;
  // Strip a single trailing emoji or punctuation cluster if present.
  const normalized = trimmed
    .replace(/[!.…]+$/, '')
    .replace(/^[!.…]+/, '')
    .trim()
    .toLowerCase();
  // Allowed single-phrase acks. Conservative — extend only when a real case
  // surfaces; over-eager additions risk swallowing content.
  const ACK_PHRASES = new Set([
    'got it',
    'got it!',
    'on it',
    'done',
    'noted',
    'sure',
    'sure thing',
    'will do',
    'okay',
    'ok',
    'thanks',
    'thank you',
    'all set',
    'sounds good',
    'no problem',
    'np',
    'cool',
  ]);
  return ACK_PHRASES.has(normalized);
}

export async function postOrchestratorReply(input: PostReplyInput): Promise<void> {
  const {
    app, profile, result, say,
    role, colleagueName,
    senderId, channelId, threadTs,
    history, userMessage, isMpim, isOwnerInGroup, mpimMemberIds, voiceInput,
  } = input;
  const { assistant } = profile;

  // v1.6.4 — if the orchestrator produced an empty reply (no tools, no text,
  // or a stuck loop) we do NOT fabricate a "Done." or equivalent. We post
  // nothing and log. The owner seeing silence in their thread is a clearer
  // signal that something went wrong than a fake confirmation.
  if (!result.reply || result.reply.trim().length === 0) {
    logger.warn('postOrchestratorReply: empty reply from orchestrator — posting nothing', {
      senderId, threadTs, channelId,
      toolSummaries: result.toolSummaries ?? [],
    });
    return;
  }

  // Step 1 (v2.2.5) — concision pass. When Sonnet emits a single text block
  // with deliberation embedded ("wait,", "let me find", "OK definitive
  // proposal", "actually,") or a wall of text > 600 chars on a non-list reply,
  // run a quick rewrite that strips the journey and keeps only the final
  // user-facing answer. Backstops the base-prompt anti-deliberation rule when
  // Sonnet ignores it. Cheap (only fires when triggered, ~150 in / ~100 out).
  // Falls back to the original draft on any error.
  const finalReply = await runConcisionPassIfNeeded(result.reply, profile);

  // Step 1b — persist what the user will actually see (post-concision) to
  // history. Future turns reading the conversation see the clean answer, not
  // the raw deliberation chain.
  const savedContent = result.toolSummaries?.length
    ? `${result.toolSummaries.join(' ')}\n${finalReply}`
    : finalReply;
  appendToConversation(threadTs, channelId, { role: 'assistant', content: savedContent });

  // Step 2 — normalize markdown → Slack mrkdwn.
  let cleanReply = formatForSlack(finalReply);

  // Step 2a (v3.0.2) — surface a status in the assistant panel while the
  // gate stack runs. Between "last tool returned" and "message lands" we
  // burn 4-8s on humanGate + claimChecker + dateVerifier + securityGate
  // (each a Sonnet pass; some have a retry path that re-invokes the
  // orchestrator). Pre-v3.0.2 the panel froze on the last tool's verb
  // ("Checking the calendar"…) or went blank if no tool fired. Single
  // 'Finishing up' status covers the whole stack. Fire-and-forget, same
  // pattern as the orchestrator's pre-tool and turn-start status hooks.
  // Slack rejects non-panel calls; setAssistantStatus swallows at debug.
  if (channelId && threadTs) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { setAssistantStatus } = require('../../connections/slack/messaging') as
        typeof import('../../connections/slack/messaging');
      void setAssistantStatus(app, profile.assistant.slack.bot_token, {
        channelId, threadTs, status: 'Finishing up',
      });
    } catch (_) { /* helper failure is non-fatal */ }
  }

  // Step 3 — owner-facing claim check (+ corrective retry).
  if (role === 'owner' || isOwnerInGroup) {
    cleanReply = await runClaimCheckAndMaybeRewrite({
      app, profile,
      initialReply: cleanReply,
      result,
      history, userMessage,
      senderId, channelId, threadTs,
      role, colleagueName, isMpim, isOwnerInGroup, mpimMemberIds,
    });

    // Step 3a (v2.6.5) — owner-facing humanness gate. Catches Maelle framing
    // herself as having technical infrastructure ("the routine fired but
    // hit an error", "I'd flag it to whoever manages the backend"). Tech
    // words about the world (backend interview, customer API, code review)
    // are FINE — the gate only fires when she attributes infrastructure to
    // HERSELF. Sibling to claimChecker but a different concern (voice, not
    // false claims). Fails open — never blocks a draft.
    //
    // v2.9 — audience='owner': talking TO the owner directly. Exemplars use
    // 1st/2nd person ("let me figure this out"); never third-person "Idan"
    // references while addressing him.
    try {
      const { runHumanGate } = await import('../../utils/humanGate');
      const verdict = await runHumanGate(cleanReply, profile, 'owner');
      if (!verdict.ok && verdict.rewrite && verdict.rewrite.trim().length > 0) {
        cleanReply = formatForSlack(verdict.rewrite);
      }
    } catch (err) {
      logger.warn('humanGate threw — leaving draft unchanged', { err: String(err).slice(0, 200) });
    }
  }

  // Step 3b — date-verifier (v3.4, Option C). Catches "Thursday 11 June" when
  // the 11th is a Wednesday, in any language. A gated Haiku call EXTRACTS the
  // weekday+date pairs; CODE judges them against the DATE LOOKUP and swaps the
  // wrong weekday word inside the exact matched span (deterministic verdict +
  // fix — the LLM only reads). Runs for both owner and colleague paths — a
  // wrong date to a colleague is just as bad.
  cleanReply = await runDateVerifierAndMaybeRetry({
    app, profile,
    initialReply: cleanReply,
    history, userMessage,
    senderId, channelId, threadTs,
    role, colleagueName, isMpim, isOwnerInGroup, mpimMemberIds,
  });

  // Step 3b-2 (v3.4.x, meeting #135) — booked-date honesty backstop. When a
  // move/create succeeded THIS turn, verify the reply's stated day/time for it
  // matches where it ACTUALLY landed (the resolved new_start/start carried in
  // mutationActions). Catches "moved to Friday" narrated as "back on Thursday".
  // Deterministic compare of resolved instants; the LLM only reads the reply +
  // the known booking and renders the fix in-language. Backstop to the
  // meeting-core assertWeekdayMatchesDate (which stops the wrong-day WRITE
  // upstream); a no-op when the write was right. Runs only when a booking fired,
  // so the cost is bounded (R9). Fails open — leaves the draft unchanged.
  try {
    const bookings = (result.mutationActions ?? [])
      .filter(m => m.ok && /^(move_meeting|create_meeting|finalize_coord_meeting|book_floating_block)$/.test(m.tool))
      .map(m => ({ tool: m.tool, subject: m.subject, iso: (m.new_start || m.start) ?? '' }))
      .filter(b => b.iso.length > 0);
    if (bookings.length > 0) {
      const { verifyReplyMatchesBooking } = await import('../../utils/dateVerifier');
      const corrected = await verifyReplyMatchesBooking(cleanReply, bookings, profile);
      if (corrected && corrected.trim().length > 0) {
        cleanReply = formatForSlack(corrected);
        appendToConversation(threadTs, channelId, { role: 'assistant', content: cleanReply });
      }
    }
  } catch (err) {
    logger.warn('booked-date honesty check threw — leaving draft unchanged', { err: String(err).slice(0, 200) });
  }

  // Step 3c (v1.8.4) — colleague-path mutation-contradiction check. When a
  // calendar-mutating tool succeeded this turn AND the draft tells the
  // colleague something like "I'll flag it for <owner>" or "he'll decide,"
  // Maelle is contradicting her own action — she did mutate the calendar,
  // she shouldn't defer it back to the owner. Retry once with a nudge so
  // the reply acknowledges the action. Code-only check, no Sonnet call.
  // Addresses the Bug C pattern from issue #26 aftermath (owner saw audit
  // log "Meeting booked" while the colleague was told "flagged for Idan").
  if (role === 'colleague' && !isOwnerInGroup) {
    const toolSummariesText = (result.toolSummaries ?? []).join(' ');
    const mutationRan = /\[(move_meeting|create_meeting|update_meeting|delete_meeting)/i.test(toolSummariesText);
    const ownerFirstName = profile.user.name.split(' ')[0];
    const ownerFnRe = new RegExp(`\\b${ownerFirstName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i');
    const draftDefersToOwner =
      /\bflag(?:ged|ging)?\s+(?:it|this|that)?\s*for\b/i.test(cleanReply) ||
      (/\blet\s+\S+\s+know\b/i.test(cleanReply) && ownerFnRe.test(cleanReply)) ||
      (/\bcheck\s+with\s+\S+/i.test(cleanReply) && ownerFnRe.test(cleanReply)) ||
      /\bhe'?ll\s+(?:likely|probably|need|decide|confirm|jump)/i.test(cleanReply);
    if (mutationRan && draftDefersToOwner) {
      logger.warn('Colleague draft defers to owner after mutation ran — retrying', {
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
  if (role === 'colleague' && !isOwnerInGroup) {
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
      assistantName: assistant.name,
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
      const { runHumanGate } = await import('../../utils/humanGate');
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

  // Step 4.5 (v2.6.2) — ack-class emoji replacement. When the cleaned reply
  // is a pure short ack ("Got it" / "On it" / "Done" / "Noted" / "Sure"),
  // suppress the text reply and react 👍 on the user's message instead.
  // Owner direction: "if nothing smart to say, we can say 👍 = positive ack."
  // Conservative match — single-phrase, ≤30 chars, no punctuation other
  // than . / !. Reply with actual content always posts as text.
  // Skipped when: voice input (audio path expects text), no userMessageTs
  // (can't react), already an emoji-only reply.
  const userMsgTs = (input as PostReplyInput).userMessageTs;
  if (!voiceInput && userMsgTs && isPureAckReply(cleanReply)) {
    try {
      await app.client.reactions.add({
        token: assistant.slack.bot_token,
        channel: channelId,
        timestamp: userMsgTs,
        name: '+1',
      });
      logger.debug('Ack-class reply replaced with 👍 reaction', {
        senderId, threadTs, replyPreview: cleanReply.slice(0, 40),
      });
      return;  // No text post; the reaction IS the reply.
    } catch (err) {
      logger.warn('Ack-replacement reaction failed — falling back to text', {
        err: String(err).slice(0, 200),
      });
      // Fall through to send text.
    }
  }

  // Step 4.6 (v3.0.8) — shadow-notify the owner about the colleague-facing
  // exchange. MOVED here from orchestrator/index.ts so the shadow reflects
  // the POST-GATE text (what the colleague actually sees) rather than the
  // raw pre-gate draft. Pre-fix the shadow fired from inside the orchestrator
  // BEFORE postReply.ts ran humanGate / securityGate / claim-checker;
  // when those gates rewrote a leaky draft (request ID in colleague reply,
  // bot-tell phrasing, etc.) the colleague got the clean version but the
  // shadow showed the leaky version. Confusing for the owner: he thought
  // colleagues saw leaks they never saw. Now shadow mirrors `cleanReply`
  // — the same string that's about to land in the colleague's DM.
  if (
    role === 'colleague' &&
    !isOwnerInGroup &&
    !result.requiresApproval &&
    cleanReply &&
    cleanReply.trim().length > 0
  ) {
    try {
      const { shadowNotify } = await import('../../utils/shadowNotify');
      const who = colleagueName ?? senderId;
      const replyPreview = cleanReply.slice(0, 200).replace(/\s+/g, ' ').trim();
      const inboundPreview = (userMessage ?? '').slice(0, 200).replace(/\s+/g, ' ').trim();
      const distinctTools = [...new Set(
        (result.toolSummaries ?? [])
          .map(s => s.match(/^\[([a-z0-9_]+)/)?.[1] ?? '')
          .filter(name => name.length > 0)
      )];
      const toolHint = distinctTools.length > 0 ? ` (${distinctTools.join(', ')})` : '';
      // v3.1.2 fix (#117) — ONE shadow per turn, not two. The v3.0.8 split
      // ("shadow post-gate", cc1ca30) put inbound + outbound in separate
      // shadowNotify calls, each rendering its own "Conversation with X"
      // header — owner saw a doubled DM stream. Re-merged: one post carrying
      // both sides under a single conversationHeader. If inbound text is
      // empty (reaction-only event), the outbound stands alone.
      const combinedDetail = inboundPreview.length > 0
        ? `${who} said: "${inboundPreview}"\nI → ${who}: "${replyPreview}"${toolHint}`
        : `I → ${who}: "${replyPreview}"${toolHint}`;
      await shadowNotify(profile, {
        channel: channelId,
        threadTs,
        action: `Conversation with ${who}`,
        detail: combinedDetail,
        conversationKey: threadTs,
        conversationHeader: `Conversation with ${who}`,
      });
    } catch (err) {
      logger.warn('Inbound-colleague shadow notify threw — continuing', { err: String(err) });
    }
  }

  // Step 5 — audio vs text.
  await sendReply({
    app, botToken: assistant.slack.bot_token,
    channelId, threadTs,
    cleanReply,
    voiceInput: voiceInput === true,
    say,
  });

  // Step 6 — approval footer, if any.
  if (result.requiresApproval && result.approvalId) {
    const approvalMsg =
      `To approve: \`approve ${result.approvalId}\`\n` +
      `To reject: \`reject ${result.approvalId}\``;
    await say({ text: approvalMsg, thread_ts: threadTs });
  }
}

// ── Internal steps ──────────────────────────────────────────────────────────

interface ClaimCheckContext {
  app: App;
  profile: UserProfile;
  initialReply: string;
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
async function runClaimCheckAndMaybeRewrite(ctx: ClaimCheckContext): Promise<string> {
  const { app, profile, initialReply, result, history, userMessage } = ctx;
  let cleanReply = initialReply;

  try {
    const { checkReplyClaims } = await import('../../utils/claimChecker');

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
        ? (/\[message_colleague/.test(toolSummariesText) &&
            (!verdict.target_name || toolSummariesText.toLowerCase().includes(verdict.target_name.toLowerCase())))
          // v3.4.x — resolve_approval relays the owner's decision to the original
          // requester ITSELF (internal DM via the resolver, not message_colleague).
          // So it backs a "the requester will get it / I'll let them know / they
          // can confirm" claim after an approval decision. Its summary carries no
          // requester name, so no target match is possible or required (the
          // double-DM the old message_colleague retry caused is exactly the harm).
          || /\[resolve_approval/.test(toolSummariesText)
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
      logger.warn('Claim-checker flagged but matching tool already ran this turn — skipping rewrite (false positive)', {
        senderId: ctx.senderId,
        threadTs: ctx.threadTs,
        action_type: verdict.action_type,
        target_name: verdict.target_name,
        toolSummaries: result.toolSummaries,
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
      const { rewriteOwningTheMiss } = await import('../../utils/claimChecker');
      const rewritten = await rewriteOwningTheMiss({
        draft: cleanReply,
        actionSummary: verdict.action_summary,
        actionType: verdict.action_type,
        targetName: verdict.target_name,
        ownerFirstName: profile.user.name.split(' ')[0],
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
  const { filterColleagueReply } = await import('../../utils/securityGate');
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

/**
 * Audio branch: voice input + TTS available + short-enough reply → audio.
 * Anything else → text via say(). Never block text on audio failure.
 */
async function sendReply(opts: {
  app: App;
  botToken: string;
  channelId: string;
  threadTs: string;
  cleanReply: string;
  voiceInput: boolean;
  say: (msg: { text: string; thread_ts?: string; unfurl_links?: boolean; unfurl_media?: boolean }) => Promise<unknown>;
}): Promise<void> {
  const useAudio = shouldRespondWithAudio({
    inputWasVoice: opts.voiceInput,
    responseText: opts.cleanReply,
  });

  if (useAudio && config.OPENAI_API_KEY) {
    try {
      const audioBuffer = await textToSpeech(opts.cleanReply);
      await sendAudioMessage({
        app: opts.app,
        botToken: opts.botToken,
        channelId: opts.channelId,
        threadTs: opts.threadTs,
        audioBuffer,
      });
      return;
    } catch (audioErr) {
      if (opts.voiceInput) {
        logger.warn('Audio response failed — falling back to text', { err: String(audioErr) });
      } else {
        logger.debug('Audio TTS unavailable — using text', { err: String(audioErr) });
      }
      // Fall through to text.
    }
  }
  // v2.6.5 — capture the posted message ts and record it on threadActivity.
  // The unconditional ✅ react that lived here in v2.6.2 was annoying mid-flow
  // — it fired on every Maelle reply regardless of whether the activity was
  // complete. Replacement: tasks/index.ts:completeTask now reacts ✅ on the
  // most recent Maelle message in the thread when an actual task transitions
  // to completed. The recordMaelleMessage call below is what gives that hook
  // a target to react on. No reaction here.
  // Bolt's `say` returns ChatPostMessageResponse at runtime even though the
  // surface type is Promise<unknown> (postReply abstracts from app-direct).
  // v3.2.6 — suppress Slack link/media unfurl on Maelle's replies. An EA's
  // replies (esp. a news answer with many source links) shouldn't balloon into
  // a wall of previews. Cited links stay clickable; they just don't auto-expand.
  const sayRes = await opts.say({ text: opts.cleanReply, thread_ts: opts.threadTs, unfurl_links: false, unfurl_media: false }) as
    | { ts?: string; ok?: boolean } | undefined;
  if (sayRes?.ts) {
    const { recordMaelleMessage } = await import('../../utils/threadActivity');
    recordMaelleMessage(opts.threadTs, opts.channelId, sayRes.ts);
  }
}

// ── Date verifier + retry (v1.6.6) ─────────────────────────────────────────

interface DateVerifyContext {
  app: App;
  profile: UserProfile;
  initialReply: string;
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
async function runDateVerifierAndMaybeRetry(ctx: DateVerifyContext): Promise<string> {
  const { profile, initialReply, userMessage } = ctx;
  let cleanReply = initialReply;

  try {
    const { verifyDates } = await import('../../utils/dateVerifier');
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

async function runConcisionPassIfNeeded(rawReply: string, profile: UserProfile): Promise<string> {
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
      model: 'claude-sonnet-4-6',
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
    logLlmUsage('concision_pass', 'claude-sonnet-4-6', resp);
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

