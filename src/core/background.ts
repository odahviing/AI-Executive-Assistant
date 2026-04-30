import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import { runOrchestrator } from './orchestrator';
import { getConversationHistory, appendToConversation } from '../db';
import { runDueTasks } from '../tasks/runner';
import { materializeRoutineTasks, backfillNullNextRunAt } from '../tasks/routineMaterializer';
import { ensureBriefingCron, updateBriefingCronChannel } from '../tasks/crons';
import { backfillOrphanApprovals } from './approvals/orphanBackfill';
import { backfillOutreachOrphans } from './approvals/outreachOrphanBackfill';
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
  // v1.5.1 — startup-once: recover any waiting_owner coords that never got
  // an approval (pre-v1.5 orphans, lost approvals from earlier bugs). Runs
  // after a small delay so Slack clients are fully warm.
  setTimeout(() => {
    const app = runningApps[0]?.app;
    if (!app) return;
    backfillOrphanApprovals(app, profiles).catch(err =>
      logger.error('Orphan-approval backfill error', { err: String(err) })
    );
    // v2.0.8 — same window: clean up sibling outreach_jobs left behind by
    // coords that booked/cancelled/abandoned BEFORE the v2.0.7 sibling-
    // cleanup in updateCoordJob existed. Also schedules outreach_decision
    // tombstones for any bare no_response rows. Idempotent.
    try {
      backfillOutreachOrphans(profiles);
    } catch (err) {
      logger.error('Outreach-orphan backfill error', { err: String(err) });
    }
  }, 30_000);

  // v1.6.0 — single-pipeline background loop. Every former sweep is now a
  // scheduled task (outreach_send, outreach_expiry, coord_nudge, coord_abandon,
  // approval_expiry, calendar_fix, routine). Materialize first so newly inserted
  // routine tasks are visible to the runner in the same tick.
  setInterval(() => {
    const app = runningApps[0]?.app;
    if (!app) return;
    materializeRoutineTasks(profiles)
      .then(() => runDueTasks(app, profiles))
      .catch(err => logger.error('Routine→task pipeline error', { err: String(err) }));
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
    const social = require('../db/socialTopics') as typeof import('../db/socialTopics');
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

  // v2.2 — Proactive colleague outreach: hourly tick. System activity,
  // owner-time-agnostic. Dispatcher short-circuits when
  // profile.behavior.proactive_colleague_social.enabled is falsy.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require('../db') as typeof import('../db');
    const existing = getDb().prepare(`
      SELECT id FROM tasks
      WHERE type = 'social_outreach_tick'
        AND owner_user_id = ?
        AND status IN ('new', 'scheduled', 'in_progress')
      LIMIT 1
    `).get(profile.user.slack_user_id);
    if (!existing) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createTask } = require('../tasks') as typeof import('../tasks');
      const firstDue = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      createTask({
        owner_user_id: profile.user.slack_user_id,
        owner_channel: dmChannel,
        type: 'social_outreach_tick',
        status: 'new',
        title: 'Proactive colleague outreach tick',
        description: 'Hourly sweep for colleagues in their mid-day window; sends at most one ping per day.',
        due_at: firstDue,
        skill_ref: `social_outreach_tick_${profile.user.slack_user_id}`,
        context: '{}',
        who_requested: 'system',
      });
      logger.info('Social outreach tick seeded', { ownerUserId: profile.user.slack_user_id, firstDue });
    }
  } catch (err) {
    logger.warn('Social outreach tick seeding threw — continuing', { err: String(err) });
  }

  // v1.5.1 — checkMissedBriefing is gone. If today's briefing was missed,
  // the routine's next_run_at is in the past and the materializer will
  // insert a task on the next 5-min tick; the runner's lateness policy
  // decides run-or-skip. No startup special-case needed.

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

  await processIfMissed({
    app, profile, botToken, botUserId,
    channelId: ownerChannel,
    ownerId: profile.user.slack_user_id,
    oldest,
  });
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

  const contextLine = `_↩ Catching up on your message from ${timeLabel}_`;
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
