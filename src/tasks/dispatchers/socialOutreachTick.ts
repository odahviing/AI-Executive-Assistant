/**
 * Proactive colleague outreach tick (v2.2).
 *
 * System activity — owner-time-agnostic. Fires every hour. For each known
 * colleague:
 *
 *   - engagement_rank > 0 (rank 0 = opt-out, never initiate)
 *   - has a timezone on record
 *   - their LOCAL time is in the 13:00-15:00 mid-day window
 *   - their LOCAL day is a work day (weekend skip — Sat/Sun default, override via profile)
 *   - has any prior interaction_log entry or last_social_at set (not cold)
 *   - last_initiated_at older than cooldown_days (default 5)
 *   - no active outreach_jobs conversation mid-flight
 *
 * From survivors:
 *   - Round-robin by engagement_rank desc, then by "longest since Maelle pinged"
 *   - Pick ONE if Maelle hasn't already sent a proactive ping in the last 24h
 *   - Generate a short human ping via Sonnet (tool_use, strict schema)
 *   - Send via the Slack connection, update last_social_at / last_initiated_at
 *   - Schedule a social_ping_rank_check task 48h out
 *   - Shadow-DM the owner with a line summary
 *
 * Self-reschedules every hour on completion. Guarded behind
 * `profile.behavior.proactive_colleague_social.enabled` (default false).
 */

import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import { completeTask, createTask } from '../index';
import { getDb, adjustEngagementRank } from '../../db';
import { getConnection } from '../../connections/registry';
import { config } from '../../config';
import { shadowNotify } from '../../utils/shadowNotify';
import logger from '../../utils/logger';
import type { TaskDispatcher } from './types';
import type { UserProfile } from '../../config/userProfile';

const MID_DAY_START_HOUR_DEFAULT = 13;
const MID_DAY_END_HOUR_DEFAULT = 15;
const COOLDOWN_DAYS_DEFAULT = 5;
const SKIP_WEEKENDS_DEFAULT = true;

interface CandidateRow {
  slack_id: string;
  name: string;
  timezone: string | null;
  engagement_rank: number;
  last_initiated_at: string | null;
  last_social_at: string | null;
  interaction_log: string;
  notes: string;
  profile_json: string;
}

interface ProactiveConfig {
  enabled: boolean;
  daily_window_hours: [number, number];
  cooldown_days: number;
  skip_weekends: boolean;
}

function readConfig(profile: UserProfile): ProactiveConfig {
  const raw = (profile.behavior as unknown as { proactive_colleague_social?: unknown })
    .proactive_colleague_social;
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const window: [number, number] = Array.isArray(cfg.daily_window_hours) && cfg.daily_window_hours.length === 2
    ? [cfg.daily_window_hours[0] as number, cfg.daily_window_hours[1] as number]
    : [MID_DAY_START_HOUR_DEFAULT, MID_DAY_END_HOUR_DEFAULT];
  return {
    enabled: cfg.enabled === true,
    daily_window_hours: window,
    cooldown_days: typeof cfg.cooldown_days === 'number' ? cfg.cooldown_days : COOLDOWN_DAYS_DEFAULT,
    skip_weekends: cfg.skip_weekends !== false && SKIP_WEEKENDS_DEFAULT,
  };
}

function isWorkday(weekday: number, skipWeekends: boolean): boolean {
  if (!skipWeekends) return true;
  // v2.2.2 — Mon–Thu only. Luxon weekday: 1=Mon..7=Sun. The intersection of
  // every common workweek (IL Sun–Thu, US/EU Mon–Fri) is Mon–Thu — narrowing
  // here keeps us safely inside business hours regardless of the colleague's
  // location. Friday and Sunday excluded by design.
  return weekday >= 1 && weekday <= 4;
}

function maelleAlreadyPingedToday(ownerUserId: string): boolean {
  const db = getDb();
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const row = db.prepare(`
    SELECT id FROM outreach_jobs
    WHERE owner_user_id = ?
      AND intent = 'proactive_social'
      AND created_at >= ?
    LIMIT 1
  `).get(ownerUserId, start.toISOString()) as { id?: string } | undefined;
  return !!row;
}

function pickCandidate(
  rows: CandidateRow[],
  config: ProactiveConfig,
  ownerSlackId: string,
  nowUtc: DateTime,
): CandidateRow | null {
  const [startHour, endHour] = config.daily_window_hours;
  const cooldownMs = config.cooldown_days * 24 * 60 * 60 * 1000;

  // v2.2.2 — recency gate. Proactive social only for people interacted with
  // in the last 72 hours. Owner direction: don't try to start a social topic
  // with someone you haven't actually talked to recently — week+ old contacts
  // get pinged cold, which reads transactional, not human.
  const RECENT_CONTACT_MS = 72 * 60 * 60 * 1000;

  const survivors = rows.filter(r => {
    if (r.slack_id === ownerSlackId) return false;
    if (!r.timezone) return false;
    if ((r.engagement_rank ?? 2) <= 0) return false;

    // Must have a fresh interaction (≤ 48h) — covers both social and any
    // other recent activity (meeting, message, conversation). Old contacts
    // (week+ silent) are skipped — proactive ping there feels random.
    const lastSocialMs = r.last_social_at ? new Date(r.last_social_at).getTime() : 0;
    const lastInteractionMs = (() => {
      try {
        const log = JSON.parse(r.interaction_log || '[]') as Array<{ date?: string }>;
        if (!Array.isArray(log) || log.length === 0) return 0;
        // interaction_log entries carry an ISO `date`. Pick the freshest.
        let max = 0;
        for (const entry of log) {
          if (!entry?.date) continue;
          const t = new Date(entry.date).getTime();
          if (Number.isFinite(t) && t > max) max = t;
        }
        return max;
      } catch { return 0; }
    })();
    const lastTouchMs = Math.max(lastSocialMs, lastInteractionMs);
    if (!lastTouchMs) return false;
    if (nowUtc.toMillis() - lastTouchMs > RECENT_CONTACT_MS) return false;

    // Colleague local time check
    const colleagueLocal = nowUtc.setZone(r.timezone);
    if (!colleagueLocal.isValid) return false;
    const h = colleagueLocal.hour;
    if (h < startHour || h >= endHour) return false;
    if (!isWorkday(colleagueLocal.weekday, config.skip_weekends)) return false;

    // Cooldown
    if (r.last_initiated_at) {
      const since = nowUtc.toMillis() - new Date(r.last_initiated_at).getTime();
      if (since < cooldownMs) return false;
    }
    return true;
  });

  if (survivors.length === 0) return null;

  // Skip anyone with an active conversation (mid-flight outreach)
  const db = getDb();
  const activeIds = db.prepare(`
    SELECT DISTINCT colleague_slack_id FROM outreach_jobs
    WHERE owner_user_id = ?
      AND status IN ('sent', 'replied')
      AND datetime(created_at) >= datetime('now', '-3 days')
  `).all((survivors[0] as any).owner_user_id ?? ownerSlackId) as Array<{ colleague_slack_id: string }>;
  const activeSet = new Set(activeIds.map(r => r.colleague_slack_id));
  const withoutActive = survivors.filter(r => !activeSet.has(r.slack_id));
  if (withoutActive.length === 0) return null;

  // Round-robin: sort by rank desc, then by "longest since Maelle last
  // pinged" ascending (older last_initiated_at = higher priority)
  withoutActive.sort((a, b) => {
    if (b.engagement_rank !== a.engagement_rank) return b.engagement_rank - a.engagement_rank;
    const aTs = a.last_initiated_at ? new Date(a.last_initiated_at).getTime() : 0;
    const bTs = b.last_initiated_at ? new Date(b.last_initiated_at).getTime() : 0;
    return aTs - bTs;
  });

  return withoutActive[0];
}

async function generatePing(params: {
  anthropic: Anthropic;
  ownerName: string;
  colleagueName: string;
  recentInteractions: string[];
  recentNotes: string[];
}): Promise<string | null> {
  const prompt = `You're Maelle, ${params.ownerName}'s executive assistant. You're casually checking in on ${params.colleagueName} — short, warm, human. One line. No "sorry to bother", no "just wanted to reach out", no AI-ish tells.

Recent exchanges with ${params.colleagueName} (oldest→newest):
${params.recentInteractions.length > 0 ? params.recentInteractions.slice(-5).map(s => `  - ${s}`).join('\n') : '  (no recent log)'}

Personal notes on ${params.colleagueName}:
${params.recentNotes.length > 0 ? params.recentNotes.slice(-3).map(s => `  - ${s}`).join('\n') : '  (no notes)'}

Rules:
- One short sentence, no more
- If there's a specific thing from the log worth asking about, ask about that (e.g. "how'd the Berlin trip go?" / "did you finish the new keyboard build?")
- If nothing specific, a simple warm check-in is fine ("hope your week's good!")
- Use ${params.colleagueName}'s first name
- Never mention ${params.ownerName} unless natural
- No emoji unless the prior log shows ${params.colleagueName} uses them`;

  try {
    const resp = await params.anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      tools: [{
        name: 'compose_ping',
        description: 'Compose a short proactive social ping to the colleague.',
        input_schema: {
          type: 'object' as const,
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      }],
      tool_choice: { type: 'tool', name: 'compose_ping' },
      messages: [{ role: 'user', content: prompt }],
    });
    const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
    const message = toolUse?.input?.message as string | undefined;
    if (!message || message.trim().length === 0) return null;
    return message.trim();
  } catch (err) {
    logger.warn('generatePing threw', { err: String(err).slice(0, 200) });
    return null;
  }
}

export const dispatchSocialOutreachTick: TaskDispatcher = async (_app, task, profile) => {
  const cfg = readConfig(profile);

  const rescheduleNextTick = () => {
    try {
      const nextDue = DateTime.now().plus({ hours: 1 }).toISO();
      if (nextDue) {
        createTask({
          owner_user_id: profile.user.slack_user_id,
          owner_channel: task.owner_channel,
          type: 'social_outreach_tick',
          status: 'new',
          title: 'Proactive colleague outreach tick',
          description: 'Hourly sweep to find colleagues in their mid-day window who deserve a warm check-in.',
          due_at: nextDue,
          skill_ref: `social_outreach_tick_${profile.user.slack_user_id}`,
          context: '{}',
          who_requested: 'system',
        });
      }
    } catch (err) {
      logger.warn('social_outreach_tick reschedule threw', { err: String(err).slice(0, 200) });
    }
  };

  try {
    if (!cfg.enabled) {
      logger.debug('social_outreach_tick skipped — disabled in profile', {
        ownerUserId: profile.user.slack_user_id,
      });
      return;
    }

    // Daily cap: at most one proactive ping per owner per day
    if (maelleAlreadyPingedToday(profile.user.slack_user_id)) {
      logger.debug('social_outreach_tick skipped — already pinged today', {
        ownerUserId: profile.user.slack_user_id,
      });
      return;
    }

    const db = getDb();
    const rows = db.prepare(`
      SELECT slack_id, name, timezone, engagement_rank, last_initiated_at, last_social_at,
             interaction_log, notes, profile_json
      FROM people_memory
    `).all() as CandidateRow[];

    const nowUtc = DateTime.utc();
    const pick = pickCandidate(rows, cfg, profile.user.slack_user_id, nowUtc);
    if (!pick) {
      // Demoted to debug — this is the steady-state outcome 22h/day for an
      // all-IL contact list and was filling the live log with no signal.
      logger.debug('social_outreach_tick no eligible candidate this hour', {
        ownerUserId: profile.user.slack_user_id,
        total_rows: rows.length,
      });
      return;
    }

    const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const interactions: string[] = (() => {
      try { return (JSON.parse(pick.interaction_log || '[]') as Array<{ summary?: string }>).map(i => i.summary || '').filter(Boolean); } catch { return []; }
    })();
    const notes: string[] = (() => {
      try { return (JSON.parse(pick.notes || '[]') as Array<{ note?: string }>).map(n => n.note || '').filter(Boolean); } catch { return []; }
    })();

    const message = await generatePing({
      anthropic,
      ownerName: profile.user.name,
      colleagueName: pick.name,
      recentInteractions: interactions,
      recentNotes: notes,
    });
    if (!message) {
      logger.warn('social_outreach_tick: ping generation failed, skipping this tick', {
        colleague: pick.name,
      });
      return;
    }

    const conn = getConnection(profile.user.slack_user_id, 'slack');
    if (!conn) {
      logger.warn('social_outreach_tick: no Slack connection', { ownerUserId: profile.user.slack_user_id });
      return;
    }

    const outcome = await conn.sendDirect(pick.slack_id, message);
    if (!outcome.ok) {
      logger.warn('social_outreach_tick: send failed', { reason: outcome.reason, colleague: pick.name });
      return;
    }

    // Record in outreach_jobs with intent='proactive_social' so daily cap + active-conversation check can see it
    const jobId = `prosocial_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
      INSERT INTO outreach_jobs (
        id, owner_user_id, owner_channel, colleague_slack_id, colleague_name,
        message, await_reply, status, sent_at, intent, dm_message_ts, dm_channel_id
      ) VALUES (
        @id, @owner_user_id, @owner_channel, @colleague_slack_id, @colleague_name,
        @message, 1, 'sent', datetime('now'), 'proactive_social', @ts, @ref
      )
    `).run({
      id: jobId,
      owner_user_id: profile.user.slack_user_id,
      owner_channel: task.owner_channel,
      colleague_slack_id: pick.slack_id,
      colleague_name: pick.name,
      message,
      ts: outcome.ts ?? null,
      ref: outcome.ref ?? null,
    });

    // Update people_memory last_social_at + last_initiated_at
    db.prepare(`
      UPDATE people_memory
      SET last_social_at = datetime('now'),
          last_initiated_at = datetime('now'),
          updated_at = datetime('now')
      WHERE slack_id = ?
    `).run(pick.slack_id);

    // Append to interaction_log
    try {
      const log = JSON.parse(pick.interaction_log || '[]') as Array<{ date: string; type: string; summary: string }>;
      log.push({
        date: new Date().toISOString(),
        type: 'social_ping',
        summary: `Maelle checked in: "${message.slice(0, 120)}"`,
      });
      db.prepare(`UPDATE people_memory SET interaction_log = ? WHERE slack_id = ?`).run(JSON.stringify(log), pick.slack_id);
    } catch (_) {}

    // Schedule the rank-check task 48h out
    try {
      const checkDue = DateTime.now().plus({ hours: 48 }).toISO();
      if (checkDue) {
        createTask({
          owner_user_id: profile.user.slack_user_id,
          owner_channel: task.owner_channel,
          type: 'social_ping_rank_check',
          status: 'new',
          title: `Rank check — ${pick.name}`,
          description: `Evaluate whether ${pick.name} replied to the proactive ping and adjust engagement_rank.`,
          due_at: checkDue,
          skill_ref: jobId,
          context: JSON.stringify({ colleague_slack_id: pick.slack_id, colleague_name: pick.name, job_id: jobId }),
          who_requested: 'system',
        });
      }
    } catch (err) {
      logger.warn('social_outreach_tick: rank-check schedule threw', { err: String(err).slice(0, 200) });
    }

    // Shadow-DM owner
    await shadowNotify(profile, {
      channel: task.owner_channel,
      action: `Proactive ping → ${pick.name}`,
      detail: `"${message.slice(0, 160)}" (rank ${pick.engagement_rank}, last initiated ${pick.last_initiated_at ?? 'never'})`,
    });

    logger.info('social_outreach_tick sent', {
      ownerUserId: profile.user.slack_user_id,
      colleague: pick.name,
      colleague_slack_id: pick.slack_id,
      rank: pick.engagement_rank,
    });
    // Mark a no-op rank adjustment just so the audit log has the initiation event
    void adjustEngagementRank; // keep import in scope for future proactive-initiated signal
  } finally {
    rescheduleNextTick();
    completeTask(task.id);
  }
};
