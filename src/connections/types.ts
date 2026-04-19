/**
 * Connection layer types (v1.9.0).
 *
 * Abstracts outbound messaging across transports (Slack, email, WhatsApp).
 * Skills import from here only — never from connections/slack or connectors/.
 * That boundary keeps skills transport-agnostic.
 *
 * Inbound routing stays in each transport's own app.ts / webhook handler —
 * the Connection interface is intentionally outbound-only for v1.
 */

/**
 * Transport identifier. String type (not enum) so new transports can register
 * without schema migration.
 */
export type ConnectionId = 'slack' | 'email' | 'whatsapp' | string;

/**
 * Outcome of a send. Every Connection returns this shape so callers handle
 * success/failure uniformly.
 */
export type SendResult =
  | { ok: true; ref?: string; ts?: string }
  | { ok: false; reason: string; detail?: string };

/**
 * Optional send metadata. Each transport uses what applies:
 *   Slack:   thread_ts → reply in thread
 *   Email:   cc, bcc, subject → email semantics; thread_ts ignored
 *   WhatsApp: thread_ts ignored; cc/bcc ignored
 *
 * Transports MUST ignore fields they don't support — never error on unknown.
 */
export interface SendOptions {
  /** Reply in an existing thread (Slack + WhatsApp-if-applicable). */
  threadTs?: string;
  /** CC list, email only. */
  cc?: string[];
  /** BCC list, email only. */
  bcc?: string[];
  /** Subject, email only. */
  subject?: string;
}

/**
 * A lightweight user lookup result — id is transport-native (slack_id /
 * email / phone). Skills that don't care about transport just use {id, name}.
 */
export interface ConnectionUser {
  id: string;
  name: string;
  email?: string;
}

/**
 * A lightweight channel lookup result. Only meaningful for transports that
 * have channels (Slack). Email/WhatsApp transports may return [].
 */
export interface ConnectionChannel {
  id: string;
  name: string;
}

/**
 * Core Connection interface. Every transport implements this.
 *
 * Intentionally narrow — common-denominator verbs that map cleanly to Slack,
 * email, and WhatsApp. Transport-specific features (e.g. email's TO/CC split)
 * are exposed on sub-interfaces that skills cast to when needed.
 */
export interface Connection {
  readonly id: ConnectionId;

  /**
   * Send a direct message to one recipient.
   *   Slack:   DM
   *   Email:   email TO: one recipient
   *   WhatsApp: DM
   */
  sendDirect(recipientRef: string, text: string, opts?: SendOptions): Promise<SendResult>;

  /**
   * Send to multiple recipients as a broadcast (each gets their own copy or
   * one combined message, per transport idiom).
   *   Slack:   N individual DMs (one per recipient)
   *   Email:   ONE email with all recipients as TO (or TO + CC if opts.cc)
   *   WhatsApp: N individual DMs
   *
   * Returns one SendResult per recipient for individual transports (Slack/
   * WhatsApp) or a single {ok:true} for bulk transports (email).
   */
  sendBroadcast(recipientRefs: string[], text: string, opts?: SendOptions): Promise<SendResult>;

  /**
   * Start / post to a group conversation.
   *   Slack:   MPIM (all recipients in one persistent group chat)
   *   Email:   single email TO all (if not already available via sendBroadcast)
   *   WhatsApp: group (may require prior setup)
   *
   * Not every transport supports this meaningfully; implementers should fall
   * back to sendBroadcast if group chats aren't applicable.
   */
  sendGroupConversation(recipientRefs: string[], text: string, opts?: SendOptions): Promise<SendResult>;

  /**
   * Post to a public channel / shared space.
   *   Slack:   channel post
   *   Email:   N/A — returns {ok:false, reason:'not_supported'}
   *   WhatsApp: N/A — returns {ok:false, reason:'not_supported'}
   */
  postToChannel(channelRef: string, text: string, opts?: SendOptions): Promise<SendResult>;

  /** Look up a user by display name. Empty array if transport doesn't support. */
  findUserByName(query: string): Promise<ConnectionUser[]>;

  /** Look up a channel by name. Empty array if transport has no channels. */
  findChannelByName(query: string): Promise<ConnectionChannel[]>;
}

/**
 * Per-person routing information. Stored on people_memory rows — one person
 * may be reachable on multiple transports.
 *
 * `internal` is derived from matching email domain against the owner's
 * company domain. Computed fresh each time via peopleMemory helper, not
 * stored (so domain changes propagate automatically).
 *
 * `preferred_external` is an owner-set override: "for this external contact,
 * prefer WhatsApp over email." Stored on people_memory.
 */
export interface PersonRef {
  slack_id?: string;
  email?: string;
  whatsapp?: string;
  internal: boolean;
  preferred_external?: 'email' | 'whatsapp';
  name?: string;
}

/**
 * Per-profile routing policy. Read from profile YAML `connections:` block.
 *
 * Layers of resolution (router.ts applies in order):
 *   1. SkillContext.inboundConnectionId (context wins if recipient reachable there)
 *   2. PersonRef.preferred_external (owner pinned preference)
 *   3. per_skill_routing[skill] (skill-level override in profile)
 *   4. default_routing (profile default)
 *   5. Hardcoded fallback: internal=slack, external=email
 */
export interface RoutingPolicy {
  enabled: ConnectionId[];
  default_routing: {
    internal: ConnectionId;
    external: ConnectionId;
  };
  per_skill_routing?: Record<string, {
    internal?: ConnectionId;
    external?: ConnectionId;
  }>;
}
