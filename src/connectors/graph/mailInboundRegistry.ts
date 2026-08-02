/**
 * Mail inbound-handler registry (#24).
 *
 * Mirrors connectors/slack/inboundReplayRegistry.ts: the poll timer
 * (mailPoll.ts) must NOT know how to extract participants, check the sender
 * gate, or scope tools for the email turn — that's the front door (#24,
 * separate work). Instead the front door registers ONE handler per profile
 * once it exists, and the poller just hands it each new message.
 *
 * Until a handler is registered for a profile, mailPoll.ts makes ZERO Graph
 * calls for that profile — see mailPoll.ts's doc comment for why (it would
 * otherwise advance the delta watermark past messages nobody can process).
 */
import type { MailMessage } from './mail';
import type { UserProfile } from '../../config/userProfile';

export type MailInboundFn = (profile: UserProfile, message: MailMessage) => Promise<void>;

const registry: Map<string, MailInboundFn> = new Map();

/** Called by the email front door at startup, once it exists. */
export function registerMailInbound(profileId: string, fn: MailInboundFn): void {
  registry.set(profileId, fn);
}

export function getMailInbound(profileId: string): MailInboundFn | undefined {
  return registry.get(profileId);
}
