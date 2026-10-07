import {
  beginSlackDelivery, getSlackDelivery, resolveSlackDelivery,
  listDueSlackDeliveries, postponeSlackDelivery,
} from '../../db/slackDelivery';
import { readInternalSlackConversation } from '../../connections/slack/eligibility';
import { readSlackThread } from './threadHistory';
import logger from '../../utils/logger';

export interface DeliveryInput {
  profileId: string; channelId: string; threadTs: string; inboundTs: string[];
}
const REVIEW_INTERVAL_MS = 10 * 60 * 1000;

/** A failed attempt is known not accepted. Everything else excludes replay. */
export function hasHeldDelivery(input: DeliveryInput): boolean {
  return input.inboundTs.some(ts => {
    const previous = getSlackDelivery(input.profileId, input.channelId, ts);
    return previous !== null && previous.status !== 'failed';
  });
}

/** Exactly one transport operation per durable claim. Never treat a transport
 * exception as proof of rejection unless Slack explicitly returned ok:false. */
export async function attemptDelivery(
  input: DeliveryInput,
  send: (attemptId: string) => Promise<unknown>,
  kind: 'text' | 'audio' | 'reaction' = 'text',
): Promise<'confirmed' | 'failed' | 'unknown' | 'held'> {
  const attempt = beginSlackDelivery({ ...input, nextCheckAt: Date.now() + REVIEW_INTERVAL_MS });
  if (!attempt) return 'held';
  let response: { ok?: boolean; ts?: string } | undefined;
  let status: 'confirmed' | 'failed' | 'unknown';
  try {
    response = await send(attempt.attemptId) as typeof response;
    status = response?.ok === false ? 'failed'
      : kind === 'audio' || response?.ok === true || !!response?.ts ? 'confirmed' : 'unknown';
  } catch (err) {
    const rejection = err as { code?: string; data?: { ok?: boolean; error?: string } };
    const explicit = rejection?.code === 'slack_webapi_platform_error' && rejection.data?.ok === false;
    // A retry may report that this bot's reaction is already present. That
    // is positive delivery evidence, not permission to append a text answer.
    status = explicit && kind === 'reaction' && rejection.data?.error === 'already_reacted'
      ? 'confirmed' : explicit ? 'failed' : 'unknown';
  }
  // Completion bookkeeping may fail after Slack accepted. The persisted
  // sending row still excludes replay and becomes due for reconciliation.
  try {
    const resolution = { ...input, attemptId: attempt.attemptId,
      status, messageTs: response?.ts, nextCheckAt: Date.now() + REVIEW_INTERVAL_MS };
    // A slow transport can finish after the heartbeat marked its sending
    // row unknown. The same attempt's actual result can still resolve it;
    // terminal operator decisions remain immutable under both CAS branches.
    if (!resolveSlackDelivery({ ...resolution, expectedStatus: 'sending' })) {
      resolveSlackDelivery({ ...resolution, expectedStatus: 'unknown' });
    }
  } catch (err) {
    logger.error('Slack delivery completion persistence failed; attempt held for reconciliation', {
      attemptId: attempt.attemptId, channelId: input.channelId, status, err: String(err),
    });
  }
  if (status !== 'confirmed') logger.warn('Slack delivery requires recovery or operator review', {
    attemptId: attempt.attemptId, channelId: input.channelId, status,
  });
  return status;
}

/** Existing catch-up heartbeat revisits held work independently of its history
 * window. Only the exact bot-authored client_msg_id certifies a text send.
 * No visible match is unknown, never permission to resend. */
export async function reconcileSlackDeliveries(app: any, profileId: string, token: string, botUserId: string): Promise<void> {
  for (const attempt of listDueSlackDeliveries(profileId)) {
    try {
      if (attempt.threadTs && await readInternalSlackConversation(app.client, token, attempt.channelId)) {
        const thread = await readSlackThread(app.client, token, attempt.channelId, attempt.threadTs, Infinity);
        const found = thread.find(message => message.user === botUserId
          && message.client_msg_id === attempt.attemptId && typeof message.ts === 'string');
        if (found && resolveSlackDelivery({ ...attempt, expectedStatus: 'unknown', status: 'confirmed', messageTs: found.ts })) continue;
      }
    } catch (err) {
      logger.warn('Slack delivery reconciliation unavailable', { attemptId: attempt.attemptId, err: String(err) });
    }
    postponeSlackDelivery(profileId, attempt.channelId, attempt.attemptId, Date.now() + REVIEW_INTERVAL_MS);
    logger.warn('Slack delivery remains unknown; operator review required, automatic resend withheld', {
      profileId, channelId: attempt.channelId, threadTs: attempt.threadTs, attemptId: attempt.attemptId,
    });
  }
}
