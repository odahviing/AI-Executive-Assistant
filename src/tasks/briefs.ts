import Anthropic from '@anthropic-ai/sdk';
import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import { config } from '../config';
import { getUnseenEvents, markEventsSeen, getDb, getPreferences } from '../db';
import { getOpenTasksForOwner, getCompletedUninformedTasks, markTaskInformed } from './index';
import { getCalendarEvents, type CalendarEvent } from '../connectors/graph/calendar';
import { verifyScheduledOutcome, type ScheduleOutcome } from '../utils/verifyScheduledOutcome';
import { updateOutreachJob } from '../db';
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
  completedTaskIds: string[];
  // v2.0.3 — name → pronoun map so Sonnet can pick the right pronouns
  // instead of guessing from first names (which is unreliable for non-Western
  // names like "Amazia").
  peopleGender: Record<string, 'he' | 'she' | 'they'>;
  // v2.1.4 — outreach_jobs ids the verifier determined are effectively
  // booked (matching event landed on owner's calendar). Caller flips them
  // to status='done' after the brief is sent so they don't resurface.
  outreachToClose: string[];
}

function pronounFor(gender: string | null | undefined): 'he' | 'she' | 'they' {
  if (gender === 'male') return 'he';
  if (gender === 'female') return 'she';
  return 'they';
}

async function collectBriefingData(
  ownerUserId: string,
  timezone: string,
  profile: UserProfile,
): Promise<BriefingData> {
  const db = getDb();
  const items: RichItem[] = [];
  const outreachIds: string[] = [];
  const coordIds: string[] = [];
  const outreachToClose: string[] = [];  // v2.1.4 — outreach rows where verifier detected a booking

  const sevenDaysAgo = DateTime.now().minus({ days: 7 }).toUTC().toISO()!;

  // v2.1.4 — pre-fetch owner's calendar events for the next 21 days so the
  // outcome verifier can check whether third parties booked anything at the
  // slots Maelle proposed. Bounded to when any outreach/coord with
  // proposed_slots actually references dates in this window. One fetch
  // covers all the verifier calls below.
  let ownerCalendarEvents: CalendarEvent[] = [];
  try {
    const calFrom = DateTime.now().setZone(timezone).minus({ days: 2 }).toFormat('yyyy-MM-dd');
    const calTo = DateTime.now().setZone(timezone).plus({ days: 30 }).toFormat('yyyy-MM-dd');
    ownerCalendarEvents = await getCalendarEvents(profile.user.email, calFrom, calTo, timezone);
  } catch (err) {
    logger.warn('brief verifier — calendar fetch failed, skipping outcome verification', {
      err: String(err).slice(0, 200),
    });
  }

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

    // v2.1.4 — honor await_reply=0 so brief doesn't narrate a
    // fire-and-forget outreach as "waiting to hear back" when Maelle
    // explicitly didn't expect a reply.
    const awaitsReply = (job.await_reply ?? 1) === 1;
    const statusLabel = {
      pending_scheduled: `scheduled to go out ${job.scheduled_at ? relativeTime(job.scheduled_at, timezone) : 'soon'}`,
      sent: awaitsReply ? 'sent, awaiting reply' : 'sent — they\'re handling it on their side',
      replied: 'replied',
      no_response: 'no response yet',
    }[job.status as string] ?? job.status;

    // v2.1.4 — verify outcome: if this outreach proposed specific times and
    // a matching event showed up on the calendar (third party booked it),
    // report that instead of "still waiting".
    let verifiedOutcome: ScheduleOutcome | null = null;
    if (ownerCalendarEvents.length > 0 && job.proposed_slots) {
      try {
        const slots = JSON.parse(job.proposed_slots) as string[];
        verifiedOutcome = verifyScheduledOutcome(
          {
            proposedSlots: Array.isArray(slots) ? slots : [],
            subjectKeyword: job.subject_keyword ?? undefined,
            colleagueSlackId: job.colleague_slack_id,
          },
          ownerCalendarEvents,
          profile,
        );
        if (verifiedOutcome.status !== 'none') {
          outreachToClose.push(job.id);
        }
      } catch (err) {
        logger.warn('brief verifier — outreach verify threw, falling back', {
          id: job.id, err: String(err).slice(0, 200),
        });
      }
    }

    outreachIds.push(job.id);
    const item: RichItem = {
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
      awaitsReply,
    };
    if (verifiedOutcome && verifiedOutcome.status !== 'none' && verifiedOutcome.event) {
      const ev = verifiedOutcome.event;
      const eStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' }).setZone(timezone);
      item.verified_outcome = {
        status: verifiedOutcome.status,
        event_subject: ev.subject ?? '',
        event_when: eStart.toFormat('EEEE d MMM \'at\' HH:mm'),
        issues: verifiedOutcome.issues,
      };
    }
    items.push(item);
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

    // v2.1.4 — verify outcome for non-terminal coords with proposed slots.
    // Same logic as outreach: if a matching event landed on the calendar,
    // surface it.
    let coordVerifiedOutcome: ScheduleOutcome | null = null;
    const isTerminal = ['booked', 'cancelled', 'abandoned'].includes(job.status as string);
    if (!isTerminal && ownerCalendarEvents.length > 0 && job.proposed_slots) {
      try {
        const slots = JSON.parse(job.proposed_slots) as string[];
        if (Array.isArray(slots) && slots.length > 0) {
          coordVerifiedOutcome = verifyScheduledOutcome(
            { proposedSlots: slots, subjectKeyword: job.subject },
            ownerCalendarEvents,
            profile,
          );
        }
      } catch (err) {
        logger.warn('brief verifier — coord verify threw, falling back', {
          id: job.id, err: String(err).slice(0, 200),
        });
      }
    }

    coordIds.push(job.id);
    const coordItem: RichItem = {
      kind: 'coordination',
      colleague: participantNames,
      subject: job.subject,
      topic: job.topic ?? undefined,
      status: statusLabel,
      proposedSlot: slot,
      updatedWhen: relativeTime(job.updated_at, timezone),
    };
    if (coordVerifiedOutcome && coordVerifiedOutcome.status !== 'none' && coordVerifiedOutcome.event) {
      const ev = coordVerifiedOutcome.event;
      const eStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' }).setZone(timezone);
      coordItem.verified_outcome = {
        status: coordVerifiedOutcome.status,
        event_subject: ev.subject ?? '',
        event_when: eStart.toFormat('EEEE d MMM \'at\' HH:mm'),
        issues: coordVerifiedOutcome.issues,
      };
    }
    items.push(coordItem);
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
  // v2.0.3 — surface completed tasks ONCE. The model is: completed → informed.
  // Query below pulls status='completed' only (not 'informed'); after the
  // briefing sends, the outer function flips each included task via
  // markTaskInformed so it never re-appears. Previously the briefing didn't
  // flip completed → informed, so tasks re-surfaced every day for 7 days.
  const completedTaskIds: string[] = [];
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
    completedTaskIds.push(task.id);
    items.push({
      kind: 'completed_task',
      title: task.title,
      completedWhen: relativeTime(task.completed_at, timezone),
    });
  }

  // v2.0.3 — collect gender for every person referenced by name anywhere in
  // the briefing items. Keyed on name (first-name collisions are rare inside
  // one owner's circle; Sonnet resolves from context).
  const peopleGender: Record<string, 'he' | 'she' | 'they'> = {};
  const peopleRows = db.prepare(
    `SELECT name, gender FROM people_memory WHERE gender IS NOT NULL`
  ).all() as Array<{ name: string; gender: string }>;
  for (const row of peopleRows) {
    if (!row.name) continue;
    const firstName = row.name.split(' ')[0];
    peopleGender[row.name] = pronounFor(row.gender);
    // Also key by first name for easier Sonnet lookup
    if (firstName && !peopleGender[firstName]) {
      peopleGender[firstName] = pronounFor(row.gender);
    }
  }

  return { items, outreachIds, coordIds, completedTaskIds, peopleGender, outreachToClose };
}

// ── Generate briefing with Sonnet ────────────────────────────────────────────

async function generateBriefingText(
  items: RichItem[],
  profile: UserProfile,
  peopleGender: Record<string, 'he' | 'she' | 'they'> = {},
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

STRUCTURE:
- Start with just the time-of-day greeting ("Morning —") — NOT "here's what happened while you were away"
- Group every item by PERSON. One short paragraph per colleague — not per item. If Amazia has three things going on, they collapse into one Amazia paragraph.
- End with an ACTION ITEMS section if there's anything that needs ${firstName}'s decision or input (not just a status update). Skip the section entirely when there's nothing to decide.
- Plain text only. Use • for bullets. Use *single asterisks* for bold (Slack style). NEVER use **double asterisks**.

WHAT GETS SURFACED:
- EVERYTHING that's still open — even items that don't need today's action. ${firstName} wants a full picture of what's on the plate. Stuff he already sees as booked-and-handled can be a one-liner, but don't hide it.
- Prefer the OUTCOME / current state over the activity. "Amazia kicked off — Sunday 26 Apr, handled" beats "I messaged Amazia and she replied".
- Skip internal plumbing ("I called the booking tool", "the system detected a conflict"). Narrate as a human EA would.

TONE + PHRASING (human, not robot):
- First person as the assistant ("I reached out...", "I'm waiting on...", "Michal messaged me...")
- Time windows in human terms: "~1.5 hours open", "plenty of room midday", "a short pocket before lunch", "booked back-to-back". NEVER say "110 min", "pretty full" when there are open hours, or any number-of-minutes phrasing. A real EA doesn't speak in minutes, she speaks in "you've got time".
- Timing of events: "yesterday", "two days ago", "this morning", "earlier this week". Not timestamps.
- Don't write a status report — write the way a trusted assistant would brief her boss in 30 seconds of talking.

PERSPECTIVE: You are the assistant. ${firstName} is the owner. Always write from the assistant's point of view.
- NEVER say "your message" — I sent the message on ${firstName}'s behalf. Say "my message" or "the message I sent".
- NEVER say "you messaged" — ${firstName} didn't message anyone, I did.
- CORRECT: "I reached out to Alex...", "I sent a message to Yael...", "Alex replied to my message..."

CONTENT OVER ACTIVITY:
WRONG: "Alex replied to your message"
RIGHT: "Alex got back to me — he's fine with the plan, will add you to the next invite"
WRONG: "I messaged Amazia Keidar"
RIGHT: "Amazia kicked off — Sunday 26 Apr 09:00, booked. Nothing to do."
WRONG: "Michal Schwartz messaged Maelle"
RIGHT: "Michal asked about a bank visit next Wednesday — I told her midday works, waiting on her to confirm with Inbar."

TASK OWNERSHIP — critical distinction:
- open_task / outreach items = things MAELLE is executing on ${firstName}'s behalf. Say "I'm working on X", "I'll follow up with Y today", "I'm handling Z". NEVER say "you need to" for these.
- Only put something in ACTION ITEMS if ${firstName} genuinely needs to make a decision or provide input Maelle can't make herself. An item already waiting on an external reply (colleague, bank) is NOT an action item for ${firstName} — it's something Maelle is watching.
- outreach at "no_response" with no decision yet → surface it, but frame as "X hasn't replied — want me to try again or drop it?" Don't dramatize.
- If an outreach is effectively done (coord booked, owner handled it directly) don't resurface it just because it's in the data. Roll it into the colleague's paragraph as past-tense closure.

AWAIT-REPLY AWARENESS:
- If an outreach item has awaitsReply=false, DO NOT narrate it as "waiting to hear back" / "still waiting". That outreach was a fire-and-forget message — ${firstName} didn't expect a reply, so Maelle isn't waiting. Narrate it as "I let X know" / "I told X" / "sent — they're handling it." past-tense, closed loop.

VERIFIED OUTCOMES — a meeting Maelle proposed was booked by someone else:
When an item carries a verified_outcome field, the verifier found a matching meeting on ${firstName}'s calendar for a slot Maelle previously proposed. That means the colleague (or their assistant / counterpart) booked it themselves — not Maelle. Narrate accordingly, do NOT say "still waiting".
- verified_outcome.status="booked_compliant" → the meeting is on the calendar, within ${firstName}'s rules. Narrate as done: "Michal and Inbar booked it — Wed 29 Apr at noon, you're set." Include event_when. Past tense, closed.
- verified_outcome.status="booked_conflict" → the meeting landed BUT its time breaks a rule (out of hours, lunch clash, etc.). Surface it with the issues list so ${firstName} can decide. Example: "Michal booked the bank visit — Wed 29 Apr 17:30 — but it's past your work hours. Approve or should I push back and ask her to move it?" Use the issues list verbatim when useful.

PRONOUNS — use the provided gender data, NEVER guess from a name. The PEOPLE_GENDER map below gives the correct pronoun (he / she / they) for every person referenced. If a person isn't in the map, use "they". Names like Amazia, Yael, Oran, Onn can be male or female — check the map. Don't guess.

PEOPLE_GENDER:
${Object.keys(peopleGender).length > 0
  ? Object.entries(peopleGender).map(([name, p]) => `  ${name}: ${p}`).join('\n')
  : '  (no gender data available — use "they" for all)'}`;

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

  // v2.2.3 (scenario 7 row 1) — sweep DB for artifacts pointing at meetings
  // that have vanished from the calendar (organizer cancelled externally).
  // Cascade fires the standard closeMeetingArtifacts cleanup so the brief
  // doesn't surface "needs your input" for events that no longer exist.
  // Best-effort: never throws, never blocks brief generation.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { cleanupVanishedMeetingArtifacts } = require('../utils/cleanupVanishedMeetingArtifacts') as
      typeof import('../utils/cleanupVanishedMeetingArtifacts');
    const swept = await cleanupVanishedMeetingArtifacts({
      ownerUserId,
      ownerEmail: profile.user.email,
    });
    if (swept.cleaned > 0) {
      logger.info('Brief pre-pass: closed orphan artifacts for vanished meetings', {
        ownerUserId, ...swept,
      });
    }
  } catch (err) {
    logger.warn('Brief pre-pass cleanup threw — continuing', { err: String(err).slice(0, 200) });
  }

  // Collect everything that's happened / in-flight
  const { items, outreachIds, coordIds, completedTaskIds, peopleGender, outreachToClose } = await collectBriefingData(ownerUserId, profile.user.timezone, profile);

  // v2.1.4 — close outreach rows that the verifier determined are booked.
  // They'll drop off tomorrow's brief (status='done' → filter excludes them).
  if (outreachToClose && outreachToClose.length > 0) {
    for (const id of outreachToClose) {
      try {
        updateOutreachJob(id, { status: 'done' });
      } catch (err) {
        logger.warn('brief verifier — close outreach failed', { id, err: String(err).slice(0, 200) });
      }
    }
    logger.info('brief verifier — outreach rows closed via verified outcome', { count: outreachToClose.length });
  }

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
  const rawText = await generateBriefingText(items, profile, peopleGender);
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

  // v2.0.3 — flip completed → informed for tasks included above. Next briefing
  // queries status='completed' only, so they drop off. Two-step
  // completed→informed pattern documented in tasks/index.ts.
  for (const id of completedTaskIds ?? []) {
    markTaskInformed(id);
  }

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
