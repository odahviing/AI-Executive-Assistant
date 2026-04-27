/**
 * SlackConnection — concrete Connection impl for Slack (v1.9.0).
 *
 * Wraps the existing messaging.ts primitives behind the Connection interface.
 * Zero behavior change vs. calling messaging.ts directly — this is the
 * adaptor layer.
 *
 * Skills import { Connection } from '../../connections/types' and receive
 * instances of this from the registry. They never import this file directly.
 */

import type { App } from '@slack/bolt';
import type { Connection, ConnectionChannel, ConnectionUser, SendOptions, SendResult } from '../types';
import {
  sendDM,
  sendMpim,
  postToChannel as slackPostToChannel,
  findUserByName as slackFindUserByName,
  findChannelByName as slackFindChannelByName,
  type SendOutcome,
} from './messaging';
import { formatForSlack } from './formatting';

function toSendResult(outcome: SendOutcome): SendResult {
  if (outcome.ok) return { ok: true, ref: outcome.channel_id, ts: outcome.ts };
  return { ok: false, reason: outcome.reason, detail: outcome.detail };
}

/**
 * Build a SlackConnection bound to a specific Bolt app + token pair.
 * Called once per profile on startup and registered in the Connection registry.
 */
export function createSlackConnection(app: App, botToken: string): Connection {
  return {
    id: 'slack',

    // v2.0.2 — all four outbound methods run text through formatForSlack
    // before hitting the primitives. This scrubs internal leakage (sentinels,
    // tool names) and applies Slack's markdown dialect. formatForSlack is
    // idempotent, so callers that pre-format stay safe. Any remaining direct
    // `app.client.chat.postMessage` call sites will migrate through here.

    async sendDirect(recipientRef, text, opts) {
      const outcome = await sendDM(app, botToken, recipientRef, formatForSlack(text), {
        threadTs: opts?.threadTs,
        attachments: opts?.attachments,
      });
      return toSendResult(outcome);
    },

    async sendBroadcast(recipientRefs, text, opts) {
      if (recipientRefs.length === 0) return { ok: false, reason: 'no_recipients' };
      const formatted = formatForSlack(text);
      let lastErr: SendResult | null = null;
      let anyOk = false;
      for (const ref of recipientRefs) {
        const outcome = await sendDM(app, botToken, ref, formatted, { threadTs: opts?.threadTs });
        const result = toSendResult(outcome);
        if (result.ok) anyOk = true;
        else lastErr = result;
      }
      return anyOk ? { ok: true } : (lastErr ?? { ok: false, reason: 'all_failed' });
    },

    async sendGroupConversation(recipientRefs, text, opts) {
      const outcome = await sendMpim(app, botToken, recipientRefs, formatForSlack(text), { threadTs: opts?.threadTs });
      return toSendResult(outcome);
    },

    async postToChannel(channelRef, text, opts) {
      const outcome = await slackPostToChannel(app, botToken, channelRef, formatForSlack(text), { threadTs: opts?.threadTs });
      return toSendResult(outcome);
    },

    async findUserByName(query): Promise<ConnectionUser[]> {
      const results = await slackFindUserByName(app, botToken, query);
      return results.map(u => ({ id: u.id, name: u.real_name || u.name, email: u.email }));
    },

    async findChannelByName(query): Promise<ConnectionChannel[]> {
      const results = await slackFindChannelByName(app, botToken, query);
      return results.map(c => ({ id: c.id, name: c.name }));
    },

    // v2.2.2 (#46) — pull core info from Slack's user directory. Maps
    // users.info → { timezone, pronouns, imageUrl, email, displayName }.
    // Slack doesn't expose a `state` (city/country) field directly, so we
    // skip that — owner-volunteered or state-from-state-via-locationTz fills.
    async collectCoreInfo(ref) {
      try {
        const info = await app.client.users.info({ token: botToken, user: ref });
        const u = info.user as any;
        if (!u) return null;
        return {
          timezone:    u?.tz || undefined,
          pronouns:    u?.profile?.pronouns || undefined,
          imageUrl:    u?.profile?.image_192 || u?.profile?.image_72 || undefined,
          email:       u?.profile?.email || undefined,
          displayName: u?.real_name || u?.name || undefined,
        };
      } catch {
        return null;
      }
    },
  };
}
