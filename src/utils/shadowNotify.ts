import type { App } from '@slack/bolt';
import type { UserProfile } from '../config/userProfile';
import logger from './logger';

/**
 * Shadow mode — v1 safety net.
 *
 * When enabled in the user profile (behavior.v1_shadow_mode: true), Maelle
 * posts a compact, unobtrusive receipt in the owner's thread every time she
 * takes an autonomous action — even one that doesn't require approval.
 *
 * SECURITY: Shadow messages are ONLY sent to the owner's DM channel.
 * If the originating channel is not the owner's DM, we redirect to the
 * owner's DM instead. Colleagues must NEVER see shadow/debug messages.
 */

/** Cache the owner's DM channel ID so we don't re-open it every call */
let ownerDmChannelCache: string | null = null;

async function getOwnerDmChannel(app: App, profile: UserProfile): Promise<string> {
  if (ownerDmChannelCache) return ownerDmChannelCache;

  const result = await app.client.conversations.open({
    token: profile.assistant.slack.bot_token,
    users: profile.user.slack_user_id,
  });
  ownerDmChannelCache = (result.channel as any)?.id ?? null;
  if (!ownerDmChannelCache) throw new Error('Could not open DM with owner');
  return ownerDmChannelCache;
}

export async function shadowNotify(
  app: App,
  profile: UserProfile,
  params: {
    channel: string;
    threadTs?: string;
    action: string;   // short label, e.g. "DM sent", "Meeting booked"
    detail: string;   // one line, e.g. "Sent Simon 3 slot options for 'Q3 review'"
  }
): Promise<void> {
  if (!profile.behavior.v1_shadow_mode) return;

  try {
    // SECURITY: Only send shadow messages to the owner's DM.
    // If the channel is already the owner's DM, use it (with thread context).
    // Otherwise, redirect to the owner's DM with no thread (standalone).
    const ownerDm = await getOwnerDmChannel(app, profile);
    const isOwnerChannel = params.channel === ownerDm;

    await app.client.chat.postMessage({
      token: profile.assistant.slack.bot_token,
      channel: ownerDm,
      // Only preserve thread context if we're already in the owner's DM
      thread_ts: isOwnerChannel ? params.threadTs : undefined,
      text: `_[shadow] ${params.action}: ${params.detail}_`,
      // Using context block so it renders smaller/dimmer than a regular message
      blocks: [
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `🔍 *${params.action}:* ${params.detail}`,
            },
          ],
        },
      ],
    });
  } catch (err) {
    // Shadow notifications are fire-and-forget — never let them break the main flow
    logger.warn('shadowNotify failed', { err: String(err), action: params.action });
  }
}
