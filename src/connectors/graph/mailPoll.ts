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
import {
  listNewMessages, markMessageRead, hasMailRefreshToken, MailAuthRevokedError, LIST_MESSAGES_TIMEOUT_MS,
} from './mail';
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

// mailpoll-tick-no-timeout-single-stall-blocks-all-polling (bouncer follow-up,
// manual-2026-08-12) — a bounded listNewMessages (mail.ts) can still fail on
// EVERY tick indefinitely (a sustained Graph outage, DNS failure, etc.), and
// that used to be silent forever: `logger.warn` and return, no counter, no
// notification — unlike the revoked-token path three functions below, which
// DMs the owner once ITS failure state is permanent. This counts consecutive
// non-revoked listNewMessages failures per profile and DMs once a run reaches
// a threshold — unlike revocation, this condition can resolve on its own, so
// a single lifetime notification would be the wrong shape here.
//
// mailpoll-sustained-failure-notification-flood (bouncer follow-up,
// manual-2026-08-12) — re-notifying at a FLAT threshold (every 5 failures,
// forever) floods the owner: at the 30s tick interval, an 8-hour outage would
// re-notify ~192 times with an all-but-identical message. Fixed with
// exponential backoff on the re-notify threshold instead of a reset-to-0: the
// failure counter itself is now NEVER reset except on success (see
// pollProfile below), and a separate per-profile threshold doubles (5, 10,
// 20, 40, 80, ...) each time it's crossed — the same 8-hour outage now
// notifies ~8 times, each spaced twice as far apart as the last, enough to
// tell "still down" from "just started" without repeating forever at a flat
// cadence. Both maps clear on any successful listNewMessages call for that
// profile (see pollProfile), so a NEW failure streak always restarts at
// CONSECUTIVE_LIST_FAILURES_BEFORE_NOTIFY.
const consecutiveListFailures = new Map<string, number>();
const nextNotifyThreshold = new Map<string, number>();
const CONSECUTIVE_LIST_FAILURES_BEFORE_NOTIFY = 5;

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
      // Check-then-add, both synchronous with no `await` between them, so
      // this is atomic under JS's single-threaded scheduling even when two
      // overlapping pollProfile runs for the SAME profile both land here
      // concurrently (the stale-tick force-clear below can start a new tick
      // while an old one for this profile is still executing). Whichever
      // run's catch block is entered first observes `false`, sets it to
      // `true`, and is the only one that proceeds to notify; the other sees
      // `true` and skips straight past. Before this fix the guard was
      // "add, then always notify" — correct only when ticks never overlap,
      // which the stale-tick ceiling can now violate by design.
      const alreadyNotifiedThisRevocation = revokedProfiles.has(profileId);
      revokedProfiles.add(profileId);
      logger.error('mailPoll — refresh token revoked; stopping polling for this profile until re-auth', {
        profileId, err: String(err).slice(0, 200),
      });
      // Fires exactly once per revocation, including under the concurrent-run
      // case above: every tick from here on skips straight past pollProfile
      // at the revokedProfiles.has(...) check in tick() below, so once this
      // Set holds profileId there is no path back into this branch for the
      // same revocation. Never call this from that skip check instead of
      // from here.
      if (!alreadyNotifiedThisRevocation) {
        await notifyOwnerOfRevokedMailAuth(profileName, profile);
      }
      return;
    }
    const failureCount = (consecutiveListFailures.get(profileId) ?? 0) + 1;
    consecutiveListFailures.set(profileId, failureCount);
    logger.warn('mailPoll — listNewMessages failed, will retry next tick', {
      profileId, err: String(err).slice(0, 200), consecutiveFailures: failureCount,
    });
    const notifyThreshold = nextNotifyThreshold.get(profileId) ?? CONSECUTIVE_LIST_FAILURES_BEFORE_NOTIFY;
    if (failureCount >= notifyThreshold) {
      // Double the threshold, don't reset the counter — see the map's own
      // comment above for why: this is what turns "every 5th failure,
      // forever" into exponential backoff (5, 10, 20, 40, ...).
      nextNotifyThreshold.set(profileId, notifyThreshold * 2);
      await notifyOwnerOfSustainedListFailure(profile, failureCount, err);
    }
    return;
  }
  // Reached only on success (both catch branches above return) — clears any
  // failure streak AND the backed-off notify threshold, so a recovered
  // connection doesn't count toward a stale notification threshold from
  // before it recovered, and the next failure streak starts back at
  // CONSECUTIVE_LIST_FAILURES_BEFORE_NOTIFY rather than wherever it left off.
  consecutiveListFailures.delete(profileId);
  nextNotifyThreshold.delete(profileId);

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

/**
 * DM's the owner when `listNewMessages` has failed CONSECUTIVE_LIST_FAILURES_
 * BEFORE_NOTIFY times in a row for this profile — the escalation path the
 * revoked-token notifier above already has, extended to the OTHER way
 * polling can go quiet (mailpoll-tick-no-timeout-single-stall-blocks-all-
 * polling, bouncer follow-up, manual-2026-08-12): a bounded call can still
 * fail on every tick (Graph outage, DNS, etc.), and unlike a revoked refresh
 * token that failure carries no distinct log signature the owner would ever
 * think to search logs for — it's the same one warn line, repeating.
 *
 * Not phrased as actionable steps like the revoked-auth notifier: unlike a
 * revoked token, a sustained listNewMessages failure needs no owner action to
 * resume (polling keeps retrying on its own every tick) — this exists purely
 * so "mail intake has been down for a while" is a fact he can see instead of
 * silence, per D3: a state that persists until something changes earns a
 * message, a one-off transient failure does not.
 *
 * Never throws, same as notifyOwnerOfRevokedMailAuth — a lost notification is
 * recoverable, an unhandled rejection out of a notifier is not.
 *
 * mailpoll-sustained-failure-notification-flood (bouncer follow-up,
 * manual-2026-08-12) — called at an EXPONENTIALLY BACKED-OFF threshold now
 * (see nextNotifyThreshold's comment above pollProfile), not a flat every-5,
 * so repeats space out instead of flooding. The message text also states the
 * failure count and an approximate elapsed duration so two repeats are never
 * textually identical and a short blip reads differently from an hours-long
 * outage at a glance.
 */
async function notifyOwnerOfSustainedListFailure(
  profile: UserProfile,
  consecutiveFailures: number,
  lastErr: unknown,
): Promise<void> {
  const profileId = profile.user.slack_user_id;
  try {
    const slack = getConnection(profileId, 'slack');
    if (!slack) {
      logger.warn('mailPoll — no Slack connection registered, cannot notify owner of sustained mail-poll failure', {
        profileId,
      });
      return;
    }
    const mailbox = profile.channels?.email?.mailbox ?? 'the configured mailbox';
    // Approximate, not measured — ticks are ~MAIL_POLL_INTERVAL_MS apart when
    // listNewMessages fails fast (the common case), so this is close enough
    // to tell "just started" from "been down for hours" without adding a
    // start-timestamp map purely to sharpen a rough number.
    const elapsedApproxMin = Math.round((consecutiveFailures * MAIL_POLL_INTERVAL_MS) / 60_000);
    const text = `Checking email (${mailbox}) has failed ${consecutiveFailures} times in a row `
      + `(~${elapsedApproxMin} min, most recent error: ${String(lastErr).slice(0, 200)}). I'm still retrying `
      + `automatically every ${MAIL_POLL_INTERVAL_MS / 1000}s — no action needed unless this keeps happening, `
      + `in which case something's wrong with my connection to Microsoft Graph, not just a one-off blip.`;
    const res = await slack.sendDirect(profileId, text);
    if (!res.ok) {
      logger.error('mailPoll — Slack sustained-failure notification send failed', {
        profileId, reason: res.reason, detail: res.detail,
      });
    }
  } catch (err) {
    logger.error('mailPoll — notifyOwnerOfSustainedListFailure itself threw', {
      profileId, err: String(err).slice(0, 200),
    });
  }
}

/**
 * DM's the owner once tick() has given up STARTING NEW TICKS — not
 * necessarily given up forever (mailpoll-permanent-dead-state-only-logs-no-
 * owner-dm, manual backlog wave, 2026-08-14; corrected 2026-08-14 by the
 * bouncer's mailpoll-permanent-dead-state-false-restart-claim follow-up) —
 * the counterpart to notifyOwnerOfSustainedListFailure above, and worse in
 * the moment it fires: a sustained listNewMessages failure still retries
 * every tick on its own; once MAX_CONSECUTIVE_FORCE_CLEARS is hit, tick()
 * stops starting new ticks until the already-stuck generation finishes.
 * That can still happen on its own (see the .finally() reset next to
 * consecutiveForceClears below) — this notifier does NOT mean intake is
 * provably dead forever, only that repeated force-clears happened with no
 * recovery yet. If the stuck generation never finishes (a genuine
 * indefinite hang), a restart is the only way out; if it does finish,
 * polling resumes on the very next tick with no restart needed. Per D3: a
 * state that persists until something changes earns a message even when
 * "something changes" may be automatic recovery rather than owner action —
 * silence here is still the worse failure.
 *
 * Same notification mechanism as the two notifiers above (getConnection +
 * slack.sendDirect) — Slack is the only channel known to still be reachable
 * once email intake itself is what died. The message states what's actually
 * true (repeated force-clears, no confirmed recovery yet) rather than
 * asserting an outcome the code can't guarantee is irreversible. Guarded by
 * notifiedPermanentPollDeath, next to consecutiveForceClears above, which
 * now resets at the SAME recovery point consecutiveForceClears does — see
 * that flag's own comment — so a genuine later death after a real recovery
 * still gets its own fresh notification instead of being silently
 * swallowed by a stale "already notified" flag.
 *
 * Never throws — same contract as the two notifiers above.
 */
async function notifyOwnerOfPermanentPollFailure(profile: UserProfile, stuckForMs: number): Promise<void> {
  const profileId = profile.user.slack_user_id;
  try {
    const slack = getConnection(profileId, 'slack');
    if (!slack) {
      logger.warn('mailPoll — no Slack connection registered, cannot notify owner of permanent mail-poll failure', {
        profileId,
      });
      return;
    }
    const mailbox = profile.channels?.email?.mailbox ?? 'the configured mailbox';
    const stuckForMin = Math.round(stuckForMs / 60_000);
    const text = `Checking email (${mailbox}) has been stuck for ~${stuckForMin} min and I've force-cleared a `
      + `stalled poll ${MAX_CONSECUTIVE_FORCE_CLEARS} times in a row without it finishing, so I've stopped `
      + `starting new polls for now. That earlier stalled run can still complete on its own, in which case `
      + `polling resumes automatically with no action from you — but if email keeps not coming through, `
      + `restarting me is the reliable way to get it moving again.`;
    const res = await slack.sendDirect(profileId, text);
    if (!res.ok) {
      logger.error('mailPoll — Slack permanent-failure notification send failed', {
        profileId, reason: res.reason, detail: res.detail,
      });
    }
  } catch (err) {
    logger.error('mailPoll — notifyOwnerOfPermanentPollFailure itself threw', {
      profileId, err: String(err).slice(0, 200),
    });
  }
}

let tickInFlight = false;
let tickStartedAt = 0;
let currentTickGeneration = 0;

// mailpoll-tick-no-timeout-single-stall-blocks-all-polling — pollProfile's
// loop is a Graph delta call (listNewMessages), then a full inbound-handler
// orchestrator turn per message, then markMessageRead. The delta call and the
// mark-read call are both bounded now (see LIST_MESSAGES_TIMEOUT_MS and
// SHORT_MAIL_CALL_TIMEOUT_MS in mail.ts, AbortSignal.timeout covering the
// whole delta call including pagination and the 410 retry, and the single
// mark-read PATCH respectively) — a stall in EITHER can no longer hold
// tickInFlight forever, and per the bouncer's own trace listNewMessages was
// also the ONLY call whose stall could double-handle a message: the delta
// watermark is written just before listNewMessages returns, so a stall
// inside the per-message handler() call happens strictly AFTER the watermark
// has already advanced past that message, and a forced tick's own fresh
// listNewMessages call simply won't see it again. So what remains for this
// ceiling to guard is starvation, not duplication: the per-message
// inbound-handler orchestrator turn is the one remaining call with no bound
// of its own, and it could still hang indefinitely, silently skipping every
// 30s tick behind it with no way to recover short of a process restart.
//
// CALIBRATION, corrected AGAIN 2026-08-12 (mailpoll-calibration-comment-
// still-wrong-2nd-time, bouncer follow-up, manual-2026-08-12) — the prior
// correction on this same row undercounted both numbers it cited. Re-derived
// here from two windows pulled fresh (scripts/vm-logs.ps1), gaps counted
// precisely rather than eyeballed:
//
//   - 2026-08-11 01:03:12.610-01:09:12.618: SEVEN skip-warns (01:03:12.610,
//     01:04:12.611, 01:04:42.612, 01:05:42.613, 01:06:12.613, 01:06:42.614,
//     01:09:12.618). A 30s gap between consecutive warns means the SAME
//     stuck run was still in flight at both checks; a 60s+ gap means N/30
//     ticks passed the tickInFlight check without a warn in between, i.e.
//     completed. Counting those gaps gives SIX completions in this window,
//     not four — skips and completions were thoroughly interspersed, never
//     seven in a row, and the mailbox recovered with no restart: the next
//     mailPoll log is a routine "starting mailbox poll timer" at 04:33:40,
//     over 3 hours later, with zero force-clear errors anywhere in between —
//     proof the run in flight at 01:09:12.618 finished well inside the
//     ceiling of the time, just with no completion log to time it by exactly
//     (it processed 0 new messages, which logs nothing).
//   - 2026-08-07 18:10:10.542-18:20:29.753: this window's "processed new
//     mail" lines (absent from the 01:03-01:09 window, which had no new mail
//     to log) let ticks be timed exactly, by pairing each stuck run's own
//     grid-aligned start with its completion log: 18:09:40.542->18:11:09.064
//     (88.5s, the observed max), 18:12:10.542->18:12:33.242 (22.7s),
//     18:13:40.542->18:14:14.489 (33.9s), ~18:15:10.542->18:15:51.746
//     (41.2s), ~18:19:40.549->18:20:29.753 (49.2s) — five single-message
//     round trips (listNewMessages + one handler() orchestrator turn + one
//     markMessageRead, each completion logging count:1) ranging 22.7-88.5s.
//
// So: SIX completions in the 01:03-01:09 window (not four), and an observed
// max end-to-end round trip of ~88.5s — call it up to ~90s, matching
// LIST_MESSAGES_TIMEOUT_MS's own "~90s max" in mail.ts, and NOT the 120s an
// earlier pass on this same correction assumed without re-measuring; that
// number didn't survive pulling the 08-07 window and pairing timestamps
// precisely. This remains evidence `listNewMessages` plus one message's full
// handling can legitimately run up to ~90s under real Graph latency, not
// evidence of the indefinite hang this ceiling guards against. The
// genuinely-unbounded scenario below (an orchestrator turn that never
// returns) has not been directly observed in production; it has no bound of
// its own regardless. After this ceiling is exceeded the flag is
// force-cleared and a NEW tick is allowed to start even though the stuck run
// may still be executing in the background. A tick-GENERATION counter (not a
// boolean) guards the handoff: the stuck run's own eventual .finally() checks
// it was still "current" when it started, so it can never clobber a
// legitimately in-flight newer tick's flag by clearing it out from under it.
//
// CEILING SHAPE, corrected the same pass (stale-tick-ceiling-fires-on-
// healthy-multi-message-ticks) — the old ceiling was a FLAT 10 missed
// intervals (300s), sized as if a tick only ever handles one message. It
// doesn't: Graph hands back every message accumulated since the last
// successful poll in ONE delta response (an overnight gap, or a 410
// resync), and pollProfile's loop handles them SEQUENTIALLY — so a real
// (not stuck) tick's total cost is listNewMessages' own bounded call
// (LIST_MESSAGES_TIMEOUT_MS, imported from mail.ts, which also covers a 410
// resync's full-inbox pass) PLUS one handler()+markMessageRead round trip
// PER message returned. At the observed ~88.5s worst single-message round
// trip, FOUR ordinary unread messages in one delta response (4x88.5s=354s)
// already exhausted the old flat 300s ceiling with nothing actually stuck —
// a false force-clear, not a caught hang (three, 265.5s, would not have;
// corrected 2026-08-12, mailpoll-calibration-comment-still-wrong-2nd-time —
// "three to four" was an arithmetic slip). The ceiling is now proportional
// instead of flat: LIST_MESSAGES_TIMEOUT_MS for the delta fetch, plus
// STALE_TICK_MESSAGES_MARGIN messages at STALE_TICK_PER_MESSAGE_MARGIN_MS
// each. Both terms are margins over the SAME single observed measurement —
// the ~88.5s worst single-message round trip above, which bundles one
// listNewMessages call together with one handler()+markMessageRead call and
// is the only end-to-end mail timing this codebase has ever logged (see
// mail.ts's LIST_MESSAGES_TIMEOUT_MS comment) — not two independently
// measured quantities, so the sum is deliberately generous rather than a
// tight decomposition of a multi-message tick's true cost. The message-count
// margin is sized for a real but bounded backlog (overnight gap, 410
// resync), not an unbounded one. A tick still running past THIS ceiling is
// what stays the genuinely-unbounded-hang signal this mechanism exists to
// catch.
//
// Force-clears are themselves capped (MAX_CONSECUTIVE_FORCE_CLEARS) rather
// than being able to fire forever while a stall persists — each one can only
// leave the ALREADY-stuck run behind (the analysis above says it can't cause
// duplicate handling), so the residual risk capping closes is unbounded
// background-task accumulation, not a correctness bug. The counter resets
// whenever any generation completes on its own — see the .finally() below —
// so it tracks consecutive force-clears with no intervening recovery, not a
// lifetime total.
const STALE_TICK_PER_MESSAGE_MARGIN_MS = 120_000; // ~1.4x margin over the observed ~88.5s worst single-message round trip
const STALE_TICK_MESSAGES_MARGIN = 5; // a real but bounded worst-case backlog (overnight gap, 410 resync) — not unbounded
const STALE_TICK_CEILING_MS = LIST_MESSAGES_TIMEOUT_MS + STALE_TICK_MESSAGES_MARGIN * STALE_TICK_PER_MESSAGE_MARGIN_MS;
const MAX_CONSECUTIVE_FORCE_CLEARS = 3;
let consecutiveForceClears = 0;

// mailpoll-permanent-dead-state-only-logs-no-owner-dm (manual backlog wave,
// 2026-08-14; reset point corrected 2026-08-14 by the bouncer's
// mailpoll-permanent-dead-state-false-restart-claim follow-up) — once tick()
// gives up below, every tick re-enters that branch every 30s until either a
// restart or the stuck generation finishes on its own (see the .finally()
// below, which resets this flag at the same point it resets
// consecutiveForceClears). Without this guard the DM added there would
// repeat every 30s for as long as the dead state lasts — the exact flood
// mailpoll-sustained-failure-notification-flood already fixed one mechanism
// over. Resets on genuine recovery, not just on restart, so a later real
// death after a real recovery still gets its own fresh notification instead
// of being silenced forever by a flag that was never cleared.
let notifiedPermanentPollDeath = false;

function tick(profiles: Map<string, UserProfile>): void {
  if (tickInFlight) {
    const stuckForMs = Date.now() - tickStartedAt;
    if (stuckForMs < STALE_TICK_CEILING_MS) {
      logger.warn('mailPoll — previous tick still running, skipping this tick', { stuckForMs });
      return;
    }
    if (consecutiveForceClears >= MAX_CONSECUTIVE_FORCE_CLEARS) {
      logger.error(
        'mailPoll — previous tick still stuck after the maximum consecutive force-clears; giving up on '
        + 'starting new ticks until a restart (another force-clear would only add another background '
        + 'run behind an already-unrecovered stall, not help)',
        { stuckForMs, consecutiveForceClears },
      );
      if (!notifiedPermanentPollDeath) {
        notifiedPermanentPollDeath = true;
        for (const profile of profiles.values()) {
          if (!profileConfigured(profile)) continue;
          void notifyOwnerOfPermanentPollFailure(profile, stuckForMs);
        }
      }
      return;
    }
    consecutiveForceClears++;
    logger.error(
      'mailPoll — previous tick exceeded the stale ceiling; force-clearing and starting a new tick anyway '
      + '(the stuck run may still be executing in the background; it will not retry on its own)',
      { stuckForMs, ceilingMs: STALE_TICK_CEILING_MS, consecutiveForceClears },
    );
    // Fall through and start a new tick — do not return here.
  }
  const myGeneration = ++currentTickGeneration;
  tickInFlight = true;
  tickStartedAt = Date.now();
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
    .finally(() => {
      // Only the still-current tick clears the flag — see the generation
      // comment above for why a stale, force-cleared tick must not clear a
      // newer one's flag when it finally resolves. Same reasoning for the
      // force-clear counter AND the permanent-death notification flag: this
      // generation finishing on its own is a recovery signal, so it resets
      // the count of consecutive force-clears and notifiedPermanentPollDeath
      // with no intervening success — a STALE generation's eventual
      // .finally() must not (it is the thing that was stuck, not proof the
      // stall is over). Resetting notifiedPermanentPollDeath here too
      // (mailpoll-permanent-dead-state-false-restart-claim, bouncer
      // follow-up, 2026-08-14) matters because the "gave up" DM never
      // promised the dead state was irreversible — it can end exactly here,
      // and when it does, a LATER genuine permanent death must still earn
      // its own notification instead of being silently swallowed by a flag
      // that was left `true` forever.
      if (myGeneration === currentTickGeneration) {
        tickInFlight = false;
        consecutiveForceClears = 0;
        notifiedPermanentPollDeath = false;
      }
    });
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
