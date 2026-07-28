/**
 * Mailbox poll timer (#24 E2).
 *
 * The email channel gets its OWN ~30s inbound cadence — deliberately NOT the
 * 5-minute task tick in core/background.ts. That tick exists for DUE work
 * (reminders, routines, request expiry); the owner explicitly rejected
 * imposing its latency on a live email conversation whose next step is a
 * human reading a reply (see startMailPollTimer's gating below and #24 E2's
 * productDecision for the push-vs-poll tradeoff — no public HTTPS ingress
 * exists for Graph change notifications, and IMAP IDLE isn't worth the
 * machinery for this).
 *
 * GATING — "provably inert without config" (owner decision #24):
 *   1. channels.email.enabled must be true, AND
 *   2. a refresh token must already exist (mail.ts's hasMailRefreshToken) —
 *      otherwise there is nothing to authenticate with.
 * If NO profile satisfies both, the interval is never scheduled at all —
 * zero behaviour change, zero new timers, on any profile without the email
 * channel configured (which today is every profile — the mailbox doesn't
 * exist yet).
 *
 * A THIRD, per-tick gate: a front-door handler (mailInboundRegistry) must be
 * registered for the profile. The front door (participant extraction /
 * sender gate / tool scoping — #24 E3/E4) is separate work. Until it
 * registers, this module fetches NOTHING for that profile — /messages/delta
 * is at-least-once and consuming it advances the durable watermark, so
 * calling it with no one to hand the messages to would silently drop mail
 * before the front door ever exists to read it. A throttled warning fires
 * instead so a configured-but-unwired mailbox is visible, not silent.
 */
import type { UserProfile } from '../../config/userProfile';
import { listNewMessages, markMessageRead, hasMailRefreshToken, MailAuthRevokedError } from './mail';
import { getMailInbound } from './mailInboundRegistry';
import logger from '../../utils/logger';

const MAIL_POLL_INTERVAL_MS = 30 * 1000;

function profileConfigured(profile: UserProfile): boolean {
  return !!profile.channels?.email?.enabled && hasMailRefreshToken(profile);
}

// Revoked tokens need a human to re-run scripts/email-auth.mjs — never
// crash-loop refreshAccessToken every 30s once we've seen invalid_grant for
// a profile. Cleared only by a restart (which re-attempts with whatever
// token is on disk at that point).
const revokedProfiles = new Set<string>();

// One throttle flag per profile so "no handler registered" logs once, not
// every 30s, while still being visible.
const warnedNoHandler = new Set<string>();

async function pollProfile(profile: UserProfile): Promise<void> {
  const profileId = profile.user.slack_user_id;
  const handler = getMailInbound(profileId);
  if (!handler) {
    if (!warnedNoHandler.has(profileId)) {
      warnedNoHandler.add(profileId);
      logger.warn(
        'mailPoll — channels.email configured but no front-door handler registered; skipping poll (no Graph calls) until the front door registers',
        { profileId },
      );
    }
    return;
  }

  let messages;
  try {
    messages = await listNewMessages(profile);
  } catch (err) {
    if (err instanceof MailAuthRevokedError) {
      revokedProfiles.add(profileId);
      logger.error('mailPoll — refresh token revoked; stopping polling for this profile until re-auth', {
        profileId, err: String(err).slice(0, 200),
      });
      return;
    }
    logger.warn('mailPoll — listNewMessages failed, will retry next tick', {
      profileId, err: String(err).slice(0, 200),
    });
    return;
  }

  if (messages.length === 0) return;

  // /messages/delta tracks property CHANGES to existing messages too, not
  // just new arrivals — so marking a message read below causes the very
  // next delta poll to hand back that same message again (now isRead:true).
  // Without this filter that would re-run the handler on every message it
  // just finished, forever. This is the "second dedup" the owner asked for:
  // isRead itself is the durable per-message marker, independent of the
  // deltaLink watermark.
  const ownMailbox = profile.channels?.email?.mailbox?.toLowerCase();
  const toProcess = messages.filter(m => {
    if (m.isRead) return false;
    // Drop mail sent by the mailbox itself (owner decision #24) — a
    // send-as/rule loopback landing a copy of Maelle's own outgoing mail
    // back in the inbox must never be treated as an inbound request.
    if (ownMailbox && m.from.toLowerCase() === ownMailbox) return false;
    return true;
  });
  if (toProcess.length === 0) return;

  for (const message of toProcess) {
    try {
      await handler(profile, message);
    } catch (err) {
      logger.error('mailPoll — inbound handler failed; leaving message unread as a failure signal', {
        profileId, messageId: message.id, err: String(err).slice(0, 200),
      });
      continue;
    }
    // A visible signal in the mailbox of what Maelle handled, and (per the
    // filter above) the guard against reprocessing it. Only mark read after
    // the handler SUCCEEDS — a thrown handler leaves the message unread as a
    // visible failure signal. Note the delta watermark has already advanced
    // past it either way (Graph delta is consume-once), so an unread message
    // — handler failure OR a markMessageRead failure right here — won't be
    // retried automatically; it's a "look at this" flag, not a retry queue.
    try {
      await markMessageRead(profile, message.id);
    } catch (err) {
      logger.error('mailPoll — markMessageRead failed after a successful handler; message stays unread', {
        profileId, messageId: message.id, err: String(err).slice(0, 200),
      });
    }
  }
  logger.info('mailPoll — processed new mail', { profileId, count: toProcess.length });
}

let tickInFlight = false;

function tick(profiles: Map<string, UserProfile>): void {
  if (tickInFlight) {
    logger.warn('mailPoll — previous tick still running, skipping this tick');
    return;
  }
  tickInFlight = true;
  (async () => {
    for (const profile of profiles.values()) {
      if (!profileConfigured(profile)) continue;
      if (revokedProfiles.has(profile.user.slack_user_id)) continue;
      try {
        await pollProfile(profile);
      } catch (err) {
        logger.warn('mailPoll — profile tick error, continuing', {
          profileId: profile.user.slack_user_id, err: String(err).slice(0, 200),
        });
      }
    }
  })()
    .catch(err => logger.error('mailPoll — tick error', { err: String(err) }))
    .finally(() => { tickInFlight = false; });
}

/**
 * Starts the mailbox poll timer. No-op — schedules nothing — unless at least
 * one profile has channels.email.enabled AND a refresh token present.
 */
export function startMailPollTimer(profiles: Map<string, UserProfile>): void {
  const anyConfigured = [...profiles.values()].some(profileConfigured);
  if (!anyConfigured) {
    logger.info('mailPoll — no profile has the email channel configured (enabled + token) — mailbox poll not scheduled');
    return;
  }
  logger.info('mailPoll — starting mailbox poll timer', { intervalMs: MAIL_POLL_INTERVAL_MS });
  setInterval(() => tick(profiles), MAIL_POLL_INTERVAL_MS);
}
