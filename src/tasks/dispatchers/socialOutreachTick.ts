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
  proactive_pending: number;  // 0 | 1 — anti-spam lock from a prior unanswered ping
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

// v2.2.2 — recency gate. Proactive social only for people interacted with
// in the last 72 hours. Owner direction: don't try to start a social topic
// with someone you haven't actually talked to recently — week+ old contacts
// get pinged cold, which reads transactional, not human.
const RECENT_CONTACT_MS = 72 * 60 * 60 * 1000;

type RejectReason =
  | 'is_owner'
  | 'no_timezone'
  | 'rank_zero'
  | 'pending_lock'
  | 'never_inbound'
  | 'silent_>72h'
  | 'invalid_tz'
  | 'outside_window'
  | 'weekend'
  | 'cooldown'
  | 'active_conversation';

// "Late" reasons are the ones where the person was otherwise eligible and
// only lost on a downstream gate — those names are useful in the log
// ("Lori would have been pinged but she's in cooldown until tomorrow").
// The early reasons (outside_window, never_inbound) are routine bulk drops;
// counting them is enough.
const LATE_DROP_REASONS = new Set<RejectReason>(['cooldown', 'active_conversation']);

interface PickResult {
  pick: CandidateRow | null;
  dropped: Partial<Record<RejectReason, number>>;
  late_drops: Array<{ name: string; reason: RejectReason }>;
}

function lastInboundMs(interactionLog: string): number {
  // 'message_received' = colleague → Maelle, the unambiguous inbound.
  // Outbound and system events don't count as the person initiating.
  try {
    const log = JSON.parse(interactionLog || '[]') as Array<{ date?: string; type?: string }>;
    if (!Array.isArray(log) || log.length === 0) return 0;
    let max = 0;
    for (const entry of log) {
      if (!entry?.date || entry.type !== 'message_received') continue;
      const t = new Date(entry.date).getTime();
      if (Number.isFinite(t) && t > max) max = t;
    }
    return max;
  } catch { return 0; }
}

function classifyRow(
  r: CandidateRow,
  config: ProactiveConfig,
  ownerSlackId: string,
  nowUtc: DateTime,
  activeSet: Set<string>,
): RejectReason | null {
  if (r.slack_id === ownerSlackId) return 'is_owner';
  if (!r.timezone) return 'no_timezone';
  if ((r.engagement_rank ?? 2) <= 0) return 'rank_zero';
  if (r.proactive_pending === 1) return 'pending_lock';

  // v2.3.1 (B18) — real INBOUND history required. Owner direction: "only
  // when they are speaking, the counter starts." Maelle-initiated outbound
  // doesn't qualify a person for proactive outreach.
  const lastInbound = lastInboundMs(r.interaction_log);
  if (!lastInbound) return 'never_inbound';
  if (nowUtc.toMillis() - lastInbound > RECENT_CONTACT_MS) return 'silent_>72h';

  const colleagueLocal = nowUtc.setZone(r.timezone);
  if (!colleagueLocal.isValid) return 'invalid_tz';
  const [startHour, endHour] = config.daily_window_hours;
  if (colleagueLocal.hour < startHour || colleagueLocal.hour >= endHour) return 'outside_window';
  if (!isWorkday(colleagueLocal.weekday, config.skip_weekends)) return 'weekend';

  if (r.last_initiated_at) {
    const cooldownMs = config.cooldown_days * 24 * 60 * 60 * 1000;
    const since = nowUtc.toMillis() - new Date(r.last_initiated_at).getTime();
    if (since < cooldownMs) return 'cooldown';
  }

  if (activeSet.has(r.slack_id)) return 'active_conversation';

  return null;
}

function pickCandidate(
  rows: CandidateRow[],
  config: ProactiveConfig,
  ownerSlackId: string,
  nowUtc: DateTime,
): PickResult {
  // Active-conversation set fetched once up-front so classifyRow stays pure.
  const db = getDb();
  const activeRows = db.prepare(`
    SELECT DISTINCT colleague_slack_id FROM outreach_jobs
    WHERE owner_user_id = ?
      AND status IN ('sent', 'replied')
      AND datetime(created_at) >= datetime('now', '-3 days')
  `).all(ownerSlackId) as Array<{ colleague_slack_id: string }>;
  const activeSet = new Set(activeRows.map(r => r.colleague_slack_id));

  const survivors: CandidateRow[] = [];
  const dropped: Partial<Record<RejectReason, number>> = {};
  const lateDrops: Array<{ name: string; reason: RejectReason }> = [];

  for (const r of rows) {
    const reason = classifyRow(r, config, ownerSlackId, nowUtc, activeSet);
    if (reason === null) {
      survivors.push(r);
      continue;
    }
    dropped[reason] = (dropped[reason] ?? 0) + 1;
    if (LATE_DROP_REASONS.has(reason)) lateDrops.push({ name: r.name, reason });
  }

  if (survivors.length === 0) return { pick: null, dropped, late_drops: lateDrops };

  // Round-robin: rank desc, then "longest since Maelle last pinged" ascending.
  survivors.sort((a, b) => {
    if (b.engagement_rank !== a.engagement_rank) return b.engagement_rank - a.engagement_rank;
    const aTs = a.last_initiated_at ? new Date(a.last_initiated_at).getTime() : 0;
    const bTs = b.last_initiated_at ? new Date(b.last_initiated_at).getTime() : 0;
    return aTs - bTs;
  });

  return { pick: survivors[0], dropped, late_drops: lateDrops };
}

// v2.3.1 (B17) — discovery question pool. Used when the person has zero
// active social topics. Owner direction: "if no topic, make an open question
// that helps discover one." Pool is intentionally generic + invites a
// non-trivial reply (not a yes/no closer). Keep additions to short, friendly
// open-ended questions a real EA might ask in a hallway.
const DISCOVERY_QUESTIONS = [
  'any cool plans for the weekend?',
  'just curious — any hobbies you\'re into outside of work?',
  'anything fun you\'ve been watching or reading lately?',
  'how was the weekend?',
  'any travel coming up?',
  'what\'s been keeping you busy lately outside the office?',
  'any new music or shows you\'d recommend?',
  'how\'s the family / pets / home stuff going?',
  'discovered any good places to eat lately?',
  'anything you\'ve been geeking out about recently?',
  'any sports or teams you\'re following?',
  'how\'s your week going so far?',
  'doing anything fun this evening?',
  'what\'s the best part of your week been?',
  'planning anything for the upcoming weekend?',
];

async function generatePing(params: {
  anthropic: Anthropic;
  ownerName: string;
  colleagueName: string;
  colleagueSlackId: string;
  recentNotes: string[];
}): Promise<string | null> {
  // v2.3.1 (B17) — pull this person's active social topics so Sonnet can
  // follow up on something real (the categories+topics already capture what
  // they've talked about with Maelle/owner). Owner direction: "share JSON
  // of current topic interactions and let Sonnet choose for it."
  let activeTopics: Array<{ category: string; topic: string; engagement_score: number; last_touched: string | null }> = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAllTopicsForPerson } = require('../../db/socialTopics') as typeof import('../../db/socialTopics');
    const rows = getAllTopicsForPerson(params.colleagueSlackId);
    activeTopics = rows.map(r => ({
      category: r.category_id,
      topic: r.label,
      engagement_score: r.engagement_score,
      last_touched: r.last_touched_at,
    }));
  } catch (err) {
    logger.warn('generatePing — getAllTopicsForPerson threw, proceeding without topics', {
      err: String(err).slice(0, 120),
    });
  }

  // Pick 3 random discovery questions for the fallback pool.
  const fallbackPool = (() => {
    const shuffled = [...DISCOVERY_QUESTIONS].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 3);
  })();

  const prompt = `You're Maelle, ${params.ownerName}'s executive assistant. You're casually checking in on ${params.colleagueName} — like a friendly teammate, NOT to do work. One short sentence.

ABSOLUTE RULES — do NOT break:
- This is a SOCIAL ping. NEVER ask about meetings, scheduling, syncs, projects, tasks, work updates, deadlines, "are we still on for…", "all set for…", or anything work-related. The whole point is non-task conversation.
- One short sentence, friendly, no more.
- Use ${params.colleagueName}'s first name.
- Never mention ${params.ownerName} unless natural to the topic.
- No emoji unless prior context strongly indicates the colleague uses them.
- No "sorry to bother", "just wanted to reach out", "hope I'm not interrupting" — get to it.

HOW TO PICK WHAT TO ASK:
1. ACTIVE TOPICS — if ${params.colleagueName} has any active social topics (below), prefer following up on the freshest one with a real question. Example: topic "marathon training" → "how's the marathon training going?". Topic "kitchen reno" → "kitchen reno still in progress, or done?".
2. PERSONAL NOTES — second priority. If notes mention something concrete worth asking about (a hobby, a recent trip), ask about that.
3. DISCOVERY FALLBACK — if neither of the above gives something real, pick ONE from this discovery pool (don't invent a fake topic):
${fallbackPool.map(q => `   - "${q}"`).join('\n')}

Active social topics for ${params.colleagueName} (JSON):
${JSON.stringify(activeTopics, null, 2)}

Personal notes on ${params.colleagueName}:
${params.recentNotes.length > 0 ? params.recentNotes.slice(-3).map(s => `  - ${s}`).join('\n') : '  (no notes)'}`;

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

  // v2.3.1 (B10 / #66) — persona-off + disabled checks moved OUT of the
  // try-finally block. The finally re-schedules unconditionally; before
  // this fix, returning early from the try still ran the finally, so
  // disabling proactive social didn't actually stop the tick — the loop
  // re-spawned itself every hour. Now: kill the loop cleanly, complete
  // the task so it doesn't sit in the queue.
  const personaActive = (profile.skills as any)?.persona === true;
  if (!personaActive) {
    logger.debug('social_outreach_tick skipped — persona skill off (loop terminates)', {
      ownerUserId: profile.user.slack_user_id,
    });
    completeTask(task.id);
    return;
  }
  if (!cfg.enabled) {
    logger.debug('social_outreach_tick skipped — disabled in profile (loop terminates)', {
      ownerUserId: profile.user.slack_user_id,
    });
    completeTask(task.id);
    return;
  }

  try {
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
             interaction_log, notes, profile_json, proactive_pending
      FROM people_memory
    `).all() as CandidateRow[];

    const nowUtc = DateTime.utc();
    const { pick, dropped, late_drops } = pickCandidate(rows, cfg, profile.user.slack_user_id, nowUtc);
    if (!pick) {
      // Steady-state outcome 22h/day for an all-IL contact list — debug only.
      // `dropped` shows the reason breakdown so "why is nobody being pinged"
      // is answerable from one log line; `late_drops` names the people who
      // were otherwise eligible and lost on cooldown / active-conversation
      // (the interesting near-misses).
      logger.debug('social_outreach_tick no eligible candidate this hour', {
        ownerUserId: profile.user.slack_user_id,
        total_rows: rows.length,
        dropped,
        ...(late_drops.length > 0 ? { late_drops } : {}),
      });
      return;
    }

    const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const notes: string[] = (() => {
      try { return (JSON.parse(pick.notes || '[]') as Array<{ note?: string }>).map(n => n.note || '').filter(Boolean); } catch { return []; }
    })();

    // v2.3.1 (B17) — interaction_log dropped from ping inputs. Owner direction:
    // social topics + personal notes are the right inputs; recent activity log
    // (often work-related) was steering Sonnet toward task-shaped pings.
    const message = await generatePing({
      anthropic,
      ownerName: profile.user.name,
      colleagueName: pick.name,
      colleagueSlackId: pick.slack_id,
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

    // Update people_memory last_social_at + last_initiated_at + flip the
    // anti-spam lock on. Cleared next time the person sends an inbound message.
    db.prepare(`
      UPDATE people_memory
      SET last_social_at    = datetime('now'),
          last_initiated_at = datetime('now'),
          proactive_pending = 1,
          updated_at        = datetime('now')
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
