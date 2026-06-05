import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import { runOrchestrator } from './orchestrator';
import { getConversationHistory, appendToConversation } from '../db';
import { runDueTasks } from '../tasks/runner';
import { materializeRoutineTasks, backfillNullNextRunAt } from '../tasks/routineMaterializer';
import { ensureBriefingCron, updateBriefingCronChannel } from '../tasks/crons';
import logger from '../utils/logger';

// v1.5.1 — tightened scope: DM only, 24h window, reply in thread, last unread
// message only. No more "I was offline" prompt injection hack.
const LOOKBACK_HOURS = 24;

// ── Background timer ─────────────────────────────────────────────────────────

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
  setInterval(() => {
    const app = runningApps[0]?.app;
    if (!app) return;
    materializeRoutineTasks(profiles)
      .then(() => runDueTasks(app, profiles))
      .catch(err => logger.error('Routine→task pipeline error', { err: String(err) }));

    // v3.1 (Path 2 Stage 8) — requests-spine reconciliation + retention. Closes
    // any open coord request whose backing coord_job went terminal or was
    // deleted out from under it (the ghost the owner hit: "deleted the orphan
    // tasks, it's still here"). Then prunes old terminal rows so the spine
    // stays lean. Fire-and-forget; never blocks the task pipeline.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { reconcileOrphanedRequests, pruneOldTerminalRequests } =
        require('./requests/reconcile') as typeof import('./requests/reconcile');
      let reconciled = 0;
      for (const profile of profiles.values()) {
        reconciled += reconcileOrphanedRequests(profile.user.slack_user_id);
      }
      const pruned = pruneOldTerminalRequests();
      if (reconciled > 0 || pruned > 0) {
        logger.info('Requests-spine maintenance', { reconciled, pruned });
      }
    } catch (err) {
      logger.warn('Requests-spine maintenance threw — non-fatal', { err: String(err).slice(0, 200) });
    }

    // Capture pass runs independently — its errors should never affect the
    // routine pipeline. Per-profile loop because the capture state
    // (people_memory, .md files) is owner-scoped.
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { runCapturePass } = require('../memory/capturePass') as typeof import('../memory/capturePass');
      for (const profile of profiles.values()) {
        try {
          await runCapturePass(app, profile);
        } catch (err) {
          logger.warn('runCapturePass threw — continuing', {
            ownerUserId: profile.user.slack_user_id,
            err: String(err).slice(0, 200),
          });
        }
      }
    })();
  }, 5 * 60 * 1000);
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

  // v2.2 — Social Engine: ensure a social_decay task exists. Self-perpetuating
  // cadence — the dispatcher reschedules itself 7 days out on completion.
  // We only need to plant the seed once. Idempotent via skill_ref uniqueness
  // (the dispatcher won't create a duplicate if one is already pending).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require('../db') as typeof import('../db');
    const existing = getDb().prepare(`
      SELECT id FROM tasks
      WHERE type = 'social_decay'
        AND owner_user_id = ?
        AND status IN ('new', 'scheduled', 'in_progress')
      LIMIT 1
    `).get(profile.user.slack_user_id);
    if (!existing) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createTask } = require('../tasks') as typeof import('../tasks');
      const firstDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      createTask({
        owner_user_id: profile.user.slack_user_id,
        owner_channel: dmChannel,
        type: 'social_decay',
        status: 'new',
        title: 'Social weekly decay pass',
        description: 'System maintenance — decays active topics untouched 7+ days.',
        due_at: firstDue,
        skill_ref: `social_decay_${profile.user.slack_user_id}`,
        context: '{}',
        who_requested: 'system',
      });
      logger.info('Social decay task seeded', { ownerUserId: profile.user.slack_user_id, firstDue });
    }
  } catch (err) {
    logger.warn('Social decay task seeding threw — continuing', { err: String(err) });
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

  // Catch up on any messages sent while the bot was offline
  await catchUpMissedMessages(app, profile, dmChannel);
}

// ── Catch-up on missed messages ──────────────────────────────────────────────

/**
 * On startup: scan the owner's 1:1 DM for messages that arrived while the bot
 * was offline and never got a reply.
 *
 * v1.5.1 rules (tighter than v1.5):
 *   - DM ONLY (the owner's 1:1 with Maelle). No MPIMs.
 *   - 24h lookback (was 48h).
 *   - Only the LAST unread user message is replied to.
 *   - Reply is posted as a thread reply under that message — never top-level.
 *   - No more "[Context: you were offline...]" prompt injection hack; the
 *     orchestrator sees the raw message. The context block on the posted
 *     reply ("↩ Catching up on your message from Xh ago") tells the owner
 *     what they're looking at.
 */
async function catchUpMissedMessages(
  app: App,
  profile: UserProfile,
  ownerChannel: string,
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

  const oldest = String((Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000) / 1000);

  // v3.2.x — scan ALL the bot's 1:1 DMs, not just the owner's. The old scope
  // was owner-DM-only, so after an outage every colleague message sent while
  // the bot was down was silently dropped (the 2026-06-04 all-day crash: she
  // came back up and answered nobody). processIfMissed replies to at most the
  // ONE latest-unanswered message per DM, so this stays bounded to ≤1 reply
  // per conversation even across a long outage.
  const channels = new Set<string>([ownerChannel]);
  try {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const list = await app.client.conversations.list({
        token: botToken, types: 'im', limit: 200, cursor,
      });
      for (const c of (list.channels ?? []) as Array<Record<string, unknown>>) {
        if (typeof c.id === 'string' && !c.is_user_deleted) channels.add(c.id);
      }
      cursor = (list.response_metadata?.next_cursor as string | undefined) || undefined;
      pages++;
    } while (cursor && pages < 5);
  } catch (err) {
    logger.warn('Catch-up: could not list DMs — falling back to owner DM only', { err: String(err) });
  }

  logger.info('Catch-up: scanning DMs for missed messages', { dmCount: channels.size });
  for (const channelId of channels) {
    try {
      await processIfMissed({
        app, profile, botToken, botUserId,
        channelId,
        ownerId: profile.user.slack_user_id,
        oldest,
      });
    } catch (err) {
      logger.warn('Catch-up: per-DM error, continuing', { channelId, err: String(err).slice(0, 200) });
    }
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

async function processIfMissed(opts: CheckOpts): Promise<void> {
  const { app, profile, botToken, botUserId, channelId, ownerId, oldest } = opts;

  let messages: Array<Record<string, unknown>>;
  try {
    const result = await app.client.conversations.history({
      token: botToken,
      channel: channelId,
      oldest,
      limit: 200,
    });
    messages = (result.messages ?? []) as Array<Record<string, unknown>>;
  } catch (err) {
    logger.debug('Catch-up: skipping channel (no access)', { channelId });
    return;
  }

  // DM-only catch-up — no mention gating; any user message in the 1:1 DM counts.
  const latestUserMsg = messages.find(m => {
    if (!m.user || m.bot_id || m.subtype) return false;
    return true;
  });

  if (!latestUserMsg?.ts) return;

  const userTs = parseFloat(latestUserMsg.ts as string);

  const latestBotMsg = messages.find(m => m.bot_id || m.user === botUserId);
  const botTs = latestBotMsg?.ts ? parseFloat(latestBotMsg.ts as string) : 0;
  if (userTs <= botTs) return;

  const msgTs = latestUserMsg.ts as string;
  try {
    const replies = await app.client.conversations.replies({
      token: botToken,
      channel: channelId,
      ts: msgTs,
      limit: 20,
    });
    const botThreadReply = (replies.messages ?? []).find(
      m => (m.bot_id || m.user === botUserId) && parseFloat(m.ts as string) > userTs
    );
    if (botThreadReply) return;
  } catch {
    // No replies or no access — proceed with catchup
  }

  const hoursAgo = Math.round((Date.now() / 1000 - userTs) / 3600);
  logger.info('Catching up missed message', {
    user: profile.user.name,
    channel: channelId,
    hoursAgo,
  });

  // v1.8.14 — mark this message ts as processed BEFORE replying, so that if
  // Slack re-delivers the same event to the live socket handler after we
  // reconnect, the live handler will see it as already handled and skip.
  // Prevents the duplicate-reply bug where catch-up and live handler both
  // answer the same missed message.
  try {
    const { markProcessed } = require('../connectors/slack/processedDedup') as typeof import('../connectors/slack/processedDedup');
    markProcessed(msgTs);
  } catch (err) {
    logger.warn('catch-up: could not mark ts as processed', { err: String(err) });
  }

  const senderId  = latestUserMsg.user as string;
  const rawText   = (latestUserMsg.text as string) ?? '';
  const threadTs  = (latestUserMsg.thread_ts as string | undefined) ?? (latestUserMsg.ts as string);
  const senderRole: 'owner' | 'colleague' = senderId === ownerId ? 'owner' : 'colleague';

  const timeLabel = hoursAgo < 1 ? 'less than an hour ago' : `about ${hoursAgo}h ago`;

  // v1.5.1 — the raw message goes to the orchestrator unchanged. The catch-up
  // framing lives only in the posted reply's context block (below), not in the
  // prompt. The old "[Context: you were offline...]" injection regularly
  // produced over-apologetic or confused replies because the LLM would
  // interpret it as owner instructions rather than scaffolding.
  const history = getConversationHistory(threadTs);

  let output;
  try {
    output = await runOrchestrator({
      userMessage: rawText,
      conversationHistory: history,
      threadTs,
      channelId,
      userId: senderId,
      senderRole,
      channel: 'slack',
      profile,
      app,
    });
  } catch (err) {
    logger.error('Catch-up: orchestrator failed', { channelId, err: String(err) });
    return;
  }

  appendToConversation(threadTs, channelId, { role: 'user', content: rawText });
  appendToConversation(threadTs, channelId, { role: 'assistant', content: output.reply });

  const contextLine = `_↩️ Catching up on your message from ${timeLabel}_`;
  const msgPreviewShort = rawText.slice(0, 60) + (rawText.length > 60 ? '…' : '');

  // Run through the Slack outbound formatter (scrubs internal leakage + applies
  // Slack's markdown dialect). Same helper the live handler uses.
  const { formatForSlack } = await import('../connections/slack/formatting');
  const cleanReply = formatForSlack(output.reply);

  // NOTE (v2.0.2): this is the single remaining core-path raw Slack call.
  // It uses Slack-specific rich-layout blocks (`context` + `section`) to render
  // the "↩ Catching up on your message from <time>" caption above the reply,
  // and the Connection interface doesn't (yet) carry a blocks payload. Kept
  // as a direct app.client call until the Connection interface grows a
  // transport-specific rich-payload option — tracked under issue #22.
  try {
    await app.client.chat.postMessage({
      token: profile.assistant.slack.bot_token,
      channel: channelId,
      thread_ts: latestUserMsg.ts as string,
      text: cleanReply,
      blocks: [
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `${contextLine}: _"${msgPreviewShort}"_` }],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: cleanReply },
        },
      ],
    });
  } catch (err) {
    logger.error('Catch-up: failed to post reply', { channelId, err: String(err) });
  }
}
