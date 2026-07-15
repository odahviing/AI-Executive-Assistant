/**
 * Per-date work-schedule overrides (v3.7.x / #143).
 *
 * Chat-driven exceptions to the yaml schedule for a specific date. YAML is the
 * default; a row here WINS for that date; no row = yaml (fail-safe — resolved in
 * getEffectiveWorkDay). A non-null `timezone` marks an away day (work-hours
 * evaluated in that zone, booked directly — no forced approval). Any column left
 * null keeps the yaml base for that axis. All reads are sync (better-sqlite3) so
 * the hot validator checkSlot can consult them without going async.
 */
import { getDb } from './client';

export interface ScheduleOverride {
  date: string;                              // yyyy-MM-dd (owner home tz)
  isWorkday: boolean | null;                 // null=keep base · false=off · true=on
  windows: string[] | null;                  // ["09:00-17:00", ...] · null=keep base
  location: 'office' | 'home' | null;        // null=keep base
  timezone: string | null;                   // IANA · presence ⇒ away day · null=home tz
  source: string;
  note: string | null;
  created_at: string;
}

interface Row {
  date: string; is_workday: number | null; windows: string | null;
  location: string | null; timezone: string | null; source: string;
  note: string | null; created_at: string;
}

function mapRow(r: Row): ScheduleOverride {
  let windows: string[] | null = null;
  if (r.windows) {
    try {
      const p = JSON.parse(r.windows);
      if (Array.isArray(p)) windows = p.filter((x): x is string => typeof x === 'string');
    } catch { windows = null; }
  }
  return {
    date: r.date,
    isWorkday: r.is_workday === null ? null : r.is_workday === 1,
    windows,
    location: (r.location === 'office' || r.location === 'home') ? r.location : null,
    timezone: r.timezone,
    source: r.source,
    note: r.note,
    created_at: r.created_at,
  };
}

/** The override for one date, or null (no row = yaml default). Sync. */
export function getScheduleOverride(ownerSlackId: string, dateIso: string): ScheduleOverride | null {
  if (!ownerSlackId || !dateIso) return null;
  const r = getDb().prepare(
    `SELECT * FROM owner_schedule_overrides WHERE owner_slack_id = ? AND date = ?`,
  ).get(ownerSlackId, dateIso) as Row | undefined;
  return r ? mapRow(r) : null;
}

/** All overrides in a date range (inclusive), oldest-first. Drives the view tool
 *  + the away-day detector + the OWNER LOCATION prompt block. */
export function listScheduleOverrides(ownerSlackId: string, fromIso?: string, toIso?: string): ScheduleOverride[] {
  if (!ownerSlackId) return [];
  const clauses = ['owner_slack_id = ?'];
  const params: unknown[] = [ownerSlackId];
  if (fromIso) { clauses.push('date >= ?'); params.push(fromIso); }
  if (toIso) { clauses.push('date <= ?'); params.push(toIso); }
  const rows = getDb().prepare(
    `SELECT * FROM owner_schedule_overrides WHERE ${clauses.join(' AND ')} ORDER BY date ASC`,
  ).all(...params) as Row[];
  return rows.map(mapRow);
}

/** Upsert a date's override. MERGE semantics: a null field keeps the existing
 *  value, so "Tuesday from office" then "and work till 6" accumulates instead of
 *  wiping. To clear a whole date, use clearScheduleOverride. */
export function upsertScheduleOverride(ownerSlackId: string, o: {
  date: string; isWorkday?: boolean | null; windows?: string[] | null;
  location?: 'office' | 'home' | null; timezone?: string | null; source?: string; note?: string | null;
}): void {
  if (!ownerSlackId || !o.date) return;
  getDb().prepare(`
    INSERT INTO owner_schedule_overrides (owner_slack_id, date, is_workday, windows, location, timezone, source, note)
    VALUES (@owner, @date, @is_workday, @windows, @location, @timezone, @source, @note)
    ON CONFLICT(owner_slack_id, date) DO UPDATE SET
      is_workday = COALESCE(excluded.is_workday, owner_schedule_overrides.is_workday),
      windows    = COALESCE(excluded.windows,    owner_schedule_overrides.windows),
      location   = COALESCE(excluded.location,   owner_schedule_overrides.location),
      timezone   = COALESCE(excluded.timezone,   owner_schedule_overrides.timezone),
      source     = excluded.source,
      note       = COALESCE(excluded.note,       owner_schedule_overrides.note)
  `).run({
    owner: ownerSlackId,
    date: o.date,
    is_workday: (o.isWorkday === undefined || o.isWorkday === null) ? null : (o.isWorkday ? 1 : 0),
    windows: (o.windows && o.windows.length > 0) ? JSON.stringify(o.windows) : null,
    location: o.location ?? null,
    timezone: o.timezone ?? null,
    source: o.source ?? 'chat',
    note: o.note ?? null,
  });
}

/** Remove a date's override entirely (revert that date to the yaml default). */
export function clearScheduleOverride(ownerSlackId: string, dateIso: string): void {
  if (!ownerSlackId || !dateIso) return;
  getDb().prepare(
    `DELETE FROM owner_schedule_overrides WHERE owner_slack_id = ? AND date = ?`,
  ).run(ownerSlackId, dateIso);
}
