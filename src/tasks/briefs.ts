import Anthropic from '@anthropic-ai/sdk';
import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import { config } from '../config';
import { getUnseenEvents, markEventsSeen, getDb, getPreferences } from '../db';
import { getOpenTasksForOwner, getCompletedUninformedTasks, markTaskInformed } from './index';
import logger from '../utils/logger';

// ── Relative time helper ──────────────────────────────────────────────────────

function relativeTime(isoStr: string | undefined, timezone: string): string {
  if (!isoStr) return 'recently';
  const dt  = DateTime.fromISO(isoStr).setZone(timezone);
  const now = DateTime.now().setZone(timezone);
  const diffDays = now.startOf('day').diff(dt.startOf('day'), 'days').days;

  if (diffDays < 0.5) return 'today';
  if (diffDays < 1.5) return 'yesterday';
  if (diffDays < 2.5) return 'two days ago';
  if (diffDays < 3.5) return 'three days ago';
  return dt.toFormat('EEEE');  // "Monday"
}

// ── Collect rich briefing data ────────────────────────────────────────────────

interface RichItem {
  kind: string;
  [key: string]: unknown;
}

interface BriefingData {
  items: RichItem[];
  outreachIds: string[];
  coordIds: string[];
}

function collectBriefingData(ownerUserId: string, timezone: string): BriefingData {
  const db = getDb();
  const items: RichItem[] = [];
  const outreachIds: string[] = [];
  const coordIds: string[] = [];

  const sevenDaysAgo = DateTime.now().minus({ days: 7 }).toUTC().toISO()!;

  // ── Outreach jobs ──────────────────────────────────────────────────────────
  const outreachJobs = db.prepare(`
    SELECT * FROM outreach_jobs
    WHERE owner_user_id = ?
    AND status NOT IN ('cancelled', 'done')
    AND created_at >= ?
    AND (briefed_at IS NULL OR updated_at > briefed_at OR status = 'no_response')
    ORDER BY updated_at DESC
    LIMIT 20
  `).all(ownerUserId, sevenDaysAgo) as any[];

  for (const job of outreachJobs) {
    const msgPreview  = (job.message ?? '').slice(0, 200);
    const replyText   = job.reply_text ?? null;

    let replyPreview: string | null = replyText;
    if (!replyPreview && job.conversation_json) {
      try {
        const conv = JSON.parse(job.conversation_json) as Array<{ role: string; content: string }>;
        const lastColleague = [...conv].reverse().find(m => m.role === 'user');
        if (lastColleague) replyPreview = lastColleague.content.slice(0, 200);
      } catch (_) {}
    }

    const statusLabel = {
      pending_scheduled: `scheduled to go out ${job.scheduled_at ? relativeTime(job.scheduled_at, timezone) : 'soon'}`,
      sent: 'sent, awaiting reply',
      replied: 'replied',
      no_response: 'no response yet',
    }[job.status as string] ?? job.status;

    outreachIds.push(job.id);
    items.push({
      kind: 'outreach',
      colleague: job.colleague_name,
      topic: msgPreview,
      status: statusLabel,
      sentWhen: job.sent_at ? relativeTime(job.sent_at, timezone) : undefined,
      scheduledFor: job.scheduled_at && job.status === 'pending_scheduled'
        ? DateTime.fromISO(job.scheduled_at).setZone(timezone).toFormat('EEEE d MMM')
        : undefined,
      theyReplied: !!replyPreview,
      replyPreview: replyPreview ?? undefined,
    });
  }

  // ── Coordination jobs (v1.6: coord_jobs is the only table) ───────────────
  const coordJobs = db.prepare(`
    SELECT * FROM coord_jobs
    WHERE owner_user_id = ?
    AND status NOT IN ('cancelled', 'abandoned')
    AND created_at >= ?
    ORDER BY updated_at DESC
    LIMIT 20
  `).all(ownerUserId, sevenDaysAgo) as any[];

  for (const job of coordJobs) {
    const statusLabel = {
      collecting:    'collecting participant responses',
      resolving:     'resolving best slot',
      negotiating:   'negotiating time',
      waiting_owner: 'waiting on your approval',
      confirmed:     'confirmed',
      booked:        'booked',
    }[job.status as string] ?? job.status;

    const slot = job.winning_slot
      ? DateTime.fromISO(job.winning_slot).setZone(timezone).toFormat('EEEE d MMM \'at\' HH:mm')
      : undefined;

    let participantNames = 'participants';
    try {
      const parts = JSON.parse(job.participants || '[]') as Array<{ name?: string; just_invite?: boolean }>;
      const keyNames = parts.filter(p => !p.just_invite).map(p => p.name).filter(Boolean);
      if (keyNames.length > 0) participantNames = keyNames.join(', ');
    } catch (_) {}

    coordIds.push(job.id);
    items.push({
      kind: 'coordination',
      colleague: participantNames,
      subject: job.subject,
      topic: job.topic ?? undefined,
      status: statusLabel,
      proposedSlot: slot,
      updatedWhen: relativeTime(job.updated_at, timezone),
    });
  }

  // ── Incoming colleague messages (events table, type=message) ──────────────
  const incomingMessages = db.prepare(`
    SELECT * FROM events
    WHERE owner_user_id = ?
    AND type IN ('message', 'outreach_reply')
    AND actioned = 0
    AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(ownerUserId, sevenDaysAgo) as any[];

  for (const ev of incomingMessages) {
    items.push({
      kind: 'incoming_message',
      from: ev.actor ?? 'unknown',
      summary: ev.detail ?? ev.title ?? '',
      when: relativeTime(ev.created_at, timezone),
    });
  }

  // ── Open user-requested tasks ──────────────────────────────────────────────
  const openTasks = db.prepare(`
    SELECT * FROM tasks
    WHERE owner_user_id = ?
    AND who_requested != 'system'
    AND status IN ('new', 'in_progress', 'pending_owner', 'pending_colleague')
    ORDER BY created_at DESC
    LIMIT 20
  `).all(ownerUserId) as any[];

  for (const task of openTasks) {
    const isAlreadyCovered = task.skill_ref && (
      outreachJobs.some((j: any) => j.id === task.skill_ref) ||
      coordJobs.some((j: any) => j.id === task.skill_ref)
    );
    if (isAlreadyCovered) continue;

    let contextSummary: string | undefined;
    try {
      const ctx = JSON.parse(task.context ?? '{}');
      contextSummary = ctx.message ?? ctx.subject ?? undefined;
    } catch (_) {}

    items.push({
      kind: 'open_task',
      title: task.title,
      status: task.status,
      dueAt: task.due_at ? relativeTime(task.due_at, timezone) : undefined,
      context: contextSummary,
    });
  }

  // ── Recently completed tasks (uninformed) ──────────────────────────────────
  const completedTasks = db.prepare(`
    SELECT * FROM tasks
    WHERE owner_user_id = ?
    AND who_requested != 'system'
    AND status = 'completed'
    AND completed_at >= ?
    ORDER BY completed_at DESC
    LIMIT 10
  `).all(ownerUserId, sevenDaysAgo) as any[];

  for (const task of completedTasks) {
    items.push({
      kind: 'completed_task',
      title: task.title,
      completedWhen: relativeTime(task.completed_at, timezone),
    });
  }

  return { items, outreachIds, coordIds };
}

// ── Generate briefing with Sonnet ────────────────────────────────────────────

async function generateBriefingText(
  items: RichItem[],
  profile: UserProfile,
): Promise<string> {
  if (items.length === 0) {
    const h = DateTime.now().setZone(profile.user.timezone).hour;
    const g = h >= 5 && h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
    return `${g} — all clear, nothing new.`;
  }

  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const firstName = profile.user.name.split(' ')[0];

  const dataText = JSON.stringify(items, null, 2);

  const systemPrompt = `You are writing a morning briefing for ${firstName} from their AI executive assistant ${profile.assistant.name}.

STYLE RULES:
- Write in first person as the assistant ("I reached out to...", "I'm waiting on...", "Michal messaged me...")
- For each item: say WHAT it's about + WHAT happened + whether ${firstName} needs to do anything
- Include timing naturally: "yesterday", "two days ago", "this morning"
- Keep it conversational and brief — you are a trusted assistant, not writing a status report
- Plain text only — NO markdown. Use • for bullets. Use *single asterisks* for bold (Slack style). NEVER use **double asterisks**
- Start with just the time-of-day greeting ("Morning —") — NOT "here's what happened while you were away"
- Maximum 350 words total
- End with any action items that require ${firstName}'s direct input (if none, skip that section)

PERSPECTIVE: You are the assistant. ${firstName} is the owner. Always write from the assistant's point of view.
- NEVER say "your message" — I sent the message on ${firstName}'s behalf. Say "my message" or "the message I sent"
- NEVER say "you messaged" — ${firstName} didn't message anyone, I did
- CORRECT: "I reached out to Alex...", "I sent a message to Yael...", "Alex replied to my message..."
- WRONG: "I sent your message to Alex", "checking if he responded to your message"

CRITICAL: Talk about the CONTENT and OUTCOME, not the activity type.
WRONG: "Alex replied to your message"
RIGHT: "Alex got back to me — he said he's fine with the plan and will add you to the next invite"
WRONG: "I messaged Amazia Keidar"
RIGHT: "I reached out to Amazia about setting up the AI agent kickoff — no reply yet, I'll follow up"
WRONG: "Michal Schwartz messaged Maelle"
RIGHT: "Michal messaged me yesterday — she said she's preparing the board materials and needs the Q1 numbers from you by Thursday"
WRONG: "checking if he responded to your message"
RIGHT: "waiting to hear back from him"

TASK OWNERSHIP — critical distinction:
- open_task items = things MAELLE is executing on Idan's behalf. Say "I'm working on X", "I'll reach out to Y today", "I'm handling Z". NEVER say "you need to" or put these in Idan's action items.
- Only put something in ACTION ITEMS if Idan genuinely needs to make a decision or provide input that Maelle cannot determine herself (e.g. "how should I position myself to Alex?").
- outreach/coordination status "no response" = FAILED. Always surface these as needing Idan's decision: "I got no response from X after two attempts — do you want me to try again, or handle it yourself?"
- outreach items where theyReplied=true and their reply is a question for Idan → these belong in action items.
- outreach items where Maelle is still waiting for a reply → say "I'm waiting to hear back" — not Idan's problem.

COMPLETENESS: Include every item in the data — do not skip or group items silently. If there are many, be brief on each but mention all of them.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Write the morning briefing based on this data:\n\n${dataText}` }],
    });

    return ((response.content[0] as Anthropic.TextBlock).text ?? '').trim();
  } catch (err) {
    logger.error('Briefing AI generation failed — falling back to simple format', { err: String(err) });
    return buildFallbackBriefing(items, profile);
  }
}

// ── Fallback (if Sonnet fails) ───────────────────────────────────────────────

function buildFallbackBriefing(items: RichItem[], profile: UserProfile): string {
  const h = DateTime.now().setZone(profile.user.timezone).hour;
  const greeting = h >= 5 && h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
  const lines: string[] = [`${greeting} — here's a quick update:`];

  for (const item of items) {
    if (item.kind === 'outreach')        lines.push(`• ${item.colleague}: ${item.status}`);
    if (item.kind === 'coordination')    lines.push(`• ${item.colleague} / ${item.subject}: ${item.status}`);
    if (item.kind === 'incoming_message') lines.push(`• ${item.from} messaged (${item.when})`);
    if (item.kind === 'open_task')       lines.push(`• ${item.title}`);
    if (item.kind === 'completed_task')  lines.push(`• Done: ${item.title}`);
  }
  return lines.join('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Sends a morning briefing to the owner.
 * Collects rich data from all relevant tables (outreach, coordination, tasks, messages),
 * then uses Sonnet to generate a natural, story-driven summary.
 */
export async function sendMorningBriefing(
  app: App,
  profile: UserProfile,
  ownerChannel: string,
  force: boolean = false
): Promise<void> {
  const ownerUserId = profile.user.slack_user_id;

  // Dedup — only one briefing per day
  if (!force) {
    const db = getDb();
    const todayLocal = DateTime.now().setZone(profile.user.timezone).toFormat('yyyy-MM-dd');
    const alreadySent = db.prepare(`
      SELECT id FROM events
      WHERE owner_user_id = ?
      AND type = 'task_update'
      AND title = 'morning_briefing_sent'
      AND detail = ?
    `).get(ownerUserId, todayLocal);
    if (alreadySent) {
      logger.info('Morning briefing already sent today — skipping', { userId: ownerUserId });
      return;
    }
  }

  // Collect everything that's happened / in-flight
  const { items, outreachIds, coordIds } = collectBriefingData(ownerUserId, profile.user.timezone);

  // Mark sent TODAY before generating (prevents duplicate on restart mid-generation)
  const { logEvent } = require('../db');
  logEvent({
    ownerUserId,
    type: 'task_update',
    title: 'morning_briefing_sent',
    detail: DateTime.now().setZone(profile.user.timezone).toFormat('yyyy-MM-dd'),
  });

  markEventsSeen(ownerUserId);
  const db2 = getDb();
  db2.prepare(`UPDATE events SET actioned = 1 WHERE owner_user_id = ? AND actioned = 0`).run(ownerUserId);

  // Generate natural language briefing via Sonnet. SlackConnection internally
  // applies formatForSlack so no explicit formatting needed at the call site.
  const rawText = await generateBriefingText(items, profile);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getConnection } = require('../connections/registry') as typeof import('../connections/registry');
  const conn = getConnection(ownerUserId, 'slack');
  if (conn) {
    await conn.postToChannel(ownerChannel, rawText);
  } else {
    logger.warn('briefs — no Slack connection registered, briefing not sent', { ownerUserId });
  }

  // Mark completed tasks as informed (briefing does NOT set informed — only direct notifications do)
  // But we still need to track that the briefing mentioned them to avoid re-mentioning
  // This is handled by the outreach/coord briefed_at stamps below.

  // Auto-complete ANY open briefing tasks
  const db = getDb();
  db.prepare(`
    UPDATE tasks
    SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
    WHERE owner_user_id = ?
    AND status IN ('new', 'in_progress', 'pending_owner', 'pending_colleague')
    AND lower(title) LIKE '%briefing%'
  `).run(ownerUserId);

  // Stamp briefed_at on outreach and coordination jobs that were included
  const now = new Date().toISOString();
  if (outreachIds.length > 0) {
    const placeholders = outreachIds.map(() => '?').join(',');
    db.prepare(`UPDATE outreach_jobs SET briefed_at = ? WHERE id IN (${placeholders})`)
      .run(now, ...outreachIds);

    db.prepare(`
      UPDATE outreach_jobs SET status = 'done', updated_at = datetime('now')
      WHERE id IN (${placeholders})
      AND status IN ('replied')
      AND await_reply = 0
    `).run(...outreachIds);
  }
  // v1.6 — coord_jobs no longer uses a briefed_at column; the briefing is a
  // read-only view of the current state. Unread-delta suppression happens via
  // the events table instead.

  logger.info('Morning briefing sent (AI-generated)', {
    userId: ownerUserId,
    items: items.length,
  });
}

// ── Briefing schedule helpers (used by crons.runner.ts) ──────────────────────

export function getBriefingWorkDays(profile: UserProfile): string[] {
  return [
    ...profile.schedule.office_days.days,
    ...profile.schedule.home_days.days,
  ];
}

export function getBriefingHourMin(profile: UserProfile): [number, number] {
  const prefs = getPreferences(profile.user.slack_user_id);
  const timePref = prefs.find(p => p.key === 'briefing_time');
  if (timePref) {
    const match = timePref.value.match(/\b(\d{1,2}):(\d{2})\b/);
    if (match) {
      return [parseInt(match[1], 10), parseInt(match[2], 10)];
    }
  }

  const startTimes = [
    profile.schedule.office_days.hours_start,
    profile.schedule.home_days.hours_start,
  ].filter(Boolean).sort();
  const earliest = startTimes[0] ?? '09:00';
  const [h, m] = earliest.split(':').map(Number);
  return [h, m ?? 0];
}

export function isWorkDay(dt: DateTime, profile: UserProfile): boolean {
  const dayNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  return getBriefingWorkDays(profile).includes(dayNames[dt.weekday] as any);
}
