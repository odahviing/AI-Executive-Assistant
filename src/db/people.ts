import { getDb } from './client';

// ── People Memory ─────────────────────────────────────────────────────────────
// Persistent contact directory — auto-populated when people are mentioned or
// found via find_slack_user. Gives the agent cross-conversation relationship context.

export interface PersonNote {
  date: string;   // YYYY-MM-DD
  note: string;
}

export type PersonGender = 'male' | 'female' | 'unknown';

export type SocialTopicQuality = 'neutral' | 'engaged' | 'good';

/**
 * Rich social topic record — tracks quality of engagement per topic
 * so Maelle knows what to revisit and what to explore further.
 *
 * Two levels of granularity:
 *   - `name`    → fixed enum category ("hobby", "family", "sport", ...).
 *                 Broad — used to catalog and group.
 *   - `subject` → optional free-form specific subject ("clair obscur game",
 *                 "marathon training", "daughter's bat mitzva").
 *                 Cooldown fires on (name + subject) pairs, so Maelle can't
 *                 re-ask about the same specific thing twice in 24h even
 *                 though the broader category ("hobby") is legal.
 *
 * Rows with the same `name` but different `subject` are separate topics.
 */
export interface SocialTopic {
  name: string;                   // enum category: "family", "sport", "hobby", ...
  subject?: string;               // free-form specific subject under that category
  quality: SocialTopicQuality;    // neutral=brief answer, engaged=opened up, good=really connected
  count: number;                  // how many times this topic came up
  last_used: string;              // YYYY-MM-DD
}

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
  working_hours?: string;

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

export interface PersonMemory {
  slack_id: string;
  name: string;
  name_he?: string;             // Hebrew spelling, used verbatim when writing in Hebrew
  email?: string;
  timezone?: string;
  gender: PersonGender;
  gender_confirmed?: number;    // 0/1 — 1 means human-confirmed; auto-detectors must not overwrite
  notes: string;                // JSON: PersonNote[]   — personal/relationship knowledge
  interaction_log: string;      // JSON: PersonInteraction[] — chronological activity timeline
  profile_json: string;         // JSON: PersonProfile  — structured behavioral model
  last_seen?: string;
  last_social_at?: string;      // ISO datetime of last ANY social exchange (Maelle or person)
  last_initiated_at?: string;   // ISO datetime of last time MAELLE started social chat (24h gate)
  social_topics: string;        // JSON: SocialTopic[]  — rich topic history
  created_at: string;
  updated_at: string;
}

/** Set or update the Hebrew spelling of a contact's name. */
export function setPersonNameHe(slackId: string, nameHe: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE people_memory SET name_he = ?, updated_at = datetime('now') WHERE slack_id = ?
  `).run(nameHe, slackId);
}

/**
 * Parse social_topics from DB — handles both old string[] format and new SocialTopic[] format.
 */
export function parseSocialTopics(json: string): SocialTopic[] {
  try {
    const raw = JSON.parse(json || '[]');
    if (!Array.isArray(raw) || raw.length === 0) return [];
    // Migrate old format (string[]) to new format
    if (typeof raw[0] === 'string') {
      return (raw as string[]).map(name => ({
        name: name.toLowerCase().trim(),
        quality: 'neutral' as SocialTopicQuality,
        count: 1,
        last_used: new Date().toISOString().split('T')[0],
      }));
    }
    return raw as SocialTopic[];
  } catch {
    return [];
  }
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
}): void {
  const db = getDb();
  // NOTE: gender is only written when explicitly supplied AND not 'unknown'.
  // Respect gender_confirmed: never overwrite a confirmed gender here. A
  // confirmed update must go through confirmPersonGender().
  db.prepare(`
    INSERT INTO people_memory (slack_id, name, email, timezone, gender, last_seen)
    VALUES (@slack_id, @name, @email, @timezone, @gender, datetime('now'))
    ON CONFLICT(slack_id) DO UPDATE SET
      name      = @name,
      email     = COALESCE(@email, email),
      timezone  = COALESCE(@timezone, timezone),
      gender    = CASE
                    WHEN gender_confirmed = 1 THEN gender
                    WHEN @gender != 'unknown' THEN @gender
                    ELSE gender
                  END,
      last_seen = datetime('now'),
      updated_at = datetime('now')
  `).run({
    slack_id: params.slackId,
    name:     params.name,
    email:    params.email    ?? null,
    timezone: params.timezone ?? null,
    gender:   params.gender   ?? 'unknown',
  });
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
  const db = getDb();
  const row = db.prepare('SELECT notes FROM people_memory WHERE slack_id = ?').get(slackId) as any;
  if (!row) return;

  const notes: PersonNote[] = JSON.parse(row.notes || '[]');
  const today = new Date().toISOString().split('T')[0];
  notes.push({ date: today, note });
  const trimmed = notes.slice(-50);   // keep last 50 — rich context, not expensive

  db.prepare(`
    UPDATE people_memory
    SET notes = ?, updated_at = datetime('now')
    WHERE slack_id = ?
  `).run(JSON.stringify(trimmed), slackId);
}

/**
 * Append an interaction to the chronological activity timeline for a contact.
 * For things like "booked meeting", "sent message", "had a conversation about X".
 * This is the activity log — separate from personal notes.
 * Keeps last 200 interactions (headlines are short, memory is cheap).
 */
export function appendPersonInteraction(slackId: string, interaction: Omit<PersonInteraction, 'date'>): void {
  const db = getDb();
  const row = db.prepare('SELECT interaction_log FROM people_memory WHERE slack_id = ?').get(slackId) as any;
  if (!row) return;

  const log: PersonInteraction[] = (() => {
    try { return JSON.parse(row.interaction_log || '[]'); } catch { return []; }
  })();

  log.push({ date: new Date().toISOString(), ...interaction });
  const trimmed = log.slice(-200);

  db.prepare(`
    UPDATE people_memory
    SET interaction_log = ?, updated_at = datetime('now')
    WHERE slack_id = ?
  `).run(JSON.stringify(trimmed), slackId);
}

/**
 * Record that a social moment happened with a person.
 *
 * @param slackId       - person's Slack ID
 * @param topic         - enum category (e.g. 'family', 'sport', 'hobby')
 * @param quality       - how engaged was the person? 'neutral' | 'engaged' | 'good'
 * @param initiatedBy   - 'maelle' | 'person' — only Maelle initiations consume the daily gate
 * @param subject       - optional free-form specific subject ('clair obscur game',
 *                        'half marathon training'). Cooldown fires at the
 *                        (topic + subject) level so Maelle doesn't re-ask about
 *                        the exact same thing within 24h.
 */
export function recordSocialMoment(
  slackId: string,
  topic: string,
  quality: SocialTopicQuality = 'neutral',
  initiatedBy: 'maelle' | 'person' = 'maelle',
  subject?: string,
): void {
  const db = getDb();
  const row = db.prepare('SELECT social_topics, last_initiated_at FROM people_memory WHERE slack_id = ?').get(slackId) as any;
  if (!row) return;

  const topics = parseSocialTopics(row.social_topics || '[]');
  const normalisedTopic   = topic.toLowerCase().trim();
  const normalisedSubject = subject?.toLowerCase().trim() || undefined;
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  // Match on (topic + subject). A subject-less legacy row with the same topic
  // does NOT match a new subject-bearing row — we want them as separate entries.
  const existing = topics.find(t =>
    t.name === normalisedTopic && (t.subject ?? undefined) === normalisedSubject,
  );
  if (existing) {
    // Upgrade quality — never downgrade (neutral → engaged → good)
    const qualityOrder: SocialTopicQuality[] = ['neutral', 'engaged', 'good'];
    if (qualityOrder.indexOf(quality) > qualityOrder.indexOf(existing.quality)) {
      existing.quality = quality;
    }
    existing.count += 1;
    existing.last_used = today;
  } else {
    topics.push({ name: normalisedTopic, subject: normalisedSubject, quality, count: 1, last_used: today });
  }

  const updates: Record<string, unknown> = {
    last_social_at: now,
    social_topics: JSON.stringify(topics),
  };

  // Only update last_initiated_at when Maelle started the social moment
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

export function searchPeopleMemory(query: string): PersonMemory[] {
  const db = getDb();
  const q = `%${query.toLowerCase()}%`;
  return db.prepare(`
    SELECT * FROM people_memory
    WHERE lower(name) LIKE ? OR lower(email) LIKE ?
    ORDER BY last_seen DESC
    LIMIT 10
  `).all(q, q) as PersonMemory[];
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
    const socialTopics = parseSocialTopics(p.social_topics || '[]');
    const profile: PersonProfile = (() => {
      try { return JSON.parse(p.profile_json || '{}'); } catch { return {}; }
    })();

    const socialLine = p.last_social_at
      ? `last social: ${p.last_social_at.split('T')[0]}${p.last_social_at.startsWith(today) ? ' (today)' : ''}`
      : 'no social exchange yet';

    // Format topics with quality signal. Show subject when present so the LLM
    // can distinguish "hobby: clair obscur" from "hobby: woodworking".
    const topicStr = socialTopics.length
      ? socialTopics.map(t => {
          const label = t.subject ? `${t.name}:${t.subject}` : t.name;
          return `${label}(${t.quality})`;
        }).join(', ')
      : '';

    const parts: string[] = [
      `${p.name} (slack_id: ${p.slack_id}${p.name_he ? `, name_he: ${p.name_he}` : ''}${p.timezone ? `, tz: ${p.timezone}` : ''}${p.email ? `, email: ${p.email}` : ''}, gender: ${p.gender}, ${socialLine}${topicStr ? `, topics: ${topicStr}` : ''})`,
    ];

    // Profile dimensions — show any that are known
    if (profile.engagement_level)   parts.push(`  profile: engagement=${profile.engagement_level}`);
    if (profile.communication_style) parts.push(`  communication: ${profile.communication_style}`);
    if (profile.language_preference) parts.push(`  language: ${profile.language_preference}`);
    if (profile.working_hours)       parts.push(`  working hours: ${profile.working_hours}`);
    if (profile.response_speed)      parts.push(`  response speed: ${profile.response_speed}`);
    if (profile.role_summary)        parts.push(`  role: ${profile.role_summary}`);
    if (profile.reports_to)          parts.push(`  reports to: ${profile.reports_to}`);
    if (profile.collaboration_notes) parts.push(`  collaboration: ${profile.collaboration_notes}`);

    // Personal/relationship notes — all of them
    for (const n of notes) {
      parts.push(`  ★ [${n.date}] ${n.note}`);
    }

    // Activity timeline. v1.6.14 — show last 30 entries ONLY for contacts
    // who are in the current chat (MPIM participants, or explicit focus);
    // everyone else gets the last 10. One heavy contact with 30 entries of
    // ~100-token exchanges can add 3k tokens to every owner turn; capping
    // non-focus at 10 saves a lot without losing context for people Maelle
    // is actively talking to.
    const isFocus = focusSlackIds?.has(p.slack_id) ?? false;
    const entryCap = isFocus ? 30 : 10;
    const log: PersonInteraction[] = (() => {
      try { return JSON.parse(p.interaction_log || '[]'); } catch { return []; }
    })();
    for (const i of log.slice(-entryCap)) {
      const d = i.date.split('T')[0];
      parts.push(`  ↳ [${d}] ${i.type}: ${i.summary}`);
    }

    return parts.join('\n');
  });

  return `WORKSPACE CONTACTS (people you have interacted with — use slack_id directly, no need to call find_slack_user):\n${lines.join('\n')}`;
}
