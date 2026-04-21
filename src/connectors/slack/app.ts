import { App, LogLevel } from '@slack/bolt';
import { config } from '../../config';
import { runOrchestrator } from '../../core/orchestrator';
import type { ChannelId } from '../../skills/types';
import type { UserProfile } from '../../config/userProfile';
import {
  getConversationHistory,
  appendToConversation,
  auditLog,
  resolveApproval,
  logEvent,
  getPendingRequestCountForColleague,
  upsertPersonMemory,
  appendPersonNote,
  getSummarySessionByThread,
} from '../../db';
import { detectAndSaveGender } from '../../utils/genderDetect';
import {
  handleOutreachReply,
  findSlackUser,
  findSlackChannel,
} from './coordinator';
import { isMessageForAssistant } from './relevance';
import { initiateCoordination } from '../../skills/meetings/coord/state';
import { handleCoordReply } from '../../skills/meetings/coord/reply';
import { forceBookCoordinationByOwner } from '../../skills/meetings/coord/booking';
import { type SlotWithLocation } from '../../skills/meetings/coord/utils';
import {
  transcribeSlackAudio,
  textToSpeech,
  sendAudioMessage,
  shouldRespondWithAudio,
} from '../../voice';
import {
  downloadSlackImage,
  buildImageBlock,
  type AnthropicImageBlock,
} from '../../vision';
import { scanImageForInjection } from '../../utils/imageGuard';
import { shadowNotify } from '../../utils/shadowNotify';
import logger from '../../utils/logger';

/**
 * RESPONSE RULES — Maelle only speaks when spoken to:
 *
 *   1:1 DM      (D...)  → responds to every message from authorised user
 *   Group DM    (G...)  → responds to every message from authorised user
 *   Channel     (C...)  → ONLY responds when @mentioned, never otherwise
 *   Private ch  (G...)  → ONLY responds when @mentioned, never otherwise
 *
 * She never reads or processes messages she wasn't addressed in.
 */

export function createSlackAppForProfile(profile: UserProfile): App {
  const { assistant, user } = profile;

  const app = new App({
    token: assistant.slack.bot_token,
    appToken: assistant.slack.app_token,
    signingSecret: assistant.slack.signing_secret,
    socketMode: true,
    logLevel: config.NODE_ENV === 'development' ? LogLevel.WARN : LogLevel.ERROR,
  });

  // v1.9.0 — register SlackConnection for this profile so skills (via the
  // router) can resolve it for outgoing messages. Nothing consumes this yet
  // in v1.9.0 sub-phase A; SummarySkill will be the first consumer in B,
  // then outreach + coord in C/D.
  //
  // Profile id comes from user.slack_user_id (stable per-owner identifier).
  {
    // Lazy import to avoid circular deps with connections/slack/index.ts
    // which imports from this module via messaging.ts.
    const { createSlackConnection } = require('../../connections/slack') as typeof import('../../connections/slack');
    const { registerConnection } = require('../../connections/registry') as typeof import('../../connections/registry');
    registerConnection(user.slack_user_id, createSlackConnection(app, assistant.slack.bot_token));
  }

  // ── Channel type helpers ──────────────────────────────────────────────────
  // Slack channel ID prefixes:
  //   D = 1:1 direct message
  //   C = public channel
  //   G = private channel OR multi-person DM (MPIM)
  //
  // We treat pure group DMs (MPIM) the same as 1:1 DMs — respond freely.
  // Private channels look the same as group DMs at the ID level, so we use
  // the isMpim flag from the event to tell them apart.

  function is1on1DM(channelId: string): boolean {
    return channelId.startsWith('D');
  }

  // In DMs (1:1 or group), say() must NOT receive thread_ts — Bolt rejects it
  function isDirectContext(channelId: string, isMpim?: boolean): boolean {
    return is1on1DM(channelId) || isMpim === true;
  }

  // Role-based access:
  //   'owner'     → the user this assistant belongs to — full access
  //   'colleague' → anyone else in the workspace — can request meetings, ask availability
  type SenderRole = 'owner' | 'colleague';

  // ── Colleague-mode testing ────────────────────────────────────────────────
  // Owner can say "test as colleague" to simulate the colleague experience.
  // Persists per-thread so follow-up messages in the same thread stay in colleague mode.
  // Owner says "stop testing" or "back to normal" to exit.
  const colleagueTestThreads = new Set<string>();

  function getSenderRole(senderId: string): SenderRole {
    return senderId === user.slack_user_id ? 'owner' : 'colleague';
  }

  // Deduplication — Slack retries events if the handler takes too long (>3s),
  // and catch-up can race with live delivery of the same event after restart.
  // v1.8.14: shared process-global Set (processedDedup.ts) so catchUpMissedMessages
  // can mark messages it replied to — preventing live handler from replying again.
  const { markProcessed, hasProcessed } = require('./processedDedup') as typeof import('./processedDedup');

  // Bot user ID — fetched once at startup, used to detect self-mentions
  let botUserId: string | null = null;
  app.client.auth.test({ token: assistant.slack.bot_token })
    .then(r => { botUserId = r.user_id as string; logger.debug('Bot user ID', { botUserId }); })
    .catch(() => { logger.warn('Could not fetch bot user ID — mention dedup disabled'); });

  // Returns true only if the message mentions THIS bot specifically
  // Used to prevent double-firing when app_mention and message.im both trigger
  function containsSelfMention(text: string): boolean {
    if (!botUserId) return false; // if we don't know our ID, don't filter
    return text.includes(`<@${botUserId}>`);
  }

  // ── Mention resolver ─────────────────────────────────────────────────────
  // Replace <@USERID> with "Real Name (slack_id: USERID)" so Claude can use
  // the Slack ID directly without a separate find_slack_user call.
  // Also saves each resolved person to people_memory for cross-session context.
  async function resolveSlackMentions(text: string): Promise<string> {
    // Clean mailto links: <mailto:email|email> → email
    let resolved = text.replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1');

    // Clean plain angle-bracket links
    resolved = resolved.replace(/<(https?:\/\/[^|>]+)>/g, '$1');
    resolved = resolved.replace(/<(https?:\/\/[^|>]+)\|[^>]+>/g, '$1');

    // Resolve ALL @mentions
    const mentionPattern = /<@([A-Z0-9]+)>/g;
    const userIds = [...new Set([...resolved.matchAll(mentionPattern)].map(m => m[1]))];
    if (userIds.length === 0) return resolved;

    interface ResolvedUser { name: string; email?: string; timezone?: string; }
    const nameMap: Record<string, ResolvedUser> = {};

    await Promise.all(userIds.map(async (userId) => {
      try {
        const info = await app.client.users.info({ token: assistant.slack.bot_token, user: userId });
        const u = info.user as any;
        const name = u?.real_name || u?.name || userId;
        nameMap[userId] = {
          name,
          email:    u?.profile?.email   || undefined,
          timezone: u?.tz               || undefined,
        };
        // Save to people_memory — skip the bot itself and the owner
        if (userId !== botUserId && userId !== user.slack_user_id) {
          upsertPersonMemory({
            slackId:  userId,
            name,
            email:    u?.profile?.email   || undefined,
            timezone: u?.tz               || undefined,
          });
          // Fire-and-forget gender detection: pronouns first, then profile image
          const imageUrl = u?.profile?.image_192 || u?.profile?.image_72 || undefined;
          detectAndSaveGender({
            slackId:   userId,
            name,
            pronouns:  u?.profile?.pronouns || undefined,
            imageUrl,
            botToken:  assistant.slack.bot_token,
          }).catch(() => {});
        }
      } catch (_) {
        nameMap[userId] = { name: userId };
      }
    }));

    // Replace <@USERID> with "Name (slack_id: USERID)" so Claude knows the ID immediately
    resolved = resolved.replace(/<@([A-Z0-9]+)>/g, (_, userId) => {
      const info = nameMap[userId];
      if (!info) return userId;
      return `${info.name} (slack_id: ${userId})`;
    });

    return resolved;
  }

  // ── Shared message processor ──────────────────────────────────────────────
  // Single function handles all contexts — DM, group DM, channel mention
  async function processMessage(params: {
    senderId: string;
    text: string;
    channelId: string;
    ts: string;
    threadTs: string;
    say: Function;
    client: typeof app.client;
    isChannel: boolean;
    isMpim?: boolean;
    mpimMemberIds?: string[];  // all non-bot member IDs when in MPIM
    voiceInput?: boolean;      // true if input came from a voice message
    images?: AnthropicImageBlock[];  // v1.7.1 — image content blocks attached to this turn
  }): Promise<void> {
    const { senderId, text, channelId, ts, threadTs, say, client, isChannel, isMpim, voiceInput, mpimMemberIds, images } = params;
    const rawRole = getSenderRole(senderId);

    // ── Colleague-mode testing (owner only, DMs only) ────────────────────────
    if (rawRole === 'owner' && !isChannel && !isMpim) {
      const lowerText = text.toLowerCase().trim();
      if (/\btest\s+as\s+colleague\b/.test(lowerText)) {
        colleagueTestThreads.add(threadTs);
        await say({ text: `Colleague test mode ON for this thread. I'll treat you as a colleague now — try asking me to book a meeting. Say "stop testing" to exit.`, thread_ts: threadTs });
        return;
      }
      if (colleagueTestThreads.has(threadTs) && /\b(stop\s+test|back\s+to\s+normal|exit\s+test)\b/.test(lowerText)) {
        colleagueTestThreads.delete(threadTs);
        await say({ text: `Back to normal — you're the owner again in this thread.`, thread_ts: threadTs });
        return;
      }
    }
    const isColleagueTest = rawRole === 'owner' && colleagueTestThreads.has(threadTs);

    // MPIM security: everyone gets colleague context in group DMs — including the owner.
    // The owner can ask direct questions (e.g. "am I free?") but gets colleague-level tools
    // and a privacy-conscious system prompt so nothing leaks to other participants.
    const isOwnerInGroup = isMpim === true && rawRole === 'owner';
    const role: SenderRole = (isMpim || isColleagueTest) ? 'colleague' : rawRole;
    logger.info('processMessage — role determined', {
      senderId,
      channelId,
      rawRole,
      effectiveRole: role,
      isChannel,
      isMpim: isMpim ?? false,
      isOwnerInGroup,
    });

    auditLog({
      action: 'message_received',
      source: 'slack',
      actor: senderId,
      details: {
        assistant: assistant.name,
        channelId,
        isChannel,
        isMpim,
        role,
        preview: text.slice(0, 100),
      },
      outcome: 'success',
    });

    // If this is from a colleague — identify them FIRST, then check active jobs
    // Owner-in-group gets colleague TOOLS but skips the colleague funnel (no rate limit, no coord/outreach intercept)
    if (role === 'colleague' && !isOwnerInGroup) {
      // Step 1: Resolve persona — always do this before anything else so we know who we're talking to
      let colleagueIdentified = false;
      try {
        const senderInfo = await app.client.users.info({
          token: assistant.slack.bot_token,
          user: senderId,
        });
        const u = senderInfo.user as any;
        const senderName = u?.real_name ?? senderId;
        logger.info('Colleague identified', { senderId, name: senderName, channel: channelId });
        colleagueIdentified = true;

        // Build relationship memory
        upsertPersonMemory({
          slackId:  senderId,
          name:     senderName,
          email:    u?.profile?.email   || undefined,
          timezone: u?.tz               || undefined,
        });
        // Detect gender in background if not yet known
        const colImageUrl = u?.profile?.image_192 || u?.profile?.image_72 || undefined;
        detectAndSaveGender({
          slackId:  senderId,
          name:     senderName,
          pronouns: u?.profile?.pronouns || undefined,
          imageUrl: colImageUrl,
          botToken: assistant.slack.bot_token,
        }).catch(() => {});
      } catch (err) {
        logger.warn('Could not identify colleague — proceeding anyway', { senderId, err: String(err) });
      }

      // Step 2: Check if this is a reply to an active coordination or outreach job
      try {
        const multiHandled = await handleCoordReply({
          senderId, text, channelId, threadTs, profile,
        });
        if (multiHandled) {
          logger.info('Message handled as coordination reply', { senderId, channelId });
          return;
        }

        const outreachHandled = await handleOutreachReply(app, {
          senderId, text, profile,
          bot_token: assistant.slack.bot_token,
        });
        if (outreachHandled) {
          logger.info('Message handled as outreach reply', { senderId, channelId });
          return;
        }
      } catch (_) { /* non-critical */ }

      // Step 3: Rate limit check — max 2 pending requests per colleague
      const pendingCount = getPendingRequestCountForColleague(profile.user.slack_user_id, senderId);
      if (pendingCount >= 2) {
        logger.warn('Colleague rate limit reached', { senderId, pendingCount });
        await app.client.chat.postMessage({
          token: assistant.slack.bot_token,
          channel: channelId,
          text: `Hi — you already have a couple of pending requests with ${profile.user.name}. I'll follow up with you once those are resolved.`,
        });
        return;
      }

      // Step 4: Log the unsolicited message for the briefing.
      // v1.6.14 — stopped writing the raw message text to people_memory.notes
      // here. notes is for RELATIONAL context (who they are, what we've
      // learned about them) — not a verbatim message log. Every inbound
      // colleague message was producing a `notes` entry like `Sent a message
      // to Maelle: "..."`, which then loaded into the system prompt forever.
      // Heavy-traffic contacts had 50+ entries (~5kB each). The conversation
      // history + outreach_jobs + audit log already preserve message content;
      // we don't need a third copy in the prompt.
      if (colleagueIdentified) {
        try {
          const senderInfo = await app.client.users.info({
            token: assistant.slack.bot_token,
            user: senderId,
          });
          const u = senderInfo.user as any;
          const senderName = u?.real_name ?? senderId;
          logEvent({
            ownerUserId: profile.user.slack_user_id,
            type: 'message',
            title: `${senderName} sent you a message`,
            detail: text.slice(0, 200),
            actor: senderName,
          });
        } catch (_) { /* non-critical */ }
      }
    }

    // Approval responses — owner only, DMs only
    if (role === 'owner' && !isChannel) {
      const approvalMatch = text.match(/^(approve|reject)\s+(appr_\S+)/i);
      if (approvalMatch) {
        await handleApprovalResponse(
          approvalMatch[1].toLowerCase() as 'approve' | 'reject',
          approvalMatch[2],
          say,
          isChannel,
          threadTs,
          profile,
        );
        return;
      }
    }


    const dbHistory = getConversationHistory(threadTs);
    // v1.7.1 — when images are attached, prefix the persisted text with
    // "[Image]" so future turns know an image was shared in this turn (the
    // bytes themselves are never stored — see vision/index.ts).
    const persistedText = images && images.length > 0
      ? `[Image] ${text}`
      : text;
    appendToConversation(threadTs, channelId, { role: 'user', content: persistedText, ts });

    // ── Load actual Slack thread replies and merge with DB history ──────────
    // The DB only has messages Maelle processed. In channels/MPIMs she may have
    // missed messages (not mentioned, relevance filtered). Fetch the real thread
    // so Claude has the full picture.
    let history = dbHistory;
    if (threadTs !== ts) {
      try {
        const threadReplies = await client.conversations.replies({
          token: assistant.slack.bot_token,
          channel: channelId,
          ts: threadTs,
          limit: 50,
        });
        const slackMessages = ((threadReplies.messages as any[]) ?? [])
          .filter(m => m.user && m.text);

        // Find messages in Slack but NOT in our DB (by timestamp)
        const dbTimestamps = new Set(dbHistory.filter(m => m.ts).map(m => m.ts));
        const missedMessages = slackMessages
          .filter(m => !dbTimestamps.has(m.ts) && m.ts !== ts)  // exclude current message
          .map(m => ({
            role: (m.user === botUserId ? 'assistant' : 'user') as 'user' | 'assistant',
            content: m.text as string,
            ts: m.ts as string,
          }));

        if (missedMessages.length > 0) {
          // Merge: combine DB history (has tool summaries) with missed Slack messages
          const merged = [...dbHistory, ...missedMessages].sort((a, b) => {
            const tsA = parseFloat(a.ts || '0');
            const tsB = parseFloat(b.ts || '0');
            return tsA - tsB;
          });
          history = merged;
          logger.info('Thread messages merged from Slack', {
            channelId,
            threadTs,
            dbCount: dbHistory.length,
            missedCount: missedMessages.length,
            mergedCount: merged.length,
          });
        }
      } catch (err) {
        logger.warn('Could not fetch Slack thread replies — using DB history only', { err: String(err), channelId, threadTs });
      }
    }

    // v1.7.6 — read-receipt reaction is added LATER (after the addressee gate).
    // Previously it fired here, before the gate, so silenced messages still got
    // the :eyes: emoji — confusing the user ("she read it but said nothing").
    // Now: react only when we're going to actually respond.
    const readEmoji = (threadTs === ts) ? 'thread' : 'eyes';
    const addReadReceipt = () => {
      client.reactions.add({ channel: channelId, timestamp: ts, name: readEmoji }).catch(() => {});
    };

    try {

      // For colleagues, resolve their real name so the orchestrator can pass it
      // into the system prompt as `senderName`. We deliberately do NOT prepend
      // any `<<FROM ...>>` or `[From: ...]` wrapper to the raw text — every such
      // marker we've tried either collides with the injection scanner's
      // owner_spoof regex or gets flagged by the Haiku coord judge as
      // "suspicious paste mimicking system syntax" (we create our own false
      // positives). The orchestrator already knows who's speaking via
      // `senderName` + the authorization line in the system prompt.
      const userMessage = text;
      let colleagueName: string | undefined;
      if (role === 'colleague' && !isOwnerInGroup) {
        try {
          const senderInfo = await client.users.info({ token: assistant.slack.bot_token, user: senderId });
          colleagueName = (senderInfo.user as any)?.real_name || (senderInfo.user as any)?.name;
        } catch (_) {}
      }

      // ── Group-DM addressee gate ──────────────────────────────────────────
      // In a group DM / channel, not every message is for Maelle. Run a
      // cheap Haiku classifier; stay silent when the message was addressed
      // to a human (or is genuinely ambiguous). Skip for 1:1 DMs.
      if ((isMpim === true || isChannel === true) && botUserId) {
        // v1.7.5 — same fix as the MPIM relevance gate: when Maelle was the
        // most recent or second-most-recent speaker in this thread, skip the
        // addressee gate entirely. The next message is almost always a
        // continuation. The gate was incorrectly silencing your three
        // explicit "@Maelle she said yes, but using Elal" messages with
        // verdict HUMAN despite the @-mention.
        const maelleRecentlySpoke = history.slice(-3).some(m => m.role === 'assistant');
        if (maelleRecentlySpoke) {
          logger.info('Addressee gate skipped — Maelle was just active in this thread', {
            channelId,
            threadTs,
            senderId,
            historySize: history.length,
            preview: text.slice(0, 100),
          });
        } else try {
          const { classifyAddressee } = await import('../../utils/addresseeGate');
          const botId: string = botUserId;
          const recent = history.slice(-4).map(h => {
            const who = h.role === 'assistant' ? assistant.name : (h.role === 'user' ? 'User' : h.role);
            return `${who}: ${(h.content ?? '').slice(0, 200)}`;
          });
          // Resolve member names for context (best-effort; skip on failure)
          let humanNames: string[] = [];
          if (mpimMemberIds?.length) {
            try {
              humanNames = (await Promise.all(
                mpimMemberIds
                  .filter(id => id !== botId)
                  .map(async id => {
                    try {
                      const info = await client.users.info({ token: assistant.slack.bot_token, user: id });
                      return (info.user as any)?.real_name || (info.user as any)?.name || '';
                    } catch { return ''; }
                  }),
              )).filter(Boolean);
            } catch { /* best-effort */ }
          }
          // v1.8.8 — strip the "<<GROUP DM — participants: ... >>" preamble
          // that app.ts prepends for MPIM context. The preamble bloats the
          // fast-path window (pushes "Maelle" past text.slice(0, 40)) and
          // confuses the Sonnet classifier (it reads "participants: Swan,
          // Dina" and votes HUMAN even when the actual message starts with
          // "Maelle, ..."). The gate should judge the owner/colleague
          // message itself, not Maelle's own framing.
          const textForGate = text.replace(/^<<[\s\S]*?>>\n+/, '');
          const verdict = await classifyAddressee({
            text: textForGate,
            botUserId: botId,
            assistantName: assistant.name,
            ownerFirstName: profile.user.name.split(' ')[0],
            recentContext: recent,
            humanNames,
          });
          logger.info('Addressee gate', {
            verdict,
            channelId,
            threadTs,
            senderId,
            isMpim: isMpim ?? false,
            preview: text.slice(0, 120),
          });
          if (verdict === 'HUMAN' || verdict === 'AMBIGUOUS') {
            // Stay silent. AMBIGUOUS is logged at info level (above) for auditing.
            if (verdict === 'AMBIGUOUS') {
              logger.info('Addressee gate: AMBIGUOUS — staying silent by default', {
                channelId, threadTs, senderId, preview: text.slice(0, 200),
                humanNames, recentContext: recent,
              });
            }
            return;
          }
        } catch (err) {
          logger.warn('Addressee gate threw — proceeding with orchestrator', { err: String(err) });
        }
      }

      // v1.7.3 — when there's an active iterating summary session for this
      // thread + this is the owner replying, force classify_summary_feedback
      // as the first tool call. Prevents Sonnet from defaulting to the more
      // familiar learn_preference (wrong category) and ensures the multi-intent
      // classifier catches every distinct ask in the message.
      // Guard: only force the tool when the SummarySkill is actually enabled
      // in the profile — otherwise the tool isn't in the registered tools list
      // and Anthropic returns a 400. Defense-in-depth alongside the Stage 1
      // toggle gate.
      let forceToolOnFirstTurn: { name: string } | undefined;
      if (role === 'owner' && !isChannel) {
        const summaryActive = ((profile.skills as any)?.summary === true || (profile.skills as any)?.meeting_summaries === true);
        if (summaryActive) {
          const summarySession = getSummarySessionByThread(threadTs);
          if (summarySession && summarySession.stage === 'iterating') {
            forceToolOnFirstTurn = { name: 'classify_summary_feedback' };
            logger.info('Summary session active — forcing classify_summary_feedback', {
              threadTs,
              summarySessionId: summarySession.id,
            });
          }
        } else if (getSummarySessionByThread(threadTs)?.stage === 'iterating') {
          // Stale session from when skill was on; warn but don't crash
          logger.warn('Iterating summary session exists but summary skill is disabled — skipping force-tool', {
            threadTs,
          });
        }
      }

      // v1.7.6 — gate cleared, we're going to respond. Add the read receipt NOW
      // so the user sees the eye emoji exactly when Maelle is committing to a reply.
      addReadReceipt();

      // v2.0.2 — if a social question was asked in this thread's previous turn,
      // classify whether the user's reply was engaged and upgrade topic quality.
      // Fires before orchestrator so the upgrade lands in people_memory before
      // the next social-context block is built for this turn.
      try {
        const { checkAndUpgradeEngagement } = await import('../../core/socialEngagement');
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        await checkAndUpgradeEngagement({ threadTs, userReply: text, anthropic: new Anthropic() });
      } catch (err) {
        logger.warn('socialEngagement — pre-orchestrator check failed', { err: String(err).slice(0, 200) });
      }

      logger.info('Calling orchestrator', { senderId, role, channelId, threadTs, isOwnerInGroup: isOwnerInGroup ?? false, historyLength: history.length, imageCount: images?.length ?? 0, forceTool: forceToolOnFirstTurn?.name });
      const result = await runOrchestrator({
        userMessage,
        conversationHistory: history,
        threadTs,
        channelId,
        userId: senderId,
        senderRole: role,
        senderName: colleagueName,
        channel: 'slack' as ChannelId,
        profile,
        app,
        isMpim,
        isOwnerInGroup,
        mpimMemberIds,
        images,
        forceToolOnFirstTurn,
      });
      logger.info('Orchestrator completed', { senderId, threadTs, hasApproval: result.requiresApproval, actionCount: result.slackActions?.length ?? 0 });

      // ── Reply pipeline (v1.6.2) ──────────────────────────────────────────────
      // normalize → owner claim-check (+ retry) → colleague security gate →
      // audio-or-text send → optional approval footer. Full flow lives in
      // postReply.ts so changes don't force re-reading this 1200-line file.
      const { postOrchestratorReply } = await import('./postReply');
      await postOrchestratorReply({
        app,
        profile,
        result,
        say: say as (msg: { text: string; thread_ts?: string }) => Promise<unknown>,
        role,
        colleagueName,
        senderId,
        channelId,
        threadTs,
        history,
        userMessage,
        isMpim,
        isOwnerInGroup,
        mpimMemberIds,
        voiceInput,
      });

      // ── Dispatch background Slack actions AFTER reply is delivered ───────────
      // These are fire-and-forget — owner already got their reply above.
      // find_slack_user is the only exception: its result feeds back into context.
      if (result.slackActions && result.slackActions.length > 0) {
        for (const action of result.slackActions) {
          // find_slack_user must stay synchronous — result feeds into conversation context
          if (action.action === 'find_slack_user') {
            try {
              const users = await findSlackUser(app, assistant.slack.bot_token, action.name as string);
              appendToConversation(threadTs, channelId, {
                role: 'assistant',
                content: users.length > 0
                  ? `Found: ${users.map((u: any) => `${u.real_name} (ID: ${u.id}, tz: ${u.tz})`).join(', ')}`
                  : `No Slack user found matching "${action.name}". Ask the user to @mention them.`,
              });
            } catch (err) {
              logger.error('Slack action failed', { err, action: action.action });
            }
            continue;
          }

          // All other actions are truly fire-and-forget
          (async () => {
            try {
              if (action.action === 'coordinate_meeting') {
                await initiateCoordination({
                  ownerUserId: action.ownerUserId as string,
                  ownerChannel: channelId,
                  ownerThreadTs: threadTs,
                  ownerName: action.ownerName as string,
                  ownerEmail: action.ownerEmail as string,
                  ownerTz: action.ownerTz as string,
                  subject: action.subject as string,
                  topic: action.topic as string | undefined,
                  durationMin: action.durationMin as number,
                  participants: action.participants as any[],
                  proposedSlots: action.proposedSlots as SlotWithLocation[],
                  profile,
                  mpimMemberIds: mpimMemberIds,
                  needsDurationApproval: action.needsDurationApproval as boolean | undefined,
                  isUrgent: action.isUrgent as boolean | undefined,
                  senderRole: action._senderRole as 'owner' | 'colleague' | undefined,
                  senderUserId: action._senderUserId as string | undefined,
                });
              } else if (action.action === 'finalize_coord_meeting') {
                const result = await forceBookCoordinationByOwner(
                  action.job_id as string,
                  action.slot_iso as string,
                  profile,
                );
                if (!result.ok) {
                  await app.client.chat.postMessage({
                    token: assistant.slack.bot_token,
                    channel: channelId,
                    thread_ts: threadTs,
                    text: `Couldn't finalize that booking — ${result.reason ?? 'unknown error'}.`,
                  });
                }
              }
              // v1.8.11 — `send_outreach_dm` and `post_to_channel` actions
              // removed: message_colleague now sends synchronously inside
              // its tool handler via Connection.
            } catch (err) {
              logger.error('Slack action failed', { err, action: action.action });
            }
          })();
        }
      }

    } catch (err) {
      logger.error('Failed to process message', { err, assistant: assistant.name, channelId });
      const text = isOverloadError(err)
        ? `Quick coffee break, ping me again in a couple of minutes?`
        : `Something's off on my end, give me a minute and try again?`;
      await say({ text, thread_ts: threadTs });
    }
  }

  // ── Image file_share helper (v1.7.1) ──────────────────────────────────────
  // Owner-only image input. Downloads each image, runs the injection guard
  // (logs + shadow-notifies suspicious content but proceeds — owner is trusted),
  // builds Anthropic image blocks, then hands off to processMessage with the
  // images attached. Used by both the DM and MPIM handlers.
  //
  // Caps at 4 images per turn for sanity. Slack file_share usually has 1.
  async function processImageFileShare(params: {
    files: any[];
    message: any;
    channelId: string;
    ts: string;
    threadTs: string;
    client: typeof app.client;
    isMpim: boolean;
    mpimMemberIds?: string[];
  }): Promise<void> {
    const { files, message, channelId, ts, threadTs, client, isMpim, mpimMemberIds } = params;

    const imageFiles = files.filter((f: any) =>
      typeof f.mimetype === 'string' && f.mimetype.startsWith('image/'),
    );
    if (imageFiles.length === 0) return;

    const toProcess = imageFiles.slice(0, 4);
    if (imageFiles.length > 4) {
      logger.warn('Image file_share with >4 images — processing first 4 only', {
        total: imageFiles.length,
      });
    }

    const images: AnthropicImageBlock[] = [];
    for (const f of toProcess) {
      const dl = await downloadSlackImage(f.url_private, assistant.slack.bot_token, f.mimetype);
      if ('error' in dl) {
        logger.warn('Image download failed', {
          error: dl.error, detail: dl.detail, filetype: f.filetype,
        });
        const friendly = dl.error === 'too_large'
          ? `That image is a bit big for me to look at — could you try a smaller version?`
          : dl.error === 'unsupported_type'
          ? `I can only look at JPEG, PNG, GIF, or WebP images — that file type doesn't work for me.`
          : `I couldn't open that image. Try sending it again?`;
        try {
          await client.chat.postMessage({
            token: assistant.slack.bot_token,
            channel: channelId,
            thread_ts: threadTs,
            text: friendly,
          });
        } catch (_) {}
        return;
      }

      // Image guard: scan for instruction-like text. v1.7.1 owner path =
      // log + shadow-notify but proceed (owner is trusted). When colleague
      // path opens, flip this to refuse + notify.
      const scan = await scanImageForInjection(dl);
      if (scan.suspicious) {
        logger.warn('⚠ SECURITY — image flagged as suspicious (v1.7.1 owner path: log + proceed)', {
          senderId: message.user,
          channelId,
          reason: scan.reason,
          extractedTextPreview: scan.extractedText?.slice(0, 200),
        });
        try {
          await shadowNotify(profile, {
            channel: channelId,
            threadTs,
            action: '⚠ Image guard: suspicious content',
            detail: `Reason: ${scan.reason ?? 'unknown'}. Extract: "${scan.extractedText?.slice(0, 200) ?? '(none)'}"`,
          });
        } catch (_) {}
      }

      images.push(buildImageBlock(dl));
    }

    if (images.length === 0) return;

    // Caption: Slack stuffs the user's typed text into event.text / message.text
    const captionText = ((message.text as string | undefined) ?? '').trim();
    const messageText = captionText || '(image attached, no caption)';

    const sayFn = async (msgOrText: any) => {
      const txt = typeof msgOrText === 'string' ? msgOrText : msgOrText.text;
      await client.chat.postMessage({
        token: assistant.slack.bot_token,
        channel: channelId,
        thread_ts: threadTs,
        text: txt,
      });
    };

    await processMessage({
      senderId: message.user!,
      text: messageText,
      channelId,
      ts,
      threadTs,
      say: sayFn,
      client,
      isChannel: false,
      isMpim,
      mpimMemberIds,
      images,
    });
  }

  // Helper: detect Anthropic API "overloaded" errors (529) so we can surface
  // a human "coffee break" message instead of generic "something broke".
  function isOverloadError(err: unknown): boolean {
    const s = String((err as any)?.error?.error?.type ?? '');
    const msg = String(err ?? '');
    if (s === 'overloaded_error') return true;
    if ((err as any)?.status === 529) return true;
    return /overloaded|rate[_ ]?limit/i.test(msg);
  }

  // Helper: narrate a KB ingest result to the owner in-thread.
  async function postIngestResult(
    result: Awaited<ReturnType<typeof import('../../skills/knowledge').ingestKnowledgeDoc>>,
    say: (text: string) => Promise<void>,
  ): Promise<void> {
    if (result.kind === 'created' && result.sectionId) {
      await say(`Filed under \`${result.sectionId}.md\`, ${result.summary || result.title || 'saved'}. Want it renamed or moved? Just tell me.`);
    } else if (result.kind === 'merged' && result.sectionId) {
      await say(`Added to your existing \`${result.sectionId}.md\`, ${result.summary || 'merged under a new update section'}.`);
    } else if (result.kind === 'sibling' && result.sectionId) {
      await say(`Filed as \`${result.sectionId}.md\` (sibling of a related section), ${result.summary || result.title || 'saved'}.`);
    } else if (result.kind === 'ambiguous') {
      await say(result.question || `Not sure where to file this. Want to give me a hint?`);
    } else if (result.kind === 'rejected') {
      if (result.reason === 'too_short' || result.reason === 'empty_condensed') {
        await say(`That file's too thin to keep as a standalone reference, was it clipped?`);
      } else if (result.reason === 'classifier_error') {
        await say(`I hit an issue classifying that, give me a moment and try again?`);
      } else {
        await say(`I don't think this is worth keeping in the knowledge base (${result.reason || 'not a clear knowledge doc'}). Let me know if I got that wrong.`);
      }
    }
  }

  // ── Handler 1: Direct messages (1:1 DM) ──────────────────────────────────
  // Fires for every message in a 1:1 DM with Maelle — no mention needed
  app.message(async ({ message, say, client }) => {
    // Allow file_share subtype (audio messages) — block everything else
    const subtype = (message as any).subtype;
    if (subtype && subtype !== 'file_share') return;
    if (!('user' in message) || !message.user) return;

    // channelId must be defined before any use
    const channelId = message.channel;

    // Only handle 1:1 DMs here
    if (!is1on1DM(channelId)) return;

    const senderRole1v1 = getSenderRole(message.user!);
    logger.info('1:1 DM received', { senderId: message.user, channelId, role: senderRole1v1, subtype: subtype ?? 'text' });

    // Handle audio + image + transcript file_shares
    if (subtype === 'file_share') {
      const files = (message as any).files as any[] | undefined;
      const ts = message.ts;
      const threadTs = ('thread_ts' in message && (message as any).thread_ts)
        ? (message as any).thread_ts as string
        : ts;

      // Document branch (v2.0.2, multi-file in v2.0.7) — owner-only. Every
      // .txt/.md/.pdf in the upload gets processed sequentially (not in
      // parallel — Anthropic rate limits + we want deterministic thread
      // order). Each file posts its own confirmation in the thread. The
      // classifier inside ingestKnowledgeDoc decides transcript vs
      // knowledge_doc vs other per file:
      //   - transcript → existing SummarySkill flow (requires summary: true)
      //   - knowledge_doc → file under KB (requires knowledge: true)
      //   - other → polite refusal
      const docFiles = (files ?? []).filter((f: any) => {
        const mt = String(f.mimetype || '');
        const ft = String(f.filetype || '');
        return mt === 'text/plain' || mt === 'text/markdown' || mt === 'application/pdf'
          || ft === 'text' || ft === 'txt' || ft === 'markdown' || ft === 'md' || ft === 'pdf';
      });
      if (docFiles.length > 0 && senderRole1v1 === 'owner') {
        const summaryActive = ((profile.skills as any)?.summary === true || (profile.skills as any)?.meeting_summaries === true);
        const knowledgeActive = ((profile.skills as any)?.knowledge === true || (profile.skills as any)?.knowledge_base === true);

        logger.info('Document files received in DM', {
          channel: channelId,
          user: message.user,
          count: docFiles.length,
          files: docFiles.map((f: any) => ({ filetype: f.filetype, mimetype: f.mimetype, size: f.size })),
        });
        client.reactions.add({ channel: channelId, timestamp: message.ts, name: 'thread' }).catch(() => {});
        setImmediate(async () => {
          const saySafe = async (text: string) => {
            try {
              await client.chat.postMessage({
                token: assistant.slack.bot_token,
                channel: channelId,
                thread_ts: threadTs,
                text,
              });
            } catch (_) {}
          };

          const caption = ((message as any).text as string | undefined)?.trim() ?? '';

          const processOneDoc = async (docFile: any, index: number, total: number): Promise<void> => {
            const isPdf = String(docFile.mimetype || '') === 'application/pdf' || String(docFile.filetype || '') === 'pdf';
            const fileLabel = docFile.name || docFile.title || `file ${index + 1}`;
            const prefix = total > 1 ? `[${index + 1}/${total}] ${fileLabel}: ` : '';
            try {
              const dl = await fetch(docFile.url_private, {
                headers: { Authorization: `Bearer ${assistant.slack.bot_token}` },
              });
              if (!dl.ok) {
                logger.warn('Doc download failed', { status: dl.status, file: fileLabel });
                await saySafe(`${prefix}Couldn't open that one, try sending it again?`);
                return;
              }

              let text: string;
              if (isPdf) {
                try {
                  const buf = Buffer.from(await dl.arrayBuffer());
                  const { PDFParse } = await import('pdf-parse');
                  const parser = new PDFParse({ data: buf });
                  const parsed = await parser.getText();
                  text = parsed.text || '';
                } catch (err) {
                  logger.warn('PDF parse failed', { err: String(err).slice(0, 200), file: fileLabel });
                  await saySafe(`${prefix}Couldn't read that PDF (maybe scanned images or encrypted). Send a text version?`);
                  return;
                }
              } else {
                text = await dl.text();
              }

              if (text.trim().length < 50) {
                await saySafe(`${prefix}Looks empty, was the export complete?`);
                return;
              }

              const sourceHint = fileLabel;
              if (!isPdf) {
                const Anthropic = (await import('@anthropic-ai/sdk')).default;
                const anthropic = new Anthropic();
                const { ingestKnowledgeDoc } = await import('../../skills/knowledge');
                const ingestResult = await ingestKnowledgeDoc({
                  profile,
                  text,
                  sourceHint,
                  ownerCaption: caption || undefined,
                  anthropic,
                });

                if (ingestResult.kind === 'rejected' && ingestResult.reason === 'transcript') {
                  if (!summaryActive) {
                    await saySafe(`${prefix}Looks like a meeting transcript. To summarize meetings, enable \`summary: true\` in your profile and restart me.`);
                    return;
                  }
                  const { ingestTranscriptUpload } = await import('../../skills/summary');
                  const result = await ingestTranscriptUpload({
                    text,
                    caption,
                    ownerUserId: profile.user.slack_user_id,
                    threadTs,
                    channelId,
                    profile,
                  });
                  const preface = result.kind === 'created'
                    ? `Here's a draft, let me know what to change before we send it out.`
                    : result.kind === 'overridden_new_meeting'
                      ? `New transcript noted, replacing the previous one with this draft.`
                      : `Got your edits, here's the updated version.`;
                  await saySafe(`${prefix}${preface}\n\n${result.rendered}`);
                  appendToConversation(threadTs, channelId, {
                    role: 'assistant',
                    content: `[Summary draft posted]\n${result.rendered}`,
                    ts: undefined,
                  });
                  return;
                }

                if (!knowledgeActive) {
                  await saySafe(`${prefix}I'd file this under your knowledge base, but \`knowledge\` is off in your profile. Flip it on and restart me.`);
                  return;
                }
                await postIngestResult(ingestResult, async (t) => saySafe(`${prefix}${t}`));
                return;
              }

              // PDF path — direct knowledge ingest
              if (!knowledgeActive) {
                await saySafe(`${prefix}I can't file PDFs yet because \`knowledge\` is off in your profile. Flip it on and restart me.`);
                return;
              }
              const Anthropic = (await import('@anthropic-ai/sdk')).default;
              const anthropic = new Anthropic();
              const { ingestKnowledgeDoc } = await import('../../skills/knowledge');
              const result = await ingestKnowledgeDoc({
                profile,
                text,
                sourceHint,
                ownerCaption: caption || undefined,
                anthropic,
              });
              await postIngestResult(result, async (t) => saySafe(`${prefix}${t}`));
            } catch (err) {
              logger.error('Doc ingestion failed', { err: String(err).slice(0, 400), file: fileLabel });
              const msg = isOverloadError(err)
                ? `${prefix}Quick coffee break, ping me again in a couple of minutes?`
                : `${prefix}Something jammed on my end, try that one again in a minute?`;
              await saySafe(msg);
            }
          };

          // Sequential loop — each file gets its own confirmation.
          for (let i = 0; i < docFiles.length; i++) {
            await processOneDoc(docFiles[i], i, docFiles.length);
          }
        });
        return;
      }

      // Image branch (v1.7.1) — owner-only by convention (DM with the bot is
      // owner-only in practice; the helper applies the injection guard regardless).
      const hasImage = files?.some((f: any) =>
        typeof f.mimetype === 'string' && f.mimetype.startsWith('image/'),
      );
      if (hasImage) {
        logger.info('Image message received in DM', { channel: channelId, user: message.user });
        setImmediate(() => {
          processImageFileShare({
            files: files!,
            message,
            channelId,
            ts,
            threadTs,
            client,
            isMpim: false,
          }).catch(err => logger.error('Image handling error', { err: String(err) }));
        });
        return;
      }

      // Audio branch (multi-file in v2.0.7). Every audio file in the upload
      // gets transcribed sequentially; each transcription turns into its own
      // processMessage call so the orchestrator answers each one in order.
      const audioFiles = (files ?? []).filter((f: any) =>
        f.mimetype?.startsWith('audio/') || f.filetype === 'mp4' || f.filetype === 'webm'
      );
      if (audioFiles.length === 0) {
        logger.warn('file_share but no audio/image/doc file found', { files: files?.map((f:any) => f.filetype) });
        return;
      }
      if (!config.OPENAI_API_KEY) {
        logger.warn('OPENAI_API_KEY not set — cannot transcribe');
        return;
      }
      logger.info('Audio messages received', { channel: channelId, user: message.user, count: audioFiles.length });
      setImmediate(async () => {
        const sayFn = async (msgOrText: any) => {
          const txt = typeof msgOrText === 'string' ? msgOrText : msgOrText.text;
          await client.chat.postMessage({ token: assistant.slack.bot_token, channel: channelId, thread_ts: threadTs, text: txt });
        };
        for (let i = 0; i < audioFiles.length; i++) {
          const audioFile = audioFiles[i];
          try {
            const text = await transcribeSlackAudio(audioFile.url_private, assistant.slack.bot_token, undefined, audioFile.mimetype);
            if (!text || text.length < 2) continue;
            logger.info('Voice message transcribed', { preview: text.slice(0, 80), index: i });
            // Prefix with [Voice message]: so the orchestrator's VOICE LANGUAGE
            // OVERRIDE rule fires. processMessage persists the text via
            // appendToConversation, so no pre-append needed.
            await processMessage({ senderId: message.user!, text: `[Voice message]: ${text}`, channelId, ts, threadTs, say: sayFn, client, isChannel: false, isMpim: false, voiceInput: true });
          } catch (err) {
            logger.error('Voice message handling error', { err: String(err), index: i });
          }
        }
      });
      return;
    }

    // v1.8.4 — forwarded huddle recap detection. If the owner shares a Slack
    // AI huddle recap via "Share message" (or pastes a huddle transcript
    // into DM), detect it and route to SummarySkill directly instead of the
    // orchestrator. Only triggers on strong signal: substantial text length
    // + at least two huddle-recap keyword markers.
    if (senderRole1v1 === 'owner' && !subtype) {
      const attachmentText = ((message as any).attachments?.[0]?.text as string | undefined) ?? '';
      const bodyText = (message.text ?? '').toString();
      const candidate = attachmentText.length > bodyText.length ? attachmentText : bodyText;

      const HUDDLE_KEYWORDS = ['summary', 'action items', 'huddle', 'transcript', 'key points', 'highlights', 'takeaways', 'next steps', 'discussion'];
      const candidateLower = candidate.toLowerCase();
      const hitCount = HUDDLE_KEYWORDS.filter(kw => candidateLower.includes(kw)).length;
      const looksLikeRecap = candidate.length >= 300 && hitCount >= 2;

      if (looksLikeRecap) {
        const summaryActive = ((profile.skills as any)?.summary === true || (profile.skills as any)?.meeting_summaries === true);
        if (!summaryActive) {
          logger.info('Forwarded huddle recap detected but summary skill disabled', { channel: channelId });
        } else {
          const ts = message.ts;
          const threadTs = ('thread_ts' in message && (message as any).thread_ts)
            ? (message as any).thread_ts as string
            : ts;
          logger.info('Forwarded huddle recap detected — ingesting', {
            channel: channelId,
            length: candidate.length,
            keywordHits: hitCount,
            source: attachmentText.length > bodyText.length ? 'attachment' : 'body',
          });
          setImmediate(async () => {
            try {
              // Caption: if message body is short, use it as the hint; otherwise no caption
              const caption = attachmentText.length > bodyText.length ? bodyText.trim() : '';
              const { ingestTranscriptUpload } = await import('../../skills/summary');
              const result = await ingestTranscriptUpload({
                text: candidate,
                caption,
                ownerUserId: profile.user.slack_user_id,
                threadTs,
                channelId,
                profile,
              });
              const preface = result.kind === 'created'
                ? `Got the huddle recap. Here's a draft summary — let me know what to change.`
                : result.kind === 'overridden_new_meeting'
                  ? `New huddle recap noted. Here's the draft for this one.`
                  : `Got your edits — here's the updated version.`;
              await client.chat.postMessage({
                token: assistant.slack.bot_token,
                channel: channelId,
                thread_ts: threadTs,
                text: `${preface}\n\n${result.rendered}`,
              });
              appendToConversation(threadTs, channelId, {
                role: 'assistant',
                content: `[Summary draft posted]\n${result.rendered}`,
                ts: undefined,
              });
            } catch (err) {
              logger.error('Huddle recap ingestion failed', { err: String(err) });
              try {
                await client.chat.postMessage({
                  token: assistant.slack.bot_token,
                  channel: channelId,
                  thread_ts: threadTs,
                  text: `Couldn't summarize that recap cleanly, try again in a minute?`,
                });
              } catch (_) {}
            }
          });
          return;
        }
      }
    }

    if (!message.text) return;

    // Skip self-mentions only in channels — in DMs, respond regardless
    // (app_mention doesn't fire in DMs, so we'd lose the message otherwise)
    if (containsSelfMention(message.text!) && !is1on1DM(channelId)) return;

    const ts       = message.ts;
    const threadTs = ('thread_ts' in message && message.thread_ts) ? message.thread_ts : ts;

    // Dedup — Slack retries if we're slow; skip if already processing this message
    if (!markProcessed(ts)) { logger.debug('DM dedup — skipping retry', { ts }); return; }

    // Process async — return to Bolt immediately to avoid 3s timeout
    const rawText = message.text!.trim();
    setImmediate(async () => {
      const resolvedText = await resolveSlackMentions(rawText);
      processMessage({
        senderId: message.user!,
        text: resolvedText,
        channelId,
        ts,
        threadTs,
        say,
        client,
        isChannel: false,
        isMpim: false,
      }).catch(err => logger.error('processMessage error', { err }));
    });
  });

  // ── Handler 2: Group DMs / MPIM ───────────────────────────────────────────
  // Fires for messages in multi-person DMs — no mention needed
  app.event('message', async ({ event, say, client }) => {
    if (!('channel_type' in event)) return;
    // Accept native MPIM channel_type, OR modern Slack group DMs that arrive as
    // 'channel' with a C-prefixed ID — verified via conversations.info `is_mpim`.
    // Without the second branch, group-DM replies that don't @-mention the bot
    // (e.g. "Yes, that works for me") are silently dropped.
    if (event.channel_type !== 'mpim' && event.channel_type !== 'channel') return;
    if (!('user' in event) || !event.user) return;

    // ── Image file_share (v1.7.1) — OWNER ONLY in MPIM ───────────────────────
    // Has to run BEFORE the text-empty check below: an image can arrive
    // without a caption. Colleagues' images are silently dropped in v1.7.1.
    if ('subtype' in event && event.subtype === 'file_share') {
      const eventFiles = (event as any).files as any[] | undefined;
      const hasImage = eventFiles?.some((f: any) =>
        typeof f.mimetype === 'string' && f.mimetype.startsWith('image/'),
      );
      if (hasImage) {
        if (event.user !== profile.user.slack_user_id) {
          logger.info('MPIM image from non-owner — dropped (v1.7.1: owner-only)', {
            senderId: event.user,
            channelId: event.channel,
            fileCount: eventFiles!.length,
          });
          return;
        }
        // Confirm this isn't a real channel masquerading as MPIM
        if (event.channel_type === 'channel') {
          try {
            const ch = (await client.conversations.info({
              token: assistant.slack.bot_token,
              channel: event.channel as string,
            })).channel as any;
            if (ch?.is_mpim !== true) return;
          } catch (err) {
            logger.warn('conversations.info failed during MPIM image check — skipping', { err: String(err) });
            return;
          }
        }

        const ts = event.ts;
        const threadTs = ('thread_ts' in event && event.thread_ts) ? event.thread_ts as string : ts;

        // Load mpimMemberIds so the orchestrator knows the group composition
        let mpimMemberIds: string[] | undefined;
        try {
          const membersRes = await client.conversations.members({
            token: assistant.slack.bot_token,
            channel: event.channel as string,
          });
          mpimMemberIds = ((membersRes.members as string[]) ?? []).filter(id => id !== botUserId);
        } catch (err) {
          logger.warn('Could not fetch MPIM members for image turn — proceeding without', { err: String(err) });
        }

        logger.info('Image message received in MPIM (owner)', {
          channel: event.channel, user: event.user, fileCount: eventFiles!.length,
        });
        setImmediate(() => {
          processImageFileShare({
            files: eventFiles!,
            message: event,
            channelId: event.channel as string,
            ts,
            threadTs,
            client,
            isMpim: true,
            mpimMemberIds,
          }).catch(err => logger.error('MPIM image handling error', { err: String(err) }));
        });
        return;
      }
    }

    if (!('text' in event) || !event.text) return;
    if ('subtype' in event && event.subtype && event.subtype !== 'file_share') return;

    if (event.channel_type === 'channel') {
      try {
        const ch = (await client.conversations.info({
          token: assistant.slack.bot_token,
          channel: event.channel as string,
        })).channel as any;
        if (ch?.is_mpim !== true) return; // real channel — only app_mention should respond
      } catch (err) {
        logger.warn('conversations.info failed — cannot confirm MPIM, skipping', { err: String(err), channelId: event.channel });
        return;
      }
    }

    logger.info('MPIM message received', { senderId: event.user, channelId: event.channel, channelType: event.channel_type, preview: (event.text as string).slice(0, 80) });

    // Skip messages with @mentions — app_mention handles those to avoid double-firing
    if (containsSelfMention(event.text as string)) return;

    const ts       = event.ts;
    const threadTs = ('thread_ts' in event && event.thread_ts) ? event.thread_ts as string : ts;

    // Dedup — same ts = Slack retry, skip it
    if (!markProcessed(ts)) { logger.debug('MPIM dedup — skipping retry', { ts }); return; }

    setImmediate(async () => {
      const rawText = (event.text as string).trim();

      // ── Fetch group members — needed for relevance check, response context, and coordination ──
      // Collect ALL member IDs (excluding bot) for coordination flow (who's in this DM?)
      // and names for relevance classifier and group context.
      let groupContext = '';
      const mpimMemberNames: string[] = [];
      const mpimMemberIds: string[] = [];
      try {
        const membersRes = await client.conversations.members({
          token: assistant.slack.bot_token,
          channel: event.channel as string,
        });
        const allMemberIds = ((membersRes.members as string[]) ?? []).filter(id => id !== botUserId);
        mpimMemberIds.push(...allMemberIds);
        logger.info('MPIM members loaded', { channelId: event.channel, memberCount: allMemberIds.length, memberIds: allMemberIds });

        const otherIds = allMemberIds.filter(id => id !== event.user);
        if (otherIds.length > 0) {
          const nameEntries: string[] = [];
          for (const id of otherIds) {
            try {
              const info = await client.users.info({ token: assistant.slack.bot_token, user: id });
              const u = info.user as any;
              const name = u?.real_name || u?.name || id;
              if (id !== profile.user.slack_user_id) {
                upsertPersonMemory({ slackId: id, name, email: u?.profile?.email, timezone: u?.tz });
              }
              nameEntries.push(`${name} (slack_id: ${id})`);
              mpimMemberNames.push(name);
            } catch (_) {
              nameEntries.push(id);
              mpimMemberNames.push(id);
            }
          }
          // Rich context: who is in the DM, who sent this message, what Maelle's role is.
          // This ensures Claude addresses all group members, not just the owner.
          const senderInfo = await client.users.info({ token: assistant.slack.bot_token, user: event.user as string }).catch(() => null);
          const senderName = (senderInfo?.user as any)?.real_name || (senderInfo?.user as any)?.name || 'the sender';
          // Using `<<GROUP DM ...>>` instead of `[GROUP DM ...]` — consistent
          // with the colleague-DM prefix change, and keeps system-added context
          // out of the owner_spoof regex range in utils/coordGuard.ts.
          groupContext =
            `<<GROUP DM — participants: ${nameEntries.join(', ')}. ` +
            `Sender: ${senderName}. ` +
            `All participants can see everything you write. ` +
            `Respond to ALL relevant people in the DM — when addressing a specific person, START your reply with <@their_slack_id> so they get a push notification. ` +
            `Do NOT say "tell her" or "let him know" when they are right here in this conversation.>>\n\n`;
        }
      } catch (err) {
        logger.warn('Could not fetch MPIM members — proceeding without group context', { err: String(err) });
      }

      // ── @mention check — if someone else is @mentioned but NOT the bot, stay silent ──
      // Pattern: <@UXXXXXX> is a Slack @mention
      const mentionPattern = /<@(U[A-Z0-9]+)>/g;
      const mentionedIds = [...rawText.matchAll(mentionPattern)].map(m => m[1]);
      if (mentionedIds.length > 0 && !mentionedIds.includes(botUserId ?? '')) {
        // Message @mentions other people but not the bot — not directed at us
        logger.info('MPIM @mention directed at others, not bot — staying silent', {
          senderId: event.user,
          mentionedIds,
          preview: rawText.slice(0, 80),
        });
        return;
      }

      // ── Relevance check — MPIM rules (different from channels) ───────────────
      // Default: RESPOND. The classifier only suppresses on clear IGNORE conditions.
      // Pass member names so the classifier can correctly evaluate introductions, etc.
      const history         = getConversationHistory(threadTs);
      const assistantActive = history.some(m => m.role === 'assistant');
      // v1.7.5 — when Maelle was the most-recent or second-most-recent speaker,
      // skip the relevance gate entirely. The next message in the thread is
      // almost certainly a continuation of the exchange she's actively in.
      // The gate exists to filter unrelated chatter — that's not the failure
      // mode here, and false negatives (Yael answering Maelle's question →
      // silenced) burn trust harder than false positives.
      const recentlyActive = history.slice(-3).some(m => m.role === 'assistant');
      if (recentlyActive) {
        logger.info('MPIM relevance check skipped — Maelle was just active in this thread', {
          senderId: event.user,
          channelId: event.channel,
          threadTs,
          historySize: history.length,
          preview: rawText.slice(0, 80),
        });
      } else {
        const shouldRespond = await isMessageForAssistant(rawText, assistant.name, assistantActive, mpimMemberNames);
        if (!shouldRespond) {
          logger.info('MPIM relevance check — staying silent', { senderId: event.user, preview: rawText.slice(0, 80) });
          return;
        }
      }

      const resolvedText = await resolveSlackMentions(rawText);

      processMessage({
        senderId: event.user as string,
        text: groupContext + resolvedText,
        channelId: event.channel as string,
        ts,
        threadTs,
        say,
        client,
        isChannel: false,
        isMpim: true,
        mpimMemberIds,
      }).catch(err => logger.error('processMessage error', { err }));
    });
  });

  // ── Handler 3: @mentions in channels and private channels ─────────────────
  // Fires ONLY when @Maelle is explicitly mentioned — she is silent otherwise
  app.event('app_mention', async ({ event, say, client }) => {
    if (!('user' in event) || !event.user) return;

    logger.info('Channel @mention received', { senderId: event.user, channelId: event.channel, threadTs: event.thread_ts ?? event.ts });

    // Strip ONLY this bot's own @mention — keep and resolve other user @mentions
    // so Claude knows who was referenced (e.g. "say hi to @Amazia Keidar")
    let rawText = event.text;
    if (botUserId) {
      rawText = rawText.replace(new RegExp(`<@${botUserId}>`, 'gi'), '').trim();
    } else {
      // Fallback: strip the very first @mention (most likely the bot)
      rawText = rawText.replace(/<@[A-Z0-9]+>/, '').trim();
    }
    const threadTs = event.thread_ts || event.ts;

    // Dedup — Slack retries app_mention too if we're slow
    if (!markProcessed(event.ts)) { logger.debug('mention dedup — skipping retry', { ts: event.ts }); return; }

    setImmediate(async () => {
      // ── Detect "channel" that is actually a group DM (MPIM) ──
      // Modern Slack workspaces give group DMs `C`-prefixed IDs that look like
      // channels. conversations.info is the source of truth: `is_mpim: true`
      // means it's a group DM regardless of the ID shape. If so, we mirror the
      // MPIM handler's behaviour: load member IDs for coord routing, build
      // groupContext, and tell processMessage this is an MPIM so the coord
      // flow posts in the thread instead of DMing each participant.
      let mpimContext = '';
      let mpimMemberIds: string[] | undefined;
      let isMpimChannel = false;
      try {
        const infoRes = await client.conversations.info({
          token: assistant.slack.bot_token,
          channel: event.channel,
        });
        const ch = infoRes.channel as any;
        if (ch?.is_mpim === true) {
          isMpimChannel = true;
          const membersRes = await client.conversations.members({
            token: assistant.slack.bot_token,
            channel: event.channel,
          });
          const allMemberIds = ((membersRes.members as string[]) ?? []).filter(id => id !== botUserId);
          mpimMemberIds = allMemberIds;
          const otherIds = allMemberIds.filter(id => id !== event.user);
          if (otherIds.length > 0) {
            const nameEntries: string[] = [];
            for (const id of otherIds) {
              try {
                const info = await client.users.info({ token: assistant.slack.bot_token, user: id });
                const u = info.user as any;
                const name = u?.real_name || u?.name || id;
                if (id !== profile.user.slack_user_id) {
                  upsertPersonMemory({ slackId: id, name, email: u?.profile?.email, timezone: u?.tz });
                }
                nameEntries.push(`${name} (slack_id: ${id})`);
              } catch (_) {
                nameEntries.push(id);
              }
            }
            const senderInfo = await client.users.info({ token: assistant.slack.bot_token, user: event.user as string }).catch(() => null);
            const senderName = (senderInfo?.user as any)?.real_name || (senderInfo?.user as any)?.name || 'the sender';
            mpimContext =
              `<<GROUP DM — participants: ${nameEntries.join(', ')}. ` +
              `Sender: ${senderName}. ` +
              `All participants can see everything you write. ` +
              `Respond to ALL relevant people in the DM — when addressing a specific person, START your reply with <@their_slack_id> so they get a push notification. ` +
              `Do NOT say "tell her" or "let him know" when they are right here in this conversation.>>\n\n`;
          }
          logger.info('app_mention — detected MPIM channel', { channelId: event.channel, memberCount: allMemberIds.length });
        }
      } catch (err) {
        logger.warn('app_mention — conversations.info failed, treating as regular channel', { err: String(err), channelId: event.channel });
      }

      // ── Load thread participants if this is a reply within an existing thread ──
      // Only people who posted in the thread or were @mentioned — NOT the full channel.
      // Their persona data is loaded so Claude has context about each active participant.
      let threadContext = '';
      if (threadTs !== event.ts) {
        try {
          const replies = await client.conversations.replies({
            token: assistant.slack.bot_token,
            channel: event.channel,
            ts: threadTs,
            limit: 50,
          });
          const threadMessages = (replies.messages as any[]) ?? [];
          const uniqueUserIds = [...new Set(
            threadMessages
              .map(m => m.user as string | undefined)
              .filter((id): id is string => !!id && id !== botUserId)
          )];

          if (uniqueUserIds.length > 0) {
            const nameEntries: string[] = [];
            for (const id of uniqueUserIds) {
              try {
                const info = await client.users.info({ token: assistant.slack.bot_token, user: id });
                const u = info.user as any;
                const name = u?.real_name || u?.name || id;
                nameEntries.push(`${name} (slack_id: ${id})`);
                // Load persona data for each thread participant
                if (id !== profile.user.slack_user_id) {
                  upsertPersonMemory({ slackId: id, name, email: u?.profile?.email, timezone: u?.tz });
                }
              } catch (_) {
                nameEntries.push(id);
              }
            }
            threadContext = `[THREAD PARTICIPANTS: ${nameEntries.join(', ')}]\n\n`;
            logger.info('Channel thread participants loaded', {
              channelId: event.channel,
              threadTs,
              participantCount: uniqueUserIds.length,
            });
          }
        } catch (err) {
          logger.warn('Could not load channel thread participants', { err: String(err), channelId: event.channel, threadTs });
        }
      }

      // Resolve remaining user mentions to "Name (slack_id: ID)" format
      const resolvedText = await resolveSlackMentions(rawText);
      processMessage({
        senderId: event.user!,
        text: mpimContext + threadContext + resolvedText,
        channelId: event.channel,
        ts: event.ts,
        threadTs,
        say,
        client,
        isChannel: !isMpimChannel,
        isMpim: isMpimChannel,
        mpimMemberIds: isMpimChannel ? mpimMemberIds : undefined,
      }).catch(err => logger.error('processMessage error', { err }));
    });
  });

  return app;
}

// ── Approval handler ──────────────────────────────────────────────────────────

async function handleApprovalResponse(
  decision: 'approve' | 'reject',
  approvalId: string,
  say: Function,
  isChannel: boolean,
  threadTs: string,
  profile: UserProfile,
): Promise<void> {
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const item   = resolveApproval(approvalId, status);

  if (!item) {
    const msg = `I couldn't find approval request \`${approvalId}\`. It may have already been resolved.`;
    isChannel ? await say({ text: msg, thread_ts: threadTs }) : await say(msg);
    return;
  }

  auditLog({
    action: `approval_${status}`,
    source: 'slack',
    actor: profile.user.slack_user_id,
    target: approvalId,
    details: { action_type: item.action_type, assistant: profile.assistant.name },
    outcome: 'success',
  });

  const reply = decision === 'approve'
    ? `Got it — I'll go ahead with that now.`
    : `Understood, I'll leave that as is. Let me know if you'd like to explore alternatives.`;

  isChannel ? await say({ text: reply, thread_ts: threadTs }) : await say(reply);

  if (decision === 'approve') {
    // Execute the approved action
    try {
      if (item.action_type === 'cancel' || item.action_type === 'reschedule') {
        const payload = item.payload as Record<string, unknown>;
        if (payload.meeting_id) {
          const { deleteMeeting } = await import('../graph/calendar');
          await deleteMeeting(profile.user.email, payload.meeting_id as string);
          const doneMsg = `Done — "${payload.meeting_subject || 'meeting'}" has been removed from your calendar.`;
          isChannel ? await say({ text: doneMsg, thread_ts: threadTs }) : await say(doneMsg);
        }
      }
      logger.info('Approval executed', { approvalId, actionType: item.action_type });
    } catch (err) {
      logger.error('Approval execution failed', { err, approvalId });
      const errMsg = `I approved the action but hit an error executing it. Please check manually.`;
      isChannel ? await say({ text: errMsg, thread_ts: threadTs }) : await say(errMsg);
    }
  }
}

// ── Proactive messaging ───────────────────────────────────────────────────────
// Phase 3 — push messages to user without them initiating

export async function sendProactiveMessage(
  app: App,
  profile: UserProfile,
  text: string,
): Promise<void> {
  try {
    await app.client.chat.postMessage({
      token: profile.assistant.slack.bot_token,
      channel: profile.user.slack_user_id,
      text,
    });
    auditLog({
      action: 'proactive_message',
      source: 'system',
      actor: profile.assistant.name,
      target: profile.user.slack_user_id,
      details: { preview: text.slice(0, 100) },
      outcome: 'success',
    });
  } catch (err) {
    logger.error('Failed to send proactive message', { err, assistant: profile.assistant.name });
  }
}
