/**
 * Colleague OOF reengage (gh#201-d).
 *
 * Confirmed root cause: when a colleague-initiated meeting search dead-ends
 * because the owner is in a known away period (an all-day Outlook "out of
 * office" event), `maybeOpenInFlightMeetingRequest.ts:48` deliberately
 * excludes colleague-initiated turns ("tracked via the existing outreach/
 * approval flows") — but a zero-slot search never calls `message_colleague`
 * or `create_approval`, so nothing durable gets written and the colleague's
 * ask just evaporates. Traced twice in production (2026-08-12, 2026-08-16).
 *
 * Owner's spec, verbatim: don't leave the request open waiting for him to
 * notice — track it, and when the away period ends, MAELLE PROACTIVELY
 * reaches back out to the colleague ("still want to book, now that he's
 * back?"). Yes → resume straight into a normal booking flow. No / silence →
 * the request is genuinely dead, closed cleanly, nobody nagged.
 *
 * This is R1 applied, not a new spine: the durable record is a `follow_up`
 * request (same kind maybeOpenInFlightMeetingRequest already uses for
 * in-flight tracking); the reengagement DM is a normal `outreach` request via
 * the existing `createOutreachJob` bridge (same await_reply / reply_deadline
 * / outreach_expiry machinery every other colleague outreach already uses);
 * the "checking" re-ask mirrors `runRescheduleReask` (runner.ts) — same
 * shape, same +24h / +48h timings, new copy.
 *
 * Independent verification, not a dependency on the search tool's payload:
 * this module does NOT read the find_available_slots result's `day_summary` /
 * `top_reasons` to decide "is the owner away" — it re-derives that directly
 * from the owner's calendar (getOwnerEventsForDecision + isAllDayOutOfOffice,
 * the same predicate the search connector itself uses). That is deliberate:
 * tracing this fix found that `skills/meetings/ops/handlers/findAvailableSlots.ts`
 * (Matchmaker's file, not touched here) actually DROPS `day_summary` from the
 * result on exactly this dead-end shape (zero slots, no attendee warnings, no
 * soft-block hint) — see its early-return around the `rawSlots` fallback. A
 * trigger that trusted the tool's payload would have nothing to read. Flagged
 * to Matchmaker separately; this fix does not depend on it being changed.
 */

import { DateTime } from 'luxon';
import type { App } from '@slack/bolt';
import type { UserProfile } from '../../config/userProfile';
import { getAnthropicClient } from '../../llm/client';
import { MODEL_HAIKU } from '../../llm/models';
import {
  createRequest,
  getRequestByIdempotencyKey,
  buildIdempotencyKey,
  updateRequest,
} from '../../db/requests';
import { createOutreachJob, updateOutreachJob, getOutreachJobByRequestId, getLinkedRequestIdForOutreach, type OutreachJob } from '../../db/jobs';
import { getPersonMemory } from '../../db/people';
import { getOwnerEventsForDecision } from '../../connectors/graph/calendarReads';
import { isAllDayOutOfOffice, computeOofSpan, formatOofUntilDisplay } from '../../utils/scheduleRules';
import { calcResponseDeadline, colleagueWorkTimeBaseFromNow } from '../../utils/responseDeadline';
import { getConnection } from '../../connections/registry';
import { logActivity } from './logActivity';
import { closeRequest } from './closeRequest';
import { parseDetails, type RequestRow } from './types';
import logger from '../../utils/logger';

// ── Payload shapes (kind-local, mirrors meetingReschedule.ts's RescheduleContext) ──

interface ColleagueOofDetails {
  colleague_slack_id: string;
  colleague_name: string;
  colleague_tz?: string;
  duration_minutes?: number;
  attendee_emails?: string[];
  meeting_mode?: string;
  subject: string;
  requester_is_attending?: boolean;
  resume_date?: string;         // yyyy-MM-dd, owner tz — first day owner is back
  oof_until_display?: string;
  recheck_attempts?: number;
}

interface OofReengageContext {
  subject?: string;
  duration_minutes?: number;
  attendee_emails?: string[];
  meeting_mode?: string;
  requester_is_attending?: boolean;
}

// ── Owner-away-period lookup (shared by the trigger and the recheck) ────────

interface OofCoverage {
  covered: boolean;
  /** Owner-local date (yyyy-MM-dd), exclusive — the first day NOT covered. */
  resumeDate?: string;
  /** "away through <date>" display; undefined for a single-day span. */
  untilDisplay?: string;
}

const OOF_LOOKAHEAD_DAYS = 120;

/**
 * Does an all-day OOF event on the owner's calendar cover `fromIso`'s date?
 * One Graph read, `isAllDayOutOfOffice` + `computeOofSpan` (the exact shared
 * predicates the search connector itself uses — see the file header). Fails
 * closed (throws) on a genuine calendar-read failure — the caller decides
 * whether to retry or give up; this never silently reports "not away."
 */
async function ownerOofCoverage(profile: UserProfile, fromIso: string): Promise<OofCoverage> {
  const tz = profile.user.timezone;
  const anchor = (() => {
    const dt = DateTime.fromISO(fromIso, { zone: tz });
    return dt.isValid ? dt : DateTime.now().setZone(tz);
  })();
  const fromDate = anchor.toFormat('yyyy-MM-dd');
  const events = await getOwnerEventsForDecision(
    profile.user.email,
    anchor.toISO()!,
    anchor.plus({ days: OOF_LOOKAHEAD_DAYS }).toISO()!,
    tz,
  );
  for (const evt of events) {
    if (!isAllDayOutOfOffice(evt)) continue;
    const evStart = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' });
    const evEnd = DateTime.fromISO(evt.end.dateTime, { zone: evt.end.timeZone ?? 'utc' });
    if (!evStart.isValid || !evEnd.isValid) continue;
    const span = computeOofSpan(
      evt.id,
      evStart.setZone(tz).toFormat('yyyy-MM-dd'),
      evEnd.diff(evStart, 'minutes').minutes,
      tz,
    );
    if (span.startDate <= fromDate && span.endDateExclusive > fromDate) {
      return { covered: true, resumeDate: span.endDateExclusive, untilDisplay: formatOofUntilDisplay(span, tz) };
    }
  }
  return { covered: false };
}

// ── 1. Trigger — colleague search dead-ends purely on owner OOF ────────────

export interface MaybeTrackOofInput {
  ownerUserId: string;
  colleagueSlackId: string;
  colleagueName?: string;
  threadTs?: string;
  channel?: string;
  toolInput: Record<string, unknown>;
  toolResult: unknown;
  profile: UserProfile;
}

/**
 * Called from the orchestrator's tool-result loop for every colleague-
 * initiated `find_available_slots` call (mirrors the site that already calls
 * `maybeOpenInFlightMeetingRequest` for the owner-initiated case). No-ops
 * immediately unless the result is a genuine zero-slot dead end that has not
 * already been escalated some other way (an error, or the existing
 * `owner_approval_candidates` / `must_be` escalation path).
 */
export async function maybeTrackColleagueOofDeadEnd(input: MaybeTrackOofInput): Promise<void> {
  const raw = input.toolResult;
  const resultObj = (Array.isArray(raw) ? {} : (raw ?? {})) as Record<string, unknown>;
  const slots = Array.isArray(raw) ? raw : Array.isArray(resultObj.slots) ? (resultObj.slots as unknown[]) : undefined;
  if (slots === undefined || slots.length > 0) return;
  if (typeof resultObj.error === 'string') return;
  // Already escalated via the colleague must-be path — that has its own
  // owner-approval flow; don't also open a second tracking row for it.
  if (resultObj.owner_approval_candidates || resultObj._must_be_owner_approval_note) return;

  const toolInput = input.toolInput ?? {};
  const searchFromRaw = typeof toolInput.search_from === 'string' ? toolInput.search_from : undefined;
  if (!searchFromRaw) return;

  let coverage: OofCoverage;
  try {
    coverage = await ownerOofCoverage(input.profile, searchFromRaw);
  } catch (err) {
    logger.warn('maybeTrackColleagueOofDeadEnd — owner calendar read failed, skipping', {
      err: String(err).slice(0, 200),
    });
    return;
  }
  if (!coverage.covered || !coverage.resumeDate) return;  // dead end for some OTHER reason — not ours to track

  const colleagueName = input.colleagueName ?? 'them';
  const colleagueFirst = colleagueName.split(/\s+/)[0] || 'them';
  const ownerFirst = input.profile.user.name.split(' ')[0];
  const durationMinutes = typeof toolInput.duration_minutes === 'number' ? toolInput.duration_minutes : undefined;
  const attendeeEmails = Array.isArray(toolInput.attendee_emails)
    ? (toolInput.attendee_emails as unknown[]).filter((e): e is string => typeof e === 'string')
    : undefined;
  const meetingMode = typeof toolInput.meeting_mode === 'string' ? toolInput.meeting_mode : undefined;
  const subject = typeof toolInput.subject === 'string' && toolInput.subject.trim() ? toolInput.subject.trim() : 'a meeting';
  const requesterIsAttending = typeof toolInput.requester_is_attending === 'boolean' ? toolInput.requester_is_attending : undefined;
  const colleagueTz = getPersonMemory(input.colleagueSlackId)?.timezone;

  // Idempotency keyed on (owner, colleague, THIS away period's end) — a repeat
  // ask during the SAME away window collapses onto the one tracking row; a
  // later, genuinely NEW away period gets a fresh key naturally.
  const idempotencyKey = buildIdempotencyKey({
    ownerUserId: input.ownerUserId,
    requesterSlackId: input.colleagueSlackId,
    kind: 'follow_up',
    subject: `colleague_oof_dead_end:${input.colleagueSlackId}:${coverage.resumeDate}`,
  });
  if (getRequestByIdempotencyKey(idempotencyKey)) return;

  const details: ColleagueOofDetails = {
    colleague_slack_id: input.colleagueSlackId,
    colleague_name: colleagueName,
    colleague_tz: colleagueTz,
    duration_minutes: durationMinutes,
    attendee_emails: attendeeEmails,
    meeting_mode: meetingMode,
    subject,
    requester_is_attending: requesterIsAttending,
    resume_date: coverage.resumeDate,
    oof_until_display: coverage.untilDisplay,
    recheck_attempts: 0,
  };

  try {
    createRequest({
      ownerUserId: input.ownerUserId,
      initiatedBy: input.colleagueSlackId,
      initiatedByRole: 'colleague',
      kind: 'follow_up',
      subkind: 'colleague_oof_dead_end',
      subject: `Reach back out to ${colleagueFirst} once ${ownerFirst} is back`,
      description: `${colleagueName} asked about ${subject === 'a meeting' ? 'a meeting' : `"${subject}"`}`
        + `${durationMinutes ? ` (~${durationMinutes} min)` : ''} but ${ownerFirst} is away`
        + `${coverage.untilDisplay ? ` until ${coverage.untilDisplay}` : ''}. Will re-offer once he's back.`,
      state: 'in_flight',
      requesterSlackId: input.colleagueSlackId,
      requesterName: colleagueName,
      targetSlackId: input.colleagueSlackId,
      targetName: colleagueName,
      originChannel: input.channel,
      originThreadTs: input.threadTs,
      idempotencyKey,
      // gh#201-d — fire the recheck AT the day the owner is due back, in his
      // own timezone. runColleagueOofRecheck re-verifies before acting (an
      // extended trip re-arms here again) rather than trusting this once.
      nextCheckAt: DateTime.fromISO(coverage.resumeDate, { zone: input.profile.user.timezone }).toUTC().toISO()!,
      nextCheckHandler: 'colleague_oof_recheck',
      details: details as unknown as Record<string, unknown>,
    });
    logger.info('maybeTrackColleagueOofDeadEnd — tracking colleague ask through owner away period', {
      ownerUserId: input.ownerUserId, colleagueSlackId: input.colleagueSlackId, resumeDate: coverage.resumeDate,
    });
  } catch (err) {
    logger.warn('maybeTrackColleagueOofDeadEnd — create skipped', { err: String(err).slice(0, 150) });
  }
}

// ── 2. Recheck timer — is the owner actually back yet? ──────────────────────

/** Bounded re-verification — never re-arm forever on a stuck Graph read. */
const MAX_RECHECK_ATTEMPTS = 6;
/** Safety valve (R3) — never let this wait past a bound, even mid-extension. */
const MAX_TOTAL_WAIT_DAYS = 60;

export async function runColleagueOofRecheck(row: RequestRow, profile: UserProfile): Promise<'rearmed' | 'closed'> {
  const details = parseDetails<ColleagueOofDetails>(row);
  const colleagueSlackId = details?.colleague_slack_id ?? row.requester_slack_id ?? undefined;
  if (!details || !colleagueSlackId) {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'closed';
  }

  const attempts = (details.recheck_attempts ?? 0) + 1;
  const createdMs = Date.parse(row.created_at.replace(' ', 'T') + 'Z');
  const overdue = Number.isFinite(createdMs) && (Date.now() - createdMs) > MAX_TOTAL_WAIT_DAYS * 86_400_000;

  let coverage: OofCoverage;
  try {
    coverage = await ownerOofCoverage(profile, DateTime.now().setZone(profile.user.timezone).toISO()!);
  } catch (err) {
    logger.warn('runColleagueOofRecheck — owner calendar read failed', {
      requestId: row.id, attempts, err: String(err).slice(0, 200),
    });
    if (attempts >= MAX_RECHECK_ATTEMPTS) {
      return closeUnreachable(row, profile, details);
    }
    updateRequest(row.id, {
      details: { ...details, recheck_attempts: attempts } as unknown as Record<string, unknown>,
      nextCheckAt: DateTime.now().plus({ hours: 6 * attempts }).toUTC().toISO(),
      nextCheckHandler: 'colleague_oof_recheck',
    });
    return 'rearmed';
  }

  if (coverage.covered && !overdue) {
    // Still away (or the trip got extended) — re-arm for the newly-known end.
    updateRequest(row.id, {
      details: {
        ...details, recheck_attempts: attempts,
        resume_date: coverage.resumeDate, oof_until_display: coverage.untilDisplay,
      } as unknown as Record<string, unknown>,
      nextCheckAt: DateTime.fromISO(coverage.resumeDate!, { zone: profile.user.timezone }).toUTC().toISO()!,
      nextCheckHandler: 'colleague_oof_recheck',
    });
    logger.info('runColleagueOofRecheck — owner still away, re-armed', {
      requestId: row.id, resumeDate: coverage.resumeDate,
    });
    return 'rearmed';
  }

  if (coverage.covered && overdue) {
    // Bouncer non-blocking finding (gh#201-d) — the safety valve (60 days)
    // tripped while the owner is STILL genuinely away. Falling through to
    // sendOofReengagement here would tell the colleague "Idan is back now" —
    // false, and exactly the outcome R3 forbids (never the wrong outcome).
    // Close honestly instead of stopping re-verification with a lie.
    return closeSafetyValveExpired(row, profile, details);
  }

  // Owner is genuinely back — reach out.
  return sendOofReengagement(row, profile, details);
}

async function closeSafetyValveExpired(row: RequestRow, profile: UserProfile, details: ColleagueOofDetails): Promise<'closed'> {
  const conn = getConnection(profile.user.slack_user_id, 'slack');
  const colleagueFirst = (details.colleague_name ?? 'there').split(/\s+/)[0] || 'there';
  closeRequest({ id: row.id, state: 'expired', closureReason: 'oof_recheck_safety_valve', closedBy: 'system' });
  if (conn) {
    try {
      await conn.sendDirect(details.colleague_slack_id,
        `Hi ${colleagueFirst}, ${profile.user.name.split(' ')[0]} is still away and it's been a while, so I've closed this one out rather than keep you waiting. Feel free to ask again any time.`);
    } catch (err) { logger.warn('closeSafetyValveExpired — colleague DM failed', { err: String(err).slice(0, 150) }); }
    try {
      await conn.sendDirect(profile.user.slack_user_id,
        `Stopped tracking ${details.colleague_name}'s ask about ${details.subject} — you've been away past the point I keep checking. Worth a manual ping if it still matters.`);
    } catch (err) { logger.warn('closeSafetyValveExpired — owner DM failed', { err: String(err).slice(0, 150) }); }
  }
  logger.warn('runColleagueOofRecheck — safety valve tripped while still away, closed honestly', { requestId: row.id });
  return 'closed';
}

async function closeUnreachable(row: RequestRow, profile: UserProfile, details: ColleagueOofDetails): Promise<'closed'> {
  const conn = getConnection(profile.user.slack_user_id, 'slack');
  const colleagueFirst = (details.colleague_name ?? 'there').split(/\s+/)[0] || 'there';
  closeRequest({ id: row.id, state: 'expired', closureReason: 'oof_recheck_unverifiable', closedBy: 'system' });
  if (conn) {
    try {
      await conn.sendDirect(details.colleague_slack_id,
        `Hi ${colleagueFirst}, sorry — I've been having trouble confirming when things freed up, so I've closed this one out. Feel free to ask again any time.`);
    } catch (err) { logger.warn('closeUnreachable — colleague DM failed', { err: String(err).slice(0, 150) }); }
    try {
      await conn.sendDirect(profile.user.slack_user_id,
        `Couldn't confirm your calendar to reach back out to ${details.colleague_name} about ${details.subject} — closed the tracking after repeated failures. Worth a manual ping if it still matters.`);
    } catch (err) { logger.warn('closeUnreachable — owner DM failed', { err: String(err).slice(0, 150) }); }
  }
  logger.warn('runColleagueOofRecheck — gave up verifying owner calendar, closed', { requestId: row.id });
  return 'closed';
}

/**
 * Owner confirmed back — send the reengagement DM. The dead-end TRACKING row
 * closes here (its one job, "get back to them once he's back," is done); a
 * fresh `outreach` request (via createOutreachJob, linked as its child) takes
 * over the awaiting-reply phase on the SAME spine, reusing the existing
 * await_reply / reply_deadline / outreach_expiry machinery wholesale.
 */
async function sendOofReengagement(row: RequestRow, profile: UserProfile, details: ColleagueOofDetails): Promise<'closed' | 'rearmed'> {
  const conn = getConnection(profile.user.slack_user_id, 'slack');
  const colleagueSlackId = details.colleague_slack_id;
  const colleagueName = details.colleague_name || row.requester_name || 'there';
  const colleagueFirst = colleagueName.split(/\s+/)[0] || 'there';
  const ownerFirst = profile.user.name.split(' ')[0];
  const subjectLabel = details.subject && details.subject !== 'a meeting' ? `"${details.subject}"` : 'time with him';

  if (!conn) {
    closeRequest({ id: row.id, state: 'expired', closureReason: 'no_slack_connection', closedBy: 'system' });
    return 'closed';
  }

  const colleagueTz = details.colleague_tz ?? getPersonMemory(colleagueSlackId)?.timezone ?? profile.user.timezone;

  // registrar fix (colleague-outreach-not-gated-to-recipient-work-hours-or-week,
  // o#245/o#246) — this used to fire the instant the owner's resume timer
  // tripped, on the OWNER's clock, ignoring the colleague's own hours/week
  // entirely (R4 applies to every colleague-facing send, not only the
  // owner's nag cadence). Defer to the colleague's own next work-time start
  // instead; re-arming back through `colleague_oof_recheck` re-verifies owner
  // coverage too, which is correct — an extended trip can still change the
  // answer by the time the colleague's window opens.
  const colleagueBase = colleagueWorkTimeBaseFromNow(colleagueTz);
  if (Date.parse(colleagueBase) > Date.now() + 60_000) {
    updateRequest(row.id, { nextCheckAt: colleagueBase, nextCheckHandler: 'colleague_oof_recheck' });
    logger.info('sendOofReengagement — outside colleague work hours, deferring reengagement', {
      requestId: row.id, colleagueSlackId, colleagueTz, deferredTo: colleagueBase,
    });
    return 'rearmed';
  }

  const message = `Hi ${colleagueFirst}, ${ownerFirst} is back now — still want me to find a time for ${subjectLabel}? Let me know and I'll get it set up.`;
  const ownerChannel = (await conn.resolveDirectChannelId?.(profile.user.slack_user_id)) ?? profile.user.slack_user_id;

  const jobId = createOutreachJob({
    owner_user_id: profile.user.slack_user_id,
    owner_channel: ownerChannel,
    colleague_slack_id: colleagueSlackId,
    colleague_name: colleagueName,
    colleague_tz: colleagueTz,
    message,
    await_reply: 1,
    status: 'sent',
    sent_at: new Date().toISOString(),
    intent: 'oof_reengage',
    reply_deadline: calcResponseDeadline(colleagueTz),
    context_json: JSON.stringify({
      subject: details.subject,
      duration_minutes: details.duration_minutes,
      attendee_emails: details.attendee_emails,
      meeting_mode: details.meeting_mode,
      requester_is_attending: details.requester_is_attending,
    } satisfies OofReengageContext),
    parentRequestId: row.id,
  });

  const res = await conn.sendDirect(colleagueSlackId, message);
  if (!res.ok) {
    updateOutreachJob(jobId, { status: 'cancelled', reply_text: `Reengagement not delivered: ${res.reason}` });
    closeRequest({ id: row.id, state: 'expired', closureReason: 'oof_reengage_not_delivered', closedBy: 'system', skipChildren: true });
    logger.warn('sendOofReengagement — DM not delivered', { requestId: row.id, jobId, reason: res.reason });
    return 'closed';
  }
  if (res.ts || res.ref) updateOutreachJob(jobId, { dm_message_ts: res.ts, dm_channel_id: res.ref });

  // Bouncer non-blocking finding (gh#201-d) — without this, the child
  // outreach request's `owner_dm_channel` is NULL, so a later silent-expiry
  // tombstone (runner.ts's runOutreachExpiryOrDecision, R3's "tell BOTH
  // sides") has nowhere to post and the owner never learns the colleague
  // went quiet on the reengagement. Same pattern as the two sibling outreach
  // call sites (skills/outreach.ts, skills/meetingReschedule.ts): resolve the
  // request the createOutreachJob bridge just minted and stamp the owner's
  // return channel on it explicitly.
  const reengageRequestId = getLinkedRequestIdForOutreach(jobId);
  if (reengageRequestId) {
    try {
      updateRequest(reengageRequestId, { ownerDmChannel: ownerChannel });
    } catch (err) {
      logger.warn('sendOofReengagement — owner_dm_channel stamp failed (non-fatal)', {
        requestId: reengageRequestId, err: String(err).slice(0, 150),
      });
    }
  }

  logActivity({
    ownerUserId: profile.user.slack_user_id,
    kind: 'outreach',
    subkind: 'dm',
    subject: `Reached back out to ${colleagueName} — ${ownerFirst} is back`,
    initiatedBy: profile.user.slack_user_id,
    initiatedByRole: 'system',
    targetSlackId: colleagueSlackId,
    targetName: colleagueName,
  });

  closeRequest({
    id: row.id,
    state: 'resolved',
    closureReason: 'owner_returned_reengaging_colleague',
    closedBy: 'system',
    skipChildren: true,  // the fresh outreach row (this colleague's live ask) stays open
  });
  logger.info('sendOofReengagement — owner back, reengaged colleague', { requestId: row.id, jobId, colleagueSlackId });
  return 'closed';
}

// ── 3. "Checking" re-ask — mirrors runRescheduleReask (runner.ts) ──────────

export async function runOofReengageReask(row: RequestRow, profile: UserProfile): Promise<'rearmed' | 'noop'> {
  const job = getOutreachJobByRequestId(row.id);
  if (row.state !== 'awaiting_colleague' || !job || job.intent !== 'oof_reengage') {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'noop';
  }
  const conn = getConnection(profile.user.slack_user_id, 'slack');
  if (!conn) {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'noop';
  }
  // registrar fix (colleague-outreach-not-gated-to-recipient-work-hours-or-week,
  // o#245/o#246) — defer this re-ask to the colleague's own next work-time
  // start rather than firing on the raw +24h timer regardless of their clock.
  const colleagueTz = job.colleague_tz || profile.user.timezone;
  const colleagueBase = colleagueWorkTimeBaseFromNow(colleagueTz);
  if (Date.parse(colleagueBase) > Date.now() + 60_000) {
    updateRequest(row.id, { nextCheckAt: colleagueBase, nextCheckHandler: 'oof_reengage_reask' });
    logger.info('runOofReengageReask — outside colleague work hours, deferring re-ask', {
      requestId: row.id, colleagueTz, deferredTo: colleagueBase,
    });
    return 'rearmed';
  }
  let ctx: OofReengageContext = {};
  try { ctx = job.context_json ? JSON.parse(job.context_json) : {}; } catch { /* generic fallback below */ }
  const subjectLabel = ctx.subject && ctx.subject !== 'a meeting' ? `"${ctx.subject}"` : 'grabbing time';
  const first = (job.colleague_name ?? '').split(/\s+/)[0] || 'there';
  const msg = `Hi ${first}, just circling back — still want to find time for ${subjectLabel}? No rush, just want to close the loop.`;
  try {
    if (job.dm_channel_id) await conn.postToChannel(job.dm_channel_id, msg, { threadTs: job.dm_message_ts });
    else await conn.sendDirect(job.colleague_slack_id, msg);
  } catch (err) {
    logger.warn('runOofReengageReask — re-ping DM failed', { requestId: row.id, err: String(err).slice(0, 200) });
  }
  // Re-arm to the NORMAL no-response expiry — one re-ask, then a clean close.
  updateRequest(row.id, {
    nextCheckAt: DateTime.now().plus({ hours: 48 }).toUTC().toISO(),
    nextCheckHandler: 'outreach_expiry',
  });
  logger.info('runOofReengageReask — re-pinged colleague once, re-armed to outreach_expiry', {
    requestId: row.id, jobId: job.id,
  });
  return 'rearmed';
}

// ── 4. Reply classification + dispatch ──────────────────────────────────────

async function classifyOofReengageReply(params: {
  subjectLabel: string;
  reply: string;
  colleagueName: string;
  assistantName: string;
  ownerName: string;
}): Promise<'yes' | 'no' | 'checking'> {
  try {
    const anthropic = getAnthropicClient();
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 30,
      tools: [{
        name: 'classify_reply',
        description: 'Classify whether the colleague still wants to book the meeting now that the owner is back.',
        input_schema: {
          type: 'object' as const,
          properties: {
            status: { type: 'string', enum: ['yes', 'no', 'checking'] },
          },
          required: ['status'],
        },
      }],
      tool_choice: { type: 'tool', name: 'classify_reply' },
      messages: [{
        role: 'user',
        content: `You are ${params.assistantName}, ${params.ownerName}'s executive assistant. You told ${params.colleagueName} that ${params.ownerName} is back now and asked if they still want to find time for ${params.subjectLabel}.

${params.colleagueName} replied: "${params.reply}"

Classify by MEANING, in any language:
- "yes": still wants to meet / find a time (any affirmative, including one that also names a time or asks a scheduling question).
- "no": no longer needs it / not necessary any more / declines.
- "checking": hasn't decided yet — needs to check something first, will come back to you. Not yes, not no.`,
      }],
    });
    const toolUse = resp.content.find(b => b.type === 'tool_use');
    const status = toolUse && toolUse.type === 'tool_use' ? (toolUse.input as { status?: string }).status : undefined;
    if (status === 'yes' || status === 'no' || status === 'checking') return status;
    return 'checking';
  } catch (err) {
    logger.warn('classifyOofReengageReply failed — defaulting to checking', { err: String(err).slice(0, 150) });
    return 'checking';
  }
}

/**
 * Main entry, dispatched from connectors/slack/coordinator.ts's intent
 * routing (mirrors handleRescheduleReply). Returns true if handled; false if
 * the caller should fall through to the generic no-routed-intent path (the
 * full orchestrator — e.g. intent isn't ours).
 *
 * NEW LLM CALL (flagged per W12.2): `classifyOofReengageReply` above, Haiku,
 * ~30 output tokens. Fires at most once per colleague reengagement — i.e.
 * only when a colleague's search previously dead-ended on the owner's away
 * period AND the owner has since returned AND the colleague replies. This is
 * a rare, bounded path (two confirmed incidents to date), not an always-on
 * cost.
 */
export async function handleOofReengageReply(
  app: App,
  params: { job: OutreachJob; replyText: string; profile: UserProfile; bot_token: string },
): Promise<boolean> {
  const { job, replyText, profile } = params;
  if (job.intent !== 'oof_reengage') return false;

  const conn = getConnection(profile.user.slack_user_id, 'slack');
  if (!conn) return false;

  let ctx: OofReengageContext = {};
  try { ctx = job.context_json ? JSON.parse(job.context_json) : {}; } catch { ctx = {}; }
  const subjectLabel = ctx.subject && ctx.subject !== 'a meeting' ? `"${ctx.subject}"` : 'time with him';

  const status = await classifyOofReengageReply({
    subjectLabel,
    reply: replyText,
    colleagueName: job.colleague_name,
    assistantName: profile.assistant.name,
    ownerName: profile.user.name,
  });

  logger.info('oof_reengage reply classified', { jobId: job.id, status });

  // A reply of any kind kills the CURRENT expiry timer — re-armed below per branch.
  if (job.request_id) {
    updateRequest(job.request_id, { nextCheckAt: null, nextCheckHandler: null });
  }

  const conversation: Array<{ role: 'maelle' | 'colleague'; text: string }> =
    job.conversation_json ? JSON.parse(job.conversation_json) : [];
  conversation.push({ role: 'colleague', text: replyText });

  // ── checking → not a decline (R4); keep open for exactly one re-ask ──────
  if (status === 'checking') {
    updateOutreachJob(job.id, { reply_text: replyText, conversation_json: JSON.stringify(conversation) });
    if (job.request_id) {
      // outreach-expiry-tombstone-says-never-replied (2026-08-12) — stamp
      // phase='outreach:re_engaged' so a second silence after this re-arm
      // reads correctly at final expiry (runner.ts's runOutreachExpiryOrDecision):
      // `state` alone stays 'awaiting_colleague' across both re-arms, so
      // without this marker a real "checking" reply followed by renewed
      // silence would tombstone as "never replied" — false, they did.
      updateRequest(job.request_id, {
        nextCheckAt: DateTime.now().plus({ hours: 24 }).toUTC().toISO(),
        nextCheckHandler: 'oof_reengage_reask',
        phase: 'outreach:re_engaged',
      });
    }
    logger.info('oof_reengage reply = checking — kept open, armed reask +24h', { jobId: job.id, requestId: job.request_id ?? null });
    return true;
  }

  // ── no → genuinely dead, close cleanly, tell the owner ───────────────────
  if (status === 'no') {
    const ack = `No worries — just say the word if that changes.`;
    try {
      if (job.dm_channel_id) await conn.postToChannel(job.dm_channel_id, ack, { threadTs: job.dm_message_ts });
      else await conn.sendDirect(job.colleague_slack_id, ack);
    } catch (err) { logger.warn('oof_reengage decline ack failed', { err: String(err).slice(0, 150) }); }
    conversation.push({ role: 'maelle', text: ack });
    updateOutreachJob(job.id, { status: 'cancelled', reply_text: replyText, conversation_json: JSON.stringify(conversation) });
    try {
      await conn.sendDirect(profile.user.slack_user_id,
        `${job.colleague_name} said they no longer need time with you — I've closed that one out.`);
    } catch (err) { logger.warn('oof_reengage owner heads-up (no) failed', { err: String(err).slice(0, 150) }); }
    logger.info('oof_reengage reply = no — closed cleanly', { jobId: job.id });
    return true;
  }

  // ── yes → resume straight into a normal booking flow ─────────────────────
  updateOutreachJob(job.id, { status: 'replied', reply_text: replyText, conversation_json: JSON.stringify(conversation) });
  try {
    await conn.sendDirect(profile.user.slack_user_id, `${job.colleague_name} still wants to grab time — finding options now.`);
  } catch (err) { logger.warn('oof_reengage owner heads-up (yes) failed', { err: String(err).slice(0, 150) }); }

  try {
    // Dynamic import — avoids a load-time cycle (orchestrator → skills → spine),
    // same idiom runner.ts's runResearchRun already uses for the same reason.
    const { runOrchestrator } = await import('../orchestrator');
    const { runOutputGates } = await import('../../utils/guards/runOutputGates');
    const attendeeList = Array.isArray(ctx.attendee_emails) && ctx.attendee_emails.length > 0
      ? ctx.attendee_emails.join(', ') : '';
    // R2-adjacent: state the ORIGINAL ask's facts explicitly rather than
    // leaving Sonnet to re-derive them from a bare "yes" — subject, duration
    // and attendees carry through byte-for-byte from what the colleague
    // originally asked for.
    const syntheticMessage =
      `${job.colleague_name} confirmed they still want to meet — subject: ${ctx.subject ?? 'a meeting'}, `
      + `duration: ${ctx.duration_minutes ?? 30} minutes${attendeeList ? `, attendees: ${attendeeList}` : ''}`
      + `${ctx.meeting_mode ? `, mode: ${ctx.meeting_mode}` : ''}. Their reply: "${replyText}". `
      + `Find available times and propose them now.`;
    const dmChannelId = job.dm_channel_id ?? job.colleague_slack_id;
    const dmThreadTs = job.dm_message_ts ?? `oof_reengage_${job.id}`;
    const result = await runOrchestrator({
      userMessage: syntheticMessage,
      conversationHistory: [],
      threadTs: dmThreadTs,
      channelId: dmChannelId,
      userId: job.colleague_slack_id,
      senderRole: 'colleague',
      senderName: job.colleague_name,
      authority: 'colleague',
      surface: 'colleague_dm',
      channel: 'slack',
      interactive: true,
      profile,
      app,
    });
    if (result.reply) {
      // gh#201-d (D1 fix, bouncer overturn) — this is a synthetic, re-entered
      // orchestrator turn whose output reaches a COLLEAGUE. Every other
      // colleague-facing reply is gated through runOutputGates before it
      // leaves the process (postReply.ts:488 for Slack, inbound.ts:339 for
      // the email leg) — sending result.reply straight to the connector
      // skipped every one of those checks (leak/identity-spoof scan,
      // owner-fact-check-and-rewrite, humanGate, dateVerifier, the
      // availability floor), the exact class runOutputGates' own header
      // (:260-269) records as retired in v4.1.x for re-running the
      // orchestrator on the reply path (G3). Same minimal shape inbound.ts
      // uses: gate the draft, then send whatever it returns.
      const gatedReply = await runOutputGates(result.reply, {
        profile, result,
        history: [], userMessage: syntheticMessage,
        senderId: job.colleague_slack_id, channelId: dmChannelId, threadTs: dmThreadTs,
        role: 'colleague', colleagueName: job.colleague_name,
        isMpim: false, isOwnerInGroup: false,
      });
      if (job.dm_channel_id) await conn.postToChannel(job.dm_channel_id, gatedReply, { threadTs: job.dm_message_ts });
      else await conn.sendDirect(job.colleague_slack_id, gatedReply);
    }
  } catch (err) {
    logger.error('oof_reengage — resume-booking orchestrator run threw', { err: String(err).slice(0, 300), jobId: job.id });
    try {
      await conn.sendDirect(job.colleague_slack_id, `Let me check on times and get back to you shortly.`);
    } catch { /* best effort — the reply is already logged above either way */ }
  }
  logger.info('oof_reengage reply = yes — resumed booking flow', { jobId: job.id });
  return true;
}
