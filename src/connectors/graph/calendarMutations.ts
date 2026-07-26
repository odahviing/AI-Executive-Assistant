import { DateTime } from 'luxon';
import logger from '../../utils/logger';
import { auditLog } from '../../db';
import { getClient } from './graphClient';
import { verifyEventDeleted } from './calendarReads';
import type { CreateMeetingParams, CreatedMeeting, UpdateMeetingParams } from './calendarTypes';

/**
 * v2.2.7 — Normalize an ISO datetime for Graph's `dateTime` field. Graph honors
 * any offset/Z in `dateTime` over the sibling `timeZone` field, so an ISO with
 * `Z` lands the event in UTC even when we also send timeZone='Asia/Jerusalem'.
 * Strip the offset, convert to the target timezone's wall-clock, emit zoneless.
 * Fix-once-here so every Graph mutation is consistent regardless of what
 * shape Sonnet (or any caller) handed us.
 */
function normalizeForGraph(iso: string, tz: string): string {
  // CRITICAL: anchor a ZONELESS datetime in the INTENDED tz, not the process's
  // local tz. `setZone:true` only adopts an offset the string ALREADY carries;
  // a naive "2026-07-07T10:00:00" has none, so without `zone: tz` Luxon parses
  // it in the SERVER's local timezone. When Maelle runs on a laptop set to the
  // owner's TRAVEL zone (e.g. US-East while he's away), a naive Israel-intended
  // "10:00" became 10:00 EDT → 17:00 Israel on the calendar — a 7h drift that
  // only ever appeared on trips (at home server-tz == home-tz, so it was a
  // no-op). `zone: tz` makes the binding canonical regardless of where we run.
  const dt = DateTime.fromISO(iso, { zone: tz, setZone: true });
  if (!dt.isValid) return iso;  // fail open — let Graph reject if truly malformed
  return dt.setZone(tz).toISO({ includeOffset: false, suppressMilliseconds: true })!;
}

export async function updateMeeting(params: UpdateMeetingParams): Promise<void> {
  const client = getClient();

  const patch: Record<string, unknown> = {};
  if (params.subject)    patch.subject    = params.subject;
  if (params.start)      patch.start      = { dateTime: normalizeForGraph(params.start, params.timezone), timeZone: params.timezone };
  if (params.end)        patch.end        = { dateTime: normalizeForGraph(params.end,   params.timezone), timeZone: params.timezone };
  if (params.body)       patch.body       = { contentType: 'HTML', content: params.body };
  if (params.categories) patch.categories = params.categories;
  // v2.7.0 — location + isOnline pass-through.
  // Empty string on location clears it on Graph's side (e.g. office→home flip
  // moves to Teams-only with no physical address). Explicit undefined skips
  // the field entirely so existing location is preserved.
  if (params.location !== undefined) {
    patch.location = { displayName: params.location };
  }
  if (params.isOnline !== undefined) {
    patch.isOnlineMeeting = params.isOnline;
  }
  // v2.9.1 — attendees PATCH. Graph replaces the whole array. Caller built
  // the final list (existing - removed + added) already.
  if (params.attendees !== undefined) {
    patch.attendees = params.attendees.map(a => ({
      emailAddress: { name: a.name ?? a.email, address: a.email },
      type: a.optional ? 'optional' : 'required',
    }));
  }

  // v3.1.2 (B1) — capture every field this PATCH actually changed so the
  // audit row tells us WHAT updated, not just that something did. Pre-fix
  // the audit only carried { subject, start } — when a PATCH changed only
  // end/categories/body/location/isOnline/attendees, the row serialized to
  // `{}` and we couldn't tell from the audit whether the update was benign
  // (category retag) or destructive (attendee removal, body wipe). Now the
  // row carries a compact per-field summary. Sensitive fields (body,
  // attendee list) are reduced to size/count metadata, not raw text.
  const patchedFields: Record<string, unknown> = {};
  if (params.subject !== undefined)    patchedFields.subject = params.subject;
  if (params.start !== undefined)      patchedFields.start = params.start;
  if (params.end !== undefined)        patchedFields.end = params.end;
  if (params.body !== undefined)       patchedFields.body_changed = true;
  if (params.categories !== undefined) patchedFields.categories = params.categories;
  if (params.location !== undefined)   patchedFields.location = params.location;
  if (params.isOnline !== undefined)   patchedFields.isOnline = params.isOnline;
  if (params.attendees !== undefined) {
    patchedFields.attendees_count = params.attendees.length;
    patchedFields.attendees_emails = params.attendees.map(a => a.email);
  }

  try {
    await client.api(`/users/${params.userEmail}/events/${params.meetingId}`).patch(patch);

    auditLog({
      action: 'update_meeting',
      source: 'graph_api',
      actor: 'assistant',
      target: params.meetingId,
      details: patchedFields,
      outcome: 'success',
    });

    logger.info('Meeting updated', { id: params.meetingId, fields: Object.keys(patchedFields) });
    // v3.2.x (#121) — invalidate after the write (see createMeeting).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('./calendarCache') as typeof import('./calendarCache')).invalidateCalendarCache(params.userEmail, 'update_meeting');
  } catch (err) {
    auditLog({
      action: 'update_meeting',
      source: 'graph_api',
      actor: 'assistant',
      target: params.meetingId,
      details: { ...patchedFields, error: String(err) },
      outcome: 'failure',
    });
    logger.error('Failed to update meeting', { err, meetingId: params.meetingId, fields: Object.keys(patchedFields) });
    throw err;
  }
}

export async function deleteMeeting(
  userEmail: string,
  meetingId: string,
  options: { comment?: string } = {},
): Promise<{ cancellationSent: boolean }> {
  const client = getClient();

  // v2.8.6 — use Graph's POST /cancel endpoint instead of bare DELETE. Pre-fix
  // `.delete()` removed the event from the organizer's calendar but did NOT
  // reliably send cancellation invites to attendees — they'd keep orphaned
  // copies of the meeting on their own calendars (root of the 2026-05-18 Dirk
  // incident: Maelle "deleted" the meeting from owner's view but Dirk's copy
  // stayed for hours, owner had to manually delete it).
  //
  // /cancel is the right endpoint: it sends a "Cancelled: <subject>" invite
  // to every attendee AND removes the event from the organizer's calendar in
  // one call. ORGANIZER-ONLY: Graph rejects it with 400 for an attendee, so
  // the owner-is-attendee case must go through `declineMeeting` below — never
  // here. (Pre-#147 it DID come here, and the 400 fallback silently degraded
  // every attendee-side decline to a bare DELETE, notifying nobody.)
  //
  // Fallback: if Graph rejects /cancel, retry with DELETE. On the organizer
  // path that means the event has no attendees — a solo "personal block",
  // where there is nobody to notify and DELETE is the right call anyway.
  // `cancellationSent` reports which of the two landed, so the caller can say
  // truthfully whether an Outlook cancellation actually went out.
  // v3.2.x (#121) — invalidate before the delete attempt; covers both the
  // /cancel and DELETE-fallback success returns in one place. A throw after
  // this just costs a harmless cache miss (next read re-fetches and correctly
  // still shows the event).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('./calendarCache') as typeof import('./calendarCache')).invalidateCalendarCache(userEmail, 'delete_meeting');
  try {
    await client.api(`/users/${userEmail}/events/${meetingId}/cancel`).post({
      Comment: options.comment ?? '',
    });
    return { cancellationSent: true };
  } catch (err: any) {
    const code = err?.statusCode ?? err?.code;
    // 400 BadRequest happens when the event has no attendees — fall back to
    // DELETE (which is the right call for solo events anyway).
    if (code === 400 || code === 'ErrorMissingArgument') {
      logger.info('deleteMeeting — /cancel rejected (no attendees), falling back to DELETE', {
        meetingId, code,
      });
      await client.api(`/users/${userEmail}/events/${meetingId}`).delete();
      return { cancellationSent: false };
    }
    throw err;
  }
}

/**
 * v4.2.x (#147) — DECLINE the owner's copy of a meeting he did NOT organize.
 *
 * This is the attendee half of the cancel path; `deleteMeeting` above is the
 * organizer half. It exists because Graph refuses `/cancel` for a non-organizer
 * (400), and the fallback there degrades to a bare DELETE: the event vanished
 * from the owner's calendar and the organizer was told NOTHING. Proven on the
 * 2026-07-26 vacation-decline thread — every attendee-side delete logged
 * "/cancel rejected … falling back to DELETE", so not one of the 17 organizers
 * got an Outlook notice. Maelle papered over that by DMing the organizer on
 * Slack and marking it "sent" before the send even ran (#147.2/.4: the false
 * "Julia's been notified", and a per-occurrence DM that said "won't make it
 * anymore" when two dates were declined).
 *
 * `sendResponse: true` is what puts "Declined" in the organizer's Outlook, and
 * an Outlook decline is per-occurrence by construction — it can neither claim a
 * notification that didn't happen nor overstate the scope.
 *
 * If Graph REFUSES the decline, the likeliest reason is that the owner is the
 * organizer after all (Graph won't let an organizer decline their own meeting) —
 * an ownership read that came back wrong. So fall through to the organizer verb
 * rather than a bare DELETE: a mis-read must never silently strip a meeting off
 * his calendar with nobody told. `notified` reports which of the three actually
 * happened, so the caller states it instead of assuming it.
 *
 * Retention: Outlook normally drops a declined meeting off the attendee's
 * calendar, but that is not a contract we can lean on — so verify and remove
 * the leftover copy ourselves. The caller's post-condition ("it is off his
 * calendar") therefore holds on every branch.
 */
export async function declineMeeting(
  userEmail: string,
  meetingId: string,
  options: { comment?: string } = {},
): Promise<{ notified: 'organizer' | 'attendees' | 'nobody' }> {
  const client = getClient();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('./calendarCache') as typeof import('./calendarCache')).invalidateCalendarCache(userEmail, 'delete_meeting');
  try {
    await client.api(`/users/${userEmail}/events/${meetingId}/decline`).post({
      SendResponse: true,
      Comment: options.comment ?? '',
    });
  } catch (err: any) {
    logger.warn('declineMeeting — /decline rejected, falling back to the organizer verb', {
      meetingId, code: err?.statusCode ?? err?.code,
    });
    const { cancellationSent } = await deleteMeeting(userEmail, meetingId, options);
    return { notified: cancellationSent ? 'attendees' : 'nobody' };
  }
  if (!(await verifyEventDeleted(userEmail, meetingId))) {
    await client.api(`/users/${userEmail}/events/${meetingId}`).delete();
  }
  return { notified: 'organizer' };
}

export async function createMeeting(params: CreateMeetingParams): Promise<CreatedMeeting> {
  const client = getClient();

  // Teams-location sanitization: when isOnline=true, Graph auto-creates the
  // Teams meeting and populates the location with the actual join link.
  // If we ALSO pass a plain string like "Microsoft Teams" / "Teams" as the
  // displayName, Graph stores the string and fails to link it — Outlook shows
  // "Microsoft Teams — Unknown / No address". Drop those sentinel strings.
  // Real physical locations ("Idan's Office", "Meeting Room", "Slack Huddle",
  // "+972-..." phone numbers, "WeWork Sarona") pass through unchanged so the
  // location pill still shows them alongside the auto-generated Teams link.
  const isTeamsSentinel = (s?: string): boolean => {
    if (!s) return false;
    const n = s.trim().toLowerCase();
    return n === 'teams' || n === 'ms teams' || n === 'microsoft teams' || n === 'teams meeting' || n === 'microsoft teams meeting';
  };
  const effectiveLocation = (params.isOnline && isTeamsSentinel(params.location))
    ? undefined
    : params.location;

  // v3.4.2 (D) — the attribution line ("Meeting booked by Maelle, Idan
  // Assistant") leads EVERY invite, always. Pre-fix it was `params.body ||
  // attribution`, so the moment the body carried a location block (which it now
  // does for every physical meeting) the attribution silently vanished — the
  // owner's "why no 'booked by Maelle' anymore" regression. Now it's always
  // prepended; the composed body (location block + any extra comment the owner
  // asked to add, assembled in ops.ts) follows it. Order: attribution → location
  // → extra.
  const attributionLine = params.defaultBodyAuthor
    ? `<p>Meeting booked by ${params.defaultBodyAuthor}.</p>`
    : `<p>Meeting scheduled by your executive assistant.</p>`;
  const composedBody = params.body
    ? `${attributionLine}\n${params.body}`
    : attributionLine;

  // All-day normalization. Graph requires isAllDay events to start at 00:00
  // of the day and end at 00:00 of the NEXT day (both in user TZ). Any other
  // shape Graph rejects or silently degrades to a non-all-day 0-min event
  // (the bug owner saw before this fix). Normalize here regardless of what
  // the caller passed — a "Sunday all-day" becomes Sun 00:00 → Mon 00:00.
  let startIso = params.start;
  let endIso = params.end;
  if (params.isAllDay) {
    const startDt = DateTime.fromISO(params.start, { zone: params.timezone });
    if (startDt.isValid) {
      const dayStart = startDt.startOf('day');
      const dayEnd = dayStart.plus({ days: 1 });
      startIso = dayStart.toISO()!;
      endIso = dayEnd.toISO()!;
    }
  }

  const event: Record<string, unknown> = {
    subject: params.subject,
    body: {
      contentType: 'HTML',
      content: composedBody,
    },
    start: { dateTime: normalizeForGraph(startIso, params.timezone), timeZone: params.timezone },
    end:   { dateTime: normalizeForGraph(endIso,   params.timezone), timeZone: params.timezone },
    attendees: params.attendees.map(a => ({
      emailAddress: { address: a.email, name: a.name },
      type: a.optional ? 'optional' : 'required',
    })),
    isOnlineMeeting: params.isOnline ?? false,
    ...(params.isOnline && {
      onlineMeetingProvider: params.onlineMeetingProvider ?? 'teamsForBusiness',
    }),
    ...(effectiveLocation && { location:    { displayName: effectiveLocation } }),
    ...(params.categories  && { categories:  params.categories }),
    ...(params.sensitivity && { sensitivity: params.sensitivity }),
    ...(params.isAllDay    && { isAllDay:    true }),
    ...(params.showAs      && { showAs:      params.showAs }),
  };

  try {
    const created = await client.api(`/users/${params.userEmail}/events`).post(event);

    auditLog({
      action: 'create_meeting',
      source: 'graph_api',
      actor: 'assistant',
      target: created.id,
      details: { subject: params.subject, start: params.start, attendees: params.attendees },
      outcome: 'success',
    });

    logger.info('Meeting created', { id: created.id, subject: params.subject, start: params.start });
    // v3.2.x (#121) — a write changes calendar state; drop the cache so the
    // next read (Maelle re-checking the day) never returns pre-write state.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('./calendarCache') as typeof import('./calendarCache')).invalidateCalendarCache(params.userEmail, 'create_meeting');
    const joinUrl: string | undefined = created?.onlineMeeting?.joinUrl;
    return { id: created.id, joinUrl };
  } catch (err) {
    auditLog({
      action: 'create_meeting',
      source: 'graph_api',
      actor: 'assistant',
      details: { subject: params.subject, error: String(err) },
      outcome: 'failure',
    });
    logger.error('Failed to create meeting', { err, subject: params.subject });
    throw err;
  }
}
