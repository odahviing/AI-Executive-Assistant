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
 * Two pure functions, both fed the SINGLE travel context
 * (`getTravelContextForInstant`) — no detection or zone math anywhere else:
 *   - resolveStatedInstant: stated clock + which-zone-he-named → canonical instant
 *   - renderWeDualClock:     instant + travel context → the ONE display string
 *
 * Cloud-safe: every zone is passed explicitly (home from config, trip from the WE
 * marker). The server's own zone is NEVER consulted — that was the v3.5.4 7-hour
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

export interface StatedTimeInput {
  startIso: string;            // stated start — bare ("…T11:00:00") or already offset-tagged
  endIso?: string;             // optional stated end, resolved the same way
  statedZone?: StatedZone;     // what the owner named (model-supplied)
  travel: OwnerTravelContext;  // the ONE detection (getTravelContextForInstant)
  homeTz: string;              // owner's home/config zone
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
function sourceZoneFor(statedZone: StatedZone, travel: OwnerTravelContext, homeTz: string): string {
  if (statedZone === 'home') return homeTz;
  if (statedZone === 'local') return travel.effectiveTz;          // == homeTz when not away
  if (typeof statedZone === 'string' && statedZone.trim()) {      // explicit zone: IANA or an abbreviation
    const named = statedZone.trim();
    return ABBREV_TO_IANA[named.toUpperCase()] ?? named;
  }
  return travel.isAway ? travel.effectiveTz : homeTz;             // unspecified
}

/**
 * Resolve a stated clock to a canonical instant. A clock that ALREADY carries an
 * offset (a search-emitted slot, or one a prior step converted) is a fixed
 * instant — returned untouched, never re-read (that re-read was the "Alliance
 * 01:30 rollover"). A bare clock is read in `sourceZoneFor(...)`.
 */
export function resolveStatedInstant(input: StatedTimeInput): ResolvedStatedTime {
  const { startIso, endIso, statedZone, travel, homeTz } = input;
  const src = sourceZoneFor(statedZone, travel, homeTz);
  const resolveOne = (iso: string): string =>
    isoHasExplicitZone(iso) ? iso : reinterpretClockInZone(iso, src, homeTz);
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
  /** Colleague-facing framing: labels become "where <name> is now" / "<name>'s
   *  home time" instead of the owner-facing "where you are now" / "your home time". */
  ownerName?: string;
}

/**
 * THE one display string for a WE instant — quoted VERBATIM by every surface
 * (confirm, booked-confirmation, move summary, colleague escalate, approval
 * preview). Each clock is pinned by MEANING so a paraphrase can't invert it
 * (the "18:00 your Boston time" bug), and the trip side carries the date so a
 * wrong day is visible in the owner's own frame.
 *
 *   away:    "Mon 29 Jun 11:00 EDT[–11:25] where you are now / 18:00[–18:25] your home time"
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
    return e.isValid ? `–${e.toFormat('HH:mm')}` : '';
  };

  // Single clock when not away, or away in the same zone (marker location had no
  // resolvable TZ → effectiveTz fell back to home): a dual clock would be identical.
  if (!travel.isAway || travel.effectiveTz === homeTz) {
    return `${homeStart.toFormat('EEE d MMM HH:mm')}${endHHmm(endIso, homeTz)}`;
  }

  const tripStart = renderClockInZone(startIso, homeTz, travel.effectiveTz);  // "Mon 29 Jun 11:00 EDT"
  const whereLabel = ownerName ? `where ${ownerName} is now` : 'where you are now';
  const homeLabel = ownerName ? `${ownerName}'s home time` : 'your home time';
  const tripPart = `${tripStart}${endHHmm(endIso, travel.effectiveTz)} ${whereLabel}`;
  const homePart = `${homeStart.toFormat('HH:mm')}${endHHmm(endIso, homeTz)} ${homeLabel}`;
  return `${tripPart} / ${homePart}`;
}

/**
 * THE profile-bound dual clock — `renderWeDualClock` with the travel lookup and
 * the reader framing already resolved, so a caller renders an instant by handing
 * over the instant and nothing else.
 *
 * Exists because M14 is about two surfaces never printing one instant two ways,
 * and the binding (which travel context, second person vs named) is exactly where
 * that drift would enter. It was written out inline in planMeeting and needed a
 * second time the moment the point-check started offering alternatives; two
 * identical closures are one edit away from disagreeing, so there is one.
 *
 * `viewer` picks the FRAMING only, never the data: 'owner' gets "where you are
 * now / your home time", anything else (a colleague, or unknown) gets the named
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
