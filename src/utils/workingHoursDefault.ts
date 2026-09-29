/**
 * Inferred workweeks use the person's own timezone region, never a tenant's
 * personal schedule: Israel Sunday–Thursday, elsewhere Monday–Friday.
 * Explicit structured working hours always win. Auto weekdays are re-derived
 * on read so stored tenant-derived defaults cannot survive a policy change.
 */

import { getDb } from '../db/client';
import type { PersonMemory } from '../db/people';
import logger from './logger';
import { isStrictIana } from './timezoneValidator';

export type WeekDay =
  | 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday';

export interface WorkingHours {
  workdays: WeekDay[];
  hoursStart: string;   // "HH:MM"
  hoursEnd:   string;
  timezone?: string; // Explicit fixed timezone for this window, independent of travel.
  source: 'manual' | 'auto';
}

const WEEK_ORDER: WeekDay[] =
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const WESTERN_DEFAULT: Pick<WorkingHours, 'workdays' | 'hoursStart' | 'hoursEnd'> = {
  workdays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  hoursStart: '09:00', hoursEnd: '17:00',
};

export function defaultWorkingHoursForTz(iana: string | null | undefined): Pick<WorkingHours, 'workdays' | 'hoursStart' | 'hoursEnd'> {
  // IANA's historical Tel_Aviv link denotes the same Israeli region.
  if (iana === 'Asia/Jerusalem' || iana === 'Asia/Tel_Aviv') {
    return { workdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'], hoursStart: '09:00', hoursEnd: '18:00' };
  }
  return WESTERN_DEFAULT;
}

/**
 * Recompute and persist `working_hours_auto` for a person based on their
 * current timezone. Called from the same paths that write timezone (provenance
 * helper or upsert). Idempotent — silently no-ops when nothing's changed.
 *
 * Thin slack_id-keyed adapter over `refreshAutoWorkingHoursById` — kept for the
 * (internal-only) callers that already hold a slack_id rather than a person_id.
 */
export function refreshAutoWorkingHours(slackId: string): void {
  const db = getDb();
  const row = db.prepare(`SELECT person_id FROM people_memory WHERE slack_id = ?`).get(slackId) as
    | { person_id: string }
    | undefined;
  if (!row) return;
  refreshAutoWorkingHoursById(row.person_id);
}

/**
 * v4.2.x — person_id-keyed sibling of `refreshAutoWorkingHours`, so it works
 * for EXTERNALS too (no slack_id). Needed the moment a caller writes a
 * timezone onto a pure-email person (#24 row 129b, James Avery/Kevel): without
 * this, `working_hours_auto` stays NULL forever on an external row, and
 * `getEffectiveWorkingHours` has no manual override to fall back to either —
 * so a known timezone with no working-hours read as "unknown" and
 * `attendeeAvailability`'s clip silently skips the person rather than using a
 * sane default window for their zone. Same idempotent recompute-from-timezone
 * as the slack_id version (now its delegate).
 */
export function refreshAutoWorkingHoursById(personId: string): void {
  const db = getDb();
  const row = db.prepare(`SELECT timezone FROM people_memory WHERE person_id = ?`).get(personId) as
    | { timezone: string | null }
    | undefined;
  if (!row || !row.timezone) return;

  const defaults = defaultWorkingHoursForTz(row.timezone);
  const json = JSON.stringify(defaults);

  const existing = db.prepare(`SELECT working_hours_auto FROM people_memory WHERE person_id = ?`).get(personId) as
    | { working_hours_auto: string | null }
    | undefined;

  if (existing?.working_hours_auto === json) return;

  db.prepare(`UPDATE people_memory SET working_hours_auto = ?, updated_at = datetime('now') WHERE person_id = ?`)
    .run(json, personId);
  logger.debug('Auto working_hours refreshed', { personId, tz: row.timezone });
}

/**
 * Read effective working hours for a person — manual override (PersonProfile
 * .working_hours_structured) wins over the timezone-derived default. Returns
 * null when neither is available (no timezone known).
 */
export function getEffectiveWorkingHours(person: PersonMemory): WorkingHours | null {
  // Try manual override from profile_json first
  try {
    const profile = JSON.parse(person.profile_json || '{}') as { working_hours_structured?: WorkingHours };
    if (profile.working_hours_structured?.workdays?.length) {
      const m = profile.working_hours_structured;
      const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
      if (!Array.isArray(m.workdays) || !m.workdays.every(d => WEEK_ORDER.includes(d))
        || !clock.test(m.hoursStart) || !clock.test(m.hoursEnd)
        || (m.timezone !== undefined && !isStrictIana(m.timezone))) {
        throw new Error('Invalid structured working-hours window');
      }
      return {
        workdays:   m.workdays as WeekDay[],
        hoursStart: m.hoursStart,
        hoursEnd:   m.hoursEnd,
        source:     'manual',
        ...(m.timezone ? { timezone: m.timezone.trim() } : {}),
      };
    }
  } catch { /* ignore */ }

  // Fall back to auto-derived
  if (person.working_hours_auto) {
    try {
      const auto = JSON.parse(person.working_hours_auto) as Pick<WorkingHours, 'workdays' | 'hoursStart' | 'hoursEnd'>;
      const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
      if (Array.isArray(auto?.workdays) && auto.workdays.length > 0
          && auto.workdays.every(d => WEEK_ORDER.includes(d))
          && typeof auto.hoursStart === 'string' && clock.test(auto.hoursStart)
          && typeof auto.hoursEnd === 'string' && clock.test(auto.hoursEnd)) {
        return { ...auto, ...(person.timezone ? { workdays: defaultWorkingHoursForTz(person.timezone).workdays } : {}), source: 'auto' };
      }
    } catch { /* ignore */ }
  }

  return null;
}

/**
 * One compact human line for a window — "Sun–Thu 09:00–18:00", "Mon/Thu
 * 09:00–17:00 Asia/Jerusalem". Workdays contiguous in WEEK_ORDER collapse to a
 * range; anything else lists them. THE renderer for hours in every model-facing
 * read (the owner roster line in db/people.ts, get_person_memory and the write
 * echo in core/assistant.ts), so one stored window never reads two ways.
 */
export function formatWorkingHoursWindow(wh: Pick<WorkingHours, 'workdays' | 'hoursStart' | 'hoursEnd' | 'timezone'>): string {
  const idx = wh.workdays.map(d => WEEK_ORDER.indexOf(d)).filter(i => i >= 0).sort((a, b) => a - b);
  const contiguous = idx.length > 1 && idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  const days = contiguous
    ? `${WEEK_ORDER[idx[0]].slice(0, 3)}–${WEEK_ORDER[idx[idx.length - 1]].slice(0, 3)}`
    : idx.map(i => WEEK_ORDER[i].slice(0, 3)).join('/');
  return `${days} ${wh.hoursStart}–${wh.hoursEnd}${wh.timezone ? ` ${wh.timezone}` : ''}`;
}

/**
 * The model-facing view of a person's EFFECTIVE window: what scheduling clips
 * to, which tier it came from (`source`: a stated structured window, else the
 * timezone default), and the zone it is expressed in — the window's own fixed
 * zone when stated, else the person's permanent zone. Returned by
 * get_person_memory and echoed by update_person_profile after an hours write
 * (core/assistant.ts) — one shape for the read and for the write echo. Null
 * when nothing is known (no stated window and no timezone to derive from).
 */
export function describeEffectiveWorkingHours(person: PersonMemory): {
  source: WorkingHours['source'];
  workdays: WeekDay[];
  hoursStart: string;
  hoursEnd: string;
  timezone: string | null;
  window: string;
} | null {
  const eff = getEffectiveWorkingHours(person);
  if (!eff) return null;
  const timezone = eff.timezone ?? person.timezone ?? null;
  return {
    source:     eff.source,
    workdays:   eff.workdays,
    hoursStart: eff.hoursStart,
    hoursEnd:   eff.hoursEnd,
    timezone,
    window:     formatWorkingHoursWindow({ ...eff, timezone: timezone ?? undefined }),
  };
}
