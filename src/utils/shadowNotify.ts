import type { UserProfile } from '../config/userProfile';
import { getConnection } from '../connections/registry';
import type { SendOptions } from '../connections/types';
import { appendToConversation } from '../db/conversations';
import logger from './logger';
import { getOrCreateOwnerDailyThread } from './ownerDailyThread';

/**
 * Shadow mode — v1 safety net.
 *
 * When enabled in the user profile (behavior.v1_shadow_mode: true), Maelle
 * posts a compact, unobtrusive receipt in the owner's DM every time she
 * takes an autonomous action — even one that doesn't require approval.
 *
 * SECURITY: Shadow messages are ONLY sent to the owner's DM channel.
 * If the originating channel is not the owner's DM, we redirect to the
 * owner's DM instead. Colleagues must NEVER see shadow/debug messages.
 *
 * Where in the owner's DM (three routes, first match wins):
 *   1. `conversationKey` — one owner-DM thread per conversation ("Conversation
 *      with X"), anchored on the first shadow for that key.
 *   2. caller's `channel` + `threadTs` IS the owner's own DM thread — post there,
 *      inside the conversation he is already reading.
 *   3. everything else (a rebalance move, an unkeyed auto-fix, a flood or
 *      image-guard notice from a colleague surface) — a reply in the owner's
 *      daily thread (`getOrCreateOwnerDailyThread`), never a fresh top-level
 *      DM. Owner ruling 2026-09-15 on "🔧 Floating block rebalanced" landing
 *      top-level: "spammy to get it a couple of times a day in a new thread".
 *      Each notice is also appended to that thread's history so a reply to it
 *      has the notice in context (SlackMaster S4). Plain top-level DM only
 *      when the daily thread cannot be reached.
 *
 * Ported to the Connection interface in v1.8.14 — no longer takes `app`.
 * Skills that call shadowNotify are now fully transport-agnostic.
 */

/** Per-profile cache of the owner's DM channel id. */
const ownerDmChannelCache: Map<string, string> = new Map();

/**
 * v2.3.2 — shadow threading cache. Key = `${ownerId}:${conversationKey}` →
 * the owner-DM ts of the FIRST shadow we sent for that conversation. Every
 * subsequent shadow with the same conversationKey threads under that ts.
 *
 * Conversation key is the inbound Slack threadTs in most cases (colleague DM
 * conversations, owner DM conversations, MPIM threads). Different
 * threads = different conversation keys = different shadow threads in the
 * owner's DM. No timeout — Slack threadTs is unique-per-thread, so two
 * conversations a week apart naturally get different keys.
 *
 * Process-wide; restart re-anchors with one extra top-level shadow per
 * still-active key (acceptable cost).
 */
const shadowThreadAnchors: Map<string, string> = new Map();

export async function shadowNotify(
  profile: UserProfile,
  params: {
    channel: string;
    threadTs?: string;
    action: string;   // short label, e.g. "DM sent", "Meeting booked"
    detail: string;   // one line, e.g. "Sent Simon 3 slot options for 'Q3 review'"
    /**
     * v2.3.2 — optional conversation key for shadow threading. When passed,
     * the first shadow with this key creates a top-level owner-DM message
     * (with a header line); every subsequent shadow with the same key
     * threads under it. Use the inbound colleague threadTs for inbound-
     * colleague shadows, the request's own origin thread for request-side
     * shadows, or any stable per-conversation id. Omit for system shadows (cron ticks,
     * dispatchers without a conversation context) — those go to the owner's daily thread.
     */
    conversationKey?: string;
    /**
     * v2.3.2 — optional one-line header for the FIRST shadow on a new
     * conversation key. Renders as a top-level "🔍 *Conversation header*"
     * line so the owner can scan their DM and tell what each thread is
     * about (e.g. "Conversation with Isaac Moddel"). Ignored on
     * subsequent shadows in the same thread.
     */
    conversationHeader?: string;
    /**
     * Leading glyph. Defaults to 🔍 (the shadow/receipt icon). Autonomous
     * calendar-REPAIR shadows (auto-move, floating-block consolidate / rebalance /
     * overlap) pass a wrench 🔧 so a fix reads distinct from a conversation receipt.
     */
    icon?: string;
    /**
     * v4.3.x (#144, piece 1) — optional file attachments, forwarded as-is to
     * whichever Connection send verb this call resolves to (postToChannel
     * or sendDirect). Reuses SendOptions.attachments end-to-end; both verbs
     * already have the upload primitive, so no branching is needed here.
     */
    attachments?: SendOptions['attachments'];
  }
): Promise<void> {
  if (!profile.behavior.v1_shadow_mode) return;

  const ownerId = profile.user.slack_user_id;
  const conn = getConnection(ownerId, 'slack');
  if (!conn) {
    logger.warn('shadowNotify — no Slack connection registered', { ownerId, action: params.action });
    return;
  }

  try {
    const icon = params.icon ?? '🔍';
    const text = `${icon} _*${params.action}:* ${params.detail}_`;

    // v2.3.2 — conversation-key threading takes priority. If the caller
    // tagged this shadow with a conversationKey, use the cached anchor (or
    // create one) so all shadows from this conversation collapse into one
    // owner-DM thread. Independent of the caller's channel — works for
    // colleague-DM conversations and the requests spine alike.
    if (params.conversationKey) {
      const cacheKey = `${ownerId}:${params.conversationKey}`;
      const anchorTs = shadowThreadAnchors.get(cacheKey);
      const ownerDm = ownerDmChannelCache.get(ownerId);

      if (anchorTs && ownerDm) {
        // Thread under existing anchor.
        const res = await conn.postToChannel(ownerDm, text, { threadTs: anchorTs, attachments: params.attachments });
        if (res.ok) {
          if (res.attachments_failed) {
            logger.warn('shadowNotify attachment upload failed (thread post)', {
              attachments_failed: res.attachments_failed, action: params.action,
            });
          }
          return;
        }
        logger.info('shadowNotify thread post failed, falling back to fresh anchor', {
          reason: res.reason, detail: res.detail, action: params.action,
        });
        // fall through: re-anchor below
      }

      // First shadow on this conversationKey (or anchor lost). Post a
      // top-level header + this shadow's body, then cache the resulting ts
      // as the anchor for subsequent shadows on the same key.
      const headerLine = params.conversationHeader
        ? `${icon} *${params.conversationHeader}*\n${text}`
        : text;
      const res = await conn.sendDirect(ownerId, headerLine, { attachments: params.attachments });
      if (!res.ok) {
        logger.warn('shadowNotify (conversation-key, first send) failed', {
          reason: res.reason, detail: res.detail, action: params.action,
        });
        return;
      }
      if (res.ref) ownerDmChannelCache.set(ownerId, res.ref);
      if (res.ts) shadowThreadAnchors.set(cacheKey, res.ts);
      if (res.attachments_failed) {
        logger.warn('shadowNotify attachment upload failed (conversation-key first send)', {
          attachments_failed: res.attachments_failed, action: params.action,
        });
      }
      return;
    }

    // v2.0.6 — if the caller passed a channel + threadTs AND the channel is
    // the owner's own DM, post in-thread there. Any outreach or request that the
    // owner started in a thread flows this way so the shadow messages stay
    // inside the conversation the owner is already reading.
    //
    // v2.1.5 — the prior check was `channel.startsWith('D')` which was wrong:
    // every 1:1 Slack DM starts with 'D', including colleague DMs. That
    // leaked shadow content into colleague threads. The in-thread path is
    // now gated on the cached owner-DM channel id — matches only when the
    // caller-provided channel is the verified owner DM. First-ever call
    // (cache empty) falls through to sendDirect, which populates the cache.
    const knownOwnerDm = ownerDmChannelCache.get(ownerId);
    if (params.channel && params.threadTs && knownOwnerDm && params.channel === knownOwnerDm) {
      const res = await conn.postToChannel(params.channel, text, { threadTs: params.threadTs, attachments: params.attachments });
      if (res.ok) {
        ownerDmChannelCache.set(ownerId, params.channel);
        if (res.attachments_failed) {
          logger.warn('shadowNotify attachment upload failed (in-thread post)', {
            attachments_failed: res.attachments_failed, action: params.action,
          });
        }
        return;
      }
      logger.info('shadowNotify in-thread post failed, falling back to DM', {
        reason: res.reason, detail: res.detail, action: params.action,
      });
      // fall through
    }

    // Default: a reply in the owner's daily thread. Used when the originating
    // context wasn't the owner's DM (a rebalance sweep, a colleague-surface
    // notice, a top-level ask with no thread_ts) — the day's housekeeping reads
    // as one thread he can follow or mute instead of a top-level DM per notice.
    const daily = await getOrCreateOwnerDailyThread({ profile, conn });
    if (daily) {
      const res = await conn.postToChannel(daily.channel, text, { threadTs: daily.rootTs, attachments: params.attachments });
      if (res.ok) {
        ownerDmChannelCache.set(ownerId, daily.channel);
        recordShadowInHistory(daily.rootTs, daily.channel, text, res.ts, params.action);
        if (res.attachments_failed) {
          logger.warn('shadowNotify attachment upload failed (daily-thread post)', {
            attachments_failed: res.attachments_failed, action: params.action,
          });
        }
        return;
      }
      logger.info('shadowNotify daily-thread post failed, falling back to DM', {
        reason: res.reason, detail: res.detail, action: params.action,
      });
    }

    // Daily thread unreachable — a plain DM still beats a lost notice.
    const res = await conn.sendDirect(ownerId, text, { attachments: params.attachments });
    if (!res.ok) {
      logger.warn('shadowNotify failed (sendDirect)', { reason: res.reason, detail: res.detail, action: params.action });
      return;
    }
    if (res.ref) ownerDmChannelCache.set(ownerId, res.ref);
    if (res.ts) recordShadowInHistory(res.ts, res.ref ?? '', text, res.ts, params.action);
    if (res.attachments_failed) {
      logger.warn('shadowNotify attachment upload failed (default sendDirect)', {
        attachments_failed: res.attachments_failed, action: params.action,
      });
    }
  } catch (err) {
    // Shadow notifications are fire-and-forget — never let them break the main flow.
    logger.warn('shadowNotify threw', { err: String(err), action: params.action });
  }
}

/**
 * A notice that lands in a thread must be readable by the next turn in that
 * thread: a DM turn builds its context from `getConversationHistory(threadTs)`
 * alone (processMessage.ts — no Slack replies merge in a 1:1), so without this
 * row the owner's "why did you move lunch?" under the notice would meet a model
 * that never saw the notice. Delivery already succeeded; a history failure is
 * logged, never retried (a retry would post the notice twice).
 */
function recordShadowInHistory(threadTs: string, channel: string, text: string, ts: string | undefined, action: string): void {
  try {
    appendToConversation(threadTs, channel, { role: 'assistant', content: text, ts });
  } catch (err) {
    logger.warn('shadowNotify — history append failed', { action, threadTs, err: String(err).slice(0, 200) });
  }
}
