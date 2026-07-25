/**
 * Reply pipeline (v1.6.2 split from app.ts).
 *
 * The stage between "runOrchestrator returned a draft" and "a message lands in
 * Slack". DELIVERY only — the output-time gate stack (concision, claim-checker,
 * humanGate, date verifier, security gate) lives in
 * `utils/guards/runOutputGates` so transport and gate policy change
 * independently of each other.
 *
 * Steps, in order:
 *   1  Concision finalizer (guard module) on the raw draft.
 *   1b Save what the user will actually SEE to conversation history (so
 *      Claude's next turn sees what she did, not the deliberation chain).
 *   2  Normalize markdown artefacts (** → *, etc) for Slack rendering, and
 *      park a 'Finishing up' status in the assistant panel.
 *   3  Run the output gate stack (guard module). Owner path and colleague
 *      path are both decided in there; it returns the text to send.
 *   4  Ack-class emoji replacement, then the colleague shadow-notify.
 *   5  Audio vs text branch based on the input modality + TTS availability.
 *   6  Optional approval footer when the orchestrator flagged a pending ask.
 */

import type { App } from '@slack/bolt';
import type { UserProfile } from '../../config/userProfile';
import { appendToConversation } from '../../db';
import type { OrchestratorOutput } from '../../core/orchestrator';
import { formatForSlack } from '../../connections/slack/formatting';
import { config } from '../../config';
import { textToSpeech, sendAudioMessage, shouldRespondWithAudio } from '../../voice';
import logger from '../../utils/logger';
import { runConcisionPassIfNeeded, runOutputGates } from '../../utils/guards/runOutputGates';

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
  // Turn inputs the gate stack reads (prior-turn tool markers for the
  // claim-checker shield, the spoof scan, the date verifier's anchor, and the
  // colleague mutation-contradiction re-draft). Passed straight to runOutputGates.
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
  // (Haiku passes now; the claim-checker's honesty rewrite is a tool-less pass,
  // not an orchestrator re-invoke). Pre-v3.0.2 the panel froze on the last tool's verb
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

  // Step 3 — the output-time GATE STACK (guard lane, utils/guards/runOutputGates).
  // Owner path: claim-check + humanGate + date-verify (probed concurrently,
  // exact serial chain on any flag). Colleague path: date-verify →
  // mutation-contradiction retry → security gate → humanGate. Every gate fails
  // OPEN, so a throw in there returns the draft we handed it.
  cleanReply = await runOutputGates(cleanReply, {
    app, profile, result,
    history, userMessage,
    senderId, channelId, threadTs,
    role, colleagueName, isMpim, isOwnerInGroup, mpimMemberIds,
  });

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
    // The owner clamped to colleague-context in a channel (v3.7.0) is not a real
    // colleague — don't shadow him about his own conversation. (!isOwnerInGroup
    // already handles the MPIM clamp; this closes the channel case.)
    senderId !== profile.user.slack_user_id &&
    !result.requiresApproval &&
    cleanReply &&
    cleanReply.trim().length > 0
  ) {
    try {
      const { shadowNotify } = await import('../../utils/shadowNotify');
      const who = colleagueName ?? senderId;
      // Shadow-mirror previews (owner-facing receipt). Cap raised from 200 — it was
      // cutting a normal slot-proposal reply / colleague ask off mid-sentence, hard
      // to read — with an ellipsis so a real overflow reads as truncated, not ended.
      const SHADOW_PREVIEW_MAX = 350;
      const previewLine = (s: string | undefined): string => {
        const flat = (s ?? '').replace(/\s+/g, ' ').trim();
        return flat.length > SHADOW_PREVIEW_MAX ? `${flat.slice(0, SHADOW_PREVIEW_MAX).trim()}…` : flat;
      };
      const replyPreview = previewLine(cleanReply);
      const inboundPreview = previewLine(userMessage);
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

// ── Delivery ───────────────────────────────────────────────────────────────

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
