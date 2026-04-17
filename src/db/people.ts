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

// ── Social context block (per-sender) ────────────────────────────────────────
// v1.7.4 — moved here from orchestrator/index.ts. It's a pure formatter for
// people_memory data, sibling to formatPeopleMemoryForPrompt above. Lives at
// the data layer so a future togglable persona skill (issue #3) can call it
// conditionally without the orchestrator having to know.

const SOCIAL_STALE_COUNT_THRESHOLD = 3;

/**
 * Builds a per-person social context block injected into the system prompt.
 * Tells Claude whether a social moment is due, what's already known, which
 * topics have been covered (and which are stale or on cooldown), so she
 * doesn't repeat herself.
 *
 * Returns '' for unknown people (no row in people_memory) — caller can skip.
 */
export function buildSocialContextBlock(slackId: string, timezone: string): string {
  const person = getPersonMemory(slackId);
  if (!person) return '';

  const now              = DateTime.now().setZone(timezone);
  const lastInitiatedAt  = person.last_initiated_at ? DateTime.fromISO(person.last_initiated_at) : null;
  const hoursAgoInit     = lastInitiatedAt ? now.diff(lastInitiatedAt, 'hours').hours : Infinity;
  const canMaelleInitiate = hoursAgoInit >= 24;

  const notes: PersonNote[]    = JSON.parse(person.notes || '[]');
  const topics                 = parseSocialTopics(person.social_topics || '[]');
  const profile: PersonProfile = (() => {
    try { return JSON.parse(person.profile_json || '{}'); } catch { return {}; }
  })();

  const lines: string[] = [`SOCIAL CONTEXT — ${person.name}`];

  // Engagement level gate — if they're avoidant, don't push.
  const engagementLevel = profile.engagement_level ?? 'neutral';
  if (engagementLevel === 'avoidant') {
    lines.push(`Engagement level: AVOIDANT — this person consistently avoids personal exchanges. Do NOT initiate social chat. Be professional and warm, but skip personal topics entirely unless they bring it up themselves.`);
    return lines.join('\n');
  }
  if (engagementLevel === 'minimal') {
    lines.push(`Engagement level: minimal — they rarely engage socially. Keep social moments very light; don't push if they seem uninterested.`);
  } else if (engagementLevel === 'friendly') {
    lines.push(`Engagement level: friendly — they respond warmly. Social moments work well with this person.`);
  } else if (engagementLevel === 'interactive') {
    lines.push(`Engagement level: interactive — they proactively chat. Be warm and reciprocate their energy.`);
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
    lines.push(`Maelle-initiated check-in: DUE (you last started one ${ago})`);
  } else {
    const h = Math.round(24 - hoursAgoInit);
    lines.push(`Maelle-initiated check-in: NOT due — you already started one recently (${h}h until next). If THEY bring up personal topics, respond freely — just don't YOU start it.`);
  }

  // Recent activity
  const interactionLog: PersonInteraction[] = (() => {
    try { return JSON.parse((person as any).interaction_log || '[]'); } catch { return []; }
  })();
  const recentInteractions = interactionLog.slice(-10);
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

  // Topic history with cooldown / stale detection / random pick
  const yesterday = now.minus({ hours: 24 }).toFormat('yyyy-MM-dd');
  const topicLabel = (t: typeof topics[number]) => t.subject ? `${t.name}:${t.subject}` : t.name;
  const isStale = (t: typeof topics[number]) =>
    t.count >= SOCIAL_STALE_COUNT_THRESHOLD && t.quality === 'neutral';

  if (topics.length > 0) {
    const recentTopics    = topics.filter(t => t.last_used >= yesterday);
    const notRecent       = topics.filter(t => t.last_used < yesterday);
    const staleTopics     = notRecent.filter(isStale);
    const availableTopics = notRecent.filter(t => !isStale(t));

    const goodTopics    = availableTopics.filter(t => t.quality === 'good');
    const engagedTopics = availableTopics.filter(t => t.quality === 'engaged');
    const neutralTopics = availableTopics.filter(t => t.quality === 'neutral');

    const topicLines: string[] = [];
    if (goodTopics.length)    topicLines.push(`  Available — great (go deeper): ${goodTopics.map(topicLabel).join(', ')}`);
    if (engagedTopics.length) topicLines.push(`  Available — engaged (worth revisiting): ${engagedTopics.map(topicLabel).join(', ')}`);
    if (neutralTopics.length) topicLines.push(`  Available — flat but not stale (could try once more): ${neutralTopics.map(topicLabel).join(', ')}`);
    if (recentTopics.length)  topicLines.push(`  INITIATION COOLDOWN (discussed within last 24h — do NOT bring these up yourself; if THEY mention it, respond warmly): ${recentTopics.map(topicLabel).join(', ')}`);
    if (staleTopics.length)   topicLines.push(`  STALE — DO NOT REVISIT (asked ${SOCIAL_STALE_COUNT_THRESHOLD}+ times, never progressed): ${staleTopics.map(topicLabel).join(', ')}`);
    lines.push(`Topic history:\n${topicLines.join('\n')}`);

    // v1.7.4 — random pick when 2+ available so Maelle doesn't cycle the same
    // top-of-list topic every initiation.
    if (canMaelleInitiate && availableTopics.length >= 2) {
      const pool = [...availableTopics].sort(() => Math.random() - 0.5);
      const pick = pool[0];
      lines.push(`→ RANDOM PICK from available pool this turn: ${topicLabel(pick)} (quality=${pick.quality}). If you initiate, prefer this one — varies which subject you raise so the conversation feels natural over time.`);
    }
  }

  const hasFreshTopic =
    canMaelleInitiate &&
    topics.some(t => t.last_used < yesterday && !isStale(t));

  if (canMaelleInitiate) {
    if (hasFreshTopic) {
      lines.push(`→ Find ONE natural moment after the work is done. Pick a fresh available topic (never one on INITIATION COOLDOWN or marked STALE). 1–2 sentences. MANDATORY: the moment you ask a personal question — even before they answer, even if they never answer — call note_about_person (or note_about_self if this person is the owner) with initiated_by="maelle", the enum topic, and a SPECIFIC free-form subject (e.g. topic="hobby", subject="clair obscur game"; topic="family", subject="daughter's school play"). The subject is what goes on 24h cooldown, not the enum — so be specific. After the conversation, consider calling update_person_profile if you learned something about their engagement, style, or role.`);
    } else {
      lines.push(`→ NO FRESH TOPICS available (everything on cooldown, stale, or empty). If a social moment fits naturally, try ONE open discovery question to find new ground. Examples to adapt to context: "what do you like to do after work?", "anything interesting going on outside work?", "anything I should know about you that I don't?". 1 sentence, soft, never pushy. MANDATORY: the moment you ask, call note_about_person (or note_about_self if this person is the owner) with initiated_by="maelle", topic that best fits ("other" if truly open), and a specific subject describing what you asked (e.g. subject="open after-work question"). If they don't bite, that subject just goes on cooldown — no harm. Engagement-level avoidant/minimal → DO NOT initiate even an open question; respect the signal.`);
    }
  } else {
    lines.push(`→ If they bring up something personal, respond warmly and call note_about_person (or note_about_self if this person is the owner) with initiated_by="person" and a specific subject. Do NOT start a social topic yourself. Any subject on INITIATION COOLDOWN above is OFF-LIMITS for you to bring up again — if they don't mention it, neither do you. Anything marked STALE is permanently OFF-LIMITS for initiation.`);
  }

  return lines.join('\n');
}
