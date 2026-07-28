/**
 * Email inbound front door (v4.3.0, #24 E3/E4).
 *
 * This is a HANDLER, not a poller. The mailbox poll timer (`connectors/graph/
 * mailPoll.ts`, #24 E2) owns the ~30s /messages/delta cadence, the isRead
 * second-dedup, and the "drop Maelle's own outgoing mail" loop guard — it
 * hands each surviving message to whatever this module registers via
 * `registerMailInbound` (mirrors `connectors/slack/inboundReplayRegistry.ts`).
 * Registering here does the OTHER half: the owner/alias sender-authorization
 * gate, participant extraction, history, the orchestrator call, and the
 * reply send.
 *
 * ORDER MATTERS in `handleInboundMail`: the sender gate runs FIRST — before
 * any body read, participant parse, or history write. Read the Slack inbound
 * path (connectors/slack/app/processMessage.ts) for structure; do NOT treat
 * connectors/whatsapp.ts as a proven pattern — per the owner it has never
 * been built or tested.
 *
 * Contract with mailPoll.ts (CORRECTED #24 row 120 — the paragraph this
 * replaced was WRONG, and a lane built ordering logic on it): mailPoll.ts
 * marks a message read ONLY after this handler returns without throwing, and
 * leaves it unread on a throw — but that is NOT a retry. Graph's
 * /messages/delta is consume-once: mailPoll's watermark has already advanced
 * past this message before the handler even runs (connectors/graph/
 * mailPoll.ts:112-118), so an unread message is only a "look at this" marker
 * in a mailbox the owner does not check — there is no next tick that comes
 * back to it. Because there is no retry, a throw here used to be silent to
 * the owner: he forwards something, something breaks, he gets nothing back,
 * ever. `handleInboundMail` now wraps the whole authorized-mail span in a
 * try/catch that DMs the owner on Slack instead — see
 * `notifyOwnerOfMailFailure` below.
 *
 * One throw-timing rule still holds, for a different reason than "retry":
 * this handler must never throw AFTER the reply has actually been sent,
 * because a throw at that point would reach that same catch and tell the
 * owner his forward went unanswered when it wasn't. That's why conversation
 * history is written only AFTER `sendDirect` confirms delivery, and why that
 * write has its OWN try/catch that logs instead of rethrowing: a lost
 * history line must degrade silently, never manufacture a false "you
 * weren't answered" alert for an email that was.
 */

import type { UserProfile } from '../../config/userProfile';
import type { MailMessage } from '../graph/mail';
import { registerMailInbound } from '../graph/mailInboundRegistry';
import { createEmailConnection } from '../../connections/email';
import { ownerEmailAddresses } from '../../connections/email/ownerAddresses';
import { getConnection, registerConnection } from '../../connections/registry';
import type { Connection } from '../../connections/types';
import { runOrchestrator } from '../../core/orchestrator';
import { getConversationHistory, appendToConversation, resolvePerson, setPersonTimezoneByEmail, type CoreFieldSetBy } from '../../db';
import { isNonHumanAttendee } from '../../memory/recordBooking';
import { extractForwardedParticipants } from './extractParticipants';
import { htmlToPlainText } from './htmlToText';
import { inferTimezoneFromStateStatic } from '../../utils/locationTz';
import { runOutputGates } from '../../utils/guards/runOutputGates';
import logger from '../../utils/logger';

/**
 * Register the email Connection (E3) + the inbound handler (E4) for this
 * profile. Complete no-op — no Connection registered, no handler registered
 * — when channels.email is absent or enabled:false.
 */
export function startEmailChannel(profile: UserProfile): void {
  const emailCfg = profile.channels.email;
  if (!emailCfg?.enabled) return;
  if (!emailCfg.mailbox) {
    logger.error('Email channel enabled but channels.email.mailbox is unset — not starting', {
      profileId: profile.user.slack_user_id,
    });
    return;
  }

  const connection = createEmailConnection(profile);
  registerConnection(profile.user.slack_user_id, connection);
  registerMailInbound(profile.user.slack_user_id, (p, message) => handleInboundMail(p, connection, message));
  logger.info('Email channel registered', {
    profileId: profile.user.slack_user_id,
    mailbox: emailCfg.mailbox,
  });
}

async function handleInboundMail(profile: UserProfile, connection: Connection, message: MailMessage): Promise<void> {
  const from = message.from.trim().toLowerCase();

  // ── Sender gate — FIRST. Nothing below this line runs for a message that
  // fails it: no body read, no participant parse, no history write.
  // (mailPoll.ts has already dropped already-read messages and anything from
  // Maelle's own mailbox before calling this handler at all.) ──────────────
  if (!ownerEmailAddresses(profile).includes(from)) {
    // Dropped SILENTLY — no bounce, no auto-reply, no "I can't help you".
    // Returning normally (not throwing) lets mailPoll.ts mark it read, so a
    // persistent spoofed sender isn't reprocessed forever. The spoof
    // containment here is disclosure-only (E3's one-address send cap): a
    // forged sender can never receive an answer anywhere but the owner's own
    // mailbox. It does NOT contain writes on its own — that's why
    // CHANNEL_TOOL_CLAMP (skills/registry.ts) narrows the email turn to a
    // 4-tool allowlist (find_available_slots, create_meeting,
    // get_person_memory, log_interaction) regardless of who triggered it.
    //
    // No owner Slack notification here, deliberately (#24 row 120) — this is
    // not a failure, it's the gate doing its job, and that must stay silent
    // to everyone. Only a message that PASSES this gate and then can't be
    // answered earns one, in the catch below — getting that backwards would
    // turn this gate into a notification firehose for anyone who emails her.
    logger.info('Email inbound — sender is not the owner (or a configured alias), dropped silently', {
      profileId: profile.user.slack_user_id,
      rejectedFrom: from,
    });
    return;
  }

  // From here the sender IS the owner (or a configured alias) — being acted
  // on, not dropped. #24 row 120: everything from here down (participant
  // extraction, the orchestrator call, the gate stack, the send) used to be
  // able to throw and vanish with no owner-visible trace at all — see the
  // file header. One try/catch around the whole span turns that into a
  // Slack DM instead.

  // Observability only (2026-07-29 recipient-hardening overturn) — a
  // Reply-To that diverges from From is the tell for the spoofed-Reply-To
  // attack that motivated PATCHing `toRecipients` explicitly in
  // replyToMail: the gate above already passed on `from`, but a forged
  // message can set Reply-To independently of it. Logged, never acted on
  // here — the actual send is safe regardless, because connections/email/
  // index.ts now sets the recipient explicitly rather than trusting Graph's
  // own reply-target inference.
  const replyToLower = message.replyTo.map(a => a.trim().toLowerCase());
  if (replyToLower.length > 0 && !replyToLower.includes(from)) {
    logger.warn('Email inbound — message Reply-To diverges from From on an owner-authorized message', {
      profileId: profile.user.slack_user_id, from, replyTo: replyToLower,
    });
  }

  try {
    await handleAuthorizedMail(profile, connection, message, from);
  } catch (err) {
    logger.error('Email inbound — handler failed after the sender gate passed; the forward went unanswered', {
      profileId: profile.user.slack_user_id, from: message.from, subject: message.subject,
      err: String(err).slice(0, 300),
    });
    await notifyOwnerOfMailFailure(profile, message);
    // Rethrow — mailPoll.ts's existing unread-marking behavior (its own
    // mailbox-side "look at this" signal) is unchanged; this wrapper only
    // ADDS the owner-visible Slack DM on top of it.
    throw err;
  }
}

/**
 * The actual work of answering an authorized forward. Split out from
 * `handleInboundMail` (#24 row 120) so this whole span sits behind ONE
 * try/catch in the caller — any throw here, from the participant-extraction
 * pass through the send, is caught there and turned into a Slack DM to the
 * owner via `notifyOwnerOfMailFailure`.
 */
async function handleAuthorizedMail(profile: UserProfile, connection: Connection, message: MailMessage, from: string): Promise<void> {
  // Stable per-chain key. A forward is addressed to Maelle, so toRecipients
  // carries only her; conversationId is the one durable coordinate for "this
  // email chain" that survives across forwards and replies.
  const channelKey = `email:${message.conversationId || message.id}`;

  const plainBody = message.bodyContentType === 'html'
    ? htmlToPlainText(message.body)
    : message.body;

  // Extract wide, bind narrow: the full chain still goes to the model below
  // as context; this is only the deterministic attendee hint layered on top.
  const extracted = await extractForwardedParticipants(plainBody);

  // ── Filter ONCE — addresses that can never be a meeting participant: the
  // owner himself, Maelle's own mailbox, her assistant address, or an
  // obvious non-human sender (recording bot / no-reply / resource mailbox).
  // #24 row 133 root cause: this filter used to run only inline in the
  // person-store loop below, so the RAW (unfiltered) list still reached the
  // model as "extracted participants" prose AND would have reached the
  // deterministic attendee route below unfiltered. Proven in production —
  // reading the persisted turn text for the #24 "Re: Fw: Kevel / Reflectiz"
  // run showed `extractForwardedParticipants` had lifted `maelle@<mailbox>`
  // and the owner's own address out of Outlook's reply-quote header (a block
  // shaped identically to a genuine forward's — see extractParticipants.ts).
  // One filter, computed once, reused below by both the person-store loop
  // and the deterministic attendee hand-off.
  const ownerAddresses = ownerEmailAddresses(profile);
  const mailboxEmail = (profile.channels.email?.mailbox ?? '').trim().toLowerCase();
  const assistantEmail = (profile.assistant.email ?? '').trim().toLowerCase();
  const ownerDomain = profile.user.email.trim().toLowerCase().split('@')[1] ?? '';
  const isMeaningfulParticipant = (email: string): boolean =>
    !ownerAddresses.includes(email) && email !== mailboxEmail && email !== assistantEmail && !isNonHumanAttendee(email);
  const externalParticipants = extracted.participants.filter(isMeaningfulParticipant);

  // ── Person store (#24 E6) — resolve-or-create a row for each address on
  // the message Maelle is ACTING on, never for one seen only in the deeper
  // quoted history further down the chain. `extractForwardedParticipants`
  // already binds to the top forwarded header only, so that boundary is
  // enforced upstream; this loop just earns the row for exactly that
  // (now-filtered) set. Fires here — independent of whether a booking ever
  // happens — because being addressed on the chain she was asked to act on
  // IS the engagement (P3), the same "found → upserted" shape the Slack
  // directory search uses (connections/slack/index.ts:308).
  for (const email of externalParticipants) {
    try {
      resolvePerson({ email, ownerDomain });
    } catch (err) {
      logger.warn('Email inbound — resolvePerson failed for an extracted participant', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // ── Stated timezone (#24 rows 129/136) — owner's precedence ruling,
  // verbatim: "don't ask. if I tell you in email the timezone, you know it.
  // if I didn't tell you and the email told you because the email wrote its
  // ET-> you know it. if you didn't get anything, you assume my time. no
  // asking in email routes." `extracted.timezoneHints` already carries the
  // free-text zone + which of the two tiers it came from; resolve to IANA
  // statically (never a live lookup on this leg) and persist through the
  // identity chokepoint. Only for a hint whose email survived the
  // meaningful-participant filter above (never stamp a "timezone" onto the
  // owner's own row or Maelle's own mailbox). An unresolvable string, or no
  // hint at all, means tier 3 applies — the existing owner-zone fallback in
  // attendeeAvailability.ts — and this loop deliberately does nothing further.
  for (const hint of extracted.timezoneHints) {
    if (!isMeaningfulParticipant(hint.email)) continue;
    const iana = inferTimezoneFromStateStatic(hint.statedTimezone);
    if (!iana) {
      logger.info('Email inbound — stated timezone did not resolve to a known IANA zone, leaving the owner-zone fallback in place', {
        email: hint.email, stated: hint.statedTimezone, source: hint.source,
      });
      continue;
    }
    const setBy: CoreFieldSetBy = hint.source === 'forwarding_note' ? 'owner' : 'auto';
    const { outcome } = setPersonTimezoneByEmail(hint.email, iana, setBy, { ownerDomain });
    logger.info('Email inbound — stated timezone resolved and applied', {
      email: hint.email, stated: hint.statedTimezone, iana, source: hint.source, setBy, outcome,
    });
  }

  const participantsLine = externalParticipants.length > 0
    ? `Extracted participants from the forwarded header: ${externalParticipants.join(', ')}`
    : 'No participant addresses could be extracted from the forwarded header — ask if attendees are unclear.';

  const turnText = [
    `[Forwarded email — From: ${message.from}, Subject: "${message.subject}"]`,
    participantsLine,
    '',
    '--- Full email chain ---',
    plainBody,
  ].join('\n');

  const history = getConversationHistory(channelKey);

  logger.info('Email inbound — running orchestrator', {
    profileId: profile.user.slack_user_id, channelKey, participantCount: externalParticipants.length,
  });

  const result = await runOrchestrator({
    userMessage: turnText,
    conversationHistory: history,
    threadTs: channelKey,
    channelId: channelKey,
    userId: profile.user.slack_user_id,
    senderRole: 'owner',
    channel: 'email',
    profile,
    interactive: true,
    inboundConnectionId: 'email',
    // #24 rows 132/133/137 (owner ruling: "the only gap is second participant
    // -> please resolve and use the same format") — hand the filtered,
    // forward-vs-reply-hardened extracted addresses into the SAME
    // resolvedMeetingAttendees route Slack's classifyTurn.meetingPeople +
    // resolveNamedInternalAttendees populate (buildTurnContext.ts), instead of
    // leaving this as prose the model must interpret for itself. Extraction
    // resolves ADDRESSES an internal-name lookup could never produce (an
    // external is never in people_memory under the owner's own domain) — one
    // authoritative route, two contributors, not a second competing spine.
    extractedAttendeeEmails: externalParticipants,
  });

  // ── Output-time gate stack (#24 E5) — the FIRST transport-neutral entry into
  // guard's runOutputGates. Gated in the EXTERNAL frame even though the only
  // live recipient is the owner's own mailbox (E3's one-address cap): he
  // forwards this reply on verbatim, so the gate follows the eventual READER,
  // not the addressee. See runEmailLegGates in runOutputGates.ts for what
  // runs (claim-check, humanGate('external'), date-verify) and why the
  // Slack-only availability floor and security gate are skipped on this leg.
  const gatedReply = await runOutputGates(result.reply, {
    profile, result,
    history, userMessage: turnText,
    senderId: from, channelId: channelKey, threadTs: channelKey,
    role: 'owner',
    transport: 'email',
  });

  // #24 row 130 ("its reply, keep the chain so i can reply again") — reply via
  // Graph's native reply action (connections/email/index.ts → connectors/
  // graph/mail.ts:replyToMail) instead of a fresh compose. The quoted chain,
  // the "Re:" subject prefix and the threading headers all come from Graph
  // once it knows WHICH message this replies to — nothing to hand-compute
  // here any more. `message.id` is the Graph id of the very message the
  // sender gate above just authorized; EmailConnection.sendDirect re-verifies
  // `message.from` (passed as recipientRef, below) against the one-address
  // cap itself before it will act on this, so the cap is inherited, not
  // bypassed — see the comment above that check for exactly how.
  const sendRes = await connection.sendDirect(message.from, gatedReply, { replyToMessageId: message.id });
  if (!sendRes.ok) {
    // No reply reached the owner, and nothing below has run yet — throw.
    // mailPoll.ts leaves the message unread as its mailbox-side marker (no
    // retry follows this — see the file header); the caller's try/catch
    // turns this into a Slack DM naming the failed forward's subject/sender.
    // Recording the turn is deliberately BELOW this check, not above it: a
    // duplicate user turn plus a phantom, never-delivered assistant reply
    // must never enter history just because a send failed once.
    throw new Error(`Email reply send failed: ${sendRes.reason}${sendRes.detail ? ' — ' + sendRes.detail : ''}`);
  }

  // Record the turn only now that delivery is CONFIRMED. Wrapped in its own
  // try/catch that logs instead of rethrowing: a DB hiccup here must degrade
  // to a lost history line, never reach the caller's catch and manufacture a
  // false "you weren't answered" alert for an email that just was.
  try {
    appendToConversation(channelKey, channelKey, { role: 'user', content: turnText });
    appendToConversation(channelKey, channelKey, { role: 'assistant', content: gatedReply });
  } catch (err) {
    logger.error('Email inbound — appendToConversation failed after a successful send; history for this turn is lost', {
      profileId: profile.user.slack_user_id, channelKey, err: String(err).slice(0, 200),
    });
  }
}

/**
 * #24 row 120 — the owner-visible half of the failure wrapper in
 * `handleInboundMail`. The email path itself just failed, so Slack is the
 * one channel still known to be up; the DM names the subject/sender of the
 * forward that didn't get answered so "I'll send it again" is something the
 * owner can actually act on. Deliberate, owner-approved exception to "no
 * Slack shadow DM on the email path" (see the file header) — never extend
 * this pattern to a path that isn't itself the one that just failed.
 *
 * `getConnection(profileId, 'slack')` from inside the email path is
 * legitimate here: CHANNEL_TOOL_CLAMP (skills/registry.ts) narrows the
 * MODEL's tool list on an email-originated turn to a 4-tool allowlist — it
 * governs what the model can call, not what code sends directly, so it does
 * not (and was never meant to) block this code-initiated send.
 *
 * Prototype-cheap on purpose: no retry queue, no backoff, no held watermark
 * — the owner explicitly asked for exactly this and nothing more ("so send
 * me slack message something didn't work, we can fix after"). Never throws:
 * a lost failure-DM is recoverable, an unhandled rejection out of a notifier
 * is not.
 */
async function notifyOwnerOfMailFailure(profile: UserProfile, message: MailMessage): Promise<void> {
  try {
    const slack = getConnection(profile.user.slack_user_id, 'slack');
    if (!slack) {
      logger.warn('Email inbound — no Slack connection registered, cannot notify owner of a failed forward', {
        profileId: profile.user.slack_user_id,
      });
      return;
    }
    const text = `I couldn't answer your forwarded email — from ${message.from}, subject "${message.subject}". `
      + `It won't be retried automatically; feel free to forward it again.`;
    const res = await slack.sendDirect(profile.user.slack_user_id, text);
    if (!res.ok) {
      logger.error('Email inbound — Slack failure-notification send failed', {
        profileId: profile.user.slack_user_id, reason: res.reason, detail: res.detail,
      });
    }
  } catch (err) {
    logger.error('Email inbound — notifyOwnerOfMailFailure itself threw', {
      profileId: profile.user.slack_user_id, err: String(err).slice(0, 200),
    });
  }
}
