/**
 * VenueSkill (v2.9) — external-venue discovery + memory.
 *
 * Two flows:
 *   - Case 1: Owner names a venue ("Coffee Landwer Ness Ziona"). Tool resolves
 *     to canonical name + address + phone via Tavily; surfaces ambiguity when
 *     multiple branches match. Owner-explicit hint flows into create_meeting.
 *   - Case 2: Owner asks Maelle to FIND a venue ("a kosher restaurant in
 *     central Tel Aviv"). Tool searches Tavily, parses to up to 3 candidates,
 *     surfaces with rank annotations from the catalog.
 *
 * Catalog (rank 1-3):
 *   3 = favorite — surfaced first
 *   2 = good     — included normally (DEFAULT for newly-saved venues)
 *   1 = avoid    — hidden by default; visible via `include_hidden=true`
 *
 * Venues are saved automatically by the create_meeting handler when a
 * non-company location lands on a calendar event (save-on-book hook in
 * skills/meetings/ops.ts). Owner can re-rank via `rank_venue`.
 *
 * When this skill is OFF (`skills.venue: false`), `find_venue` and
 * `rank_venue` aren't shipped to Sonnet at all; the create_meeting save-on-book
 * hook is gated on the same toggle so the catalog stays clean.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import {
  findVenuesByCriteria,
  countHiddenVenues,
  findVenueByNameAndOwner,
  updateVenue,
  insertVenue,
  type VenueRow,
} from '../db/venues';
import {
  searchVenueCandidates,
  resolveVenueByName,
  evaluateVenueHours,
  type VenueCandidate,
  type HoursStatus,
} from '../utils/venueSearch';
import logger from '../utils/logger';

type FindVenueArgs = {
  area?: string;
  type?: string;
  type_tags?: string[];
  name_hint?: string;
  meeting_time?: string;          // v2.8.4 — ISO datetime; deterministic hours filter
  include_hidden?: boolean;
  max_options?: number;
};

type RankVenueArgs = {
  venue_id_or_name: string;
  rank: 1 | 2 | 3;
};

export class VenueSkill implements Skill {
  id = 'venue' as const;
  name = 'Venue';
  description = 'External-venue discovery (cafés, restaurants, pubs, customer offices) with owner-curated rank memory. Surfaces 3 options for area+type searches; resolves name+address for owner-named venues.';

  getTools(_profile: UserProfile): Anthropic.Tool[] {
    return [
      {
        name: 'find_venue',
        description: `Find external meeting venues for a non-company meeting (coffee, restaurant, pub, customer office, park).

Two modes — pass EITHER (or both):
- \`name_hint\` only → owner named a specific place ("Coffee Landwer Ness Ziona"). The tool resolves to the canonical name + address + phone. If multiple branches match, returns ambiguity_flag so you ask which one.
- \`area\` + \`type\` (+ optional \`type_tags\`) → owner asked Maelle to find a place. Tool returns up to 3 candidates, ordered by the owner's preferences (rank 3 first, rank 2 next, then unranked).

Ranks (from the owner's catalog of previously-booked venues):
- 3 = favorite — surface first; suggest it
- 2 = good     — include in normal options
- 1 = avoid    — HIDDEN by default. The result includes \`hidden_count\` so you can mention "there are N other places you've ranked low here — want to see them?". If owner says yes, re-call with \`include_hidden=true\` to surface them.

When the owner names a venue you've never booked before, the catalog doesn't have it yet; the tool returns the freshly-resolved candidate without rank metadata. After booking, the venue gets auto-saved with rank=2.

When you know the meeting time (or a tentative slot), pass it as \`meeting_time\` (ISO datetime). The tool deterministically filters out venues KNOWN to be closed at that time and tags each survivor with \`hours_status\`: \`open\` (verified open), \`closed\` (filtered out — won't be in results), or \`unknown\` (opening hours not in our data — Sonnet should surface this to the owner).

Use this tool when:
- Owner asks for a coffee / lunch / dinner / drinks place ("find me a kosher restaurant in Tel Aviv")
- Owner names a specific external venue and you need the address ("Coffee Landwer Ness Ziona Tuesday 3pm")
- Owner asks "what are my favorite cafés near the office?" (returns rank 3 venues)

Do NOT use when:
- Meeting is at the owner's office (location resolves automatically via resolveLocation)
- Owner explicitly says "online" / "Teams"
- The venue is already booked on the meeting being moved (use existing event location)`,
        input_schema: {
          type: 'object',
          properties: {
            area: {
              type: 'string',
              description: 'Geographic area for Case-2 search ("Tel Aviv", "central Israel", "between Ness Ziona and Modiin"). Comma-separated values OK. Omit when using name_hint alone.',
            },
            type: {
              type: 'string',
              enum: ['coffee', 'restaurant', 'pub', 'park', 'bar', 'hotel', 'office', 'other'],
              description: 'Venue type for Case-2 search. Omit when using name_hint alone.',
            },
            type_tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Refinements for Case-2 search: ["kosher"], ["italian", "casual"], ["sports-bar"], etc. Optional.',
            },
            name_hint: {
              type: 'string',
              description: 'Specific venue name for Case-1 resolution. May include city/branch hint inline ("Coffee Landwer Ness Ziona"). Optional.',
            },
            meeting_time: {
              type: 'string',
              description: 'OPTIONAL ISO datetime of the planned meeting. When provided, the tool deterministically drops venues known to be closed at that time and tags survivors with hours_status (open / unknown). Pass it whenever the time is known — much better than guessing.',
            },
            include_hidden: {
              type: 'boolean',
              description: 'Default false. Set true to include rank=1 venues in the results — only do this when the owner explicitly asks "show me the ones I ranked low" or similar.',
            },
            max_options: {
              type: 'integer',
              description: 'Max candidates to return. Defaults to 3.',
              minimum: 1,
              maximum: 5,
            },
          },
          required: [],
        },
      },
      {
        name: 'rank_venue',
        description: `Set the owner's rank on a venue in the catalog.

Ranks:
- 3 = favorite — always offered first
- 2 = good    — included in normal options (default for newly-saved venues)
- 1 = avoid   — hidden by default; still searchable via find_venue(include_hidden=true)

Use when the owner explicitly says "rank Coffee Landwer 3", "drop Aroma to 1", "make this my favorite", "never offer that one again", etc. The venue must already exist in the catalog — newly-found ones get saved on booking.`,
        input_schema: {
          type: 'object',
          properties: {
            venue_id_or_name: {
              type: 'string',
              description: 'Either the venue id (from find_venue result) or the venue name. Name match is case-insensitive.',
            },
            rank: {
              type: 'integer',
              enum: [1, 2, 3],
              description: '1 = avoid (hide), 2 = good (default), 3 = favorite (top of list).',
            },
          },
          required: ['venue_id_or_name', 'rank'],
        },
      },
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    if (toolName === 'find_venue') {
      return this.findVenue(args as FindVenueArgs, context);
    }
    if (toolName === 'rank_venue') {
      return this.rankVenue(args as RankVenueArgs, context);
    }
    return null;
  }

  private async findVenue(args: FindVenueArgs, context: SkillContext): Promise<unknown> {
    const ownerUserId = context.profile.user.slack_user_id;
    const tz = context.profile.user.timezone;
    const meetingTimeIso = (typeof args.meeting_time === 'string' && args.meeting_time.trim().length > 0)
      ? args.meeting_time.trim()
      : undefined;
    const max = Math.min(Math.max(args.max_options ?? 3, 1), 5);
    const hasNameHint = typeof args.name_hint === 'string' && args.name_hint.trim().length > 0;
    const hasAreaType = (args.area && args.area.trim().length > 0) || (args.type && args.type.trim().length > 0);

    if (!hasNameHint && !hasAreaType) {
      return {
        success: false,
        error: 'missing_input',
        message: 'find_venue needs either name_hint OR (area + type).',
      };
    }

    // (1) Try the owner's catalog first — exact name match or area+type match.
    const catalogHits = findVenuesByCriteria({
      ownerUserId,
      area: args.area ?? null,
      type: args.type ?? null,
      typeTags: args.type_tags,
      nameHint: args.name_hint ?? null,
      includeHidden: args.include_hidden === true,
      limit: max,
    });

    const hidden_count = hasAreaType
      ? countHiddenVenues({
          ownerUserId,
          area: args.area ?? null,
          type: args.type ?? null,
          typeTags: args.type_tags,
        })
      : 0;

    // Case 1 — owner named a venue:
    //   If the catalog has it (or branches), surface those.
    //   If not, resolve fresh via Tavily and return the resolved venue.
    if (hasNameHint && !hasAreaType) {
      if (catalogHits.length > 0) {
        const filtered = applyHoursFilter(catalogHits.map(v => ({ row: v as VenueRow | null, cand: null as VenueCandidate | null })), meetingTimeIso, tz);
        return {
          success: true,
          source: 'catalog',
          options: filtered.map(serializeFiltered),
          hidden_count,
          ambiguity_flag: filtered.length > 1,
        };
      }
      const fresh = await resolveVenueByName(args.name_hint!, args.area);
      if (!fresh) {
        return {
          success: false,
          error: 'no_match',
          message: `Couldn't resolve "${args.name_hint}" to a known venue. Ask the owner for the full address.`,
        };
      }
      const filtered = applyHoursFilter([{ row: null, cand: fresh }], meetingTimeIso, tz);
      return {
        success: true,
        source: 'fresh',
        options: filtered.map(serializeFiltered),
        hidden_count,
        ambiguity_flag: false,
      };
    }

    // Case 2 — area + type search. Mix catalog (ranked) with fresh discoveries.
    //   If catalog has ≥ max hits, return those (the owner has enough preference data here).
    //   Otherwise, top up with Tavily candidates.
    if (catalogHits.length >= max) {
      const filtered = applyHoursFilter(catalogHits.map(v => ({ row: v, cand: null as VenueCandidate | null })), meetingTimeIso, tz);
      return {
        success: true,
        source: 'catalog',
        options: filtered.map(serializeFiltered),
        hidden_count,
        ambiguity_flag: false,
      };
    }

    const remaining = max - catalogHits.length;
    let freshCandidates: VenueCandidate[] = [];
    try {
      freshCandidates = await searchVenueCandidates({
        area: args.area,
        type: args.type,
        typeTags: args.type_tags,
        maxResults: remaining + 2,  // overfetch slightly so dedup leaves enough
      });
    } catch (err) {
      logger.warn('find_venue — fresh search threw, returning catalog-only', {
        err: String(err).slice(0, 200),
      });
    }

    // Dedup against catalog by case-insensitive name match.
    const catalogNames = new Set(catalogHits.map(v => v.name.toLowerCase()));
    const freshDeduped = freshCandidates.filter(c => !catalogNames.has(c.name.toLowerCase())).slice(0, remaining);

    const merged: Array<{ row: VenueRow | null; cand: VenueCandidate | null }> = [
      ...catalogHits.map(v => ({ row: v as VenueRow | null, cand: null as VenueCandidate | null })),
      ...freshDeduped.map(c => ({ row: null as VenueRow | null, cand: c })),
    ];
    const filtered = applyHoursFilter(merged, meetingTimeIso, tz);

    return {
      success: true,
      source: catalogHits.length > 0 ? 'mixed' : 'fresh',
      options: filtered.map(serializeFiltered),
      hidden_count,
      ambiguity_flag: false,
    };
  }

  private async rankVenue(args: RankVenueArgs, context: SkillContext): Promise<unknown> {
    const ownerUserId = context.profile.user.slack_user_id;
    if (!args.venue_id_or_name || ![1, 2, 3].includes(args.rank)) {
      return {
        success: false,
        error: 'bad_args',
        message: 'venue_id_or_name + rank (1, 2, or 3) required.',
      };
    }

    // Try id first (uuid shape), then fall back to name match.
    const looksLikeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.venue_id_or_name);
    let venue: VenueRow | null = null;
    if (looksLikeId) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getVenueById } = require('../db/venues') as typeof import('../db/venues');
      venue = getVenueById(args.venue_id_or_name);
      if (venue && venue.owner_user_id !== ownerUserId) venue = null;
    } else {
      venue = findVenueByNameAndOwner(ownerUserId, args.venue_id_or_name);
    }

    if (!venue) {
      return {
        success: false,
        error: 'venue_not_found',
        message: `No venue in the catalog matches "${args.venue_id_or_name}". The catalog only carries places the owner has previously booked — newly-suggested venues need to be booked first.`,
      };
    }

    updateVenue(venue.id, { rank: args.rank });
    logger.info('venue rank updated', {
      id: venue.id, name: venue.name, oldRank: venue.rank, newRank: args.rank,
    });
    return {
      success: true,
      venue_id: venue.id,
      name: venue.name,
      previous_rank: venue.rank,
      new_rank: args.rank,
      message: `Set ${venue.name}${venue.branch_name ? ` (${venue.branch_name})` : ''} to rank ${args.rank}.`,
    };
  }

  getSystemPromptSection(profile: UserProfile): string {
    const firstName = profile.user.name.split(' ')[0];
    return `EXTERNAL VENUES (venue skill) — find / resolve / rank places for non-company meetings.

Use \`find_venue\` whenever a meeting needs a physical location outside ${firstName}'s office, home, or a Teams call. Two ways to call it:
- \`name_hint\` alone → ${firstName} named a venue ("Coffee Landwer Ness Ziona"). Tool resolves to canonical name + address; if multiple branches match, \`ambiguity_flag\` will be true — ask which one.
- \`area\` + \`type\` → ${firstName} asked you to find a place ("kosher restaurant in central Tel Aviv"). Tool returns up to 3 options; mix of his catalog favorites and fresh search results.

The result includes \`hidden_count\` — venues at rank 1 (avoid) in this area. When > 0, mention it casually so he can ask to see them: "Three options here. You've also got 2 places ranked low in this area — want to see them?". If he says yes, re-call \`find_venue\` with \`include_hidden=true\`.

Rank legend (carried on each option):
- rank 3 → favorite — present this one first and suggest it
- rank 2 → good — include normally (default for newly-saved venues)
- rank 1 → avoid — hidden by default
- rank null → newly-discovered, not yet in his catalog

After he picks a venue from a Case-2 search, surface the \`reservation_url\` (if present) and \`phone\` so he can book the table himself. EVERY option you present must include the \`maps_url\` link the tool returned — that's the always-present fallback link he can click to see the place on Google Maps. If \`phone\` is absent, say so plainly ("no phone in my data — look it up via the Maps link"). Once he confirms the reservation done, call \`create_meeting\` with \`location\` set to the venue's display string (name + address). The venue gets saved to his catalog automatically on booking with rank=2.

OPENING HOURS — pass \`meeting_time\` to \`find_venue\` whenever you know the time. The tool drops closed venues deterministically. Surviving candidates carry \`hours_status\`: when it's \`unknown\`, mention that openly ("opening hours not in my data — worth a quick check"). When it's \`open\`, you're cleared. Don't invent hours either way.

Owner can re-rank venues in chat ("rank Coffee Landwer 3", "drop Aroma to 1", "make that my favorite") → call \`rank_venue\`. The catalog only carries places he's previously booked; tell him so if he tries to rank something brand-new.

When the venue skill is the right tool: any meeting where ${firstName} or a colleague is asking for a non-company physical setting. NOT for online meetings, NOT for office meetings, NOT for home-day Huddles.`;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * v2.8.4 — deterministic opening-hours filter.
 *
 * Input: mixed list of catalog rows + fresh candidates. Output: same list
 * minus any entry KNOWN to be closed at meetingTimeIso. Each survivor is
 * paired with its hours_status (`open` | `unknown`). When meetingTimeIso is
 * undefined, every entry passes with hours_status='unknown'.
 *
 * Catalog rows don't currently carry opening_hours yet (future schema —
 * tracked at #96 alongside Google Places). Today they're always `unknown`
 * unless a fresh candidate happens to have hours we extracted from Tavily.
 */
type FilteredEntry = {
  row: VenueRow | null;
  cand: VenueCandidate | null;
  hours_status: HoursStatus;
};

function applyHoursFilter(
  entries: Array<{ row: VenueRow | null; cand: VenueCandidate | null }>,
  meetingTimeIso: string | undefined,
  timezone: string,
): FilteredEntry[] {
  const out: FilteredEntry[] = [];
  for (const e of entries) {
    const hoursByDay = e.cand?.opening_hours_by_day;
    const status = evaluateVenueHours({
      openingHoursByDay: hoursByDay,
      meetingTimeIso,
      timezone,
    });
    if (status === 'closed') continue;  // hard drop — won't reach Sonnet
    out.push({ ...e, hours_status: status });
  }
  return out;
}

function serializeFiltered(e: FilteredEntry): Record<string, unknown> {
  const base = e.row ? serializeVenue(e.row) : e.cand ? serializeCandidate(e.cand) : {};
  return { ...base, hours_status: e.hours_status };
}

function serializeVenue(v: VenueRow): Record<string, unknown> {
  return {
    venue_id: v.id,
    name: v.name,
    branch_name: v.branch_name,
    address: v.address,
    area_tags: v.area_tags,
    type: v.type,
    type_tags: v.type_tags,
    phone: v.phone,
    reservation_url: v.reservation_url,
    maps_url: buildMapsSearchUrl(v.name, v.branch_name ?? undefined, v.address ?? undefined),
    notes: v.notes,
    rank: v.rank,
    last_used_at: v.last_used_at,
  };
}

function serializeCandidate(c: VenueCandidate): Record<string, unknown> {
  return {
    venue_id: null,            // not yet in catalog
    name: c.name,
    branch_name: c.branch_name ?? null,
    address: c.address ?? null,
    area_tags: c.area_tags ?? [],
    type: c.type ?? null,
    type_tags: c.type_tags ?? [],
    phone: c.phone ?? null,
    reservation_url: c.reservation_url ?? null,
    // v2.8.4 — always include a usable link. When Tavily / Google Places
    // surfaces a reservation_url it goes above; otherwise this Maps search
    // URL is the fallback so Sonnet always has something clickable to give
    // the owner. Deterministic, no extra API call.
    maps_url: buildMapsSearchUrl(c.name, c.branch_name, c.address),
    notes: c.notes ?? null,
    rank: null,
    last_used_at: null,
  };
}

/**
 * Deterministic Google Maps search URL for a venue. Combines name +
 * branch_name + address so the search query is as specific as possible.
 * No API call — pure URL construction.
 */
function buildMapsSearchUrl(name: string, branchName?: string | null, address?: string | null): string {
  const parts: string[] = [name];
  if (branchName) parts.push(branchName);
  if (address) parts.push(address);
  const query = encodeURIComponent(parts.join(' '));
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

/**
 * Public helper used by the create_meeting save-on-book hook. NOT a tool —
 * fires inside the meetings skill after a successful booking when the
 * location is non-company. Inserts a new row at rank=2 OR bumps last_used_at
 * on an existing match.
 *
 * Returns the saved/bumped row id, or null when no action was taken.
 */
export function saveOrBumpVenueOnBook(params: {
  ownerUserId: string;
  name: string;
  address?: string;
  type?: string;
  areaTags?: string[];
  phone?: string;
  reservationUrl?: string;
}): string | null {
  const existing = findVenueByNameAndOwner(params.ownerUserId, params.name);
  if (existing) {
    updateVenue(existing.id, {
      lastUsedAt: new Date().toISOString(),
      // Top up missing fields if the fresh save has new info, but don't
      // overwrite owner-curated data.
      ...(existing.address ? {} : params.address !== undefined ? { address: params.address } : {}),
      ...(existing.phone ? {} : params.phone !== undefined ? { phone: params.phone } : {}),
      ...(existing.reservation_url ? {} : params.reservationUrl !== undefined ? { reservationUrl: params.reservationUrl } : {}),
    });
    return existing.id;
  }
  const fresh = insertVenue({
    ownerUserId: params.ownerUserId,
    name: params.name,
    address: params.address,
    type: params.type,
    areaTags: params.areaTags,
    phone: params.phone,
    reservationUrl: params.reservationUrl,
    rank: 2,
  });
  // bump last_used_at right away
  updateVenue(fresh.id, { lastUsedAt: new Date().toISOString() });
  return fresh.id;
}
