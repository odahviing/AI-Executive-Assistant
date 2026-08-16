/**
 * v2.9.3 (#103) — end-of-chat capture pass.
 *
 * The colleague-self-write path was mute pre-v2.9.3: when a colleague
 * volunteered preferences ("4-6pm Sydney"), the system prompt didn't tell
 * Sonnet to call `update_person_profile`, so structured facts never
 * landed and the next conversation started cold. This module fills that
 * gap with a deterministic, code-side capture mechanism:
 *
 *   1. The 5-min background loop calls `runCapturePass(profile)`.
 *   2. It queries `conversation_threads` for DMs that went quiet 30+ min
 *      ago AND have new activity since the last capture
 *      (`findThreadsReadyForCapture`).
 *   3. For each ready thread, it asks the Connection whose 1:1 DM that
 *      channel is (`resolveChannelCounterpart`) and skips owner DMs. No
 *      transport client is touched here — this module knows people, not pipes.
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

import type Anthropic from '@anthropic-ai/sdk';
import type { UserProfile } from '../config/userProfile';
import { getConnection } from '../connections/registry';
import {
  findThreadsReadyForCapture,
  markThreadCaptured,
  getConversationHistory,
  getPersonMemory,
  updatePersonProfile,
  setCoreFieldWithProvenance,
  appendPersonNote,
  appendPersonInteraction,
  type PersonProfile,
} from '../db';
import { readPersonMemory, writePersonSection, slugifyName } from './peopleMemory';
import { selfSlackId } from '../core/assistantSelf';
import { getAnthropicClient } from '../llm/client';
import { MODEL_HAIKU } from '../llm/models';
import { isStrictIana } from '../utils/timezoneValidator';
import { config } from '../config';
import logger from '../utils/logger';
import { extractFirstJsonObject } from '../utils/extractJson';
import {
  FIXED_CATEGORIES,
  MAX_ACTIVE_CATEGORIES_PER_PERSON,
  getActiveSubjectsForPerson,
  getCategoryByLabel,
  getRecentTopicBeats,
  createSubject,
  recordTopicBeat,
  countActiveCategoriesForPerson,
  isCategoryActiveForPerson,
  markSubjectDead,
  threadHadSocialTurn,
  updateSubjectSummary,
  type SubjectToucher,
} from '../db/socialSubjects';

const SILENCE_MINUTES = 30;
const MAX_THREADS_PER_TICK = 20;
const HAIKU_MODEL = MODEL_HAIKU;

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
  // v3.5.x — language_preference is NO LONGER captured here. Outbound language
  // is DERIVED from the person's most recent inbound (people.resolveOutbound-
  // LanguageForPerson), so a one-off ("do you speak Hebrew?") must not freeze
  // into a durable steering attribute. Owner can still pin via update_person_profile.
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
- timezone: STRICT IANA Region/City form only — "America/New_York", "Europe/London", "Asia/Tokyo", "Australia/Sydney". When the chat names a nickname (ET, PT, BST, IST, "Sydney time"), map to IANA before emitting. SKIP the field if you can't confidently resolve to a Region/City form. Never emit bare abbreviations — they get rejected downstream.
- state: city / country mentioned as their location ("Boston", "Tel Aviv", "Israel")
- name_he: the native-script spelling of their name (Hebrew/Cyrillic/Arabic) if they wrote it or it became clear — capture it so it's never re-guessed
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
- interaction_summary: a one-sentence headline of what this chat was about (e.g. "Asked for 30-min meeting with the owner next week, settled on Thursday 14:00 her time"). ALWAYS emit this when the chat had any substantive content.
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

function chatToTranscript(messages: Array<{ role: string; content: string }>, humanName: string): string {
  return messages.map(m => {
    const speaker = m.role === 'assistant' ? `Maelle` : humanName || 'them';
    return `${speaker}: ${m.content}`;
  }).join('\n');
}

/**
 * Parse Haiku's strict-JSON output. Returns null on any parse failure —
 * caller treats null as "no deltas, skip apply but still mark captured".
 */
function parseDelta(raw: string): CaptureDelta | null {
  try {
    const match = extractFirstJsonObject(raw);
    if (!match) return null;
    return JSON.parse(match) as CaptureDelta;
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
  // Timezone is validated strictly: Haiku occasionally emits abbreviations
  // like "EST"/"IST"/"PST" despite the prompt asking for IANA. Luxon happily
  // resolves "IST" to Asia/Kolkata (+5:30, wrong for Israel) and the bad
  // value silently corrupts every cross-TZ slot render that follows. Mirror
  // the explicit-tool guard at `update_person_profile` — drop with a log
  // when the candidate fails the IANA check.
  if (delta.timezone) {
    if (isStrictIana(delta.timezone)) {
      setCoreFieldWithProvenance(slackId, 'timezone', delta.timezone, 'auto');
    } else {
      logger.warn('capturePass — dropped non-IANA timezone from Haiku capture', {
        slackId, candidate: delta.timezone,
      });
    }
  }
  if (delta.state) setCoreFieldWithProvenance(slackId, 'state', delta.state, 'auto');
  // v3.5.x — capture as an 'auto' guess (provenance-aware): freezes the spelling
  // so it's reused verbatim, but an owner correction can never be clobbered.
  if (delta.name_he) setCoreFieldWithProvenance(slackId, 'name_he', delta.name_he, 'auto');

  // profile_json fields — direct merge via updatePersonProfile.
  const profileUpdates: Partial<PersonProfile> = {};
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
  // v3.2.0 — md files are keyed by person_id now. A known colleague always has
  // a row (written at message arrival); fall back to the legacy name-slug only
  // if somehow absent so a write never silently drops.
  const personId = getPersonMemory(slackId)?.person_id ?? slugifyName(colleagueName);

  const residenceLines: string[] = [];
  if (delta.state) residenceLines.push(`Lives in ${delta.state}.`);
  if (delta.timezone) residenceLines.push(`Timezone: ${delta.timezone}.`);
  if (residenceLines.length > 0) {
    await writePersonSection({
      profile, personId, displayName: colleagueName,
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
      profile, personId, displayName: colleagueName,
      section: 'Workplace',
      text: workplaceLines.join(' '),
    });
  }

  const hoursLines: string[] = [];
  if (delta.working_hours) hoursLines.push(delta.working_hours);
  if (delta.response_speed) hoursLines.push(`Typical response speed: ${delta.response_speed}.`);
  if (hoursLines.length > 0) {
    await writePersonSection({
      profile, personId, displayName: colleagueName,
      section: 'Working hours',
      text: hoursLines.join(' '),
    });
  }

  const commLines: string[] = [];
  if (delta.communication_style) commLines.push(delta.communication_style);
  if (delta.name_he) commLines.push(`Native-script spelling: ${delta.name_he}.`);
  if (commLines.length > 0) {
    await writePersonSection({
      profile, personId, displayName: colleagueName,
      section: 'Communication style',
      text: commLines.join(' '),
    });
  }

  // History section — APPEND-style. We read the current section, append
  // a new dated bullet, write the whole block back.
  if (delta.interaction_summary) {
    const today = new Date().toISOString().split('T')[0];
    const newLine = `- [${today}] ${delta.interaction_summary}`;
    const currentMd = await readPersonMemory(profile, personId, colleagueName);
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
      profile, personId, displayName: colleagueName,
      section: "What we've discussed",
      text: newBody,
    });
  }
}

/**
 * Main entry. Called from the background loop every 5 min. Bounded by
 * MAX_THREADS_PER_TICK so a burst of ready threads can't blow the budget
 * on a single tick.
 */
export async function runCapturePass(profile: UserProfile): Promise<void> {
  if (!config.ANTHROPIC_API_KEY) return;  // dev mode without API key — silently skip

  // v4.1.x (#51) — "whose DM is this?" goes through the Connection, not through
  // `app.client.conversations.info`. This module holds a person's memory; it has
  // no business knowing which transport that person is on, and reaching into the
  // Slack client was the one place it did.
  //
  // Resolved ONCE per tick: it is per-profile and constant for the run, and the
  // absent case has to be handled before the loop, not inside it. A missing
  // transport is NOT a per-thread failure — a per-thread failure marks the thread
  // captured so it can't retry-storm, so treating "registry not ready" that way
  // would silently burn every pending capture on one bad tick. Bail instead and
  // pick them all up in five minutes.
  const conn = getConnection(profile.user.slack_user_id, 'slack');
  const resolveCounterpart = conn?.resolveChannelCounterpart?.bind(conn);
  if (!resolveCounterpart) {
    logger.warn('capturePass: no transport can resolve a DM counterpart — skipping this tick', {
      ownerUserId: profile.user.slack_user_id,
    });
    return;
  }

  const ready = findThreadsReadyForCapture(SILENCE_MINUTES, MAX_THREADS_PER_TICK);
  if (ready.length === 0) return;

  logger.info('capturePass: ready threads found', { count: ready.length });

  const anthropic = getAnthropicClient();
  const ownerSlackId = profile.user.slack_user_id;
  const ownerName = profile.user.name.split(' ')[0];

  for (const row of ready) {
    try {
      // 1. Whose DM is this? The Connection answers for 1:1 DMs ONLY and
      //    returns null for anything multi-party — which is exactly the answer
      //    this pass needs. A capture writes to ONE person's row, so being
      //    handed "a member" of a group DM would file one person's conversation
      //    onto another person's record. Null on failure too; either way we skip
      //    the thread. (Owner DMs resolve to the owner's id — handled below.)
      const colleagueId = await resolveCounterpart(row.channel_id);
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
        // v3.0 follow-up — subject reconciliation for OWNER's own subjects.
        // The owner's own gaming/movies/family/etc. social subjects live in
        // social_subjects keyed on person_slack_id = ownerSlackId. End-of-chat
        // Haiku decides match/create with full context. Replaces the per-turn
        // createSubject path that produced the 2026-05-22 "בידוק" duplicate.
        await runSubjectReconciliation(
          profile, anthropic, row.thread_ts,
          ownerSlackId, ownerName, ownerName,
          row.captured_at,
        );
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
      const currentMd = await readPersonMemory(profile, personRow.person_id, personRow.name) ?? '';

      // 3. Load chat transcript.
      const messages = getConversationHistory(row.thread_ts);
      if (messages.length === 0) {
        markThreadCaptured(row.thread_ts);
        continue;
      }
      const transcript = chatToTranscript(messages, personRow.name);

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
        // Haiku said "nothing new to learn" on the person-PROFILE side — but
        // subject reconciliation (step 6 below) is an INDEPENDENT judgment
        // ("did they answer a subject Maelle raised?") and must never be
        // skipped just because this unrelated pass produced no profile
        // delta. gh#198-LIB-9: an empty delta used to `continue` here,
        // which meant runSubjectReconciliation never ran for the thread, so
        // a person who replied (without teaching Haiku a new profile fact)
        // still had the raise counted against them at the next coda
        // trigger. Reconciliation is the ONLY writer of an answered raise
        // (recordSubjectAnswered/recordSubjectTouch have no other caller),
        // so it must run regardless of this branch's outcome — log and
        // fall through instead of bailing.
        logger.info('capturePass: no new deltas', { threadTs: row.thread_ts, colleague: personRow.name });
      } else {
        // 5. Apply deltas to DB + md mirror.
        await applyDelta(profile, colleagueId, personRow.name, delta);

        logger.info('capturePass: applied deltas', {
          threadTs: row.thread_ts,
          colleague: personRow.name,
          deltaKeys: Object.keys(delta),
        });
      }

      // 6. v3.0 follow-up — subject reconciliation for THE COLLEAGUE's
      // own subjects. Colleagues talking with Maelle about their gaming /
      // movies / family / etc. → end-of-chat Haiku decides match/create
      // with full context. Same protection as the owner-DM path: ID-based
      // matching prevents label-drift duplicates.
      await runSubjectReconciliation(
        profile, anthropic, row.thread_ts,
        colleagueId, personRow.name, ownerName,
        row.captured_at,
      );

      // 7. Stamp captured_at.
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
 * Haiku prompt for SELF capture.
 *
 * This row is her IDENTITY, and it is the narrowest capture in the system —
 * deliberately the opposite of the colleague pass. It was written "be generous"
 * and that is exactly what broke it: the pass mistook every owner-DM turn for a
 * lesson about her and wrote capability narration ("Maelle can perform a
 * comprehensive calendar analysis across a multi-week range") and owner
 * workflow preferences ("Owner prefers briefings with one event per line") onto
 * the SELF row. 50 of those filled the note cap inside six days and pushed out
 * every real identity fact — including the name-origin story this subsystem was
 * built for (#105) — so the ABOUT YOU block injected on every owner AND
 * colleague turn became a feature list, and asked about herself she had nothing
 * to answer from.
 *
 * Two consequences encoded below:
 *  - Only what the OWNER TAUGHT counts. Her own messages are narration, never a
 *    source of facts about her.
 *  - A capability is not an identity fact, and an owner workflow preference is
 *    L7 content — it belongs in the per-skill learned MD via
 *    update_my_preferences, never on this row.
 */
const selfSystemPrompt = (assistantName: string, ownerName: string) =>
  `You are maintaining the IDENTITY record of ${assistantName}, ${ownerName}'s executive assistant, from a conversation between the two of them.

You will be given:
1. The notes already on file about who ${assistantName} is
2. A conversation transcript (${assistantName} + ${ownerName})

Your job: identify NEW things ${ownerName} TAUGHT ${assistantName} about herself. This is a very narrow bar. Almost every conversation teaches nothing — the normal, correct answer is an empty list.

ONLY these count:
- Origin / name meaning / where the name came from / why she exists
- Identity facts: whether she's AI or human, age, when she was built, who built her
- Personality, character, or voice ${ownerName} described or corrected ("be warmer", "stop over-apologizing", "you're direct, not chatty")
- Lore or background ${ownerName} shared about her and why she is the way she is
- How she should refer to or describe HERSELF

TWO HARD EXCLUSIONS — these are the failure modes that wrecked this record:

1. CAPABILITIES ARE NOT IDENTITY. Anything of the form "she can X", "she is able to Y", "when asked to Z she does W", "she searches / analyses / checks / presents / offers" is a description of what her tools do. It teaches her nothing about who she is, and she already knows it. Never emit it — no matter how the conversation phrased it.

2. ${ownerName}'S PREFERENCES ARE NOT HER IDENTITY. "Owner prefers X formatted this way", "owner wants Y included", "owner asks for Z on Sundays" is a STANDING PREFERENCE of his. It has its own home (per-skill preference files) and does not belong on her record. The only preference-shaped thing that belongs here is one about her CHARACTER or VOICE — tone, warmth, directness, how she carries herself — never about the shape of an output, a workflow, a tool, or what to include in a report.

Also skip, as before:
- ${ownerName}'s own life / work / meetings / calendar / hobbies
- Facts about colleagues mentioned in the conversation
- Plot details of games / books / movies discussed (facts about THAT WORK, not about her — unless he explicitly tied it back, like "you were named after a character")
- Small talk that taught her nothing about herself

WHO SAID IT MATTERS: only ${ownerName}'s words teach. ${assistantName}'s own messages in the transcript are her narrating her work — never treat them as a source of facts about her. If the only support for a candidate note is something SHE said, drop it.

DEDUP RULE — strict: compare against the notes on file. A fact re-confirmed with new wording or extra colour = skip, unless the new context adds something genuinely substantive.

Output strict JSON. No prose, no markdown fences:
{ "notes": ["fact 1", "fact 2", ...] }

Each note: 1-2 sentences, third-person about her ("Named after…", "Speaks plainly, never over-apologises…", "Built in…"). Be specific; vague notes ("seems friendly") are useless later.

If nothing new was taught — the usual case — output { "notes": [] }.`;

interface SelfCaptureDelta {
  notes: string[];
}

function parseSelfDelta(raw: string): SelfCaptureDelta | null {
  try {
    const match = extractFirstJsonObject(raw);
    if (!match) return null;
    const parsed = JSON.parse(match);
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
 * Loads her existing SELF row notes, runs Haiku with the conversation + those
 * notes as context, and appends anything the OWNER TAUGHT her about herself via
 * appendPersonNote on the SELF: row. Idempotent across re-runs of the same chat:
 * Haiku sees existing notes and emits only deltas. Pure code-side capture —
 * Sonnet's in-turn note_about_self calls remain the primary path; this pass is a
 * safety net that catches identity facts Sonnet didn't save explicitly.
 *
 * The bar is narrow on purpose (see selfSystemPrompt): identity, lore and voice
 * only. Emitting nothing is the expected outcome for almost every thread.
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
      // idempotent (only upserts when missing, or a core identity field —
      // name / email / timezone — has drifted from the profile), so
      // calling it here is safe.
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
    const transcript = chatToTranscript(messages, ownerName);

    const assistantName = profile.assistant.name;
    const userMsg = [
      `NOTES ALREADY ON FILE about ${assistantName} (do NOT re-emit any of these — same fact = skip):`,
      '```',
      existingNotes.length === 0
        ? '(none yet)'
        : existingNotes.map(n => `[${n.date}] ${n.note}`).join('\n'),
      '```',
      '',
      `CONVERSATION TRANSCRIPT (${assistantName} + ${ownerName}):`,
      '```',
      transcript,
      '```',
      '',
      `Did ${ownerName} teach ${assistantName} anything new about who she IS? Remember: capabilities and his workflow preferences do not count, and only his words teach. JSON only.`,
    ].join('\n');

    const resp = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 1000,
      system: selfSystemPrompt(assistantName, ownerName),
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = resp.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('')
      .trim();
    const delta = parseSelfDelta(text);

    if (!delta || delta.notes.length === 0) {
      logger.info('runSelfCapture: nothing new taught about her in this thread', { threadTs });
      return;
    }

    for (const note of delta.notes) {
      appendPersonNote(selfId, note);
    }
    // Logged with the text: this row is small, durable and prompt-visible on
    // every turn, so what lands on it is worth being able to audit from the log.
    logger.info('runSelfCapture: applied SELF identity notes', {
      threadTs, count: delta.notes.length, notes: delta.notes.map(n => n.slice(0, 120)),
    });
  } catch (err) {
    logger.warn('runSelfCapture: threw — non-fatal', {
      threadTs, err: String(err).slice(0, 200),
    });
  }
}

// ── Subject reconciliation (end-of-chat) ─────────────────────────────────────
//
// v3.0 follow-up — full LLM-driven subject decisions, deferred from per-turn
// to end-of-chat. Per-turn classifier (`classifyTurn`) still detects
// kind/category/sentiment/direction per message and fires engagement signals
// against existing matched subject IDs, but no longer CREATES rows or
// records topic beats. Those writes happen here, where Haiku sees:
//   - the FULL conversation transcript
//   - the person's complete active-subjects list (id, label, last_touched,
//     recent topic_beats) — rich context, not just labels
//   - the 3-level model (category > subject > topic) + the 30 fixed categories
//   - 3 example shapes covering different category granularities
//
// Haiku returns ID-based decisions: `{ action: 'match', subject_id }` (must be
// an ID from the shown list), `{ action: 'create', category, label }` (must
// be one of the 30 categories), or `{ action: 'reject', subject_id? }` — gh#198
// (answer 7+8) — an explicit "not relevant/stop" (with subject_id, kills that
// row) or work content wrongly headed for a category (no subject_id, no row
// created). Each match/create decision carries the topic_beats touched in
// this chat; reject never does. Code applies the writes deterministically.
//
// Closes the 2026-05-22 "בידוק" duplicate bug: label-drift can't fork rows
// anymore because matching is by ID, not by label string. Same as the
// principle in the SELF capture path — judgment-class decisions go to the
// LLM with rich context; safety nets verify the LLM's output structurally
// (IDs exist, categories are in the fixed list).

const SUBJECT_RECONCILE_PROMPT_TEMPLATE = (categoryListCsv: string) => `You are reconciling social-subject memory for an AI executive assistant after a chat ended.

## The 3-level memory model

We track social interactions in three levels:

  Level 1 — CATEGORY: one of 30 fixed labels (you cannot create new categories). Pick from:
    ${categoryListCsv}

  Level 2 — SUBJECT: the recurring interest under ONE category. Granularity depends on the domain:
    - Long-running investment (a game played for weeks, a kid's school year, a job change, a side project, a relationship): each ONE is its own subject.
    - Recurring discovery activity (movie recommendations, restaurants to try, podcasts in rotation, news topics): ONE umbrella subject for the activity; individual items track as topic-beats under it.
    When in doubt, ask: "Will this same subject be touched repeatedly in future conversations?" — yes → subject, no → topic-beat under an umbrella.

  Level 3 — TOPIC BEAT: the specific moment under a subject. Short labels (2-5 words). A beat ALWAYS belongs to ONE subject under ONE category.

## Whose interest is it — read who OWNS the topic

A SUBJECT is the COLLEAGUE's OWN recurring interest, life thread, or activity — something THEY are genuinely invested in and will keep coming back to. Before you create or match one, read the transcript for WHO the topic actually belongs to. Don't react to topic words just because they APPEAR in the chat — anchor on what the colleague revealed about THEIR world (what they play, watch, build, who's in their family, where they're travelling).

Social subjects are the person's PERSONAL life — hobbies, family, interests, plans outside the job. They are NOT work.

Three ways a topic can show up that are NOT the colleague's social subject:

  - **It's WORK, not personal life.** This is the most common mistake. NEVER create or match a subject from work content: meetings, scheduling, calls, syncs, "the call with X", projects, POCs, interviews, candidates, deadlines, code, customers, launches, deliverables, status updates. Work is the JOB, not a hobby — it's never a social subject, no matter how often it comes up (e.g. "Idan call scheduling" is NOT a 'partner' subject; "the Ido interview" is NOT a 'learning' subject; "Brainrocket POC" is NOT a 'side_projects' subject). Work content always gets an explicit "reject" decision (see below) — never silence, never match/create.
  - **It's Maelle's, not theirs.** Topics Maelle brings up about HERSELF — her name, where it comes from, her origin/lore, how she works — are never the colleague's subjects, even when the colleague replies to them. Example: the colleague asks "what does your name mean?" and Maelle explains she's named after a character in some game. That game is MAELLE's lore — it says nothing about the colleague's interests. Output nothing for it (not even a reject — it was never a candidate). (Same for anything the OWNER raised about himself that the colleague merely heard.)
  - **They're just reacting, not invested.** A polite one-off reply, a passing question, or "oh I don't really know that / not my thing" is not a subject — there's no ongoing interest of theirs to track. A subject needs THEIR genuine, repeated investment. Output nothing for it.

Read the direction of the conversation: who introduced it, whose life/hobby/work it describes, and whether the colleague showed they actually care about it. When the topic is genuinely theirs AND personal (not work) → capture it. When it's Maelle's lore or a passing mention they didn't own → output nothing. When it's work → reject it explicitly (below).

## Explicit rejection — "reject"

Two, and only two, situations use action: "reject":

  1. **The person explicitly waves something off.** They say (in any words) that an existing subject isn't relevant any more, ask Maelle to stop bringing it up, or otherwise clearly signal "not this." Set subject_id to the existing row being rejected — this KILLS that subject; Maelle won't raise it again.
  2. **The chat's content is work**, not personal life (see above) — something that might otherwise look like it belongs to a category but is actually the job. Leave subject_id empty.

A "reject" never carries topic_beats — there's nothing to file them under.

## Pairing invariant — CRITICAL

A chat can touch MULTIPLE subjects across MULTIPLE categories. Each decision in your output is a SELF-CONTAINED unit:
  { category + subject + this subject's topic_beats }

NEVER put a beat from one category under a subject of another. If the chat covered both gaming (Stormvale Saga progress) and family (kid's school project), output TWO decisions — one with category=gaming and the Stormvale beats, one with category=family and the school beats. Beats stay with THEIR subject's category.

## Example shapes (English-only, illustrative)

  gaming:
    Subject: "Stormvale Saga"   (PLACEHOLDER, made-up title — deep, multi-week investment → one subject for the whole game)
      Topics under it: "beat the final boss", "act 1 plot twist", "endgame build choices", "weekend co-op run"

  movies:
    Subject: "Netflix movie recommendations"   (recurring discovery — umbrella over many individual films)
      Topics under it: "8+ rating filter", "Inspection movie", "weekend movie shortlist", "Heat watched"

  family:
    Subject: "Ophir's elementary school"   (ongoing life track — one subject for the whole school year)
      Topics under it: "first grade adjustment", "sick last Monday", "school project due Friday"

## Multi-subject example (one chat, two categories)

Chat covers "wrapped up Stormvale Saga last night, ending was wild" AND "Ophir had a rough school day". Output:

  [
    { category: "gaming",
      action: "match", subject_id: "subj_abc123",  // existing Stormvale Saga row
      sentiment: "positive",
      topic_beats: ["ending wrap-up", "wild ending reaction"] },
    { category: "family",
      action: "match", subject_id: "subj_def456",  // existing Ophir school row
      sentiment: "negative",
      topic_beats: ["rough school day"] }
  ]

Two decisions, two categories, beats stay properly scoped. Never collapse cross-category content into one decision.

## Running summary — MERGE, never overwrite

Each subject in the active list may show a "current summary" — everything learned about it across every past conversation, in prose. For every "match" or "create" decision, also output a "summary" field: the FULL updated summary for that subject, 5-10 sentences, in prose.

This is a MERGE, not a replacement with just this chat's news:
  - If a "current summary" is shown, your output must carry forward everything still true in it AND fold in whatever this chat added or changed (progress, a changed plan, a new detail). The result should read as one coherent, up-to-date account of the whole subject, not a diff.
  - If this chat genuinely added nothing beyond what the current summary already says, you may re-emit it unchanged.
  - If there is no "current summary" (a brand-new subject, or one this chat "create"s), write the summary from this chat's content alone.
  - Keep it to roughly 5-10 sentences — specific and concrete (what's actually happened, been said, or been decided), not vague ("they like gaming"). There is room to be generous; do not compress away real detail to hit the low end.
  - A "reject" never carries a summary.

## Your output

For each subject this chat touched:
  - category: REQUIRED for action="match"/"create" (one of the 30) — echo the matched row's category, or pick the right one of the 30 to create under. Omit for a work "reject" (there's no category to name); for a "reject" of an existing subject, echo its category.
  - action: "match", "create", or "reject"
  - subject_id: when action="match" — must be EXACTLY one of the IDs shown in the active list (no inventing, no modifying). Also set when action="reject" targets an existing subject (situation 1 above); leave empty for a work reject (situation 2).
  - subject_label: ONLY when action="create" — short umbrella label (2-6 words ideally)
  - sentiment: "positive" | "negative" | "neutral" — how the person feels about THIS subject in this chat (irrelevant for "reject"; default "neutral")
  - topic_beats: short labels (2-5 words each) for the beats THIS subject was touched in this chat — always empty for "reject"
  - summary: the merged running summary described above — required for "match"/"create", omitted for "reject"

You may output zero decisions (if the chat had no social content and no work to reject), one decision (typical), or several (if the chat spanned multiple subjects across one or more categories).

## Important rules

  - When matching, subject_id MUST be exactly one of the IDs shown. Hallucinated IDs are dropped (we'd rather lose a signal than create a wrong-row write).
  - When creating, category MUST be one of the 30.
  - Granularity is judgment-class — use the shapes above as patterns.
  - Topic-beats are always more specific than the subject. Under "Stormvale Saga", beats are individual moments; never put the game title itself as a beat.
  - DON'T duplicate. If an active subject already covers this content, match it — don't create a near-duplicate with slightly different wording.

Output JSON only. No prose, no markdown fences.`;

interface SubjectDecision {
  category: string;           // required for match/create (one of 30); optional for reject
  action: 'match' | 'create' | 'reject';
  subject_id?: string;        // when match, or when reject targets an existing subject
  subject_label?: string;     // when create
  sentiment: 'positive' | 'negative' | 'neutral';
  topic_beats: string[];
  summary?: string;           // merged running summary — match/create only (item 3)
}

interface ReconcileOutput {
  decisions: SubjectDecision[];
}

function parseReconcileOutput(raw: string): ReconcileOutput | null {
  try {
    const match = extractFirstJsonObject(raw);
    if (!match) return null;
    const parsed = JSON.parse(match) as { decisions?: unknown };
    if (!Array.isArray(parsed.decisions)) return null;
    const decisions: SubjectDecision[] = [];
    for (const raw of parsed.decisions) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const action = r.action;
      if (action !== 'match' && action !== 'create' && action !== 'reject') continue;
      const category = typeof r.category === 'string' ? r.category.toLowerCase().trim() : '';
      // category is structurally required for match/create; a "reject" of
      // work content has none to give (gh#198 — work is never a category).
      if (!category && action !== 'reject') continue;
      const sentimentRaw = typeof r.sentiment === 'string' ? r.sentiment.toLowerCase().trim() : 'neutral';
      const sentiment: 'positive' | 'negative' | 'neutral' =
        sentimentRaw === 'positive' || sentimentRaw === 'negative' ? sentimentRaw : 'neutral';
      const topic_beats = Array.isArray(r.topic_beats)
        ? r.topic_beats.filter((b: unknown): b is string => typeof b === 'string' && b.trim().length > 0)
        : [];
      decisions.push({
        category,
        action,
        subject_id: typeof r.subject_id === 'string' ? r.subject_id : undefined,
        subject_label: typeof r.subject_label === 'string' ? r.subject_label.trim() : undefined,
        sentiment,
        topic_beats,
        summary: typeof r.summary === 'string' && r.summary.trim() ? r.summary.trim() : undefined,
      });
    }
    return { decisions };
  } catch {
    return null;
  }
}

/**
 * End-of-chat subject reconciliation. Loads active subjects for `personSlackId`,
 * runs Haiku with the 3-level model + rich context, applies match/create
 * decisions + records topic beats. Both owner-DM and colleague-DM paths call
 * this — `personSlackId` scopes which person's subjects are reconciled.
 *
 * Fire-and-forget: any error caught + logged, never propagates.
 *
 * `priorCapturedAt` — gh#198 (answer 21a) — this thread's `captured_at` from
 * BEFORE this tick's processing (i.e. its previous capture, or null if never
 * captured). Threaded through so the raise-feedback pivot guard below can
 * tell "this is the very first reconciliation to see the raise" (the coda's
 * own delivery is what made this thread capture-ready) from "a genuinely
 * later cycle" — see logEngagement.ts's `allowPivotDetection`.
 */
async function runSubjectReconciliation(
  profile: UserProfile,
  anthropic: ReturnType<typeof getAnthropicClient>,
  threadTs: string,
  personSlackId: string,
  personName: string,
  ownerName: string,
  priorCapturedAt: string | null,
): Promise<void> {
  try {
    // 1. Active subjects with rich context (recent topic beats per subject)
    const subjects = getActiveSubjectsForPerson(personSlackId);

    // 2. Chat transcript
    const messages = getConversationHistory(threadTs);
    if (messages.length === 0) return;
    const transcript = chatToTranscript(messages, personName);

    // 3. Build the active-subjects block with beats
    const activeSubjectsBlock = (() => {
      if (subjects.length === 0) return '(no active subjects on file yet)';
      const lines: string[] = [];
      for (const s of subjects) {
        const beats = getRecentTopicBeats(s.id, 5);
        const beatsStr = beats.length > 0
          ? `\n      recent topics: ${beats.map(b => `"${b.label}"`).join(', ')}`
          : '';
        // item 3 (2026-08-16) — the existing merged summary, shown so Haiku
        // MERGES into it rather than starting from the beats alone. Absent
        // until the social_subjects.summary column lands (needs-dependency,
        // Handyman) — s.summary reads undefined until then and this line
        // simply doesn't render, no different from a subject with no summary yet.
        const summaryStr = s.summary ? `\n      current summary: "${s.summary}"` : '';
        const cat = s.category_id.replace(/^cat_global_/, '');
        lines.push(`    [${s.id}] "${s.label}" — category=${cat}, last touched ${s.last_touched_at}${summaryStr}${beatsStr}`);
      }
      return lines.join('\n');
    })();

    const ownerUserId = profile.user.slack_user_id;
    // Who actually said this, in this leg: the owner-DM leg reconciles the
    // owner's own subjects (owner is the source), the colleague-DM leg
    // reconciles the colleague's subjects (the colleague is the source).
    // Stamping both legs 'owner' (pre-o#228) made every colleague-taught
    // subject/beat indistinguishable from an owner-authored note about that
    // colleague, so buildSocialContextBlockById's created_by !== 'owner'
    // filter (people.ts) dropped them all.
    const toucher: SubjectToucher = personSlackId === ownerUserId ? 'owner' : 'colleague';
    const systemPrompt = SUBJECT_RECONCILE_PROMPT_TEMPLATE(FIXED_CATEGORIES.join(', '));
    const userMsg = [
      `Person being reconciled: ${personName}`,
      '',
      'ACTIVE SUBJECTS for this person:',
      activeSubjectsBlock,
      '',
      'CHAT TRANSCRIPT (just ended):',
      '```',
      transcript,
      '```',
      '',
      'Output JSON only: { "decisions": [{...}] } — empty array if no social subjects were touched.',
    ].join('\n');

    const resp = await anthropic.messages.create({
      model: HAIKU_MODEL,
      // 1500 → 3000 (item 3, 2026-08-16): each match/create decision now also
      // carries a 5-10 sentence merged summary (up to ~1800 chars). The old
      // budget covered labels + beats only; a multi-subject chat would now
      // risk truncating mid-JSON. Same call, same model tier — no new call,
      // no tier change, just headroom for the larger existing response.
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = resp.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('')
      .trim();
    const output = parseReconcileOutput(text);
    const decisions = output?.decisions ?? [];
    if (decisions.length === 0) {
      // gh#198 (answer 20) — a zero-decision chat is NOT resolved here. An
      // earlier pass fell through to step 5 on this branch so an ignored
      // raise's unanswered-raise counter would move — but that patched the
      // RECONCILIATION path, and the owner's ruling is explicit: "do not
      // also patch the reconciliation path... only the absence of an answer
      // moves [to the coda trigger]." Resolving it here fires on whatever
      // chat happens to conclude next, however soon and however unrelated to
      // the raised subject — not on the 24h/next-coda cadence the owner
      // specified. The single resolve-on-read pass now lives in
      // `directiveForProactiveSlot` (stateMachine.ts), which runs lazily, only
      // when the 24h gate reopens and a new coda is about to be considered.
      logger.info('runSubjectReconciliation: no subject decisions', { threadTs, personSlackId });
      return;
    }

    // 4. Apply decisions
    // Build id → category map for the category-pairing integrity check.
    const subjectCategoryById = new Map<string, string>();
    for (const s of subjects) {
      subjectCategoryById.set(s.id, s.category_id.replace(/^cat_global_/, ''));
    }
    let matchedCount = 0;
    let createdCount = 0;
    let rejectedCount = 0;
    let beatsRecorded = 0;
    const matchedSubjectIds: Array<{ id: string; sentiment: 'positive'|'negative'|'neutral' }> = [];

    for (const d of decisions) {
      let subjectId: string | null = null;

      if (d.action === 'reject') {
        // gh#198 (answer 7+8) — ONE mechanism for both an explicit "not
        // relevant/stop" and work content wrongly routed here. With a
        // subject_id, kill that existing row outright (not the raise
        // counter — immediate). Without one (work content, no row to
        // begin with), there's nothing to do but skip it — the point of
        // this branch is that match/create below never sees it.
        if (d.subject_id && subjectCategoryById.has(d.subject_id)) {
          try {
            markSubjectDead(d.subject_id);
          } catch (err) {
            logger.warn('runSubjectReconciliation: markSubjectDead threw', {
              threadTs, subjectId: d.subject_id, err: String(err).slice(0, 200),
            });
          }
          logger.info('runSubjectReconciliation: subject rejected (explicit stop)', {
            threadTs, personSlackId, subjectId: d.subject_id,
          });
        } else {
          logger.info('runSubjectReconciliation: work content rejected — no row created', {
            threadTs, personSlackId,
          });
        }
        rejectedCount++;
        continue;  // never records topic beats
      }

      if (d.action === 'match') {
        // ID-based safety: Haiku must return an ID from the shown list.
        // Hallucinated IDs get logged + skipped (don't silently create as
        // fallback — that would re-introduce the drift-creates-duplicates
        // pattern this whole pass exists to prevent).
        if (!d.subject_id || !subjectCategoryById.has(d.subject_id)) {
          logger.warn('runSubjectReconciliation: hallucinated subject_id, skipping', {
            threadTs, claimed: d.subject_id, activeCount: subjects.length,
          });
          continue;
        }
        // Category-pairing integrity: the category Haiku declared must
        // match the category of the matched subject. If they disagree,
        // Haiku scrambled the pairing — drop the decision (the beats
        // belong to a different category than this subject row).
        const actualCategory = subjectCategoryById.get(d.subject_id)!;
        if (d.category !== actualCategory) {
          logger.warn('runSubjectReconciliation: category/subject mismatch — dropping decision', {
            threadTs, claimedCategory: d.category, actualCategory, subject_id: d.subject_id,
          });
          continue;
        }
        subjectId = d.subject_id;
        matchedCount++;
        matchedSubjectIds.push({ id: subjectId, sentiment: d.sentiment });
      } else if (d.action === 'create') {
        if (!d.subject_label) {
          logger.warn('runSubjectReconciliation: create missing subject_label, skipping', {
            threadTs, decision: d,
          });
          continue;
        }
        const category = getCategoryByLabel(d.category);
        if (!category) {
          logger.warn('runSubjectReconciliation: category not in fixed set, skipping', {
            threadTs, claimed: d.category,
          });
          continue;
        }
        // gh#198-LIB-6 (answer 19) — deterministic code-side work gate. The
        // reconciler's own prompt is asked to reject work content (see the
        // "read who OWNS the topic" section above), but a thread whose turns
        // never classified as 'social' (classifyTurn, persisted per-turn via
        // markThreadHadSocialTurn in buildTurnContext.ts) cannot produce a
        // subject regardless of what the reconciler's prompt returns. Not a
        // second LLM call — classifyTurn already ran on every interactive
        // turn in this thread; not a keyword blocklist — it reads the same
        // classification the social directive itself already trusted.
        if (!threadHadSocialTurn(threadTs)) {
          logger.info('runSubjectReconciliation: blocked create — thread never classified as social', {
            threadTs, personSlackId, wouldBeCategory: category.label, label: d.subject_label,
          });
          continue;
        }
        // gh#198 (answer 15) — hard cap of 3 active categories per person,
        // enforced HERE at the creation site, not the picker. A 4th is
        // refused outright (block, never rotate an existing one out).
        // "Active" = the category already has real per-person standing
        // (social_person_category_scores.score > 0) — only gates a BRAND
        // NEW category; adding another subject to a category the person is
        // already active in is unaffected (the existing 5-per-category cap,
        // socialSubjects.ts createSubject, still applies independently).
        if (!isCategoryActiveForPerson(personSlackId, category.id)
            && countActiveCategoriesForPerson(personSlackId) >= MAX_ACTIVE_CATEGORIES_PER_PERSON) {
          logger.info('runSubjectReconciliation: blocked create — person already at the active-category cap', {
            threadTs, personSlackId, wouldBeCategory: category.label, cap: MAX_ACTIVE_CATEGORIES_PER_PERSON,
          });
          continue;
        }
        const created = createSubject({
          ownerUserId,
          personSlackId,
          categoryId: category.id,
          label: d.subject_label,
          createdBy: toucher,
        });
        subjectId = created.id;
        createdCount++;
        logger.info('runSubjectReconciliation: created subject', {
          threadTs, personSlackId, subjectId, category: category.label, label: d.subject_label,
        });
      }

      // Item 3 (2026-08-16) — write the MERGED running summary. Rides this
      // same reconciliation call (no second LLM call): Haiku already saw the
      // current summary in the active-subjects block above and returned the
      // complete merged text, so this is a plain write, not a merge decision.
      // Wrapped separately from topic-beat recording below so a summary write
      // failure (e.g. the column not existing yet) can never block beats that
      // otherwise would have landed.
      if (subjectId && d.summary) {
        try {
          updateSubjectSummary(subjectId, d.summary);
        } catch (err) {
          logger.warn('runSubjectReconciliation: updateSubjectSummary threw', {
            subjectId, err: String(err).slice(0, 200),
          });
        }
      }

      // Record topic beats under whichever subject (matched or created),
      // tagged with this decision's sentiment so the engagement signals
      // downstream see per-subject sentiment, not a turn-level average.
      if (subjectId && d.topic_beats.length > 0) {
        for (const beat of d.topic_beats) {
          try {
            recordTopicBeat({
              subjectId,
              label: beat,
              sentiment: d.sentiment,
              createdBy: toucher,
            });
            beatsRecorded++;
          } catch (err) {
            logger.warn('runSubjectReconciliation: recordTopicBeat threw', {
              subjectId, beat, err: String(err).slice(0, 200),
            });
          }
        }
      }
    }

    // 5. Engagement signals — applied at end-of-chat instead of per-turn.
    // For each MATCHED subject this chat touched:
    //   - If it's the recently-raised subject (Maelle initiated last) → fire
    //     raise-feedback signal (moves the CATEGORY score, resets the
    //     subject's unanswered-raise counter).
    //   - Otherwise → fire organic-match signal (moves the CATEGORY score
    //     +1/-1, capped 0..3).
    // Created subjects already moved their category's score by +1 inside
    // createSubject (socialSubjects.ts) — no extra signal needed. Rejected
    // decisions never reach this point (handled + `continue`d above).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { applyRaiseFeedbackForMatches, applyOrganicMatchSignal } = require('../core/social/logEngagement') as
        typeof import('../core/social/logEngagement');
      // Read the raised subject BEFORE raise-feedback runs: applyRaiseFeedbackForMatches
      // clears the raise marker (last_assistant_initiated_at → NULL), after which
      // getMostRecentRaisedSubject returns null and the organic loop below would fire
      // a SECOND signal on the very subject raise-feedback just credited (±2 instead
      // of ±1) — exactly the common "colleague replied to the coda" path.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getMostRecentRaisedSubject } = require('../db/socialSubjects') as
        typeof import('../db/socialSubjects');
      const raised = getMostRecentRaisedSubject(ownerUserId, personSlackId);
      // gh#198 (answer 21a) — GUARD THE PIVOT. Only let a non-match count as
      // "unanswered" once this thread has already been reconciled at least
      // once SINCE the raise happened (priorCapturedAt >= raise timestamp) —
      // i.e. this is a genuinely separate later cycle, not the coda's own
      // delivery-triggered first capture. A factual data check, not a clock.
      const allowPivotDetection = !raised
        || (priorCapturedAt != null
          && new Date(priorCapturedAt).getTime() >= new Date(raised.last_assistant_initiated_at!).getTime());
      applyRaiseFeedbackForMatches({
        ownerUserId,
        personSlackId,
        matchedSubjects: matchedSubjectIds,
        allowPivotDetection,
      });
      // Organic match — fire per matched subject that ISN'T the raised one
      // (raise-feedback already handled the raised case above).
      for (const m of matchedSubjectIds) {
        if (raised && m.id === raised.id) continue;  // already covered by raise-feedback
        applyOrganicMatchSignal({
          ownerUserId,
          personSlackId,
          matchedSubjectId: m.id,
          initiator: 'owner',  // end-of-chat applies on behalf of the person; signal is "spontaneous match"
          sentiment: m.sentiment,
        });
      }
    } catch (err) {
      logger.warn('runSubjectReconciliation: engagement signals threw — non-fatal', {
        threadTs, err: String(err).slice(0, 200),
      });
    }

    logger.info('runSubjectReconciliation: complete', {
      threadTs, personSlackId, matchedCount, createdCount, rejectedCount, beatsRecorded,
    });
  } catch (err) {
    logger.warn('runSubjectReconciliation: threw — non-fatal', {
      threadTs, err: String(err).slice(0, 200),
    });
  }
}
