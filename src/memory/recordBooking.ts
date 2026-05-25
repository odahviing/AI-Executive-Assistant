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
 * Where it's keyed:
 *   By Slack ID (via people_memory). Externals without a slack_id are
 *   silently skipped — they don't have a md file in the current model.
 *   Future improvement: a parallel `external_contacts` store.
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
  /** Attendees from the booking call. Each entry: email + optional name. */
  attendees: Array<{ email: string; name?: string }>;
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
    const { searchPeopleMemory } = require('../db') as typeof import('../db');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { writePersonSection, readPersonMemorySync, slugifyName } = require('./peopleMemory') as typeof import('./peopleMemory');

    const ownerEmail = params.profile.user.email.toLowerCase();
    const assistantEmail = (params.profile.assistant.email ?? '').toLowerCase();
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

      // Resolve slack_id via people_memory (email → slack_id). External
      // attendees with no Slack-resolvable email are skipped — they have no
      // md file in this model.
      const matches = searchPeopleMemory(email);
      const person = matches.find(m => (m.email ?? '').toLowerCase() === email);
      if (!person) {
        logger.debug('recordBooking: skipping external attendee (no people_memory row)', { email });
        continue;
      }

      const slug = slugifyName(person.name);
      const existing = readPersonMemorySync(params.profile, slug) ?? '';

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
          slug,
          displayName: person.name,
          section: "What we've discussed",
          text: newBody,
        });
      } catch (err) {
        logger.warn('recordBooking: writePersonSection failed for attendee', {
          email, slug, err: String(err).slice(0, 200),
        });
      }
    }
  } catch (err) {
    logger.warn('recordBookingInPersonMemory threw — booking still succeeded', {
      subject: params.subject, err: String(err).slice(0, 200),
    });
  }
}
