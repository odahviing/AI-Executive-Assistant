/**
 * The shared message processor extracted from app.ts. Handles all inbound
 * contexts (1:1 DM, group DM/MPIM, channel mention): role resolution, the
 * colleague funnel, history merge, the addressee gate, the inbound queue, the
 * orchestrator call, the reply pipeline, and post-reply Slack actions.
 */

import { runOrchestrator } from '../../../core/orchestrator';
import { isBriefRequest } from '../../../core/briefIntent';
import { sendMorningBriefing } from '../../../tasks/briefs';
import type { ChannelId } from '../../../skills/types';
import {
  getConversationHistory,
  appendToConversation,
  auditLog,
  logEvent,
  getPendingRequestCountForColleague,
  upsertPersonMemory,
  getSummarySessionByThread,
} from '../../../db';
import { detectAndSaveGender } from '../../../utils/genderDetect';
import { handleOutreachReply, findSlackUser } from '../coordinator';
import { describeImage, downloadSlackImage, buildImageBlock, type AnthropicImageBlock } from '../../../vision';
import logger from '../../../utils/logger';
import type { SenderRole, SlackAppContext, ProcessMessageParams } from './context';
import { failureReply } from './helpers';

// Re-attach a recent thread image on a follow-up owner turn. Image bytes
// are multimodal ONLY on the turn they arrive; later turns saw just a lossy
// one-line gist, so the owner kept hearing "I don't have the actual image
// content" while still discussing a picture he'd just shared. When there's no
// fresh image, scan the recent history for the most-recent persisted
// `[Image … file_urls: URL]` and re-download it (the url_private stays valid via
// the bot token) so Sonnet sees the real pixels again. Bounded to the
// most-recent image within the last few entries (stops once it scrolls out of
// near context), owner 1:1 only (owner images are trusted — ingestion already
// lets them through), fail-open (any hiccup → no image = the prior behavior).
const IMAGE_REATTACH_LOOKBACK = 6;
function mimeFromImageUrl(url: string): string {
  const u = url.toLowerCase();
  if (u.includes('.jpeg') || u.includes('.jpg')) return 'image/jpeg';
  if (u.includes('.gif')) return 'image/gif';
  if (u.includes('.webp')) return 'image/webp';
  return 'image/png';
}
async function reattachRecentThreadImage(
  history: Array<{ role: string; content: string }>,
  botToken: string,
): Promise<AnthropicImageBlock[] | undefined> {
  const recent = history.slice(-IMAGE_REATTACH_LOOKBACK);
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (m.role !== 'user') continue;
    const match = /\[Image[^\]]*\bfile_urls:\s*(\S+)/i.exec(m.content);
    if (!match) continue;
    const url = match[1];
    try {
      const dl = await downloadSlackImage(url, botToken, mimeFromImageUrl(url));
      if ('error' in dl) {
        logger.warn('image re-attach — re-download failed, proceeding without', { error: dl.error });
        return undefined;
      }
      logger.info('image re-attach — re-attached recent thread image for a follow-up turn', { urlPreview: url.slice(0, 80) });
      return [buildImageBlock(dl)];
    } catch (err) {
      logger.warn('image re-attach threw — proceeding without', { err: String(err).slice(0, 160) });
      return undefined;
    }
  }
  return undefined;
}

  // ── Shared message processor ──────────────────────────────────────────────
  // Single function handles all contexts — DM, group DM, channel mention
export async function processMessage(ctx: SlackAppContext, params: ProcessMessageParams): Promise<void> {
  const { app, profile, colleagueTestThreads, getSenderRole } = ctx;
  const { assistant, user } = profile;
    const { senderId, text, framing, channelId, ts, threadTs, say, client, isChannel, isMpim, isExplicitMention, voiceInput, mpimMemberIds, images, imageUrls } = params;
    const rawRole = getSenderRole(senderId);

    // The MODEL-facing string for this turn, composed exactly once: the framing
    // the handler declared (group-DM preamble, thread roster, thread-action
    // directive, attached-file blocks) wrapped around the person's own words.
    // From here down the choice between the two is by AUDIENCE, never by
    // convenience — the model, history and the inbound queue's merge read
    // `framedText`; everything a PERSON reads (log/audit previews, the briefing
    // event, the addressee gate's subject, the owner's shadow mirror) reads
    // `text`. GH #150 was the one place that had only the fused string.
    //
    // What we deliberately do NOT add to either: a `<<FROM …>>` / `[From: …]`
    // sender wrapper. Every such marker we tried either collided with the
    // injection scanner's owner_spoof regex or got flagged by the Haiku coord
    // judge as a paste mimicking system syntax — we manufactured our own false
    // positives. The orchestrator learns who is speaking from `senderName` plus
    // the authorization line in the system prompt.
    const framedText = `${framing?.prefix ?? ''}${text}${framing?.suffix ?? ''}`;

    // v3.3.x — a delivered inbound proves the socket is alive RIGHT NOW. Stamp
    // the recovery watermark here (the shared entry for DM/MPIM/mention). The
    // watermark is what scopes on-restart / on-reconnect catch-up to the actual
    // downtime gap instead of a blind 24h window — and stamping on real inbound
    // (never the bare process timer) is what keeps a dead-socket zombie's
    // watermark correctly frozen so its gap is fully recovered.
    try {
      const { stampSocketAlive } = require('../socketWatermark') as typeof import('../socketWatermark');
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
    // Channel security (owner direction): a real channel is a shared, often-public
    // surface, so the owner is clamped to colleague-context there too — even when
    // HE is the one asking. He keeps AUTHORITY via the colleague-allowed tools (and
    // the thread-action directive when present), but loses owner-only tools
    // (get_free_busy, recall_preferences, get_person_memory, news/web_research, …)
    // and owner-level narration, so his private calendar / owner-only data never
    // lands in a channel. Like owner-in-group he also skips the colleague funnel
    // (self-upsert / rate-limit / outreach-reply intercept). Colleague-test mode is
    // DM-only (isChannel is false there), so it is unaffected.
    const isOwnerInChannel = isChannel === true && rawRole === 'owner';
    const role: SenderRole = (isMpim || isChannel || isColleagueTest) ? 'colleague' : rawRole;
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
      ownerUserId: user.slack_user_id,
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
    // Owner-in-group / owner-in-channel gets colleague TOOLS but skips the colleague
    // funnel (no self-upsert, no rate limit, no coord/outreach intercept)
    // Report row 146b — ONE users.info fetch for this senderId, hoisted above
    // the colleague block and reused by Step 4's logEvent title and by the
    // colleagueName resolution further down (previously three separate round
    // trips for the same fact across this function). Throw-on-failure is
    // deliberate: a failed lookup must leave `colleagueSenderUser` unset, so
    // no people_memory upsert happens and no "Colleague identified" log fires
    // for a fetch that never succeeded (146a — a transient failure must never
    // overwrite a stored real name with the raw Slack ID).
    let colleagueSenderUser: any;
    if (role === 'colleague' && !isOwnerInGroup && !isOwnerInChannel) {
      // Step 1: Resolve persona — always do this before anything else so we know who we're talking to
      let colleagueIdentified = false;
      try {
        const senderInfo = await app.client.users.info({
          token: assistant.slack.bot_token,
          user: senderId,
        });
        colleagueSenderUser = senderInfo?.user as any;
        const senderName = colleagueSenderUser?.real_name ?? senderId;
        logger.info('Colleague identified', { senderId, name: senderName, channel: channelId });
        colleagueIdentified = true;

        // Build relationship memory
        upsertPersonMemory({
          slackId:  senderId,
          name:     senderName,
          email:    colleagueSenderUser?.profile?.email   || undefined,
          timezone: colleagueSenderUser?.tz               || undefined,
        });
        // Detect gender in background if not yet known
        const colImageUrl = colleagueSenderUser?.profile?.image_192 || colleagueSenderUser?.profile?.image_72 || undefined;
        detectAndSaveGender({
          slackId:  senderId,
          name:     senderName,
          pronouns: colleagueSenderUser?.profile?.pronouns || undefined,
          imageUrl: colImageUrl,
          botToken: assistant.slack.bot_token,
          // #51 — first-person Hebrew morphology self-declaration tier. Opt-in
          // (default off); `text` here is genuinely senderId's OWN message, the
          // one condition detectAndSaveGender requires before reading it as a
          // self-declaration.
          selfText: profile.advanced.self_declared_gender_detection ? text : undefined,
        }).catch(() => {});
      } catch (err) {
        logger.warn('Could not identify colleague — proceeding anyway', { senderId, err: String(err) });
      }

      // Step 2: Check if this is a reply to an active outreach job
      try {
        const outreachHandled = await handleOutreachReply(app, {
          // framedText, so the reply matcher's input is byte-identical to what it
          // read before the framing split — requests owns what this reads.
          senderId, text: framedText, profile,
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
        const senderName = colleagueSenderUser?.real_name ?? senderId;
        logEvent({
          ownerUserId: profile.user.slack_user_id,
          type: 'message',
          title: `${senderName} sent you a message`,
          detail: text.slice(0, 200),
          actor: senderName,
        });
      }
    }

    // v2.0.7 — legacy "approve appr_xxx" / "reject appr_xxx" command path
    // retired. That route wrote to the (now-dropped) approval_queue table.
    // Approvals today use the first-class `approvals` table + free-text
    // replies bound by Sonnet via `resolve_approval`, so no command parsing
    // is needed here.


    const dbHistory = getConversationHistory(threadTs);
    // When the owner keeps discussing a picture from an earlier turn (no
    // fresh image this turn), re-attach the recent thread image so Sonnet sees
    // the real pixels, not the lossy gist. Owner 1:1 only; fresh images win.
    const reattachedImages = (!images?.length && role === 'owner' && !isChannel && !isMpim)
      ? await reattachRecentThreadImage(dbHistory, assistant.slack.bot_token)
      : undefined;
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
          ? `[Image${imageDescPart} — file_urls: ${imageUrls.join(' ')}] ${framedText}`
          : `[Image${imageDescPart}] ${framedText}`)
      : framedText;
    appendToConversation(threadTs, channelId, { role: 'user', content: persistedText, ts });

    // ── Load actual Slack thread replies and merge with DB history ──────────
    // The DB only has messages Maelle processed. In channels/MPIMs she may have
    // missed messages (not mentioned, relevance filtered). Fetch the real thread
    // so Claude has the full picture.
    // v3.5.x — ONLY merge in channels/MPIMs. In a 1:1 DM Maelle misses nothing
    // (every inbound is processed + appended), so the merge added zero new info
    // and only re-inflated stale history past the DB's recency cap — burying a
    // NEW request under ~50 messages of an already-finished one (Daniel,
    // 2026-06-29: a fresh "meeting with Tal" ask read as a continuation).
    let history = dbHistory;
    if (threadTs !== ts && (isChannel || isMpim)) {
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
        // v4.4.x — resolve @mentions the same way every persisted path does
        // (handlers.ts:415/:729/:1241). This text comes straight off
        // conversations.replies, never through the inbound handler, so without
        // this pass a bare `<@U0ARK...>` id syntax rode into the merged history
        // (and from there into the model / a reply) instead of a resolved name.
        //
        // v4.4.9 — exclude Maelle's OWN messages (m.user === ctx.botUserId) from
        // "missed" reconciliation entirely. This block's whole premise (see the
        // comment above, v3.5.x) is recovering INBOUND messages the addressee
        // gate filtered before she ever saw them — that concept doesn't apply to
        // her own replies, she always knows what she said. But assistant rows
        // written by appendToConversation (postReply.ts Step 3b) never carry a
        // ts (they're persisted before the Slack send returns one), so every one
        // of her own past replies failed the `dbTimestamps.has(m.ts)` check and
        // was funneled back in here as a "missed" message: reprocessed through
        // resolveSlackMentions (meant for fresh inbound text, not her own
        // already-resolved output) and duplicated alongside the identical
        // content already sitting in dbHistory — doubling every one of her own
        // replies in the model's context on every channel/MPIM catch-up merge.
        const missedMessages = await Promise.all(slackMessages
          .filter(m => m.user !== ctx.botUserId && !dbTimestamps.has(m.ts) && m.ts !== ts)  // exclude current message + her own replies
          .map(async m => ({
            role: 'user' as const,
            content: await ctx.resolveSlackMentions(m.text as string),
            ts: m.ts as string,
          })));

        if (missedMessages.length > 0) {
          // Merge: combine DB history (has tool summaries) with missed Slack messages
          const merged = [...dbHistory, ...missedMessages].sort((a, b) => {
            const tsA = parseFloat(a.ts || '0');
            const tsB = parseFloat(b.ts || '0');
            return tsA - tsB;
          });
          // Bound to the DB's recency cap (conversations.ts:28 keeps last 20) so
          // a long thread's merge can't re-expand the history the orchestrator
          // just trimmed — the ratchet that bled stale context in.
          history = merged.slice(-20);
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
      // into the system prompt as `senderName`. Reuses the fetch from the
      // colleague block above (row 146b) — no second round trip.
      const colleagueName: string | undefined = (role === 'colleague' && !isOwnerInGroup && !isOwnerInChannel)
        ? (colleagueSenderUser?.real_name || colleagueSenderUser?.name)
        : undefined;

      // ── Group-DM addressee gate ──────────────────────────────────────────
      // In a group DM / channel, not every message is for Maelle. Run a
      // cheap Haiku classifier; stay silent when the message was addressed
      // to a human (or is genuinely ambiguous). Skip for 1:1 DMs.
      if ((isMpim === true || isChannel === true) && ctx.botUserId && !isExplicitMention) {
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
          const { classifyAddressee } = await import('../../../utils/addresseeGate');
          const botId: string = ctx.botUserId!;
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
          // The gate judges the PERSON's message, never Maelle's own framing.
          // v1.8.8 it had to un-fuse the "<<GROUP DM — participants: … >>"
          // preamble with a regex: the preamble pushed "Maelle" past the
          // classifier's text.slice(0, 40) fast-path window and made it read
          // "participants: Swan, Dina" and vote HUMAN on a message that opened
          // with "Maelle, ...". Framing now arrives declared, so `text` already
          // IS the person's words — which also covers the roster,
          // thread-action and attached-file framing that regex never matched.
          const verdict = await classifyAddressee({
            text,
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
          if (await isBriefRequest(text)) {
            logger.info('Brief request detected — short-circuiting to sendMorningBriefing', {
              senderId, channelId, preview: text.slice(0, 80),
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
      const { enqueueMessage, isMergeAbort } = require('../inboundQueue') as typeof import('../inboundQueue');
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
        text: framedText,
        senderName: colleagueName,
        meta: {},
        runner: async ({ mergedText, signal, markWrite }) => {
          // Did anything from this turn actually reach the person? Set by the
          // delivery pipeline (postReply's onDelivered), read only by the
          // failure handler at the bottom of this closure.
          let delivered = false;
          try {
            // v2.6.1 — recent-outbound context lookup for colleague 1:1 DMs.
            // When a colleague replies to Maelle in their DM (top-level OR thread
            // reply on a Maelle-sent message), check for an open outbound from
            // her to them within 24h. Attach as priorOutboundContext so the
            // orchestrator sees "RECENT OUTBOUND TO THIS COLLEAGUE" before
            // drafting. Closes the amnesia (Isaac's "Ok" 2 min after Maelle's
            // heads-up landing as "Hey, what can I help you with?"). Skipped
            // for owner DMs, MPIMs, channels, and owner-in-group contexts —
            // those have their own continuity surfaces.
            let priorOutboundContext: string | undefined;
            if (role === 'colleague' && !isMpim && !isChannel && !isOwnerInGroup) {
              try {
                const { getRecentOutboundContext, closeFollowupForMessageTs, buildThreadReplyContextBlock } =
                  await import('../recentOutboundContext');
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
                // (classify every open candidate <=24h / auto-expire >24h;
                // the old <10min deterministic bypass was removed, gh#176/#177).
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
                const { tryAutoResolveThreadBoundApproval } = await import('../../../utils/threadBoundApprovalAutoResolve');
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

            logger.info('Calling orchestrator', { senderId, role, channelId, threadTs, isOwnerInGroup: isOwnerInGroup ?? false, historyLength: history.length, imageCount: images?.length ?? 0, forceTool: forceToolOnFirstTurn?.name, batched: mergedText !== framedText, hasPriorOutboundContext: !!priorOutboundContext });
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
              images: images?.length ? images : reattachedImages,
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
            const { postOrchestratorReply } = await import('../postReply');
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
              // The person's own words — NOT framedText. Step 4.6 mirrors this
              // string to the owner as `X said: "…"` (GH #150).
              userMessage: text,
              // v4.3.x (#144) — the Haiku vision description already
              // computed above (zero new LLM calls) so the Step 4.6 shadow
              // receipt reports what the picture showed, not just the raw
              // caption placeholder. undefined when there was no image (or
              // the vision pass produced nothing) — the field only means
              // "there is a description to add".
              inboundAttachmentNote: imageDescPart || undefined,
              isMpim,
              isChannel,
              isOwnerInGroup,
              mpimMemberIds,
              voiceInput,
              // The one signal the failure handler below needs: has the person seen
              // anything from this turn yet?
              onDelivered: () => { delivered = true; },
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
                      // v4.4.10 — same class of fix as postReply.ts Step 3b: this
                      // breadcrumb has no real Slack ts (it's a synthetic history
                      // row, not a posted message), so without a stamp it parses to
                      // 0 in the catch-up merge's `parseFloat(m.ts || '0')` sort
                      // above (line 370) and jumps to the front of every merged
                      // history — ahead of every real message, and the first row
                      // the `.slice(-20)` trim drops. Wall-clock at write time, in
                      // Slack ts format, sorts it correctly relative to the
                      // messages around it instead.
                      ts: (Date.now() / 1000).toFixed(6),
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
          } catch (err) {
            // THE failure handler for the reply path, and it has to live in here.
            // This closure runs from scheduleRun's timer, long after
            // processMessage returned, so the try/catch below — the one that
            // lexically encloses these very lines — never sees a throw from
            // inside it. Since v2.4.3 put the turn behind the queue, everything
            // past `enqueueMessage` has failed into one log line and total
            // silence: 2026-07-20 09:12, a 529 mid-turn, Elan asked to book a
            // slot in his DM and Maelle never said a word.
            //
            // An ABORT is not a failure — the queue killed this turn on purpose
            // to merge a message that landed while we were thinking (S8), and a
            // superseded turn apologising would be a brand-new bug. Re-throw so
            // the queue's abort branch restarts the debounce exactly as before.
            if (isMergeAbort(err, signal)) throw err;
            logger.error('Turn failed after the queue took the message', {
              err, senderId, channelId, threadTs, role, delivered,
            });
            // Already answered, and then something in the tail threw (the
            // approval footer's own send, the threadActivity import). Do NOT
            // stack "something's off" on top of an answer the person is reading
            // — a broken trailer's audience is the log, not them.
            if (delivered) return;
            try {
              await say({ text: failureReply(err), thread_ts: threadTs });
            } catch (sendErr) {
              // Slack itself is refusing us; there is nothing left to try. Log
              // the ORIGINAL cause here so it survives into error-*.log instead
              // of being replaced by the send failure at the queue's backstop.
              logger.error('Failure reply could not be delivered either — the person is left with silence', {
                cause: String(err).slice(0, 300), sendErr: String(sendErr).slice(0, 200),
                channelId, threadTs,
              });
            }
          }
        },  // ← close runner async function (v2.4.3 A1)
      });  // ← close enqueueMessage call

    } catch (err) {
      // PRE-QUEUE failures only — everything from the addressee gate down to the
      // synchronous `enqueueMessage` call above (the summary-session read, the
      // module require). Once the queue has the message the turn runs on its own
      // timer and owns its failures in the runner catch above; this one cannot
      // see them.
      logger.error('Failed to process message', { err, assistant: assistant.name, channelId });
      await say({ text: failureReply(err), thread_ts: threadTs });
    }
}
