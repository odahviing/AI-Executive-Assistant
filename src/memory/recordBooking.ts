/**
 * v3.0.6 — auto-write a booking record into each non-owner attendee's
 * person_memory md file when a meeting is successfully booked / moved /
 * finalized via coord. Code-driven (no Sonnet judgment), runs once per
 * mutation. Closes the gap surfaced 2026-05-25 where Maelle had booked a
 * Modiin lunch meeting with Natan earlier in the day but had NO memory of
 * the venue she'd negotiated when asked about it that night — because the
 * existing capturePass only runs on COLLEAGUE DM threads, not on owner DM
 * threads that drive a booking.
 *
 * What gets written:
 *   Section: "What we've discussed"
 *   Line:    "- [YYYY-MM-DD] Booked '<subject>' at <location> for <when>"
 *
 * Where it's keyed (v3.2.0 — Unified Person Store):
 *   Every attendee is resolved through `resolvePerson({email, name})`, which
 *   FINDS-OR-CREATES the person row — internal AND external. Pure-email
 *   externals (gmail candidates, customers) are NO LONGER skipped: they get a
 *   person row on first booking, the booking is appended to their structured
 *   `interaction_log` (DB-first), and the md "What we've discussed" note is
 *   written after (keyed by person_id). Next time the owner books them, the
 *   history is already on file.
 *
 * Never throws. A failure here must never undo a successful booking.
 */
import type { UserProfile } from '../config/userProfile';
import { DateTime } from 'luxon';
import logger from '../utils/logger';

export interface RecordBookingParams {
  profile: UserProfile;
  subject: string;
  startIso: string;
  location?: string;
  /**
   * Attendees from the booking call. `slack_id`, when the flow already knows
   * it, is the STRONGEST dedup handle — resolvePerson matches an existing
   * internal colleague by slack_id even if their row has no email on file or a
   * differently-spelled name (closes the duplicate-row edge).
   */
  attendees: Array<{ email: string; name?: string; slack_id?: string }>;
  /** Kind of mutation — drives the verb in the line. */
  mutation: 'booked' | 'moved' | 'updated';
}

const VERB_BY_MUTATION: Record<RecordBookingParams['mutation'], string> = {
  booked: 'Booked',
  moved: 'Moved',
  updated: 'Updated',
};

export async function recordBookingInPersonMemory(params: RecordBookingParams): Promise<void> {
  if (!params.subject || !params.attendees?.length) return;

  try {
    // Lazy-load DB + memory writer to avoid circular-import risk from
    // skills/meetings/ops.ts → here → db → ... back into skills.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolvePerson, appendPersonInteractionById } = require('../db') as typeof import('../db');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { writePersonSection, readPersonMemorySync } = require('./peopleMemory') as typeof import('./peopleMemory');

    const ownerEmail = params.profile.user.email.toLowerCase();
    const ownerDomain = ownerEmail.split('@')[1] ?? '';
    const assistantEmail = (params.profile.assistant.email ?? '').toLowerCase();
    // v3.2.0 — resource mailboxes (the meeting room) are attendees on the
    // calendar event but are NOT people; skip them so resolvePerson doesn't
    // mint a spurious "person" row for the room.
    const roomEmail = (params.profile.meetings.room_email ?? '').toLowerCase();
    const tz = params.profile.user.timezone;

    const whenDt = DateTime.fromISO(params.startIso, { zone: tz });
    const dateStr = whenDt.isValid ? whenDt.toFormat('yyyy-MM-dd') : '????-??-??';
    const whenLabel = whenDt.isValid ? whenDt.toFormat('EEE d MMM HH:mm') : params.startIso;
    const verb = VERB_BY_MUTATION[params.mutation];
    const locPart = params.location && params.location.trim().length > 0
      ? ` at ${params.location.trim()}`
      : '';
    const newLine = `- [${dateStr}] ${verb} "${params.subject}"${locPart} for ${whenLabel}`;

    for (const att of params.attendees) {
      const email = (att.email ?? '').toLowerCase();
      if (!email) continue;
      if (email === ownerEmail) continue;
      if (assistantEmail && email === assistantEmail) continue;
      if (roomEmail && email === roomEmail) continue;

      // v3.2.0 — find-or-create the person (internal OR external). slack_id
      // (when known) is the strongest handle and dedups against an existing
      // internal row regardless of stored email/name; pure-email candidates
      // get a row created on first booking instead of being skipped.
      const resolved = resolvePerson({ slackId: att.slack_id, email, name: att.name, ownerDomain });
      if (!resolved) continue;
      const person = resolved.row;

      // DB-first: append the booking to the structured interaction timeline so
      // the last-N-interactions recall (used when booking) includes externals.
      try {
        appendPersonInteractionById(person.person_id, {
          type: params.mutation === 'booked' ? 'meeting_booked' : 'coordination',
          summary: `${verb} "${params.subject}"${locPart} for ${whenLabel}`,
        });
      } catch (err) {
        logger.warn('recordBooking: interaction-log append failed', { email, err: String(err).slice(0, 200) });
      }

      // Then the md narrative note, keyed by person_id.
      const existing = readPersonMemorySync(params.profile, person.person_id, person.name) ?? '';

      // Append the new line to "What we've discussed" — DON'T replace.
      // Match capturePass behavior: append latest line, keep history.
      const sectionRegex = /## What we've discussed\s*\n([\s\S]*?)(?=\n## |\n*$)/i;
      let newBody: string;
      const m = existing.match(sectionRegex);
      if (m && m[1].trim().length > 0) {
        // Existing body — append the new line.
        newBody = `${m[1].trim()}\n${newLine}`;
      } else {
        // Section absent or empty — start fresh.
        newBody = newLine;
      }

      try {
        await writePersonSection({
          profile: params.profile,
          personId: person.person_id,
          displayName: person.name,
          section: "What we've discussed",
          text: newBody,
        });
      } catch (err) {
        logger.warn('recordBooking: writePersonSection failed for attendee', {
          email, personId: person.person_id, err: String(err).slice(0, 200),
        });
      }
    }
  } catch (err) {
    logger.warn('recordBookingInPersonMemory threw — booking still succeeded', {
      subject: params.subject, err: String(err).slice(0, 200),
    });
  }
}
