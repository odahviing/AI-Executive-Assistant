/** Record completed booking mutations once in the canonical person interaction log.
 * Only active booking engagement earns a row; calendar observation does not. */
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
  /** This producer records completed bookings only. */
  mutation: 'booked';
}

const VERB_BY_MUTATION: Record<RecordBookingParams['mutation'], string> = {
  booked: 'Booked',
};

// v3.1.7 — meeting attendees aren't always people. Recording/notetaker bots
// (Gong, Otter, Fireflies, …), no-reply/notification senders, and calendar
// resource mailboxes ride along on the invite — they must NOT become "person"
// rows. Conservative by design: only obvious non-humans, never a real contact.
const BOT_DOMAIN_FRAGMENTS = [
  'gong.io', 'otter.ai', 'fireflies.ai', 'read.ai', 'fathom.video',
  'recall.ai', 'avoma.com', 'tldv.io', 'sembly.ai', 'fellow.app',
  'resource.calendar.google.com',
];
// Exported — reused by the email inbound path (#24) so the "is this a
// real human" filter has one definition, not a second bot-domain list.
export function isNonHumanAttendee(email: string): boolean {
  const e = email.toLowerCase();
  const localPart = e.split('@')[0] ?? '';
  const domain = e.split('@')[1] ?? '';
  if (/^(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|postmaster)$/.test(localPart)) return true;
  if (/(^|[._-])(no-?reply|do-?not-?reply|notification)([._-]|$)/.test(localPart)) return true;
  return BOT_DOMAIN_FRAGMENTS.some(frag => domain === frag || domain.endsWith('.' + frag) || domain.endsWith(frag));
}

export async function recordBookingInPersonMemory(params: RecordBookingParams): Promise<void> {
  if (!params.subject || !params.attendees?.length) return;

  try {
    // Lazy-load DB + memory writer to avoid circular-import risk from
    // skills/meetings/ops.ts → here → db → ... back into skills.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolvePerson, appendPersonInteractionById } = require('../db') as typeof import('../db');

    const ownerEmail = params.profile.user.email.toLowerCase();
    const ownerDomain = ownerEmail.split('@')[1] ?? '';
    const assistantEmail = (params.profile.assistant.email ?? '').toLowerCase();
    // v3.2.0 — resource mailboxes (the meeting room) are attendees on the
    // calendar event but are NOT people; skip them so resolvePerson doesn't
    // mint a spurious "person" row for the room.
    const roomEmail = (params.profile.meetings.room_email ?? '').toLowerCase();
    const tz = params.profile.user.timezone;

    const whenDt = DateTime.fromISO(params.startIso, { zone: tz });
    const whenLabel = whenDt.isValid ? whenDt.toFormat('EEE d MMM HH:mm') : params.startIso;
    const verb = VERB_BY_MUTATION[params.mutation];
    const locPart = params.location && params.location.trim().length > 0
      ? ` at ${params.location.trim()}`
      : '';

    for (const att of params.attendees) {
      const email = (att.email ?? '').toLowerCase();
      if (!email) continue;
      if (email === ownerEmail) continue;
      if (assistantEmail && email === assistantEmail) continue;
      if (roomEmail && email === roomEmail) continue;
      if (isNonHumanAttendee(email)) continue;  // recording bots / no-reply / resource mailboxes

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
          type: 'meeting_booked',
          summary: `${verb} "${params.subject}"${locPart} for ${whenLabel}`,
        });
      } catch (err) {
        logger.warn('recordBooking: interaction-log append failed', { email, err: String(err).slice(0, 200) });
      }


    }
  } catch (err) {
    logger.warn('recordBookingInPersonMemory threw — booking still succeeded', {
      subject: params.subject, err: String(err).slice(0, 200),
    });
  }
}
