/**
 * Default working-hours derivation from a person's IANA timezone (v2.2.2, #46;
 * generalized off the single hardcoded Israel case in #cloneable-default).
 *
 * A person whose timezone matches a configured tenant's OWN timezone
 * (`user.timezone` in `config/users/<tenant>.yaml`) gets that tenant's
 * own workweek — the union of `office_days` + `home_days` — with generic
 * business hours. Anywhere else → Mon–Fri, 09:00–17:00 (Western default).
 * This used to hardcode `iana === 'Asia/Jerusalem'` → Sun–Thu, which only
 * ever generalized for THIS deployment (Reflectiz/Israel); a clone run for
 * a tenant on a different Sun–Thu (or any non-Western) workweek got the
 * Western default regardless of their own configured schedule. Deriving the
 * workday SET from config (never the exact hours — a tenant's own split
 * shifts are a personal habit, not a regional convention) keeps this correct
 * for whichever tenant(s) are actually configured, no code change needed.
 *
 * Persisted into `people_memory.working_hours_auto` whenever the timezone is
 * set or updated. Distinct from `PersonProfile.working_hours_structured` which
 * is the manual override path. Code paths that need working hours should call
 * `getEffectiveWorkingHours(person)` — manual wins, auto is fallback.
 */

import { getDb } from '../db/client';
import type { PersonMemory } from '../db/people';
import { getTenantWorkdaysForTimezone } from '../config/userProfile';
import logger from './logger';

export type WeekDay =
  | 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday';

export interface WorkingHours {
  workdays: WeekDay[];
  hoursStart: string;   // "HH:MM"
  hoursEnd:   string;
  source: 'manual' | 'auto';
}

const WEEK_ORDER: WeekDay[] =
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Generic business hours applied whenever a person's timezone matches a
// configured tenant's own — a coarse fallback (superseded the moment a real
// value is known), never the tenant's actual (possibly split-shift) hours.
const TENANT_MATCH_HOURS = { hoursStart: '09:00', hoursEnd: '18:00' };

const WESTERN_DEFAULT: Pick<WorkingHours, 'workdays' | 'hoursStart' | 'hoursEnd'> = {
  workdays:   ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  hoursStart: '09:00',
  hoursEnd:   '17:00',
};

export function defaultWorkingHoursForTz(iana: string | null | undefined): Pick<WorkingHours, 'workdays' | 'hoursStart' | 'hoursEnd'> {
  if (!iana) return WESTERN_DEFAULT;

  // v4.4.x — utils no longer reaches for the raw multi-tenant loader
  // (`loadAllProfiles`) and re-derives the office/home-day union itself; that
  // was a utils -> config runtime dependency the wave's own sibling fix
  // (cloneable-default) was specifically about avoiding. The one fact this
  // needs — "does any configured tenant's own timezone match, and if so what
  // are their workdays" — comes from a single cache-backed accessor config
  // itself owns (getTenantWorkdaysForTimezone, same posture as
  // getProfileByEmail), never from utils loading and scanning every profile.
  try {
    const tenantDays = getTenantWorkdaysForTimezone(iana);
    if (tenantDays && tenantDays.length > 0) {
      const workdays = WEEK_ORDER.filter(d => tenantDays.includes(d));
      if (workdays.length > 0) {
        return { workdays, ...TENANT_MATCH_HOURS };
      }
    }
  } catch (err) {
    logger.debug('defaultWorkingHoursForTz — tenant profile lookup failed, using Western default', {
      iana, err: String(err).slice(0, 200),
    });
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
