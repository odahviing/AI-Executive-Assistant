/**
 * EmailConnection — concrete Connection impl for email (v4.3.0, #24,
 * reply-path hardened #24 row 130; recipient-validation gap closed
 * 2026-07-29 — see "RECIPIENT IS VALIDATED AND ENFORCED" below).
 *
 * Owner decision this embeds: v1 email is a ONE-ADDRESS transport BY
 * CONSTRUCTION. `sendDirect` is the only live verb, and it hard-caps the
 * recipient inside itself — a case-insensitive match on the owner's own
 * address (`profile.user.email`) or a configured alias
 * (`profile.channels.email.owner_aliases`), checked against EVERY address
 * `opts` can carry: `recipientRef`, `cc`, AND `bcc`. Neither of Graph's mail
 * verbs this file calls (`replyToMail`) forwards `cc`/`bcc` on today — it is
 * validated here regardless, so the cap stays complete by construction if
 * that ever changes, rather than depending on whoever adds it to also
 * remember to widen this check. Anything outside that validated set is
 * refused before it ever reaches Graph. This is the specific control the
 * owner is relying on for his whole risk position on this channel: even a
 * spoofed inbound message (the sender gate in `connectors/email/inbound.ts`
 * is a spoofable From-header compare) can never produce a disclosure
 * anywhere but back to himself — true because `recipientRef` is both
 * validated HERE and the exact value PATCHed into the actual Graph send
 * (see "RECIPIENT IS VALIDATED AND ENFORCED" below); it no longer depends on
 * how Graph itself would otherwise have resolved the reply target. The
 * owner/alias address set itself is computed by `ownerEmailAddresses` in
 * `./ownerAddresses` — the one function this file and that inbound sender
 * gate both import, so the two directions cannot silently drift apart.
 *
 * REPLY, NOT FRESH COMPOSE (#24 row 130 — "she cut the original email, its
 * not good, its reply, keep the chain so i can reply again"). Every real
 * send on this transport is an answer to a message that was JUST authorized
 * by the inbound sender gate (`connectors/email/inbound.ts`), so `sendDirect`
 * requires `opts.replyToMessageId` and calls Graph's native reply action
 * (`connectors/graph/mail.ts:replyToMail`) — quoting, the "Re:" subject
 * prefix and the threading headers all come from Graph. The RECIPIENT does
 * NOT come from Graph's own inference — see the next section for why that
 * used to be assumed and is now enforced instead. There is no fresh-
 * compose fallback: `sendMail` (the old always-fresh-compose call) has been
 * removed rather than kept "just in case" — a caller that reaches this
 * without a reply target gets `missing_reply_target`, never a silent,
 * chain-cutting compose.
 *
 * RECIPIENT IS VALIDATED AND ENFORCED, NOT MERELY INFERRED — corrected
 * 2026-07-29. This section used to be titled "THE CAP IS INHERITED, NOT
 * BYPASSED" and argued a reply's recipient was structurally fixed by Graph,
 * with the `recipientRef` check below as extra assurance on top of that.
 * That was wrong: Graph's createReply follows ordinary mail-client reply
 * semantics and addresses a reply using the original message's `Reply-To`
 * header when present, `From` otherwise — and a spoofed forward can set
 * `Reply-To` independently of `From`. A message with `From: <owner>` /
 * `Reply-To: <attacker>` used to pass both the sender gate and this file's
 * `recipientRef` check (both read `From`-derived values) while Graph would
 * have sent the actual reply to the Reply-To attacker: the validated string
 * and the address actually used were two different things. Fixed at the
 * root: `recipientRef` (validated against `allowed` below, unchanged) is now
 * passed to `replyToMail` as `opts.to`, which PATCHes it onto the draft's
 * `toRecipients` explicitly (`connectors/graph/mail.ts`) instead of trusting
 * Graph's inference. The address Graph actually sends to is now the exact
 * one validated here — by construction of THIS code, not by an assumption
 * about Graph's.
 *
 * Every other verb either can't be done safely (a broadcast/group/channel
 * post would be a multi-recipient email — the exact multi-party disclosure
 * this transport exists to prevent) or doesn't apply to email at all
 * (no user/channel directory) — all return `not_supported` / empty rather
 * than approximating. No `getTools` — v1 has no email-owned tool worth
 * registering (the email turn reuses the meetings skill's existing tools,
 * clamped by `CHANNEL_TOOL_CLAMP` in skills/registry.ts).
 */

import type { Connection, ConnectionChannel, ConnectionUser, SendResult } from '../types';
import type { UserProfile } from '../../config/userProfile';
import { replyToMail } from '../../connectors/graph/mail';
import { formatForEmail } from './formatting';
import { ownerEmailAddresses } from './ownerAddresses';
import logger from '../../utils/logger';

export function createEmailConnection(profile: UserProfile): Connection {
  return {
    id: 'email',

    async sendDirect(recipientRef, text, opts): Promise<SendResult> {
      // The cap covers every address this call could reach — recipientRef,
      // cc, AND bcc — not just the primary recipient. Neither is forwarded to
      // Graph by the reply call below, but validating them here regardless
      // means this check is already complete the day either is wired in,
      // instead of silently staying a `to`-only check nobody remembers to
      // widen.
      const targets = [recipientRef, ...(opts?.cc ?? []), ...(opts?.bcc ?? [])].map(a => a.trim().toLowerCase());
      const allowed = ownerEmailAddresses(profile);
      if (targets.some(t => !allowed.includes(t))) {
        logger.warn('EmailConnection.sendDirect — recipient(s) outside the one-address cap, refused', {
          recipients: targets,
          profileId: profile.user.slack_user_id,
        });
        return { ok: false, reason: 'recipient_not_allowed' };
      }
      if (!opts?.replyToMessageId) {
        // No fresh-compose fallback — see the file header. v1's one real
        // caller (connectors/email/inbound.ts) always has a reply target;
        // reaching here means a caller doesn't understand this transport's
        // contract, and the safe response is to refuse, not to silently cut
        // the chain the way the old sendMail path used to.
        logger.error('EmailConnection.sendDirect — no replyToMessageId, refusing (email v1 has no fresh-compose path)', {
          profileId: profile.user.slack_user_id,
        });
        return { ok: false, reason: 'missing_reply_target' };
      }
      try {
        await replyToMail(profile, {
          messageId: opts.replyToMessageId,
          // recipientRef was already validated against `allowed` above —
          // passing it through as `to` is what makes the actual Graph send
          // land on that exact address instead of whatever Graph's own
          // reply-target inference would produce (see file header).
          to: recipientRef.trim(),
          bodyHtml: formatForEmail(text),
        });
        return { ok: true };
      } catch (err) {
        logger.error('EmailConnection.sendDirect — send failed', {
          err: String(err).slice(0, 200),
          profileId: profile.user.slack_user_id,
        });
        return { ok: false, reason: 'send_failed', detail: String(err).slice(0, 200) };
      }
    },

    // Every one of these would either fan a message out to more than the one
    // trusted address (broadcast / group / channel) or has no email-side
    // equivalent (a user/channel directory) — refuse rather than approximate.
    async sendBroadcast(): Promise<SendResult> {
      return { ok: false, reason: 'not_supported' };
    },
    async sendGroupConversation(): Promise<SendResult> {
      return { ok: false, reason: 'not_supported' };
    },
    async postToChannel(): Promise<SendResult> {
      return { ok: false, reason: 'not_supported' };
    },
    async findUserByName(): Promise<ConnectionUser[]> {
      return [];
    },
    async findChannelByName(): Promise<ConnectionChannel[]> {
      return [];
    },
  };
}
