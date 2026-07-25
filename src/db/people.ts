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

export function setCurrentTravel(slackId: string, travel: CurrentTravel): void {
  const db = getDb();
  db.prepare(
    `UPDATE people_memory SET currently_traveling = ?, updated_at = datetime('now') WHERE slack_id = ?`
  ).run(JSON.stringify(travel), slackId);
}

export function clearCurrentTravel(slackId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE people_memory SET currently_traveling = NULL, updated_at = datetime('now') WHERE slack_id = ?`
  ).run(slackId);
}

/**
 * Returns the active travel record for the person, or null if none / expired.
 * Lazy cleanup: when the window is in the past, this returns null AND clears
 * the column so the next reader sees a clean slate.
 */
export function getCurrentTravel(slackId: string): CurrentTravel | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT currently_traveling FROM people_memory WHERE slack_id = ?`
  ).get(slackId) as { currently_traveling?: string | null } | undefined;
  if (!row || !row.currently_traveling) return null;
  try {
    const t = JSON.parse(row.currently_traveling) as CurrentTravel;
    if (!t.location || !t.from || !t.until) return null;
    const today = new Date().toISOString().slice(0, 10);
    // Past trip → auto-clear and treat as not active.
    if (t.until < today) {
      clearCurrentTravel(slackId);
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
export function getTravelRecord(slackId: string): CurrentTravel | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT currently_traveling FROM people_memory WHERE slack_id = ?`
  ).get(slackId) as { currently_traveling?: string | null } | undefined;
  if (!row || !row.currently_traveling) return null;
  try {
    const t = JSON.parse(row.currently_traveling) as CurrentTravel;
    if (!t.location || !t.from || !t.until) return null;
    const today = new Date().toISOString().slice(0, 10);
    if (t.until < today) {
      clearCurrentTravel(slackId);
      return null;
    }
    return t;
  } catch (_) {
    return null;
  }
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
 * v2.2.2 (#46) — single choke-point for writing core attendee fields with
 * provenance enforcement. Returns true when the write happened.
 *
 *   field: 'gender' | 'timezone' | 'state'
 *   by:    'owner' | 'person' | 'auto'
 *
 * Authority: owner overrides anyone; person overrides only auto; auto cannot
 * overwrite anything already set by owner or person. Empty/null current values
 * are always overwritten.
 */
export function setCoreFieldWithProvenance(
  slackId: string,
  field: 'gender' | 'timezone' | 'state',
  value: string,
  by: CoreFieldSetBy,
): boolean {
  const pid = personIdForSlackId(slackId);
  return pid ? setCoreFieldWithProvenanceById(pid, field, value, by) : false;
}

/** v3.2.0 — person_id-keyed worker (works for externals too). */
export function setCoreFieldWithProvenanceById(
  personId: string,
  field: 'gender' | 'timezone' | 'state',
  value: string,
  by: CoreFieldSetBy,
): boolean {
  if (!value || !value.trim()) return false;
  const db = getDb();
  const setByCol = `${field}_set_by` as const;
  const row = db.prepare(`SELECT ${field} as value, ${setByCol} as setBy FROM people_memory WHERE person_id = ?`).get(personId) as
    | { value: string | null; setBy: CoreFieldSetBy | null }
    | undefined;

  // No row yet — caller must create first; we no-op rather than create.
  if (!row) return false;

  const currentSetBy = row.setBy ?? null;
  const currentValue = (row.value ?? '').toString();
  const newRank = SET_BY_RANK[by];
  const currentRank = currentSetBy ? SET_BY_RANK[currentSetBy] : 0;

  // Block lower-rank overwrite of an existing value.
  if (currentValue && currentSetBy && newRank < currentRank) return false;
  // Same rank, same value — no-op (avoid touching updated_at).
  if (currentValue === value.trim() && currentSetBy === by) return false;

  db.prepare(
    `UPDATE people_memory SET ${field} = ?, ${setByCol} = ?, updated_at = datetime('now') WHERE person_id = ?`,
  ).run(value.trim(), by, personId);

  // Side effect: setting gender via this path also flips gender_confirmed for
  // back-compat readers (gender_confirmed=1 means owner OR person, not auto).
  if (field === 'gender' && by !== 'auto') {
    db.prepare(`UPDATE people_memory SET gender_confirmed = 1 WHERE person_id = ?`).run(personId);
  }

  return true;
}

/** v3.2.0 — resolve a slack_id to its surrogate person_id (null if no row). */
export function personIdForSlackId(slackId: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT person_id FROM people_memory WHERE slack_id = ?').get(slackId) as
    | { person_id: string } | undefined;
  return row?.person_id ?? null;
}

/**
 * Set or update the native-script spelling of a contact's name.
 *
 * v3.5.x — provenance-aware (owner > person > auto), matching the core-field
 * authority chain. An owner correction ("עידן not אידן") sticks; an auto guess
 * (capture pass / first-time transliteration) can't overwrite an owner/person
 * value. Defaults to 'auto' so legacy callers behave as before. This is what
 * freezes the spelling: once stored it's reused verbatim, never re-guessed.
 */
export function setPersonNameHe(slackId: string, nameHe: string, by: CoreFieldSetBy = 'auto'): void {
  const pid = personIdForSlackId(slackId);
  if (pid) setPersonNameHeById(pid, nameHe, by);
}

/** v3.2.0 — person_id-keyed worker. v3.5.x — provenance-aware. */
export function setPersonNameHeById(personId: string, nameHe: string, by: CoreFieldSetBy = 'auto'): void {
  if (!nameHe || !nameHe.trim()) return;
  const db = getDb();
  const row = db.prepare(
    `SELECT name_he as value, name_he_set_by as setBy FROM people_memory WHERE person_id = ?`,
  ).get(personId) as { value: string | null; setBy: CoreFieldSetBy | null } | undefined;
  if (!row) return;
  const currentValue = (row.value ?? '').toString();
  const currentRank = row.setBy ? SET_BY_RANK[row.setBy] : 0;
  // Block a lower-rank overwrite of an existing value (auto can't clobber owner).
  if (currentValue && SET_BY_RANK[by] < currentRank) return;
  // Same value + same provenance — no-op (don't churn updated_at).
  if (currentValue === nameHe.trim() && row.setBy === by) return;
  db.prepare(`
    UPDATE people_memory SET name_he = ?, name_he_set_by = ?, updated_at = datetime('now') WHERE person_id = ?
  `).run(nameHe.trim(), by, personId);
}

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
  timezone?: string;
  gender?: PersonGender;
  /**
   * v2.2.2 (#46) — provenance for the timezone write. Defaults to 'auto'
   * (Slack profile / users.info pulls). Owner-path callers pass 'owner' so the
   * value is locked against later auto-overwrite. The write itself rides
   * `setCoreFieldWithProvenanceById` (below) — the authority chain is enforced
   * there, in ONE place, not re-implemented in this statement.
   */
  timezoneSetBy?: CoreFieldSetBy;
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
  // confirmed update must go through confirmPersonGender().
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
    setCoreFieldWithProvenanceById(personId, 'timezone', params.timezone, params.timezoneSetBy ?? 'auto');
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
 * Human-confirmed gender write. Sets gender_confirmed = 1 so that no
 * downstream auto-detector can overwrite it. Call this when the person
 * themselves states their gender (e.g. "אני את - נקבה", "I'm a guy"),
 * or when the owner confirms on their behalf.
 */
export function confirmPersonGender(slackId: string, gender: PersonGender): void {
  const pid = personIdForSlackId(slackId);
  if (pid) confirmPersonGenderById(pid, gender);
}

/** v3.2.0 — person_id-keyed worker. */
export function confirmPersonGenderById(personId: string, gender: PersonGender): void {
  const db = getDb();
  db.prepare(`
    UPDATE people_memory
       SET gender = ?, gender_confirmed = 1, updated_at = datetime('now')
     WHERE person_id = ?
  `).run(gender, personId);
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

/** Stamp the detected inbound language for a person (cheap, called per turn). */
export function setLastInboundLang(slackId: string, lang: string): void {
  if (!lang || !slackId) return;
  const db = getDb();
  db.prepare(
    `UPDATE people_memory SET last_inbound_lang = ?, last_inbound_lang_at = datetime('now'), updated_at = datetime('now') WHERE slack_id = ?`,
  ).run(lang, slackId);
}

/**
 * The language to WRITE TO this person in. Precedence:
 *   1. recent inbound (within LANG_RECENCY_DAYS) — the live signal wins
 *   2. stored language_preference (owner pin / legacy) — fallback for contacts
 *      we haven't heard from recently
 *   3. English (default)
 * Returns a short code: 'he' | 'ru' | 'ar' | 'en' | <stored pref lowercased>.
 */
export function resolveOutboundLanguageForPerson(person: PersonMemory | null | undefined): string {
  if (!person) return 'en';
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
  } catch { /* fall through to default */ }
  // 3. Default.
  return 'en';
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
 * @param slackId     - person's Slack ID
 * @param initiatedBy - 'maelle' | 'person' — only Maelle initiations consume the daily gate
 */
export function recordSocialMoment(
  slackId: string,
  initiatedBy: 'maelle' | 'person' = 'maelle',
): void {
  // Updates last_social_at + last_initiated_at on the person row so the 24h
  // Maelle-initiation gate keeps working. Subject + topic-beat writes happen
  // ONLY at end-of-chat in `memory/capturePass.ts:runSubjectReconciliation`
  // (v3.0.1); this helper covers the people_memory row only.
  const db = getDb();
  const row = db.prepare('SELECT slack_id FROM people_memory WHERE slack_id = ?').get(slackId) as any;
  if (!row) return;

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { last_social_at: now };
  if (initiatedBy === 'maelle') {
    updates.last_initiated_at = now;
  }
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE people_memory SET ${setClause}, updated_at = datetime('now') WHERE slack_id = @slack_id`)
    .run({ ...updates, slack_id: slackId });
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

/** Provenance-aware field pick for a merge (owner > person > auto; ties → `a`). */
function pickByProvenance(
  a: { value?: string | null; setBy?: CoreFieldSetBy | null },
  b: { value?: string | null; setBy?: CoreFieldSetBy | null },
): { value: string | null; setBy: CoreFieldSetBy | null } {
  const av = (a.value ?? '').trim();
  const bv = (b.value ?? '').trim();
  if (!av && !bv) return { value: null, setBy: null };
  if (!av) return { value: bv, setBy: b.setBy ?? null };
  if (!bv) return { value: av, setBy: a.setBy ?? null };
  const ar = a.setBy ? SET_BY_RANK[a.setBy] : 0;
  const br = b.setBy ? SET_BY_RANK[b.setBy] : 0;
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
 * known the person since then), the recency stamps keep the LATER value, and
 * the loser's per-person md file is folded into the survivor's so no file is
 * orphaned (an orphan would surface as a phantom duplicate in the md catalog).
 *
 * Two refusals, both because merging would DESTROY identity rather than repair
 * it: a kind='self' row (Maelle's own row — merging it is how colleague gossip
 * would reach it), and two DIFFERENT slack_ids (two Slack accounts on one
 * address are two people; keeping them apart is the conservative read).
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
  const gender = pickByProvenance(
    { value: survivor.gender === 'unknown' ? null : survivor.gender, setBy: survivor.gender_set_by },
    { value: loser.gender === 'unknown' ? null : loser.gender, setBy: loser.gender_set_by },
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
    gender_set_by:        gender.setBy,
    gender_confirmed:     Math.max(survivor.gender_confirmed ?? 0, loser.gender_confirmed ?? 0),
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

  try {
    apply.immediate();
  } catch (err) {
    logger.error('person store — merge failed, both rows left intact', { survivorId, loserId, err: String(err).slice(0, 300) });
    return false;
  }

  logger.warn('person store — merged two rows for one person', {
    survivorId, loserId, email: merged.email, slackId: merged.slack_id, name: merged.name,
  });

  // Fold the loser's md file into the survivor's. Lazy require: the md layer
  // owns the file layout and itself reads the DB, so the dependency is resolved
  // at call time in both directions (same pattern as refreshAutoWorkingHours).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mergePersonMdFiles } = require('../memory/peopleMemory') as typeof import('../memory/peopleMemory');
    mergePersonMdFiles(survivorId, loserId, merged.name);
  } catch (err) {
    logger.warn('person store — md-file merge failed after row merge', { survivorId, loserId, err: String(err).slice(0, 200) });
  }

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
  const people = db.prepare(`
    SELECT * FROM people_memory
    WHERE slack_id != ?
    AND slack_id NOT LIKE 'SELF:%'
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
    const langPart = `, language_pref: ${resolveOutboundLanguageForPerson(p)}`;
    // v3.5.x — only a confirmed (person/owner) gender is authoritative; an `auto`
    // guess renders 'unknown' so it can't steer gendered Hebrew forms.
    const genderField = p.gender && p.gender !== 'unknown' && p.gender_set_by !== 'auto' ? p.gender : 'unknown';
    const parts: string[] = [
      `${p.name} (slack_id: ${p.slack_id}${p.name_he ? `, name_he: ${p.name_he}` : ''}${stateTag}${travelTag}${tzPart}${p.email ? `, email: ${p.email}` : ''}, gender: ${genderField}${langPart}${socialPart})`,
    ];

    // Profile dimensions moved to per-person markdown files (v2.2.1). Fields
    // still persisted for code paths that read them deterministically.
    void profile;

    // v2.3.4 — drop calendar-state snapshot entries (`meeting_booked`,
    // `coordination`) from the prompt-rendered list. These were lying when
    // the underlying meeting got moved or cancelled afterwards. The calendar
    // is the source of truth for meetings; memory belongs to relational facts
    // (conversations, messages, social pings), not stale booking snapshots.
    const relationalLog: PersonInteraction[] = (() => {
      try {
        const log = JSON.parse(p.interaction_log || '[]') as PersonInteraction[];
        return log.filter(i => i.type !== 'meeting_booked' && i.type !== 'coordination');
      } catch { return []; }
    })();

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
      if (bits.length > 0) {
        parts.push(`  (${bits.join(', ')} on file — get_person_memory("${p.name}") to load)`);
      }
    }

    return parts.join('\n');
  });

  return `WORKSPACE CONTACTS (people you have interacted with — use slack_id directly, no need to call find_slack_user). Each line shows what you know at a glance; where a line ends with "N notes / past exchanges on file", that person's relationship history and conversation notes load on demand via get_person_memory — pull it when they're relevant to the turn:\n${lines.join('\n')}`;
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

/**
 * Builds a per-person social context block injected into the system prompt
 * for COLLEAGUE turns (owner turns use the new Social Engine directive
 * instead). Surfaces engagement level, profile, recent interactions, and
 * notes. Topic history (stale-count / cooldown / seed topics) was retired
 * in v2.2 — that machinery is owner-scoped now and lives in the Social
 * Engine. Returns '' for unknown people.
 */
export function buildSocialContextBlock(slackId: string, timezone: string, assistantName: string = 'Assistant'): string {
  const person = getPersonMemory(slackId);
  if (!person) return '';

  const now              = DateTime.now().setZone(timezone);
  const lastInitiatedAt  = person.last_initiated_at ? DateTime.fromISO(person.last_initiated_at) : null;
  const hoursAgoInit     = lastInitiatedAt ? now.diff(lastInitiatedAt, 'hours').hours : Infinity;
  const canMaelleInitiate = hoursAgoInit >= 24;

  const notes: PersonNote[]    = JSON.parse(person.notes || '[]');
  const profile: PersonProfile = (() => {
    try { return JSON.parse(person.profile_json || '{}'); } catch { return {}; }
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

  // Profile summary — show anything known
  const profileParts: string[] = [];
  if (profile.communication_style)  profileParts.push(`style: ${profile.communication_style}`);
  // v3.3.x — language_preference deliberately NOT rendered here. This block is
  // the COLLEAGUE-path (inbound) social context: when the person writes to
  // Maelle, the reply must mirror THEIR current message, never a stored pref
  // (the Ayala "English in, Hebrew out" bug). The stored preference is for the
  // OUTREACH path (when Maelle INITIATES) — surfaced on the owner-path contact
  // line instead. Inbound language is governed by detectMessageLanguage's
  // per-turn directive + the CURRENT-TURN-WINS rule.
  // #135 — working_hours (free-text) deliberately NOT rendered here. It's a
  // SCHEDULING fact, and the LLM was repeating it as authority (the Isaac "works
  // Mon/Thu only" bug — the free-text contradicted his real free/busy + structured
  // workdays). Availability is owned by find_available_slots / attendeeAvailability
  // (structured workdays + Graph free/busy), never this relational social blob —
  // same reasoning as language_preference above.
  if (profile.response_speed)       profileParts.push(`responds: ${profile.response_speed}`);
  if (profile.role_summary)         profileParts.push(`role: ${profile.role_summary}`);
  if (profile.reports_to)           profileParts.push(`reports to: ${profile.reports_to}`);
  if (profile.collaboration_notes)  profileParts.push(`collab: ${profile.collaboration_notes}`);
  if (profileParts.length > 0) {
    lines.push(`Profile: ${profileParts.join(' | ')}`);
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

  // Recent activity. v2.3.4 — drop calendar-state snapshot types
  // (meeting_booked / coordination) — they go stale when meetings get moved
  // or cancelled and Sonnet ends up narrating snapshots as if they were
  // current facts. Relational entries only.
  const interactionLog: PersonInteraction[] = (() => {
    try { return JSON.parse(person.interaction_log || '[]'); } catch { return []; }
  })();
  const relationalInteractions = interactionLog.filter(
    i => i.type !== 'meeting_booked' && i.type !== 'coordination',
  );
  const recentInteractions = relationalInteractions.slice(-10);
  if (recentInteractions.length > 0) {
    lines.push(`Recent activity:\n${recentInteractions.map(i => `  [${i.date.split('T')[0]}] ${i.summary}`).join('\n')}`);
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
