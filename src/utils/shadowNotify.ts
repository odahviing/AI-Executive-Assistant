import type { UserProfile } from '../config/userProfile';
import { getConnection } from '../connections/registry';
import logger from './logger';

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
 * conversations, owner DM conversations, MPIM coord threads). Different
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
     * colleague shadows, owner_thread_ts for coord-side shadows, or any
     * stable per-conversation id. Omit for system shadows (cron ticks,
     * dispatchers without a conversation context) — those stay top-level.
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
    const text = `🔍 _*${params.action}:* ${params.detail}_`;

    // v2.3.2 — conversation-key threading takes priority. If the caller
    // tagged this shadow with a conversationKey, use the cached anchor (or
    // create one) so all shadows from this conversation collapse into one
    // owner-DM thread. Independent of the caller's channel — works for
    // colleague-DM conversations and coord state machine alike.
    if (params.conversationKey) {
      const cacheKey = `${ownerId}:${params.conversationKey}`;
      const anchorTs = shadowThreadAnchors.get(cacheKey);
      const ownerDm = ownerDmChannelCache.get(ownerId);

      if (anchorTs && ownerDm) {
        // Thread under existing anchor.
        const res = await conn.postToChannel(ownerDm, text, { threadTs: anchorTs });
        if (res.ok) return;
        logger.info('shadowNotify thread post failed, falling back to fresh anchor', {
          reason: res.reason, detail: res.detail, action: params.action,
        });
        // fall through: re-anchor below
      }

      // First shadow on this conversationKey (or anchor lost). Post a
      // top-level header + this shadow's body, then cache the resulting ts
      // as the anchor for subsequent shadows on the same key.
      const headerLine = params.conversationHeader
        ? `🔍 *${params.conversationHeader}*\n${text}`
        : text;
      const res = await conn.sendDirect(ownerId, headerLine);
      if (!res.ok) {
        logger.warn('shadowNotify (conversation-key, first send) failed', {
          reason: res.reason, detail: res.detail, action: params.action,
        });
        return;
      }
      if (res.ref) ownerDmChannelCache.set(ownerId, res.ref);
      if (res.ts) shadowThreadAnchors.set(cacheKey, res.ts);
      return;
    }

    // v2.0.6 — if the caller passed a channel + threadTs AND the channel is
    // the owner's own DM, post in-thread there. Any coord/outreach that the
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
      const res = await conn.postToChannel(params.channel, text, { threadTs: params.threadTs });
      if (res.ok) {
        ownerDmChannelCache.set(ownerId, params.channel);
        return;
      }
      logger.info('shadowNotify in-thread post failed, falling back to DM', {
        reason: res.reason, detail: res.detail, action: params.action,
      });
      // fall through
    }

    // Default: standalone DM to the owner. Used when the originating context
    // wasn't the owner's DM (e.g. coord initiated by a colleague, or top-level
    // ask with no thread_ts).
    const res = await conn.sendDirect(ownerId, text);
    if (!res.ok) {
      logger.warn('shadowNotify failed (sendDirect)', { reason: res.reason, detail: res.detail, action: params.action });
      return;
    }
    if (res.ref) ownerDmChannelCache.set(ownerId, res.ref);
  } catch (err) {
    // Shadow notifications are fire-and-forget — never let them break the main flow.
    logger.warn('shadowNotify threw', { err: String(err), action: params.action });
  }
}
