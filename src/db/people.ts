import { getDb } from './client';
import { DateTime } from 'luxon';

// ── People Memory ─────────────────────────────────────────────────────────────
// Persistent contact directory — auto-populated when people are mentioned or
// found via find_slack_user. Gives the agent cross-conversation relationship context.

export interface PersonNote {
  date: string;   // YYYY-MM-DD
  note: string;
}

export type PersonGender = 'male' | 'female' | 'unknown';

export type PersonSocialTopicQuality = 'neutral' | 'engaged' | 'good';
// Back-compat alias during v2.2 migration; prefer PersonSocialTopicQuality.
export type SocialTopicQuality = PersonSocialTopicQuality;

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
  slack_id: string;
  name: string;
  name_he?: string;             // Hebrew spelling, used verbatim when writing in Hebrew
  email?: string;
  timezone?: string;
  timezone_set_by?: CoreFieldSetBy;
  state?: string;               // v2.2.2 — free-text location ("Israel", "Boston", "Tel Aviv")
  state_set_by?: CoreFieldSetBy;
  gender: PersonGender;
  gender_confirmed?: number;    // 0/1 — kept for back-compat. New code reads gender_set_by.
  gender_set_by?: CoreFieldSetBy;
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
 * v2.2.3 — proactive ping anti-spam lock.
 *
 * setProactivePending(slackId)   → fired by socialOutreachTick after a
 *                                   proactive ping is sent. Locks the person
 *                                   out of further proactive pings.
 * clearProactivePendingOnInbound → fired ONLY on a real inbound message from
 *                                   the person. Their reply (to anything —
 *                                   the proactive ping itself, or a separate
 *                                   task-driven DM Maelle sent) is the signal
 *                                   that they're engaged again.
 *
 * Outbound messages Maelle sends (task-driven message_colleague, coord DM,
 * a second proactive ping) DO NOT clear the lock. Only an inbound from them.
 *
 * isProactivePending(slackId)    → read; pickCandidate filters with this.
 */
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

export function setProactivePending(slackId: string): void {
  const db = getDb();
  db.prepare(`UPDATE people_memory SET proactive_pending = 1, updated_at = datetime('now') WHERE slack_id = ?`).run(slackId);
}

export function clearProactivePendingOnInbound(slackId: string): void {
  if (!slackId) return;
  const db = getDb();
  db.prepare(`UPDATE people_memory SET proactive_pending = 0, updated_at = datetime('now') WHERE slack_id = ? AND proactive_pending = 1`).run(slackId);
}

export function isProactivePending(slackId: string): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT proactive_pending FROM people_memory WHERE slack_id = ?`).get(slackId) as
    | { proactive_pending: number | null }
    | undefined;
  return !!(row && row.proactive_pending === 1);
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
  if (!value || !value.trim()) return false;
  const db = getDb();
  const setByCol = `${field}_set_by` as const;
  const row = db.prepare(`SELECT ${field} as value, ${setByCol} as setBy FROM people_memory WHERE slack_id = ?`).get(slackId) as
    | { value: string | null; setBy: CoreFieldSetBy | null }
    | undefined;

  // No row yet — caller must upsert first; we no-op rather than create.
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
    `UPDATE people_memory SET ${field} = ?, ${setByCol} = ?, updated_at = datetime('now') WHERE slack_id = ?`,
  ).run(value.trim(), by, slackId);

  // Side effect: setting gender via this path also flips gender_confirmed for
  // back-compat readers (gender_confirmed=1 means owner OR person, not auto).
  if (field === 'gender' && by !== 'auto') {
    db.prepare(`UPDATE people_memory SET gender_confirmed = 1 WHERE slack_id = ?`).run(slackId);
  }

  return true;
}

/** Set or update the Hebrew spelling of a contact's name. */
export function setPersonNameHe(slackId: string, nameHe: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE people_memory SET name_he = ?, updated_at = datetime('now') WHERE slack_id = ?
  `).run(nameHe, slackId);
}

/**
 * Create or update a contact in people_memory.
 * Safe to call repeatedly — only overwrites non-null fields.
 * Gender is only updated when a real value (not 'unknown') is supplied.
 */
export function upsertPersonMemory(params: {
  slackId: string;
  name: string;
  email?: string;
  timezone?: string;
  gender?: PersonGender;
  /**
   * v2.2.2 (#46) — provenance for the timezone write. Defaults to 'auto'
   * (Slack profile / users.info pulls). Owner-path callers should pass 'owner'
   * so the value is locked against later auto-overwrite. The COALESCE pattern
   * here means the timezone is only written when currently NULL; the explicit
   * provenance helper `setCoreFieldWithProvenance` is the right path for
   * AUTHORITATIVE overwrites of an existing value.
   */
  timezoneSetBy?: CoreFieldSetBy;
}): void {
  const db = getDb();
  const tzSetBy: CoreFieldSetBy = params.timezoneSetBy ?? 'auto';
  // NOTE: gender is only written when explicitly supplied AND not 'unknown'.
  // Respect gender_confirmed: never overwrite a confirmed gender here. A
  // confirmed update must go through confirmPersonGender().
  db.prepare(`
    INSERT INTO people_memory (slack_id, name, email, timezone, timezone_set_by, gender, last_seen)
    VALUES (@slack_id, @name, @email, @timezone, @tz_set_by, @gender, datetime('now'))
    ON CONFLICT(slack_id) DO UPDATE SET
      name             = @name,
      email            = COALESCE(@email, email),
      timezone         = COALESCE(@timezone, timezone),
      timezone_set_by  = CASE
                           WHEN @timezone IS NOT NULL AND timezone IS NULL
                             THEN @tz_set_by
                           ELSE timezone_set_by
                         END,
      gender           = CASE
                           WHEN gender_confirmed = 1 THEN gender
                           WHEN @gender != 'unknown' THEN @gender
                           ELSE gender
                         END,
      last_seen        = datetime('now'),
      updated_at       = datetime('now')
  `).run({
    slack_id:  params.slackId,
    name:      params.name,
    email:     params.email    ?? null,
    timezone:  params.timezone ?? null,
    tz_set_by: params.timezone ? tzSetBy : null,
    gender:    params.gender   ?? 'unknown',
  });

  // v2.2.2 (#46) — whenever timezone landed (new or existing), refresh the
  // auto-derived working hours. Cheap; idempotent inside the helper.
  if (params.timezone) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { refreshAutoWorkingHours } = require('../utils/workingHoursDefault') as typeof import('../utils/workingHoursDefault');
      refreshAutoWorkingHours(params.slackId);
    } catch { /* never block memory writes */ }
  }
}

/**
 * Update gender from an automatic detector (pronouns, image, name-LLM).
 * Silently no-ops if gender_confirmed = 1 — auto-detection never overrides
 * a human confirmation.
 */
export function updatePersonGender(slackId: string, gender: PersonGender): void {
  const db = getDb();
  db.prepare(`
    UPDATE people_memory
       SET gender = ?, updated_at = datetime('now')
     WHERE slack_id = ? AND gender_confirmed = 0
  `).run(gender, slackId);
}

/**
 * Human-confirmed gender write. Sets gender_confirmed = 1 so that no
 * downstream auto-detector can overwrite it. Call this when the person
 * themselves states their gender (e.g. "אני את - נקבה", "I'm a guy"),
 * or when the owner confirms on their behalf.
 */
export function confirmPersonGender(slackId: string, gender: PersonGender): void {
  const db = getDb();
  db.prepare(`
    UPDATE people_memory
       SET gender = ?, gender_confirmed = 1, updated_at = datetime('now')
     WHERE slack_id = ?
  `).run(gender, slackId);
}

/**
 * Update the structured profile for a person — merges supplied fields into
 * the existing profile, leaving unspecified fields untouched.
 */
export function updatePersonProfile(slackId: string, updates: Partial<PersonProfile>): void {
  const db = getDb();
  const row = db.prepare('SELECT profile_json FROM people_memory WHERE slack_id = ?').get(slackId) as any;
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
    UPDATE people_memory SET profile_json = ?, updated_at = datetime('now') WHERE slack_id = ?
  `).run(JSON.stringify(merged), slackId);
}

/**
 * Append a personal/relationship note about a contact.
 * For things like "has two kids", "loves Real Madrid", "goes by Ike".
 * Keep it to human context — work activity goes in appendPersonInteraction.
 * Keeps last 50 notes.
 */
export function appendPersonNote(slackId: string, note: string): void {
  // RMW guarded by BEGIN IMMEDIATE so concurrent writers serialize. Pre-fix
  // an in-turn `note_about_self` from Sonnet could interleave with a
  // background capture-pass write on the same row: A reads → B reads →
  // A writes → B's write overwrites A. Lost note. With the transaction,
  // the second writer either waits for the first commit (then sees the
  // updated row on its own SELECT inside the txn) or fails with SQLITE_BUSY
  // (which better-sqlite3 surfaces as an exception — caller's existing
  // try/catch handles non-fatal logging).
  const db = getDb();
  const txn = db.transaction((id: string, newNote: string) => {
    const row = db.prepare('SELECT notes FROM people_memory WHERE slack_id = ?').get(id) as
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
      WHERE slack_id = ?
    `).run(JSON.stringify(trimmed), id);
  });
  txn.immediate(slackId, note);
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
  const db = getDb();
  const txn = db.transaction((id: string, entry: Omit<PersonInteraction, 'date'>) => {
    const row = db.prepare('SELECT interaction_log FROM people_memory WHERE slack_id = ?').get(id) as
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
      WHERE slack_id = ?
    `).run(JSON.stringify(trimmed), id);
  });
  txn.immediate(slackId, interaction);
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
  return db.prepare(`
    SELECT * FROM people_memory
    WHERE (lower(name) LIKE ? OR lower(email) LIKE ?)
      AND slack_id NOT LIKE 'SELF:%'
    ORDER BY last_seen DESC
    LIMIT 10
  `).all(q, q) as PersonMemory[];
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
    const tz = p.timezone
      ? (p.state ? `${p.timezone} (${p.state})` : p.timezone)
      : 'unknown';
    const gender = p.gender && p.gender !== 'unknown' ? p.gender : 'unknown';
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
    const tzPart = p.timezone
      ? `, tz: ${p.timezone}${!p.state ? ' (city not on file — TZ is reliable for time math; only ask for city when location/venue matters)' : ''}`
      : '';

    const parts: string[] = [
      `${p.name} (slack_id: ${p.slack_id}${p.name_he ? `, name_he: ${p.name_he}` : ''}${stateTag}${travelTag}${tzPart}${p.email ? `, email: ${p.email}` : ''}, gender: ${p.gender}${socialPart})`,
    ];

    // Profile dimensions moved to per-person markdown files (v2.2.1). Fields
    // still persisted for code paths that read them deterministically.
    void profile;

    // Personal/relationship notes — only when persona is on (the notes are
    // social context: hobbies, life events, relationship-building bits).
    if (includeSocial) {
      for (const n of notes) {
        parts.push(`  ★ [${n.date}] ${n.note}`);
      }
    }

    // Activity timeline. v1.6.14 — show last 30 entries ONLY for contacts
    // who are in the current chat (MPIM participants, or explicit focus);
    // everyone else gets the last 10. One heavy contact with 30 entries of
    // ~100-token exchanges can add 3k tokens to every owner turn; capping
    // non-focus at 10 saves a lot without losing context for people Maelle
    // is actively talking to.
    // v2.2.3 (#3) — interaction log is operational + social mixed; kept on
    // both modes but trimmed harder when persona off (focus contacts only).
    //
    // v2.3.4 — drop calendar-state snapshot entries (`meeting_booked`,
    // `coordination`) from the prompt-rendered list. These were lying when
    // the underlying meeting got moved or cancelled afterwards: Lori's row
    // had three meeting_booked snapshots — two with the original April dates
    // and one with the May reschedule — and Sonnet narrated the older April
    // entry as fact ("Lori onboarding isn't showing on tomorrow's
    // calendar"). The calendar is the source of truth for meetings; memory
    // belongs to relational facts (conversations, messages, social pings),
    // not to point-in-time booking snapshots that go stale silently.
    const isFocus = focusSlackIds?.has(p.slack_id) ?? false;
    const entryCap = includeSocial ? (isFocus ? 30 : 10) : (isFocus ? 10 : 0);
    if (entryCap > 0) {
      const log: PersonInteraction[] = (() => {
        try { return JSON.parse(p.interaction_log || '[]'); } catch { return []; }
      })();
      const relational = log.filter(i => i.type !== 'meeting_booked' && i.type !== 'coordination');
      for (const i of relational.slice(-entryCap)) {
        const d = i.date.split('T')[0];
        parts.push(`  ↳ [${d}] ${i.type}: ${i.summary}`);
      }
    }

    return parts.join('\n');
  });

  return `WORKSPACE CONTACTS (people you have interacted with — use slack_id directly, no need to call find_slack_user):\n${lines.join('\n')}`;
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
  if (profile.language_preference)  profileParts.push(`language: ${profile.language_preference}`);
  if (profile.working_hours)        profileParts.push(`hours: ${profile.working_hours}`);
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
    try { return JSON.parse((person as any).interaction_log || '[]'); } catch { return []; }
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
