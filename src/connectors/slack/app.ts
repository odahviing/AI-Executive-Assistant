import { App, LogLevel } from '@slack/bolt';
import { config } from '../../config';
import { runOrchestrator } from '../../core/orchestrator';
import { getAnthropicClient } from '../../llm/client';
import { ownerPostedInThread, classifyThreadAction, buildThreadRoster, buildThreadActionDirective } from '../../core/threadActions';
import { isBriefRequest } from '../../core/briefIntent';
import { sendMorningBriefing } from '../../tasks/briefs';
import type { ChannelId } from '../../skills/types';
import type { UserProfile } from '../../config/userProfile';
import {
  getConversationHistory,
  appendToConversation,
  auditLog,
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
import {
  transcribeSlackAudio,
  textToSpeech,
  sendAudioMessage,
  shouldRespondWithAudio,
} from '../../voice';
import {
  downloadSlackImage,
  buildImageBlock,
  describeImage,
  type AnthropicImageBlock,
} from '../../vision';
import { scanImageForInjection } from '../../utils/imageGuard';
import { shadowNotify } from '../../utils/shadowNotify';
import { registerInboundReplay } from './inboundReplayRegistry';
import logger from '../../utils/logger';

/**
 * RESPONSE RULES — Maelle only speaks when spoken to. v3.3.0 routing matrix:
 *
 *   1:1 DM      (D...)              → responds to every message from authorised user
 *   Group DM / MPIM (G...)          → responds when @mentioned, when she was the
 *                                     most-recent active speaker, OR when the
 *                                     addressee-gate / relevance-classifier votes
 *                                     RESPOND. MPIM @Maelle skips the relevance LLM
 *                                     (fast-path, v3.2.5)
 *   Channel — top-of-thread @mention → owner-presence gate applies (CH-2 caveat
 *                                     known); when owner participates, runs the
 *                                     thread-action engine (book / follow_up / other)
 *   Channel — mid-thread @mention   → thread-action engine if the owner is a thread
 *                                     participant (see `core/threadActions/`); otherwise
 *                                     silent. Reading the thread is EPHEMERAL —
 *                                     no people-memory upserts from a real-channel read
 *   Channel — no @mention            → silent
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
    registerConnection(user.slack_user_id, createSlackConnection(app, assistant.slack.bot_token, profile));
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
  const { markProcessed, hasProcessed, markContentProcessed } = require('./processedDedup') as typeof import('./processedDedup');

  // Bot user ID — fetched once at startup, used to detect self-mentions
  let botUserId: string | null = null;
  app.client.auth.test({ token: assistant.slack.bot_token })
    .then(r => { botUserId = r.user_id as string; logger.debug('Bot user ID', { botUserId }); })
    .catch(() => { logger.warn('Could not fetch bot user ID — mention dedup disabled'); });

  // ── Mention resolver ─────────────────────────────────────────────────────
  // Replace <@USERID> with "Real Name (slack_id: USERID)" so Claude can use
  // the Slack ID directly without a separate find_slack_user call.
  // Also saves each resolved person to people_memory for cross-session context.
  async function resolveSlackMentions(text: string): Promise<string> {
    // Clean mailto links: <mailto:email|email> → email
    let resolved = text.replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1');

    // Clean plain angle-bracket links — strip `<URL>` brackets only, no info
    // loss. The `<URL|text>` form is left INTACT (v3.0.5, issue #113): pre-fix
    // we stripped to just the URL and lost the link text, so when the owner
    // typed `@Leor` Slack delivered `<linkedin.com/feed/#|Leor Eliashiv>` and
    // Maelle saw only the URL — then asked "who's behind that LinkedIn link?"
    // Sonnet reads Slack's native `<URL|text>` syntax fine; no normalization
    // needed.
    resolved = resolved.replace(/<(https?:\/\/[^|>]+)>/g, '$1');

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
      // v3.3.x — a mention of the BOT ITSELF renders as just the assistant's
      // name, never "Maelle (slack_id: U0ARK...)". The slack_id is only useful
      // for DMing a person; Maelle never DMs herself, so exposing her own ID
      // into the prompt is pointless AND is the exact token that could get
      // echoed back to a colleague (Ayala 2026-06-12: "@Maelle see above"
      // rendered "Maelle (slack_id: U0ARK5814PQ) see above" into the turn).
      if (userId === botUserId) return assistant.name;
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
    // v3.2.6 (#14) — true when this turn arrived via app_mention (an explicit
    // @Maelle). An explicit mention is unambiguously addressed to her, so the
    // group-DM/channel addressee gate (which silences messages aimed at a human)
    // must be skipped — otherwise a mid-thread thread-action mention, whose bot
    // <@id> was stripped from the text and where Maelle hasn't spoken yet, gets
    // mis-judged HUMAN/AMBIGUOUS and dropped.
    isExplicitMention?: boolean;
    voiceInput?: boolean;      // true if input came from a voice message
    images?: AnthropicImageBlock[];  // v1.7.1 — image content blocks attached to this turn
    imageUrls?: string[];            // v2.5.2 — Slack url_private per attached image, persisted to history so Sonnet can forward via message_colleague.attachments
  }): Promise<void> {
    const { senderId, text, channelId, ts, threadTs, say, client, isChannel, isMpim, isExplicitMention, voiceInput, mpimMemberIds, images, imageUrls } = params;
    const rawRole = getSenderRole(senderId);

    // v3.3.x — a delivered inbound proves the socket is alive RIGHT NOW. Stamp
    // the recovery watermark here (the shared entry for DM/MPIM/mention). The
    // watermark is what scopes on-restart / on-reconnect catch-up to the actual
    // downtime gap instead of a blind 24h window — and stamping on real inbound
    // (never the bare process timer) is what keeps a dead-socket zombie's
    // watermark correctly frozen so its gap is fully recovered.
    try {
      const { stampSocketAlive } = require('./socketWatermark') as typeof import('./socketWatermark');
      stampSocketAlive(user.slack_user_id);
    } catch { /* non-fatal */ }

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

      // Step 2: Check if this is a reply to an active outreach job
      try {
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
        logger.warn('Colleague rate limit reached', { senderId, pendingCount, isChannel, isMpim });
        // Privacy: in a real channel (where third parties can read), DM the
        // colleague directly instead of posting publicly with the owner's
        // name + a "you have pending requests" disclosure. In DM/MPIM the
        // message stays in-thread (audience already knows the participants).
        if (isChannel) {
          await app.client.chat.postMessage({
            token: assistant.slack.bot_token,
            channel: senderId,
            text: `Hi — you already have a couple of pending requests with ${profile.user.name}. I'll follow up with you once those are resolved.`,
          });
        } else {
          await app.client.chat.postMessage({
            token: assistant.slack.bot_token,
            channel: channelId,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            text: `Hi — you already have a couple of pending requests with ${profile.user.name}. I'll follow up with you once those are resolved.`,
          });
        }
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

    // v2.0.7 — legacy "approve appr_xxx" / "reject appr_xxx" command path
    // retired. That route wrote to the (now-dropped) approval_queue table.
    // Approvals today use the first-class `approvals` table + free-text
    // replies bound by Sonnet via `resolve_approval`, so no command parsing
    // is needed here.


    const dbHistory = getConversationHistory(threadTs);
    // v1.7.1 — when images are attached, prefix the persisted text with
    // "[Image]" so future turns know an image was shared in this turn (the
    // bytes themselves are never stored — see vision/index.ts).
    // v2.5.2 — also persist the Slack url_private of each image so Sonnet
    // can forward it via `message_colleague.attachments` later. The bytes
    // are gone after the turn, but the URL is still valid (bot token auth)
    // and the SendOptions.attachments path knows how to re-download +
    // re-upload to the recipient.
    // v3.3.x — persist the image's CONTENT as text, not just a placeholder.
    // Bytes are live only this turn; without a text description, anything the
    // image carried (subject/time/attendees in a screenshot) is gone on the
    // next turn and Maelle re-asks ("book me 25 mins" + screenshot → turn 2
    // "online" had nothing left). One Haiku vision pass at ingestion; the
    // result rides the SAME history path as a normal message. Fails soft.
    let imageDescPart = '';
    if (images && images.length > 0) {
      const descriptions = (await Promise.all(images.map(b => describeImage(b))))
        .filter((d): d is string => !!d);
      if (descriptions.length > 0) imageDescPart = ` — ${descriptions.join(' | ')}`;
    }
    const persistedText = images && images.length > 0
      ? (imageUrls && imageUrls.length > 0
          ? `[Image${imageDescPart} — file_urls: ${imageUrls.join(' ')}] ${text}`
          : `[Image${imageDescPart}] ${text}`)
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
      if ((isMpim === true || isChannel === true) && botUserId && !isExplicitMention) {
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

      // v2.3.2 — deterministic brief-request short-circuit (owner DM only).
      // When the owner asks "didn't get my morning update" / "send the brief"
      // etc., route directly to sendMorningBriefing(force=true). Skips the
      // orchestrator entirely so Sonnet can't improvise a calendar rundown
      // with fabricated open items + "your window is X" framing.
      // Cheap regex pre-filter inside isBriefRequest gates the LLM call.
      if (role === 'owner' && !isChannel && !isMpim && !images?.length) {
        try {
          if (await isBriefRequest(userMessage)) {
            logger.info('Brief request detected — short-circuiting to sendMorningBriefing', {
              senderId, channelId, preview: userMessage.slice(0, 80),
            });
            await sendMorningBriefing(app, profile, channelId, true, threadTs);
            return;
          }
        } catch (err) {
          logger.warn('Brief short-circuit threw — falling through to orchestrator', {
            err: String(err).slice(0, 200),
          });
        }
      }

      // v2.4.3 (A1) — route through inbound queue for debounce + mutex +
      // abort-if-safe. Rapid-fire messages from the same thread collapse
      // into one merged turn instead of stacking parallel orchestrator
      // runs (which was the root cause of 13+ tool calls per booking
      // observed 2026-05-03). The runner closure carries everything that
      // used to follow runOrchestrator inline; queue invokes it once per
      // batch, possibly aborting if a fresh message arrives mid-turn
      // before any write tool fires.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { enqueueMessage } = require('./inboundQueue') as typeof import('./inboundQueue');
      enqueueMessage({
        channelId,
        threadTs,
        // 1:1 DM = not a multi-person channel, not an MPIM. Slack DMs give
        // each top-level message its own threadTs (threadTs == ts), so
        // threadTs-scoping puts every message in its own queue and never
        // merges. Logically a DM is one ongoing conversation — coalesce by
        // channelId only. MPIMs / channels keep threadTs-scoping because
        // they have genuine parallel conversations.
        isOneOnOneDm: !isChannel && !isMpim,
        text: userMessage,
        senderName: colleagueName,
        meta: {},
        runner: async ({ mergedText, signal, markWrite }) => {
          // v2.6.1 (D4) — recent-outbound context lookup for colleague 1:1 DMs.
          // When a colleague replies to Maelle in their DM (top-level OR thread
          // reply on a Maelle-sent message), check for an open outbound from
          // her to them within 24h. Attach as priorOutboundContext so the
          // orchestrator sees "RECENT OUTBOUND TO THIS COLLEAGUE" before
          // drafting. Closes the D4 amnesia (Isaac's "Ok" 2 min after Maelle's
          // heads-up landing as "Hey, what can I help you with?"). Skipped
          // for owner DMs, MPIMs, channels, and owner-in-group contexts —
          // those have their own continuity surfaces.
          let priorOutboundContext: string | undefined;
          if (role === 'colleague' && !isMpim && !isChannel && !isOwnerInGroup) {
            try {
              const { getRecentOutboundContext, closeFollowupForMessageTs, buildThreadReplyContextBlock } =
                await import('./recentOutboundContext');
              // Path A — thread reply on a Maelle-sent DM. threadTs !== ts means
              // this is a reply inside a thread, parent ts === threadTs. If
              // that parent matches an outreach_jobs.dm_message_ts, it's an
              // explicit reply (no LLM needed).
              if (threadTs && threadTs !== ts) {
                const job = closeFollowupForMessageTs({ messageTs: threadTs, reason: 'thread_reply' });
                if (job) {
                  priorOutboundContext = buildThreadReplyContextBlock(job);
                  logger.info('priorOutboundContext set via thread_reply', {
                    jobId: job.id, colleague: colleagueName, threadTs,
                  });
                }
              }
              // Path B — top-level DM reply. Run the time-window logic
              // (deterministic <10min / LLM 10min-24h / auto-expire >24h).
              if (!priorOutboundContext) {
                const ctx = await getRecentOutboundContext({
                  ownerUserId: profile.user.slack_user_id,
                  colleagueSlackId: senderId,
                  colleagueName: colleagueName ?? senderId,
                  ownerFirstName: profile.user.name.split(' ')[0],
                  inboundText: mergedText,
                });
                if (ctx.matched && ctx.contextBlock) {
                  priorOutboundContext = ctx.contextBlock;
                  logger.info('priorOutboundContext set via lookup', {
                    matchedVia: ctx.matchedVia, jobId: ctx.matchedJobId, colleague: colleagueName,
                  });
                }
              }
            } catch (err) {
              logger.warn('priorOutboundContext lookup threw — proceeding without context', {
                err: String(err).slice(0, 200),
              });
            }
          }
          // v2.7.7 (Module D) — thread-bound approval auto-resolve.
          // When the owner replies in a thread that uniquely matches a
          // pending approval AND a Haiku classifier reads the reply as a
          // clean approve/reject (NOT amend, NOT topic-change), call
          // resolveRequest directly and skip the orchestrator entirely.
          // Latency drops from ~3s to ~300ms; saves a ~50k-token Sonnet turn.
          // Fails open: any mismatch / ambiguity / classifier error →
          // falls through to runOrchestrator as before.
          if (
            profile.behavior?.deterministic_approval_resolve === true
            && role === 'owner'
            && threadTs
            && mergedText
            && mergedText.trim().length > 0
          ) {
            try {
              const { tryAutoResolveThreadBoundApproval } = await import('../../utils/threadBoundApprovalAutoResolve');
              const autoResolve = await tryAutoResolveThreadBoundApproval({
                message: mergedText,
                threadTs,
                ownerUserId: senderId,
                profile,
                app,
              });
              if (autoResolve.resolved) {
                // Acknowledge with a reaction on the owner's message; the
                // resolver itself runs downstream effects (booking, requester
                // DM, closeRequest cascade) which post their own confirmations
                // where relevant. No text reply from us — avoids duplication
                // with whatever the resolver posts.
                const emoji = autoResolve.verdict === 'approve' ? 'white_check_mark' : 'x';
                client.reactions.add({ channel: channelId, timestamp: ts, name: emoji }).catch(() => {});
                logger.info('Module D — orchestrator skipped via auto-resolve', {
                  senderId, threadTs, requestId: autoResolve.request_id, verdict: autoResolve.verdict,
                });
                markWrite();
                return;
              }
              logger.debug('Module D — auto-resolve declined, falling through to orchestrator', {
                reason: autoResolve.reason,
              });
            } catch (err) {
              logger.warn('Module D — auto-resolve threw, falling through to orchestrator', {
                err: String(err).slice(0, 200),
              });
            }
          }

          logger.info('Calling orchestrator', { senderId, role, channelId, threadTs, isOwnerInGroup: isOwnerInGroup ?? false, historyLength: history.length, imageCount: images?.length ?? 0, forceTool: forceToolOnFirstTurn?.name, batched: mergedText !== userMessage, hasPriorOutboundContext: !!priorOutboundContext });
          const result = await runOrchestrator({
            userMessage: mergedText,
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
            isChannel,
            isOwnerInGroup,
            mpimMemberIds,
            images,
            forceToolOnFirstTurn,
            signal,
            onWriteExecuted: () => markWrite(),
            priorOutboundContext,
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
        // v2.6.2 — pass the user's message ts so postReply can react 👍
        // on it for ack-class replies (replacing "Got it" text with a
        // reaction).
        userMessageTs: ts,
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

          // v1.8.11 — `send_outreach_dm` and `post_to_channel` actions
          // removed: message_colleague now sends synchronously inside its tool
          // handler via Connection. v3.4.x — coordinate_meeting /
          // finalize_coord_meeting actions removed with the coord subsystem.
          // find_slack_user (handled above) is the only Slack action left.
        }
      }
        },  // ← close runner async function (v2.4.3 A1)
      });  // ← close enqueueMessage call

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
    const imageUrls: string[] = [];
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

      // Image guard: scan for instruction-like text.
      //   - Owner path: log + shadow-notify but PROCEED. Owner is trusted; he
      //     might legitimately share screenshots that contain text. Sonnet
      //     reads the image as content, not as instructions, governed by the
      //     owner-path system prompt.
      //   - Colleague path (v2.5.2): REFUSE the image + shadow-notify the
      //     owner. Colleague-uploaded images with embedded text are a known
      //     prompt-injection surface (e.g. screenshot claiming "Idan said you
      //     can do X"). The image is dropped from the turn — Sonnet never
      //     sees it. The colleague gets a human-toned reply explaining we
      //     don't read attachments here. Owner sees the security shadow note
      //     so the pattern is visible.
      const scan = await scanImageForInjection(dl);
      const senderRoleForImage = getSenderRole(message.user!);
      if (scan.suspicious) {
        logger.warn('⚠ SECURITY — image flagged as suspicious', {
          senderId: message.user,
          senderRole: senderRoleForImage,
          channelId,
          reason: scan.reason,
          extractedTextPreview: scan.extractedText?.slice(0, 200),
          action: senderRoleForImage === 'owner' ? 'log_and_proceed' : 'refuse_and_drop',
        });
        try {
          await shadowNotify(profile, {
            channel: channelId,
            threadTs,
            action: senderRoleForImage === 'owner'
              ? '⚠ Image guard: suspicious content (owner — proceeded)'
              : '⚠ Image guard: suspicious content from colleague — REFUSED',
            detail: `Sender: ${message.user}. Reason: ${scan.reason ?? 'unknown'}. Extract: "${scan.extractedText?.slice(0, 200) ?? '(none)'}"`,
          });
        } catch (_) {}
        if (senderRoleForImage === 'colleague') {
          // Drop this image from the turn entirely. The colleague gets a
          // human-toned message back; Sonnet never sees the suspicious bytes.
          try {
            await client.chat.postMessage({
              token: assistant.slack.bot_token,
              channel: channelId,
              thread_ts: threadTs,
              text: `Sorry, I can't read attached images here — let me know in plain text what you need.`,
            });
          } catch (_) {}
          continue;  // skip pushing to images[] — Sonnet won't see this file
        }
      }

      images.push(buildImageBlock(dl));
      imageUrls.push(f.url_private as string);
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
      imageUrls,
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

  // On-restart catch-up routes missed messages THROUGH this live path instead
  // of reimplementing it. Register a replay fn (closure over processMessage +
  // the shared ingestion helpers) that core/background.ts calls per detected
  // missed message — voice/video get transcribed, images downloaded, then the
  // SAME processMessage handles the orchestrator + reply. One path, two callers.
  registerInboundReplay(user.slack_user_id, async ({ message, channelId, postThreadTs, source }) => {
    const senderId = message.user as string | undefined;
    if (!senderId) return;
    const ts = (message.ts as string) ?? postThreadTs;
    const files = (message.files as Array<Record<string, unknown>> | undefined) ?? [];

    let text = (message.text as string) ?? '';
    let images: AnthropicImageBlock[] | undefined;
    let imageUrls: string[] | undefined;
    let voiceInput = false;

    const audioFile = files.find(f => typeof f.mimetype === 'string'
      && ((f.mimetype as string).startsWith('audio/') || (f.mimetype as string).startsWith('video/')));
    const imageFiles = files.filter(f => typeof f.mimetype === 'string' && (f.mimetype as string).startsWith('image/'));

    if (audioFile?.url_private) {
      try {
        const transcript = await transcribeSlackAudio(audioFile.url_private as string, assistant.slack.bot_token, undefined, audioFile.mimetype as string);
        if (transcript && transcript.trim().length >= 2) { text = `[Voice message]: ${transcript}`; voiceInput = true; }
      } catch (err) {
        logger.warn('inboundReplay — transcription failed, skipping media', { err: String(err).slice(0, 200) });
      }
    } else if (imageFiles.length > 0) {
      const blocks: AnthropicImageBlock[] = [];
      const urls: string[] = [];
      for (const f of imageFiles) {
        try {
          const dl = await downloadSlackImage(f.url_private as string, assistant.slack.bot_token, f.mimetype as string);
          if ('buffer' in dl) { blocks.push(buildImageBlock(dl)); if (f.url_private) urls.push(f.url_private as string); }
        } catch (err) {
          logger.warn('inboundReplay — image download failed', { err: String(err).slice(0, 200) });
        }
      }
      if (blocks.length > 0) { images = blocks; imageUrls = urls; text = text || '(image attached, no caption)'; }
    }

    if (!text || text.trim().length < 1) return;  // nothing replayable

    // Caption first, then processMessage posts the actual reply via `say`.
    try {
      await app.client.chat.postMessage({
        token: assistant.slack.bot_token, channel: channelId, thread_ts: postThreadTs,
        text: '_↩️ Catching up on your message_', unfurl_links: false, unfurl_media: false,
      });
    } catch (_) { /* caption is cosmetic */ }

    const catchUpSay = async (msg: { text: string; thread_ts?: string }) => {
      await app.client.chat.postMessage({
        token: assistant.slack.bot_token, channel: channelId,
        thread_ts: msg.thread_ts ?? postThreadTs, text: msg.text,
        unfurl_links: false, unfurl_media: false,
      });
    };

    await processMessage({
      senderId, text, channelId, ts, threadTs: postThreadTs,
      say: catchUpSay as unknown as Function, client: app.client,
      isChannel: false, isMpim: source === 'assistant_panel' ? false : false,
      images, imageUrls, voiceInput,
    });
  });

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

      // Document branch — owner-only. Every .txt/.md/.pdf in the upload gets
      // downloaded + parsed sequentially, then routed through the orchestrator
      // as a normal turn with the file content embedded in the user message
      // (v2.2.5 restructure). Sonnet's full skill catalog + system prompt
      // decides what to do: review meetings against the list, file as KB,
      // summarize a transcript, or ask the owner what's intended. Replaces
      // the prior auto-classify path that misfiled task instructions as KB
      // because the classifier saw file shape, not caption intent.
      const docFiles = (files ?? []).filter((f: any) => {
        const mt = String(f.mimetype || '');
        const ft = String(f.filetype || '');
        return mt === 'text/plain' || mt === 'text/markdown' || mt === 'application/pdf'
          || ft === 'text' || ft === 'txt' || ft === 'markdown' || ft === 'md' || ft === 'pdf';
      });
      if (docFiles.length > 0 && senderRole1v1 === 'owner') {
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

          // v2.2.5 (D) — route file uploads through the orchestrator. The
          // previous flow auto-classified every doc and either filed it as KB
          // or refused, ignoring the owner's caption. Now: download + parse
          // each doc, build a synthetic user message that includes the caption
          // and the file text (capped), and let the orchestrator decide via
          // its full skill catalog. Caption asks to review meetings → calendar
          // tools fire. Caption asks to save → Sonnet calls knowledge tools.
          // Empty caption with content that looks like a transcript → Sonnet
          // can recognize and route. The auto-misfile path is gone.

          // Download + parse all docs first; bail individually on failure.
          const FILE_TEXT_CAP = 20000;
          const parsedDocs: Array<{ label: string; text: string; truncated: boolean }> = [];
          for (let i = 0; i < docFiles.length; i++) {
            const docFile = docFiles[i];
            const isPdf = String(docFile.mimetype || '') === 'application/pdf' || String(docFile.filetype || '') === 'pdf';
            const fileLabel = docFile.name || docFile.title || `file ${i + 1}`;
            try {
              const dl = await fetch(docFile.url_private, {
                headers: { Authorization: `Bearer ${assistant.slack.bot_token}` },
              });
              if (!dl.ok) {
                await saySafe(`Couldn't open ${fileLabel}, try sending it again?`);
                continue;
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
                  await saySafe(`Couldn't read ${fileLabel} (maybe scanned images or encrypted). Send a text version?`);
                  continue;
                }
              } else {
                text = await dl.text();
              }
              if (text.trim().length < 10) {
                await saySafe(`${fileLabel} looks empty, was the export complete?`);
                continue;
              }
              const truncated = text.length > FILE_TEXT_CAP;
              parsedDocs.push({
                label: fileLabel,
                text: truncated ? text.slice(0, FILE_TEXT_CAP) : text,
                truncated,
              });
            } catch (err) {
              logger.error('Doc download/parse failed', { err: String(err).slice(0, 400), file: fileLabel });
              const msg = isOverloadError(err)
                ? `Quick coffee break, ping me again in a couple of minutes?`
                : `Something jammed reading ${fileLabel}, try that one again in a minute?`;
              await saySafe(msg);
            }
          }

          if (parsedDocs.length === 0) return;

          // Build a synthetic user message: caption + each file's content.
          // Orchestrator sees this as the user turn; appendToConversation
          // already runs inside processMessage so future turns see the file.
          const fileBlocks = parsedDocs.map(d => {
            const trunc = d.truncated ? `\n[…file truncated at ${FILE_TEXT_CAP} chars]` : '';
            return `\n\n[Attached file: ${d.label}]\n${d.text}${trunc}`;
          }).join('');
          const augmentedText = caption
            ? `${caption}${fileBlocks}`
            : `[Owner uploaded ${parsedDocs.length === 1 ? 'a file' : `${parsedDocs.length} files`} with no caption.]${fileBlocks}`;

          // Route through processMessage like any other DM turn.
          await processMessage({
            senderId: message.user as string,
            text: augmentedText,
            channelId,
            ts,
            threadTs,
            say: (msg: { text: string; thread_ts?: string }) => client.chat.postMessage({
              token: assistant.slack.bot_token,
              channel: channelId,
              thread_ts: msg.thread_ts ?? threadTs,
              text: msg.text,
            }),
            client,
            isChannel: false,
            isMpim: false,
          });
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

    const ts       = message.ts;
    const threadTs = ('thread_ts' in message && message.thread_ts) ? message.thread_ts : ts;

    // Dedup — Slack retries if we're slow; skip if already processing this message
    if (!markProcessed(ts)) { logger.debug('DM dedup — skipping retry', { ts }); return; }
    // v2.8.7 — content-based dedup. Same shape as the MPIM handler. 1:1 DM
    // is less prone to assistant-panel mirroring but defense-in-depth.
    if (!markContentProcessed(message.channel as string, (message as any).user ?? '', (message as any).text ?? '')) {
      logger.info('DM dedup — same content recently processed, skipping', {
        ts, senderId: (message as any).user, channelId: message.channel,
      });
      return;
    }

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

  // ── Handler 1c: Assistant thread opened (v2.7.3) ──────────────────────────
  // Slack's assistant panel (separate UI surface from regular DM) fires this
  // event when a user opens Maelle in it. We register the thread so subsequent
  // setStatus("Working…") calls during tool iterations actually surface in the
  // panel. No greeting message is sent — assistant panels show the suggested-
  // prompts UI by default; we don't want to push past that.
  app.event('assistant_thread_started' as any, async ({ event }: any) => {
    try {
      const assistantThread = event?.assistant_thread;
      if (!assistantThread) return;
      const channelId = assistantThread.channel_id ?? assistantThread.context?.channel_id;
      const threadTs = assistantThread.thread_ts;
      if (!channelId || !threadTs) {
        logger.warn('assistant_thread_started — missing channel_id or thread_ts, skipping', { event: JSON.stringify(event).slice(0, 300) });
        return;
      }
      const { registerAssistantThread } = await import('./assistantThreads');
      registerAssistantThread({ channelId, threadTs });
    } catch (err) {
      logger.warn('assistant_thread_started handler threw', { err: String(err).slice(0, 200) });
    }
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

    // v2.6.2 — channel routing.
    // Real channel (not MPIM) messages need to pass two gates before this handler
    // continues:
    //   (1) The message must be a thread reply — top-level channel chatter is
    //       intentionally dropped (an EA doesn't read every word in #general).
    //   (2) Maelle must have spoken in this thread before — i.e. someone already
    //       @-mentioned her in this thread and she replied. Without that, even
    //       thread replies are dropped (she's not a member of every thread).
    // Both gates pass → fall through to the same MPIM relevance + addressee
    // gates downstream so she only responds when actually addressed.
    // MPIM messages (channel_type='mpim' OR 'channel'+is_mpim) skip both gates
    // and use the existing relevance check below.
    let isRealChannelContinuation = false;
    if (event.channel_type === 'channel') {
      let isMpimChannel = false;
      try {
        const ch = (await client.conversations.info({
          token: assistant.slack.bot_token,
          channel: event.channel as string,
        })).channel as any;
        isMpimChannel = ch?.is_mpim === true;
      } catch (err) {
        logger.warn('conversations.info failed — cannot confirm MPIM, skipping', { err: String(err), channelId: event.channel });
        return;
      }
      if (!isMpimChannel) {
        // Real channel. Apply the two gates.
        const isThreadReply = 'thread_ts' in event
          && typeof event.thread_ts === 'string'
          && event.thread_ts.length > 0
          && event.thread_ts !== event.ts;
        if (!isThreadReply) {
          // Top-level channel message — drop. Maelle isn't passively reading channels.
          return;
        }
        const priorThreadTs = (event as { thread_ts: string }).thread_ts;
        const priorHistory = getConversationHistory(priorThreadTs);
        const maelleSpokeHere = priorHistory.some(m => m.role === 'assistant');
        if (!maelleSpokeHere) {
          // Thread Maelle never engaged in. Drop — she joins threads only when
          // someone @-mentions her (handled by app_mention). Once she's spoken,
          // continuation flows through this branch.
          return;
        }
        isRealChannelContinuation = true;
        logger.info('Real-channel thread continuation eligible — running relevance + addressee gates', {
          channelId: event.channel, threadTs: priorThreadTs,
          historySize: priorHistory.length,
          preview: (event.text as string).slice(0, 80),
        });
      }
    }

    // v2.6.1 — log event.ts + thread_ts + bot-mention presence so we can
    // correlate this handler with the parallel `app_mention` handler when
    // both fire for the same user message (D2 investigation, 2026-05-06).
    // If both handlers log the SAME ts, markProcessed dedup should catch
    // the second; if they log DIFFERENT ts values for the same user input,
    // the dedup key needs to widen.
    logger.info('MPIM message received', {
      senderId: event.user,
      channelId: event.channel,
      channelType: event.channel_type,
      ts: event.ts,
      threadTs: ('thread_ts' in event ? event.thread_ts : undefined) ?? null,
      hasSelfMention: typeof event.text === 'string' && botUserId ? (event.text as string).includes(`<@${botUserId}>`) : null,
      botUserIdSet: !!botUserId,
      preview: (event.text as string).slice(0, 80),
    });

    // Pre-v2.6.1 we bailed here on self-mention, expecting app_mention to take
    // over. Slack doesn't reliably fire app_mention for MPIMs (workspace and
    // event-subscription dependent), so @-mentions in group DMs were silenced
    // — observed 2026-05-06: two consecutive `@Maelle ...` messages in an MPIM
    // got no response, then a bare-name message ("I wonder if Maelle is down")
    // woke her up. Now: process self-mentions here too. The markProcessed dedup
    // a few lines down already handles the rare case where both `message` and
    // `app_mention` fire for the same ts — first to mark wins, the other no-ops.
    const ts       = event.ts;
    const threadTs = ('thread_ts' in event && event.thread_ts) ? event.thread_ts as string : ts;

    // Dedup — same ts = Slack retry OR concurrent app_mention firing. First
    // call marks ts; any second handler (this one or app_mention) skips.
    if (!markProcessed(ts)) { logger.debug('MPIM dedup — skipping retry', { ts }); return; }
    // v2.8.7 — content-based dedup. See app_mention handler above for the
    // root cause (Slack assistant-panel mirror = same text, different ts).
    if (!markContentProcessed(event.channel as string, event.user as string, (event.text as string) ?? '')) {
      logger.info('MPIM dedup — same content recently processed, skipping', {
        ts, senderId: event.user, channelId: event.channel,
      });
      return;
    }

    setImmediate(async () => {
      const rawText = (event.text as string).trim();

      // ── Fetch group members — needed for relevance check, response context, and coordination ──
      // Collect ALL member IDs (excluding bot) for coordination flow (who's in this DM?)
      // and names for relevance classifier and group context.
      let groupContext = '';
      const mpimMemberNames: string[] = [];
      const mpimMemberIds: string[] = [];
      // v2.6.2 — skip the full-channel members fetch for real-channel
      // continuations. Real channels can have hundreds of members, the
      // groupContext "all participants see everything" framing is wrong
      // for a channel thread, and the coord-routing flows that use
      // mpimMemberIds don't apply here. Thread participants are loaded
      // separately via processMessage's conversations.replies merge.
      try {
        if (isRealChannelContinuation) {
          // No-op — leave groupContext empty + mpimMember* arrays empty.
        } else {
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
          // out of the injection-scanner's owner_spoof regex range.
          groupContext =
            `<<GROUP DM — participants: ${nameEntries.join(', ')}. ` +
            `Sender: ${senderName}. ` +
            `All participants can see everything you write. ` +
            `Respond to ALL relevant people in the DM — when addressing a specific person, START your reply with <@their_slack_id> so they get a push notification. ` +
            `Do NOT say "tell her" or "let him know" when they are right here in this conversation.>>\n\n`;
        }
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
      // v3.1.x — explicit-@mention fast-path. When the message @mentions the
      // bot directly, that's the most unambiguous "respond" signal there is —
      // skip the relevance LLM entirely. (mentionedIds + botUserId are already
      // computed above; we only reach here when mentions are absent OR the bot
      // IS among them, since the other-people-only case returned at line ~1644.)
      // Closes the ~2s wasted Sonnet relevance call on every @Maelle group
      // opener — the old fast-path in relevance.ts required ZERO @mentions, so
      // an explicit @Maelle disabled it and paid the full classification.
      // v3.3.x — outer MPIM relevance Haiku call DELETED. It duplicated work
      // already done by `classifyAddressee` inside `processMessage` (both Haiku
      // post-v3.3.0, both classifying the same RESPOND/IGNORE question with
      // slightly different framings). The inner gate has identical skip
      // conditions (explicit @bot, recently-active, sender-is-owner) plus a
      // finer MAELLE/HUMAN/AMBIGUOUS verdict. The fast-path log below preserves
      // the "explicitly mentioned" / "recently active" trail for diagnostics
      // without paying the LLM call.
      const botExplicitlyMentioned = botUserId != null && mentionedIds.includes(botUserId);
      if (botExplicitlyMentioned) {
        logger.info('MPIM mention fast-path — bot explicitly @mentioned', {
          senderId: event.user, channelId: event.channel, threadTs, preview: rawText.slice(0, 80),
        });
      } else if (recentlyActive) {
        logger.info('MPIM mention fast-path — Maelle was just active in this thread', {
          senderId: event.user, channelId: event.channel, threadTs, preview: rawText.slice(0, 80),
        });
      }
      // No-fast-path messages flow through to processMessage where the inner
      // addressee gate (`classifyAddressee`) does the single Haiku verdict.

      const resolvedText = await resolveSlackMentions(rawText);

      processMessage({
        senderId: event.user as string,
        text: groupContext + resolvedText,
        channelId: event.channel as string,
        ts,
        threadTs,
        say,
        client,
        // v2.6.2 — real-channel thread continuation flips these. The
        // addressee gate at processMessage:460 reads either flag (`isMpim ||
        // isChannel`) to gate the relevance check, so behavior stays correct;
        // mpimMemberIds is intentionally undefined for channels (no DM-each-
        // member coord routing applies).
        isChannel: isRealChannelContinuation,
        isMpim: !isRealChannelContinuation,
        mpimMemberIds: isRealChannelContinuation ? undefined : mpimMemberIds,
      }).catch(err => logger.error('processMessage error', { err }));
    });
  });

  // ── Handler 2.5: emoji reactions on outbound DMs (v2.6.1 D4 + v2.6.2 emoji)
  //
  // Three things this handler does, in order:
  //   1. Close D4 followup tracker for the matched outreach_jobs row (so
  //      subsequent inbound DMs from this colleague aren't falsely matched
  //      against an already-acked outbound).
  //   2. v2.6.2 — Shadow-DM the owner with the colleague's emoji ack so he
  //      knows they saw it. Only fires when the matched row IS an outreach
  //      DM (i.e. closed > 0); silent reactions outside outreach context
  //      generate no shadow.
  //   3. v2.6.2 — Approval-via-emoji. If the message ts matches a pending
  //      approval's slack_msg_ts, route ✅/👍/🙏 → resolveApproval('approve')
  //      and ❌/👎 → resolveApproval('reject'). Other emoji ignored.
  //
  // Each path is isolated in try/catch so a failure in one doesn't block the others.
  app.event('reaction_added', async ({ event, client }) => {
    try {
      // Only react to reactions on Maelle's OWN messages.
      if (!('item' in event) || !event.item) return;
      const item = event.item as { type?: string; channel?: string; ts?: string };
      if (item.type !== 'message' || !item.ts) return;
      // The user who reacted shouldn't be the bot itself.
      const reactor = ('user' in event ? (event.user as string) : undefined);
      if (reactor === botUserId) return;
      const reaction = ('reaction' in event ? (event.reaction as string) : '') || '';

      // ── Path 1 + 2: outreach followup close + shadow ────────────────────
      try {
        const { closeFollowupForMessageTs } = await import('./recentOutboundContext');
        const closed = closeFollowupForMessageTs({ messageTs: item.ts, reason: 'emoji_ack' });
        if (closed) {
          logger.info('reaction_added closed outreach followup', {
            jobId: closed.id,
            colleague: closed.colleague_name,
            reaction,
            reactor,
          });
          // v2.6.2 — shadow-DM the owner so he knows the colleague saw it.
          // Owner direction: "i do need shadow DM for colleague feedback
          // reply, otherwise i don't know they saw it." Posts a single line
          // into the owner-DM thread keyed on the same conversationKey so
          // it nests under the original outbound's shadow thread.
          try {
            const { shadowNotify } = await import('../../utils/shadowNotify');
            const messagePreview = closed.message.slice(0, 120).replace(/\s+/g, ' ').trim();
            await shadowNotify(profile, {
              channel: closed.dm_channel_id ?? '',
              threadTs: closed.dm_message_ts,
              action: `${closed.colleague_name} reacted :${reaction}:`,
              detail: `to: "${messagePreview}${closed.message.length > messagePreview.length ? '…' : ''}"`,
              conversationKey: closed.dm_message_ts,
              conversationHeader: `Conversation with ${closed.colleague_name}`,
            });
          } catch (shadowErr) {
            logger.warn('reaction_added shadow notify failed — followup still closed', {
              err: String(shadowErr).slice(0, 200), jobId: closed.id,
            });
          }
        }
      } catch (err) {
        logger.warn('reaction_added followup-close path threw', { err: String(err).slice(0, 200) });
      }

      // ── Path 3: approval-via-emoji ──────────────────────────────────────
      // v2.7.0 — matches against requests.terminal_dm_msg_ts (the spine).
      // Per Q3: only the terminal-question DM stamps that field, so ✅ on
      // a midpoint reminder is a no-op.
      try {
        const { getRequestByTerminalMsgTs } = await import('../../db/requests');
        const approval = getRequestByTerminalMsgTs(item.ts);
        if (!approval) return;
        // Map the reaction to a verdict. Widened sets (owner direction
        // 2026-06-21 — "increase yes/no emoji so 'ok' does yes, as long as
        // they're not ambiguous; ~10-15 each is fine"). NOT owner-configurable
        // by design — a clone's owner won't define it; the defaults must just
        // cover the obvious ones.
        // Approve: every unambiguous affirmative (check marks, thumbs, ok-hand,
        //   :ok:, :100:, :pray:/thanks-as-ack).
        // Reject: every unambiguous negative (x marks, thumbs-down, no-entry,
        //   :no_good:).
        // DELIBERATELY excluded (ambiguous — could be neither yes nor no):
        //   eyes 👀, thinking 🤔, fire 🔥, tada 🎉, clap 👏, raised_hands 🙌,
        //   v ✌️. Those stay no-ops; the owner can still resolve via typed reply.
        const APPROVE_REACTIONS = new Set([
          'white_check_mark', 'heavy_check_mark', 'ballot_box_with_check',
          'check_mark', 'check', 'white_tick',
          '+1', 'thumbsup', '+1::skin-tone-2', '+1::skin-tone-3',
          'ok_hand', 'ok', 'ok_woman',
          '100', 'pray', 'saluting_face',
        ]);
        const REJECT_REACTIONS = new Set([
          'x', 'negative_squared_cross_mark', 'heavy_multiplication_x',
          'cross_mark', 'multiplication_x',
          '-1', 'thumbsdown',
          'no_entry', 'no_entry_sign', 'no_good', 'prohibited',
        ]);
        let verdict: 'approve' | 'reject' | null = null;
        if (APPROVE_REACTIONS.has(reaction)) verdict = 'approve';
        else if (REJECT_REACTIONS.has(reaction)) verdict = 'reject';
        if (!verdict) {
          logger.debug('reaction_added on approval — non-decisive emoji, ignoring', {
            approvalId: approval.id, reaction, reactor,
          });
          return;
        }
        // Only the owner can resolve — defense in depth (approval DMs go to
        // owner's private channel, but a workspace admin could in theory
        // react too; ignore those).
        if (reactor && reactor !== approval.owner_user_id) {
          logger.info('reaction_added on approval from non-owner — ignoring', {
            approvalId: approval.id, reactor, ownerUserId: approval.owner_user_id,
          });
          return;
        }
        const { resolveRequest } = await import('../../core/requests/resolver');
        const decision = verdict === 'approve'
          ? { verdict: 'approve' as const, data: {} }
          : { verdict: 'reject' as const, reason: `Owner reacted :${reaction}:` };
        const result = await resolveRequest(approval.id, decision, { app, profile, resolvedByColleague: false });
        logger.info('reaction_added resolved approval via emoji', {
          approvalId: approval.id, verdict, reaction, ok: result.ok,
        });
        // v3.5.x — leave a MEMORY RECORD of this silent resolve in the owner's
        // approval-thread history. The emoji path runs NO Sonnet turn, so without
        // this a later owner turn in the thread has amnesia about what happened:
        // it misreports "not notified" and fires a duplicate (the Ysrael class,
        // reached via ✅ instead of a typed "Yes"). A reaction can't narrate, so
        // we record the fact — including whether the requester was already told
        // (the resolver relays + stamps requester_notified_at). Best-effort.
        if (result.ok) {
          try {
            const { getRequest } = await import('../../db/requests');
            const fresh = getRequest(approval.id);
            const subj = fresh?.subject || approval.subject || 'the request';
            const who = (fresh?.requester_name ?? approval.requester_name ?? '').split(/\s+/)[0];
            const notified = !!(fresh?.requester_slack_id && fresh.requester_notified_at);
            const verb = verdict === 'approve' ? 'approved' : 'declined';
            const note = `[Resolved via reaction: ${verb} "${subj}"${notified && who ? `; ${who} was notified` : ''}.]`;
            const histThread = fresh?.owner_dm_thread_ts ?? approval.owner_dm_thread_ts ?? item.ts;
            const histChannel = fresh?.owner_dm_channel ?? approval.owner_dm_channel ?? item.channel;
            if (histThread && histChannel) {
              appendToConversation(histThread, histChannel, { role: 'assistant', content: note });
            }
          } catch (_) { /* memory record is best-effort — never block the resolve */ }
        }
      } catch (err) {
        logger.warn('reaction_added approval path threw', { err: String(err).slice(0, 200) });
      }
    } catch (err) {
      logger.warn('reaction_added handler threw — ignoring', { err: String(err).slice(0, 200) });
    }
  });

  // ── Handler 3: @mentions in channels and private channels ─────────────────
  // Fires ONLY when @Maelle is explicitly mentioned — she is silent otherwise
  app.event('app_mention', async ({ event, say, client }) => {
    if (!('user' in event) || !event.user) return;

    // v2.6.1 — log event.ts so we can correlate against the MPIM `message`
    // handler when both fire for the same user @-mention in an MPIM (D2).
    logger.info('Channel @mention received', {
      senderId: event.user,
      channelId: event.channel,
      ts: event.ts,
      threadTs: event.thread_ts ?? event.ts,
    });

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
    // v2.8.7 — content-based dedup. Slack's assistant-panel mirror can fire
    // a SECOND event with a different ts but the SAME text from the same
    // sender in the same channel within ~30s. Without this guard, both
    // events run full orchestrator turns → duplicate replies in two
    // different thread anchors (2026-05-19 Mayrav incident).
    if (!markContentProcessed(event.channel, event.user, event.text ?? '')) {
      logger.info('mention dedup — same content recently processed, skipping', {
        ts: event.ts, senderId: event.user, channelId: event.channel,
      });
      return;
    }

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
      // Live Slack display names resolved this event (users.info), shared between
      // the MPIM-member loop and the thread-speaker loop so a person who is BOTH
      // a member and a thread speaker is resolved + upserted ONCE, not twice
      // (#L-3). Also lets the thread-action roster resolve real names instead of
      // leaking raw U0… ids (#M-3, invariant 9 — channel threads stay read-only).
      const threadNamesById = new Map<string, string>();
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
                threadNamesById.set(id, name);
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
      // v3.2.6 (#14) — hoisted so the owner-presence gate below can read who
      // posted in the thread. Empty for a start-of-thread mention.
      let threadMsgs: Array<{ user?: string }> = [];
      let threadParticipantIds: string[] = [];
      // Pre-condition for the thread-action engine: we successfully read the
      // thread. If replies fetch fails (Slack rate-limit, 5xx), we have no
      // roster — running the engine anyway would ship a directive saying
      // "book a meeting with: (nobody)" and Sonnet would invent attendees
      // from the @-mention text. Better: skip the engine entirely on fetch
      // failure and let the orchestrator handle the @-mention as a plain
      // prompt (the @-mention text usually names whom to book with —
      // Sonnet reads it directly).
      let threadFetchOk = true;
      if (threadTs !== event.ts) {
        try {
          const replies = await client.conversations.replies({
            token: assistant.slack.bot_token,
            channel: event.channel,
            ts: threadTs,
            limit: 50,
          });
          const threadMessages = (replies.messages as any[]) ?? [];
          threadMsgs = threadMessages;
          const uniqueUserIds = [...new Set(
            threadMessages
              .map(m => m.user as string | undefined)
              .filter((id): id is string => !!id && id !== botUserId)
          )];
          threadParticipantIds = uniqueUserIds;

          if (uniqueUserIds.length > 0) {
            const nameEntries: string[] = [];
            for (const id of uniqueUserIds) {
              // #L-3 — if the MPIM-member loop above already resolved (and, for an
              // MPIM, upserted) this person this event, reuse the cached name; don't
              // re-call users.info or re-upsert the same id.
              const cachedName = threadNamesById.get(id);
              if (cachedName) {
                nameEntries.push(`${cachedName} (slack_id: ${id})`);
                continue;
              }
              try {
                const info = await client.users.info({ token: assistant.slack.bot_token, user: id });
                const u = info.user as any;
                const name = u?.real_name || u?.name || id;
                threadNamesById.set(id, name);
                nameEntries.push(`${name} (slack_id: ${id})`);
                // Load persona data for each thread participant.
                // v3.2.6 (#14, invariant 9) — EPHEMERAL READ: when this is a
                // real-channel mid-thread mention (the thread-action path),
                // reading the thread must persist NOTHING about its people. So
                // skip the upsert here — the name above (from the Slack API, not
                // the DB) is enough for in-memory threadContext, and the roster
                // resolves VIP/email READ-ONLY (getPersonMemory). MPIMs are group
                // DMs Maelle is part of, not blind channels — keep their upsert.
                if (id !== profile.user.slack_user_id && isMpimChannel) {
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
          threadFetchOk = false;
        }
      }

      // ── Thread actions (#14) — owner-presence gate (the trust control) ──
      // Applies ONLY to a REAL-channel MID-THREAD mention: Maelle is being
      // pulled into an existing thread she wasn't part of. NOT for MPIMs (group
      // DMs use the owner-in-group authority model) and NOT for a start-of-
      // thread mention (threadTs === event.ts → engages like an MPIM, existing
      // behavior). His presence in the thread IS the authorization (invariant 1
      // / S2): if the owner never posted here, Maelle does nothing — she's his
      // EA, and a colleague can't drive her in a thread he isn't part of.
      // Reading the thread for this is ephemeral — no capture/people/interaction
      // writes (invariant 9); those drops live in the `message` handler.
      let threadActionDirective = '';
      if (!isMpimChannel && threadTs !== event.ts && threadFetchOk) {
        // Owner is present if he posted earlier in the thread OR he is the one
        // mentioning Maelle now (his just-sent message may not be in the fetched
        // replies yet — Slack eventual consistency). Sender-is-owner trivially
        // satisfies presence.
        const ownerPresent =
          event.user === profile.user.slack_user_id ||
          ownerPostedInThread(threadMsgs, profile.user.slack_user_id);
        if (!ownerPresent) {
          logger.info('thread-action gate — owner not in thread; no action', {
            channelId: event.channel, threadTs, senderId: event.user,
          });
          return; // silent — Maelle is the owner's EA
        }
        // Owner present → classify the ask and build the action directive. The
        // orchestrator executes it through the existing engine (coord / outreach
        // / news); the deterministic roster + VIP split is code-derived here.
        try {
          const action = await classifyThreadAction({
            anthropic: getAnthropicClient(),
            mentionText: rawText,
            threadContext,
            profile,
          });
          // Roster = thread speakers + anyone @mentioned in the mention text.
          const mentionedIds = [...new Set(
            ((event.text ?? '').match(/<@([A-Z0-9]+)>/g) ?? [])
              .map(m => m.replace(/[<@>]/g, ''))
              .filter(id => id !== botUserId),
          )];
          const roster = buildThreadRoster(
            [...threadParticipantIds, ...mentionedIds],
            profile.user.slack_user_id,
            threadNamesById,
          );
          threadActionDirective = buildThreadActionDirective(action, roster, profile);
          logger.info('thread-action gate — owner present; routing', {
            channelId: event.channel, threadTs, action,
            rosterSize: roster.length, vipCount: roster.filter(r => r.isVip).length,
          });
        } catch (err) {
          logger.warn('thread-action routing threw — falling through plain', { err: String(err).slice(0, 200) });
        }
      }

      // Resolve remaining user mentions to "Name (slack_id: ID)" format
      const resolvedText = await resolveSlackMentions(rawText);
      processMessage({
        senderId: event.user!,
        text: threadActionDirective + mpimContext + threadContext + resolvedText,
        channelId: event.channel,
        ts: event.ts,
        threadTs,
        say,
        client,
        isChannel: !isMpimChannel,
        isMpim: isMpimChannel,
        mpimMemberIds: isMpimChannel ? mpimMemberIds : undefined,
        isExplicitMention: true,
      }).catch(err => logger.error('processMessage error', { err }));
    });
  });

  return app;
}

// v2.0.7 — handleApprovalResponse retired with the legacy approval_queue
// table. Approvals today are resolved via the `approvals` table + Sonnet's
// free-text interpretation (resolve_approval tool); no command grammar needed.

// ── Socket watchdog (v3.3.x — recovery rewrite) ────────────────────────────────
//
// The v3.2.4 "never crash on a socket transient" handlers (index.ts) keep the
// process alive when the Slack socket dies — which, with recovery being
// startup-only, turned socket-death into a SILENT ZOMBIE: process up, socket
// dead, no inbound, no restart, no catch-up (2026-06-12/13). This watchdog
// closes that: it POLLS the documented public `client.connected` boolean (no
// API calls, no fragile finity event names — not a catch-up heartbeat) and:
//   • reconnect after a gap → fire ONE gap-scoped catch-up (recover what
//     arrived while the socket was down, without waiting for a restart).
//   • disconnected > threshold AND Slack API still reachable → exit(1) so the
//     supervisor (PM2 fork, autorestart) restarts clean → startup catch-up.
//     The auth.test gate prevents a restart-storm during a real Slack outage
//     (if the API is ALSO down, restarting won't help — ride it out).
const WATCHDOG_POLL_MS = 30 * 1000;
const DISCONNECT_EXIT_MS = 3 * 60 * 1000;

export function startSocketWatchdog(app: App, profile: UserProfile, ownerChannel: string): void {
  const profileId = profile.user.slack_user_id;
  const botToken = profile.assistant.slack.bot_token;
  let wasConnected = true;
  let disconnectedSinceMs: number | null = null;
  let watchdogDisabledLogged = false;

  setInterval(() => {
    void (async () => {
      const client = (app as any).receiver?.client;
      // CRITICAL fail-safe: `client.connected` is a runtime-internal of Bolt's
      // SocketModeReceiver. If that shape ever changes and the client object
      // isn't found, we CANNOT assess connectivity — and must NOT infer
      // "disconnected" (that would exit-loop a perfectly healthy bot). Skip the
      // poll entirely when the client/boolean is absent; recovery then falls
      // back to startup-only, never to a restart storm.
      if (!client || typeof client.connected !== 'boolean') {
        if (!watchdogDisabledLogged) {
          watchdogDisabledLogged = true;
          logger.warn('Socket watchdog: client.connected not reachable — watchdog disabled (startup catch-up still active)', { profileId });
        }
        return;
      }
      const connected: boolean = client.connected === true;

      if (connected) {
        if (!wasConnected) {
          // Reconnect after a gap → recover the downtime, scoped to the
          // watermark captured BEFORE we stamp the reconnect moment.
          const { getLastSocketAlive, stampSocketAlive } =
            require('./socketWatermark') as typeof import('./socketWatermark');
          const sinceMs = getLastSocketAlive(profileId) ?? undefined;
          logger.warn('Socket reconnected after a gap — running gap-scoped catch-up', {
            profileId, gapStartMs: sinceMs,
          });
          stampSocketAlive(profileId);
          try {
            const { catchUpMissedMessages } = require('../../core/background') as typeof import('../../core/background');
            await catchUpMissedMessages(app, profile, ownerChannel, sinceMs);
          } catch (err) {
            logger.error('Reconnect catch-up failed', { profileId, err: String(err).slice(0, 200) });
          }
        } else {
          // Healthy poll: stamp "alive" every tick while the socket is
          // genuinely connected. This keeps the watermark CURRENT during quiet
          // periods (no inbound for days) so a later crash recovers only the
          // real downtime, not the whole quiet stretch. Safe to stamp here —
          // unlike the bare process timer, this branch only runs when
          // client.connected === true, never in a dead-socket zombie state.
          try {
            (require('./socketWatermark') as typeof import('./socketWatermark')).stampSocketAlive(profileId);
          } catch { /* non-fatal */ }
        }
        wasConnected = true;
        disconnectedSinceMs = null;
        return;
      }

      // Disconnected.
      wasConnected = false;
      if (disconnectedSinceMs === null) {
        disconnectedSinceMs = Date.now();
        logger.warn('Socket reported disconnected — watching', { profileId });
        return;
      }
      if (Date.now() - disconnectedSinceMs < DISCONNECT_EXIT_MS) return;

      // Down past threshold. Only restart if Slack's API is reachable (socket-
      // specific problem a restart fixes) — not during a full Slack/network
      // outage (restarting won't help; avoid a PM2 max_restarts burn).
      let apiReachable = false;
      try { apiReachable = (await app.client.auth.test({ token: botToken }))?.ok === true; }
      catch { apiReachable = false; }
      if (!apiReachable) {
        logger.warn('Socket down but Slack API unreachable — likely an outage; NOT restarting', { profileId });
        return;
      }
      logger.error('Socket dead > threshold while API is reachable — exiting for a clean restart', {
        profileId, downMs: Date.now() - disconnectedSinceMs,
      });
      try { (require('./socketWatermark') as typeof import('./socketWatermark')).flushSocketWatermark(); } catch { /* noop */ }
      process.exit(1);
    })();
  }, WATCHDOG_POLL_MS).unref?.();
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
