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
 *   3. OWNER PATH: run the claim-checker. On false-claim verdict, re-invoke
 *      the orchestrator with a corrective nudge (and, for message-type
 *      claims, tool_choice forcing message_colleague). Capped at one retry.
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

export type SenderRole = 'owner' | 'colleague' | 'unknown';

export interface PostReplyInput {
  app: App;
  profile: UserProfile;
  result: OrchestratorOutput;
  say: (msg: { text: string; thread_ts?: string }) => Promise<unknown>;
  role: SenderRole;
  colleagueName?: string;
  senderId: string;
  channelId: string;
  threadTs: string;
  // Inputs the claim-checker retry path needs to re-invoke the orchestrator
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  userMessage: string;
  isMpim?: boolean;
  isOwnerInGroup?: boolean;
  mpimMemberIds?: string[];
  voiceInput?: boolean;
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

  // Step 3 — owner-facing claim check (+ corrective retry).
  if (role === 'owner' || isOwnerInGroup) {
    cleanReply = await runClaimCheckAndMaybeRetry({
      app, profile,
      initialReply: cleanReply,
      result,
      history, userMessage,
      senderId, channelId, threadTs,
      role, colleagueName, isMpim, isOwnerInGroup, mpimMemberIds,
    });
  }

  // Step 3b — date-verifier (v1.6.6). Catches "Sunday 20 Apr" when Sunday
  // is actually 19 Apr per the DATE LOOKUP table. Cheap regex — no LLM call.
  // If mismatches found, one corrective orchestrator retry. Runs for both
  // owner and colleague paths — a wrong date to a colleague is just as bad.
  cleanReply = await runDateVerifierAndMaybeRetry({
    app, profile,
    initialReply: cleanReply,
    history, userMessage,
    senderId, channelId, threadTs,
    role, colleagueName, isMpim, isOwnerInGroup, mpimMemberIds,
  });

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
    const mutationRan = /\[(move_meeting|create_meeting|update_meeting|delete_meeting|finalize_coord_meeting)/i.test(toolSummariesText);
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

  // Step 4 — colleague-facing security gate (leak filter).
  if (role === 'colleague' && !isOwnerInGroup) {
    cleanReply = await runSecurityGate({
      reply: cleanReply,
      colleagueName,
      senderId,
      assistantName: assistant.name,
      ownerFirstName: profile.user.name.split(' ')[0],
    });
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
 * false action claims. On detection, re-invoke the orchestrator once with a
 * corrective nudge; for message-type claims, also force tool_choice to
 * message_colleague so the model must actually call the tool.
 *
 * Fails open: verifier errors, JSON parse errors, retry errors — all leave
 * the original draft in place. Never blocks a reply.
 */
async function runClaimCheckAndMaybeRetry(ctx: ClaimCheckContext): Promise<string> {
  const { app, profile, initialReply, result, history, userMessage } = ctx;
  let cleanReply = initialReply;

  try {
    const { checkReplyClaims } = await import('../../utils/claimChecker');
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

    if (!verdict.claimed_action) return cleanReply;

    // v1.7.4 — defense in depth. The claim-checker can false-positive (saw
    // it happen with "the message is on its way" being flagged even when
    // message_colleague ran). If the matching tool clearly DID run this turn,
    // refuse the retry — the claim was honest, the checker erred. Without
    // this guard, the retry forces the SAME tool with a corrective nudge,
    // which creates a duplicate outreach (Amazia 6-second-apart bug).
    const toolSummariesText = (result.toolSummaries ?? []).join(' ');
    const matchingToolAlreadyRan =
      verdict.action_type === 'message'
        ? /\[message_colleague/.test(toolSummariesText) &&
          (!verdict.target_name || toolSummariesText.toLowerCase().includes(verdict.target_name.toLowerCase()))
        : verdict.action_type === 'book'
          ? /\[(create_meeting|finalize_coord_meeting)/.test(toolSummariesText)
          : verdict.action_type === 'task'
            ? /\[(create_task|create_approval)/.test(toolSummariesText)
            : false;

    if (matchingToolAlreadyRan) {
      logger.warn('Claim-checker flagged but matching tool already ran this turn — skipping retry (false positive)', {
        senderId: ctx.senderId,
        threadTs: ctx.threadTs,
        action_type: verdict.action_type,
        target_name: verdict.target_name,
        toolSummaries: result.toolSummaries,
      });
      return cleanReply;
    }

    logger.warn('Claim-checker: retrying turn with corrective nudge', {
      senderId: ctx.senderId,
      threadTs: ctx.threadTs,
      action_type: verdict.action_type,
      target_name: verdict.target_name,
      action_summary: verdict.action_summary,
    });

    const targetLabel = verdict.target_name ?? 'the person mentioned';
    const nudge =
      verdict.action_type === 'message'
        ? `Your previous draft claimed you already messaged ${targetLabel}, but no send tool ran. Call message_colleague now to actually send it.`
        : `Your previous draft claimed you already did something (${verdict.action_summary ?? verdict.action_type ?? 'an action'}) that no tool call in that turn actually performed. Either call the right tool now to actually do it, or rewrite the reply as a plan ("I'll take care of that") instead of a completed claim.`;

    try {
      const retry = await runOrchestrator({
        userMessage,
        conversationHistory: history,
        threadTs: ctx.threadTs,
        channelId: ctx.channelId,
        userId: ctx.senderId,
        senderRole: ctx.role as 'owner' | 'colleague',
        senderName: ctx.colleagueName,
        channel: 'slack' as ChannelId,
        profile,
        app,
        isMpim: ctx.isMpim,
        isOwnerInGroup: ctx.isOwnerInGroup,
        mpimMemberIds: ctx.mpimMemberIds,
        extraInstruction: nudge,
        forceToolOnFirstTurn:
          verdict.action_type === 'message' ? { name: 'message_colleague' } : undefined,
      });
      cleanReply = formatForSlack(retry.reply);
      // Overwrite the conversation-history entry with the corrected draft so
      // Claude's NEXT turn doesn't see the dishonest version.
      appendToConversation(ctx.threadTs, ctx.channelId, { role: 'assistant', content: cleanReply });
    } catch (retryErr) {
      logger.warn('Claim-checker retry errored — keeping original draft', { err: String(retryErr) });
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
}): Promise<string> {
  const { filterColleagueReply } = await import('../../utils/securityGate');
  const gateResult = await filterColleagueReply({
    reply: opts.reply,
    colleagueName: opts.colleagueName,
    colleagueSlackId: opts.senderId,
    assistantName: opts.assistantName,
    ownerFirstName: opts.ownerFirstName,
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
  say: (msg: { text: string; thread_ts?: string }) => Promise<unknown>;
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
  await opts.say({ text: opts.cleanReply, thread_ts: opts.threadTs });
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
 * v1.6.6 — scan the draft for weekday/date pairs (e.g. "Sunday 20 Apr") and
 * verify against the owner's local 14-day lookup. Mismatches trigger one
 * corrective orchestrator retry with a nudge listing the wrong pairs.
 *
 * Runs for BOTH owner and colleague paths — a date-wrong DM to a colleague
 * creates the same trust problem as one to the owner.
 *
 * Fails OPEN: parse errors, retry errors, anything → return the original draft.
 * Max one retry; the retry's output is NOT re-verified (avoid loops).
 */
async function runDateVerifierAndMaybeRetry(ctx: DateVerifyContext): Promise<string> {
  const { app, profile, initialReply, history, userMessage } = ctx;
  let cleanReply = initialReply;

  try {
    const { verifyDates, buildDateCorrectionNudge } = await import('../../utils/dateVerifier');
    const verdict = await verifyDates(cleanReply, profile.user.timezone, userMessage);
    if (verdict.ok || verdict.mismatches.length === 0) return cleanReply;

    logger.warn('Date verifier: draft has wrong weekday/date pairs — retrying', {
      senderId: ctx.senderId,
      threadTs: ctx.threadTs,
      mismatches: verdict.mismatches,
    });

    const nudge = buildDateCorrectionNudge(verdict.mismatches);
    let retriedReply: string | null = null;
    try {
      const retry = await runOrchestrator({
        userMessage,
        conversationHistory: history,
        threadTs: ctx.threadTs,
        channelId: ctx.channelId,
        userId: ctx.senderId,
        senderRole: ctx.role as 'owner' | 'colleague',
        senderName: ctx.colleagueName,
        channel: 'slack' as ChannelId,
        profile,
        app,
        isMpim: ctx.isMpim,
        isOwnerInGroup: ctx.isOwnerInGroup,
        mpimMemberIds: ctx.mpimMemberIds,
        extraInstruction: nudge,
      });
      if (retry.reply && retry.reply.trim().length > 0) {
        retriedReply = formatForSlack(retry.reply);
      }
    } catch (retryErr) {
      logger.warn('Date verifier retry errored — falling through to deterministic correction', { err: String(retryErr) });
    }

    // v1.8.14 — re-verify retry output. If it STILL has the same mismatches,
    // deterministically rewrite the wrong weekday tokens inline. Prevents the
    // "Thursday 24 Apr" bug where a retry loop produces the same wrong pair
    // twice and the draft ships anyway. String replacement is bounded by the
    // lookup we already computed — safe and always correct.
    const candidate = retriedReply ?? cleanReply;
    const reverdict = await verifyDates(candidate, profile.user.timezone, userMessage);
    if (!reverdict.ok && reverdict.mismatches.length > 0) {
      logger.warn('Date verifier: retry still has mismatches — applying deterministic correction', {
        mismatches: reverdict.mismatches,
      });
      cleanReply = candidate;
      for (const mm of reverdict.mismatches) {
        // Example: written="Thursday" (or "Thu") + writtenDate="24 Apr" → correct="Friday".
        // Find the exact wrong pair in the draft and swap the weekday token only.
        const wdPattern = new RegExp(`\\b${escapeRegex(mm.writtenWeekday)}\\b(?=[,\\s]+(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\s+${escapeRegex(mm.writtenDate.split(' ')[1] ?? '')})`, 'gi');
        cleanReply = cleanReply.replace(wdPattern, mm.correctWeekday);
      }
      appendToConversation(ctx.threadTs, ctx.channelId, { role: 'assistant', content: cleanReply });
    } else if (retriedReply) {
      cleanReply = retriedReply;
      appendToConversation(ctx.threadTs, ctx.channelId, { role: 'assistant', content: cleanReply });
    }
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

async function runConcisionPassIfNeeded(rawReply: string, profile: UserProfile): Promise<string> {
  const trim = rawReply.trim();
  if (!trim) return trim;

  const tooLong = trim.length > 600 && !looksLikeAList(trim);
  const hasDeliberation = DELIBERATION_RE.test(trim);
  if (!tooLong && !hasDeliberation) return trim;

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
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

Keep the answer; drop the journey. Stay under 4 short sentences unless the draft is a numbered/bulleted list, in which case keep the list intact and trim only the prose around it. Match the language of the draft (Hebrew/English).

Draft:
${trim}`,
      }],
    });
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
      triggered: hasDeliberation ? 'pattern' : 'length',
    });
    return cleaned;
  } catch (err) {
    logger.warn('Concision pass threw — sending original draft', { err: String(err).slice(0, 200) });
    return trim;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
