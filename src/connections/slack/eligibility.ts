import type { App } from '@slack/bolt';
import logger from '../../utils/logger';

type Client = App['client'];
type SlackConversation = Record<string, any>;

// Only the token's immutable workspace identity is cached. Membership and
// sharing are read afresh: a formerly internal room may become Slack Connect.
const workspaces = new WeakMap<Client, Map<string, Promise<string | null>>>();
async function workspaceId(client: Client, token: string): Promise<string | null> {
  let tokens = workspaces.get(client);
  if (!tokens) { tokens = new Map(); workspaces.set(client, tokens); }
  let pending = tokens.get(token);
  if (!pending) {
    pending = client.auth.test({ token }).then(r => r.ok && r.team_id ? r.team_id : null)
      .catch(() => null);
    tokens.set(token, pending);
  }
  const id = await pending;
  if (!id) tokens.delete(token); // an unavailable read must be retryable
  return id;
}

/** S1: a Slack identity must belong to this token's authenticated workspace. */
export async function isInternalSlackUser(client: Client, token: string, userId: string): Promise<boolean> {
  try {
    const team = await workspaceId(client, token);
    if (!team) return false;
    const result = await client.users.info({ token, user: userId });
    const user = result.user;
    return result.ok === true && !!user && user.team_id === team && user.is_stranger !== true;
  } catch { return false; }
}

/**
 * S1/W9 eligibility before reading, processing or posting conversation content.
 * A DM can omit sharing flags; its authenticated counterpart proves membership.
 * Rooms must positively report that they are not externally shared. Unknown
 * metadata never widens access. is_stranger=false alone is NOT membership proof.
 */
export async function readInternalSlackConversation(
  client: Client, token: string, channelId: string, senderId?: string,
): Promise<SlackConversation | null> {
  try {
    const result = await client.conversations.info({ token, channel: channelId });
    const channel = result.channel as SlackConversation | undefined;
    if (!result.ok || !channel || channel.is_ext_shared === true || channel.is_pending_ext_shared === true
      || (Array.isArray(channel.connected_team_ids) && channel.connected_team_ids.length > 0)) return null;
    if (channel.is_im === true) {
      if (typeof channel.user !== 'string' || !await isInternalSlackUser(client, token, channel.user)) return null;
      if (senderId && senderId !== channel.user) return null;
    } else if ((channel.is_mpim === true || channel.is_channel === true || channel.is_group === true)
      && channel.is_ext_shared === false) {
      if (senderId && !await isInternalSlackUser(client, token, senderId)) return null;
    } else return null;
    return channel;
  } catch (err) {
    logger.warn('Slack eligibility unavailable — withholding conversation', { channelId, err: String(err).slice(0, 160) });
    return null;
  }
}
