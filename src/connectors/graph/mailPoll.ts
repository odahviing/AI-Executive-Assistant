/**
 * Mailbox poll timer (#24).
 *
 * The email channel gets its OWN ~30s inbound cadence — deliberately NOT the
 * 5-minute task tick in core/background.ts. That tick exists for DUE work
 * (reminders, routines, request expiry); the owner explicitly rejected
 * imposing its latency on a live email conversation whose next step is a
 * human reading a reply (see startMailPollTimer's gating below; the
 * push-vs-poll tradeoff was settled in #24 — no public HTTPS ingress
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
 * sender gate / tool scoping — #24) is separate work. Until it
 * registers, this module fetches NOTHING for that profile — /messages/delta
 * is at-least-once and consuming it advances the durable watermark, so
 * calling it with no one to hand the messages to would silently drop mail
 * before the front door ever exists to read it. A throttled warning fires
 * instead so a configured-but-unwired mailbox is visible, not silent.
 */
import type { UserProfile } from '../../config/userProfile';
import { listNewMessages, markMessageRead, hasMailRefreshToken, MailAuthRevokedError } from './mail';
import { getMailInbound } from './mailInboundRegistry';
import { getConnection } from '../../connections/registry';
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

async function pollProfile(profileName: string, profile: UserProfile): Promise<void> {
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
      // Fires exactly once per revocation: this branch only runs while
      // profileId was NOT yet in revokedProfiles (the .add above just put it
      // there), and every tick from here on skips straight past pollProfile
      // at the revokedProfiles.has(...) check in tick() below — there is no
      // path back into this branch for the same revocation, so no 30s DM
      // loop. Never call this from that skip check instead of from here.
      await notifyOwnerOfRevokedMailAuth(profileName, profile);
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

/**
 * DM's the owner when the delegated refresh token is revoked and email
 * polling stops for this profile. Same reasoning as #24 row 120's
 * `notifyOwnerOfMailFailure` (connectors/email/inbound.ts) — and stronger
 * here: email itself is the thing that just failed, so Slack is the only
 * channel known to still be reachable. `getConnection(profileId, 'slack')`
 * from inside the email/Graph path is the same legitimate exception
 * documented there: CHANNEL_TOOL_CLAMP narrows the MODEL's tool list on an
 * email-originated turn, it does not gate a code-initiated send.
 *
 * Actionable by design, not just informative: re-running email-auth.mjs
 * alone does NOT resume polling — revokedProfiles (above) is in-memory and
 * cleared only by a restart, so the message spells out both steps in order.
 *
 * Never throws — a lost notification is recoverable, an unhandled rejection
 * out of a notifier is not. Prototype-cheap on purpose, same as row 120: no
 * retry, no backoff.
 */
async function notifyOwnerOfRevokedMailAuth(profileName: string, profile: UserProfile): Promise<void> {
  const profileId = profile.user.slack_user_id;
  try {
    const slack = getConnection(profileId, 'slack');
    if (!slack) {
      logger.warn('mailPoll — no Slack connection registered, cannot notify owner of revoked mail auth', {
        profileId,
      });
      return;
    }
    const mailbox = profile.channels?.email?.mailbox ?? 'the configured mailbox';
    const text = `Your email connection (${mailbox}) stopped working — the refresh token was revoked, so I've `
      + `stopped polling it (this won't retry or crash-loop on its own). To fix it:\n`
      + `1. Run \`node scripts/email-auth.mjs ${profileName}\` to re-sign in.\n`
      + `2. Then restart me — re-signing in alone only updates the token on disk, it doesn't resume polling `
      + `by itself.`;
    const res = await slack.sendDirect(profileId, text);
    if (!res.ok) {
      logger.error('mailPoll — Slack revoked-auth notification send failed', {
        profileId, reason: res.reason, detail: res.detail,
      });
    }
  } catch (err) {
    logger.error('mailPoll — notifyOwnerOfRevokedMailAuth itself threw', {
      profileId, err: String(err).slice(0, 200),
    });
  }
}

let tickInFlight = false;

function tick(profiles: Map<string, UserProfile>): void {
  if (tickInFlight) {
    logger.warn('mailPoll — previous tick still running, skipping this tick');
    return;
  }
  tickInFlight = true;
  (async () => {
    for (const [profileName, profile] of profiles.entries()) {
      if (!profileConfigured(profile)) continue;
      if (revokedProfiles.has(profile.user.slack_user_id)) continue;
      try {
        await pollProfile(profileName, profile);
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
