/**
 * weTimeResolver (v3.5.x) — THE spine for "what does the owner's stated meeting
 * time mean, and how do we show it" on a Working-Elsewhere (WE) trip day.
 *
 * Why this exists: for months, that decision was re-made independently across 6+
 * layers (create/move interpret, slot search, the confirm builder, the booked
 * narration, the move summary, the approval preview) that didn't have to agree —
 * and the pivotal "which zone did he mean" was left to the model, which on
 * 2026-06-29 tagged "Israel time" 0/3 times and turned "6:30 PM Israel" into 6:30
 * PM Boston = 1:30 AM Israel the next day. The fix (the owner's framing): ONE
 * function answers the time, and everything follows it.
 *
 * Stated bare dates resolve through the owner's dated schedule overrides;
 * already-resolved instants use the shared travel context for display:
 *   - resolveStatedInstant: stated clock + which-zone-he-named → canonical instant
 *   - renderWeDualClock:     instant + travel context → the ONE display string
 *
 * Cloud-safe: every zone is passed explicitly (home from config, trip from the
 * dated schedule). The server's own zone is NEVER consulted — that was the v3.5.4 7-hour
 * drift root.
 */
import { DateTime } from 'luxon';
import { reinterpretClockInZone, renderClockInZone, isoHasExplicitZone } from './timezoneConvert';
import type { OwnerTravelContext } from './workingElsewhere';
import type { UserProfile } from '../config/userProfile';

/**
 * What the owner NAMED about the zone of a stated time. The model's only job is
 * to echo his words into one of these — it never maps to IANA or does math:
 *   'home'   — "Israel time" / "my home time" / "IL time"
 *   'local'  — "where I am" / "local" / "my time" (while travelling) / the trip city
 *   <IANA>   — an explicit third zone he named ("America/Chicago"); escape hatch
 *   undefined — he named no zone
 */
export type StatedZone = 'home' | 'local' | string | undefined;

/** The existing tool/callback source precedence, shared by preview and execution. */
export function statedZoneFromArgs(args: Record<string, unknown>): StatedZone {
  return (typeof args.stated_zone === 'string' && args.stated_zone.trim())
    ? args.stated_zone.trim()
    : (typeof args.start_timezone === 'string' && args.start_timezone.trim() ? args.start_timezone.trim() : undefined);
}

/** Resolve a raw abbreviation only from coherent known person context. With no
 * structured clock referent, disagreeing or unknown participants remain a
 * clarification; a guessed attendee zone never borrows the owner's authority. */
export function statedClockPersonContext(
  args: Record<string, unknown>,
  profile: UserProfile,
  startIso: string,
): string | null | undefined {
  const participants = Array.isArray(args.attendees) ? args.attendees : args.attendee_emails;
  // An absent roster (notably a move-by-id) does not establish whose clock.
  // An explicitly empty roster is the owner's own time.
  if (!Array.isArray(participants)) return null;
  const emails: string[] = [];
  for (const participant of participants) {
    const email = typeof participant === 'string' ? participant
      : participant && typeof participant === 'object' && typeof participant.email === 'string' ? participant.email : '';
    if (!email) return null;
    if (email.toLowerCase() !== profile.user.email.toLowerCase()) emails.push(email);
  }
  if (!emails.length) return undefined;
  const { loadAttendeeAvailabilityForEmails, attendeeKnownTimezoneForDay } = require('./attendeeAvailability') as typeof import('./attendeeAvailability');
  const entries = loadAttendeeAvailabilityForEmails(emails, profile.user.email, profile.user.timezone) ?? [];
  if (!entries.length
    || emails.some(email => !entries.some(e => e.email.toLowerCase() === email.toLowerCase()))) return null;
  const zones = new Set(entries.map(e => attendeeKnownTimezoneForDay(e, startIso)));
  if (zones.has(null)) return null;
  return zones.size === 1 ? [...zones][0] : null;
}

export interface StatedTimeInput {
  startIso: string;            // stated start — bare ("…T11:00:00") or already offset-tagged
  endIso?: string;             // optional stated end, resolved the same way
  statedZone?: StatedZone;     // what the owner named (model-supplied)
  travel?: OwnerTravelContext; // explicit context for profile-less callers
  homeTz: string;              // owner's home/config zone
  profile?: UserProfile;      // resolve a bare stated DATE before it is an instant
  /** Relevant person's known zone. null means the referenced person is unresolved;
   * do not replace their context with the owner's. Omitted means owner's clock. */
  personTimezone?: string | null;
  /** M12's email zone fallback is retained; it does not choose a DST occurrence. */
  emailRoute?: boolean;
}

/** An unresolved requested clock is actionable, never a guessed instant. */
export class StatedTimeClarificationError extends Error {
  readonly code = 'stated_time_clarification';
  constructor(
    readonly reason: 'ambiguous_local_time' | 'nonexistent_local_time' | 'ambiguous_timezone',
    readonly wallClock: string,
    readonly sourceZone: string,
    readonly choices: string[] = [],
  ) {
    super(reason === 'ambiguous_timezone'
      ? `Which timezone does ${sourceZone} refer to for ${wallClock}?`
      : reason === 'nonexistent_local_time'
        ? `${wallClock} does not occur in ${sourceZone} because the clocks move forward. What time should I use?`
        : `${wallClock} occurs twice in ${sourceZone} because the clocks move back. Which occurrence should I use (${choices.join(' or ')})?`);
  }
  toToolResult(): { success: false; error: string; reason: string; message: string; choices: string[] } {
    return { success: false, error: this.code, reason: this.reason, message: this.message, choices: this.choices };
  }
}

export interface ResolvedStatedTime {
  startIso: string;            // canonical instant (offset-tagged, owner-zone representation)
  endIso?: string;
  sourceZone: string;          // the IANA a BARE clock was read in (for the log)
  reinterpreted: boolean;      // false when the input already carried an offset (left as-is)
}

/**
 * Common spoken zone abbreviations → IANA. luxon can't parse "ET"/"EST", so if
 * the model echoes an abbreviation instead of IANA we'd otherwise leave the time
 * bare and home-anchor it. Structured lookup (not NL matching) — the short tail
 * of zones the owner actually names. Unknown strings fall through to luxon as-is.
 */
const ABBREV_TO_IANA: Record<string, string> = {
  ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York',
  CT: 'America/Chicago', CST: 'America/Chicago', CDT: 'America/Chicago',
  MT: 'America/Denver', MST: 'America/Denver', MDT: 'America/Denver',
  PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  IL: 'Asia/Jerusalem', IST: 'Asia/Jerusalem', IDT: 'Asia/Jerusalem',
  GMT: 'Etc/UTC', UTC: 'Etc/UTC', BST: 'Europe/London',
  CET: 'Europe/Paris', CEST: 'Europe/Paris',
};

/**
 * Pick the zone a BARE (zoneless) clock should be read in. The owner's rule:
 * a time he names a zone for wins; a time with NO zone defaults to where he
 * physically is on a trip day, else home.
 */
function sourceZoneFor(statedZone: StatedZone, travel: OwnerTravelContext, homeTz: string, input: StatedTimeInput): string {
  if (statedZone === 'home') return homeTz;
  if (statedZone === 'local') return travel.effectiveTz;          // == homeTz when not away
  if (typeof statedZone === 'string' && statedZone.trim()) {      // explicit zone: IANA or an abbreviation
    const named = statedZone.trim();
    if (['CST', 'IST'].includes(named.toUpperCase())) {
      const context = input.personTimezone === undefined ? travel.effectiveTz : input.personTimezone;
      const canonical = (zone: string): string => {
        try { return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone; }
        catch { return zone; }
      };
      const candidates = named.toUpperCase() === 'IST'
        ? ['Asia/Jerusalem', 'Asia/Kolkata', 'Europe/Dublin']
        : ['America/Chicago', 'Asia/Shanghai', 'Asia/Taipei', 'America/Havana'];
      const known = context ? canonical(context) : '';
      const at = context ? DateTime.fromISO(input.startIso, { zone: context }) : undefined;
      if (known && (candidates.some(z => canonical(z) === known)
        || (named.toUpperCase() === 'CST' && at?.offsetNameShort === 'CST'))) return context!;
      if (input.emailRoute) return homeTz;
      throw new StatedTimeClarificationError('ambiguous_timezone', input.startIso, named, candidates);
    }
    return ABBREV_TO_IANA[named.toUpperCase()] ?? named;
  }
  return travel.isAway ? travel.effectiveTz : homeTz;             // unspecified
}

/**
 * Select the source zone independently of any DST occurrence. Broad search
 * windows need this choice even when no individual clock is being requested.
 */
export function resolveStatedSourceZone(input: StatedTimeInput): string {
  const { startIso, statedZone, homeTz } = input;
  const travel = input.travel ?? { isAway: false, effectiveTz: homeTz, location: '' };
  let clockTravel = travel;
  if (input.profile && !isoHasExplicitZone(startIso)) {
    // A wall clock's date is already stated. Treating it as a home-zone
    // INSTANT first can select yesterday's trip (01:00 at home is still
    // yesterday in the US), before we have decided which zone it belongs to.
    const { getEffectiveWorkDay } = require('./workHours') as typeof import('./workHours');
    const day = getEffectiveWorkDay(startIso.split('T')[0], input.profile);
    clockTravel = { isAway: day.isAway, effectiveTz: day.timezone, location: '' };
  }
  return sourceZoneFor(statedZone, clockTravel, homeTz, input);
}

/** Resolve a requested clock, clarifying only an unresolved source or DST
 * occurrence. Explicit-offset inputs stay byte-for-byte fixed instants. */
export function resolveStatedInstant(input: StatedTimeInput): ResolvedStatedTime {
  const { startIso, endIso, statedZone, homeTz } = input;
  // An already explicit interval needs no source-zone choice at all.
  if (isoHasExplicitZone(startIso) && (!endIso || isoHasExplicitZone(endIso))) {
    const sourceZone = ['CST', 'IST'].includes(statedZone?.toUpperCase() ?? '')
      ? DateTime.fromISO(startIso, { setZone: true }).zoneName ?? homeTz
      : resolveStatedSourceZone(input);
    return { startIso, endIso, sourceZone, reinterpreted: false };
  }
  const src = resolveStatedSourceZone(input);
  const resolveOne = (iso: string): string => {
    if (isoHasExplicitZone(iso)) return iso;
    const local = DateTime.fromISO(iso, { zone: src });
    const wall = DateTime.fromISO(iso, { zone: 'UTC' });
    if (local.isValid && wall.isValid) {
      if (local.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS") !== wall.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS")) {
        throw new StatedTimeClarificationError('nonexistent_local_time', iso, src);
      }
      const possible = local.getPossibleOffsets();
      if (possible.length > 1) throw new StatedTimeClarificationError('ambiguous_local_time', iso, src,
        possible.map(dt => dt.toISO()!).sort());
    }
    return reinterpretClockInZone(iso, src, homeTz);
  };
  const startOut = resolveOne(startIso);
  return {
    startIso: startOut,
    endIso: typeof endIso === 'string' ? resolveOne(endIso) : undefined,
    sourceZone: src,
    reinterpreted: startOut !== startIso,
  };
}

export interface DualClockOptions {
  endIso?: string;
  /** Colleague-facing framing: labels name "<name>'s travel timezone" / "<name>'s
   *  home time" instead of the owner-facing "your travel timezone" / "your home time". */
  ownerName?: string;
}

/**
 * THE one display string for a WE instant — quoted VERBATIM by every surface
 * (confirm, booked-confirmation, move summary, colleague escalate, approval
 * preview). Each clock is pinned by MEANING so a paraphrase can't invert it
 * (the "18:00 your Boston time" bug), and the trip side carries the date so a
 * wrong day is visible in the owner's own frame.
 *
 *   away:    "Mon 29 Jun 11:00 EDT[–11:25] your travel timezone / 18:00[–18:25] your home time"
 *   at home: "Mon 29 Jun 11:00[–11:25]"   (single clock — no false dual)
 *
 * The trip LOCATION is deliberately not named — it's the owner's lodging and
 * reads as the meeting VENUE (the "book at my hotel?" bug).
 */
export function renderWeDualClock(
  startIso: string,
  travel: OwnerTravelContext,
  homeTz: string,
  opts: DualClockOptions = {},
): string {
  const { endIso, ownerName } = opts;
  const homeStart = DateTime.fromISO(startIso, { zone: homeTz });
  if (!homeStart.isValid) return startIso;  // fail-safe: never throw inside narration
  const endHHmm = (iso: string | undefined, zone: string): string => {
    if (!iso) return '';
    const e = DateTime.fromISO(iso, { zone: homeTz }).setZone(zone);
    const s = homeStart.setZone(zone);
    const format = e.hasSame(s, 'day') ? 'HH:mm' : 'EEE d MMM HH:mm';
    return e.isValid ? `–${e.toFormat(format)}${e.offset !== s.offset ? ` ${e.toFormat('ZZZZ')}` : ''}` : '';
  };

  // Single clock when not away or when the effective zone matches home:
  // a dual clock would be identical.
  if (!travel.isAway || travel.effectiveTz === homeTz) {
    return `${homeStart.toFormat('EEE d MMM HH:mm')}${endHHmm(endIso, homeTz)}`;
  }

  const tripStart = renderClockInZone(startIso, homeTz, travel.effectiveTz);  // "Mon 29 Jun 11:00 EDT"
  const whereLabel = ownerName ? `${ownerName}'s travel timezone` : 'your travel timezone';
  const homeLabel = ownerName ? `${ownerName}'s home time` : 'your home time';
  const tripPart = `${tripStart}${endHHmm(endIso, travel.effectiveTz)} ${whereLabel}`;
  const sameDate = homeStart.toISODate() === homeStart.setZone(travel.effectiveTz).toISODate();
  const homePart = `${homeStart.toFormat(sameDate ? 'HH:mm' : 'EEE d MMM HH:mm')}${endHHmm(endIso, homeTz)} ${homeLabel}`;
  return `${tripPart} / ${homePart}`;
}

/**
 * THE profile-bound dual clock — `renderWeDualClock` with the travel lookup and
 * the reader framing already resolved, so a caller renders an instant by handing
 * over the instant and nothing else.
 *
 * Exists because M13 is about two surfaces never printing one instant two ways,
 * and the binding (which travel context, second person vs named) is exactly where
 * that drift would enter. It was written out inline in planMeeting and needed a
 * second time the moment the point-check started offering alternatives; two
 * identical closures are one edit away from disagreeing, so there is one.
 *
 * `viewer` picks the FRAMING only, never the data: 'owner' gets "your travel
 * timezone / your home time", anything else (a colleague, or unknown) gets the named
 * third-person form — the colleague-safe reading is the default, so an unset
 * viewer can never tell a colleague about someone else's trip in second person.
 */
export function profileDualClock(
  profile: UserProfile,
  viewer?: 'owner' | 'other',
): (startIso: string, endIso?: string) => string {
  // Lazy require, not a top-level import: this module is the WE spine and
  // `workingElsewhere` reaches back into it for types. Resolving the dependency
  // at CALL time (never at module init) keeps the edge harmless in either
  // direction — nothing here runs while the modules are still loading.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getTravelContextForInstant } = require('./workingElsewhere') as
    typeof import('./workingElsewhere');
  const reader = viewer === 'owner' ? {} : { ownerName: profile.user.name.split(' ')[0] };
  return (startIso: string, endIso?: string): string =>
    renderWeDualClock(
      startIso,
      getTravelContextForInstant(startIso, profile),
      profile.user.timezone,
      { endIso, ...reader },
    );
}
