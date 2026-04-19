/**
 * Connection router (v1.9.0).
 *
 * Decides which Connection to use for an outgoing message, given:
 *   - the profile (for policy settings)
 *   - the recipient (reachable transports, preferences)
 *   - the skill initiating the message (for per-skill routing overrides)
 *   - optional context (inbound transport wins for replies)
 *
 * Policy layers, applied in order:
 *   1. SkillContext.inboundConnectionId — if the recipient is reachable on
 *      the transport the inbound came through, reply there. (Yael DMs on
 *      Slack → Maelle replies on Slack.)
 *   2. PersonRef.preferred_external — owner-pinned preference for this
 *      specific external contact ("Eyal prefers WhatsApp").
 *   3. Per-skill routing in profile.connections.per_skill_routing.
 *   4. Profile-wide default_routing.
 *   5. Hardcoded fallback: internal=slack, external=email.
 *
 * Graceful degradation: if the preferred transport isn't registered OR the
 * recipient isn't reachable there, the router walks down to alternatives
 * (email → whatsapp → null). Never tries a channel we have no address for.
 *
 * Never throws. Returns null when no valid connection can deliver to this
 * recipient; caller logs + surfaces to owner.
 */

import type { Connection, ConnectionId, PersonRef, RoutingPolicy } from './types';
import { getConnection } from './registry';
import logger from '../utils/logger';

export interface RouterInput {
  profileId: string;
  profilePolicy: RoutingPolicy;
  skill?: string;
  recipient: PersonRef;
  context?: { inboundConnectionId?: ConnectionId };
}

export interface RouterOutput {
  connection: Connection;
  /** Transport-native recipient ref (slack_id / email / whatsapp number). */
  recipientRef: string;
  /** Why this connection was chosen (for logging + debugging). */
  reason: string;
}

/**
 * Resolve the outgoing Connection + recipient ref. Returns null if there's
 * no valid way to reach this recipient.
 */
export function resolveOutgoing(input: RouterInput): RouterOutput | null {
  const { profileId, profilePolicy, skill, recipient, context } = input;

  // Layer 1 — context wins (inbound transport for replies)
  if (context?.inboundConnectionId) {
    const ref = refForTransport(recipient, context.inboundConnectionId);
    if (ref) {
      const conn = getConnection(profileId, context.inboundConnectionId);
      if (conn) return { connection: conn, recipientRef: ref, reason: `context:${context.inboundConnectionId}` };
    }
  }

  // Layer 2 — internal rule: internal recipients always go to slack (unless
  // explicitly overridden below). Keeps internal team chatter on the team
  // channel even when email/whatsapp are available.
  if (recipient.internal && recipient.slack_id) {
    // But if per-skill routing says internal goes elsewhere for this skill, respect it
    const perSkillInternal = skill ? profilePolicy.per_skill_routing?.[skill]?.internal : undefined;
    const profileInternal = profilePolicy.default_routing.internal;
    const chosen = perSkillInternal ?? profileInternal ?? 'slack';
    const ref = refForTransport(recipient, chosen);
    if (ref) {
      const conn = getConnection(profileId, chosen);
      if (conn) return { connection: conn, recipientRef: ref, reason: `internal:${chosen}${perSkillInternal ? ' (per-skill)' : ''}` };
    }
    // Chosen internal transport isn't available — fall back to slack if we have it
    if (recipient.slack_id) {
      const slackConn = getConnection(profileId, 'slack');
      if (slackConn) return { connection: slackConn, recipientRef: recipient.slack_id, reason: 'internal:slack (fallback)' };
    }
  }

  // Layer 3 — external routing: per-recipient preference → per-skill → profile default
  const perSkillExternal = skill ? profilePolicy.per_skill_routing?.[skill]?.external : undefined;
  const profileExternal = profilePolicy.default_routing.external;
  const chosenExternal: ConnectionId =
    recipient.preferred_external ??
    perSkillExternal ??
    profileExternal ??
    'email';

  // Try the chosen external transport
  const chosenRef = refForTransport(recipient, chosenExternal);
  if (chosenRef) {
    const conn = getConnection(profileId, chosenExternal);
    if (conn) {
      const reasonSource = recipient.preferred_external
        ? 'recipient-pinned'
        : perSkillExternal
          ? 'per-skill'
          : 'profile-default';
      return { connection: conn, recipientRef: chosenRef, reason: `external:${chosenExternal} (${reasonSource})` };
    }
  }

  // Layer 4 — graceful fallback: try any other reachable transport
  const tryOrder: ConnectionId[] = ['email', 'whatsapp', 'slack'];
  for (const fallback of tryOrder) {
    if (fallback === chosenExternal) continue;
    const ref = refForTransport(recipient, fallback);
    if (!ref) continue;
    const conn = getConnection(profileId, fallback);
    if (conn) {
      logger.info('Router fell back from preferred transport', {
        profileId,
        skill,
        wanted: chosenExternal,
        got: fallback,
        reason: 'preferred transport not available for this recipient',
      });
      return { connection: conn, recipientRef: ref, reason: `external:${fallback} (fallback)` };
    }
  }

  // Can't reach this recipient on any registered transport
  logger.warn('Router could not resolve — recipient unreachable', {
    profileId,
    skill,
    recipientName: recipient.name,
    hasSlackId: !!recipient.slack_id,
    hasEmail: !!recipient.email,
    hasWhatsapp: !!recipient.whatsapp,
    internal: recipient.internal,
    registeredTransports: profilePolicy.enabled,
  });
  return null;
}

/**
 * Return the recipient's transport-native reference for a given transport,
 * or null if they have no address on that transport.
 */
function refForTransport(recipient: PersonRef, transport: ConnectionId): string | null {
  switch (transport) {
    case 'slack':    return recipient.slack_id ?? null;
    case 'email':    return recipient.email    ?? null;
    case 'whatsapp': return recipient.whatsapp ?? null;
    default:         return null;
  }
}

/**
 * Helper: is this recipient reachable on a specific transport? Used by the
 * context-wins rule (layer 1).
 */
export function recipientReachableOn(recipient: PersonRef, transport: ConnectionId): boolean {
  return refForTransport(recipient, transport) !== null;
}

/**
 * Helper: default policy for profiles that don't specify a connections block.
 * Matches pre-v1.9.0 behavior (slack-only).
 */
export function defaultRoutingPolicy(): RoutingPolicy {
  return {
    enabled: ['slack'],
    default_routing: {
      internal: 'slack',
      external: 'email',
    },
  };
}
