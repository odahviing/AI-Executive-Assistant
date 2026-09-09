/**
 * Shared helper for auto-loading attendee work-hour availability from
 * people_memory. Used by both `find_available_slots` and `coordinate_meeting`
 * paths so attendee TZ + work hours clip slots consistently regardless of
 * which entry point Sonnet picked.
 *
 * SCOPE: TIMEZONE + WORK HOURS ONLY. This helper does NOT touch busy/free
 * data — that's an annotation/overlay concern handled separately by
 * `attendeeBusyEmails` (busy-time pre-filter for mixed coords) and
 * `annotateSlotsWithAttendeeStatus` (per-slot per-attendee status tags).
 * The work-hour clip is the only HARD filter on slot proposals from this
 * helper's data; busy time is intentionally not a hard filter — Sonnet
 * sees busy slots with annotation and decides whether to propose them.
 *
 * Returns undefined when no attendee in the list has structured availability
 * data — back-compat with the no-clip path that existed before v2.3.3.
 */

import { DateTime } from 'luxon';
import logger from './logger';
import { renderClockInZone } from './timezoneConvert';
import type { WeekDay } from './floatingBlocks';
import type { TimezoneTempSource } from '../db/people';

export interface AttendeeAvailabilityEntry {
  email: string;
  timezone: string;
  workdays: WeekDay[];
  hoursStart: string;
  hoursEnd: string;
  // v2.5.2 — when active travel overrode the stored profile timezone for this
  // entry, this carries the original stored timezone + travel location so the
  // caller can render dual-TZ ("15:00 Boston / 22:00 Idan") on slot proposals
  // and surface "Yael is in Boston this week" honestly to the owner.
  // Undefined when the attendee is not traveling — the timezone field above
  // is the only one that matters in that case.
  travel?: {
    location: string;       // free text, e.g. "Boston"
    homeTimezone: string;   // stored profile timezone, e.g. "Asia/Jerusalem"
    until: string;          // ISO yyyy-MM-dd
  };
  /** v3.3.8 — stored profile timezone, always set when known. Per-day TZ
   * resolution (attendeeTzForDay) derives from THIS + travelWindow, never
   * from the now-collapsed `timezone` field above. */
  homeTimezone?: string;
  /**
   * v3.3.8 — the travel record as a DATED window (covers future trips too).
   * The work-hours clip and per-slot local display resolve the attendee's
   * timezone PER SEARCHED DAY: inside [from, until] → this timezone, outside
   * → homeTimezone. Fixes both directions of the now-collapse bug: a future
   * trip ("back in Israel on Tuesday") was invisible when searching Tuesday,
   * and a current trip ending Friday wrongly clipped next week's search.
   */
  travelWindow?: {
    from: string;        // ISO yyyy-MM-dd (inclusive)
    until: string;       // ISO yyyy-MM-dd (inclusive)
    timezone: string;    // IANA of the travel location
    location: string;
  };
  /**
   * True when this entry has NO stored people_memory timezone and was built
   * from `fallbackTimezone` + `defaultWorkingHoursForTz` (#M3) — a GUESS, not
   * data the attendee or owner ever stated. Callers that narrate this entry's
   * hours to the model (e.g. the day_summary grounding note) must say
   * "assumed", never "stated", when this is true — otherwise a guess reads as
   * a fact. Cleared back to false by a conversational owner override
   * (attendee_hours in find_available_slots), which IS a real statement.
   */
  assumed?: boolean;
  /**
   * v4.8.x (o#262/o#265, owner ruling 2026-08-31) — set when this attendee is
   * currently on a TEMP timezone reading (a later auto-tier value differing
   * from their established PERMANENT zone, TTL'd — see
   * `getEffectiveTimezoneById`, src/db/people.ts). `timezone`/`hoursStart`/
   * `hoursEnd` above are ALWAYS computed off the permanent zone regardless —
   * this is surfacing-only ("assuming X is on <permanent>, we currently see Y")
   * so a wrong-but-stated-once zone never gets silently corrected back onto
   * the very booking it's stale for. `source` says which auto-tier writer
   * produced the reading (Slack profile sync vs the Haiku chat-capture pass —
   * `TimezoneTempSource`, src/db/people.ts) — a caller that surfaces this to
   * a human MUST attribute by `source`, never hard-code "Slack": until
   * 2026-09-01 that writer was the only one, so the wording was true then and
   * would be a false provenance claim now.
   *
   * NEVER read this field directly when surfacing it for a specific DAY —
   * resolve it through `tzTempDifferingForDay` below. The reading is a
   * discrepancy against the PERMANENT zone, which is only the zone the day's
   * clip actually ran in when the attendee isn't travelling that day.
   */
  tzTempDiffering?: { tempZone: string; expiresAt: string; source: TimezoneTempSource };
}

/**
 * v3.3.8 — the attendee's effective IANA timezone on a specific calendar day.
 * `isoDate` is yyyy-MM-dd (the slot walker's owner-TZ day — travel dates are
 * calendar-level facts, sub-day boundary effects are noise).
 */
export function attendeeTzForDay(
  entry: Pick<AttendeeAvailabilityEntry, 'timezone' | 'homeTimezone' | 'travelWindow'>,
  isoDate: string,
): string {
  const tw = entry.travelWindow;
  if (tw && isoDate >= tw.from && isoDate <= tw.until) return tw.timezone;
  return entry.homeTimezone ?? entry.timezone;
}

/**
 * v4.8.x (2026-09-01) — the temp-timezone hedge, resolved PER DAY. The ONE
 * place that decides whether `tzTempDiffering` may be spoken about a given
 * calendar day; every surfacing caller goes through it (the per-slot conflict
 * line and the day_summary grounding note both did the check themselves, and
 * only one of them had it).
 *
 * `tzTempDiffering` is a discrepancy measured against the attendee's PERMANENT
 * zone, so the hedge it produces ("assuming they're on their usual zone, we
 * currently read X") is only a true account of the math when the day's clip
 * actually ran in that permanent zone. On a day inside `travelWindow` it did
 * not: `attendeeTzForDay` already swapped the TRIP zone into the work-hours
 * clip, so the sentence describes a calculation that never happened — and when
 * the passive reading came from a client sitting in the destination (the
 * co-existence `db/people.ts` documents above `TimezoneTemp`, people.ts:TimezoneTemp)
 * it degenerates into "their timezone on file is America/New_York, but we
 * currently read America/New_York". The dated travel record is the stated
 * signal and outranks the passive reading (M12), so those days need no hedge
 * at all.
 *
 * A travel record that did NOT swap the zone (destination unresolvable in the
 * static map, or same zone as home) never becomes a `travelWindow` in the first
 * place — `loadAttendeeAvailabilityForEmails` only writes one when
 * `travelTz && travelTz !== resolvedTz` — so those days keep the hedge, exactly
 * like a non-traveller. Same gate as `planMeeting.ts`'s
 * `travelActuallySwappedZone`, on the entry that already encodes it.
 */
export function tzTempDifferingForDay(
  entry: Pick<AttendeeAvailabilityEntry, 'travelWindow' | 'tzTempDiffering'>,
  isoDate: string,
): AttendeeAvailabilityEntry['tzTempDiffering'] | undefined {
  if (!entry.tzTempDiffering) return undefined;
  const tw = entry.travelWindow;
  if (tw && isoDate >= tw.from && isoDate <= tw.until) return undefined;
  return entry.tzTempDiffering;
}

/**
 * Build an AttendeeAvailability list from people_memory for the given emails.
 *
 * v2.5.2 — when an attendee has an active travel record (person_id-keyed
 * `getTravelRecordById`), the entry's `timezone` becomes the travel location's
 * timezone (resolved via `inferTimezoneFromStateStatic`) instead of the
 * stored profile timezone. The original stored timezone is preserved on
 * `entry.travel.homeTimezone` so callers can render dual-TZ slot lines.
 * Static-map lookup only — async Sonnet fallback would block slot search.
 * If the location can't be resolved statically, we fall back to the stored
 * timezone (no travel override) and log so it surfaces in diagnostics.
 *
 * @param emails       Attendee email addresses to look up. The owner's own
 *                     email (if present) is filtered out — owner availability
 *                     comes from the profile, not from people_memory.
 * @param ownerEmail   Owner email — used to filter the owner out of the list.
 * @returns            List of work-hour entries (one per attendee with known
 *                     timezone), or undefined if none. Use the result as the
 *                     `attendeeAvailability` arg to `findAvailableSlots`.
 */
export function loadAttendeeAvailabilityForEmails(
  emails: string[],
  ownerEmail: string,
  fallbackTimezone?: string,   // #M3 — no-TZ attendee is assumed in this zone (owner/requester frame)
): AttendeeAvailabilityEntry[] | undefined {
  if (!emails || emails.length === 0) return undefined;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { searchPeopleMemory, getTravelRecordById, getEffectiveTimezoneById } = require('../db') as typeof import('../db');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getEffectiveWorkingHours, defaultWorkingHoursForTz } = require('./workingHoursDefault') as
      typeof import('./workingHoursDefault');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { inferTimezoneFromStateStatic } = require('./locationTz') as
      typeof import('./locationTz');

    const ownerLower = ownerEmail.toLowerCase();
    const built: AttendeeAvailabilityEntry[] = [];
    for (const email of emails) {
      const lower = email.toLowerCase();
      if (lower === ownerLower) continue;
      const matches = searchPeopleMemory(email);
      const person = matches.find(m => (m.email ?? '').toLowerCase() === lower);
      // v4.8.x (o#262/o#265, owner ruling 2026-08-31) — read the PERMANENT
      // stored zone via getEffectiveTimezoneById, never the raw column: a
      // later differing Slack-auto reading lands in a TTL'd sibling value
      // (`tzTempDiffering` below) instead of silently overwriting the
      // established zone, so working-hours math is never computed against a
      // stale/transient reading (o#265 — Maayan stored/read as ET drove a
      // whole search's "outside working hours" verdicts wrong).
      const effectiveTz = person ? getEffectiveTimezoneById(person.person_id) : undefined;
      // #M3 (2026-07-23 owner direction) — an attendee with no stored timezone is
      // ASSUMED to be in the requester's frame (fallbackTimezone = owner's TZ) with
      // standard hours, instead of being SKIPPED (which left them unclipped so the
      // search could offer owner-morning to a would-be-remote person). A human-stated
      // TZ/time still overrides via search_window_timezone. `fallbackTimezone` being
      // optional is a call-signature convenience, not a supported second mode: every
      // caller of `loadAttendeeAvailabilityForEmails` / `attendeeCheckParams` now
      // passes it (last five fixed 2026-09-07 — planMeeting.ts, createMeeting.ts's
      // dense-packing counter-offer, autoMove.ts x2, checkHealth.ts). A caller that
      // omits it silently reintroduces the pre-ruling skip below (`if (!resolvedTz)
      // continue`) — that is a bug to fix at the call site, not current behaviour.
      const resolvedTz = effectiveTz?.timezone ?? fallbackTimezone;
      if (!resolvedTz) continue;
      const wh = effectiveTz?.timezone ? getEffectiveWorkingHours(person!) : defaultWorkingHoursForTz(resolvedTz);
      if (!wh) continue;

      let timezone = resolvedTz;
      let travelMeta: AttendeeAvailabilityEntry['travel'];
      let travelWindow: AttendeeAvailabilityEntry['travelWindow'];
      // v3.3.8 — raw record includes FUTURE trips; the dated window drives
      // per-day resolution. v4.8.x — keyed by person_id, not slack_id: an
      // email-only external (no slack_id) can carry a travel record too (the
      // email-inbound stated-zone path writes one), and the slack_id-keyed
      // lookup silently returned null for every such row — write succeeded,
      // read never happened (same class as getTravelRecordById's doc,
      // db/people.ts). Also no longer gated on a stored base timezone: a
      // fallback-assumed attendee (#M3) with a travel record has a STATED
      // zone for the trip's days — inside the window that record outranks the
      // owner-frame guess (M12: stated-in-chain > assume-owner-zone); outside
      // it they fall back to homeTimezone = resolvedTz, unchanged.
      if (person) {
        const travel = getTravelRecordById(person.person_id);
        if (travel) {
          const travelTz = inferTimezoneFromStateStatic(travel.location);
          if (travelTz && travelTz !== resolvedTz) {
            travelWindow = {
              from: travel.from,
              until: travel.until,
              timezone: travelTz,
              location: travel.location,
            };
            const today = new Date().toISOString().slice(0, 10);
            const activeToday = travel.from <= today;  // until >= today guaranteed by getTravelRecordById
            if (activeToday) {
              travelMeta = {
                location: travel.location,
                homeTimezone: resolvedTz,  // = person.timezone when stored; the #M3 fallback frame otherwise
                until: travel.until,
              };
              timezone = travelTz;
            }
          } else if (!travelTz) {
            logger.info('attendeeAvailability — travel location not in static TZ map, using stored', {
              email, location: travel.location,
            });
          }
        }
      }

      built.push({
        email,
        timezone,
        workdays: wh.workdays,
        hoursStart: wh.hoursStart,
        hoursEnd: wh.hoursEnd,
        homeTimezone: resolvedTz,
        ...(travelMeta ? { travel: travelMeta } : {}),
        ...(travelWindow ? { travelWindow } : {}),
        // #M3 — no stored permanent timezone means resolvedTz came from the
        // fallback (requester's frame) and wh came from the generic zone
        // default, not this attendee's own profile. A GUESS, flag it.
        ...(effectiveTz?.timezone ? {} : { assumed: true }),
        // v4.8.x (o#262/o#265) — permanent zone is known and used for the math
        // above, but a later auto-tier reading currently differs (TTL'd) —
        // surface-only, never substituted into the computation itself. `source`
        // rides along so a surfacing caller attributes it correctly.
        ...(effectiveTz?.tempDiffering
          ? { tzTempDiffering: {
              tempZone: effectiveTz.tempDiffering.value,
              expiresAt: effectiveTz.tempDiffering.expiresAt,
              source: effectiveTz.tempDiffering.source,
            } }
          : {}),
      });
    }

    if (built.length === 0) return undefined;
    logger.info('attendeeAvailability — auto-loaded', {
      attendees: built.map(b => {
        const tag = b.travel ? `${b.email}(${b.timezone} via ${b.travel.location} until ${b.travel.until}, was ${b.travel.homeTimezone}, ${b.hoursStart}-${b.hoursEnd})` :
                                `${b.email}(${b.timezone}, ${b.hoursStart}-${b.hoursEnd})`;
        return tag;
      }),
    });
    return built;
  } catch (err) {
    logger.warn('attendeeAvailability auto-load threw, proceeding without', {
      err: String(err).slice(0, 200),
    });
    return undefined;
  }
}

/**
 * The two ATTENDEE-scoped rejection prefixes the slot walker emits as
 * `<prefix>:<email>` (findAvailableSlots.ts) when it is DROPPING conflicted
 * slots. Declared once for the walker and its own day-summary splitter
 * (findAvailableSlots.ts's splitDayReasons), which imports it instead of
 * carrying a copy.
 *
 * The only declaration in the codebase: core/orchestrator/turnHelpers.ts's
 * `attendeeCheckSource` imports this constant rather than hand-typing the two
 * strings (landed 2026-09-06) — deliberately NOT widened to also match
 * `travel_buffer_collision`, since owner-side `checkSlot` padding and this
 * attendee-side check both emit that label with no email on purpose, so it's
 * indistinguishable from the owner's own constraint at that call site.
 */
export const ATTENDEE_REASON_PREFIXES = ['attendee_busy_collision', 'outside_attendee_work_hours'] as const;

/**
 * The full attendee-check param bundle for `findAvailableSlots`, in ONE call.
 *
 * The finder only checks attendees when BOTH `attendeeBusyEmails` (busy
 * subtraction) AND `attendeeAvailability` (work-hours/tz clip) are passed —
 * `attendeeEmails` alone is a no-op. Callers that wanted real attendee-aware
 * scheduling used to hand-build both at the call site; forget the availability
 * half and you silently get an owner-only check (the #133 auto-move bug class).
 * Bundling them means callers pass the attendee list ONCE and can't desync.
 *
 * `emails` is the attendee-only list — the owner is filtered out of the
 * availability lookup internally and never belongs in the busy pool. Spread the
 * result into the `findAvailableSlots` params: `{ ...base, ...attendeeCheckParams(emails, owner) }`.
 */
export function attendeeCheckParams(
  emails: string[],
  ownerEmail: string,
  fallbackTimezone?: string,   // #M3 — no-TZ attendees assumed in this zone (owner frame)
): { attendeeBusyEmails: string[]; attendeeAvailability?: AttendeeAvailabilityEntry[] } {
  const availability = loadAttendeeAvailabilityForEmails(emails, ownerEmail, fallbackTimezone);
  return { attendeeBusyEmails: emails, ...(availability ? { attendeeAvailability: availability } : {}) };
}

/**
 * #24 (2026-07-29) — the ONE zone "their side" of an instant is presented in:
 * the single distinct non-owner attendee zone, or '' when there is none or more
 * than one (two zones → no single "their zone" to pick; leave it unset rather
 * than guess — the #M3 fallback-not-force philosophy). An attendee with no
 * stored zone arrives here already carrying the owner's zone (#M3 fallback) and
 * is filtered out by the `!== ownerTz` test — so a missing zone yields NO
 * presentation, never the owner's clock labelled as theirs.
 *
 * Declared ONCE (2026-09-09) for the three surfaces that attach the same
 * `presentation_local` string (renderClockInZone in this zone): find_available_slots'
 * `autoPresentTz` default per slot, and — via `presentationLocalFieldFor` below —
 * every create_meeting / move_meeting success return on the written instant,
 * idempotent short-circuits included. The write tools carried no attendee-local
 * rendering at all until then, so the tool line the output checker reads was
 * owner-local only — it did the ET arithmetic itself (17:00 Jerusalem → "12:00pm
 * Boston", five hours instead of seven) and rewrote a CORRECT "10:00am Boston"
 * booked-confirmation into a wrong one (Sharon Duret, 2026-09-08T20:28Z).
 *
 * `isoDate` (yyyy-MM-dd, owner-local) resolves each attendee's zone for THAT
 * day via `attendeeTzForDay` — a dated travel window swaps the trip zone in —
 * and is what a single booked instant passes. Omitted → the entry's current
 * effective `timezone`, the only honest choice for a multi-day search that has
 * no single day to resolve against.
 */
export function singleAttendeePresentationZone(
  entries: ReadonlyArray<Pick<AttendeeAvailabilityEntry, 'timezone' | 'homeTimezone' | 'travelWindow'>> | undefined,
  ownerTz: string,
  isoDate?: string,
): string {
  const zones = new Set<string>();
  for (const e of entries ?? []) {
    const tz = isoDate ? attendeeTzForDay(e, isoDate) : e.timezone;
    if (tz && tz !== ownerTz) zones.add(tz);
  }
  return zones.size === 1 ? [...zones][0] : '';
}

/**
 * The `presentation_local` field for ONE written instant — spread into EVERY
 * create_meeting / move_meeting success return the orchestrator's tool-summary
 * line renders (turnHelpers.ts appends it as ` [local: …]`), the idempotent
 * short-circuits included: a colleague following up on their own booking
 * re-triggers create_meeting and lands there, and the output checker reads that
 * `OK` line exactly like the first. Zone = singleAttendeePresentationZone on the
 * instant's owner-local day; no single attendee zone → `{}`, nothing attached,
 * never the owner's clock labelled as theirs (the reader degrades to owner-local).
 * `attendeeEmails` may carry gaps (a name-only attendee) — dropped here.
 */
export function presentationLocalFieldFor(
  attendeeEmails: ReadonlyArray<string | undefined>,
  startIso: string,
  ownerEmail: string,
  ownerTz: string,
): { presentation_local?: string } {
  const emails = attendeeEmails.filter((e): e is string => typeof e === 'string' && e.length > 0);
  const tz = singleAttendeePresentationZone(
    loadAttendeeAvailabilityForEmails(emails, ownerEmail, ownerTz),
    ownerTz,
    DateTime.fromISO(startIso, { zone: ownerTz }).toFormat('yyyy-MM-dd'),
  );
  const rendered = tz ? renderClockInZone(startIso, ownerTz, tz) : '';
  return rendered ? { presentation_local: rendered } : {};
}
