import Anthropic from '@anthropic-ai/sdk';
import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import { config } from '../config';
import { markEventsSeen, getDb, getPreferences } from '../db';
import { getBriefableTasks, markTaskInformed, type Task } from './index';
import { getCalendarEvents, type CalendarEvent } from '../connectors/graph/calendar';
import { processCalendarEvents } from '../skills/meetings/ops';
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
  // v2.2.4 — every surfaced task whose status is 'completed' lands here.
  // After the brief sends, the caller flips each one to 'informed' via the
  // existing two-step. Replaces the previous outreachIds/coordIds/
  // completedTaskIds split — tasks is now the only spine.
  taskIdsToInform: string[];
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

// ── Item builders (v2.2.4 — extracted from collectBriefingData) ──────────────
//
// Each builder takes a hydrated detail row (or task) and produces a RichItem
// in the shape the briefing prompt expects. Keeps collectBriefingData itself
// short and pure: walk tasks, branch on skill_origin, hand to the right
// builder.

function buildOutreachItem(
  job: any,
  ownerCalendarEvents: CalendarEvent[],
  profile: UserProfile,
  timezone: string,
): RichItem {
  const msgPreview = (job.message ?? '').slice(0, 200);
  const replyText = job.reply_text ?? null;

  let replyPreview: string | null = replyText;
  if (!replyPreview && job.conversation_json) {
    try {
      const conv = JSON.parse(job.conversation_json) as Array<{ role: string; content: string }>;
      const lastColleague = [...conv].reverse().find(m => m.role === 'user');
      if (lastColleague) replyPreview = lastColleague.content.slice(0, 200);
    } catch (_) {}
  }

  const awaitsReply = (job.await_reply ?? 1) === 1;
  const statusLabel = {
    pending_scheduled: `scheduled to go out ${job.scheduled_at ? relativeTime(job.scheduled_at, timezone) : 'soon'}`,
    sent: awaitsReply ? 'sent, awaiting reply' : 'sent — they\'re handling it on their side',
    replied: 'replied',
    no_response: 'no response yet',
  }[job.status as string] ?? job.status;

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
    } catch (err) {
      logger.warn('brief verifier — outreach verify threw, falling back', {
        id: job.id, err: String(err).slice(0, 200),
      });
    }
  }

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
  return item;
}

function buildCoordItem(
  job: any,
  ownerCalendarEvents: CalendarEvent[],
  profile: UserProfile,
  timezone: string,
): RichItem {
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

  const item: RichItem = {
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
    item.verified_outcome = {
      status: coordVerifiedOutcome.status,
      event_subject: ev.subject ?? '',
      event_when: eStart.toFormat('EEEE d MMM \'at\' HH:mm'),
      issues: coordVerifiedOutcome.issues,
    };
  }
  return item;
}

function buildTaskItem(task: Task, timezone: string): RichItem {
  if (task.status === 'completed') {
    return {
      kind: 'completed_task',
      title: task.title,
      completedWhen: task.completed_at ? relativeTime(task.completed_at, timezone) : 'recently',
    };
  }

  let contextSummary: string | undefined;
  try {
    const ctx = JSON.parse(task.context ?? '{}');
    contextSummary = ctx.message ?? ctx.subject ?? undefined;
  } catch (_) {}

  return {
    kind: 'open_task',
    title: task.title,
    status: task.status,
    dueAt: task.due_at ? relativeTime(task.due_at, timezone) : undefined,
    context: contextSummary,
  };
}

// ── Data collection (v2.2.4 — tasks-first) ───────────────────────────────────

async function collectBriefingData(
  ownerUserId: string,
  timezone: string,
  profile: UserProfile,
): Promise<BriefingData> {
  const db = getDb();
  const items: RichItem[] = [];
  const outreachToClose: string[] = [];   // verifier-detected booked outreach
  const taskIdsToInform: string[] = [];   // surfaced + completed → flip to 'informed' post-brief

  const sevenDaysAgo = DateTime.now().minus({ days: 7 }).toUTC().toISO()!;

  // v2.1.4 — pre-fetch owner's calendar events for the next ~30 days so the
  // outcome verifier can check whether third parties booked anything at the
  // slots Maelle proposed. One fetch covers every hydration call below.
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

  // ── Calendar surface (v2.3.2) ─────────────────────────────────────────────
  // Today's + tomorrow's meetings, structured for the brief Sonnet pass.
  // Reuses processCalendarEvents (privacy mask, free-event strip, attendee
  // extraction, online detection) so the brief sees the same shape every
  // other consumer does. Pushed first so they appear at the top of the
  // items JSON Sonnet reads.
  if (ownerCalendarEvents.length > 0) {
    try {
      const processed = processCalendarEvents(
        ownerCalendarEvents,
        profile.user.email,
        profile.user.name,
        timezone,
      );
      const todayLocal = DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd');
      const tomorrowLocal = DateTime.now().setZone(timezone).plus({ days: 1 }).toFormat('yyyy-MM-dd');

      const summarize = (evs: typeof processed) => evs
        .filter(e => !e.isCancelled && e._eventType === 'mine')
        .sort((a, b) => a._localStartTime.localeCompare(b._localStartTime))
        .map(e => ({
          subject: e.subject,
          start: e._localStartTime,
          end: e._localEndTime,
          duration_min: e._durationMin,
          all_day: e.isAllDay,
          attendees: e.attendees,
          is_online: e.isOnlineMeeting,
          categories: e.categories,
          is_lunch: e.is_lunch,
        }));

      const todays = summarize(processed.filter(e => e._localDate === todayLocal));
      const tomorrows = summarize(processed.filter(e => e._localDate === tomorrowLocal));

      if (todays.length > 0) {
        items.push({
          kind: 'calendar_today',
          date: DateTime.now().setZone(timezone).toFormat('EEEE d MMM'),
          events: todays,
        });
      }
      if (tomorrows.length > 0) {
        items.push({
          kind: 'calendar_tomorrow',
          date: DateTime.now().setZone(timezone).plus({ days: 1 }).toFormat('EEEE d MMM'),
          events: tomorrows,
        });
      }
    } catch (err) {
      logger.warn('brief — calendar surface build threw, skipping today/tomorrow section', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // ── Tasks-first walk (v2.2.4) ─────────────────────────────────────────────
  // Tasks is the spine. Outreach + coord rows are detail tables that hang off
  // tasks via skill_ref. We query tasks once, then hydrate outreach- and
  // coord-backed tasks with their detail row for richer narration. The
  // completed → informed two-step then governs every surface uniformly —
  // booked coords stop resurfacing the day after one brief informs about
  // them, replied outreach the same. Replaces the prior three-parallel-queries
  // structure (outreach_jobs, coord_jobs, tasks all queried independently with
  // tasks deduped against the others) which left coord/outreach rows stranded
  // in the brief for 7 days regardless of what 'informed' was doing.
  const tasks = getBriefableTasks(ownerUserId, sevenDaysAgo);

  for (const task of tasks) {
    if (task.skill_origin === 'outreach' && task.skill_ref) {
      const job = db.prepare(`SELECT * FROM outreach_jobs WHERE id = ?`).get(task.skill_ref) as any;
      if (job) {
        const item = buildOutreachItem(job, ownerCalendarEvents, profile, timezone);
        if (item.verified_outcome) outreachToClose.push(job.id);
        items.push(item);
      } else {
        items.push(buildTaskItem(task, timezone));
      }
    } else if (task.skill_origin === 'meetings' && task.type === 'coordination' && task.skill_ref) {
      const job = db.prepare(`SELECT * FROM coord_jobs WHERE id = ?`).get(task.skill_ref) as any;
      if (job) {
        items.push(buildCoordItem(job, ownerCalendarEvents, profile, timezone));
      } else {
        items.push(buildTaskItem(task, timezone));
      }
    } else {
      items.push(buildTaskItem(task, timezone));
    }
    if (task.status === 'completed') taskIdsToInform.push(task.id);
  }

  // v2.3.2 — events table NO LONGER feeds the brief. The tasks-spine (above)
  // owns every briefable item; events stays a write-only audit log surface
  // consumed by `recall_interactions` and the on-demand `get_briefing` tool.
  // Reason: every inbound colleague DM was logged with actioned=0 and
  // surfaced once per brief regardless of whether Maelle had handled it in
  // real-time, the owner had read it directly, or a downstream coord/booking
  // had already informed about it. The tasks.informed two-step (v2.2.4)
  // already does "show once, then drop" correctly for items that matter.

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
    if (firstName && !peopleGender[firstName]) {
      peopleGender[firstName] = pronounFor(row.gender);
    }
  }

  return { items, taskIdsToInform, peopleGender, outreachToClose };
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

STRUCTURE (in this order):
1. Time-of-day greeting ("Morning —"). Nothing else on this line.
2. TODAY'S CALENDAR — only if a calendar_today item is present. Short list, one line per meeting: time, subject, key attendee(s), location/online tag. No prose around it. Skip lunch and short personal blocks unless they're the only items. NEVER add "your window is X" / "it's a short day" / "you finish at Y" framing — ${firstName} already knows his own schedule shape.
3. TOMORROW (one short line) — only if calendar_tomorrow is present AND there's something notable: an external meeting, an overlap, a big-deal item. Skip if tomorrow is routine. Don't enumerate every meeting — this is a heads-up, not a second calendar.
4. PER-PERSON paragraphs — one short paragraph per colleague who has open / recently-changed work. If Amazia has three things going on, they collapse into one Amazia paragraph. Skip people with nothing new.
5. ACTION ITEMS section — only if there's something that needs ${firstName}'s decision or input. Skip the section entirely when there's nothing to decide.

FORMAT:
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
- NO SELF-CONTRADICTION — if you closed an item in a colleague paragraph ("nothing to do", "handled", "booked", "you're set"), that SAME item MUST NOT appear in ACTION ITEMS. Pick one. Saying "Yael's BiWeekly is booked, nothing to do there" and then listing the same booking under ACTION ITEMS as something to verify makes you look lost. If you're flagging something for ${firstName}, don't also tell him there's nothing to do.
- MULTI-CONFLICT AGGREGATION — when several meetings need ${firstName}'s decision on the same day (e.g. several conflicts on his OOF day, several overlaps in one block), DO NOT enumerate each one with its own bullet + per-item question. Bundle them. List the meeting names inline and ask ONE question. EXAMPLE: "Wednesday has 3 meetings on your OOF (Sales Sync, Vision, Product Weekly) — which do you want me to move or cancel?" not "1. Sales Sync — cancel or reschedule? 2. Vision — keep or move? 3. Product Weekly — cancel or reschedule?". Treat ${firstName} as a human reader, not someone clicking through a checklist.
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
  const { items, taskIdsToInform, peopleGender, outreachToClose } = await collectBriefingData(ownerUserId, profile.user.timezone, profile);

  // v2.1.4 — close outreach rows that the verifier determined are booked.
  // updateOutreachJob's terminal hook (v2.2.4) cascades the linked task to
  // 'completed' so the next brief's tasks-first walk drops them via the
  // informed two-step.
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

  // markEventsSeen kept — `seen` flag still drives the on-demand `get_briefing`
  // tool (tasks/skill.ts) which surfaces unseen events on owner request.
  // The `actioned=1` flush is gone in v2.3.2: no reader of `actioned=0`
  // remains after the brief stopped reading the events table.
  markEventsSeen(ownerUserId);

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

  // Auto-complete ANY open briefing tasks
  const db = getDb();
  db.prepare(`
    UPDATE tasks
    SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
    WHERE owner_user_id = ?
    AND status IN ('new', 'in_progress', 'pending_owner', 'pending_colleague')
    AND lower(title) LIKE '%briefing%'
  `).run(ownerUserId);

  // v2.2.4 — flip every surfaced completed task to 'informed'. Two-step
  // pattern (completed → informed) now governs all surfaces uniformly:
  // outreach-, coord-, reminder-, follow-up- backed tasks all drop off the
  // next brief once flipped. Replaces the prior briefed_at outreach stamps
  // and the await_reply=0 auto-close — those were per-table workarounds for
  // the same problem informed already solves at the task layer.
  for (const id of taskIdsToInform ?? []) {
    markTaskInformed(id);
  }

  logger.info('Morning briefing sent (AI-generated)', {
    userId: ownerUserId,
    items: items.length,
    informed: taskIdsToInform.length,
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
