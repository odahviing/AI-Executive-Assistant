/**
 * Slack messaging primitives (v1.7.2).
 *
 * This is the foundation of the planned Connection-interface migration tracked
 * in issue #1. It exposes a small surface that domain skills can use to send
 * messages WITHOUT importing from connectors/slack/coordinator.ts (which is
 * still domain-muddled).
 *
 * Today: only Slack. Tomorrow: each Connection (slack, email, whatsapp)
 * implements the same shape so domain skills don't change when transports
 * are added or swapped.
 *
 * SummarySkill is the first consumer. As coord.ts and outreach.ts get ported
 * (issue #1), they'll route through here too — at which point coordinator.ts
 * shrinks to a Slack-specific Connection implementation.
 *
 * Important: this module is fire-and-forget. It does NOT create outreach_jobs
 * rows or track replies — that's an outreach concern. Use this for "send and
 * move on" messaging like distributing a meeting summary. For send-and-track
 * use OutreachCoreSkill's message_colleague tool.
 */

import type { App } from '@slack/bolt';
import logger from '../../utils/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SlackUserSearchResult {
  id: string;
  name: string;
  real_name: string;
  email?: string;
  tz: string;
  is_external_guest: boolean;   // workspace guest (not a full member)
}

export interface SlackChannelSearchResult {
  id: string;
  name: string;
  is_private: boolean;
  is_archived: boolean;
}

export type SendOutcome =
  | { ok: true; channel_id: string; ts?: string }
  | { ok: false; reason: 'not_in_channel_private' | 'channel_not_found' | 'user_not_found' | 'error'; detail: string };

// ── Sends ────────────────────────────────────────────────────────────────────

/** Send a 1:1 DM to a Slack user. Opens the DM channel if needed. */
export async function sendDM(
  app: App,
  botToken: string,
  userId: string,
  text: string,
  opts: {
    threadTs?: string;
    attachments?: Array<{ sourceUrl: string; filename?: string }>;
  } = {},
): Promise<SendOutcome> {
  try {
    const open = await app.client.conversations.open({ token: botToken, users: userId });
    const channelId = (open.channel as any)?.id as string | undefined;
    if (!channelId) return { ok: false, reason: 'user_not_found', detail: `Could not open DM with ${userId}` };

    const res = await app.client.chat.postMessage({
      token: botToken,
      channel: channelId,
      text,
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    });

    // v2.2.7 — attachments. Download each Slack file URL with bot-token auth,
    // then re-upload to the same channel under the same thread (or under the
    // text message's own ts when no explicit thread). Failures don't fail the
    // send — text already landed; we log and move on. Slack file URLs require
    // Authorization: Bearer <bot_token> to download.
    if (opts.attachments && opts.attachments.length > 0 && res.ts) {
      const threadForAttachments = opts.threadTs ?? res.ts;
      for (const att of opts.attachments) {
        try {
          const fileResp = await fetch(att.sourceUrl, {
            headers: { Authorization: `Bearer ${botToken}` },
          });
          if (!fileResp.ok) {
            logger.warn('sendDM attachment download failed', {
              url: att.sourceUrl, status: fileResp.status,
            });
            continue;
          }
          const buf = Buffer.from(await fileResp.arrayBuffer());
          const filename = att.filename || att.sourceUrl.split('/').pop() || 'attachment';
          await app.client.files.uploadV2({
            token: botToken,
            channel_id: channelId,
            thread_ts: threadForAttachments,
            file: buf,
            filename,
          });
        } catch (err) {
          logger.warn('sendDM attachment upload failed', {
            url: att.sourceUrl, err: String(err).slice(0, 200),
          });
        }
      }
    }

    return { ok: true, channel_id: channelId, ts: res.ts };
  } catch (err: any) {
    const detail = err?.data?.error ?? err?.message ?? String(err);
    logger.warn('sendDM failed', { userId, detail });
    return { ok: false, reason: 'error', detail };
  }
}

/**
 * Send a group DM (MPIM) to N users. Slack's conversations.open accepts a
 * comma-separated user list and creates the MPIM if needed.
 */
export async function sendMpim(
  app: App,
  botToken: string,
  userIds: string[],
  text: string,
  opts: { threadTs?: string } = {},
): Promise<SendOutcome> {
  if (userIds.length === 0) return { ok: false, reason: 'user_not_found', detail: 'no users supplied' };
  try {
    const open = await app.client.conversations.open({ token: botToken, users: userIds.join(',') });
    const channelId = (open.channel as any)?.id as string | undefined;
    if (!channelId) return { ok: false, reason: 'user_not_found', detail: 'could not open MPIM' };

    const res = await app.client.chat.postMessage({
      token: botToken,
      channel: channelId,
      text,
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    });
    return { ok: true, channel_id: channelId, ts: res.ts };
  } catch (err: any) {
    const detail = err?.data?.error ?? err?.message ?? String(err);
    logger.warn('sendMpim failed', { userIds, detail });
    return { ok: false, reason: 'error', detail };
  }
}

/**
 * Post to a public or private channel. Auto-joins public channels we're
 * not in; refuses private channels we haven't been invited to.
 */
export async function postToChannel(
  app: App,
  botToken: string,
  channelId: string,
  text: string,
  opts: { threadTs?: string } = {},
): Promise<SendOutcome> {
  const tryPost = async () => app.client.chat.postMessage({
    token: botToken,
    channel: channelId,
    text,
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
  });

  try {
    const res = await tryPost();
    return { ok: true, channel_id: channelId, ts: res.ts };
  } catch (err: any) {
    const code: string = err?.data?.error ?? err?.message ?? '';

    if (code === 'not_in_channel') {
      try {
        const info = await app.client.conversations.info({ token: botToken, channel: channelId }) as any;
        const isPrivate: boolean = info?.channel?.is_private ?? true;
        if (isPrivate) {
          return {
            ok: false,
            reason: 'not_in_channel_private',
            detail: `I'm not a member of that private channel and can't join without an invite.`,
          };
        }
        await app.client.conversations.join({ token: botToken, channel: channelId });
        const res = await tryPost();
        return { ok: true, channel_id: channelId, ts: res.ts };
      } catch (joinErr: any) {
        return { ok: false, reason: 'error', detail: joinErr?.data?.error ?? String(joinErr) };
      }
    }

    if (code === 'channel_not_found') {
      return { ok: false, reason: 'channel_not_found', detail: code };
    }

    logger.warn('postToChannel failed', { channelId, detail: code });
    return { ok: false, reason: 'error', detail: code };
  }
}

// ── Lookups ──────────────────────────────────────────────────────────────────

/**
 * Find Slack workspace users by display/real name. Returns up to 200 matches.
 * The `is_external_guest` flag flips true for users marked is_restricted /
 * is_ultra_restricted by the workspace — useful for the "internals only" rule
 * the Summary skill applies.
 */
export async function findUserByName(
  app: App,
  botToken: string,
  name: string,
): Promise<SlackUserSearchResult[]> {
  try {
    const result = await app.client.users.list({ token: botToken, limit: 200 });
    const members = (result.members ?? []) as any[];
    const query = name.toLowerCase().trim();
    if (!query) return [];

    return members
      .filter(m =>
        !m.deleted && !m.is_bot &&
        (
          m.real_name?.toLowerCase().includes(query) ||
          m.name?.toLowerCase().includes(query) ||
          m.profile?.display_name?.toLowerCase().includes(query)
        ),
      )
      .map(m => ({
        id: m.id,
        name: m.name,
        real_name: m.real_name ?? m.name,
        email: m.profile?.email ?? undefined,
        tz: m.tz ?? 'UTC',
        is_external_guest: !!(m.is_restricted || m.is_ultra_restricted),
      }));
  } catch (err) {
    logger.error('findUserByName failed', { err: String(err), name });
    return [];
  }
}

export async function findChannelByName(
  app: App,
  botToken: string,
  name: string,
): Promise<SlackChannelSearchResult[]> {
  try {
    const result = await app.client.conversations.list({
      token: botToken,
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
    });
    const channels = (result.channels ?? []) as any[];
    const query = name.toLowerCase().replace(/^#/, '').trim();
    if (!query) return [];

    return channels
      .filter(c => c.name?.toLowerCase().includes(query))
      .map(c => ({
        id: c.id,
        name: c.name,
        is_private: !!c.is_private,
        is_archived: !!c.is_archived,
      }));
  } catch (err) {
    logger.error('findChannelByName failed', { err: String(err), name });
    return [];
  }
}
