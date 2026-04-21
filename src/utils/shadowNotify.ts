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

    // v2.0.6 — if the caller passed a channel + threadTs AND the channel is a
    // Slack DM (id starts with 'D'), post in-thread there. Any coord/outreach
    // that the owner started in a thread flows this way so the shadow messages
    // stay inside the conversation the owner is already reading. Non-DM
    // channels (colleague DMs, MPIMs, public channels) fall through to
    // sendDirect to the owner — that's the security floor: colleagues never
    // see shadow/debug content. No cache needed; postToChannel either succeeds
    // or we fall back cleanly.
    if (params.channel && params.threadTs && params.channel.startsWith('D')) {
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
