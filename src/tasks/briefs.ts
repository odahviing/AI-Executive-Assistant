import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import { SONNET } from '../llm/models';
import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import { markEventsSeen, getDb, getPreferences, appendToConversation } from '../db';
import {
  getRequestsForBrief,
  markRequestSurfaced,
  todayStartUtcIso,
} from '../db/requests';
import { closeRequest } from '../core/requests/closeRequest';
import type { RequestRow } from '../core/requests/types';
import { parseDetails } from '../core/requests/types';
import { getCalendarEvents, type CalendarEvent } from '../connectors/graph/calendar';
import { getPersonByEmail } from '../db/people';
import { formatSkillPreferencesBlock } from '../utils/skillPreferences';
import { formatSeenLogBlock, NEWS_PER_GOAL_TIMEOUT_MS, type NewsBundle } from '../skills/news';
import { processCalendarEvents } from '../skills/meetings/ops';
import { verifyScheduledOutcome, type ScheduleOutcome } from '../utils/verifyScheduledOutcome';
import logger from '../utils/logger';
import { calendarListingFormatRule } from '../utils/calendarListingFormat';

/** Items past this surface count flip to cancelled (auto-park). */
const STALE_SURFACE_THRESHOLD = 3;

/** v3.2.6 — news gather is best-effort + fail-open. If it doesn't return within
 *  this window, the brief composes calendar+tasks exactly as today (no delay).
 *  #166 came back twice from editing this number (or news.ts's inner
 *  NEWS_PER_GOAL_TIMEOUT_MS) without re-checking the other side — the
 *  relationship was asserted only in prose here, so it could drift silently
 *  (the Updates section just vanishes, no error). Both outer timeouts below
 *  are now DERIVED from news.ts's NEWS_PER_GOAL_TIMEOUT_MS (imported, the
 *  inner per-goal search budget — the parallel per-goal fan-out is the long
 *  pole; goal planning itself is a quick Haiku call) plus a fixed margin, so
 *  an edit to either constant cannot invert the relationship without a
 *  visible arithmetic change here. Margin sizing is unchanged from the prior
 *  literals (12s inner + 8s scheduled margin = 20s; +2s on-demand margin =
 *  14s) — those margins were already measured safe (gather-done timestamps
 *  landing 4-8s after the preceding calendar step across
 *  logs/maelle-2026-07-{28,29,30}.log; #166's own note measured 5.00s →
 *  7.94s → 8.32s over four days). Don't shrink either margin without
 *  re-timing both sides. */
const NEWS_BRIEF_SCHEDULED_MARGIN_MS = 8_000;
const NEWS_BRIEF_TIMEOUT_MS = NEWS_PER_GOAL_TIMEOUT_MS + NEWS_BRIEF_SCHEDULED_MARGIN_MS;
/** #166 follow-up — the ON-DEMAND path (owner asked for the brief in Slack,
 *  `force: true`) has someone waiting live behind the eye-emoji receipt, so it
 *  keeps a tighter margin than the scheduled path: a slower-than-usual gather
 *  is dropped (fail-open, same as ever) rather than making a person watch a
 *  long spinner. See NEWS_BRIEF_TIMEOUT_MS above for why this is derived
 *  rather than a bare literal. */
const NEWS_BRIEF_ON_DEMAND_MARGIN_MS = 2_000;
const NEWS_BRIEF_TIMEOUT_MS_ON_DEMAND = NEWS_PER_GOAL_TIMEOUT_MS + NEWS_BRIEF_ON_DEMAND_MARGIN_MS;
/** Cap how many meeting-companies we derive into news goals (cost control). */
const NEWS_MEETING_COMPANY_CAP = 3;
/** v3.x — today's calendar-health pass folded into the brief is best-effort +
 *  fail-open. Active mode does Graph reads (+ possibly a coord move), so a
 *  more generous window than news; if it overruns, the brief ships without the
 *  health line and the fixes still complete in the background. */
const BRIEF_HEALTH_TIMEOUT_MS = 25_000;

// Generic mailbox providers — an attendee here tells us nothing about a company.
const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com',
  'proton.me', 'protonmail.com',
]);

/** "acme.com" → "Acme"; "mail.acme.co.uk" → "Acme". Best-effort label for a
 *  company name when the person store has no explicit org. */
function companyLabelFromDomain(domain: string): string | null {
  const parts = domain.toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return null;
  let labels = parts.slice(0, -1); // drop TLD
  const secondLevel = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
  if (labels.length > 1 && secondLevel.has(labels[labels.length - 1])) {
    labels = labels.slice(0, -1);
  }
  const head = labels[labels.length - 1];
  if (!head) return null;
  return head.charAt(0).toUpperCase() + head.slice(1);
}

/**
 * Derive the companies of the people on TODAY's calendar (the news calendar
 * tie-in). READ-ONLY — uses getPersonByEmail (never resolvePerson, which would
 * create rows as a side effect of the brief). Prefers the person store's `org`,
 * falls back to the email domain. Skips internal (owner-domain) + generic
 * providers. Deduped + capped. Returns [] when nothing usable.
 */
/**
 * Kernel — derive company names from raw events (used by both the morning
 * brief and the on-demand news() tool, which fetches today's calendar at
 * call time). Skips internal (owner-domain) + generic providers. Reads
 * person store READ-ONLY (getPersonByEmail; never creates rows). Deduped
 * and capped at NEWS_MEETING_COMPANY_CAP.
 */
export function extractMeetingCompaniesFromEvents(
  events: Array<{ attendees?: Array<{ emailAddress?: { address?: string } }> }>,
  profile: UserProfile,
): string[] {
  const ownerDomain = (profile.user.email.split('@')[1] ?? '').toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    for (const att of ev.attendees ?? []) {
      const email = att.emailAddress?.address?.trim().toLowerCase();
      if (!email || !email.includes('@')) continue;
      const domain = email.split('@')[1];
      if (!domain || domain === ownerDomain || GENERIC_EMAIL_DOMAINS.has(domain)) continue;
      const row = getPersonByEmail(email);
      const company = (row?.org && row.org.trim()) || companyLabelFromDomain(domain);
      if (!company) continue;
      const key = company.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(company);
      if (out.length >= NEWS_MEETING_COMPANY_CAP) return out;
    }
  }
  return out;
}

function deriveMeetingCompanies(items: RichItem[], profile: UserProfile): string[] {
  const today = items.find(i => i.kind === 'calendar_today');
  if (!today) return [];
  const events = (today.events as Array<{ attendees?: Array<{ emailAddress?: { address?: string } }> }> | undefined) ?? [];
  return extractMeetingCompaniesFromEvents(events, profile);
}

// ── Relative time helper ──────────────────────────────────────────────────────

function relativeTime(isoStr: string | undefined | null, timezone: string): string {
  if (!isoStr) return 'recently';
  const dt  = DateTime.fromISO(isoStr).setZone(timezone);
  const now = DateTime.now().setZone(timezone);
  const diffDays = now.startOf('day').diff(dt.startOf('day'), 'days').days;
  if (diffDays < 0.5) return 'today';
  if (diffDays < 1.5) return 'yesterday';
  if (diffDays < 2.5) return 'two days ago';
  if (diffDays < 3.5) return 'three days ago';
  return dt.toFormat('EEEE');
}

interface RichItem {
  kind: string;
  [key: string]: unknown;
}

interface BriefingData {
  items: RichItem[];
  requestIdsToSurface: string[];   // stamp last_surfaced_at + informed=1
  requestIdsToStale: string[];     // surfaced_count >= threshold → cancel
  peopleGender: Record<string, 'he' | 'she' | 'they'>;
}

function pronounFor(gender: string | null | undefined): 'he' | 'she' | 'they' {
  if (gender === 'male') return 'he';
  if (gender === 'female') return 'she';
  return 'they';
}

interface InteractionLogEntry { date: string; type: string; summary: string }
function recentColleagueContext(slackId: string | null | undefined, limit = 3): InteractionLogEntry[] {
  if (!slackId) return [];
  try {
    const db = getDb();
    const row = db.prepare(`SELECT interaction_log FROM people_memory WHERE slack_id = ?`).get(slackId) as { interaction_log: string | null } | undefined;
    if (!row?.interaction_log) return [];
    const all = JSON.parse(row.interaction_log) as InteractionLogEntry[];
    if (!Array.isArray(all)) return [];
    return all.filter(e => e.type !== 'meeting_booked' && e.type !== 'coordination').slice(-limit);
  } catch (err) {
    logger.warn('recentColleagueContext threw', { slackId, err: String(err).slice(0, 200) });
    return [];
  }
}

// ── Item builders by kind ────────────────────────────────────────────────────

function buildApprovalItem(r: RequestRow, timezone: string): RichItem {
  const det = parseDetails<Record<string, unknown>>(r) ?? {};
  const slotsArr = Array.isArray(det.slots) ? (det.slots as any[]) : [];
  return {
    kind: 'approval',
    request_id: r.id,
    state: r.state,
    subkind: r.subkind,
    subject: r.subject,
    ask_text: r.description,
    requester_name: r.requester_name ?? det.requester_name ?? null,
    requester_slack_id: r.requester_slack_id ?? null,
    expires_at: r.expires_at,
    expires_at_relative: r.expires_at ? relativeTime(r.expires_at, timezone) : null,
    proposed_start: det.proposed_start ?? det.start ?? det.winning_slot ?? null,
    proposed_end: det.proposed_end ?? det.end ?? null,
    winning_slot: det.winning_slot ?? null,
    slots: slotsArr,
    payload: det,
    closure_reason: r.closure_reason,
    closed_at: r.closed_at,
    closed_at_relative: r.closed_at ? relativeTime(r.closed_at, timezone) : null,
    recent_context: recentColleagueContext(r.requester_slack_id, 3),
  };
}

function buildOutreachItem(
  r: RequestRow,
  ownerCalendarEvents: CalendarEvent[],
  profile: UserProfile,
  timezone: string,
): RichItem {
  const det = parseDetails<Record<string, unknown>>(r) ?? {};
  const msgPreview = String(det.message ?? r.description ?? '').slice(0, 200);
  const replyText = (det.reply_text as string | undefined) ?? null;

  let replyPreview: string | null = replyText;
  if (!replyPreview && det.conversation_json) {
    try {
      const conv = JSON.parse(det.conversation_json as string) as Array<{ role: string; content: string }>;
      const lastColleague = [...conv].reverse().find(m => m.role === 'user');
      if (lastColleague) replyPreview = lastColleague.content.slice(0, 200);
    } catch (_) {}
  }

  const awaitsReply = det.await_reply !== false && det.await_reply !== 0 && r.state === 'awaiting_colleague';
  const statusLabel = r.state === 'awaiting_colleague'
    ? (awaitsReply ? 'sent, awaiting reply' : "sent — they're handling it on their side")
    : r.state === 'in_flight'
      ? (det.scheduled_at ? `scheduled to go out ${relativeTime(det.scheduled_at as string, timezone)}` : 'in flight')
      : r.state === 'resolved'
        ? (replyPreview ? 'replied' : 'done')
        : r.state;

  let verifiedOutcome: ScheduleOutcome | null = null;
  if (ownerCalendarEvents.length > 0 && det.proposed_slots) {
    try {
      const slots = JSON.parse(det.proposed_slots as string) as string[];
      verifiedOutcome = verifyScheduledOutcome(
        {
          proposedSlots: Array.isArray(slots) ? slots : [],
          subjectKeyword: det.subject_keyword as string | undefined,
          colleagueSlackId: r.target_slack_id ?? undefined,
        },
        ownerCalendarEvents,
        profile,
      );
    } catch (err) {
      logger.warn('brief verifier — outreach verify threw, falling back', { id: r.id, err: String(err).slice(0, 200) });
    }
  }

  const item: RichItem = {
    kind: 'outreach',
    request_id: r.id,
    state: r.state,
    colleague: r.target_name,
    topic: msgPreview,
    status: statusLabel,
    sentWhen: det.sent_at ? relativeTime(det.sent_at as string, timezone) : undefined,
    scheduledFor: det.scheduled_at && r.state === 'in_flight'
      ? DateTime.fromISO(det.scheduled_at as string).setZone(timezone).toFormat('EEEE d MMM')
      : undefined,
    theyReplied: !!replyPreview,
    replyPreview: replyPreview ?? undefined,
    awaitsReply,
    closure_reason: r.closure_reason,
    closed_at: r.closed_at,
    closed_at_relative: r.closed_at ? relativeTime(r.closed_at, timezone) : null,
    recent_context: recentColleagueContext(r.target_slack_id, 3),
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

function buildTaskItem(r: RequestRow, timezone: string): RichItem {
  const det = parseDetails<Record<string, unknown>>(r) ?? {};
  return {
    kind: r.state === 'resolved' || r.state === 'cancelled' || r.state === 'expired' ? 'completed_task' : 'open_task',
    request_id: r.id,
    state: r.state,
    title: r.subject,
    description: r.description,
    dueAt: r.next_check_at ? relativeTime(r.next_check_at, timezone) : undefined,
    context: det.message ?? det.subject ?? undefined,
    target_name: r.target_name,
    closure_reason: r.closure_reason,
    closed_at: r.closed_at,
    closed_at_relative: r.closed_at ? relativeTime(r.closed_at, timezone) : null,
    recent_context: recentColleagueContext(r.target_slack_id, 3),
  };
}

function buildItemForRow(
  r: RequestRow,
  ownerCalendarEvents: CalendarEvent[],
  profile: UserProfile,
  timezone: string,
): RichItem {
  if (r.kind === 'approval') return buildApprovalItem(r, timezone);
  if (r.kind === 'outreach' || r.kind === 'social_outreach') return buildOutreachItem(r, ownerCalendarEvents, profile, timezone);
  return buildTaskItem(r, timezone);
}

// ── Data collection (v2.7.0 — requests-spine) ────────────────────────────────

async function collectBriefingData(
  ownerUserId: string,
  timezone: string,
  profile: UserProfile,
): Promise<BriefingData> {
  const db = getDb();
  const items: RichItem[] = [];
  const requestIdsToSurface: string[] = [];
  const requestIdsToStale: string[] = [];

  // Pre-fetch owner's calendar for verifier.
  let ownerCalendarEvents: CalendarEvent[] = [];
  try {
    // v3.3.x (M-11) — narrowed today+30 → today+7. The brief renders today/
    // tomorrow, the auto-categorize sweep covers today..today+7, and coord/
    // outreach outcome verification matches proposed slots inside this window.
    // A coordination proposed >7 days out simply won't get a "booked ✓" line in
    // the brief until the date nears (verifyScheduledOutcome returns 'none' →
    // no outcome block, the item stays "collecting"); it never prints a false
    // "missing meeting". Calendar HEALTH keeps its own (now 21-day) window.
    const calFrom = DateTime.now().setZone(timezone).minus({ days: 2 }).toFormat('yyyy-MM-dd');
    const calTo = DateTime.now().setZone(timezone).plus({ days: 7 }).toFormat('yyyy-MM-dd');
    ownerCalendarEvents = await getCalendarEvents(profile.user.email, calFrom, calTo, timezone);
  } catch (err) {
    logger.warn('brief — calendar fetch failed', { err: String(err).slice(0, 200) });
  }

  // Today + tomorrow calendar surface.
  if (ownerCalendarEvents.length > 0) {
    try {
      const processed = processCalendarEvents(
        ownerCalendarEvents,
        profile.user.email,
        profile.user.name,
        timezone,
        profile,
        // The morning brief is an owner-only DM surface — sendMorningBriefing's
        // 'send_briefing_now' tool path is unreachable in a room (the tool is
        // absent from both COLLEAGUE_ALLOWED_TOOLS and OWNER_ROOM_ACTION_TOOLS,
        // skills/registry.ts) and the scheduled cron always targets
        // routine.owner_channel. Defaulting to 'other' here (pre-fix) rendered
        // the owner's own Personal-category events as [Private] with no
        // attendees in his own brief.
        'owner',
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
          location: e.location,
          categories: e.categories,
          is_floating_block: e.is_floating_block,
        }));

      const todays = summarize(processed.filter(e => e._localDate === todayLocal));
      const tomorrows = summarize(processed.filter(e => e._localDate === tomorrowLocal));
      if (todays.length > 0) items.push({ kind: 'calendar_today', date: DateTime.now().setZone(timezone).toFormat('EEEE d MMM'), events: todays });
      if (tomorrows.length > 0) items.push({ kind: 'calendar_tomorrow', date: DateTime.now().setZone(timezone).plus({ days: 1 }).toFormat('EEEE d MMM'), events: tomorrows });
    } catch (err) {
      logger.warn('brief — calendar surface build threw', { err: String(err).slice(0, 200) });
    }
  }

  // Auto-categorize sweep.
  if (ownerCalendarEvents.length > 0 && (profile.categories ?? []).length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ac = require('../utils/autoCategorize') as typeof import('../utils/autoCategorize');
      const todayStart = DateTime.now().setZone(timezone).startOf('day').toMillis();
      const sevenDaysOut = todayStart + 7 * 24 * 60 * 60 * 1000;
      const upcoming = ownerCalendarEvents.filter(ev => {
        const t = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' }).toMillis();
        return t >= todayStart && t < sevenDaysOut;
      });
      const candidates = ac.pickUncategorizedEvents(upcoming, profile);
      if (candidates.length > 0) {
        const BATCH_CAP = 20;
        const batch = candidates.slice(0, BATCH_CAP);
        const acResult = await ac.autoCategorizeEvents({ events: batch, profile });
        if (acResult.applied.length > 0 || acResult.skipped_unmatched.length > 0) {
          items.push({
            kind: 'auto_categorized',
            applied: acResult.applied,
            skipped_unmatched: acResult.skipped_unmatched,
            attempted: acResult.attempted,
            had_more_uncategorized: candidates.length > BATCH_CAP,
          });
        }
      }
    } catch (err) {
      logger.warn('brief — auto-categorize threw', { err: String(err).slice(0, 200) });
    }
  }

  // ── Requests-spine walk ───────────────────────────────────────────────────
  const todayStart = todayStartUtcIso(timezone);
  const requests = getRequestsForBrief(ownerUserId, todayStart);

  for (const r of requests) {
    const item = buildItemForRow(r, ownerCalendarEvents, profile, timezone);
    items.push(item);
    requestIdsToSurface.push(r.id);

    // Auto-park at surface threshold — ONLY for awaiting_owner items. The
    // intent is "owner ignored this N times, stop nagging." Doesn't apply to:
    //   - awaiting_colleague (we're waiting on someone else; owner can't unblock)
    //   - in_flight (autonomous scheduled fire — reminders, scheduled outreach,
    //     research). Auto-cancelling these would kill the reminder before it fires.
    if (r.state === 'awaiting_owner' && r.surfaced_count + 1 >= STALE_SURFACE_THRESHOLD) {
      requestIdsToStale.push(r.id);
    }
  }

  // Tombstoned colleagues — preserved from v2.5.2.
  try {
    const tombstoneRows = db.prepare(`
      SELECT erl.slack_id, erl.created_at, pm.name
      FROM engagement_rank_log erl
      LEFT JOIN people_memory pm ON pm.slack_id = erl.slack_id
      WHERE erl.new_rank = 0
        AND erl.delta < 0
        AND erl.reason IN ('no_reply_to_ping', 'no_social_response_to_coda')
        AND datetime(erl.created_at) >= datetime('now', '-24 hours')
      ORDER BY erl.created_at DESC
    `).all() as Array<{ slack_id: string; created_at: string; name: string | null }>;
    const seen = new Set<string>();
    for (const row of tombstoneRows) {
      if (seen.has(row.slack_id)) continue;
      seen.add(row.slack_id);
      items.push({ kind: 'tombstoned_colleague', name: row.name ?? row.slack_id, tombstoned_at: row.created_at });
    }
  } catch (err) {
    logger.warn('brief — tombstone collection threw', { err: String(err).slice(0, 200) });
  }

  // Pronoun map.
  const peopleGender: Record<string, 'he' | 'she' | 'they'> = {};
  const peopleRows = db.prepare(`SELECT name, gender FROM people_memory WHERE gender IS NOT NULL`).all() as Array<{ name: string; gender: string }>;
  for (const row of peopleRows) {
    if (!row.name) continue;
    const firstName = row.name.split(' ')[0];
    peopleGender[row.name] = pronounFor(row.gender);
    if (firstName && !peopleGender[firstName]) peopleGender[firstName] = pronounFor(row.gender);
  }

  return { items, requestIdsToSurface, requestIdsToStale, peopleGender };
}

// ── Sonnet generation (unchanged from v2.6.x) ────────────────────────────────

async function generateBriefingText(
  items: RichItem[],
  profile: UserProfile,
  peopleGender: Record<string, 'he' | 'she' | 'they'> = {},
  newsBundle?: NewsBundle,
  healthSummary?: string,
  slotHoldsSummary?: string,
  newsTimedOut = false,
): Promise<string> {
  // v3.2.6 — news is additive: it only changes the brief when there's grounded
  // material. Empty bundle (news off / nothing found / no derived companies) →
  // the brief is byte-identical to before this feature.
  const hasNews = !!(newsBundle && newsBundle.sources.length > 0);
  // v3.x — today's calendar-health summary folded into the brief (replaces the
  // separate morning health routine). Additive like news: the caller only
  // passes a summary when the health pass had something to say (it drops the
  // text on `vacuous` — see the gather site), so presence IS the signal.
  const hasHealth = !!(healthSummary && healthSummary.trim().length > 0);
  // o#180 — the timeout branch is distinct from "genuinely nothing to
  // report": `newsTimedOut` only reaches here when the Promise.race in
  // sendMorningBriefing lost to the clock, never on an empty-but-completed
  // gather. That's the one case the composer must say something about.
  const newsIncomplete = !hasNews && newsTimedOut;

  if (items.length === 0 && !hasNews && !hasHealth) {
    // No time-of-day greeting on line 1 — the Slack app shows the first line
    // as the preview, so lead with the useful state, not "Morning —".
    return newsIncomplete
      ? `All clear — nothing new today. Didn't get to check today's updates in time — I'll fold them in next time.`
      : `All clear — nothing new today.`;
  }

  const anthropic = getAnthropicClient();
  const firstName = profile.user.name.split(' ')[0];
  const dataText = JSON.stringify(items, null, 2);
  // v3.x — pin the brief to the owner's configured language (generic; no
  // hardcoded language list). The brief is a standalone compose pass with no
  // inbound message to match, so the owner's profile language is the source.
  const ownerLangName = (() => {
    try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(profile.user.language) ?? profile.user.language; }
    catch { return profile.user.language; }
  })();
  // v3.x — owner's learned BRIEF preferences (free-text, per-skill MD). '' when
  // none. Same layer as calendar prefs; owner-private by nature (his brief).
  const briefPrefs = formatSkillPreferencesBlock(profile, 'brief', { label: 'BRIEF' });

  // v3.2.6 — the Updates (news) instruction + the rolling 7-day dedup log. Only
  // present when there's grounded news material this morning, so the brief is
  // unchanged when news is off / empty.
  const newsBlock = hasNews
    ? `

UPDATES (news) — after the calendar/tasks body, add an "Updates" section of news that matters to ${firstName}, drawn ONLY from the NEWS SOURCES in the data below. Rules:
- RELEVANCE IS THE BAR. Include only items genuinely relevant to ${firstName}'s interests — NEVER add a marginal/off-topic one just to reach a count. Up to 7 items: when you have 6–7 genuinely relevant ones, show them (he skims and picks); when only 2–3 are relevant, show 2–3; if only 1, show 1. 7 is the ceiling, not a target — do not pad.
- Only genuinely NEW developments from the last 7 days. Skip anything older, and skip anything already in the "already covered" log below.
- MERGE same-story duplicates WITHIN today's set: if two sources report the SAME event/development (even from different outlets or worded differently — e.g. the same funding round, the same acquisition, the same company's valuation), produce exactly ONE bullet, citing the best source. Never list the same story twice.
- Each bullet cites its source as a Slack hyperlink: <url|short label> (e.g. <https://...|Reuters>). NEVER paste a bare URL, and NEVER write "[link]" followed by the URL — that doubles the text. One compact hyperlink per bullet.
- NEVER assert a current-events fact not present in the sources.
- If a topic/company returned nothing, just leave it out — do NOT add an apology or a "couldn't find anything on X" line. If nothing new at all, OMIT the Updates section entirely (no empty heading).
Write it in ${ownerLangName}.${formatSeenLogBlock(profile)}`
    : newsIncomplete
    // o#180 — the gather lost the race against the clock (not "nothing new");
    // say so in ONE short line so the owner can tell "dropped for cause" apart
    // from a genuinely quiet news day, without composing a full section or
    // inventing any content.
    ? `

UPDATES (news) — the news check didn't finish in time this morning, so there's no Updates section. Add ONE short plain-text line (not a section, no heading) noting that near the end of the brief, in ${ownerLangName} — e.g. "Didn't get to check today's updates in time, I'll fold them in next time." Do NOT invent or guess at any news content.`
    : '';

  const systemPrompt = `You are writing a morning briefing for ${firstName} from their AI executive assistant ${profile.assistant.name}.

LANGUAGE — write the entire brief in ${ownerLangName} (${firstName}'s language). Proper nouns (names, meeting titles) keep their original spelling.

STRUCTURE (in this order):
1. TODAY'S CALENDAR — this is the FIRST line of the message. Only if a calendar_today item is present; apply the CALENDAR LISTING FORMAT block below. When no calendar_today item exists, the first line is instead the first notable item (step 3).
2. TOMORROW (one short line) — only if calendar_tomorrow is present AND there's something notable.
3. The rest — per-person paragraphs for colleagues who have open or recently-changed work, plus freestanding lines for items not tied to a specific person (calendar conflicts, pending approvals, auto-categorizations, etc.). No separate "ACTION ITEMS" section — every open or notable item gets narrated ONCE in the body, in whichever spot reads most naturally.

Principle: nobody can assign ${firstName} work. Only HIS rules / HIS calendar / HIS approvals deserve to be surfaced as "needs your call". Random colleague drafts, suggestions, or "what do you think?" pings stay in the per-person paragraph as conversation, not as a decision request.

APPROVAL CONTEXT RULE: when a request item has kind='approval', USE the ask_text + subject + requester_name + payload fields. NEVER ask ${firstName} what the item is about — he filed it through you. If a critical field is missing, surface the gap honestly ("I have a pending Julia approval but the context didn't come through — let me dig") rather than asking him.

CLOSURE NARRATION: When a request has a closure_reason and state in (resolved / cancelled / expired), narrate it as past tense closure in the colleague's paragraph — there's nothing left to act on. Use the closed_at_relative field on the item to anchor the narration in time ("Yesterday: ...", "Earlier today: ...") so ${firstName} doesn't read a stale close as today's news.
- closure_reason='surfaced_threshold' → "I stopped working on X — let me know if you want me to revive it." (one passive line; this is auto-park after 3 surfaces with no action)
- closure_reason starting with 'owner_' → YOUR own decision, not an outbound action. Narrate as "${firstName} said <closure_reason>, so I closed the X coord — nothing to do." NEVER claim "I told <requester>" / "I let <name> know" — those imply a DM you sent. Only describe an outbound DM when the item has target_slack_id set AND closure actually involved a colleague reply or relay (e.g., closure_reason='colleague_replied').
- closure_reason='colleague_replied' → describe the reply.
- closure_reason='meeting_cascade' / starts with 'parent_' → "the meeting got moved/cancelled, so I closed X."

${calendarListingFormatRule(firstName)}

FORMAT:
- Plain text only. • for bullets. *single asterisks* for bold. NEVER **double**.

WHAT GETS SURFACED:
- Everything still open AND every closure ${firstName} hasn't been informed about yet. Don't hide stuff he should know about.
- Prefer OUTCOME / current state over activity.
- Skip internal plumbing.

TONE + PHRASING:
- First person as the assistant. "I reached out...", "I'm waiting on...".
- Time windows in human terms.
- Don't write a status report — be concise; outcome over activity.

PERSPECTIVE: You are the assistant. ${firstName} is the owner. Write from the assistant's POV.
- NEVER "your message" — say "my message".
- NEVER "you messaged X" — ${firstName} didn't message anyone, I did.

CONTENT OVER ACTIVITY:
WRONG: "Alex replied to your message"
RIGHT: "Alex got back to me — he's fine with the plan, will add you to the next invite"

TASK OWNERSHIP:
- open requests = I'm executing on ${firstName}'s behalf. "I'm working on X", "I'll follow up".
- AWAITING-EXTERNAL = WATCHING — don't surface as a decision request. "I'm waiting on X" reads as status, not a needs-his-call.
- ONE-PLACE RULE — every item belongs in ONE spot in the brief. Don't narrate the same conflict / approval / status twice (once as a freestanding line and again inside a per-person paragraph, or vice versa). Pick the surface that reads most naturally and put it only there.
- MULTI-CONFLICT AGGREGATION — bundle, don't enumerate.
- outreach awaiting_colleague with no decision → "X hasn't replied — want me to try again or drop it?"
- approval in state="awaiting_colleague" → ${firstName}'s counter was RELAYED to requester_name and they have NOT replied yet. Say "waiting to hear back from <name> on <subject>". NEVER state or imply the requester said something, pushed back, or rejected the counter — there is no reply on record. "Relayed your counter to Eli, no word back yet" ✅. "Eli said the counter doesn't work" ❌ (you have no message from them). When expires_at_relative is set and close (today/tomorrow), anchor the nudge to it — "waiting on Mike; this lapses tomorrow if he doesn't come back, worth a poke" — so ${firstName} knows it's about to time out, not open indefinitely.
- kind="tombstoned_colleague" → ONE passive past-tense line about the PERSON in plain human words. ✅ "I'll stop pinging Yael for now — she hasn't replied to a few of my pings, will pick it back up when she's around." ❌ "Yael is no longer active in the system" / "removed from my working list" / "deactivated her record" / any phrasing that exposes internal tracking, system state, or bot framing.
- kind="auto_categorized":
  - For events in \`applied\` (categories Maelle figured out) → ONE informational past-tense line, NOT a question. ("Tagged 'X' as Weekly.")
  - For events in \`skipped_unmatched\` (categories Maelle TRIED to auto-tag but couldn't pick) → SIGNAL that you tried + ASK what category it is, OPEN-ENDED. The "tried" framing matters: owner cares that you ATTEMPTED before asking, not that you didn't even look. ✅ "Tried to auto-tag 'Alex & Jordan' but couldn't decide — what category should that be?" ✅ "Couldn't auto-tag 'Acme & Blake' — what category is that?" ❌ "'Alex & Jordan' has no category. What should I tag it as?" (reads as if you didn't try) ❌ "Want me to tag 'Alex & Jordan' as Weekly too?" / "Should I tag it as X, or something else?" — never propose a specific category as the default in the question; that primes the wrong answer when you genuinely don't know.

AWAIT-REPLY AWARENESS:
- If outreach has awaitsReply=false, narrate past-tense closed loop ("I let X know"), don't say "still waiting".

VERIFIED OUTCOMES — meeting Maelle proposed was booked by someone else:
- verified_outcome.status="booked_compliant" → past tense, closed.
- verified_outcome.status="booked_conflict" → surface the issues so ${firstName} can decide.

PRONOUNS — use the provided gender map. If a person isn't in the map, use "they".

PEOPLE_GENDER:
${Object.keys(peopleGender).length > 0
  ? Object.entries(peopleGender).map(([name, p]) => `  ${name}: ${p}`).join('\n')
  : '  (no gender data available — use "they" for all)'}${briefPrefs}${newsBlock}`;

  // v3.2.6 — append the grounded news sources to the data so Sonnet can write +
  // cite the Updates section. Only when there's material (keeps tokens at zero
  // when news is off/empty).
  const newsPart = hasNews
    ? `\n\nNEWS SOURCES (for the Updates section — write grounded in these and cite each as <url|label>):\n${JSON.stringify({ sources: newsBundle!.sources }, null, 2)}`
    : '';
  const healthPart = hasHealth
    ? `\n\nCALENDAR HEALTH (today only) — fold this into the brief as a short, human "Calendar" note: what you auto-fixed today and what needs ${firstName}'s call today. Plain sentences, no header, no tool names. Today's issues only; the full week is handled separately at midday:\n${healthSummary!.trim()}`
    : '';
  // #30 — active slot holds, so ${firstName} can see if tentative reservations
  // are piling up (overuse oversight; there's no hard global cap by design).
  const hasHolds = !!(slotHoldsSummary && slotHoldsSummary.trim().length > 0);
  const holdsPart = hasHolds
    ? `\n\nSLOT HOLDS — tentative reservations currently open (not booked yet). Fold into the brief as a brief, human note ONLY if it's worth ${firstName}'s attention (e.g. several open, or one sitting a while). Plain sentences, no header:\n${slotHoldsSummary!.trim()}`
    : '';
  const userContent = `Write the morning briefing based on this data:\n\n${dataText}${newsPart}${healthPart}${holdsPart}`;

  try {
    const response = await anthropic.messages.create({
      ...SONNET,
      // v4.0.x — the brief composes on adaptive thinking at `medium`. Thinking-off
      // Sonnet 5 made a poor surface-or-omit judgment (dropped a genuinely-new news
      // section); a light reasoning pass fixes the call. It's a 1x/day cron, so the
      // cost is negligible. max_tokens bumped well above the old 800/1100 (which were
      // sized for thinking-OFF, response-text-only) because thinking now shares the
      // output budget — the old ceiling would truncate the moment it reasons.
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      max_tokens: (hasNews || hasHealth || hasHolds) ? 6000 : 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });
    // find the TEXT block — with thinking on, content[0] is a thinking block.
    return ((response.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined)?.text ?? '').trim();
  } catch (err) {
    logger.error('Briefing AI generation failed — falling back to simple format', { err: String(err) });
    return buildFallbackBriefing(items, profile);
  }
}

function buildFallbackBriefing(items: RichItem[], _profile: UserProfile): string {
  // No time-of-day greeting header — lead straight with the items so the
  // Slack preview (first line) carries real content, not "Morning —".
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === 'outreach')        lines.push(`• ${item.colleague}: ${item.status}`);
    if (item.kind === 'coordination')    lines.push(`• ${item.colleague} / ${item.subject}: ${item.status}`);
    if (item.kind === 'approval')        lines.push(`• ${item.requester_name ?? 'someone'}: ${item.subject}`);
    if (item.kind === 'open_task')       lines.push(`• ${item.title}`);
    if (item.kind === 'completed_task')  lines.push(`• Done: ${item.title}`);
  }
  return lines.join('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function sendMorningBriefing(
  app: App,
  profile: UserProfile,
  ownerChannel: string,
  force: boolean = false,
  // v3.x — when the brief is requested IN a thread (owner asks "daily brief"
  // inside the Slack assistant panel / a DM thread), post it back INTO that
  // thread so it stays in the conversation. Omitted on the SCHEDULED fire
  // (routine path) → top-level DM, which is correct for the morning push.
  threadTs?: string,
): Promise<void> {
  const ownerUserId = profile.user.slack_user_id;

  // Daily dedup.
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

  // Pre-pass cleanup (kept) — close requests linked to vanished calendar events.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { cleanupVanishedMeetingArtifacts } = require('../utils/cleanupVanishedMeetingArtifacts') as
      typeof import('../utils/cleanupVanishedMeetingArtifacts');
    await cleanupVanishedMeetingArtifacts({ ownerUserId, ownerEmail: profile.user.email });
  } catch (err) {
    logger.warn('Brief pre-pass cleanup threw — continuing', { err: String(err).slice(0, 200) });
  }

  const { items, requestIdsToSurface, requestIdsToStale, peopleGender } =
    await collectBriefingData(ownerUserId, profile.user.timezone, profile);

  // Log brief was sent.
  const { logEvent } = require('../db');
  logEvent({
    ownerUserId,
    type: 'task_update',
    title: 'morning_briefing_sent',
    detail: DateTime.now().setZone(profile.user.timezone).toFormat('yyyy-MM-dd'),
  });
  markEventsSeen(ownerUserId);

  // v3.2.6 — personalized news (gated + best-effort + fail-open). Gather BEFORE
  // compose (the brief is a single direct Sonnet pass with no tool loop) and
  // fold a grounded "Updates" section in. A slow/empty gather never delays or
  // breaks the brief — calendar + tasks always ship.
  let newsBundle: NewsBundle | undefined;
  // o#180 — distinct from "genuinely nothing to report": set only when the
  // race above timed out, so the composer can say "didn't get to check in
  // time" instead of silently dropping the whole Updates section.
  let newsTimedOut = false;
  if ((profile.skills as any)?.news === true) {
    try {
      const meetingCompanies = deriveMeetingCompanies(items, profile);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { gatherNews } = require('../skills/news') as typeof import('../skills/news');
      const newsTimeoutMs = force ? NEWS_BRIEF_TIMEOUT_MS_ON_DEMAND : NEWS_BRIEF_TIMEOUT_MS;
      const gathered = await Promise.race([
        gatherNews(profile, { meetingCompanies }),
        new Promise<undefined>(res => { const t = setTimeout(() => res(undefined), newsTimeoutMs); if (typeof t.unref === 'function') t.unref(); }),
      ]);
      // #167 — gatherNews (news.ts) never resolves to `undefined` itself (it
      // NEVER throws and always returns a NewsBundle, even an empty one on
      // total internal failure); `undefined` here can ONLY mean the timeout
      // branch of the race above won. So this is the one place that can tell
      // "the pass never finished in time" apart from "it finished and there
      // was genuinely nothing new" — log them distinctly (WARN vs INFO) so a
      // dropped-for-cause morning doesn't read as a quiet news day, and so the
      // signal lands HERE, synchronously, rather than relying on gatherNews's
      // own eventual success/failure log line — which keeps running after
      // losing the race and can land well after the brief has already sent.
      if (!gathered) {
        newsTimedOut = true;
        logger.warn('briefs — news gather timed out, composing without it', { timeoutMs: newsTimeoutMs, force });
      } else if (gathered.sources.length > 0) {
        newsBundle = gathered;
      } else {
        logger.info('briefs — news gather returned no sources (quiet day or no goals), composing without it');
      }
    } catch (err) {
      logger.warn('briefs — news gather threw, composing without it', { err: String(err).slice(0, 200) });
    }
  }

  // v3.x — today-scoped calendar health, folded into the ONE morning brief
  // (replaces the separate 07:00 standalone health routine). Active mode so it
  // auto-fixes today's issues; scoped to TODAY only — the 13:00 routine still
  // runs the full this-week + next-week sweep. Best-effort + fail-open + timed
  // like news: a slow/erroring pass never delays or breaks the brief. The tool
  // returns its result via `summary_text` and does NOT post its own owner
  // message (the busy_day DM was retired in v2.3.1), so there's no double-send.
  let healthSummary: string | undefined;
  if ((profile.skills as Record<string, unknown> | undefined)?.calendar === true) {
    try {
      const today = DateTime.now().setZone(profile.user.timezone).toFormat('yyyy-MM-dd');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { executeSkillTool } = require('../skills/registry') as typeof import('../skills/registry');
      const healthCtx = {
        profile,
        threadTs: threadTs ?? `brief_health_${ownerUserId}`,
        channelId: ownerChannel,
        userId: ownerUserId,
        senderRole: 'owner' as const,
        // v4.4.x (#154) — this is the scheduled morning brief's own
        // today-scoped health pass: always a private owner-alone run, never
        // a live conversation. Declared explicitly now that the fields are
        // required (skills/types.ts SkillContext).
        authority: 'owner' as const,
        surface: 'owner_dm' as const,
        channel: 'slack' as const,
        app,
      };
      const res = await Promise.race([
        executeSkillTool('check_calendar_health', { mode: 'active', start_date: today, end_date: today }, healthCtx),
        new Promise<undefined>(r => { const t = setTimeout(() => r(undefined), BRIEF_HEALTH_TIMEOUT_MS); if (typeof t.unref === 'function') t.unref(); }),
      ]);
      // Read the tool's own `vacuous` flag ("nothing worth saying" —
      // checkHealth.ts:1591), the same structured signal dispatchRoutine rides
      // (dispatchers/routine.ts:30). Pre-fix the brief threw the flag away and re-derived
      // it with an English regex over the composed prose, which broke the
      // moment a template was reworded or an issue description happened to
      // contain "looks good" — and the brief itself is composed in the owner's
      // configured language, so prose-sniffing was never a safe signal.
      const health = (res && typeof res === 'object') ? res as { summary_text?: unknown; vacuous?: unknown } : undefined;
      const summary = health?.summary_text;
      if (health?.vacuous === true) {
        logger.info('briefs — calendar-health pass vacuous, omitting from brief');
      } else if (typeof summary === 'string' && summary.trim().length > 0) {
        healthSummary = summary.trim();
      }
    } catch (err) {
      logger.warn('briefs — calendar-health gather threw, composing without it', { err: String(err).slice(0, 200) });
    }
  }

  // #30 — active slot holds, surfaced for overuse oversight (no hard global cap
  // by design — the brief is how the owner notices if holds are piling up).
  let slotHoldsSummary: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getActiveSlotHolds, getRecentlyFulfilledHolds } = require('../db/slotHolds') as typeof import('../db/slotHolds');
    const holds = getActiveSlotHolds(ownerUserId);
    const lines: string[] = [];
    if (holds.length > 0) {
      lines.push(...holds.map(h => {
        const when = DateTime.fromISO(h.start_iso).setZone(profile.user.timezone);
        const whenLabel = when.isValid ? when.toFormat('EEE d MMM HH:mm') : h.start_iso;
        const since = DateTime.fromISO((h.created_at || '').replace(' ', 'T'), { zone: 'utc' });
        const ageHrs = since.isValid ? Math.round(DateTime.now().diff(since, 'hours').hours) : null;
        return `- ${h.holder_name}: ${whenLabel}${h.subject ? ` (${h.subject})` : ''}${h.reason ? ` — ${h.reason}` : ''}${ageHrs != null ? `, held ${ageHrs}h` : ''}`;
      }));
    }
    // Auto-resolved holds (became real meetings since the last brief) — a closed
    // loop to report, not an open reservation.
    const fulfilled = getRecentlyFulfilledHolds(ownerUserId, 24);
    if (fulfilled.length > 0) {
      lines.push(...fulfilled.map(h => {
        const when = DateTime.fromISO(h.start_iso).setZone(profile.user.timezone);
        const whenLabel = when.isValid ? when.toFormat('EEE d MMM HH:mm') : h.start_iso;
        return `- (resolved) the ${whenLabel} hold for ${h.holder_name}${h.subject ? ` (${h.subject})` : ''} became a real meeting — I released the hold.`;
      }));
    }
    if (lines.length > 0) slotHoldsSummary = lines.join('\n');
  } catch (err) {
    logger.warn('briefs — slot-holds gather threw, continuing', { err: String(err).slice(0, 150) });
  }

  // Generate + send.
  const rawText = await generateBriefingText(items, profile, peopleGender, newsBundle, healthSummary, slotHoldsSummary, newsTimedOut);

  // v2.7.1 (bug 4.5) — humanGate the brief. The brief generator skipped the
  // owner-facing voice check that postReply.ts applies to regular replies,
  // letting machine framing leak ("Yael is no longer active in the system",
  // "removed from my working list"). One Sonnet rewrite pass on flag.
  let textToSend = rawText;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runHumanGate } = require('../utils/humanGate') as typeof import('../utils/humanGate');
    // Brief always goes to the owner — audience='owner'.
    const verdict = await runHumanGate(rawText, profile, 'owner');
    if (!verdict.ok && verdict.rewrite) {
      textToSend = verdict.rewrite;
      logger.info('briefs — humanGate rewrote the brief', { ownerUserId });
    }
  } catch (err) {
    logger.warn('briefs — humanGate threw, sending raw', { err: String(err).slice(0, 200) });
  }

  // What goes into thread history: the gated text, before decoration. The glyph
  // is transport garnish and the interactive path stores undecorated drafts too.
  const briefForHistory = textToSend;

  // ☀️ briefing glyph so the daily thread reads distinct in the sidebar (the
  // owner's OWN threads never get an icon). Added AFTER humanGate so the gate
  // never sees/rewrites the emoji.
  textToSend = `☀️ ${textToSend}`;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getConnection } = require('../connections/registry') as typeof import('../connections/registry');
  const conn = getConnection(ownerUserId, 'slack');
  if (conn) {
    // v3.2.6 — when the brief carries news source links, suppress Slack's
    // link/media unfurl so it doesn't balloon into 15–20 previews.
    const posted = await conn.postToChannel(ownerChannel, textToSend, {
      ...(threadTs ? { threadTs } : {}),
      ...(newsBundle ? { unfurl: false } : {}),
    });
    // The brief is the other post Maelle makes on her OWN initiative, and the
    // owner answers it in-thread ("move the 3pm", "what's item 3?"). Nothing
    // recorded it in `conversations`, so that reply loaded an empty history and
    // she had to re-derive the whole day — the same gap the routine dispatcher
    // had. On the ON-DEMAND path the gap is half as wide and just as real: the
    // brief short-circuit (processMessage.ts:500) returns before postReply, so
    // his ask was stored and the answer wasn't.
    //
    // Same appendToConversation the interactive path uses, one assistant row, no
    // invented inbound. Keyed on the thread he replies into: the thread he ASKED
    // in when he requested it, otherwise the scheduled post's own ts, which
    // becomes the thread root.
    if (posted.ok) {
      const historyThread = threadTs ?? posted.ts;
      if (historyThread) {
        appendToConversation(historyThread, ownerChannel, {
          role: 'assistant',
          content: `[Morning brief posted]\n${briefForHistory}`,
        });
      }
    }
  } else {
    logger.warn('briefs — no Slack connection registered', { ownerUserId });
  }

  // v3.2.6 — fire-and-forget the seen-log write so tomorrow's brief / an
  // on-demand ask doesn't repeat today's stories (topic-level dedup). Non-fatal.
  if (newsBundle) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { writeSeenLog } = require('../skills/news') as typeof import('../skills/news');
    // v3.3.x — pass the posted brief so the seen-log records only the SHOWN
    // (cited) items, not the whole gathered bundle. Unshown-but-recent articles
    // then resurface on tomorrow's re-pull instead of being silently buried.
    void writeSeenLog(profile, newsBundle, { briefText: textToSend }).catch(() => { /* non-fatal */ });
  }

  // POST-BRIEF: stamp surfaced + auto-park stale items.
  // Stamp goes FIRST so surfaced_count is reflective; stale closures land
  // after — those rows will surface ONE more time next brief with closure
  // narration ("I stopped working on X"), then drop.
  markRequestSurfaced(requestIdsToSurface);
  for (const id of requestIdsToStale) {
    // v3.1 (Path 2) — closing-strength guarantee #3: when the brief auto-parks
    // a colleague-INITIATED request the owner ignored N times, the requester
    // must hear back too — otherwise they're left hanging ("Maelle said she'd
    // ask Idan, then silence"). Mirrors runExpiry's requester loop-close. Only
    // fires for colleague-initiated rows (requester set, != owner); owner-self
    // requests have no external party to notify. Fire-and-forget before close.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getRequest } = require('../db/requests') as typeof import('../db/requests');
      const r = getRequest(id);
      // v3.1 — honor the requester_notified_at dedup contract (same as the
      // resolver + closeMeetingArtifacts paths) so we never double-DM a
      // requester who was already told through another path.
      if (conn && r && r.requester_slack_id && r.requester_slack_id !== ownerUserId && !r.requester_notified_at) {
        const requesterFirst = r.requester_name?.split(' ')[0] ?? 'there';
        const ownerFirst = profile.user.name.split(' ')[0];
        const subjectText = r.subject && r.subject.toLowerCase().endsWith('needs your input')
          ? 'that ask' : (r.subject || 'that ask');
        const body = `Hey ${requesterFirst} — I couldn't get a read from ${ownerFirst} on ${subjectText}. Closing this for now; ping me when you want to try again.`;
        if (r.origin_is_mpim && r.origin_channel) {
          void conn.postToChannel(r.origin_channel, body, { threadTs: r.origin_thread_ts ?? undefined }).catch(() => {});
        } else {
          void conn.sendDirect(r.requester_slack_id, body).catch(() => {});
        }
        // v3.1.1 — no requester_notified_at stamp here: closeRequest below makes
        // this row terminal, so nothing ever re-reads the stamp (it's moot). The
        // `!r.requester_notified_at` guard above still prevents a double-DM if an
        // earlier path already notified this request.
        logger.info('briefs — requester loop-close on stale auto-park', { requestId: id, requesterSlackId: r.requester_slack_id });
      }
    } catch (err) {
      logger.warn('briefs — stale requester loop-close threw, closing anyway', { requestId: id, err: String(err).slice(0, 200) });
    }
    closeRequest({
      id,
      state: 'cancelled',
      closureReason: 'surfaced_threshold',
      closedBy: 'brief',
    });
  }

  logger.info('Morning briefing sent (AI-generated)', {
    userId: ownerUserId,
    items: items.length,
    surfaced: requestIdsToSurface.length,
    auto_parked: requestIdsToStale.length,
  });
}

// ── Briefing schedule helpers ─────────────────────────────────────────────────

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
    if (match) return [parseInt(match[1], 10), parseInt(match[2], 10)];
  }
  // v2.8.1 — earliest work-hour start across all days in the canonical work_hours map.
  const wh = profile.schedule.work_hours ?? {};
  const allStarts: string[] = [];
  for (const ranges of Object.values(wh)) {
    for (const r of ranges) {
      const m = r.match(/^(\d{2}:\d{2})-/);
      if (m) allStarts.push(m[1]);
    }
  }
  allStarts.sort();
  const earliest = allStarts[0] ?? '09:00';
  const [h, m] = earliest.split(':').map(Number);
  return [h, m ?? 0];
}

export function isWorkDay(dt: DateTime, profile: UserProfile): boolean {
  const dayNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  return getBriefingWorkDays(profile).includes(dayNames[dt.weekday] as any);
}
