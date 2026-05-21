/**
 * Venue catalog — owner-curated external meeting venues (cafés, restaurants,
 * pubs, customer offices). Powers the `venue` skill (v2.9).
 *
 * Ranks:
 *   3 = favorite — surface first when searching
 *   2 = good     — included in normal results (DEFAULT for newly-saved venues)
 *   1 = avoid    — hidden by default; surfaced only when caller passes
 *                  includeHidden=true
 *   NULL         = unranked (shouldn't happen at steady state; existing rows
 *                  predating this code may carry NULL)
 *
 * Rows are written:
 *   - automatically when create_meeting books a non-company location
 *     (save-on-book hook in skills/meetings/ops.ts)
 *   - manually when the owner explicitly asks Maelle to save a venue
 */

import crypto from 'crypto';
import { getDb } from './client';
import logger from '../utils/logger';

export interface VenueRow {
  id: string;
  owner_user_id: string;
  name: string;
  branch_name: string | null;
  address: string | null;
  area_tags: string[];       // parsed JSON
  type: string | null;
  type_tags: string[];       // parsed JSON
  phone: string | null;
  reservation_url: string | null;
  place_id: string | null;
  booking_links: Array<{ platform: string; url: string }>;  // parsed JSON
  notes: string | null;
  rank: 1 | 2 | 3 | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface VenueInsert {
  ownerUserId: string;
  name: string;
  branchName?: string;
  address?: string;
  areaTags?: string[];
  type?: string;
  typeTags?: string[];
  phone?: string;
  reservationUrl?: string;
  placeId?: string;
  bookingLinks?: Array<{ platform: string; url: string }>;
  notes?: string;
  rank?: 1 | 2 | 3 | null;
}

interface VenueUpdate {
  branchName?: string;
  address?: string;
  areaTags?: string[];
  type?: string;
  typeTags?: string[];
  phone?: string;
  reservationUrl?: string;
  placeId?: string;
  bookingLinks?: Array<{ platform: string; url: string }>;
  notes?: string;
  rank?: 1 | 2 | 3 | null;
  lastUsedAt?: string;
}

function rowToVenue(r: any): VenueRow {
  return {
    id: r.id,
    owner_user_id: r.owner_user_id,
    name: r.name,
    branch_name: r.branch_name ?? null,
    address: r.address ?? null,
    area_tags: safeParseJsonArray(r.area_tags),
    type: r.type ?? null,
    type_tags: safeParseJsonArray(r.type_tags),
    phone: r.phone ?? null,
    reservation_url: r.reservation_url ?? null,
    place_id: r.place_id ?? null,
    booking_links: safeParseBookingLinks(r.booking_links),
    notes: r.notes ?? null,
    rank: (r.rank as 1 | 2 | 3 | null) ?? null,
    last_used_at: r.last_used_at ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function safeParseJsonArray(s: unknown): string[] {
  if (typeof s !== 'string' || s.length === 0) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}
function safeParseBookingLinks(s: unknown): Array<{ platform: string; url: string }> {
  if (typeof s !== 'string' || s.length === 0) return [];
  try {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(x => x && typeof x.platform === 'string' && typeof x.url === 'string');
  } catch { return []; }
}

export function insertVenue(input: VenueInsert): VenueRow {
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO venues (id, owner_user_id, name, branch_name, address, area_tags,
                        type, type_tags, phone, reservation_url, place_id,
                        booking_links, notes, rank, created_at, updated_at)
    VALUES (@id, @owner_user_id, @name, @branch_name, @address, @area_tags,
            @type, @type_tags, @phone, @reservation_url, @place_id,
            @booking_links, @notes, @rank, datetime('now'), datetime('now'))
  `).run({
    id,
    owner_user_id: input.ownerUserId,
    name: input.name,
    branch_name: input.branchName ?? null,
    address: input.address ?? null,
    area_tags: JSON.stringify(input.areaTags ?? []),
    type: input.type ?? null,
    type_tags: JSON.stringify(input.typeTags ?? []),
    phone: input.phone ?? null,
    reservation_url: input.reservationUrl ?? null,
    place_id: input.placeId ?? null,
    booking_links: JSON.stringify(input.bookingLinks ?? []),
    notes: input.notes ?? null,
    rank: input.rank ?? 2,  // default 2 — silent insert per owner direction
  });
  logger.info('venue created', { id, name: input.name, type: input.type, rank: input.rank ?? 2 });
  return getVenueById(id)!;
}

export function getVenueById(id: string): VenueRow | null {
  const r = getDb().prepare('SELECT * FROM venues WHERE id = ?').get(id);
  return r ? rowToVenue(r) : null;
}

/**
 * Normalize a venue identifier so dedup matches across address-string drift.
 *
 * Save-on-book at meetings/ops.ts stuffs the full "Name, Street, City"
 * resolution into the `name` column. Cross-visit Place API drift (city
 * aliasing, abbreviation, order) means the same physical place gets saved
 * with slightly different strings each visit → exact `lower(name)` dedup
 * misses → catalog accumulates duplicates of the same café.
 *
 * Heuristic: strip after the first comma + lowercase. Matches "Café X"
 * against "Café X, 123 Main St" against "Café X, Tel Aviv". Owner-typed
 * bare names also match. Proper fix (Place API place_id as canonical
 * key) tracked under issue #96; until then, this heuristic catches the
 * common case.
 */
function normalizeVenueName(s: string): string {
  const commaIdx = s.indexOf(',');
  const head = commaIdx >= 0 ? s.slice(0, commaIdx) : s;
  return head.trim().toLowerCase();
}

export function findVenueByNameAndOwner(ownerUserId: string, name: string): VenueRow | null {
  // Two passes: exact-name first (cheap, common case), then normalized
  // head-only match (catches Place API drift across visits to the same
  // venue). The normalized pass runs an in-memory filter over the
  // owner's venues — venues per owner stay bounded (dozens to low
  // hundreds), so the per-call cost is negligible vs adding a column.
  const db = getDb();
  const exact = db.prepare(`
    SELECT * FROM venues
    WHERE owner_user_id = ? AND lower(name) = lower(?)
    ORDER BY last_used_at DESC NULLS LAST
    LIMIT 1
  `).get(ownerUserId, name);
  if (exact) return rowToVenue(exact);
  const target = normalizeVenueName(name);
  if (!target) return null;
  const candidates = db.prepare(`
    SELECT * FROM venues
    WHERE owner_user_id = ?
    ORDER BY last_used_at DESC NULLS LAST
  `).all(ownerUserId) as Array<{ name: string; [k: string]: unknown }>;
  for (const c of candidates) {
    if (normalizeVenueName(c.name) === target) return rowToVenue(c);
  }
  return null;
}

export function updateVenue(id: string, patch: VenueUpdate): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  const map: Array<[keyof VenueUpdate, string, (v: unknown) => unknown]> = [
    ['branchName',      'branch_name',     v => v],
    ['address',         'address',         v => v],
    ['areaTags',        'area_tags',       v => JSON.stringify(v ?? [])],
    ['type',            'type',            v => v],
    ['typeTags',        'type_tags',       v => JSON.stringify(v ?? [])],
    ['phone',           'phone',           v => v],
    ['reservationUrl',  'reservation_url', v => v],
    ['placeId',         'place_id',        v => v],
    ['bookingLinks',    'booking_links',   v => JSON.stringify(v ?? [])],
    ['notes',           'notes',           v => v],
    ['rank',            'rank',            v => v],
    ['lastUsedAt',      'last_used_at',    v => v],
  ];
  for (const [key, col, transform] of map) {
    if (key in patch) {
      sets.push(`${col} = @${col}`);
      params[col] = transform(patch[key]);
    }
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = datetime('now')`);
  getDb().prepare(`UPDATE venues SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

/**
 * Find candidate venues for the owner by type and area, ranked.
 * Sort: rank=3 first, rank=2 next, NULL last; within a rank tier, most-recently-used first.
 * Hidden (rank=1) rows are EXCLUDED unless `includeHidden` is true.
 *
 * Area matching is a substring case-insensitive match against area_tags JSON;
 * the `area` param is split on commas / pipes / "and"-style separators so
 * "Tel Aviv, Ramat Gan" matches venues tagged with EITHER.
 */
export function findVenuesByCriteria(params: {
  ownerUserId: string;
  type?: string | null;
  typeTags?: string[];           // refinements; ANY-of match
  area?: string | null;          // free text; substring match against area_tags
  nameHint?: string | null;      // substring match against name
  limit?: number;                // hard cap on returned rows (default 10)
  includeHidden?: boolean;       // include rank=1
}): VenueRow[] {
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
  const rows = getDb().prepare(`
    SELECT * FROM venues
    WHERE owner_user_id = ?
    ORDER BY
      CASE WHEN rank = 3 THEN 0
           WHEN rank = 2 THEN 1
           WHEN rank IS NULL THEN 2
           ELSE 3 END,
      COALESCE(last_used_at, '') DESC
  `).all(params.ownerUserId) as any[];

  const venues = rows.map(rowToVenue);
  const typeLower = params.type?.toLowerCase().trim() ?? '';
  const typeTagsLower = (params.typeTags ?? []).map(t => t.toLowerCase().trim()).filter(Boolean);
  const areaTokens = areaTokensFromString(params.area ?? '');
  const nameHintLower = params.nameHint?.toLowerCase().trim() ?? '';

  const filtered = venues.filter(v => {
    if (!params.includeHidden && v.rank === 1) return false;
    if (typeLower && v.type && v.type.toLowerCase() !== typeLower) return false;
    if (typeTagsLower.length > 0) {
      const tags = v.type_tags.map(t => t.toLowerCase());
      const anyMatch = typeTagsLower.some(t => tags.includes(t));
      if (!anyMatch) return false;
    }
    if (areaTokens.length > 0) {
      const tags = v.area_tags.map(t => t.toLowerCase()).join(' | ');
      const addr = (v.address ?? '').toLowerCase();
      const anyMatch = areaTokens.some(tok => tags.includes(tok) || addr.includes(tok));
      if (!anyMatch) return false;
    }
    if (nameHintLower) {
      const blob = `${v.name} ${v.branch_name ?? ''}`.toLowerCase();
      if (!blob.includes(nameHintLower)) return false;
    }
    return true;
  });

  return filtered.slice(0, limit);
}

/**
 * Count rank=1 (hidden) venues matching a criteria — same matching logic as
 * findVenuesByCriteria, but only the avoid pile. Used to surface
 * "N other places you've ranked low in this area" so the owner can ask to see
 * them.
 */
export function countHiddenVenues(params: {
  ownerUserId: string;
  type?: string | null;
  typeTags?: string[];
  area?: string | null;
}): number {
  const rows = findVenuesByCriteria({
    ownerUserId: params.ownerUserId,
    type: params.type,
    typeTags: params.typeTags,
    area: params.area,
    includeHidden: true,
    limit: 50,
  });
  return rows.filter(v => v.rank === 1).length;
}

function areaTokensFromString(area: string): string[] {
  if (!area || area.trim().length === 0) return [];
  // Split on commas, pipes, " and ", " or ", " - "
  const parts = area
    .split(/,|\||\band\b|\bor\b|—| - /i)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0);
  return parts;
}

/**
 * Heuristic check: is the given location string a "company space" (owner's own
 * office labels: Idan Office / Meeting Room / Office / Huddle / Reflectiz HQ ...)
 * — those are NOT external venues and should not be auto-saved.
 *
 * Reads from `profile.meetings.office_location.*` so it stays cloneable.
 */
export function isCompanyLocation(
  location: string,
  officeLabels: { short_label?: string; meeting_room_label?: string; small_meeting_room_label?: string; full_label?: string },
): boolean {
  if (!location || location.trim().length === 0) return true;  // empty = not external
  const loc = location.trim().toLowerCase();
  if (loc === 'huddle') return true;
  const candidates = [
    officeLabels.short_label,
    officeLabels.meeting_room_label,
    officeLabels.small_meeting_room_label,
    officeLabels.full_label,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0).map(s => s.toLowerCase());
  if (candidates.includes(loc)) return true;
  // Teams join URL (online meetings get the URL patched into location)
  if (loc.startsWith('https://teams.microsoft.com/')) return true;
  // Microsoft Teams Meeting sentinel
  if (loc === 'microsoft teams meeting' || loc === 'microsoft teams') return true;
  return false;
}
