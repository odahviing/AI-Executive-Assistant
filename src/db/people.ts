import { getDb } from './client';
import { DateTime } from 'luxon';
import logger from '../utils/logger';

// ── People Memory ─────────────────────────────────────────────────────────────
// Persistent contact directory — auto-populated when people are mentioned or
// found via find_slack_user. Gives the agent cross-conversation relationship context.

export interface PersonNote {
  date: string;   // YYYY-MM-DD
  note: string;
}

export type PersonGender = 'male' | 'female' | 'unknown';

/**
 * Structured person profile — built up over time from observed behavior and
 * explicit interactions. Each dimension is independent and updateable.
 */
export interface PersonProfile {
  // How willing is this person to engage socially with Maelle?
  // avoidant = always ignores/one-word, minimal = rarely engages,
  // neutral = normal, friendly = warm, interactive = proactively chats
  engagement_level?: 'avoidant' | 'minimal' | 'neutral' | 'friendly' | 'interactive';

  // How do they communicate? Observed from message patterns.
  // e.g. "very brief, always direct, never asks questions back"
  // or "writes long messages, asks follow-up questions, conversational"
  communication_style?: string;

  // Preferred language if different from what Maelle defaults to
  // e.g. "Hebrew" or "English" — learned from reply patterns
  language_preference?: string;

  // When they're typically reachable — learned from timezone and reply patterns
  // e.g. "Israel 9am–6pm" or "US Eastern, responds mornings"
  // Free-text legacy. New writes should also populate working_hours_structured
  // so #43 (intersect attendee availability in slot search) can read it.
  working_hours?: string;

  // v2.2.1 (#46) — structured working window. Populated alongside the free-text
  // legacy when Maelle confirms the data via the colleague. Code paths that
  // need to intersect (slot search, outreach gating) read this; LLM context
  // still reads the free-text for natural narration.
  working_hours_structured?: {
    workdays: Array<'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday'>;
    hoursStart: string;   // 'HH:MM' in `timezone` (or owner's TZ if absent)
    hoursEnd: string;     // 'HH:MM'
    timezone?: string;    // IANA — overrides people_memory.timezone for this window when set
  };

  // Their role and what they care about — learned over time
  // e.g. "Heads up sales in EMEA. Focused on Q3 targets and team hiring."
  role_summary?: string;

  // Who they report to
  reports_to?: string;

  // How long they typically take to respond to messages from Maelle
  response_speed?: 'immediate' | 'fast' | 'hours' | 'day' | 'slow' | 'unreliable';

  // Who they work with most, what meetings they appear in
  // e.g. "Always in EMEA calls with David and Yael. Runs Monday team sync."
  collaboration_notes?: string;

  // When this profile was last meaningfully updated
  updated_at?: string;
}

/**
 * A single entry in the interaction timeline for a person.
 * Tracks what happened — separate from personal notes (who they are).
 */
export interface PersonInteraction {
  date: string;    // ISO datetime — when it happened
  type: 'meeting_booked' | 'message_sent' | 'message_received' | 'conversation' | 'social_chat' | 'coordination' | 'other';
  summary: string; // Short headline: "Booked 30min with Idan and Maayan for Thu 10 Apr 14:00"
}

// v2.2.2 (#46) — provenance for core attendee fields. Authority order:
// owner > person > auto. Owner can overwrite anyone; person overwrites only
// auto; auto cannot overwrite a set value. Always write through
// `setCoreFieldWithProvenance` below — never poke *_set_by columns directly.
export type CoreFieldSetBy = 'owner' | 'person' | 'auto';

export interface PersonMemory {
  // v3.2.0 — Unified Person Store. `person_id` is the surrogate PK (stable,
  // never changes). `slack_id` is now a nullable identity attribute — NULL for
  // pure-email externals (gmail candidates, customers). `email` is the other
  // identity attribute. `kind` distinguishes internal (has slack / company
  // domain) from external from the synthetic SELF row. Resolve a person by any
  // handle via `resolvePerson` — never assume slack_id is present.
  person_id: string;
  kind: 'internal' | 'external' | 'self';
  org?: string;                 // company — mostly for externals
  source?: string;              // row origin: slack | calendar | manual
  // v3.2.6 — owner-marked VIP (0/1). VIP calendars are ALWAYS pulled into a
  // thread-booking free/busy search; non-VIPs are invite-only (annotated, never
  // gating). Default 0 — set only on the owner's explicit say-so. Seed for #58.
  is_vip?: number;
  slack_id: string | null;
  name: string;
  name_he?: string;             // native-script spelling (Hebrew/Cyrillic/Arabic), used verbatim when writing in that script
  name_he_set_by?: CoreFieldSetBy; // v3.5.x — provenance for name_he (owner correction sticks; auto can't clobber)
  email?: string;
  timezone?: string;
  timezone_set_by?: CoreFieldSetBy;
  state?: string;               // v2.2.2 — free-text location ("Israel", "Boston", "Tel Aviv")
  state_set_by?: CoreFieldSetBy;
  gender: PersonGender;
  gender_confirmed?: number;    // 0/1 — kept for back-compat. New code reads gender_set_by.
  gender_set_by?: CoreFieldSetBy;
  last_inbound_lang?: string;       // v3.5.x — derived: dominant script of their most recent inbound ('he'|'ru'|'ar'|'en')
  last_inbound_lang_at?: string;    // v3.5.x — ISO datetime that signal was stamped
  working_hours_auto?: string;  // JSON: { workdays, hoursStart, hoursEnd } — derived from timezone defaults
  // v2.2.4 — travel awareness. JSON: { location, from, until } where location
  // is free text ("Boston", "NYC", "London"), from/until are ISO yyyy-MM-dd.
  // When set and `until` is in the future, this overrides `state` + `timezone`
  // + working_hours_auto for slot search and time-of-day display. Cleared
  // (set to NULL) once `until` is in the past. Read via getCurrentTravel().
  currently_traveling?: string;
  notes: string;                // JSON: PersonNote[]   — personal/relationship knowledge
  interaction_log: string;      // JSON: PersonInteraction[] — chronological activity timeline
  profile_json: string;         // JSON: PersonProfile  — structured behavioral model
  last_seen?: string;
  last_social_at?: string;      // ISO datetime of last ANY social exchange (Maelle or person)
  last_initiated_at?: string;   // ISO datetime of last time MAELLE started social chat (24h gate)
  created_at: string;
  updated_at: string;
}

const SET_BY_RANK: Record<CoreFieldSetBy, number> = { owner: 3, person: 2, auto: 1 };

/**
 * v4.2.x — the effective authority behind a row's stored gender.
 *
 * `gender_confirmed` predates `gender_set_by` and is documented above as the
 * back-compat mirror ("new code reads gender_set_by") — but it is a SECOND
 * authority signal, and the provenance chain only ever consulted the first. A row
 * carrying confirmed=1 with a NULL or 'auto' provenance tag (the shape every
 * pre-v3.5 row has, and the shape `confirmPersonGenderById` used to mint) then
 * ranked 0 or 1, so BOTH ends of the chain misread it: an auto detection could
 * overwrite a gender the person themselves confirmed — the invariant
 * `genderDetect.ts` documents as "enforced in people.ts" and which was not — and
 * a merge could pick the OTHER row's auto guess while carrying confirmed=1
 * forward, leaving a row that claims a confirmed gender for a value nobody
 * confirmed.
 *
 * A confirmation is a human statement by definition, so it FLOORS the rank at
 * 'person'. This is the one place the two columns are reconciled; every gender
 * authority comparison goes through it.
 */
function genderRank(setBy?: CoreFieldSetBy | null, confirmed?: number | null): number {
  return Math.max(setBy ? SET_BY_RANK[setBy] : 0, confirmed ? SET_BY_RANK.person : 0);
}

// ── Reading the interaction timeline ─────────────────────────────────────────
//
// Two kinds of entry live in one log and they need different treatment:
//
//   RELATIONAL (conversation / message_* / social_chat / other) — what was said.
//   Always true after the fact; render freely.
//
//   BOOKING SNAPSHOTS (meeting_booked / coordination) — what the calendar looked
//   like at write time. v2.3.4 stripped these from EVERY reader because a
//   snapshot lies once the meeting moves or is cancelled, and Sonnet narrated
//   stale ones as current fact.
//
// That blanket strip made the booking timeline write-only: recordBooking has
// been appending entries no reader could ever surface, so "we booked yesterday"
// — first-class work context under P6 — was unrecallable from the store. The
// fix is a freshness rule instead of a blanket strip: a booking recorded in the
// last BOOKING_RECALL_DAYS renders WITH an explicit as-booked frame that names
// the calendar as authoritative; older ones stay out, because that is exactly
// where a snapshot has had time to go stale.
export const BOOKING_RECALL_DAYS = 14;

/** Rendered above any booking-snapshot line so a moved meeting can't read as current. */
export const BOOKING_SNAPSHOT_FRAME =
  'recorded when booked — the calendar is authoritative if any of these moved since';

function isBookingSnapshot(i: PersonInteraction): boolean {
  return i.type === 'meeting_booked' || i.type === 'coordination';
}

/**
 * Split a person's raw `interaction_log` JSON into the two lists every reader
 * needs. ONE parse + ONE freshness rule, shared by the owner contact block, the
 * colleague context block and get_person_memory, so the three can't drift.
 * Corrupt JSON yields empty lists — never throws.
 */
export function readInteractionLog(
  rawJson: string | null | undefined,
  recentDays: number = BOOKING_RECALL_DAYS,
): { relational: PersonInteraction[]; recentBookings: PersonInteraction[] } {
  let log: PersonInteraction[];
  try {
    const parsed = JSON.parse(rawJson || '[]');
    log = Array.isArray(parsed) ? parsed as PersonInteraction[] : [];
  } catch {
    return { relational: [], recentBookings: [] };
  }
  const cutoff = DateTime.now().minus({ days: recentDays });
  const relational: PersonInteraction[] = [];
  const recentBookings: PersonInteraction[] = [];
  for (const i of log) {
    // Every reader downstream does `i.date.split('T')[0]`; this is now the ONE
    // place that parses the column, so a malformed entry is dropped here rather
    // than throwing inside a prompt builder.
    if (!i || typeof i.date !== 'string' || typeof i.summary !== 'string') continue;
    if (!isBookingSnapshot(i)) { relational.push(i); continue; }
    const at = DateTime.fromISO(i.date);
    if (at.isValid && at >= cutoff) recentBookings.push(i);
  }
  return { relational, recentBookings };
}

// ── v2.2.4 — travel awareness ────────────────────────────────────────────────
//
// People travel. A Tel Aviv person works from Boston for a week, an NYC
// person flies to London. Stored profile (timezone, state) is the *default*;
// when they're elsewhere, that should win for slot search and time-of-day
// reasoning during the window.
//
// `currently_traveling` column holds JSON: { location, from, until }. The
// reader (`getCurrentTravel`) returns null when the window is in the past —
// callers don't need to filter. Cleanup happens lazily on read; we don't run
// a sweep.

export interface CurrentTravel {
  location: string;
  from:   string;  // ISO yyyy-MM-dd
  until:  string;  // ISO yyyy-MM-dd
}

/**
 * v4.4.x (#170) — person_id-keyed (works for externals too). This is now the
 * ONLY writer of the column — `update_person_profile` (core/assistant.ts)
 * applies travel by person_id for both internal and external targets, so
 * there is no remaining slack_id-only caller to keep a thin wrapper for.
 */
export function setCurrentTravelById(personId: string, travel: CurrentTravel): void {
  const db = getDb();
  db.prepare(
    `UPDATE people_memory SET currently_traveling = ?, updated_at = datetime('now') WHERE person_id = ?`
  ).run(JSON.stringify(travel), personId);
}

/** v4.4.x (#170) — person_id-keyed (works for externals too); see setCurrentTravelById. */
export function clearCurrentTravelById(personId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE people_memory SET currently_traveling = NULL, updated_at = datetime('now') WHERE person_id = ?`
  ).run(personId);
}

/**
 * Returns the active travel record for the person, or null if none / expired.
 * Lazy cleanup: when the window is in the past, this returns null AND clears
 * the column so the next reader sees a clean slate.
 *
 * v4.4.x (#170) — person_id-keyed worker (works for externals too). The
 * slack_id-only original silently returned null for every email-only person
 * (externals, and any colleague whose row hadn't yet had a slack_id attached)
 * — not because they weren't traveling, but because the query couldn't reach
 * their row at all.
 */
export function getCurrentTravelById(personId: string): CurrentTravel | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT currently_traveling FROM people_memory WHERE person_id = ?`
  ).get(personId) as { currently_traveling?: string | null } | undefined;
  if (!row || !row.currently_traveling) return null;
  try {
    const t = JSON.parse(row.currently_traveling) as CurrentTravel;
    if (!t.location || !t.from || !t.until) return null;
    const today = new Date().toISOString().slice(0, 10);
    // Past trip → auto-clear and treat as not active.
    if (t.until < today) {
      clearCurrentTravelById(personId);
      return null;
    }
    // Future trip (saved ahead of departure) → not active yet, fall back to
    // stored profile. Do NOT clear — the record is still useful, it just
    // shouldn't override TZ until the trip actually starts.
    if (t.from > today) return null;
    return t;
  } catch (_) {
    return null;
  }
}

export function getCurrentTravel(slackId: string): CurrentTravel | null {
  const pid = personIdForSlackId(slackId);
  return pid ? getCurrentTravelById(pid) : null;
}

/**
 * v3.3.8 — raw travel record, gated only on "not already over" (until >= today).
 *
 * getCurrentTravel answers "are they traveling NOW" — right for narration and
 * social. The slot finder needs a different question: "what timezone are they
 * in on the day being SEARCHED" — and a trip that starts Friday is invisible
 * to now-semantics while being decisive for a Friday search. Real incident
 * (Daniel, 2026-06-11): the owner taught "she's back in Israel on Tuesday",
 * the record was saved correctly ({Israel, from/until 2026-06-16}), and the
 * Tuesday search still applied Tokyo because getCurrentTravel returned null
 * for a future trip. Consumers resolve per-day via
 * `attendeeAvailability.attendeeTzForDay`.
 */
/** v4.4.x (#170) — person_id-keyed worker (works for externals too); see
 *  getCurrentTravelById for why the slack_id-only original silently missed
 *  every email-only person. */
export function getTravelRecordById(personId: string): CurrentTravel | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT currently_traveling FROM people_memory WHERE person_id = ?`
  ).get(personId) as { currently_traveling?: string | null } | undefined;
  if (!row || !row.currently_traveling) return null;
  try {
    const t = JSON.parse(row.currently_traveling) as CurrentTravel;
    if (!t.location || !t.from || !t.until) return null;
    const today = new Date().toISOString().slice(0, 10);
    if (t.until < today) {
      clearCurrentTravelById(personId);
      return null;
    }
    return t;
  } catch (_) {
    return null;
  }
}

export function getTravelRecord(slackId: string): CurrentTravel | null {
  const pid = personIdForSlackId(slackId);
  return pid ? getTravelRecordById(pid) : null;
}

// ── v3.2.6 — VIP flag ────────────────────────────────────────────────────────
// Owner-curated, like engagement_rank. VIP calendars are ALWAYS pulled into a
// thread-booking free/busy search; non-VIPs are invite-only (annotated, never
// gating). Set only on the owner's explicit say-so. Seed for the full VIP
// feature (#58). Default 0; idempotent.

export function setPersonVip(slackId: string, vip: boolean): void {
  const db = getDb();
  db.prepare(
    `UPDATE people_memory SET is_vip = ?, updated_at = datetime('now') WHERE slack_id = ?`
  ).run(vip ? 1 : 0, slackId);
}

export function setPersonVipById(personId: string, vip: boolean): void {
  const db = getDb();
  db.prepare(
    `UPDATE people_memory SET is_vip = ?, updated_at = datetime('now') WHERE person_id = ?`
  ).run(vip ? 1 : 0, personId);
}

/**
 * v2.2.2 (#46) — the core attendee fields whose writes are provenance-gated.
 * v4.2.x — `name_he` joined them: it had its own setter running a byte-identical
 * copy of the rank chain, which is one authority rule in two places (and the copy
 * returned void, so its outcome could never be reported).
 */
export type CoreProvenanceField = 'gender' | 'timezone' | 'state' | 'name_he';

/**
 * v4.2.x — the outcome of a provenance-gated write.
 *
 * This used to be a boolean, and a boolean cannot say WHY nothing was written —
 * yet the two reasons are opposite facts about the world. "A higher authority
 * holds a DIFFERENT value" is a refusal. "The row already says exactly this" is
 * nothing-to-do. Every caller that reports back to a human collapsed both into a
 * refusal, so re-confirming a gender already on file at the same authority came
 * back as `higher_authority_already_set` — Maelle reporting she couldn't save
 * something that was already true. The distinction is drawn HERE, beside the rank
 * comparison, so no caller re-derives it (there is one provenance decision, in
 * one place, and it is this one).
 */
export type CoreFieldWrite =
  | 'applied'                 // written: a new value, or the same value at a raised authority
  | 'already_set'             // no write needed — the stored value already matches the request
  | 'refused_lower_authority' // a higher authority holds a DIFFERENT value
  | 'no_value'                // nothing usable to write
  | 'no_person';              // no row for this identity

/**
 * Single choke-point for writing a core field with provenance enforcement.
 *
 * Authority: owner overrides anyone; person overrides only auto; auto cannot
 * overwrite anything already set by owner or person. Empty/null current values
 * are always overwritten.
 */
export function setCoreFieldWithProvenance(
  slackId: string,
  field: CoreProvenanceField,
  value: string,
  by: CoreFieldSetBy,
): CoreFieldWrite {
  const pid = personIdForSlackId(slackId);
  return pid ? setCoreFieldWithProvenanceById(pid, field, value, by) : 'no_person';
}

/** v3.2.0 — person_id-keyed worker (works for externals too). */
export function setCoreFieldWithProvenanceById(
  personId: string,
  field: CoreProvenanceField,
  value: string,
  by: CoreFieldSetBy,
): CoreFieldWrite {
  const next = (value ?? '').trim();
  if (!next) return 'no_value';
  const db = getDb();
  const setByCol = `${field}_set_by` as const;
  const row = db.prepare(
    `SELECT ${field} as value, ${setByCol} as setBy, gender_confirmed as confirmed FROM people_memory WHERE person_id = ?`,
  ).get(personId) as
    | { value: string | null; setBy: CoreFieldSetBy | null; confirmed: number | null }
    | undefined;

  // No row yet — caller must create first; we no-op rather than create.
  if (!row) return 'no_person';

  const currentSetBy = row.setBy ?? null;
  const currentValue = (row.value ?? '').toString();
  const newRank = SET_BY_RANK[by];
  // Gender has a second authority column; genderRank folds them into one rank so
  // a confirmed-but-untagged value can't be read as unowned.
  const currentRank = field === 'gender'
    ? genderRank(currentSetBy, row.confirmed)
    : (currentSetBy ? SET_BY_RANK[currentSetBy] : 0);

  if (currentValue === next) {
    // Already what was asked. The only work left is RAISING the authority behind
    // it (a person's word promoted to the owner's) — and when there is none to
    // raise, nothing needed doing. That is NOT a refusal even when a higher
    // authority holds the field, because what it holds is this very value.
    if (newRank <= currentRank) return 'already_set';
  } else if (currentValue && newRank < currentRank) {
    // A different value, and a higher authority owns the field — the one case
    // where a write is genuinely refused. The test is the RANK, not whether a
    // provenance tag happens to be present: an untagged rank stays 0, so this
    // never fires for an untagged row (the lowest incoming rank is auto=1) while
    // a confirmed gender still defends itself.
    return 'refused_lower_authority';
  }

  db.prepare(
    `UPDATE people_memory SET ${field} = ?, ${setByCol} = ?, updated_at = datetime('now') WHERE person_id = ?`,
  ).run(next, by, personId);

  // Side effect: setting gender via this path also flips gender_confirmed for
  // back-compat readers (gender_confirmed=1 means owner OR person, not auto).
  if (field === 'gender' && by !== 'auto') {
    db.prepare(`UPDATE people_memory SET gender_confirmed = 1 WHERE person_id = ?`).run(personId);
  }

  return 'applied';
}

/** v3.2.0 — resolve a slack_id to its surrogate person_id (null if no row). */
export function personIdForSlackId(slackId: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT person_id FROM people_memory WHERE slack_id = ?').get(slackId) as
    | { person_id: string } | undefined;
  return row?.person_id ?? null;
}

/**
 * The native-script spelling of a name (`name_he` — Hebrew/Cyrillic/Arabic) is a
 * core field like any other: provenance-aware (owner > person > auto), so an owner
 * correction ("עידן not אידן") sticks and an auto guess (capture pass /
 * first-time transliteration) can't overwrite it. That is what freezes the
 * spelling — once stored it's reused verbatim, never re-guessed.
 *
 * v4.2.x — it no longer has its own setter. `setPersonNameHe(By)` re-implemented
 * the same rank chain in a second place and returned void, so a refused write was
 * indistinguishable from a landed one at the tool surface. Callers now use
 * `setCoreFieldWithProvenance(By)(…, 'name_he', …)` and get the real outcome.
 */

/**
 * Create or update a contact in people_memory from a SLACK signal (users.info
 * pull, @mention resolve, colleague message, self-seed).
 * Safe to call repeatedly — only overwrites non-null fields.
 * Gender is only updated when a real value (not 'unknown') is supplied.
 *
 * v4.0.4 — identity resolution goes through `resolvePerson`, THE chokepoint.
 * Pre-fix this function ran its OWN `INSERT … ON CONFLICT(slack_id)`, which
 * deduped on slack_id ONLY: a person already on file from the CALENDAR
 * (slack_id NULL, email set) got a SECOND row the first time they appeared on
 * Slack, because nothing checked whether another row already owned that email.
 * That is exactly how Luke Joas ended up with two rows for one address
 * (`p_mq97pufr_00pi9w`, source=calendar, 2026-06-11 → `p_U07QVKMCMP0`,
 * source=slack, 2026-06-23), which then read as "ambiguous" downstream and
 * dropped him from an availability search. resolvePerson's merge-by-attach
 * hangs the new slack_id on the existing email-matched row instead.
 *
 * `name` is deliberately NOT passed to resolvePerson: its fuzzy-name step must
 * never merge two DISTINCT Slack humans who happen to share a display name.
 * The name is written below, where a definitive slack_id already pinned the row.
 */
export function upsertPersonMemory(params: {
  slackId: string;
  name: string;
  email?: string;
  /**
   * A Slack-derived zone (users.info / profile pull) — always recorded as 'auto',
   * which is what every remaining caller is. A STATED zone ("I'm in Boston") is
   * not an upsert concern: it goes straight to `setCoreFieldWithProvenance` with
   * the stater's authority. The old `timezoneSetBy` override had exactly one
   * caller — update_person_profile — which ALSO wrote the same field through the
   * provenance helper moments later, so the first write's outcome was
   * unobservable and the second always came back "already_set". One write, one
   * reportable outcome; the parameter went with the duplicate.
   */
  timezone?: string;
  gender?: PersonGender;
}): void {
  if (!params.slackId) return;
  const db = getDb();

  const resolved = resolvePerson({
    slackId:  params.slackId,
    email:    params.email,
    // A `SELF:<owner>` row is the assistant's own row and must stay kind='self'
    // — searchPeopleMemory excludes self by kind, which is what stops colleague
    // gossip from landing on Maelle's row.
    kindHint: params.slackId.startsWith('SELF:') ? 'self' : 'internal',
  });
  if (!resolved) return;
  const personId = resolved.person_id;

  // NOTE: gender is only written when explicitly supplied AND not 'unknown'.
  // Respect gender_confirmed: never overwrite a confirmed gender here. A
  // confirmed update must go through confirmPersonGenderById().
  db.prepare(`
    UPDATE people_memory SET
      name             = @name,
      gender           = CASE
                           WHEN gender_confirmed = 1 THEN gender
                           WHEN @gender != 'unknown' THEN @gender
                           ELSE gender
                         END,
      last_seen        = datetime('now'),
      updated_at       = datetime('now')
    WHERE person_id = @person_id
  `).run({
    person_id: personId,
    name:      params.name,
    gender:    params.gender   ?? 'unknown',
  });

  // Timezone rides the provenance chokepoint (owner > person > auto). It used to
  // be a `COALESCE(@timezone, timezone)` in the statement above, which OVERWROTE
  // an owner-set zone with an auto Slack guess while leaving the old `_set_by`
  // tag in place — the row then claimed 'owner' authority for an auto value.
  // Harmless while owner-set zones only ever lived on calendar rows this function
  // never touched; the moment a merge folds such a row onto a Slack row (which is
  // now the point) it would silently clobber a taught timezone.
  if (params.timezone) {
    setCoreFieldWithProvenanceById(personId, 'timezone', params.timezone, 'auto');
    // v2.2.2 (#46) — refresh the auto-derived working hours off whatever zone is
    // now STORED (the write above may have been refused as lower-authority).
    // Cheap; idempotent inside the helper.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { refreshAutoWorkingHours } = require('../utils/workingHoursDefault') as typeof import('../utils/workingHoursDefault');
      refreshAutoWorkingHours(params.slackId);
    } catch { /* never block memory writes */ }
  }

  // The Slack profile is authoritative for a Slack person's address, so an
  // email CHANGE propagates here (resolvePerson's attach is fill-only). Routed
  // through the single email writer so it can never mint / strand a second row
  // for an address another person already owns.
  if (params.email) setPersonEmail(personId, params.email, { overwrite: true });
}

/**
 * Human-confirmed gender write — the person themselves stating it ("אני את -
 * נקבה", "I'm a guy"), or the owner confirming on their behalf (`by: 'owner'`).
 *
 * v4.2.x — delegates to `setCoreFieldWithProvenanceById` instead of running its
 * own UPDATE. The old statement wrote `gender_confirmed = 1` and left
 * `gender_set_by` untouched, which is precisely how a row acquired a confirmed
 * flag over an 'auto' (or untagged) provenance — the split authority `genderRank`
 * now has to defend against. One writer, both columns, one authority chain.
 *
 * Returns the write outcome (`CoreFieldWrite`), which the caller owes a human:
 * `refused_lower_authority` is the only real refusal (a HIGHER authority holds a
 * DIFFERENT gender), `already_set` means it was on file exactly as stated, and
 * 'unknown' is the absence of a gender — it can never be "confirmed", so it comes
 * back as `no_value`. Callers must not claim it saved on anything but `applied` /
 * `already_set`.
 *
 * person_id-keyed (works for externals too). The slack_id-keyed wrapper went with
 * the old UPDATE — it had no callers, and every path already holds a person_id
 * from `resolvePerson` / `resolvePersonTarget`.
 */
export function confirmPersonGenderById(personId: string, gender: PersonGender, by: CoreFieldSetBy = 'person'): CoreFieldWrite {
  if (gender !== 'male' && gender !== 'female') return 'no_value';
  // A confirmation is a human statement by construction — 'auto' is not a thing
  // this function can express, so an auto caller is treated as the person's word
  // rather than silently downgraded to a guess that also flips confirmed.
  return setCoreFieldWithProvenanceById(personId, 'gender', gender, by === 'auto' ? 'person' : by);
}

// ── v3.5.x — derived outbound language ───────────────────────────────────────
//
// Outbound composition TO a person (relay / outreach / coord) should speak the
// language they're ACTUALLY writing in, not a frozen one-off preference that
// never self-corrects (the Ayala bug: stored language_preference=Hebrew, she
// writes English, got a Hebrew relay). We stamp the dominant script of each
// inbound human message and derive outbound from the most recent one; default
// English. The owner can still pin a language via update_person_profile, which
// wins for contacts we haven't heard from inside the recency window.

const LANG_RECENCY_DAYS = 45;

/**
 * v4.4.x (#170) — person_id-keyed worker (works for externals too). The
 * slack_id-only original was this field's ONLY writer and could never reach
 * an email-only row (every external, and any colleague whose row hadn't yet
 * had a slack_id attached) — not "stale for them", genuinely unwritable, so
 * their language signal stayed permanently NULL no matter how many turns
 * they sent.
 */
export function setLastInboundLangById(personId: string, lang: string): void {
  if (!lang || !personId) return;
  const db = getDb();
  db.prepare(
    `UPDATE people_memory SET last_inbound_lang = ?, last_inbound_lang_at = datetime('now'), updated_at = datetime('now') WHERE person_id = ?`,
  ).run(lang, personId);
}

/** Stamp the detected inbound language for a person (cheap, called per turn). */
export function setLastInboundLang(slackId: string, lang: string): void {
  if (!lang || !slackId) return;
  const pid = personIdForSlackId(slackId);
  if (pid) setLastInboundLangById(pid, lang);
}

/**
 * The language to WRITE TO this person in. Precedence:
 *   1. recent inbound (within LANG_RECENCY_DAYS) — the live signal wins
 *   2. stored language_preference (owner pin / legacy) — fallback for contacts
 *      we haven't heard from recently
 * Returns a short code ('he' | 'ru' | 'ar' | 'en' | <stored pref lowercased>),
 * or **null when nothing is known** — no live signal and no stored
 * preference. v4.4.x (#170): this used to return 'en' for that case too, so a
 * genuine "he writes to her in English" and a bare "we've never heard from
 * them" were the same string and no caller could tell them apart — which
 * mattered once the write side (setLastInboundLangById above) meant the
 * unknown case would otherwise be indistinguishable from a confirmed one.
 * Callers decide what "unknown" should render as (a legible default, an
 * omission, etc.) — this function never picks a language for them.
 */
export function resolveOutboundLanguageForPerson(person: PersonMemory | null | undefined): string | null {
  if (!person) return null;
  // 1. Live signal — most recent inbound, if fresh.
  if (person.last_inbound_lang && person.last_inbound_lang_at) {
    const iso = person.last_inbound_lang_at.replace(' ', 'T') + 'Z'; // SQLite datetime() is UTC, no marker
    const ageDays = (Date.now() - Date.parse(iso)) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays <= LANG_RECENCY_DAYS) {
      return person.last_inbound_lang;
    }
  }
  // 2. Stored preference (owner pin / legacy) for contacts not recently active.
  try {
    const pj = JSON.parse(person.profile_json || '{}');
    const pref = ((pj?.language_preference as string | undefined) ?? '').toLowerCase().trim();
    if (pref) {
      if (pref === 'he' || pref === 'he-il' || pref.startsWith('hebrew') || pref.includes('עברית')) return 'he';
      return pref;
    }
  } catch { /* fall through */ }
  // 3. Nothing known.
  return null;
}

/**
 * Update the structured profile for a person — merges supplied fields into
 * the existing profile, leaving unspecified fields untouched.
 */
export function updatePersonProfile(slackId: string, updates: Partial<PersonProfile>): void {
  const pid = personIdForSlackId(slackId);
  if (pid) updatePersonProfileById(pid, updates);
}

/** v3.2.0 — person_id-keyed worker. */
export function updatePersonProfileById(personId: string, updates: Partial<PersonProfile>): void {
  const db = getDb();
  const row = db.prepare('SELECT profile_json FROM people_memory WHERE person_id = ?').get(personId) as any;
  if (!row) return;

  const existing: PersonProfile = (() => {
    try { return JSON.parse(row.profile_json || '{}'); } catch { return {}; }
  })();

  const merged: PersonProfile = {
    ...existing,
    ...Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined && v !== null && v !== '')),
    updated_at: new Date().toISOString().split('T')[0],
  };

  db.prepare(`
    UPDATE people_memory SET profile_json = ?, updated_at = datetime('now') WHERE person_id = ?
  `).run(JSON.stringify(merged), personId);
}

/**
 * Append a personal/relationship note about a contact.
 * For things like "has two kids", "loves Real Madrid", "goes by Ike".
 * Keep it to human context — work activity goes in appendPersonInteraction.
 * Keeps last 50 notes.
 */
export function appendPersonNote(slackId: string, note: string): void {
  const pid = personIdForSlackId(slackId);
  if (pid) appendPersonNoteById(pid, note);
}

/**
 * v3.2.0 — person_id-keyed worker (works for externals).
 *
 * RMW guarded by BEGIN IMMEDIATE so concurrent writers serialize. Pre-fix
 * an in-turn `note_about_self` from Sonnet could interleave with a
 * background capture-pass write on the same row: A reads → B reads →
 * A writes → B's write overwrites A. Lost note. With the transaction,
 * the second writer either waits for the first commit (then sees the
 * updated row on its own SELECT inside the txn) or fails with SQLITE_BUSY
 * (which better-sqlite3 surfaces as an exception — caller's existing
 * try/catch handles non-fatal logging).
 */
export function appendPersonNoteById(personId: string, note: string): void {
  const db = getDb();
  const txn = db.transaction((id: string, newNote: string) => {
    const row = db.prepare('SELECT notes FROM people_memory WHERE person_id = ?').get(id) as
      | { notes: string }
      | undefined;
    if (!row) return;
    const notes: PersonNote[] = JSON.parse(row.notes || '[]');
    const today = new Date().toISOString().split('T')[0];
    notes.push({ date: today, note: newNote });
    const trimmed = notes.slice(-50);   // keep last 50 — rich context, not expensive
    db.prepare(`
      UPDATE people_memory
      SET notes = ?, updated_at = datetime('now')
      WHERE person_id = ?
    `).run(JSON.stringify(trimmed), id);
  });
  txn.immediate(personId, note);
}

/**
 * Append an interaction to the chronological activity timeline for a contact.
 * For things like "booked meeting", "sent message", "had a conversation about X".
 * This is the activity log — separate from personal notes.
 * Keeps last 200 interactions (headlines are short, memory is cheap).
 *
 * RMW guarded by BEGIN IMMEDIATE so concurrent writers serialize. Same race
 * shape as appendPersonNote: capture-pass writes a "social_chat" summary in
 * parallel with an orchestrator-side note_about_person call on the same row;
 * without the transaction, one entry is silently lost.
 */
export function appendPersonInteraction(slackId: string, interaction: Omit<PersonInteraction, 'date'>): void {
  // v3.2.0 — resolve to the surrogate person_id, then delegate. Keeps the
  // slack_id-keyed call sites (assistant log_interaction, capturePass, social)
  // unchanged while the storage is person_id-centric.
  const db = getDb();
  const row = db.prepare('SELECT person_id FROM people_memory WHERE slack_id = ?').get(slackId) as
    | { person_id: string } | undefined;
  if (!row) return;
  appendPersonInteractionById(row.person_id, interaction);
}

/**
 * v3.2.0 — append an interaction keyed by the surrogate person_id. This is the
 * path that works for EXTERNAL people (no slack_id) — e.g. recordBooking now
 * logs a booking against a pure-email candidate's timeline so the next time the
 * owner books them, the last-N-interactions recall has the history.
 *
 * RMW guarded by BEGIN IMMEDIATE so concurrent writers serialize (same race
 * shape as appendPersonNote). Keeps the last 200 interactions.
 */
export function appendPersonInteractionById(personId: string, interaction: Omit<PersonInteraction, 'date'>): void {
  const db = getDb();
  const txn = db.transaction((id: string, entry: Omit<PersonInteraction, 'date'>) => {
    const row = db.prepare('SELECT interaction_log FROM people_memory WHERE person_id = ?').get(id) as
      | { interaction_log: string }
      | undefined;
    if (!row) return;

    const log: PersonInteraction[] = (() => {
      try { return JSON.parse(row.interaction_log || '[]'); } catch { return []; }
    })();

    log.push({ date: new Date().toISOString(), ...entry });
    const trimmed = log.slice(-200);

    db.prepare(`
      UPDATE people_memory
      SET interaction_log = ?, updated_at = datetime('now')
      WHERE person_id = ?
    `).run(JSON.stringify(trimmed), id);
  });
  txn.immediate(personId, interaction);
}

/**
 * Record that a social moment happened with a person.
 *
 * @param personId    - person's surrogate id
 * @param initiatedBy - 'maelle' | 'person' — only Maelle initiations consume the daily gate
 * @returns true when the row was actually stamped; FALSE when this person_id has
 *          no people_memory row, in which case nothing was written. The return
 *          exists because `last_initiated_at` is the once-per-day coda gate: a
 *          silent no-op here leaves that gate open, and the caller that just
 *          DELIVERED a coda (`recordCodaDelivered`) has to be able to say so.
 *
 * v4.4.x (#170) — person_id-keyed worker (works for externals too).
 */
export function recordSocialMomentById(
  personId: string,
  initiatedBy: 'maelle' | 'person' = 'maelle',
): boolean {
  // Updates last_social_at + last_initiated_at on the person row so the 24h
  // Maelle-initiation gate keeps working. Subject + topic-beat writes happen
  // ONLY at end-of-chat in `memory/capturePass.ts:runSubjectReconciliation`
  // (v3.0.1); this helper covers the people_memory row only.
  const db = getDb();
  const row = db.prepare('SELECT person_id FROM people_memory WHERE person_id = ?').get(personId) as any;
  if (!row) return false;

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { last_social_at: now };
  if (initiatedBy === 'maelle') {
    updates.last_initiated_at = now;
  }
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE people_memory SET ${setClause}, updated_at = datetime('now') WHERE person_id = @person_id`)
    .run({ ...updates, person_id: personId });
  return true;
}

/** Slack-keyed convenience — resolves to the surrogate id, then delegates. */
export function recordSocialMoment(
  slackId: string,
  initiatedBy: 'maelle' | 'person' = 'maelle',
): boolean {
  const pid = personIdForSlackId(slackId);
  return pid ? recordSocialMomentById(pid, initiatedBy) : false;
}

export function getPersonMemory(slackId: string): PersonMemory | null {
  const db = getDb();
  return db.prepare('SELECT * FROM people_memory WHERE slack_id = ?').get(slackId) as PersonMemory | null;
}

/**
 * Free-text search across people_memory by name / email.
 *
 * SELF rows are excluded by construction. The Maelle SELF row carries
 * slack_id of shape `SELF:<ownerSlackId>` and name = the assistant's name;
 * a colleague typing "Maelle" or even a fuzzy match against the assistant
 * name must NOT resolve to the SELF row (gossip about Maelle would
 * otherwise persist there from any colleague's input). Defense in depth —
 * `SLACK_ID_RE = /^[UW][A-Z0-9]{6,}$/` rejects "SELF:" inputs upstream,
 * but a regex change or a SELF re-keying would re-open the gap without
 * this filter.
 */
export function searchPeopleMemory(query: string): PersonMemory[] {
  const db = getDb();
  const q = `%${query.toLowerCase()}%`;
  // v3.2.0 — exclude the SELF row via `kind` (not the slack_id prefix): an
  // external person has slack_id NULL, and `NULL NOT LIKE 'SELF:%'` is NULL
  // (falsy) in SQL, which would silently drop every external from name search.
  return db.prepare(`
    SELECT * FROM people_memory
    WHERE (lower(name) LIKE ? OR lower(email) LIKE ?)
      AND kind != 'self'
    ORDER BY last_seen DESC
    LIMIT 10
  `).all(q, q) as PersonMemory[];
}

/** v3.2.0 — fresh surrogate id for a runtime-created person (no slack_id to
 *  derive from — e.g. a pure-email external first seen at booking time). */
export function newPersonId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** v3.2.0 — fetch by surrogate PK. */
export function getPersonById(personId: string): PersonMemory | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM people_memory WHERE person_id = ?').get(personId) as PersonMemory | null) ?? null;
}

/** v3.2.0 — fetch by email (logical key). Prefers a Slack-bearing (internal)
 *  row when duplicates exist — Slack wins per the merge rule. Never returns
 *  the SELF row. */
export function getPersonByEmail(email: string): PersonMemory | null {
  const e = (email ?? '').trim();
  if (!e) return null;
  const db = getDb();
  return (db.prepare(`
    SELECT * FROM people_memory
    WHERE lower(email) = lower(?) AND kind != 'self'
    ORDER BY (slack_id IS NOT NULL) DESC, last_seen DESC
    LIMIT 1
  `).get(e) as PersonMemory | null) ?? null;
}

// ── v4.0.4 — one human, one row ──────────────────────────────────────────────
//
// `email` is the LOGICAL identity key of the person store, so writing one is an
// identity operation, not a field update. Two rows sharing one address are one
// human split in half, and every consumer that counts rows (attendee resolution,
// the md catalog, name search) then reads the split as ambiguity. The three
// helpers below are the whole enforcement: `setPersonEmail` is the only writer of
// the column, `mergePersonRows` collapses a pair that already exists, and
// `resolvePerson` calls both so no creation path can fork around them.

/** SQLite `datetime('now')` writes "YYYY-MM-DD HH:MM:SS"; JS `toISOString()`
 *  writes "…THH:MM:SS.sssZ". Both live in these columns, and a raw string
 *  compare orders 'T' (0x54) after ' ' (0x20) — so normalize before comparing
 *  or a same-day ISO value always looks newer than a SQLite one. */
function tsKey(s?: string | null): string {
  return (s ?? '').replace('T', ' ').replace('Z', '').trim();
}
function laterOf(a?: string | null, b?: string | null): string | null {
  const ka = tsKey(a); const kb = tsKey(b);
  if (!ka) return b ?? null;
  if (!kb) return a ?? null;
  return kb > ka ? (b ?? null) : (a ?? null);
}
function earlierOf(a?: string | null, b?: string | null): string | null {
  const ka = tsKey(a); const kb = tsKey(b);
  if (!ka) return b ?? null;
  if (!kb) return a ?? null;
  return kb < ka ? (b ?? null) : (a ?? null);
}

/**
 * Provenance-aware field pick for a merge (owner > person > auto; ties → `a`).
 * `rank` overrides the tag-derived rank for a field whose authority isn't carried
 * by `_set_by` alone — gender, whose confirmed flag is a second signal
 * (`genderRank`).
 */
function pickByProvenance(
  a: { value?: string | null; setBy?: CoreFieldSetBy | null; rank?: number },
  b: { value?: string | null; setBy?: CoreFieldSetBy | null; rank?: number },
): { value: string | null; setBy: CoreFieldSetBy | null } {
  const av = (a.value ?? '').trim();
  const bv = (b.value ?? '').trim();
  if (!av && !bv) return { value: null, setBy: null };
  if (!av) return { value: bv, setBy: b.setBy ?? null };
  if (!bv) return { value: av, setBy: a.setBy ?? null };
  const ar = a.rank ?? (a.setBy ? SET_BY_RANK[a.setBy] : 0);
  const br = b.rank ?? (b.setBy ? SET_BY_RANK[b.setBy] : 0);
  return br > ar ? { value: bv, setBy: b.setBy ?? null } : { value: av, setBy: a.setBy ?? null };
}

/** Union two JSON arrays of dated records, dedup by `keyOf`, oldest→newest, capped. */
function unionDated<T>(aJson: string, bJson: string, keyOf: (x: T) => string, dateOf: (x: T) => string, cap: number): string {
  const parse = (s: string): T[] => {
    try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? (v as T[]) : []; } catch { return []; }
  };
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of [...parse(aJson), ...parse(bJson)]) {
    if (!item || typeof item !== 'object') continue;
    const k = keyOf(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  out.sort((x, y) => tsKey(dateOf(x)).localeCompare(tsKey(dateOf(y))));
  return JSON.stringify(out.slice(-cap));
}

/** Shallow-merge two PersonProfile blobs; non-empty keys from `a` win. */
function mergeProfileJson(aJson: string, bJson: string): string {
  const parse = (s: string): Record<string, unknown> => {
    try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; }
    catch { return {}; }
  };
  const merged = parse(bJson);
  for (const [k, v] of Object.entries(parse(aJson))) {
    if (v !== undefined && v !== null && v !== '') merged[k] = v;
  }
  return JSON.stringify(merged);
}

/** Columns not on the PersonMemory interface but present on the row. */
type PersonRow = PersonMemory & { engagement_rank?: number; proactive_pending?: number };

/**
 * v4.0.4 — collapse TWO rows that are the SAME human into ONE, preserving the
 * union of what each side knew. Returns true when the merge happened.
 *
 * Survivor choice is the CALLER's (the canonical rule is `getPersonByEmail`'s:
 * a slack_id-bearing row wins, then most-recently-seen) — this function only
 * guarantees nothing is lost: handles are COALESCEd, provenance-tagged fields
 * keep the higher authority, notes / interaction_log are unioned + deduped,
 * profile_json is shallow-merged, `created_at` keeps the EARLIER date (we've
 * known the person since then), and the recency stamps keep the LATER value.
 *
 * The loser's per-person md file is folded into the survivor's BEFORE the rows
 * collapse, and a fold that didn't complete DEFERS the collapse — see the
 * comment at the call below for why that order is the only recoverable one.
 *
 * Three refusals. Two because merging would DESTROY identity rather than repair
 * it: a kind='self' row (Maelle's own row — merging it is how colleague gossip
 * would reach it), and two DIFFERENT slack_ids (two Slack accounts on one
 * address are two people; keeping them apart is the conservative read). The
 * third is the md fold above — a deferral, not a verdict on identity: the pair
 * stays visible to the sweep and the next attempt finishes the job.
 */
export function mergePersonRows(survivorId: string, loserId: string): boolean {
  if (!survivorId || !loserId || survivorId === loserId) return false;
  const db = getDb();
  const survivor = getPersonById(survivorId) as PersonRow | null;
  const loser = getPersonById(loserId) as PersonRow | null;
  if (!survivor || !loser) return false;

  if (survivor.kind === 'self' || loser.kind === 'self') {
    logger.warn('person store — refusing to merge a SELF row', { survivorId, loserId });
    return false;
  }
  if (survivor.slack_id && loser.slack_id && survivor.slack_id !== loser.slack_id) {
    logger.warn('person store — refusing to merge two distinct slack identities', {
      survivorId, loserId, survivorSlackId: survivor.slack_id, loserSlackId: loser.slack_id,
    });
    return false;
  }

  const slackIdMerged = survivor.slack_id ?? loser.slack_id ?? null;
  const nameHe = pickByProvenance(
    { value: survivor.name_he, setBy: survivor.name_he_set_by },
    { value: loser.name_he, setBy: loser.name_he_set_by },
  );
  const timezone = pickByProvenance(
    { value: survivor.timezone, setBy: survivor.timezone_set_by },
    { value: loser.timezone, setBy: loser.timezone_set_by },
  );
  const state = pickByProvenance(
    { value: survivor.state, setBy: survivor.state_set_by },
    { value: loser.state, setBy: loser.state_set_by },
  );
  // Gender's authority is the pair (gender_set_by, gender_confirmed) — see
  // genderRank. Ranking on the tag alone let a confirmed value lose to the other
  // row's auto guess while `gender_confirmed` was max()'d forward, producing a row
  // that claimed a confirmed gender for a value nobody confirmed.
  const survivorGenderRank = genderRank(survivor.gender_set_by, survivor.gender_confirmed);
  const loserGenderRank    = genderRank(loser.gender_set_by, loser.gender_confirmed);
  const gender = pickByProvenance(
    { value: survivor.gender === 'unknown' ? null : survivor.gender, setBy: survivor.gender_set_by, rank: survivorGenderRank },
    { value: loser.gender === 'unknown' ? null : loser.gender, setBy: loser.gender_set_by, rank: loserGenderRank },
  );
  // The authority that stands behind the SURVIVING value — read off whichever
  // side(s) actually hold that value, so a confirmation follows the gender it
  // confirmed instead of being inherited by the one that won.
  const genderRankKept = Math.max(
    gender.value && gender.value === survivor.gender ? survivorGenderRank : 0,
    gender.value && gender.value === loser.gender    ? loserGenderRank    : 0,
  );

  // engagement_rank: a non-default (≠2) value carries real signal; when both do
  // and they disagree the LOWER wins — rank 0 is a "don't socialize with me"
  // opt-out and a merge must never silently overturn it.
  const rankS = typeof survivor.engagement_rank === 'number' ? survivor.engagement_rank : 2;
  const rankL = typeof loser.engagement_rank === 'number' ? loser.engagement_rank : 2;
  const engagementRank = rankS === rankL ? rankS
    : rankS === 2 ? rankL
    : rankL === 2 ? rankS
    : Math.min(rankS, rankL);

  // Outbound language follows the FRESHER inbound stamp, not the survivor.
  const survivorLangFresher = tsKey(survivor.last_inbound_lang_at) >= tsKey(loser.last_inbound_lang_at);
  const lastInboundLang = (survivor.last_inbound_lang && survivorLangFresher)
    ? survivor.last_inbound_lang
    : (loser.last_inbound_lang ?? survivor.last_inbound_lang ?? null);

  const merged = {
    person_id:            survivorId,
    slack_id:             slackIdMerged,
    email:                survivor.email ?? loser.email ?? null,
    // A slack_id present ⇒ internal by construction; otherwise the stronger of
    // the two claims wins ('internal' means company-domain / known colleague).
    kind:                 slackIdMerged ? 'internal'
                            : (survivor.kind === 'internal' || loser.kind === 'internal') ? 'internal' : 'external',
    org:                  survivor.org ?? loser.org ?? null,
    source:               slackIdMerged ? 'slack' : (survivor.source ?? loser.source ?? null),
    name:                 (survivor.name ?? '').trim() || (loser.name ?? '').trim() || 'Unknown',
    name_he:              nameHe.value,
    name_he_set_by:       nameHe.setBy,
    timezone:             timezone.value,
    timezone_set_by:      timezone.setBy,
    state:                state.value,
    state_set_by:         state.setBy,
    gender:               gender.value ?? 'unknown',
    // Both columns come out of the SAME rank, so a merged row can never again
    // hold a confirmed flag over an auto value (nor lose a legacy confirmation
    // that arrived with no provenance tag — it is re-tagged 'person' here).
    gender_set_by:        gender.setBy ?? (genderRankKept >= SET_BY_RANK.person ? 'person' : null),
    gender_confirmed:     genderRankKept >= SET_BY_RANK.person ? 1 : 0,
    is_vip:               Math.max(survivor.is_vip ?? 0, loser.is_vip ?? 0),
    engagement_rank:      engagementRank,
    proactive_pending:    Math.max(survivor.proactive_pending ?? 0, loser.proactive_pending ?? 0),
    working_hours_auto:   survivor.working_hours_auto ?? loser.working_hours_auto ?? null,
    currently_traveling:  survivor.currently_traveling ?? loser.currently_traveling ?? null,
    notes:                unionDated<PersonNote>(
                            survivor.notes, loser.notes,
                            n => `${n.date ?? ''}|${n.note ?? ''}`, n => n.date ?? '', 50),
    interaction_log:      unionDated<PersonInteraction>(
                            survivor.interaction_log, loser.interaction_log,
                            i => `${i.date ?? ''}|${i.type ?? ''}|${i.summary ?? ''}`, i => i.date ?? '', 200),
    profile_json:         mergeProfileJson(survivor.profile_json, loser.profile_json),
    last_seen:            laterOf(survivor.last_seen, loser.last_seen),
    last_social_at:       laterOf(survivor.last_social_at, loser.last_social_at),
    last_initiated_at:    laterOf(survivor.last_initiated_at, loser.last_initiated_at),
    last_inbound_lang:    lastInboundLang,
    last_inbound_lang_at: laterOf(survivor.last_inbound_lang_at, loser.last_inbound_lang_at),
    created_at:           earlierOf(survivor.created_at, loser.created_at),
  };

  const apply = db.transaction(() => {
    // DELETE first: when the survivor is adopting the loser's slack_id, the
    // UNIQUE index would still see it held by the loser row.
    db.prepare(`DELETE FROM people_memory WHERE person_id = ?`).run(loserId);
    db.prepare(`
      UPDATE people_memory SET
        slack_id = @slack_id, email = @email, kind = @kind, org = @org, source = @source,
        name = @name, name_he = @name_he, name_he_set_by = @name_he_set_by,
        timezone = @timezone, timezone_set_by = @timezone_set_by,
        state = @state, state_set_by = @state_set_by,
        gender = @gender, gender_set_by = @gender_set_by, gender_confirmed = @gender_confirmed,
        is_vip = @is_vip, engagement_rank = @engagement_rank, proactive_pending = @proactive_pending,
        working_hours_auto = @working_hours_auto, currently_traveling = @currently_traveling,
        notes = @notes, interaction_log = @interaction_log, profile_json = @profile_json,
        last_seen = @last_seen, last_social_at = @last_social_at, last_initiated_at = @last_initiated_at,
        last_inbound_lang = @last_inbound_lang, last_inbound_lang_at = @last_inbound_lang_at,
        created_at = @created_at, updated_at = datetime('now')
      WHERE person_id = @person_id
    `).run(merged);
  });

  // Fold the loser's md file into the survivor's FIRST — the row transaction is
  // the commit point of the WHOLE merge, files included. Files and SQLite are
  // separate durability domains, so these two halves can never be one atomic
  // commit; the order is what decides where an interrupted merge leaves residue.
  // Rows-first (the v4.0.4 shape) left the unrecoverable side: process death
  // between the commit and the fold orphaned `<loserId>.md` forever, because the
  // dedupe sweep looks for duplicate ROWS and by then there were none — and the
  // orphan file still renders as a phantom duplicate person in the prompt
  // catalog, i.e. exactly the bug v4.0.4 removed. Md-first inverts it: any
  // failure leaves the pair still duplicated, which the boot sweep already finds
  // and retries, and the fold is idempotent so the retry is free.
  // Lazy require: the md layer owns the file layout and itself reads the DB, so
  // the dependency is resolved at call time in both directions (same pattern as
  // refreshAutoWorkingHours).
  let mdFolded = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mergePersonMdFiles } = require('../memory/peopleMemory') as typeof import('../memory/peopleMemory');
    mdFolded = mergePersonMdFiles(survivorId, loserId, merged.name);
  } catch (err) {
    logger.warn('person store — md-file merge threw', { survivorId, loserId, err: String(err).slice(0, 200) });
  }
  if (!mdFolded) {
    logger.warn('person store — merge deferred: the loser\'s md file is still on disk', { survivorId, loserId });
    return false;
  }

  try {
    apply.immediate();
  } catch (err) {
    logger.error('person store — merge failed, both rows left intact', { survivorId, loserId, err: String(err).slice(0, 300) });
    return false;
  }

  logger.warn('person store — merged two rows for one person', {
    survivorId, loserId, email: merged.email, slackId: merged.slack_id, name: merged.name,
  });

  return true;
}

/**
 * v4.0.4 — THE writer for `people_memory.email`. Never `UPDATE … SET email`
 * anywhere else: the address is the logical identity key, so if ANOTHER row
 * already holds it the two rows are the same human and must be MERGED, not left
 * as a duplicate pair.
 *
 * Fill-only by default (an existing address stays). `overwrite: true` is for the
 * Slack path, where users.info is authoritative and an address CHANGE should
 * propagate.
 *
 * Returns the person_id that owns the address afterwards (may differ from the
 * argument when a merge picked the other row as survivor), or null when the
 * write was refused — two distinct Slack identities claiming one address, where
 * the existing holder keeps it.
 */
export function setPersonEmail(personId: string, email: string, opts?: { overwrite?: boolean }): string | null {
  const e = (email ?? '').trim().toLowerCase();
  if (!personId || !e) return null;
  const db = getDb();
  const row = getPersonById(personId);
  if (!row) return null;

  const current = (row.email ?? '').trim().toLowerCase();
  if (current === e) return personId;
  if (current && !opts?.overwrite) return personId;

  const holder = getPersonByEmail(e);
  if (holder && holder.person_id !== personId) {
    // Same address ⇒ same human. Collapse; the slack_id-bearing row survives
    // (getPersonByEmail's canonical "Slack wins" order).
    const survivorId = row.slack_id ? personId : (holder.slack_id ? holder.person_id : personId);
    const loserId = survivorId === personId ? holder.person_id : personId;
    if (mergePersonRows(survivorId, loserId)) return survivorId;
    logger.warn('person store — email write refused, address held by another identity', {
      email: e, personId, holder: holder.person_id,
    });
    return null;
  }

  db.prepare(`UPDATE people_memory SET email = ?, updated_at = datetime('now') WHERE person_id = ?`).run(e, personId);
  return personId;
}

export interface ResolvePersonInput {
  slackId?: string | null;
  email?: string | null;
  name?: string | null;
  /** Owner's company domain (e.g. "reflectiz.com") — classifies a fresh
   *  email-only person as internal vs external. */
  ownerDomain?: string;
  /** Force the kind on create (overrides domain inference). `self` is the
   *  assistant's own synthetic row — see upsertPersonMemory. */
  kindHint?: 'internal' | 'external' | 'self';
}

export interface ResolvedPerson {
  person_id: string;
  created: boolean;
  row: PersonMemory;
}

/**
 * v3.2.0 — THE person chokepoint. Find-or-create + merge across
 * {slack_id → email → fuzzy name}, returning a stable person_id. Every caller
 * that has a slack_id / email / name and needs "who is this person" routes
 * through here instead of a bare slack_id lookup — that's what lets a
 * pure-email external (booked once, no Slack) be recognized next time.
 *
 * v4.0.4 — the two handles are looked up UP FRONT instead of in a first-match-
 * wins ladder, which is what makes "one human, two rows" impossible to leave
 * behind:
 *   - both handles match DIFFERENT rows → they are one human split in half
 *     (a calendar-sourced row + a later Slack row); MERGE, Slack row survives.
 *     The pre-4.0.4 ladder returned the slack row and left the pair standing,
 *     documented as "almost never happens" — Luke Joas proved it does, and the
 *     split then read as ambiguity in attendee resolution.
 *   - only one matches → that's the person; the missing handle is attached
 *     (merge-by-attach, Slack wins → promote to internal).
 *   - the address is already held by a row with a DIFFERENT slack_id → two
 *     Slack accounts, one address = two people. slack_id is the stronger
 *     handle, so the holder keeps the address and this caller gets its own row.
 *   - neither matches → unambiguous fuzzy name, else create.
 * Because the slack_id lookup happens first, an attach can no longer collide
 * with the UNIQUE index at all — the old silently-swallowed catch is gone.
 *
 * Returns null only when given no usable handle at all.
 */
export function resolvePerson(input: ResolvePersonInput): ResolvedPerson | null {
  const db = getDb();
  const slackId = (input.slackId ?? '').trim() || undefined;
  const email = (input.email ?? '').trim().toLowerCase() || undefined;
  const name = (input.name ?? '').trim() || undefined;
  if (!slackId && !email && !name) return null;

  const bySlack = slackId ? getPersonMemory(slackId) : null;
  const byEmail = email ? getPersonByEmail(email) : null;

  const emailHeldByOther = !!(byEmail && slackId && byEmail.slack_id && byEmail.slack_id !== slackId);
  if (emailHeldByOther) {
    logger.warn('person store — address held by a different slack identity; keeping them separate', {
      email, slackId, holder: byEmail!.person_id, holderSlackId: byEmail!.slack_id,
    });
  }
  const usableEmail = emailHeldByOther ? undefined : email;
  const emailRow = emailHeldByOther ? null : byEmail;

  // 1. One human on two rows → collapse (Slack row survives).
  if (bySlack && emailRow && bySlack.person_id !== emailRow.person_id) {
    mergePersonRows(bySlack.person_id, emailRow.person_id);
  }

  // 2. Target = the strongest handle that matched, else an unambiguous name.
  let targetId = bySlack?.person_id ?? emailRow?.person_id;
  if (!targetId && name) {
    const matches = searchPeopleMemory(name);
    const exact = matches.filter(m => m.name.toLowerCase() === name.toLowerCase());
    const pick = exact.length === 1 ? exact[0] : (matches.length === 1 ? matches[0] : null);
    // A name is never strong enough to hand back a row that already belongs to
    // a DIFFERENT Slack identity.
    if (pick && !(slackId && pick.slack_id && pick.slack_id !== slackId)) targetId = pick.person_id;
  }

  // 3. Enrich the matched row with whatever handle it doesn't have yet.
  if (targetId) {
    if (slackId && !getPersonById(targetId)?.slack_id) {
      // bySlack was empty ⇒ no row owns this slack_id ⇒ the UNIQUE index on
      // slack_id cannot fire. Promote to internal (Slack wins); never re-kind
      // the assistant's own SELF row.
      db.prepare(`
        UPDATE people_memory
           SET slack_id = ?, source = 'slack', updated_at = datetime('now'),
               kind = CASE WHEN kind = 'self' THEN kind ELSE 'internal' END
         WHERE person_id = ?
      `).run(slackId, targetId);
    }
    if (usableEmail) targetId = setPersonEmail(targetId, usableEmail) ?? targetId;
    const row = getPersonById(targetId);
    return row ? { person_id: row.person_id, created: false, row } : null;
  }

  // 4. create — requires at least one handle.
  const personId = slackId ? `p_${slackId.replace(/[^A-Za-z0-9]/g, '_')}` : newPersonId();
  const ownerDomain = (input.ownerDomain ?? '').trim().toLowerCase();
  const kind: 'internal' | 'external' | 'self' =
    input.kindHint
    ?? (slackId ? 'internal'
      : (usableEmail && ownerDomain && usableEmail.endsWith('@' + ownerDomain)) ? 'internal'
      : 'external');
  const source = slackId ? 'slack' : (usableEmail ? 'calendar' : 'manual');
  const displayName = name ?? (usableEmail ? usableEmail.split('@')[0] : (slackId ?? 'Unknown'));
  try {
    db.prepare(`
      INSERT INTO people_memory (person_id, slack_id, email, kind, source, name, gender, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, 'unknown', datetime('now'))
    `).run(personId, slackId ?? null, usableEmail ?? null, kind, source, displayName);
  } catch {
    // Lost a race / unique collision — re-resolve by the strongest handle.
    const again = slackId ? getPersonMemory(slackId) : (usableEmail ? getPersonByEmail(usableEmail) : null);
    if (again) return { person_id: again.person_id, created: false, row: again };
    return null;
  }
  const row = getPersonById(personId);
  if (!row) return null;
  return { person_id: personId, created: true, row };
}

/**
 * v4.2.x — the outcome of `setPersonTimezoneByEmail`: every `CoreFieldWrite`
 * value, plus two pre-flight rejections that never reach the provenance
 * chokepoint at all.
 */
export type SetPersonTimezoneOutcome = CoreFieldWrite | 'invalid_email' | 'invalid_timezone';

/**
 * v4.2.x — persist a LEARNED timezone for a person identified by EMAIL, with
 * no dependency on a slack_id. Built for #24 row 129b (James Avery/Kevel): a
 * brand-new external has no people_memory row, so `attendeeAvailability`'s
 * owner-zone fallback (utils/attendeeAvailability.ts) was the ONLY possible
 * outcome for every external Maelle has never met — a fallback isn't a safety
 * net when it's the sole path. This is the persistence half of that fix: give
 * a caller that has already extracted/resolved a zone (an owner's forwarding
 * note, or the chain itself stating "ET") somewhere to put it, so the NEXT
 * slot search reads the real zone instead of the fallback.
 *
 * NOT this function's job: turning prose into an IANA zone. `locationTz.ts`
 * already does that (`inferTimezoneFromStateStatic` / `inferTimezoneFromState`
 * — its static map already resolves 'et' → 'America/New_York'); callers
 * should resolve free text FIRST and pass the resolved IANA zone here. This
 * function also does not classify WHICH authority tier a signal deserves
 * (owner's own note vs. the chain's own text vs. nothing) — that judgment is
 * the caller's (`by` is required, never defaulted).
 *
 * Resolves through `resolvePerson` (the identity chokepoint) — find-or-create
 * by email, so a repeated external accumulates ONE row (P2), never a
 * duplicate. Writes through `setCoreFieldWithProvenanceById` (owner > person >
 * auto — P4/#46), so a caller passing `by:'auto'` (inferred from chain prose)
 * can never clobber a stronger stored value, while `by:'owner'` (the owner
 * said so in his forwarding note) always wins. Also refreshes
 * `working_hours_auto` off whichever zone actually landed (the write above may
 * have been refused as lower-authority) via `refreshAutoWorkingHoursById`, so
 * `attendeeAvailability` has a default working window to clip against
 * immediately — a fresh external otherwise has a timezone but no working-hours
 * read at all, which drops them from the clip entirely instead of using a sane
 * default for their zone.
 *
 * Rejects a non-strict-IANA `timezone` (same guard as `update_person_profile`
 * — luxon resolves ambiguous abbreviations like "IST" to Asia/Kolkata) so a
 * raw "ET"/"PST"-shaped string can never land on the row.
 *
 * Never throws — a bad extraction must never take down the caller.
 *
 * @returns `outcome` — 'applied' | 'already_set' | 'refused_lower_authority' |
 *          'no_value' | 'no_person' (the `CoreFieldWrite` outcomes —
 *          'no_person' is not expected in practice here since `resolvePerson`
 *          creates the row) plus 'invalid_email' (empty / no '@') and
 *          'invalid_timezone' (non-strict-IANA shape), both pre-flight
 *          rejections that never touch the store. `personId` is the
 *          resolved/created person_id, or null when nothing was resolved.
 */
export function setPersonTimezoneByEmail(
  email: string,
  timezone: string,
  by: CoreFieldSetBy,
  opts?: { name?: string; ownerDomain?: string },
): { outcome: SetPersonTimezoneOutcome; personId: string | null } {
  const e = (email ?? '').trim().toLowerCase();
  if (!e || !e.includes('@')) {
    logger.warn('setPersonTimezoneByEmail — invalid email, nothing resolved', { email });
    return { outcome: 'invalid_email', personId: null };
  }

  const tz = (timezone ?? '').trim();
  if (!tz) return { outcome: 'no_value', personId: null };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isStrictIana } = require('../utils/timezoneValidator') as typeof import('../utils/timezoneValidator');
  if (!isStrictIana(tz)) {
    logger.warn('setPersonTimezoneByEmail — rejected non-IANA timezone', { email: e, attempted: tz, by });
    return { outcome: 'invalid_timezone', personId: null };
  }

  const resolved = resolvePerson({ email: e, name: opts?.name, ownerDomain: opts?.ownerDomain });
  if (!resolved) return { outcome: 'no_person', personId: null };
  const personId = resolved.person_id;

  const outcome = setCoreFieldWithProvenanceById(personId, 'timezone', tz, by);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { refreshAutoWorkingHoursById } = require('../utils/workingHoursDefault') as
      typeof import('../utils/workingHoursDefault');
    refreshAutoWorkingHoursById(personId);
  } catch (err) {
    logger.warn('setPersonTimezoneByEmail — working-hours refresh threw', {
      personId, err: String(err).slice(0, 200),
    });
  }

  logger.info('setPersonTimezoneByEmail', { email: e, personId, timezone: tz, by, outcome });
  return { outcome, personId };
}

/**
 * v2.8.6 — render the "people Maelle is interacting with right now" data
 * block for the dynamic prompt section. Used by the colleague-path system
 * prompt so Sonnet sees email / tz / gender as DATA (no rules, no "never
 * ask"), and stops defensively asking the colleague for facts already on
 * file. Pre-fix, the handler-side auto-fill at meetings/ops.ts:1175 covered
 * the WRITE side (filling missing emails from people_memory at create_meeting
 * time) but Sonnet's draft sometimes asked anyway because the prompt didn't
 * surface known data — root of the 2026-05-18 Maayan ask.
 *
 * Scope: speakers Maelle can see THIS turn. The speaking colleague + any
 * other MPIM members (when in MPIM). Owner excluded. The speaking colleague
 * themselves IS included — Maelle may book FOR them, so their email/tz
 * matter even though they typed the request.
 *
 * Missing fields render as "unknown" so Sonnet knows to ask when needed.
 * Returns '' when nothing to surface (e.g. owner DM, all unknown lookups).
 */
export function formatThreadPeopleBlock(
  speakerSlackId: string | undefined,
  otherMemberIds: string[] | undefined,
  ownerSlackId: string,
): string {
  const ids = new Set<string>();
  if (speakerSlackId && speakerSlackId !== ownerSlackId) ids.add(speakerSlackId);
  if (otherMemberIds) {
    for (const id of otherMemberIds) {
      if (id && id !== ownerSlackId) ids.add(id);
    }
  }
  if (ids.size === 0) return '';

  const lines: string[] = [];
  for (const id of ids) {
    const p = getPersonMemory(id);
    if (!p) {
      lines.push(`- ${id}: email=unknown, tz=unknown, gender=unknown`);
      continue;
    }
    const email = p.email || 'unknown';
    // v3.1.2 — mirror the formatPeopleMemoryForPrompt guard. When state/city
    // is on file, that's the location for discussion. When it's NOT, mark the
    // tz explicitly so Sonnet doesn't infer a city from the IANA tag (the
    // "Asia/Jerusalem → Jerusalem" leak class). A timezone is reliable for
    // time math; it is NOT where the person is.
    const tzUnconfirmed = p.timezone && p.timezone_set_by === 'auto'
      ? ' [unconfirmed guess — confirm before presenting their local time]'
      : '';
    const tz = p.timezone
      ? (p.state
          ? `${p.timezone} (${p.state})${tzUnconfirmed}`
          : `${p.timezone} (city not on file — TZ is reliable for time math; only ask for city when location/venue matters)${tzUnconfirmed}`)
      : 'unknown';
    // v3.5.x — an `auto` gender (image/legacy name-guess) is NOT authoritative:
    // surface it as unknown so it can't drive gendered Hebrew forms (the Daniel
    // mis-gender). Only a person/owner-confirmed gender steers. Mirrors the tz
    // unconfirmed-guess gate above.
    const gender = p.gender && p.gender !== 'unknown' && p.gender_set_by !== 'auto' ? p.gender : 'unknown';
    lines.push(`- ${p.name}: email=${email}, tz=${tz}, gender=${gender}`);
  }
  if (lines.length === 0) return '';
  return `PEOPLE IN THIS THREAD — data Maelle has on file. Use it when booking; don't ask for fields shown here. Fields marked "unknown" need to be asked the FIRST time they become relevant (and ONLY when relevant — gender isn't a booking gate).
${lines.join('\n')}`;
}

/**
 * Format recent contacts as a compact block for injection into the system prompt.
 * Excludes the owner themselves. Shows ALL known notes per person — each note is
 * short, and the richness of context is worth the tokens.
 */
/**
 * Format workspace contacts for the system prompt.
 *
 * @param ownerSlackId  — owner's Slack id; their own row and Maelle's SELF row are excluded
 * @param focusSlackIds — (v1.6.14) contacts whose FULL interaction history should load
 *                         (other people in the current chat — MPIM members etc). Everyone
 *                         else gets a short 10-entry tail. Undefined → everyone's short.
 */
export function formatPeopleMemoryForPrompt(
  ownerSlackId: string,
  focusSlackIds?: Set<string>,
  // v2.2.3 (#3) — when persona skill is OFF, render a slim contact line:
  // identity + tz + state + email + gender, no social fields, no notes,
  // no interaction log. Defaults to true so legacy callers preserve current
  // verbose behavior.
  includeSocial: boolean = true,
): string {
  const db = getDb();
  // Exclude the owner AND Maelle's own synthetic SELF:<owner> row (her row is
  // rendered separately as the ABOUT YOU block — see core/assistantSelf.ts).
  //
  // Exclusion is by `kind` / an explicit NULL-safe comparison, NEVER by a bare
  // `slack_id != ?`: an external person's slack_id is NULL, and `NULL != 'U…'`
  // evaluates to NULL (falsy) in SQL, so the old predicate silently dropped
  // EVERY external from the owner's contact block — 19 people the owner had
  // actually booked showed no email, no timezone, no "N notes on file", so
  // Maelle re-asked for addresses she already stores. Same NULL trap
  // searchPeopleMemory documents and guards 500 lines above.
  const people = db.prepare(`
    SELECT * FROM people_memory
    WHERE kind != 'self'
    AND (slack_id IS NULL OR slack_id != ?)
    AND last_seen >= datetime('now', '-90 days')
    ORDER BY last_seen DESC
    LIMIT 25
  `).all(ownerSlackId) as PersonMemory[];

  if (people.length === 0) return '';

  const today = new Date().toISOString().split('T')[0];
  const lines = people.map(p => {
    const notes: PersonNote[] = JSON.parse(p.notes || '[]');
    const profile: PersonProfile = (() => {
      try { return JSON.parse(p.profile_json || '{}'); } catch { return {}; }
    })();

    const stateTag = p.state ? `, state: ${p.state}` : '';

    // v2.2.4 (bug 5) — surface active travel windows in the contact line so
    // Sonnet sees "currently in Boston until 22 Jun" right next to the
    // default state/timezone. Stored profile is the default; travel is the
    // override for the window. Reader auto-clears past trips, so anything
    // that lands here is current.
    let travelTag = '';
    if (p.currently_traveling) {
      try {
        const t = JSON.parse(p.currently_traveling) as { location: string; from: string; until: string };
        if (t.location && t.until && t.until >= today) {
          travelTag = `, currently in ${t.location} until ${t.until}`;
        }
      } catch (_) { /* fail silent — travel field stays unrendered */ }
    }

    // v2.2.3 (#3) — social fields (last_social_at, topics) only rendered when
    // persona skill is on. Off mode = pure operational identity line.
    const socialLine = includeSocial
      ? (p.last_social_at
          ? `last social: ${p.last_social_at.split('T')[0]}${p.last_social_at.startsWith(today) ? ' (today)' : ''}`
          : 'no social exchange yet')
      : '';
    const socialPart = includeSocial ? `, ${socialLine}` : '';

    // v2.6.5 — when state is missing but timezone is set, mark the tz line
    // explicitly so Sonnet doesn't infer a city from the IANA string.
    // Pre-fix, `tz: Australia/Brisbane` (with no state) led Sonnet to write
    // "you're in Brisbane" — but Brisbane is just the IANA tz tag; the
    // person could be anywhere in AEST. Adding "(timezone only, city
    // unknown)" inline in the prompt data keeps the constraint visible
    // without needing a separate prompt rule.
    // v3.5.x — when a timezone is an UNCONFIRMED auto guess, mark it so Maelle
    // confirms before presenting the person's local time (the Gidon bug: stored
    // auto Amsterdam, he's in Israel → times shown in Amsterdam silently).
    // Owner/person-set timezones steer silently — no marker.
    const tzUnconfirmed = p.timezone && p.timezone_set_by === 'auto'
      ? ' [unconfirmed guess — confirm before presenting their local time]'
      : '';
    const tzPart = p.timezone
      ? `, tz: ${p.timezone}${!p.state ? ' (city not on file — TZ is reliable for time math; only ask for city when location/venue matters)' : ''}${tzUnconfirmed}`
      : '';

    // v3.3.x / v3.5.x — surface the OUTBOUND language on the owner-path contact
    // line: the language to write in when Maelle INITIATES a message TO this
    // person (outreach / coord / reminder). v3.5.x DERIVES it from their most
    // recent inbound message (default English) instead of a frozen one-off
    // preference, so an English-writing colleague never gets a Hebrew DM. The
    // outbound-language prompt rule consumes this `language_pref` value.
    // v4.4.x (#170) — resolveOutboundLanguageForPerson now returns null for
    // "nothing known" instead of a bare 'en' indistinguishable from a real
    // signal. Render that state explicitly (mirrors the tzUnconfirmed /
    // auto-gender markers above) so Sonnet treats it as a default to speak
    // in, not a confirmed fact about how this person writes.
    const outboundLang = resolveOutboundLanguageForPerson(p);
    const langPart = outboundLang
      ? `, language_pref: ${outboundLang}`
      : `, language_pref: unknown — no inbound message or stored preference yet; default to English but don't present it as their known language`;
    // v3.5.x — only a confirmed (person/owner) gender is authoritative; an `auto`
    // guess renders 'unknown' so it can't steer gendered Hebrew forms.
    const genderField = p.gender && p.gender !== 'unknown' && p.gender_set_by !== 'auto' ? p.gender : 'unknown';
    // Externals have no Slack account, so there is no slack_id to hand back —
    // rendering the column raw printed "slack_id: null" and invited the model to
    // pass that string to a tool. Their handle is the email.
    const handle = p.slack_id
      ? `slack_id: ${p.slack_id}`
      : 'external — no Slack account, reach them by email';
    const parts: string[] = [
      `${p.name} (${handle}${p.name_he ? `, name_he: ${p.name_he}` : ''}${stateTag}${travelTag}${tzPart}${p.email ? `, email: ${p.email}` : ''}, gender: ${genderField}${langPart}${socialPart})`,
    ];

    // Profile dimensions moved to per-person markdown files (v2.2.1). Fields
    // still persisted for code paths that read them deterministically.
    void profile;

    // v2.3.4 kept booking snapshots out because a moved meeting made them lie;
    // readInteractionLog replaces that blanket strip with a freshness rule so
    // "we booked yesterday" is recallable (P6) while stale snapshots still are
    // not. See BOOKING_SNAPSHOT_FRAME.
    const { relational: relationalLog, recentBookings } = readInteractionLog(p.interaction_log);

    const isFocus = p.slack_id ? (focusSlackIds?.has(p.slack_id) ?? false) : false;
    if (isFocus) {
      // FULL render — person is in the CURRENT chat (MPIM member / explicit
      // focus). Worth the tokens: Maelle is actively talking with them now.
      // Personal/relationship notes only when persona is on (hobbies, life
      // events, relationship bits). Last 30 interactions (10 when social off).
      if (includeSocial) {
        for (const n of notes) parts.push(`  ★ [${n.date}] ${n.note}`);
      }
      const entryCap = includeSocial ? 30 : 10;
      for (const i of relationalLog.slice(-entryCap)) {
        parts.push(`  ↳ [${i.date.split('T')[0]}] ${i.type}: ${i.summary}`);
      }
      if (recentBookings.length > 0) {
        parts.push(`  recent bookings with them (${BOOKING_SNAPSHOT_FRAME}):`);
        for (const i of recentBookings.slice(-5)) {
          parts.push(`    📅 [${i.date.split('T')[0]}] ${i.summary}`);
        }
      }
    } else {
      // COMPACT roster line — v3.x (Block 1 prompt reduction). Was: every one
      // of the (up to 25) contacts dumped ALL ★ notes + a 10-entry ↳ tail,
      // fresh on every owner turn (~6k tokens, billed full-rate, uncached).
      // The note + interaction BODIES live in the DB and load on demand via
      // get_person_memory (extended in v3.x to return them alongside the
      // markdown file). We surface only the COUNTS so Sonnet knows there's
      // history worth pulling for this specific person.
      const noteCount = includeSocial ? notes.length : 0;
      const intCount = relationalLog.length;
      const bits: string[] = [];
      if (noteCount > 0) bits.push(`${noteCount} note${noteCount === 1 ? '' : 's'}`);
      if (intCount > 0) bits.push(`${intCount} past exchange${intCount === 1 ? '' : 's'}`);
      if (recentBookings.length > 0) {
        bits.push(`${recentBookings.length} booking${recentBookings.length === 1 ? '' : 's'} in the last ${BOOKING_RECALL_DAYS} days`);
      }
      if (bits.length > 0) {
        parts.push(`  (${bits.join(', ')} on file — get_person_memory("${p.name}") to load)`);
      }
    }

    return parts.join('\n');
  });

  return `WORKSPACE CONTACTS (people you have interacted with — colleagues carry a slack_id you can use directly, no need to call find_slack_user; externals carry an email instead and have no Slack account, so never call find_slack_user for them). Each line shows what you know at a glance; where a line ends with "N notes / past exchanges on file", that person's relationship history and conversation notes load on demand via get_person_memory — pull it when they're relevant to the turn:\n${lines.join('\n')}`;
}

// ── Social context block (per-sender) ────────────────────────────────────────
// v1.7.4 — moved here from orchestrator/index.ts. It's a pure formatter for
// people_memory data, sibling to formatPeopleMemoryForPrompt above. Lives at
// the data layer so a future togglable persona skill (issue #3) can call it
// conditionally without the orchestrator having to know.

// Owner-side topic management lives in the Social Engine
// (`src/core/social/` + `src/db/socialSubjects.ts`). The colleague context
// block below surfaces profile + notes + interactions without any
// stale/cooldown machinery.

/** Timeline entries that belong to the SOCIAL layer, not the work layer. */
const SOCIAL_INTERACTION_TYPES = new Set(['social_chat', 'social_ping']);

/**
 * WORK context about the colleague Maelle is talking to — who they are on the
 * org chart, how they work, what she and they last did together.
 *
 * Split out of buildSocialContextBlock (which was gated entirely on the optional
 * `skills.social` toggle) because none of this is social: role, reports_to,
 * response speed, collaboration notes and the recent work exchanges are what
 * make her COMPETENT with this person, and P6 forbids gating work-competence
 * behind the social budget. A tenant that runs Maelle task-only used to lose all
 * of it as collateral. This block is unconditional on a colleague turn; the
 * social half below is what the toggle governs.
 *
 * Scope note (P9): this is built for the AUTHENTICATED speaker, about
 * themselves — tier 2, they may read everything about themselves. It is never
 * built for a third party. `sharedSurface` says the answer will be read by more
 * than that one person (MPIM / channel), and the booking tail is withheld there:
 * a meeting's subject, venue and time is the speaker's own business, and the
 * others in the room may not be on it. Withholding is the default when a
 * reader's entitlement is unclear.
 *
 * Returns '' for unknown people or when nothing is on file.
 */
export function buildPersonWorkContextBlock(
  slackId: string,
  opts?: { sharedSurface?: boolean },
): string {
  const person = getPersonMemory(slackId);
  if (!person) return '';

  const profile: PersonProfile = (() => {
    try { return JSON.parse(person.profile_json || '{}'); } catch { return {}; }
  })();

  const lines: string[] = [];

  const profileParts: string[] = [];
  if (profile.communication_style)  profileParts.push(`style: ${profile.communication_style}`);
  // v3.3.x — language_preference deliberately NOT rendered here. This is the
  // COLLEAGUE-path (inbound) context: when the person writes to Maelle, the
  // reply must mirror THEIR current message, never a stored pref (the Ayala
  // "English in, Hebrew out" bug). The stored preference is for the OUTREACH
  // path (when Maelle INITIATES) — surfaced on the owner-path contact line
  // instead. Inbound language is governed by detectMessageLanguage's per-turn
  // directive + the CURRENT-TURN-WINS rule.
  // #135 — working_hours (free-text) deliberately NOT rendered here. It's a
  // SCHEDULING fact, and the LLM was repeating it as authority (the Isaac "works
  // Mon/Thu only" bug — the free-text contradicted his real free/busy + structured
  // workdays). Availability is owned by find_available_slots / attendeeAvailability
  // (structured workdays + Graph free/busy), never this relational blob — same
  // reasoning as language_preference above.
  if (profile.response_speed)       profileParts.push(`responds: ${profile.response_speed}`);
  if (profile.role_summary)         profileParts.push(`role: ${profile.role_summary}`);
  if (profile.reports_to)           profileParts.push(`reports to: ${profile.reports_to}`);
  if (profile.collaboration_notes)  profileParts.push(`collab: ${profile.collaboration_notes}`);
  if (profileParts.length > 0) lines.push(`Profile: ${profileParts.join(' | ')}`);

  const { relational, recentBookings } = readInteractionLog(person.interaction_log);
  const workExchanges = relational.filter(i => !SOCIAL_INTERACTION_TYPES.has(i.type)).slice(-10);
  if (workExchanges.length > 0) {
    lines.push(`Recent work exchanges:\n${workExchanges.map(i => `  [${i.date.split('T')[0]}] ${i.summary}`).join('\n')}`);
  }
  if (recentBookings.length > 0 && !opts?.sharedSurface) {
    lines.push(`Recent bookings with them (${BOOKING_SNAPSHOT_FRAME}):\n${recentBookings.slice(-5).map(i => `  [${i.date.split('T')[0]}] ${i.summary}`).join('\n')}`);
  }

  if (lines.length === 0) return '';
  return [`WHAT YOU KNOW ABOUT ${person.name} (work context)`, ...lines].join('\n');
}

/**
 * The SOCIAL half of the per-person block, injected on COLLEAGUE turns only when
 * `skills.social` is on (owner turns use the Social Engine directive instead).
 * Engagement rank, the initiation cadence gate, and personal notes — the parts
 * that genuinely belong to the optional friend-of-the-team layer.
 *
 * Work competence (role, reports_to, response speed, collaboration, recent work
 * exchanges and bookings) is NOT here — see buildPersonWorkContextBlock, which
 * runs whether or not social is on. Returns '' for unknown people.
 *
 * v4.4.x (#170) — person_id-keyed worker (works for externals too).
 */
export function buildSocialContextBlockById(personId: string, timezone: string, assistantName: string = 'Assistant'): string {
  const person = getPersonById(personId);
  if (!person) return '';

  const now              = DateTime.now().setZone(timezone);
  const lastInitiatedAt  = person.last_initiated_at ? DateTime.fromISO(person.last_initiated_at) : null;
  const hoursAgoInit     = lastInitiatedAt ? now.diff(lastInitiatedAt, 'hours').hours : Infinity;
  const canMaelleInitiate = hoursAgoInit >= 24;

  const notes: PersonNote[] = (() => {
    try { return JSON.parse(person.notes || '[]'); } catch { return []; }
  })();

  const lines: string[] = [`SOCIAL CONTEXT — ${person.name}`];

  // v2.2 — numeric engagement rank 0..3. Replaces the legacy string enum.
  // Auto-adjusts based on ping response signal (engagementRank.ts).
  const rank = (person as any).engagement_rank as number | undefined;
  const rankValue = typeof rank === 'number' ? rank : 2;
  if (rankValue === 0) {
    lines.push(`Engagement rank: 0 — this person has signalled they don't want social exchanges with you. Do NOT initiate social chat. Stay strictly professional. If THEY bring something personal up, respond warmly and briefly — don't milk it.`);
    return lines.join('\n');
  }
  if (rankValue === 1) {
    lines.push(`Engagement rank: 1/3 — minimal. They reply when pinged but don't lean in. Keep social moments very light and short; don't push.`);
  } else if (rankValue === 2) {
    lines.push(`Engagement rank: 2/3 — open / neutral. Normal social cadence works.`);
  } else if (rankValue === 3) {
    lines.push(`Engagement rank: 3/3 — loves to chat. Be warm and reciprocate their energy; they'll carry the conversation.`);
  }

  if (canMaelleInitiate) {
    const ago = lastInitiatedAt
      ? (hoursAgoInit >= 48 ? `${Math.round(hoursAgoInit / 24)} days ago` : 'yesterday')
      : 'never';
    lines.push(`${assistantName}-initiated check-in: DUE (you last started one ${ago})`);
  } else {
    const h = Math.round(24 - hoursAgoInit);
    lines.push(`${assistantName}-initiated check-in: NOT due — you already started one recently (${h}h until next). If THEY bring up personal topics, respond freely — just don't YOU start it.`);
  }

  const { relational } = readInteractionLog(person.interaction_log);
  const socialMoments = relational.filter(i => SOCIAL_INTERACTION_TYPES.has(i.type)).slice(-10);
  if (socialMoments.length > 0) {
    lines.push(`Recent social moments:\n${socialMoments.map(i => `  [${i.date.split('T')[0]}] ${i.summary}`).join('\n')}`);
  }

  // Personal/relationship notes
  const recentNotes = notes.slice(-8);
  if (recentNotes.length > 0) {
    lines.push(`Personal notes:\n${recentNotes.map(n => `  [${n.date}] ${n.note}`).join('\n')}`);
  } else {
    lines.push(`Personal notes: none yet — good opportunity to learn something`);
  }

  if (canMaelleInitiate) {
    lines.push(`→ Find ONE natural moment to check in after the work is done. One short human question, not pushy. Engagement-level avoidant → DO NOT initiate; engagement-level minimal → keep it very light.`);
  } else {
    lines.push(`→ If they bring up something personal, respond warmly. Do NOT start a social topic yourself on this turn — you already initiated recently.`);
  }

  return lines.join('\n');
}

/** Slack-keyed convenience — resolves to the surrogate id, then delegates. */
export function buildSocialContextBlock(slackId: string, timezone: string, assistantName: string = 'Assistant'): string {
  const pid = personIdForSlackId(slackId);
  return pid ? buildSocialContextBlockById(pid, timezone, assistantName) : '';
}
