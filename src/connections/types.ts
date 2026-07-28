/**
 * Connection layer types (v1.9.0).
 *
 * Abstracts outbound messaging across transports (Slack, email, WhatsApp).
 * Skills import from here only — never from connections/slack or connectors/.
 * That boundary keeps skills transport-agnostic.
 *
 * Inbound routing stays in each transport's own app.ts / webhook handler —
 * the Connection interface is intentionally outbound-only for v1.
 *
 * v2.6.4 — Connections may also OWN tools (`getTools` / `executeToolCall`)
 * for transport-specific primitives (Slack's find_slack_channel, future
 * email's find_email_thread, etc.). Skills registry merges these alongside
 * skill tools so Sonnet sees one unified tool list.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { UserProfile } from '../config/userProfile';

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
  /**
   * v2.2.7 — Optional file attachments. Transport-specific shape: each
   * attachment carries a transport-native locator (e.g. Slack permalink or
   * url_private) the Connection knows how to fetch + re-upload. Other
   * transports may interpret or ignore. Today: SlackConnection.sendDirect
   * implements; other methods + transports ignore.
   */
  attachments?: Array<{
    /** Transport-native file locator. For Slack: permalink or url_private. */
    sourceUrl: string;
    /** Optional override for the filename used when re-uploading. */
    filename?: string;
  }>;
  /**
   * v3.2.6 — pass false to suppress link/media previews (Slack: unfurl_links /
   * unfurl_media). Used by the news-bearing brief, which carries many source
   * links that would otherwise unfurl into a wall of previews. Other transports
   * may ignore.
   */
  unfurl?: boolean;
  /**
   * v4.3.0 (#24 row 130) — email only. The transport-native id of the message
   * this send REPLIES to. When present, EmailConnection.sendDirect uses
   * Graph's native reply action (quoted chain, "Re:" prefix and threading
   * headers all come from Graph) instead of composing a fresh message — the
   * fix for "she cut the original email, keep the chain so I can reply
   * again." Other transports ignore it. Email's v1 caller (connectors/email/
   * inbound.ts) always has one available (the inbound message being
   * answered); EmailConnection refuses rather than silently falling back to
   * a chain-cutting compose when it's missing.
   */
  replyToMessageId?: string;
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

  /**
   * v2.2.2 (#46) — fetch core attendee info from this transport's directory:
   * timezone, gender hint (pronouns / photo / etc), state if available. Used
   * to keep `people_memory` populated without asking the owner. Optional —
   * transports that don't have a directory (some webhook surfaces) just don't
   * implement it, callers check before invoking.
   *
   * Implementations: SlackConnection wraps users.info + pronouns + image;
   * future EmailConnection might parse a contact card; future WhatsAppConnection
   * the profile name + (when available) public profile photo.
   *
   * Returns null when the ref doesn't resolve. Returned values get persisted
   * via setCoreFieldWithProvenance with set_by='auto' — owner / person can
   * override them later.
   */
  collectCoreInfo?(ref: string): Promise<CoreInfoFromTransport | null>;

  /**
   * v2.6.4 — Tools that ONLY make sense for this transport. Slack today:
   * find_slack_channel. Future email: find_email_thread, list_unread, etc.
   *
   * Optional — connections that don't own any tools (or transports that
   * piggyback entirely on the universal outreach skill) just don't implement.
   *
   * Tools returned here get merged with skill-tools by `getSkillTools` in
   * src/skills/registry.ts. Same colleague-allowlist filter applies.
   */
  getTools?(profile: UserProfile): Anthropic.Tool[];

  /**
   * v2.6.4 — Handle a tool call for a tool this Connection owns. Return null
   * if this Connection doesn't recognize the tool name (registry falls
   * through to next handler). Return a result object on success.
   */
  executeToolCall?(toolName: string, args: Record<string, unknown>): Promise<unknown | null>;

  /**
   * v2.6.5 — react to a previously-sent message. Used for activity-completion
   * markers (✅ when a task completes). Optional — transports without
   * reactions (email, SMS) simply don't implement; callers no-op when absent.
   *
   * Intentionally fire-and-forget shape (returns void). The caller doesn't
   * branch on success/failure for these — the reaction is a nice-to-have UI
   * touch, not part of any contract.
   */
  reactToMessage?(channelRef: string, messageTs: string, emojiName: string): Promise<void>;

  /**
   * v4.1.x (O2) — EDIT and RETRACT a message this Connection already sent.
   * Optional on the same terms as reactToMessage: a transport with no edit /
   * delete primitive (email, SMS) simply doesn't implement, and callers check
   * before invoking.
   *
   * Unlike reactToMessage these return a SendResult, because an edit IS a send
   * — it puts new text in front of a person — and callers do branch on the
   * outcome (the routine dispatcher posts a fresh message when its placeholder
   * update fails). Implementers MUST run `text` through the same outbound
   * formatter the send verbs use. That is a correctness requirement, not
   * tidiness: an edit that skips it delivers raw markdown where the identical
   * text sent through sendDirect / postToChannel would have rendered clean.
   *
   * `messageRef` is the transport-native message id (Slack: the message ts).
   * updateMessage returns that ref back as `ts` — the message still exists at
   * it. deleteMessage returns no `ts`, because it doesn't any more.
   */
  updateMessage?(channelRef: string, messageRef: string, text: string): Promise<SendResult>;
  deleteMessage?(channelRef: string, messageRef: string): Promise<SendResult>;

  /**
   * v3.3.7 (#125c) — resolve the 1:1 direct-message channel ref for a user on
   * this transport (Slack: conversations.open → D-channel id). Used by
   * recall_interactions to read the verbatim recent exchange with a person
   * out of the conversations store. Optional — transports without a stable
   * DM-channel concept just don't implement; callers check before invoking.
   * Returns null when the user doesn't resolve.
   */
  resolveDirectChannelId?(userRef: string): Promise<string | null>;

  /**
   * v4.1.x (#51) — the REVERSE of resolveDirectChannelId: given a 1:1 direct
   * channel ref, who is the person on the other side? Used by the memory
   * capture pass, which walks stored DM threads by channel and needs the person
   * each one belongs to. Optional; returns null when the ref doesn't resolve.
   *
   * Contract every transport must hold: 1:1 ONLY. A group or multi-party ref
   * resolves to null, never to "one of the participants" — a caller asking
   * "whose DM is this" cannot be handed an arbitrary member of a shared space,
   * and null makes it skip instead of guess. Returns the bare person ref and
   * nothing else; resolving a channel is not a licence to hand back what is in
   * it.
   */
  resolveChannelCounterpart?(channelRef: string): Promise<string | null>;
}

/**
 * v2.2.2 (#46) — transport-pulled core info shape. All fields optional;
 * transports fill what they have. Caller persists via setCoreFieldWithProvenance.
 */
export interface CoreInfoFromTransport {
  timezone?: string;       // IANA
  state?: string;          // free-text city / country if the transport carries it
  gender?: 'male' | 'female';
  // Hint URL the caller can pass to genderDetect.detectGenderFromImage for
  // a photo-based fallback when `gender` itself isn't directly available.
  imageUrl?: string;
  pronouns?: string;
  email?: string;
  displayName?: string;
}
