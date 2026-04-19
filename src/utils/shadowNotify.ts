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

export async function shadowNotify(
  profile: UserProfile,
  params: {
    channel: string;
    threadTs?: string;
    action: string;   // short label, e.g. "DM sent", "Meeting booked"
    detail: string;   // one line, e.g. "Sent Simon 3 slot options for 'Q3 review'"
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
    const cached = ownerDmChannelCache.get(ownerId);

    // If we already know the owner's DM channel AND the originating channel
    // matches it, thread into the same conversation. Otherwise send a
    // standalone DM to the owner (and learn the channel id from the result).
    if (cached && cached === params.channel) {
      const res = await conn.postToChannel(cached, text, { threadTs: params.threadTs });
      if (!res.ok) {
        logger.warn('shadowNotify failed (cached channel)', { reason: res.reason, detail: res.detail, action: params.action });
      }
      return;
    }

    const res = await conn.sendDirect(ownerId, text);
    if (!res.ok) {
      logger.warn('shadowNotify failed (sendDirect)', { reason: res.reason, detail: res.detail, action: params.action });
      return;
    }
    // Cache the owner's DM channel id from the first successful send so
    // subsequent calls can detect "same channel" and preserve thread context.
    if (res.ref) ownerDmChannelCache.set(ownerId, res.ref);
  } catch (err) {
    // Shadow notifications are fire-and-forget — never let them break the main flow.
    logger.warn('shadowNotify threw', { err: String(err), action: params.action });
  }
}
