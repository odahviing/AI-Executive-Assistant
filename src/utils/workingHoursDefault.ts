/** One recorded regular week per person. Dated travel/override policy is owned
 * by its existing callers and does not change this base schedule. */
import { getDb } from '../db/client';
import type { PersonMemory } from '../db/people';
import { isStrictIana } from './timezoneValidator';

export const WEEK_ORDER = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export type WeekDay = typeof WEEK_ORDER[number];
export interface ClockWindow { hoursStart: string; hoursEnd: string }
export type WeeklySchedule = Record<WeekDay, ClockWindow | null>;
export interface WorkingHours { week: WeeklySchedule; timezone?: string; source: 'manual' | 'auto' }
export interface WorkingHoursUpdate { week: Partial<WeeklySchedule>; timezone?: string }
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function validateDays(raw: unknown, complete: boolean): asserts raw is WeeklySchedule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid regular week');
  const days = raw as Record<string, unknown>;
  if (Object.keys(days).some(d => !WEEK_ORDER.includes(d as WeekDay)) || (complete && WEEK_ORDER.some(d => !(d in days)))) throw new Error('Invalid regular week');
  for (const hours of Object.values(days)) {
    if (hours === null) continue;
    if (!hours || typeof hours !== 'object' || Array.isArray(hours)) throw new Error('Invalid working hours');
    const h = hours as ClockWindow;
    if (Object.keys(h).some(k => !['hoursStart', 'hoursEnd'].includes(k)) || typeof h.hoursStart !== 'string' || typeof h.hoursEnd !== 'string' || !clock.test(h.hoursStart) || !clock.test(h.hoursEnd) || h.hoursStart >= h.hoursEnd) throw new Error('Invalid working hours');
  }
}

export function defaultWorkingHoursForTz(iana: string | null | undefined): WorkingHours {
  const israel = iana === 'Asia/Jerusalem' || iana === 'Asia/Tel_Aviv';
  const workdays: readonly WeekDay[] = israel ? WEEK_ORDER.slice(0, 5) : WEEK_ORDER.slice(1, 6);
  return { week: Object.fromEntries(WEEK_ORDER.map(day => [day, workdays.includes(day) ? { hoursStart: '09:00', hoursEnd: israel ? '18:00' : '17:00' } : null])) as WeeklySchedule, source: 'auto' };
}

/** Recurring edits replace supplied days in the base; absent days survive. */
export function mergeWorkingHoursUpdate(existing: WorkingHours | undefined, update: unknown, defaults?: WorkingHours): WorkingHours {
  if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('Invalid working hours');
  const value = update as WorkingHoursUpdate;
  if (Object.keys(value).some(k => !['week', 'timezone'].includes(k)) || (value.timezone !== undefined && !isStrictIana(value.timezone))) throw new Error('Invalid working hours');
  validateDays(value.week, false);
  const prior = existing ?? defaults;
  const week = { ...prior?.week, ...value.week } as WeeklySchedule;
  validateDays(week, true);
  return { week, source: 'manual', ...(value.timezone ?? prior?.timezone ? { timezone: value.timezone ?? prior?.timezone } : {}) };
}

/** Migration-only conversion of the retired base/permanent-weekday format.
 * Authority tags are carried by the surrounding profile and remain untouched. */
export function materializeLegacyWorkingHours(stated: unknown, auto: unknown, timezone: string | null): WorkingHours | null {
  // Validate even a superseded auto record before retiring it: malformed
  // source data requires review, not silent deletion under a valid manual row.
  if (auto != null) {
    if (typeof auto !== 'object' || Array.isArray(auto)) throw new Error('Invalid legacy auto hours');
    const value = auto as { workdays?: unknown; hoursStart?: unknown; hoursEnd?: unknown };
    if (Object.keys(value).some(k => !['workdays', 'hoursStart', 'hoursEnd'].includes(k))
      || !Array.isArray(value.workdays) || !value.workdays.length || !value.workdays.every(d => WEEK_ORDER.includes(d))
      || typeof value.hoursStart !== 'string' || typeof value.hoursEnd !== 'string'
      || !clock.test(value.hoursStart) || !clock.test(value.hoursEnd) || value.hoursStart >= value.hoursEnd) throw new Error('Invalid legacy auto hours');
  }
  if (stated && typeof stated === 'object' && 'week' in stated) {
    const current = stated as WorkingHours;
    if (Object.keys(current).some(k => !['week', 'source', 'timezone'].includes(k))) throw new Error('Invalid recorded week');
    validateDays(current.week, true);
    if (!['manual', 'auto'].includes(current.source) || (current.timezone !== undefined && !isStrictIana(current.timezone))) throw new Error('Invalid recorded week');
    return current;
  }
  const legacy = stated as { workdays?: WeekDay[]; hoursStart?: string; hoursEnd?: string; dayOverrides?: Partial<Record<WeekDay, ClockWindow>>; timezone?: string } | undefined;
  const inferred = auto as { workdays?: WeekDay[]; hoursStart?: string; hoursEnd?: string } | undefined;
  if (legacy && (typeof legacy !== 'object' || Array.isArray(legacy) || Object.keys(legacy).some(k => !['workdays', 'hoursStart', 'hoursEnd', 'dayOverrides', 'timezone'].includes(k)))) throw new Error('Invalid legacy working hours');
  if (legacy?.dayOverrides !== undefined) {
    validateDays(legacy.dayOverrides, false);
    if (Object.values(legacy.dayOverrides).some(h => h === null)) throw new Error('Invalid legacy day override');
  }
  if (!legacy && !inferred && !timezone) return null;
  const defaults = defaultWorkingHoursForTz(timezone);
  const first = Object.values(defaults.week).find(Boolean)!;
  const days = legacy?.workdays ?? (timezone ? WEEK_ORDER.filter(d => defaults.week[d]) : inferred?.workdays);
  if (!days || days.some(d => !WEEK_ORDER.includes(d))) throw new Error('Invalid legacy workdays');
  // The old manual reader used regional defaults for omitted clocks, never
  // the separately stored auto clocks. Preserve that exact effective value.
  const start = legacy ? legacy.hoursStart ?? (timezone ? first.hoursStart : undefined) : inferred?.hoursStart ?? first.hoursStart;
  const end = legacy ? legacy.hoursEnd ?? (timezone ? first.hoursEnd : undefined) : inferred?.hoursEnd ?? first.hoursEnd;
  if (typeof start !== 'string' || typeof end !== 'string' || !clock.test(start) || !clock.test(end) || start >= end) throw new Error('Invalid legacy clocks');
  const week = Object.fromEntries(WEEK_ORDER.map(day => [day, legacy?.dayOverrides?.[day] ?? (days.includes(day) ? { hoursStart: start, hoursEnd: end } : null)])) as WeeklySchedule;
  validateDays(week, true);
  if (legacy?.timezone !== undefined && !isStrictIana(legacy.timezone)) throw new Error('Invalid legacy timezone');
  return { week, source: legacy ? 'manual' : 'auto', ...(legacy?.timezone ? { timezone: legacy.timezone } : {}) };
}

export function refreshAutoWorkingHours(slackId: string): void {
  const row = getDb().prepare('SELECT person_id FROM people_memory WHERE slack_id = ?').get(slackId) as { person_id: string } | undefined;
  if (row) refreshAutoWorkingHoursById(row.person_id);
}

/** Initialize once. A later timezone change never rewrites the regular week. */
export function refreshAutoWorkingHoursById(personId: string): void {
  const db = getDb();
  const row = db.prepare('SELECT timezone, profile_json FROM people_memory WHERE person_id = ?').get(personId) as { timezone: string | null; profile_json: string | null } | undefined;
  if (!row?.timezone) return;
  const profile = JSON.parse(row.profile_json || '{}');
  if (profile.working_hours_structured) return;
  profile.working_hours_structured = defaultWorkingHoursForTz(row.timezone);
  db.prepare("UPDATE people_memory SET profile_json = ?, working_hours_auto = NULL, updated_at = datetime('now') WHERE person_id = ?").run(JSON.stringify(profile), personId);
}

export function getEffectiveWorkingHours(person: PersonMemory): WorkingHours | null {
  try {
    const hours = JSON.parse(person.profile_json || '{}').working_hours_structured as WorkingHours | undefined;
    if (!hours) return null;
    validateDays(hours.week, true);
    if (!['manual', 'auto'].includes(hours.source) || (hours.timezone !== undefined && !isStrictIana(hours.timezone))) return null;
    return hours;
  } catch { return null; }
}

export function formatWorkingHoursWindow(hours: Pick<WorkingHours, 'week' | 'timezone'>): string {
  const groups = new Map<string, WeekDay[]>();
  for (const day of WEEK_ORDER) {
    const window = hours.week[day];
    const key = window ? `${window.hoursStart}–${window.hoursEnd}` : 'off';
    groups.set(key, [...(groups.get(key) ?? []), day]);
  }
  const names = (days: WeekDay[]): string => {
    const indices = days.map(d => WEEK_ORDER.indexOf(d));
    return days.length > 1 && indices.every((n, i) => !i || n === indices[i - 1] + 1)
      ? `${days[0].slice(0, 3)}–${days[days.length - 1].slice(0, 3)}` : days.map(d => d.slice(0, 3)).join('/');
  };
  return [...groups].sort(([a], [b]) => Number(a === 'off') - Number(b === 'off')).map(([window, days]) => `${names(days)} ${window}`).join('; ') + (hours.timezone ? ` ${hours.timezone}` : '');
}

export function describeEffectiveWorkingHours(person: PersonMemory): (Omit<WorkingHours, 'timezone'> & { timezone: string | null; window: string }) | null {
  const hours = getEffectiveWorkingHours(person);
  if (!hours) return null;
  const timezone = hours.timezone ?? person.timezone ?? null;
  return { ...hours, timezone, window: formatWorkingHoursWindow({ ...hours, timezone: timezone ?? undefined }) };
}
