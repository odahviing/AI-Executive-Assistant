/**
 * v2.9.3 (#103) — end-of-chat capture pass.
 *
 * The colleague-self-write path was mute pre-v2.9.3: when a colleague
 * volunteered preferences ("4-6pm Sydney"), the system prompt didn't tell
 * Sonnet to call `update_person_profile`, so structured facts never
 * landed and the next conversation started cold. This module fills that
 * gap with a deterministic, code-side capture mechanism:
 *
 *   1. The 5-min background loop calls `runCapturePass(app, profile)`.
 *   2. It queries `conversation_threads` for DMs that went quiet 30+ min
 *      ago AND have new activity since the last capture
 *      (`findThreadsReadyForCapture`).
 *   3. For each ready thread, it resolves the colleague via Slack
 *      `conversations.info` (DM channel.user) and skips owner DMs.
 *   4. It loads the colleague's current state (people_memory profile_json
 *      + .md file content + recent notes) and the just-completed chat.
 *   5. A single Haiku call extracts deltas — facts the chat revealed
 *      that aren't already on file. Comparing against current state
 *      means re-runs on the same chat (idempotency) are no-ops.
 *   6. Code applies deltas: DB writes first (profile_json fields via
 *      updatePersonProfile + setCoreFieldWithProvenance), then mirrors
 *      the same updates into the colleague's .md file sections so the
 *      day-to-day prompt (which reads from .md) reflects current state.
 *   7. `markThreadCaptured` stamps captured_at so re-runs don't refire
 *      until new messages arrive.
 *
 * Cost: ~$0.001/capture × ~20 ready-events/day ≈ $0.02/day. Negligible.
 *
 * Scope (MVP): DM threads only (`channel_id LIKE 'D%'`). MPIM and
 * channel-mention triggers come later — they need a separate speaker-
 * identification path because the conversation_threads.context array
 * stores 'user'/'assistant' roles without slack_id per message.
 */

import type { App } from '@slack/bolt';
import type Anthropic from '@anthropic-ai/sdk';
import type { UserProfile } from '../config/userProfile';
import {
  findThreadsReadyForCapture,
  markThreadCaptured,
  getConversationHistory,
  getPersonMemory,
  updatePersonProfile,
  setCoreFieldWithProvenance,
  appendPersonNote,
  appendPersonInteraction,
  setPersonNameHe,
  type PersonProfile,
} from '../db';
import { readPersonMemory, writePersonSection, slugifyName } from './peopleMemory';
import { selfSlackId } from '../core/assistantSelf';
import { getAnthropicClient } from '../llm/client';
import { config } from '../config';
import logger from '../utils/logger';

const SILENCE_MINUTES = 30;
const MAX_THREADS_PER_TICK = 20;
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Haiku-extracted delta. Each field is optional — Haiku only emits keys
 * it confidently learned. The shape mirrors PersonProfile + a few core
 * `people_memory` columns (timezone/state/name_he) that aren't in
 * profile_json but are part of "what we know about this person".
 *
 * `interaction_summary` is a one-line headline of what this chat was
 * about. It always gets logged (when present), even when no profile
 * fields changed — that's the "history" half of the capture goal.
 */
interface CaptureDelta {
  // people_memory columns (provenance-aware)
  timezone?: string;
  state?: string;
  name_he?: string;
  // profile_json fields
  language_preference?: string;
  working_hours?: string;
  communication_style?: string;
  response_speed?: 'immediate' | 'fast' | 'hours' | 'day' | 'slow' | 'unreliable';
  role_summary?: string;
  reports_to?: string;
  collaboration_notes?: string;
  // history
  interaction_summary?: string;
  // anything notable that doesn't fit a structured field but is durable
  durable_note?: string;
}

const SYSTEM_PROMPT = `You are a fact extractor for an executive assistant's memory layer.

You will be given (1) a chat transcript between an EA named Maelle and a colleague, (2) the current structured profile + freeform md notes Maelle already has on that colleague.

Your ONLY job: identify what is genuinely NEW or UPDATED about the colleague based on this chat. Compare against the current state — DO NOT re-emit facts already on file.

What counts as a learnable fact (operational, changes how Maelle should interact next time):
- timezone: explicit timezone mention ("ET", "PST", "Sydney time") or strong signal
- state: city / country mentioned as their location ("Boston", "Tel Aviv", "Israel")
- name_he: Hebrew spelling of their name if they wrote it or it became clear
- language_preference: if they consistently write in a language different from Maelle's default
- working_hours: when they're typically reachable, what days they work
- communication_style: brief vs lengthy, direct vs warm, asks questions back vs not
- response_speed: how quickly they replied (immediate/fast/hours/day/slow/unreliable)
- role_summary: their role, what they focus on
- reports_to: their manager's name
- collaboration_notes: who they work with, what meetings they appear in

What's NOT a learnable structured fact (skip these):
- The booking / scheduling subject itself (the system tracks meetings separately)
- One-off mood ("seemed stressed today")
- Speculation Maelle didn't actually observe in the chat

ALSO emit:
- interaction_summary: a one-sentence headline of what this chat was about (e.g. "Asked for 30-min meeting with Idan next week, settled on Thursday 14:00 her time"). ALWAYS emit this when the chat had any substantive content.
- durable_note: optional — anything else worth remembering that doesn't fit a structured field. Use sparingly.

IDEMPOTENCY: if the chat re-fires through the capture pass and you see the facts already in the existing profile, RETURN AN EMPTY OBJECT. The system relies on you producing no-ops on re-runs.

CONFIDENCE: only emit a field if the chat CLEARLY teaches it. If you'd hedge "maybe", omit it.

Output strict JSON. No prose, no markdown fences, just the JSON object.`;

function buildUserMessage(
  colleagueName: string,
  currentProfile: PersonProfile,
  currentMd: string,
  chatTranscript: string,
): string {
  return [
    `Colleague: ${colleagueName}`,
    '',
    'CURRENT STRUCTURED PROFILE (what we already know — do NOT re-emit these):',
    '```json',
    JSON.stringify(currentProfile, null, 2),
    '```',
    '',
    'CURRENT MD FILE (freeform notes — also do NOT re-emit content already here):',
    '```',
    currentMd || '(none yet)',
    '```',
    '',
    'CHAT TRANSCRIPT (just completed):',
    '```',
    chatTranscript,
    '```',
    '',
    'Extract deltas as JSON:',
  ].join('\n');
}

function chatToTranscript(messages: Array<{ role: string; content: string }>, colleagueName: string, ownerName: string): string {
  return messages.map(m => {
    const speaker = m.role === 'assistant' ? `Maelle` : colleagueName || 'them';
    return `${speaker}: ${m.content}`;
  }).join('\n');
}

/**
 * Parse Haiku's strict-JSON output. Returns null on any parse failure —
 * caller treats null as "no deltas, skip apply but still mark captured".
 */
function parseDelta(raw: string): CaptureDelta | null {
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '');
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]) as CaptureDelta;
  } catch {
    return null;
  }
}

/**
 * Apply a Haiku delta to BOTH the DB and the colleague's .md file.
 *
 * DB writes use the existing provenance-aware helpers (`_set_by='auto'`
 * via setCoreFieldWithProvenance for timezone/state; updatePersonProfile
 * for profile_json fields). Owner-direct writes still trump auto.
 *
 * MD mirroring: each structured field maps to a section in the .md file
 * template (Residence / Workplace / Working hours / Communication style).
 * Updates REPLACE the section body. Interaction history APPENDS to the
 * "What we've discussed" section. Owner can hand-edit any section; the
 * next capture pass replaces only the auto-managed sections.
 */
async function applyDelta(
  profile: UserProfile,
  slackId: string,
  colleagueName: string,
  delta: CaptureDelta,
): Promise<void> {
  // ── 1. DB writes ──────────────────────────────────────────────────────
  // Core fields (provenance-aware — auto writes lose to owner/person).
  if (delta.timezone) setCoreFieldWithProvenance(slackId, 'timezone', delta.timezone, 'auto');
  if (delta.state) setCoreFieldWithProvenance(slackId, 'state', delta.state, 'auto');
  if (delta.name_he) setPersonNameHe(slackId, delta.name_he);

  // profile_json fields — direct merge via updatePersonProfile.
  const profileUpdates: Partial<PersonProfile> = {};
  if (delta.language_preference) profileUpdates.language_preference = delta.language_preference;
  if (delta.working_hours) profileUpdates.working_hours = delta.working_hours;
  if (delta.communication_style) profileUpdates.communication_style = delta.communication_style;
  if (delta.response_speed) profileUpdates.response_speed = delta.response_speed;
  if (delta.role_summary) profileUpdates.role_summary = delta.role_summary;
  if (delta.reports_to) profileUpdates.reports_to = delta.reports_to;
  if (delta.collaboration_notes) profileUpdates.collaboration_notes = delta.collaboration_notes;
  if (Object.keys(profileUpdates).length > 0) {
    updatePersonProfile(slackId, profileUpdates);
  }

  // Durable note (free-form, appended to notes[] capped at 50).
  if (delta.durable_note) {
    appendPersonNote(slackId, delta.durable_note);
  }

  // Interaction history — appended to interaction_log AND mirrored to
  // the "What we've discussed" .md section as a dated bullet.
  if (delta.interaction_summary) {
    appendPersonInteraction(slackId, {
      type: 'conversation',
      summary: delta.interaction_summary,
    });
  }

  // ── 2. MD file mirroring ──────────────────────────────────────────────
  // Per owner direction: the .md is the source of truth for prompt
  // context, so every DB write also reflects into the matching section.
  // Section body REPLACES the prior content (latest signal wins) for
  // structural state; the discussed-history section APPENDS.
  const slug = slugifyName(colleagueName);

  const residenceLines: string[] = [];
  if (delta.state) residenceLines.push(`Lives in ${delta.state}.`);
  if (delta.timezone) residenceLines.push(`Timezone: ${delta.timezone}.`);
  if (residenceLines.length > 0) {
    await writePersonSection({
      profile, slug, displayName: colleagueName,
      section: 'Residence',
      text: residenceLines.join(' '),
    });
  }

  const workplaceLines: string[] = [];
  if (delta.role_summary) workplaceLines.push(delta.role_summary);
  if (delta.reports_to) workplaceLines.push(`Reports to ${delta.reports_to}.`);
  if (delta.collaboration_notes) workplaceLines.push(delta.collaboration_notes);
  if (workplaceLines.length > 0) {
    await writePersonSection({
      profile, slug, displayName: colleagueName,
      section: 'Workplace',
      text: workplaceLines.join(' '),
    });
  }

  const hoursLines: string[] = [];
  if (delta.working_hours) hoursLines.push(delta.working_hours);
  if (delta.response_speed) hoursLines.push(`Typical response speed: ${delta.response_speed}.`);
  if (hoursLines.length > 0) {
    await writePersonSection({
      profile, slug, displayName: colleagueName,
      section: 'Working hours',
      text: hoursLines.join(' '),
    });
  }

  const commLines: string[] = [];
  if (delta.language_preference) commLines.push(`Prefers ${delta.language_preference}.`);
  if (delta.communication_style) commLines.push(delta.communication_style);
  if (delta.name_he) commLines.push(`Hebrew spelling: ${delta.name_he}.`);
  if (commLines.length > 0) {
    await writePersonSection({
      profile, slug, displayName: colleagueName,
      section: 'Communication style',
      text: commLines.join(' '),
    });
  }

  // History section — APPEND-style. We read the current section, append
  // a new dated bullet, write the whole block back.
  if (delta.interaction_summary) {
    const today = new Date().toISOString().split('T')[0];
    const newLine = `- [${today}] ${delta.interaction_summary}`;
    const currentMd = await readPersonMemory(profile, slug);
    let existingDiscussedBody = '';
    if (currentMd) {
      // Extract the "What we've discussed" section body if it exists.
      const match = currentMd.match(/##\s+What we've discussed\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
      if (match) existingDiscussedBody = match[1].trim();
    }
    const newBody = existingDiscussedBody
      ? `${existingDiscussedBody}\n${newLine}`
      : newLine;
    await writePersonSection({
      profile, slug, displayName: colleagueName,
      section: "What we've discussed",
      text: newBody,
    });
  }
}

/**
 * Resolve a DM channel's "other user" (the colleague). Returns null on
 * any failure — caller skips that thread for this tick.
 *
 * Uses `conversations.info`; for `im` channels Slack returns `channel.user`
 * directly as the human counterpart of the bot. Owner DMs return the
 * owner's slack_id; caller filters those.
 */
async function resolveDmColleague(app: App, channelId: string): Promise<string | null> {
  try {
    const res = await app.client.conversations.info({ channel: channelId });
    if (!res.ok || !res.channel) return null;
    const ch = res.channel as { is_im?: boolean; user?: string };
    if (ch.is_im && ch.user) return ch.user;
    return null;
  } catch (err) {
    logger.warn('capturePass: conversations.info failed', {
      channelId, err: String(err).slice(0, 200),
    });
    return null;
  }
}

/**
 * Main entry. Called from the background loop every 5 min. Bounded by
 * MAX_THREADS_PER_TICK so a burst of ready threads can't blow the budget
 * on a single tick.
 */
export async function runCapturePass(app: App, profile: UserProfile): Promise<void> {
  if (!config.ANTHROPIC_API_KEY) return;  // dev mode without API key — silently skip

  const ready = findThreadsReadyForCapture(SILENCE_MINUTES, MAX_THREADS_PER_TICK);
  if (ready.length === 0) return;

  logger.info('capturePass: ready threads found', { count: ready.length });

  const anthropic = getAnthropicClient();
  const ownerSlackId = profile.user.slack_user_id;
  const ownerName = profile.user.name.split(' ')[0];

  for (const row of ready) {
    try {
      // 1. Resolve colleague. Skip owner DMs + non-DM rows that slipped
      //    through the SQL filter (shouldn't happen but defensive).
      const colleagueId = await resolveDmColleague(app, row.channel_id);
      if (!colleagueId) {
        // Couldn't resolve — mark captured to avoid retrying every tick.
        markThreadCaptured(row.thread_ts);
        continue;
      }
      if (colleagueId === ownerSlackId) {
        // v2.9.4 follow-up — owner's DM IS the SELF capture path. Same
        // trigger (30 min quiet + new activity), different target (Maelle's
        // SELF row instead of a colleague row), different Haiku prompt
        // (facts about MAELLE herself, not about the speaker). Owner direction:
        // "do the same we did in the memory of persons / tell haiku to keep
        // as much as he can about maelle, but no duplicates."
        await runSelfCapture(profile, anthropic, row.thread_ts, ownerName);
        markThreadCaptured(row.thread_ts);
        continue;
      }

      // 2. Load current state — people_memory row + profile_json + md file.
      const personRow = getPersonMemory(colleagueId);
      if (!personRow) {
        // No row yet — capture skipped because we have no name to slug
        // the md file. The first explicit interaction creates the row;
        // future captures will land.
        markThreadCaptured(row.thread_ts);
        continue;
      }
      const currentProfile: PersonProfile = (() => {
        try { return JSON.parse(personRow.profile_json || '{}'); } catch { return {}; }
      })();
      const slug = slugifyName(personRow.name);
      const currentMd = await readPersonMemory(profile, slug) ?? '';

      // 3. Load chat transcript.
      const messages = getConversationHistory(row.thread_ts);
      if (messages.length === 0) {
        markThreadCaptured(row.thread_ts);
        continue;
      }
      const transcript = chatToTranscript(messages, personRow.name, ownerName);

      // 4. Single Haiku call to extract deltas.
      const userMsg = buildUserMessage(personRow.name, currentProfile, currentMd, transcript);
      const resp = await anthropic.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 800,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      });
      const text = resp.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('')
        .trim();
      const delta = parseDelta(text);

      if (!delta || Object.keys(delta).length === 0) {
        // Haiku said "nothing new to learn" — mark and move on.
        logger.info('capturePass: no new deltas', { threadTs: row.thread_ts, colleague: personRow.name });
        markThreadCaptured(row.thread_ts);
        continue;
      }

      // 5. Apply deltas to DB + md mirror.
      await applyDelta(profile, colleagueId, personRow.name, delta);

      logger.info('capturePass: applied deltas', {
        threadTs: row.thread_ts,
        colleague: personRow.name,
        deltaKeys: Object.keys(delta),
      });

      // 6. Stamp captured_at.
      markThreadCaptured(row.thread_ts);
    } catch (err) {
      logger.warn('capturePass: per-thread error, marking captured to avoid retry storm', {
        threadTs: row.thread_ts,
        err: String(err).slice(0, 200),
      });
      // Defensive: mark captured even on error so we don't retry the
      // same failing thread every 5 min forever. Loss is acceptable —
      // the next chat will trigger again.
      try { markThreadCaptured(row.thread_ts); } catch { /* ignore */ }
    }
  }
}

// ── SELF capture path (owner-DM threads) ────────────────────────────────────

/**
 * Haiku prompt for SELF capture. Different from the colleague prompt:
 * we want EVERYTHING that defines who Maelle is (origin, personality,
 * preferences, identity, communication style) — generous capture — but
 * STRICTLY dedup against the existing notes. Same-fact-different-wording
 * = skip.
 */
const SELF_SYSTEM_PROMPT = `You are extracting facts about Maelle (an AI executive assistant) from her conversation with her owner.

You will be given:
1. The notes Maelle already has saved about herself
2. A conversation transcript between Maelle and her owner

Your job: identify NEW facts about MAELLE that aren't already on file. Be generous in what counts as a Maelle-fact — capture anything that defines who she is or how she should behave:
- Origin / name meaning / where the name came from / why she exists
- Identity (AI/human/bot, age, when she was built, who built her)
- Personality traits the owner described or implied
- Communication preferences ("be more X", "always Y when Z")
- How she should handle specific situations
- Background / lore the owner shared about why she works the way she does
- Things the owner wants her to remember about her own role

What's NOT a Maelle-fact (skip these — they belong elsewhere):
- The owner's own life / work / meetings / calendar / hobbies
- Facts about colleagues mentioned in the conversation
- Plot details of games / books / movies the owner discussed (those are facts about THAT WORK, not about Maelle — unless the owner explicitly tied it back to Maelle, like "you were named after a character")
- Generic small-talk that didn't teach Maelle anything about herself

DEDUP RULE — this is strict: compare against the existing notes. If the conversation re-confirms a fact already on file, even with new wording or additional context, output it ONLY IF the new context adds something substantive. Pure re-statements with no new info = skip. Same essential fact phrased differently = skip.

Output strict JSON. No prose, no markdown fences:
{ "notes": ["fact 1", "fact 2", ...] }

Each note: 1-2 sentences, written from a third-person stance describing Maelle ("Named after...", "Owner prefers her to...", "Built around..."). Be specific. Vague notes ("seems friendly") are useless later.

If nothing new was learned, output { "notes": [] }.`;

interface SelfCaptureDelta {
  notes: string[];
}

function parseSelfDelta(raw: string): SelfCaptureDelta | null {
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '');
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const notes = Array.isArray(parsed?.notes)
      ? parsed.notes.filter((n: unknown): n is string => typeof n === 'string' && n.trim().length > 0)
      : [];
    return { notes };
  } catch {
    return null;
  }
}

/**
 * Process an owner-DM thread as a SELF capture turn.
 *
 * Loads Maelle's existing SELF row notes, runs Haiku with the conversation
 * + existing notes as context, applies new Maelle-facts via appendPersonNote
 * on the SELF: row. Idempotent across re-runs of the same chat: Haiku sees
 * existing notes and emits only deltas. Pure code-side capture — Sonnet's
 * in-turn note_about_self calls remain the primary path; this pass is a
 * safety net that catches facts Sonnet didn't save explicitly during chat.
 *
 * Fire-and-forget contract: any error caught + logged, never propagates.
 */
async function runSelfCapture(
  profile: UserProfile,
  anthropic: ReturnType<typeof getAnthropicClient>,
  threadTs: string,
  ownerName: string,
): Promise<void> {
  try {
    const selfId = selfSlackId(profile.user.slack_user_id);
    let selfRow = getPersonMemory(selfId);
    if (!selfRow) {
      // No SELF row — startup seed should have created it, but if a
      // migration / manual DB edit / race wiped it, re-seed now rather
      // than silently dropping the capture. seedAssistantSelf is
      // idempotent (only upserts when missing or assistant name
      // changes), so calling it here is safe.
      logger.warn('runSelfCapture: SELF row missing — re-seeding', { selfId });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { seedAssistantSelf } = require('../core/assistantSelf') as
        typeof import('../core/assistantSelf');
      seedAssistantSelf(profile);
      selfRow = getPersonMemory(selfId);
      if (!selfRow) {
        logger.warn('runSelfCapture: re-seed failed — skipping capture', { selfId });
        return;
      }
    }

    const existingNotes: Array<{ date: string; note: string }> = (() => {
      try { return JSON.parse(selfRow.notes || '[]'); } catch { return []; }
    })();

    const messages = getConversationHistory(threadTs);
    if (messages.length === 0) return;
    const transcript = chatToTranscript(messages, profile.assistant.name, ownerName);

    const userMsg = [
      'EXISTING NOTES about Maelle (do NOT re-emit any of these — same fact = skip):',
      '```',
      existingNotes.length === 0
        ? '(none yet)'
        : existingNotes.map(n => `[${n.date}] ${n.note}`).join('\n'),
      '```',
      '',
      'CONVERSATION TRANSCRIPT (Maelle + owner):',
      '```',
      transcript,
      '```',
      '',
      'What new Maelle-facts (if any) does this conversation reveal? JSON only.',
    ].join('\n');

    const resp = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 1000,
      system: SELF_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = resp.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('')
      .trim();
    const delta = parseSelfDelta(text);

    if (!delta || delta.notes.length === 0) {
      logger.info('runSelfCapture: no new Maelle-facts in this thread', { threadTs });
      return;
    }

    for (const note of delta.notes) {
      appendPersonNote(selfId, note);
    }
    logger.info('runSelfCapture: applied SELF notes', {
      threadTs, count: delta.notes.length,
    });
  } catch (err) {
    logger.warn('runSelfCapture: threw — non-fatal', {
      threadTs, err: String(err).slice(0, 200),
    });
  }
}
