import { App } from '@slack/bolt';
import type { UserProfile } from '../config/userProfile';
import { runDueTasks } from '../tasks/runner';
import { materializeRoutineTasks, backfillNullNextRunAt } from '../tasks/routineMaterializer';
import { ensureBriefingCron, updateBriefingCronChannel } from '../tasks/crons';
import logger from '../utils/logger';
import { readInternalSlackConversation } from '../connections/slack/eligibility';
import { readSlackThread } from '../connectors/slack/threadHistory';

// v3.3.10 — recovery scope: DM + panel threads, gap-from-watermark (no time
// cap — "since Maelle was last online", any length), one reply per distinct
// unread THREAD (a person with two separate unanswered threads gets both),
// posted in-thread. The legacy 24h LOOKBACK_HOURS was removed — the watermark
// IS the window.
//
// Recovery covers DMs, MPIMs and joined channels. Each actual answer stays in
// its original thread; room candidates reuse the live addressing boundary.

// ── Background timer ─────────────────────────────────────────────────────────

/**
 * #30 — expire slot holds past min(2 owner-workdays, slot-start). Releases each
 * as 'expired' and DMs the holder that the time was freed (decision 4:
 * "always cancel after 2 days → DM the person"). Reuse the origin thread only
 * when it belongs to the holder's DM. Owner-parked holds with no holder slack_id are
 * released silently. Fire-and-forget via processSlotHoldsIfDue; never throws upward.
 */
async function sweepExpiredSlotHolds(profiles: Map<string, UserProfile>): Promise<void> {
  try {
    const { getDueSlotHolds, releaseSlotHold } = await import('../db/slotHolds');
    const { getConnection } = await import('../connections/registry');
    const { DateTime } = await import('luxon');
    const due = getDueSlotHolds(new Date().toISOString());
    if (due.length === 0) return;
    for (const h of due) {
      releaseSlotHold(h.id, 'expired', true);
      if (!h.holder_slack_id) continue;                 // owner-parked external — no one to DM
      // Only tell the holder we "freed up" the slot if it's still in the FUTURE.
      // A hold whose slot already started expires with expires_at=slot-start
      // (past) → "I freed up Tuesday 2pm" sent on Wednesday reads as nonsense.
      // Release it silently in that case (the release above already ran).
      const startMs = Date.parse(h.start_iso);
      if (Number.isFinite(startMs) && startMs <= Date.now()) continue;
      const profile = profiles.get(h.owner_user_id);
      if (!profile) continue;
      try {
        const conn = getConnection(h.owner_user_id, 'slack');
        if (!conn) continue;
        const when = DateTime.fromISO(h.start_iso).setZone(profile.user.timezone);
        const whenLabel = when.isValid ? when.toFormat('EEE d MMM HH:mm') : h.start_iso;
        const subj = h.subject ? ` for "${h.subject}"` : '';
        // A room or another person's DM has a different thread namespace.
        // Unresolved ownership still permits a private, top-level notice.
        const holderChannel = h.origin_channel && h.origin_thread_ts
          ? await conn.resolveDirectChannelId?.(h.holder_slack_id).catch(() => null)
          : null;
        const threadTs = holderChannel && holderChannel === h.origin_channel
          ? h.origin_thread_ts ?? undefined
          : undefined;
        const sent = await conn.sendDirect(
          h.holder_slack_id,
          `Freed up the ${whenLabel} hold${subj} — it had been pending a couple of days, so I let it go. Just say the word if you still want it.`,
          threadTs ? { threadTs } : undefined,
        );
        if (!sent.ok) throw new Error(sent.detail ?? sent.reason);
      } catch (err) {
        logger.warn('sweepExpiredSlotHolds — holder DM failed (hold already released)', { id: h.id, err: String(err).slice(0, 150) });
      }
    }
    logger.info('sweepExpiredSlotHolds', { expired: due.length });
  } catch (err) {
    logger.warn('sweepExpiredSlotHolds threw — continuing', { err: String(err).slice(0, 200) });
  }
}

/** Hold/event subject identity — exact after case/whitespace normalization
 *  (the same normalization the per-meeting hold cap uses), never fuzzy. */
function normalizedSubject(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Reconcile active holds against the REAL calendar (owner ruling 2026-09-17:
 * "I do want to auto-close a hold if you see it on the Outlook"): when the
 * hold's OWN meeting is on the calendar — e.g. the colleague sent the Outlook
 * invite themselves — release it `fulfilled_by_booking` (the brief reports it).
 * A booking made through Maelle never reaches here; createMeeting releases it
 * on the spot (db/slotHolds releaseHoldsTakenByBooking).
 *
 * "The hold's own meeting" means ALL of: a timed real commitment (all-day
 * events and everything `occupancyRoleOf` — the validator's own predicate —
 * calls free / working-elsewhere / elastic are never a booked hold; the
 * 2026-09-15 false release was a two-week all-day free "Dina - Vacation"
 * marker with the holder on it), the holder as attendee, and the event
 * COVERING the held window — or, when the hold carries a subject and the
 * event's subject equals it, merely overlapping it (same meeting, shifted a
 * little when the invite was sent). Brushing the window is never enough.
 * Owner-parked holds (no holder_slack_id) are skipped — no attendee to match.
 */
async function reconcileFulfilledHolds(profiles: Map<string, UserProfile>): Promise<void> {
  try {
    const { getActiveSlotHolds, releaseSlotHold } = await import('../db/slotHolds');
    const { getPersonMemory } = await import('../db/people');
    const { getCalendarEvents } = await import('../connectors/graph/calendar');
    const { occupancyRoleOf } = await import('../utils/scheduleRules');
    const { getFloatingBlocks } = await import('../utils/floatingBlocks');
    const { DateTime } = await import('luxon');
    for (const profile of profiles.values()) {
      const holds = getActiveSlotHolds(profile.user.slack_user_id);
      if (holds.length === 0) continue;
      const tz = profile.user.timezone;
      const floatingBlocks = getFloatingBlocks(profile);
      for (const h of holds) {
        if (!h.holder_slack_id) continue;
        const holderEmail = (getPersonMemory(h.holder_slack_id)?.email ?? '').toLowerCase();
        if (!holderEmail) continue;
        const startMs = Date.parse(h.start_iso);
        const endMs = Date.parse(h.end_iso);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
        const holdSubject = normalizedSubject(h.subject);
        const day = DateTime.fromMillis(startMs).setZone(tz).toFormat('yyyy-MM-dd');
        let events;
        try {
          events = await getCalendarEvents(profile.user.email, day, day, tz);
        } catch { continue; }
        const match = events.find(ev => {
          // Occupancy needs the owner profile so a self attendee or configured
          // room does not turn a movable floating block into a human meeting.
          if (ev.isAllDay || occupancyRoleOf(ev, floatingBlocks, tz, profile) !== 'commitment') return false;
          if (!(ev.attendees ?? []).some(a => (a.emailAddress?.address ?? '').toLowerCase() === holderEmail)) return false;
          const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' }).toMillis();
          const evEnd = DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone ?? 'utc' }).toMillis();
          const sameSubject = holdSubject !== '' && normalizedSubject(ev.subject) === holdSubject;
          return sameSubject ? (evStart < endMs && evEnd > startMs) : (evStart <= startMs && evEnd >= endMs);
        });
        if (match) {
          releaseSlotHold(h.id, 'fulfilled_by_booking');
          logger.info('reconcileFulfilledHolds — the held meeting is on the calendar, released', {
            id: h.id, holder: h.holder_name, eventId: match.id, subjectMatch: normalizedSubject(match.subject) === holdSubject,
          });
        }
      }
    }
  } catch (err) {
    logger.warn('reconcileFulfilledHolds threw — continuing', { err: String(err).slice(0, 200) });
  }
}

// The hold lifecycle (reconcile + expiry) runs on its OWN 30-min cadence, not
// every 5-min tick — a 2-day-out hold doesn't need 5-min polling, and per the
// owner that frequency read as spam. The global tick stays 5-min (reminders /
// routines / request expiry need it); only the hold work is throttled here.
const HOLD_PROCESS_INTERVAL_MS = 30 * 60 * 1000;
let lastHoldProcessMs = 0;
async function processSlotHoldsIfDue(profiles: Map<string, UserProfile>): Promise<void> {
  const now = Date.now();
  if (now - lastHoldProcessMs < HOLD_PROCESS_INTERVAL_MS) return;
  lastHoldProcessMs = now;
  await reconcileFulfilledHolds(profiles);   // release holds whose own meeting is now on the calendar
  await sweepExpiredSlotHolds(profiles);      // then expire the genuinely-stale ones
}

/**
 * Starts the 5-minute background timer that runs all periodic tasks.
 */
export function startBackgroundTimer(
  runningApps: Array<{ app: App; name: string }>,
  profiles: Map<string, UserProfile>,
): void {
  // v2.7.0 — orphan-backfill scripts deleted. The requests spine is correct
  // by construction; if it leaks we fix the leak, not patch with a sweeper.

  // v1.6.0 — single-pipeline background loop. v3.1 (Path 2): all LIFECYCLE
  // timers (outreach send/expiry, coord nudge/abandon, approval expiry/reminder)
  // moved off the tasks table onto the requests spine — they fire via
  // sweepDueRequests (called inside runDueTasks). The tasks table now carries
  // only non-back-and-forth work: routine, calendar_fix, social_*, reminder,
  // follow_up, research. Materialize first so newly inserted routine tasks are
  // visible to the runner in the same tick.
  //
  // v2.9.3 (#103) — end-of-chat capture pass piggybacks on the same loop.
  // No new cron entity; the existing 5-min tick is the only scheduler. The
  // pass is bounded (≤20 ready threads/tick), fire-and-forget, and never
  // blocks the materializer/runner pipeline.
  // v3.8.x — re-entrancy guard. setInterval does NOT await the async pipeline, so
  // if one run exceeds the 5-min interval the next tick re-enters and
  // sweepDueRequests re-selects the same still-open rows — request handlers
  // (runResearchRun/runReminderFire) only clear next_check_at at the very end, so
  // this double-fires a research/reminder run + double owner DMs + double LLM spend.
  // Skip a tick while one is in flight (mirrors the 10-min catch-up's
  // periodicInFlight). The prune + capture pass below still run every tick — they
  // carry their own guards and are cheap.
  let taskPipelineInFlight = false;
  setInterval(() => {
    const app = runningApps[0]?.app;
    if (!app) return;
    if (taskPipelineInFlight) {
      logger.warn('Routine→task pipeline still running from a prior tick — skipping this tick');
    } else {
      taskPipelineInFlight = true;
      materializeRoutineTasks(profiles)
        .then(() => runDueTasks(app, profiles))
        .then(() => processSlotHoldsIfDue(profiles))
        .catch(err => logger.error('Routine→task pipeline error', { err: String(err) }))
        .finally(() => { taskPipelineInFlight = false; });
    }

    // #30 — slot-hold retention (drop terminal rows >30d). Fire-and-forget;
    // never blocks the task pipeline.
    // gh#52 (52-U9) — the requests-spine prune that used to run alongside
    // this (pruneOldTerminalRequests, core/requests/reconcile.ts) is GONE.
    // Owner ruling: "its a mistake don't truncate requests/approvals" —
    // nothing on the requests spine is ever deleted for age. Slot holds are a
    // separate, much smaller housekeeping table and keep their own retention.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { cleanOldSlotHolds } = require('../db/slotHolds') as typeof import('../db/slotHolds');
      cleanOldSlotHolds();
    } catch (err) {
      logger.warn('Slot-hold retention threw — non-fatal', { err: String(err).slice(0, 200) });
    }

    // Capture pass runs independently — its errors should never affect the
    // routine pipeline. Per-profile loop because the capture state
    // (people_memory, .md files) is owner-scoped.
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { runCapturePass } = require('../memory/capturePass') as typeof import('../memory/capturePass');
      for (const profile of profiles.values()) {
        try {
          await runCapturePass(profile);
        } catch (err) {
          logger.warn('runCapturePass threw — continuing', {
            ownerUserId: profile.user.slack_user_id,
            err: String(err).slice(0, 200),
          });
        }
      }
    })();
  }, 5 * 60 * 1000);

  // v3.3.10 follow-up — PERIODIC catch-up safety net (every 10 min).
  // WHY: the socket watchdog triggers recovery on a DETECTED reconnect/dead
  // socket. But a "half-dead" socket — Bolt reporting client.connected===true
  // while delivering nothing (real case 2026-06-14: laptop network dropped
  // overnight, socket went deaf, `connected` stayed true) — is never detected,
  // so no reconnect fires and inbound silently stops until a manual restart.
  // This scan runs over HTTP (WebClient, independent of socket health) and
  // recovers missed messages regardless of what the socket claims.
  //
  // CRITICAL: it scopes to its OWN last-scan time, NOT the socket-alive
  // watermark. In the half-dead case the watchdog keeps stamping that watermark
  // fresh (connected lies true), so scoping to it would see a zero gap and miss
  // the very message we need. lastPeriodicScan is detection-independent: a
  // rolling ~10-min window, bounded and cheap; the per-conversation
  // answered-check + markProcessed dedup prevent any double-reply with live
  // delivery or the startup/reconnect catch-up.
  const PERIODIC_CATCHUP_MS = 10 * 60 * 1000;
  const lastPeriodicScan = new Map<string, number>();
  let periodicInFlight = false;
  setInterval(() => {
    void (async () => {
      if (periodicInFlight) return;  // never overlap a prior slow run
      const app = runningApps[0]?.app;
      if (!app) return;
      periodicInFlight = true;
      try {
        for (const profile of profiles.values()) {
          const pid = profile.user.slack_user_id;
          const sinceMs = lastPeriodicScan.get(pid) ?? (Date.now() - PERIODIC_CATCHUP_MS);
          const scanStart = Date.now();
          try {
            const dmRes = await app.client.conversations.open({
              token: profile.assistant.slack.bot_token,
              users: pid,
            });
            const ownerChannel = (dmRes.channel as any)?.id as string | undefined;
            if (!ownerChannel) continue;
            await catchUpMissedMessages(app, profile, ownerChannel, sinceMs, true);
            lastPeriodicScan.set(pid, scanStart);  // advance only on success
          } catch (err) {
            logger.warn('Periodic catch-up — per-profile error, continuing', {
              pid, err: String(err).slice(0, 200),
            });
          }
        }
      } finally {
        periodicInFlight = false;
      }
    })();
  }, PERIODIC_CATCHUP_MS);
}

// ── Startup initialisation ───────────────────────────────────────────────────

/**
 * Runs at startup for each profile:
 * 1. Ensures the system briefing cron exists
 * 2. Sends any missed briefing from today
 * 3. Catches up on missed messages (last 48h)
 */
export async function initProfile(
  app: App,
  profile: UserProfile,
  dmChannel: string,
): Promise<void> {
  // Ensure briefing cron exists and set its DM channel
  ensureBriefingCron(profile);
  updateBriefingCronChannel(profile.user.slack_user_id, dmChannel);

  // v2.9.3 (#104) — one-shot migration: bump the user-curated calendar-
  // health routine from once-a-day (07:30) to twice-a-day (07:30,13:00).
  // Idempotent — only fires when the row is in its untouched starting
  // shape (schedule_time === '07:30', is_system=0, title match).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require('../db/client') as typeof import('../db/client');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runV293CalendarHealthTwiceDaily } = require('../db/migrations/v2_9_3_calendar_health_twice_daily') as
      typeof import('../db/migrations/v2_9_3_calendar_health_twice_daily');
    runV293CalendarHealthTwiceDaily(getDb(), profile.user.timezone);
  } catch (err) {
    logger.warn('v2.9.3 calendar-health twice-daily migration threw — continuing', {
      err: String(err).slice(0, 200),
    });
  }

  // #75 — repair any active routines stuck with next_run_at = NULL. Caused
  // by the materializer's `WHERE next_run_at IS NOT NULL` filter being the
  // only thing that updates next_run_at — once NULL, silently invisible
  // forever. Backfill computes the first future firing from schedule_*.
  // Idempotent; logs a warn per repair so we know if something is bypassing
  // create_routine.
  try {
    const repaired = backfillNullNextRunAt(profile);
    if (repaired > 0) {
      logger.info('Routine null-next-run-at backfill complete', {
        ownerUserId: profile.user.slack_user_id,
        repaired,
      });
    }
  } catch (err) {
    logger.error('Routine null-next-run-at backfill threw — continuing', { err: String(err) });
  }

  // v2.2 — Social Engine: seed the 30 fixed categories for this owner on
  // first startup. Idempotent via UNIQUE(owner_user_id, label) + count check.
  // Rows stay seeded across restarts; topics created at runtime as the owner
  // brings them up (or as Maelle raises new ones).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const social = require('../db/socialSubjects') as typeof import('../db/socialSubjects');
    social.ensureCategoriesSeeded(profile.user.slack_user_id);
  } catch (err) {
    logger.warn('Social categories seeding threw — continuing', { err: String(err) });
  }

  // v2.2 — Migrate legacy profile_json.engagement_level strings to numeric
  // engagement_rank. Idempotent; only affects rows still at the default.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rank = require('../db/engagementRank') as typeof import('../db/engagementRank');
    rank.migrateLegacyEngagementLevel();
  } catch (err) {
    logger.warn('Legacy engagement_level migration threw — continuing', { err: String(err) });
  }

  // gh#198 (2026-08-15) — the weekly social_decay seed is REMOVED (answer 5:
  // subjects no longer carry a score to decay; a subject now dies on 2
  // unanswered raises or an explicit reject, never on a clock — see
  // socialSubjects.ts / capturePass.ts). Drain any lingering pending/new rows
  // of this now-dispatcher-less type once, same pattern as the cold-open
  // drain below — the dispatcher is gone, so the runner would otherwise just
  // mark them 'failed'. Idempotent — a no-op after the first clean pass.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require('../db') as typeof import('../db');
    const res = getDb().prepare(`
      UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
      WHERE type = 'social_decay'
        AND owner_user_id = ?
        AND status IN ('new', 'scheduled', 'in_progress')
    `).run(profile.user.slack_user_id);
    if (res.changes > 0) {
      logger.info('Social decay tasks drained (weekly decay pass removed, gh#198)', {
        ownerUserId: profile.user.slack_user_id, cancelled: res.changes,
      });
    }
  } catch (err) {
    logger.warn('Social decay task drain threw — continuing', { err: String(err) });
  }

  // v3.2.5 — cold-open proactive outreach (the hourly `social_outreach_tick`)
  // was REMOVED. Proactive social now happens ONLY as an in-conversation coda
  // (the social directive on a live turn — chooseSocialDirective), never as an
  // out-of-the-blue DM. Owner direction: "kill the cold open, keep the coda as
  // the entry point to raise topics — she attaches to a discussion the person
  // is already having." Drain any lingering self-rearmed tick rows once so they
  // don't sit in the queue (the dispatcher is gone; the runner would just mark
  // them failed). Idempotent — a no-op after the first clean pass.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require('../db') as typeof import('../db');
    const res = getDb().prepare(`
      UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
      WHERE type = 'social_outreach_tick'
        AND owner_user_id = ?
        AND status IN ('new', 'scheduled', 'in_progress')
    `).run(profile.user.slack_user_id);
    if (res.changes > 0) {
      logger.info('Cold-open outreach ticks drained (cold-open system removed)', {
        ownerUserId: profile.user.slack_user_id, cancelled: res.changes,
      });
    }
  } catch (err) {
    logger.warn('Cold-open tick drain threw — continuing', { err: String(err) });
  }

  // v1.5.1 — checkMissedBriefing is gone. If today's briefing was missed,
  // the routine's next_run_at is in the past and the materializer will
  // insert a task on the next 5-min tick; the runner's lateness policy
  // decides run-or-skip. No startup special-case needed.

  // v3.1.7 — the auto calendar backfill of external people was REMOVED: it
  // swept the entire external calendar (customer demos, partner calls, a
  // personal event, the Gong bot) instead of just deliberate recent bookings,
  // and flooded the people catalog. External people are now persisted ONLY by
  // the live recordBooking path when the owner actually books a meeting (with a
  // non-human attendee filter); catch-up is a pick-list the owner chooses from.

  // Startup catch-up is deliberately NOT run here. initProfile is the FAST
  // local setup (idempotent migrations + seeding) — it must stay quick because
  // index.ts awaits it BEFORE the Slack socket opens. The ~40s, all-DMs catch-up
  // scan now runs in the BACKGROUND right after the socket opens (index.ts
  // Phase 4), so a restart no longer leaves Maelle deaf while it runs. Ordering
  // is safe: markProcessed (processedDedup.ts) is a shared atomic claim, so a
  // re-delivered message races between the live handler and the background scan
  // and exactly one wins — see replayMissedMessage's mid-flight guard. index.ts
  // captures the pre-boot watermark before stamping the socket alive.
}

// ── Catch-up on missed messages ──────────────────────────────────────────────

/**
 * On startup (and on reconnect / the 10-min heartbeat): scan the bot's DMs +
 * panel threads for messages that arrived while the socket was down and never
 * got a reply.
 *
 *   - Window = since the socket watermark (no cap); no watermark → since NOW
 *     (replay nothing). See the SAFETY note on `oldest` below.
 *   - At most ONE reply per distinct unanswered thread (answered-check +
 *     per-thread dedup).
 *   - Replies route through the live inbound path (replayMissedMessage), so
 *     voice/image/video are handled exactly as a live message; the posted
 *     reply itself is the delivery evidence; no preliminary caption is posted.
 */
// The periodic heartbeat (every 10 min) scans all DMs and almost always finds
// nothing — logging that scan each time floods the log (~144 lines/day of "I
// looked, found nothing"). Throttle the heartbeat's scan line to at most one
// per hour. The scan itself still runs every tick — only the log is rate-
// limited. Startup / reconnect catch-ups (rare, meaningful) are never throttled.
const HEARTBEAT_SCAN_LOG_INTERVAL_MS = 60 * 60 * 1000;
let lastHeartbeatScanLogMs = 0;
function shouldLogHeartbeatScan(): boolean {
  const now = Date.now();
  if (now - lastHeartbeatScanLogMs >= HEARTBEAT_SCAN_LOG_INTERVAL_MS) {
    lastHeartbeatScanLogMs = now;
    return true;
  }
  return false;
}

// v3.3.x — exported so the socket watchdog can fire a gap-scoped recovery on
// reconnect (not only at startup). `sinceMs` is the socket-alive watermark;
// when omitted the gap starts NOW (replay nothing — see the `oldest` SAFETY
// note below), NOT a 24h lookback.
// `isHeartbeat` is set by the 10-min periodic safety-net caller so its routine
// "scanning DMs" log line is throttled to ≤1/hour (the scan still runs).
// Bounded-concurrency runner for the per-DM scan. The catch-up loop used to be
// strictly serial: with ~30+ DMs and ≥2 Slack Web-API calls each (top-level
// history + panel-thread discovery), that's 60+ sequential Tier-3 round-trips →
// ~40s wall time. A small worker pool overlaps the round-trips (far shorter wall
// time) while staying modest enough not to trip Slack's per-method rate limits
// into a 429 backoff storm. Order-independent — each DM is scanned in isolation
// and dedup is per-message-ts. Tunable via CATCHUP_SCAN_CONCURRENCY.
const CATCHUP_SCAN_CONCURRENCY = 5;
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

export async function catchUpMissedMessages(
  app: App,
  profile: UserProfile,
  ownerChannel: string,
  sinceMs?: number,
  isHeartbeat?: boolean,
): Promise<void> {
  const botToken = profile.assistant.slack.bot_token;

  let botUserId: string;
  try {
    const auth = await app.client.auth.test({ token: botToken });
    botUserId = auth.user_id as string;
  } catch (err) {
    logger.warn('Catch-up: could not resolve bot user ID', { err: String(err) });
    return;
  }

  // Gap = "since Maelle was last online", from the watermark. NO time cap
  // (owner direction): if she was off two days, recover two days; off a week,
  // a week. The per-conversation answered-check (latestHuman > latestBot)
  // decides; the window just bounds how far back we look.
  //
  // SAFETY: with NO watermark — first run on this build, or a lost file — we
  // have no record of when she was last up, so do NOT sweep an unknown
  // backlog. The history-based panel discovery sees threads the OLD
  // registry-blind catch-up never answered; sweeping on a fresh boot would
  // belatedly blast colleagues with stale messages. "What's gone is gone":
  // no watermark → gap starts NOW → replay nothing pre-existing. Once a
  // watermark exists, real outages of ANY length recover fully.
  const nowMs = Date.now();
  const oldest = String((sinceMs != null ? sinceMs : nowMs) / 1000);

  // Scan every listed surface, then verify internal eligibility before reading
  // content. Recovery answers each distinct unanswered thread, not just the
  // latest conversation in a DM. MPIM candidates reuse the live addressee gate;
  // channel candidates require an explicit mention on that message.
  const dmChannels = new Set<string>([ownerChannel]);
  const mpimChannels = new Set<string>();
  const groupChannels = new Set<string>();
  try {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const list = await app.client.conversations.list({
        token: botToken, types: 'im,mpim,public_channel,private_channel', limit: 200, cursor,
      });
      if (!list.ok) throw new Error('Slack conversations unavailable');
      for (const c of (list.channels ?? []) as Array<Record<string, unknown>>) {
        if (typeof c.id !== 'string') continue;
        if (c.is_im === true) { if (!c.is_user_deleted) dmChannels.add(c.id); continue; }
        if (c.is_mpim === true) { mpimChannels.add(c.id); continue; }
        if (c.is_member === true) groupChannels.add(c.id);
      }
      cursor = (list.response_metadata?.next_cursor as string | undefined) || undefined;
      if (cursor && cursors.has(cursor)) throw new Error('Slack conversation pagination repeated');
      if (cursor) cursors.add(cursor);
    } while (cursor);
  } catch (err) {
    logger.warn('Catch-up: could not list conversations — falling back to owner DM only', { err: String(err) });
  }

  if (!isHeartbeat || shouldLogHeartbeatScan()) {
    logger.info('Catch-up: scanning for missed messages', {
      dmCount: dmChannels.size, mpimCount: mpimChannels.size, channelCount: groupChannels.size, sinceMs,
    });
  }

  type CatchUpEntry = { channelId: string; surface: 'dm' | 'mpim' | 'channel' };
  const entries: CatchUpEntry[] = [
    ...[...dmChannels].map(channelId => ({ channelId, surface: 'dm' as const })),
    ...[...mpimChannels].map(channelId => ({ channelId, surface: 'mpim' as const })),
    ...[...groupChannels].map(channelId => ({ channelId, surface: 'channel' as const })),
  ];

  await runWithConcurrency(entries, CATCHUP_SCAN_CONCURRENCY, async ({ channelId, surface }) => {
    if (!await readInternalSlackConversation(app.client, botToken, channelId)) return;
    const opts: CheckOpts = {
      app, profile, botToken, botUserId,
      channelId,
      ownerId: profile.user.slack_user_id,
      oldest,
    };
    // One reply per distinct unread THREAD (owner direction): the same person
    // can have two separate unanswered conversations — a top-level DM and a
    // panel, or two panels — and each is its own thing to answer. We gather an
    // unanswered candidate from every surface, dedup by thread (so a panel
    // parent that also appears as a top-level message isn't answered twice),
    // and replay the latest unanswered message of each thread. (Surface B is
    // discovered from the channel's own Slack history, NOT a registry: the old
    // registry could hold a stale thread_ts and miss a colleague's real panel
    // thread — Ayala's, a long-lived thread the registry didn't have — which is
    // why her message was never recovered on 2026-06-12. A panel parent is a
    // top-level message, so it always surfaces in history; we check its replies.)
    const candidates: UnansweredCandidate[] = [];
    if (surface === 'dm') {
      try {
        for (const parentTs of await discoverThreadParents(app, botToken, channelId, { oldest, includeUnmentioned: true })) {
          try {
            const c = await findUnansweredInThread(opts, parentTs);
            if (c) candidates.push(c);
          } catch (err) {
            logger.warn('Catch-up: per-panel-thread error, continuing', {
              channelId, threadTs: parentTs, err: String(err).slice(0, 200),
            });
          }
        }
      } catch (err) {
        logger.warn('Catch-up: panel discovery threw — continuing', { channelId, err: String(err).slice(0, 200) });
      }
    } else {
      // Channels require explicit mentions; MPIM top-level messages can be
      // naturally addressed and are classified by the existing live gate.
      try {
        const roots = await discoverThreadParents(app, botToken, channelId, { includeMentionsOf: botUserId, oldest, includeUnmentioned: surface === 'mpim' });
        for (const rootTs of roots) {
          try {
            const c = await findUnansweredMentionInThread(opts, rootTs, surface);
            if (c) candidates.push(c);
          } catch (err) {
            logger.warn('Catch-up: per-mention-thread error, continuing', {
              channelId, threadTs: rootTs, err: String(err).slice(0, 200),
            });
          }
        }
      } catch (err) {
        logger.warn('Catch-up: mention discovery threw — continuing', { channelId, err: String(err).slice(0, 200) });
      }
    }
    if (candidates.length === 0) return;
    // Dedup by thread — keep the latest unanswered message per distinct thread,
    // so an overlap (a panel parent surfacing both as a top-level candidate and
    // a thread candidate) is answered once, not twice.
    const byThread = new Map<string, UnansweredCandidate>();
    for (const c of candidates) {
      const existing = byThread.get(c.postThreadTs);
      if (!existing || c.userTs > existing.userTs) byThread.set(c.postThreadTs, c);
    }
    // MPIM group context (participant roster) needs member ids — fetched once
    // per channel, only when there's actually something to reply to.
    let mpimMemberIds: string[] | undefined;
    if (surface === 'mpim' && byThread.size > 0) {
      try {
        const membersRes = await app.client.conversations.members({ token: botToken, channel: channelId });
        mpimMemberIds = ((membersRes.members as string[]) ?? []).filter(id => id !== botUserId);
      } catch (err) {
        logger.warn('Catch-up: could not fetch MPIM members — replying without group context', {
          channelId, err: String(err).slice(0, 200),
        });
      }
    }
    for (const c of byThread.values()) {
      try {
        await replayMissedMessage(opts, c.message, {
          postThreadTs: c.postThreadTs,
          source: c.source,
          isMpim: surface === 'mpim' ? true : undefined,
          isChannel: surface === 'channel' ? true : undefined,
          mpimMemberIds,
        });
      } catch (err) {
        logger.warn('Catch-up: replay error, continuing', { channelId, threadTs: c.postThreadTs, err: String(err).slice(0, 200) });
      }
    }
  });
}

/** A thread's latest unanswered message (top-level DM stream, a panel thread, or a mentioned MPIM/channel thread). */
interface UnansweredCandidate {
  message: Record<string, unknown>;
  postThreadTs: string;
  source: 'dm' | 'assistant_panel' | 'mpim' | 'channel';
  userTs: number;
}

/** Literal Slack @-mention of the bot — structured token, not natural language (W4). */
function mentionsBot(text: unknown, botUserId: string): boolean {
  return typeof text === 'string' && text.includes(`<@${botUserId}>`);
}

/**
 * Traverse top-level history without an oldest cutoff: an old parent may
 * have new replies. Select roots by latest_reply within the gap, plus new
 * directly addressed roots (all human roots for DMs/MPIMs, explicit mentions
 * for channels). Do not silently stop after the first page or ten threads.
 */
async function discoverThreadParents(
  app: App, botToken: string, channelId: string,
  opts?: { includeMentionsOf?: string; oldest?: string; includeUnmentioned?: boolean },
): Promise<string[]> {
  try {
    const parents: string[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
    const res = await app.client.conversations.history({ token: botToken, channel: channelId, limit: 200, cursor });
    if (!res.ok) throw new Error('Slack history unavailable');
    for (const m of (res.messages ?? []) as Array<Record<string, unknown>>) {
      if (typeof m.ts !== 'string') continue;
      const replyCount = typeof m.reply_count === 'number' ? m.reply_count : 0;
      const selfMention = opts?.includeMentionsOf ? mentionsBot(m.text, opts.includeMentionsOf) : false;
      const inGap = !opts?.oldest || Number(m.ts) >= Number(opts.oldest);
      const activeReply = replyCount > 0 && (!opts?.oldest || typeof m.latest_reply !== 'string' || Number(m.latest_reply) >= Number(opts.oldest));
      if (activeReply || (inGap && (selfMention || (opts?.includeUnmentioned && m.user && !m.bot_id)))) parents.push(m.ts);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
    if ((res.has_more && !cursor) || (cursor && cursors.has(cursor))) throw new Error('Slack history pagination incomplete');
    if (cursor) cursors.add(cursor);
    } while (cursor);
    return parents;
  } catch (err) {
    logger.warn('Catch-up: thread discovery unavailable', { channelId, err: String(err).slice(0, 160) });
    return [];
  }
}

interface CheckOpts {
  app: App;
  profile: UserProfile;
  botToken: string;
  botUserId: string;
  channelId: string;
  ownerId: string;
  oldest: string;
}

// v3.2.6 (#122) — assistant-PANEL catch-up. Messages typed in the Slack
// assistant panel are THREAD REPLIES under the panel's assistant thread;
// `conversations.history` (top-level only) never returns them, so the DM scan
// above is structurally blind to the surface the owner actually uses daily.
// Here we pull the panel thread's replies directly and replay the latest
// unanswered one. The (channel, thread_ts) coordinates come from
// discoverThreadParents (registry-free — it reads recent DM history for panel
// parents), so this works without any persisted thread registry.
// Returns a panel thread's latest unanswered user message as a candidate, or
// null. (Was processAssistantThreadIfMissed, which replayed directly.)
async function findUnansweredInThread(opts: CheckOpts, threadTs: string): Promise<UnansweredCandidate | null> {
  const { app, botToken, channelId, botUserId, oldest } = opts;

  let messages: Array<Record<string, unknown>>;
  try {
    messages = await readSlackThread(app.client, botToken, channelId, threadTs, Infinity);
  } catch (err) {
    logger.debug('Catch-up: assistant thread not accessible', { channelId, threadTs });
    return null;
  }

  const latestUserMsg = latestByTs(
    messages,
    m => !!m.user && !m.bot_id && (!m.subtype || m.subtype === 'file_share') && m.user !== botUserId,
  );
  if (!latestUserMsg?.ts) return null;
  if (hasAcknowledgement(latestUserMsg, botUserId)) return null;

  const userTs = parseFloat(latestUserMsg.ts as string);
  if (userTs < parseFloat(oldest)) return null;  // before the gap — leave it

  const latestBotMsg = latestByTs(messages, m => m.user === botUserId);
  const botTs = latestBotMsg?.ts ? parseFloat(latestBotMsg.ts as string) : 0;
  if (userTs <= botTs) return null;  // already answered in the panel

  // Reply target = the panel parent thread.
  return { message: latestUserMsg, postThreadTs: threadTs, source: 'assistant_panel', userTs };
}

// Channel candidates require their own bot mention. MPIM candidates reuse the
// live addressee gate, including active-thread continuation. A later human
// clarification is context, never evidence that Maelle answered. Room media
// remains excluded here; its existing ingestion policies own that surface.
async function findUnansweredMentionInThread(
  opts: CheckOpts, rootTs: string, source: 'mpim' | 'channel',
): Promise<UnansweredCandidate | null> {
  const { app, botToken, channelId, botUserId, oldest } = opts;

  let messages: Array<Record<string, unknown>>;
  try {
    messages = await readSlackThread(app.client, botToken, channelId, rootTs, Infinity);
  } catch {
    return null;  // no access / no history — nothing to discover
  }

  const explicitMention = latestByTs(
    messages,
    m => !!m.user && !m.bot_id && !m.subtype && m.user !== botUserId
      && mentionsBot(m.text, botUserId),
  );
  const latestBot = latestByTs(messages, m => m.user === botUserId);
  // An unanswered explicit request remains authoritative even when followed
  // by a clarification. Replay that request with the current thread context;
  // do not reclassify its last fragment as though the request never existed.
  const pendingMention = explicitMention && !hasAcknowledgement(explicitMention, botUserId)
    && Number(explicitMention.ts) >= Number(oldest)
    && Number(explicitMention.ts) > Number(latestBot?.ts ?? 0);
  const latestMention = source === 'channel' || pendingMention ? explicitMention : latestByTs(
    messages, m => !!m.user && !m.bot_id && !m.subtype && m.user !== botUserId,
  );
  if (!latestMention?.ts) return null;
  if (hasAcknowledgement(latestMention, botUserId)) return null;

  const mentionTs = parseFloat(latestMention.ts as string);
  if (mentionTs < parseFloat(oldest)) return null;  // the mention predates the downtime gap

  const answeredAfter = messages.some(m => m.user === botUserId && typeof m.ts === 'string' && parseFloat(m.ts) > mentionTs);
  if (answeredAfter) return null;  // Maelle already answered

  return { message: latestMention, postThreadTs: rootTs, source, userTs: mentionTs };
}

// An ack reaction is a delivered answer too (postReply's ack replacement).
// Read receipts ('eyes'/'thread') do not complete a turn. Other people's
// reactions, messages and other bots cannot stand in for Maelle's response.
function hasAcknowledgement(message: Record<string, unknown>, botUserId: string): boolean {
  return Array.isArray(message.reactions) && message.reactions.some(r =>
    r && ['+1', 'white_check_mark', 'x'].includes(r.name) && Array.isArray(r.users) && r.users.includes(botUserId));
}

// Newest message matching `pred`, by ts. Order-independent — works for both
// conversations.history (newest-first) and conversations.replies (oldest-first).
function latestByTs(
  messages: Array<Record<string, unknown>>,
  pred: (m: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  let bestTs = -1;
  for (const m of messages) {
    if (typeof m.ts !== 'string' || !pred(m)) continue;
    const t = parseFloat(m.ts);
    if (Number.isFinite(t) && t > bestTs) { bestTs = t; best = m; }
  }
  return best;
}

// Shared replay tail — used by BOTH the DM (history) and assistant-panel
// (replies) catch-up paths. Runs the missed message through the orchestrator
// and posts the reply (threaded per `post.postThreadTs`: the message itself
// for a DM, the panel parent for an assistant thread).
async function replayMissedMessage(
  opts: CheckOpts,
  latestUserMsg: Record<string, unknown>,
  post: {
    postThreadTs: string;
    source: UnansweredCandidate['source'];
    isMpim?: boolean;
    isChannel?: boolean;
    mpimMemberIds?: string[];
  },
): Promise<void> {
  const { profile, channelId } = opts;
  const msgTs = latestUserMsg.ts as string;
  const userTs = parseFloat(msgTs);
  const hoursAgo = Math.round((Date.now() / 1000 - userTs) / 3600);
  logger.info('Catching up missed message', {
    user: profile.user.name,
    channel: channelId,
    source: post.source,
    hoursAgo,
  });

  // v1.8.14 — mark this message ts as processed BEFORE replying, so that if
  // Slack re-delivers the same event to the live socket handler after we
  // reconnect, the live handler sees it as already handled and skips. Prevents
  // catch-up and the live handler both answering the same missed message.
  // markProcessed returns false when this ts was ALREADY marked — which means
  // the live handler ingested it and is mid-flight (slow orchestrator turn,
  // reply not posted to Slack yet, so the answered-check that selected this
  // candidate saw stale botTs). Replaying now would post a SECOND reply. Gate
  // on the return: if the live path already owns this message, skip. (After
  // the 10-min dedup TTL, a genuinely-unanswered message becomes re-markable
  // and a later tick will recover it — so a live turn that marked-then-threw
  // still self-heals.)
  let alreadyOwned = false;
  try {
    const { markProcessed } = require('../connectors/slack/processedDedup') as typeof import('../connectors/slack/processedDedup');
    alreadyOwned = !markProcessed(msgTs);
  } catch (err) {
    logger.warn('catch-up: could not mark ts as processed', { err: String(err) });
  }
  if (alreadyOwned) {
    logger.info('catch-up: msg already owned by the live handler (mid-flight) — skipping replay to avoid double reply', {
      channel: channelId, msgTs,
    });
    return;
  }

  // Route THROUGH the live inbound path (registered by connectors/slack/app)
  // instead of reimplementing transcription / image-ingestion / orchestrator /
  // reply here. Voice & video get transcribed, images downloaded, then the SAME
  // processMessage answers — exactly as a live message would. The replay fn
  // posts only the actual answer; a cosmetic caption must never mark work answered.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getInboundReplay } = require('../connectors/slack/inboundReplayRegistry') as
    typeof import('../connectors/slack/inboundReplayRegistry');
  const replay = getInboundReplay(profile.user.slack_user_id);
  if (!replay) {
    logger.warn('catch-up: no inbound replay registered for profile — skipping', {
      channelId, profileId: profile.user.slack_user_id,
    });
    return;
  }
  try {
    // conversations.history/replies rows don't carry `.channel` — inject it so
    // the live path has the channel context.
    await replay({
      message: { ...latestUserMsg, channel: channelId },
      channelId,
      postThreadTs: post.postThreadTs,
      source: post.source,
      isMpim: post.isMpim,
      isChannel: post.isChannel,
      mpimMemberIds: post.mpimMemberIds,
    });
  } catch (err) {
    logger.error('Catch-up: inbound replay failed', { channelId, err: String(err) });
  }
}
