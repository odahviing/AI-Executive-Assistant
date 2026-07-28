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

/**
 * v3.1 (audit fix LATENT-2) — only pass a `thread_ts` that looks like a real
 * Slack message ts (`1700000000.000100`). Synthetic ids (e.g. a routine's
 * fallback `routine_<id>_<ms>` when its placeholder DM post failed) would
 * otherwise reach Slack as a `thread_ts`, get rejected, and DROP the message
 * (coord/approval DMs vanished). When the ts is invalid we post top-level in
 * the real channel instead of failing — the message still lands.
 */
function safeThreadTs(ts?: string): string | undefined {
  return ts && /^\d+\.\d+$/.test(ts) ? ts : undefined;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface SlackUserSearchResult {
  id: string;
  name: string;
  real_name: string;
  email?: string;
  tz: string;
}

export interface SlackChannelSearchResult {
  id: string;
  name: string;
}

export type SendOutcome =
  | { ok: true; channel_id: string; ts?: string }
  | { ok: false; reason: 'not_in_channel_private' | 'channel_not_found' | 'user_not_found' | 'error'; detail: string };

// ── Sends ────────────────────────────────────────────────────────────────────

/**
 * v3.3.7 (#125c) — resolve the 1:1 DM channel id for a user (opens it if
 * needed). Same conversations.open call sendDM makes internally; exposed so
 * the Connection can map person → DM channel for verbatim conversation recall.
 */
export async function resolveDmChannelId(
  app: App,
  botToken: string,
  userId: string,
): Promise<string | null> {
  try {
    const open = await app.client.conversations.open({ token: botToken, users: userId });
    return ((open.channel as any)?.id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * v4.1.x (#51) — the REVERSE of resolveDmChannelId: given a DM channel, who is
 * the human on the other side? `conversations.info` returns `channel.user` for
 * an `im`, which is the bot's counterpart in that conversation.
 *
 * Strictly 1:1 IM only. A group DM or channel resolves to null rather than to
 * "some member", because a caller asking "whose DM is this" must never be
 * handed an arbitrary participant of a shared space — and null is the answer
 * that makes them skip rather than guess. Also null on any API failure.
 */
export async function resolveDmCounterpart(
  app: App,
  botToken: string,
  channelId: string,
): Promise<string | null> {
  try {
    const res = await app.client.conversations.info({ token: botToken, channel: channelId });
    const ch = res.channel as { is_im?: boolean; user?: string } | undefined;
    if (!res.ok || !ch) return null;
    return ch.is_im && ch.user ? ch.user : null;
  } catch (err) {
    logger.warn('resolveDmCounterpart failed', { channelId, detail: String(err).slice(0, 200) });
    return null;
  }
}

/** Send a 1:1 DM to a Slack user. Opens the DM channel if needed. */
export async function sendDM(
  app: App,
  botToken: string,
  userId: string,
  text: string,
  opts: {
    threadTs?: string;
    attachments?: Array<{ sourceUrl: string; filename?: string }>;
    // v3.2.6 — pass false to suppress Slack link/media previews (the news brief
    // carries many source links; unfurling them spams the message).
    unfurl?: boolean;
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
      ...(safeThreadTs(opts.threadTs) ? { thread_ts: safeThreadTs(opts.threadTs) } : {}),
      ...(opts.unfurl === false ? { unfurl_links: false, unfurl_media: false } : {}),
    });

    // v2.2.7 — attachments. Download each Slack file URL with bot-token auth,
    // then re-upload to the same channel under the same thread (or under the
    // text message's own ts when no explicit thread). Failures don't fail the
    // send — text already landed; we log and move on. Slack file URLs require
    // Authorization: Bearer <bot_token> to download.
    if (opts.attachments && opts.attachments.length > 0 && res.ts) {
      const threadForAttachments = safeThreadTs(opts.threadTs) ?? res.ts;
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
      ...(safeThreadTs(opts.threadTs) ? { thread_ts: safeThreadTs(opts.threadTs) } : {}),
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
  opts: { threadTs?: string; unfurl?: boolean } = {},
): Promise<SendOutcome> {
  const tryPost = async () => app.client.chat.postMessage({
    token: botToken,
    channel: channelId,
    text,
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    ...(opts.unfurl === false ? { unfurl_links: false, unfurl_media: false } : {}),
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

/**
 * Edit an existing message in place. Used by the routine dispatcher's
 * placeholder-then-update pattern (v2.8.5): post a "Working…" placeholder
 * to create the thread (so assistant.threads.setStatus can fire on a real
 * threadTs during tool calls), then swap in the final content here.
 *
 * Fire-and-forget tolerance: returns ok=false on failure, never throws.
 * The caller should log at info/warn but never block on this — worst case
 * the placeholder stays as "Working…" forever, which is annoying but not
 * load-bearing.
 */
export async function updateMessage(
  app: App,
  botToken: string,
  channelId: string,
  ts: string,
  text: string,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    await app.client.chat.update({
      token: botToken,
      channel: channelId,
      ts,
      text,
    });
    return { ok: true };
  } catch (err: any) {
    const code: string = err?.data?.error ?? err?.message ?? '';
    logger.warn('updateMessage failed', { channelId, ts, detail: code });
    return { ok: false, detail: code };
  }
}

/**
 * Delete a message. Used by the routine dispatcher when the orchestrator
 * returns a silent result — we don't want a stale "Working…" placeholder
 * hanging in the DM. Fire-and-forget like updateMessage.
 */
export async function deleteMessage(
  app: App,
  botToken: string,
  channelId: string,
  ts: string,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    await app.client.chat.delete({
      token: botToken,
      channel: channelId,
      ts,
    });
    return { ok: true };
  } catch (err: any) {
    const code: string = err?.data?.error ?? err?.message ?? '';
    logger.warn('deleteMessage failed', { channelId, ts, detail: code });
    return { ok: false, detail: code };
  }
}

// ── Lookups ──────────────────────────────────────────────────────────────────

/**
 * Find Slack workspace users by display/real name. Returns up to 200 matches.
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
      }));
  } catch (err) {
    logger.error('findUserByName failed', { err: String(err), name });
    return [];
  }
}

/**
 * Resolve a channel NAME to an id, for `message_colleague(channel_id)`.
 *
 * The payload is two fields on purpose. `id` is what the caller cannot work
 * without; `name` is needed to tell several substring matches apart and to confirm
 * back to the owner which channel was picked. Nothing else crosses, and the tool
 * wrapper in index.ts returns exactly these two (shared rule 10 — return the least
 * the caller needs).
 *
 * `is_private` and `is_archived` used to be computed here and were dropped, unread,
 * by every caller. They are DELETED rather than plumbed further: an unread field on
 * a payload that ends up in the model's context is exactly what rule 10 warns about
 * — the next reader widens the return "so the model can decide", and a private
 * channel's name in the context cannot be taken back. `exclude_archived` below
 * already makes the archived bit a constant.
 *
 * ⚠️ OPEN — owner's call, not settled here. `types` still lists `private_channel`,
 * so a private channel the BOT belongs to can be matched by a fuzzy name search and
 * its name handed to the model; on a colleague-readable surface (T6 — the owner is
 * not the owner in an MPIM) that name can then be read out to the room. Narrowing to
 * `public_channel` closes it and also removes posting to private channels entirely.
 * Never invoked in any log to date, so this is hardening, not an incident.
 */
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
      }));
  } catch (err) {
    logger.error('findChannelByName failed', { err: String(err), name });
    return [];
  }
}

/**
 * Set the "Working…" status indicator in an assistant-panel thread (v2.7.3).
 *
 * Slack's assistant-panel surface supports an ephemeral status indicator that
 * shows above the input field while the agent is processing. The indicator
 * clears automatically when the agent posts its reply.
 *
 * Requires `assistant:write` scope. Only works in threads that opened via
 * the assistant panel — for regular DM messages the API returns
 * `channel_not_found` or `not_in_assistant_thread`. Errors are swallowed at
 * debug, so a call on a non-panel thread is a harmless no-op.
 *
 * Pass empty status to clear (Slack also clears on next chat.postMessage).
 * Fire-and-forget; never blocks tool execution. Errors are logged at debug
 * (we expect transient mismatches when the tracker is stale post-restart).
 */
export async function setAssistantStatus(
  app: App,
  botToken: string,
  params: { channelId: string; threadTs: string; status: string },
): Promise<void> {
  // v2.8.7 — swap the two text slots. Owner direction:
  //   TOP (loading_messages): the per-tool status ("On it",
  //                            "Opening calendar", "Booking it", …)
  //   BOTTOM (status):         a static "writing…" — same shape as
  //                            Slack's normal user-typing indicator
  // Fallback when params.status is empty (rare — observation-only tools
  // that intentionally clear): 'Working' to keep min-length safe.
  const topText = params.status && params.status.trim().length > 0
    ? params.status
    : 'Working';
  try {
    await app.client.apiCall('assistant.threads.setStatus', {
      token: botToken,
      channel_id: params.channelId,
      thread_ts: params.threadTs,
      status: 'is working...',
      loading_messages: [topText],
    });
  } catch (err) {
    // Don't escalate — status is UX polish. If it fails (wrong thread type,
    // scope missing, etc.) the agent reply still lands fine.
    logger.debug('setAssistantStatus failed (non-fatal)', {
      channelId: params.channelId, threadTs: params.threadTs,
      status: params.status, err: String(err).slice(0, 200),
    });
  }
}
