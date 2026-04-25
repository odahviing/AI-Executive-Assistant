/**
 * Default working-hours derivation from a person's IANA timezone (v2.2.2, #46).
 *
 * Israel TZ → Sun–Thu, 09:00–17:00 (Israeli workweek).
 * Anywhere else → Mon–Fri, 09:00–17:00 (Western default).
 *
 * Persisted into `people_memory.working_hours_auto` whenever the timezone is
 * set or updated. Distinct from `PersonProfile.working_hours_structured` which
 * is the manual override path. Code paths that need working hours should call
 * `getEffectiveWorkingHours(person)` — manual wins, auto is fallback.
 */

import { getDb } from '../db/client';
import type { PersonMemory } from '../db/people';
import logger from './logger';

export type WeekDay =
  | 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday';

export interface WorkingHours {
  workdays: WeekDay[];
  hoursStart: string;   // "HH:MM"
  hoursEnd:   string;
  source: 'manual' | 'auto';
}

const ISRAEL_DEFAULT: Pick<WorkingHours, 'workdays' | 'hoursStart' | 'hoursEnd'> = {
  workdays:   ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'],
  hoursStart: '09:00',
  hoursEnd:   '17:00',
};

const WESTERN_DEFAULT: Pick<WorkingHours, 'workdays' | 'hoursStart' | 'hoursEnd'> = {
  workdays:   ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  hoursStart: '09:00',
  hoursEnd:   '17:00',
};

export function defaultWorkingHoursForTz(iana: string | null | undefined): Pick<WorkingHours, 'workdays' | 'hoursStart' | 'hoursEnd'> {
  if (!iana) return WESTERN_DEFAULT;
  return iana === 'Asia/Jerusalem' ? ISRAEL_DEFAULT : WESTERN_DEFAULT;
}

/**
 * Recompute and persist `working_hours_auto` for a person based on their
 * current timezone. Called from the same paths that write timezone (provenance
 * helper or upsert). Idempotent — silently no-ops when nothing's changed.
 */
export function refreshAutoWorkingHours(slackId: string): void {
  const db = getDb();
  const row = db.prepare(`SELECT timezone FROM people_memory WHERE slack_id = ?`).get(slackId) as
    | { timezone: string | null }
    | undefined;
  if (!row || !row.timezone) return;

  const defaults = defaultWorkingHoursForTz(row.timezone);
  const json = JSON.stringify(defaults);

  const existing = db.prepare(`SELECT working_hours_auto FROM people_memory WHERE slack_id = ?`).get(slackId) as
    | { working_hours_auto: string | null }
    | undefined;

  if (existing?.working_hours_auto === json) return;

  db.prepare(`UPDATE people_memory SET working_hours_auto = ?, updated_at = datetime('now') WHERE slack_id = ?`)
    .run(json, slackId);
  logger.debug('Auto working_hours refreshed', { slackId, tz: row.timezone });
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
      return {
        workdays:   m.workdays as WeekDay[],
        hoursStart: m.hoursStart,
        hoursEnd:   m.hoursEnd,
        source:     'manual',
      };
    }
  } catch { /* ignore */ }

  // Fall back to auto-derived
  if (person.working_hours_auto) {
    try {
      const auto = JSON.parse(person.working_hours_auto) as Pick<WorkingHours, 'workdays' | 'hoursStart' | 'hoursEnd'>;
      if (auto.workdays?.length) {
        return { ...auto, source: 'auto' };
      }
    } catch { /* ignore */ }
  }

  return null;
}
