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

    async sendDirect(recipientRef, text, opts) {
      // threadTs is passed through when set — Slack thread replies on DMs are
      // supported (Slack treats DMs as channels internally).
      const outcome = await sendDM(app, botToken, recipientRef, text, { threadTs: opts?.threadTs });
      return toSendResult(outcome);
    },

    async sendBroadcast(recipientRefs, text, opts) {
      // Slack idiom: individual DMs per recipient. (Email's semantics of
      // "one message to many" don't apply here — MPIM would be a persistent
      // group chat, not a broadcast.)
      if (recipientRefs.length === 0) return { ok: false, reason: 'no_recipients' };
      let lastErr: SendResult | null = null;
      let anyOk = false;
      for (const ref of recipientRefs) {
        const outcome = await sendDM(app, botToken, ref, text, { threadTs: opts?.threadTs });
        const result = toSendResult(outcome);
        if (result.ok) anyOk = true;
        else lastErr = result;
      }
      return anyOk ? { ok: true } : (lastErr ?? { ok: false, reason: 'all_failed' });
    },

    async sendGroupConversation(recipientRefs, text, opts) {
      // Slack idiom: MPIM — opens a persistent group chat with all recipients.
      const outcome = await sendMpim(app, botToken, recipientRefs, text, { threadTs: opts?.threadTs });
      return toSendResult(outcome);
    },

    async postToChannel(channelRef, text, opts) {
      const outcome = await slackPostToChannel(app, botToken, channelRef, text, { threadTs: opts?.threadTs });
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
  };
}
