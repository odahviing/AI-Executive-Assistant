/**
 * SummarySkill (v1.7.2) — meeting transcript → summary → distribute.
 *
 * Three-stage state machine, one session per Slack thread:
 *   Stage 1 — Drafting:    transcript file lands, Sonnet drafts a structured
 *                          English summary (always English, even if transcript
 *                          is Hebrew). Posted to thread.
 *   Stage 2 — Iterating:   owner replies are absorbed as draft edits, style
 *                          rules (persisted to user_preferences), or share
 *                          intent. Classic chat-LLM iteration — small or large.
 *   Stage 3 — Sharing:     final summary distributed to named recipients;
 *                          action items with deadlines spawn summary_action_followup
 *                          tasks targeting internal Slack users.
 *
 * Persistence rule (per design): the full summary text is NEVER kept after share.
 * `summary_sessions.current_draft` is nulled on share (and after 7 days idle).
 * The meta we KEEP forever: meeting_date/time/subject/main_topic/attendees.
 *
 * Externals are never auto-resolved to Slack IDs (they're not in the workspace).
 * If a name is unclear, the skill asks the owner — never guesses.
 *
 * Slack messaging goes through src/connections/slack/messaging.ts — NOT through
 * coordinator.ts. This is the foundation for the issue #1 Connection split.
 */

import Anthropic from '@anthropic-ai/sdk';
import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config } from '../config';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import {
  getSummarySessionByThread,
  createSummarySession,
  replaceSummaryDraft,
  overrideSummarySessionWithNewTranscript,
  markSummaryShared,
  parseDraft,
  savePreference,
  getPreferences,
  type SummaryDraft,
  type SummaryAttendee,
  type SummaryActionItem,
} from '../db';
import { createTask } from '../tasks';
import {
  sendDM,
  sendMpim,
  postToChannel,
  findUserByName,
  findChannelByName,
} from '../connections/slack/messaging';
import { getCalendarEvents, type CalendarEvent } from '../connectors/graph/calendar';
import { selectRelevantKbForMeeting } from './knowledge';
import logger from '../utils/logger';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

// ── Helpers ─────────────────────────────────────────────────────────────────

function ownerCompanyDomain(profile: UserProfile): string | null {
  const at = profile.user.email.indexOf('@');
  return at >= 0 ? profile.user.email.slice(at + 1).toLowerCase() : null;
}

function isInternalEmail(email: string | undefined, profile: UserProfile): boolean {
  if (!email) return false;
  const domain = ownerCompanyDomain(profile);
  if (!domain) return false;
  return email.toLowerCase().endsWith(`@${domain}`);
}

// v1.8.8 — infer summary type from the draft subject so type-specific style
// preferences can be loaded on top of the global ones. Keyword-based; returns
// null for ambiguous/general meetings (use global rules only).
export function inferSummaryType(subject: string | undefined | null): string | null {
  if (!subject) return null;
  const s = subject.toLowerCase();
  if (/\binterview\b/.test(s)) return 'interview';
  if (/\b(1:1|one.?on.?one)\b/.test(s)) return 'one_on_one';
  if (/\b(standup|stand.?up|daily)\b/.test(s)) return 'standup';
  if (/\bretro(spective)?\b/.test(s)) return 'retro';
  if (/\b(biweekly|bi.?weekly|weekly)\b/.test(s)) return 'weekly';
  if (/\b(quarterly|q[1-4])\b/.test(s)) return 'quarterly';
  return null;
}

function summaryStylePromptBlock(ownerUserId: string, summaryType?: string | null): string {
  // v1.8.8 — layered preferences: global ('summary' category, backward-compat)
  // + optional type-specific ('summary_type_<type>' category). Type rules are
  // rendered AFTER global so Sonnet sees them last — last-wins in attention.
  const allPrefs = getPreferences(ownerUserId);
  const globalPrefs = allPrefs.filter(p => p.category === 'summary');
  const typePrefs = summaryType
    ? allPrefs.filter(p => p.category === `summary_type_${summaryType}`)
    : [];
  if (globalPrefs.length === 0 && typePrefs.length === 0) return '';

  const sections: string[] = [];
  if (globalPrefs.length > 0) {
    sections.push(`GLOBAL (apply to every summary):\n${globalPrefs.map(p => `- ${p.value}`).join('\n')}`);
  }
  if (typePrefs.length > 0) {
    sections.push(`SPECIFIC TO ${summaryType!.toUpperCase().replace(/_/g, ' ')} SUMMARIES (these win over global on conflict):\n${typePrefs.map(p => `- ${p.value}`).join('\n')}`);
  }
  return `\n\nOWNER'S SUMMARY STYLE PREFERENCES (apply unless the owner overrides for this specific summary):\n\n${sections.join('\n\n')}`;
}

/**
 * Pull calendar events around a timestamp (default: today + yesterday) to
 * use as context for matching the transcript to a meeting. Read-only,
 * uses the calendar connector directly — not a MeetingsSkill function.
 */
async function lookupNearbyEvents(
  profile: UserProfile,
  windowDate: DateTime,
): Promise<CalendarEvent[]> {
  const dayBefore = windowDate.minus({ days: 1 }).toFormat('yyyy-MM-dd');
  const dayAfter = windowDate.plus({ days: 1 }).toFormat('yyyy-MM-dd');
  try {
    return await getCalendarEvents(profile.user.email, dayBefore, dayAfter, profile.user.timezone);
  } catch (err) {
    logger.warn('Summary: calendar lookup failed', { err: String(err) });
    return [];
  }
}

// ── Sonnet calls ────────────────────────────────────────────────────────────

/**
 * Classify what an uploaded file looks like — a fresh transcript (new meeting)
 * or a corrected summary (the owner went over the previous summary, edited it
 * externally, and is bringing it back).
 *
 * Fails open to 'transcript' on parse/API error — safer than overwriting an
 * active draft accidentally.
 */
async function classifyUploadedFile(text: string): Promise<'transcript' | 'summary'> {
  const sample = text.slice(0, 6000);   // first ~6KB is plenty to classify
  const prompt = `Look at this text. Is it a meeting TRANSCRIPT (raw dialogue, multiple speakers labeled like "Speaker 1:" or "Brett:", question/answer flow, possibly timestamps) or a meeting SUMMARY (narrative paragraphs, structured sections, action items, no speaker dialogue)?

Output strict JSON only — no prose, no markdown, no fences:
{"kind": "transcript" | "summary"}

TEXT (first 6000 chars):
"""
${sample}
"""`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = ((resp.content[0] as Anthropic.TextBlock).text ?? '').trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    const parsed = JSON.parse(cleaned) as { kind?: string };
    return parsed.kind === 'summary' ? 'summary' : 'transcript';
  } catch (err) {
    logger.warn('Summary: file classification failed, defaulting to transcript', { err: String(err) });
    return 'transcript';
  }
}

/**
 * Stage 1 — Drafting. Sonnet receives the transcript + calendar context (if any)
 * + style preferences. Returns a structured English JSON draft.
 */
async function draftSummaryFromTranscript(params: {
  transcript: string;
  ownerUserId: string;
  ownerName: string;
  calendarEvent?: CalendarEvent;
  agendaText?: string;
  profile: UserProfile;
}): Promise<SummaryDraft> {
  const calBlock = params.calendarEvent
    ? `\n\nCALENDAR EVENT MATCH:\n- Subject: ${params.calendarEvent.subject}\n- Start: ${params.calendarEvent.start?.dateTime}\n- Attendees: ${(params.calendarEvent.attendees ?? []).map(a => `${a.emailAddress.name} <${a.emailAddress.address}>`).join(', ')}${params.agendaText ? `\n- Agenda/body: ${params.agendaText.slice(0, 2000)}` : ''}`
    : '';

  const inferredType = inferSummaryType(params.calendarEvent?.subject);
  const styleBlock = summaryStylePromptBlock(params.ownerUserId, inferredType);

  // v1.7.4 — when the KnowledgeBaseSkill is active, run a tiny relevance
  // pre-pass to pull any company/team context that would help ground this
  // summary. Skips silently if KB is empty, skill is off, or nothing matches.
  let kbBlock = '';
  const kbActive = (params.profile.skills as any)?.knowledge === true || (params.profile.skills as any)?.knowledge_base === true;
  if (kbActive) {
    const subjectHint = params.calendarEvent?.subject ?? '(unknown subject)';
    kbBlock = await selectRelevantKbForMeeting({
      profile: params.profile,
      meetingSubject: subjectHint,
      transcriptOpening: params.transcript.slice(0, 1000),
      anthropic,
    });
  }

  const prompt = `You are ${params.profile.assistant.name}, ${params.ownerName}'s personal executive assistant. The owner just sent you a meeting transcript and wants a summary they can share.

Your output is STRICT JSON ONLY — no prose, no markdown, no code fences. Use this shape:

{
  "subject": "short title for the meeting (English, even if transcript is Hebrew)",
  "main_topic": "one sentence — what was this meeting really about",
  "is_external": true|false,    // true if non-company-domain attendees were present
  "attendees": [
    { "name": "Brett Johnson", "email": "brett@reflectiz.com", "internal": true,  "source": "calendar" },
    { "name": "John Smith",    "email": "john@stripe.com",     "internal": false, "source": "transcript" }
  ],
  "paragraphs": [
    "3-8 paragraphs covering what was discussed. Each paragraph 2-4 sentences.",
    "Lead with WHAT was decided / discussed, not WHO said what (no he-said-she-said).",
    "For external meetings, frame from the team's perspective: 'The team met with John from Stripe…'."
  ],
  "action_items": [
    {
      "assignee_text": "Brett",            // raw label from transcript
      "description":   "Send the privacy presentation to Idan",
      "deadline_iso":  "2026-04-17T14:00:00",   // OPTIONAL — only if transcript explicitly stated a deadline
      "deadline_label":"by tomorrow"             // OPTIONAL — human form ("by Friday", "next week")
    }
  ],
  "speakers_unresolved": ["Speaker 2"]   // any "Speaker N" labels you couldn't confidently match to a name
}

CRITICAL RULES:
- Summary language is ALWAYS English. Even if the transcript is Hebrew.
- Do NOT invent attendees, action items, or quotes. If something isn't in the transcript, it doesn't go in the summary.
- Do NOT auto-resolve "Speaker 1" / "Speaker 2" to names unless the transcript itself names them. List them in speakers_unresolved instead.
- Action items: only flag items that were CLEARLY committed to (assignee + action), not vague "we should look into this".
- Deadlines: only fill deadline_iso when the transcript was explicit ("by tomorrow", "Friday morning", "by EOD"). If there was no deadline, omit both deadline fields.
- For dates without a year, assume current year. If "tomorrow" / "by Friday", compute relative to ${DateTime.now().setZone(params.profile.user.timezone).toFormat('EEEE, d MMMM yyyy')}.
- Prefer 4-6 paragraphs. Avoid one-sentence paragraphs.
- Owner of this meeting: ${params.ownerName} — never list them as an action-item assignee unless they are explicitly tasked.
${calBlock}${styleBlock}${kbBlock}

TRANSCRIPT:
"""
${params.transcript}
"""`;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = ((resp.content[0] as Anthropic.TextBlock).text ?? '').trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const parsed = JSON.parse(cleaned) as Partial<SummaryDraft>;

  // Defensive defaults so a partial reply doesn't crash render
  return {
    subject: String(parsed.subject ?? 'Meeting summary'),
    main_topic: String(parsed.main_topic ?? ''),
    is_external: Boolean(parsed.is_external ?? false),
    attendees: Array.isArray(parsed.attendees) ? parsed.attendees as SummaryAttendee[] : [],
    paragraphs: Array.isArray(parsed.paragraphs) ? parsed.paragraphs as string[] : [],
    action_items: Array.isArray(parsed.action_items) ? parsed.action_items as SummaryActionItem[] : [],
    speakers_unresolved: Array.isArray(parsed.speakers_unresolved) ? parsed.speakers_unresolved as string[] : undefined,
  };
}

/**
 * Parse a fully-edited summary text the owner sent back. Less constrained
 * than the transcript path — the structure is whatever the owner wrote,
 * we just need to re-extract the JSON shape so iteration continues.
 */
async function parseSummaryFromText(params: {
  summaryText: string;
  existing: SummaryDraft | null;
  profile: UserProfile;
}): Promise<SummaryDraft> {
  const seedBlock = params.existing ? `

PREVIOUS DRAFT (for attendee/action-item context — the owner's text below is authoritative for paragraphs):
${JSON.stringify(params.existing)}` : '';

  const prompt = `The owner sent back an edited meeting summary. Re-extract it into the same JSON shape used during drafting.

STRICT JSON ONLY (no prose, no markdown, no fences):
{
  "subject": "...",
  "main_topic": "...",
  "is_external": true|false,
  "attendees": [{ "name": "...", "email": "...", "internal": true|false, "source": "calendar"|"transcript"|"owner" }],
  "paragraphs": ["...", "..."],
  "action_items": [{ "assignee_text": "...", "description": "...", "deadline_iso": "ISO or omit", "deadline_label": "..." }],
  "speakers_unresolved": []
}

Rules:
- Treat the owner's text as authoritative for paragraphs and action items.
- Carry over attendees / subject from the previous draft if the owner didn't change them.
- Detect action items in the text (e.g. "Brett — send presentation by tomorrow") and structure them.
- Output English even if the source is Hebrew.${seedBlock}

OWNER'S EDITED SUMMARY:
"""
${params.summaryText}
"""`;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = ((resp.content[0] as Anthropic.TextBlock).text ?? '').trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const parsed = JSON.parse(cleaned) as Partial<SummaryDraft>;
  return {
    subject: String(parsed.subject ?? params.existing?.subject ?? 'Meeting summary'),
    main_topic: String(parsed.main_topic ?? params.existing?.main_topic ?? ''),
    is_external: Boolean(parsed.is_external ?? params.existing?.is_external ?? false),
    attendees: Array.isArray(parsed.attendees) ? parsed.attendees as SummaryAttendee[] : (params.existing?.attendees ?? []),
    paragraphs: Array.isArray(parsed.paragraphs) ? parsed.paragraphs as string[] : [],
    action_items: Array.isArray(parsed.action_items) ? parsed.action_items as SummaryActionItem[] : [],
    speakers_unresolved: Array.isArray(parsed.speakers_unresolved) ? parsed.speakers_unresolved as string[] : params.existing?.speakers_unresolved,
  };
}

// ── Render ──────────────────────────────────────────────────────────────────

function renderDraftForOwner(draft: SummaryDraft): string {
  const lines: string[] = [];
  lines.push(`*${draft.subject}*`);
  if (draft.main_topic) lines.push(`_${draft.main_topic}_`);

  if (draft.attendees.length > 0) {
    const internal = draft.attendees.filter(a => a.internal).map(a => a.name);
    const external = draft.attendees.filter(a => !a.internal).map(a => a.name);
    const parts: string[] = [];
    if (internal.length) parts.push(`Internal: ${internal.join(', ')}`);
    if (external.length) parts.push(`External: ${external.join(', ')}`);
    if (parts.length) lines.push(parts.join(' · '));
  }

  lines.push('');
  for (const p of draft.paragraphs) lines.push(p);

  if (draft.action_items.length > 0) {
    lines.push('');
    lines.push('*Action items*');
    for (const a of draft.action_items) {
      const who = a.assignee_slack_id ? `<@${a.assignee_slack_id}>` : a.assignee_text;
      const when = a.deadline_label ? ` — ${a.deadline_label}` : '';
      lines.push(`• ${who}: ${a.description}${when}`);
    }
  }

  if (draft.speakers_unresolved && draft.speakers_unresolved.length > 0) {
    lines.push('');
    lines.push(`_Note: I couldn't put a name to ${draft.speakers_unresolved.join(', ')} — let me know who they are and I'll fix it._`);
  }

  return lines.join('\n');
}

function renderDraftForShare(draft: SummaryDraft, profile: UserProfile): string {
  const lines: string[] = [];

  // Heading — different framing for internal-only vs external meetings
  const ownerFirst = profile.user.name.split(' ')[0];
  if (draft.is_external) {
    const externalNames = draft.attendees.filter(a => !a.internal).map(a => a.name);
    if (externalNames.length > 0) {
      lines.push(`*Summary — meeting with ${externalNames.join(', ')}*`);
    } else {
      lines.push(`*${draft.subject}*`);
    }
  } else {
    const names = draft.attendees.filter(a => a.internal && a.name !== profile.user.name).map(a => a.name);
    if (names.length > 0) {
      lines.push(`*Summary of ${ownerFirst}'s meeting with ${names.join(', ')}*`);
    } else {
      lines.push(`*${draft.subject}*`);
    }
  }

  lines.push('');
  for (const p of draft.paragraphs) lines.push(p);

  if (draft.action_items.length > 0) {
    lines.push('');
    lines.push('*Action items*');
    for (const a of draft.action_items) {
      const who = a.assignee_slack_id ? `<@${a.assignee_slack_id}>` : a.assignee_text;
      const when = a.deadline_label ? ` — ${a.deadline_label}` : '';
      lines.push(`• ${who}: ${a.description}${when}`);
    }
  }

  return lines.join('\n');
}

// ── v1.8.8 — passive style-rule learner ─────────────────────────────────────
// After each successful update_summary_draft, this classifier judges whether
// the owner's feedback was a GENERALIZABLE style rule worth saving. If so, it
// saves the rule to user_preferences automatically — no confirmation, no DM,
// no explicit tool call from Sonnet. Silent learning.
//
// Scope:
// - Saves only when Sonnet judges the rule would help FUTURE drafts (not a
//   one-off topic correction).
// - Saves under category='summary' for global rules, 'summary_type_<type>'
//   for type-specific rules (interview/one_on_one/standup/retro/weekly/
//   quarterly). Type inferred from the current draft's subject.
//
// Never blocks the iteration flow: runs asynchronously, fails open on any
// error (network, parse). Logs every decision at INFO level under
// "style-learner:" so pm2 logs show the trail.
async function classifyAndSaveStylePreference(params: {
  feedback: string;
  draftSubjectBefore: string;
  draftBefore: SummaryDraft;
  draftAfter: SummaryDraft;
  ownerUserId: string;
  anthropic: Anthropic;
}): Promise<void> {
  const { feedback, draftBefore, draftAfter, ownerUserId, anthropic } = params;
  const currentType = inferSummaryType(draftAfter.subject ?? params.draftSubjectBefore);

  const prompt = `You watch owner feedback on a meeting-summary draft and decide whether that feedback is a STYLE RULE worth saving for future summaries — or just a one-off topic/content correction.

OWNER'S FEEDBACK MESSAGE:
${feedback}

DRAFT BEFORE (abridged):
Subject: ${params.draftSubjectBefore}
Paragraphs: ${draftBefore.paragraphs.length}
Action items: ${draftBefore.action_items.length}

DRAFT AFTER EDIT (abridged):
Paragraphs: ${draftAfter.paragraphs.length}
Action items: ${draftAfter.action_items.length}

${currentType ? `INFERRED TYPE: ${currentType}` : 'INFERRED TYPE: (general / not categorized)'}

DECISION RULES:
- is_style_rule: true if the feedback is about HOW the summary is written (length, structure, voice, tone, format, sections, naming conventions). False if it's a topic/content correction ("that fact is wrong", "add this attendee", "remove the decision about X").
- generalizes: true if applying this rule would help FUTURE summaries of similar type. False if it only makes sense for THIS specific meeting.
- scope: 'global' if the rule should apply to every summary regardless of type. 'type-specific' if it's specific to interview / one-on-one / weekly / etc.
- type_name: required if scope='type-specific'. Choose from: interview, one_on_one, standup, retro, weekly, quarterly. If the rule is for a type not listed, use the closest match or set scope='global'.
- rule_key: a short snake_case identifier (2-4 words) for the rule, e.g. "paragraph_style", "owner_self_reference", "interview_sections".
- rule_value: a single sentence describing the rule in action form. E.g. "Write paragraphs per topic rather than one-line bullets." or "In summaries written from the owner's POV, use first person — never name the owner in third person."

EXAMPLES of save:
- Feedback "more paragraphs per topic than one-liner bullets" → is_style_rule=true, generalizes=true, scope=global
- Feedback "don't call me Idan in the summary, I was in the meeting" → is_style_rule=true, generalizes=true, scope=global (applies to all first-person summaries)
- Feedback "on interview summary focus on entry/positive/negative/follow-up" → is_style_rule=true, generalizes=true, scope=type-specific, type_name=interview

EXAMPLES of SKIP:
- Feedback "Q3 goals was wrong, should be Q2" → is_style_rule=false (topic correction)
- Feedback "add Amazia as attendee" → is_style_rule=false (content fix)
- Feedback "cut the part about budget" → is_style_rule=false (one-off content removal)

Output strict JSON only (no prose, no fences):
{
  "is_style_rule": true | false,
  "generalizes": true | false,
  "scope": "global" | "type-specific",
  "type_name": "interview" | "one_on_one" | "standup" | "retro" | "weekly" | "quarterly" | null,
  "rule_key": "snake_case_identifier",
  "rule_value": "one-sentence rule",
  "reason": "one short sentence explaining the decision"
}`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = ((resp.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined)?.text ?? '').trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.info('style-learner: parse failure — skip', { rawPreview: raw.slice(0, 200) });
      return;
    }
    const verdict = JSON.parse(jsonMatch[0]) as {
      is_style_rule: boolean;
      generalizes: boolean;
      scope: 'global' | 'type-specific';
      type_name: string | null;
      rule_key: string;
      rule_value: string;
      reason: string;
    };

    if (!verdict.is_style_rule || !verdict.generalizes) {
      logger.info('style-learner: skipped (not generalizable style rule)', {
        ownerUserId,
        feedbackPreview: feedback.slice(0, 80),
        reason: verdict.reason,
        is_style_rule: verdict.is_style_rule,
        generalizes: verdict.generalizes,
      });
      return;
    }
    if (!verdict.rule_key || !verdict.rule_value) {
      logger.warn('style-learner: verdict missing key/value — skip', { verdict });
      return;
    }

    const category = verdict.scope === 'type-specific' && verdict.type_name
      ? `summary_type_${verdict.type_name}`
      : 'summary';
    const normalizedKey = verdict.rule_key.replace(/[^a-z0-9_]/gi, '_').toLowerCase();

    savePreference({
      userId: ownerUserId,
      category,
      key: normalizedKey,
      value: verdict.rule_value,
      source: 'inferred',
    });

    logger.info('style-learner: rule saved', {
      ownerUserId,
      category,
      key: normalizedKey,
      value: verdict.rule_value,
      scope: verdict.scope,
      type_name: verdict.type_name,
      reason: verdict.reason,
      feedbackPreview: feedback.slice(0, 120),
    });
  } catch (err) {
    logger.warn('style-learner: classifier call failed — skip', { err: String(err) });
  }
}

// ── Action-item resolution ──────────────────────────────────────────────────

/**
 * Best-effort resolve action-item assignees to internal Slack IDs.
 * Strategy:
 *   1. Try to match the assignee_text to an existing draft attendee with internal=true
 *   2. If no attendee match, try findUserByName against the workspace and verify internal email
 *   3. External names: leave unresolved (no slack_id)
 */
async function resolveActionItemAssignees(
  app: App | undefined,
  botToken: string,
  draft: SummaryDraft,
  profile: UserProfile,
): Promise<SummaryDraft> {
  if (!app) return draft;
  const updatedItems: SummaryActionItem[] = [];

  for (const item of draft.action_items) {
    if (item.assignee_slack_id) {
      updatedItems.push(item);
      continue;
    }

    // 1) Try draft attendees first
    const attendeeMatch = draft.attendees.find(a =>
      a.internal && a.name.toLowerCase().includes(item.assignee_text.toLowerCase()),
    );
    if (attendeeMatch?.slackId) {
      updatedItems.push({
        ...item,
        assignee_slack_id: attendeeMatch.slackId,
        assignee_name: attendeeMatch.name,
        assignee_internal: true,
      });
      continue;
    }

    // 2) Try Slack workspace lookup
    try {
      const candidates = await findUserByName(app, botToken, item.assignee_text);
      const internalCandidate = candidates.find(c => isInternalEmail(c.email, profile));
      if (internalCandidate) {
        updatedItems.push({
          ...item,
          assignee_slack_id: internalCandidate.id,
          assignee_name: internalCandidate.real_name,
          assignee_internal: true,
        });
        continue;
      }
    } catch (err) {
      logger.warn('Summary: action-item resolution lookup failed', { name: item.assignee_text, err: String(err) });
    }

    // 3) Leave unresolved — external or unknown
    updatedItems.push({
      ...item,
      assignee_internal: false,
    });
  }

  return { ...draft, action_items: updatedItems };
}

// ── Skill ───────────────────────────────────────────────────────────────────

export class SummarySkill implements Skill {
  id = 'summary' as const;
  name = 'Summary';
  description = 'Drafts meeting summaries from transcripts, iterates with the owner, distributes to recipients, and creates follow-up tasks for action items.';

  getTools(_profile: UserProfile): Anthropic.Tool[] {
    return [
      {
        name: 'classify_summary_feedback',
        description: `INTERNAL — call this FIRST when the owner replies in a thread that has an active summary session. It decomposes the owner's message into a LIST of intents — one message can carry multiple asks (style rule + draft edit + share, all at once).

Possible intent kinds:
- STYLE_RULE: lasting preference about how summaries should look ("always shorter", "use first person", "empty line between paragraphs"). Each one becomes a learn_summary_style call.
- DRAFT_EDIT: change THIS specific summary (remove an attendee, fix a name, refocus a section, full rewrite). Each one becomes an update_summary_draft call.
- SHARE_INTENT: distribute the summary now ("send it to Brett", "post in #leadership"). Becomes a share_summary call. Apply outstanding draft edits BEFORE sharing.
- UNRELATED: the message isn't about the summary at all (owner pivoted to a separate question). Stop the summary flow and handle the message normally.

Always pass the owner's verbatim message in owner_message. Always handle ALL returned intents in this turn — don't drop any.`,
        input_schema: {
          type: 'object',
          properties: {
            owner_message: { type: 'string', description: 'The owner\'s most recent reply in the summary thread, verbatim' },
          },
          required: ['owner_message'],
        },
      },
      {
        name: 'learn_summary_style',
        description: `Persist a SUMMARY style preference for all future summaries. Use whenever the owner says how summaries should look — "always shorter", "use first person", "lead with action items", "empty line between paragraphs", "bold external participants".

CRITICAL: when in an active summary session, ALWAYS use this tool — NOT learn_preference. learn_preference saves to a different category that summaries don't read. They look similar but only learn_summary_style affects future summaries.

Do NOT use for per-meeting corrections like "Speaker 1 is Brett" or "remove Yael from attendees" — those are DRAFT_EDIT, use update_summary_draft.`,
        input_schema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Short snake_case label, e.g. "summary_perspective", "summary_paragraph_spacing"' },
            value: { type: 'string', description: 'The rule in plain English, e.g. "Write in first person — I/me/my, not Idan/he/his." or "One topic per paragraph, empty line between paragraphs."' },
          },
          required: ['key', 'value'],
        },
      },
      {
        name: 'update_summary_draft',
        description: `Apply an edit to the in-progress summary draft and re-render it for the owner. Use for any per-meeting change: add/remove sections, rewrite paragraphs, fix attendee names, add a missing action item, change focus.

The instruction is your interpretation of what the owner asked for. Be specific — Sonnet will use this to revise the draft.`,
        input_schema: {
          type: 'object',
          properties: {
            instruction: { type: 'string', description: 'Plain-English instruction for the revision, e.g. "Make the privacy section more detailed and shorter on the Q3 roadmap"' },
          },
          required: ['instruction'],
        },
      },
      {
        name: 'share_summary',
        description: `Stage 3 — distribute the final summary. Sends to each named recipient and creates summary_action_followup tasks for action items with deadlines.

Recipients are explicit and named — never inferred. The owner says "send to Brett and Moshe" → call with two user recipients. "Post in #leadership" → channel recipient. "Group DM with Brett, Moshe, and Sarah" → mpim recipient.

External attendees are excluded from the default-allowed set in v1.7.2 (they're not in Slack). To include an external in distribution, the owner must explicitly name them — and they'd need a Slack account to receive it (rare). For external sharing via email, the email Connection (planned) will handle it.

Action items WITH deadlines and a resolvable internal Slack ID → create a summary_action_followup task firing 2pm in the assignee's timezone on the deadline date.
Action items WITHOUT deadlines or with external/unmatched assignees → stay as text in the shared summary; no task.`,
        input_schema: {
          type: 'object',
          properties: {
            recipients: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['user', 'channel', 'mpim'] },
                  id_or_name: { type: 'string', description: 'Slack user ID (preferred) or display name; or channel name with or without #' },
                  display_name: { type: 'string', description: 'Optional human-readable label for confirmation back to the owner' },
                },
                required: ['type', 'id_or_name'],
              },
              description: 'Named recipients. For type=user provide a Slack user ID if you have one. For type=mpim provide a comma-joined list of user IDs in id_or_name OR pass type=user multiple times.',
            },
          },
          required: ['recipients'],
        },
      },
      {
        name: 'list_speaker_unknowns',
        description: 'Returns the unresolved speaker labels in the current draft (e.g. ["Speaker 2", "Speaker 4"]). Call when the owner asks "who are the speakers I need to name?".',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    const { profile, threadTs, channelId } = context;
    const ownerUserId = profile.user.slack_user_id;

    switch (toolName) {
      // ── Stage 2 classifier ────────────────────────────────────────────────
      case 'classify_summary_feedback': {
        const session = getSummarySessionByThread(threadTs);
        if (!session) {
          return { ok: false, reason: 'no_active_summary_session' };
        }
        const ownerMessage = String(args.owner_message ?? '');
        const draft = parseDraft(session);
        const draftBlock = draft ? `\n\nCURRENT DRAFT (subject: "${draft.subject}", paragraphs: ${draft.paragraphs.length}, action items: ${draft.action_items.length}, attendees: ${draft.attendees.map(a => a.name).join(', ')}):\n${draft.paragraphs.slice(0, 2).join(' ').slice(0, 600)}…` : '';

        const prompt = `Decompose the owner's reply in an active meeting-summary thread into a LIST of intents. One message can carry multiple asks — for example "use first person, paragraph per topic with blank lines, and Yael wasn't there" is THREE intents (two style rules + one draft edit). DON'T pick just one — return ALL of them.

Intent kinds:
1. STYLE_RULE — lasting preference for ALL future summaries
   Examples: "always shorter", "use first person", "empty line between paragraphs", "bold external names", "lead with action items", "include date at top"
   Output: { "kind": "STYLE_RULE", "style_key": "snake_case_label", "style_value": "the rule in plain English" }

2. DRAFT_EDIT — change THIS specific summary
   Examples: "Speaker 2 is Brett", "remove Yael from attendees", "rewrite the privacy section more detailed", "add action item: Brett to send presentation by Friday", "make it half the length", a wholesale rewrite pasted inline
   Output: { "kind": "DRAFT_EDIT", "instruction": "precise instruction for the revision" }

3. SHARE_INTENT — distribute the summary now
   Examples: "send to Brett and Moshe", "post in #leadership", "looks good, ship it", "send it"
   Output: { "kind": "SHARE_INTENT", "recipients_hint": "verbatim text describing recipients (e.g. 'Brett and Moshe', '#leadership')" }

4. UNRELATED — the message isn't about the summary at all (owner pivoted to a separate question)
   Examples: "by the way, what's my next meeting?", "remind me about the board prep tomorrow"
   Output: { "kind": "UNRELATED", "reason": "short why" }

Rules:
- A reply can have 1, 2, or many intents. Decompose carefully — don't merge a style rule with a draft edit just because they're in the same sentence.
- For STYLE_RULE: style_key is short snake_case (e.g. "summary_perspective", "summary_paragraph_spacing"), style_value is the rule in plain English suitable for injection into a future system prompt ("Write in first person — I/me/my, not the owner's name.").
- For DRAFT_EDIT: instruction must be clear and specific enough that a separate call with that instruction produces the right revision.
- If the reply is just "ok" or "thanks" with no actionable content, return [] (empty intents array).
- If it's UNRELATED, that's the ONLY intent in the array — don't mix UNRELATED with summary intents.

Output STRICT JSON only — no prose, no markdown, no fences:
{
  "intents": [
    { "kind": "STYLE_RULE", "style_key": "...", "style_value": "..." },
    { "kind": "DRAFT_EDIT", "instruction": "..." },
    { "kind": "SHARE_INTENT", "recipients_hint": "..." },
    { "kind": "UNRELATED", "reason": "..." }
  ]
}${draftBlock}

OWNER'S REPLY:
"""
${ownerMessage}
"""`;

        try {
          const resp = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 800,
            messages: [{ role: 'user', content: prompt }],
          });
          const raw = ((resp.content[0] as Anthropic.TextBlock).text ?? '').trim();
          const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
          const parsed = JSON.parse(cleaned) as { intents?: Array<Record<string, unknown>> };
          const intents = Array.isArray(parsed.intents) ? parsed.intents : [];

          // Build a directive next-action plan based on the intents found
          const styleCount = intents.filter(i => i.kind === 'STYLE_RULE').length;
          const editCount = intents.filter(i => i.kind === 'DRAFT_EDIT').length;
          const shareCount = intents.filter(i => i.kind === 'SHARE_INTENT').length;
          const unrelatedCount = intents.filter(i => i.kind === 'UNRELATED').length;

          logger.info('summary.stage2 — classified', {
            threadTs,
            intentCount: intents.length,
            styleCount,
            editCount,
            shareCount,
            unrelatedCount,
            preview: ownerMessage.slice(0, 80),
          });

          // Build the action plan as a clear sequence
          const planSteps: string[] = [];
          for (const intent of intents) {
            if (intent.kind === 'STYLE_RULE') {
              planSteps.push(`- Call learn_summary_style with key="${intent.style_key}" and value="${intent.style_value}"`);
            } else if (intent.kind === 'DRAFT_EDIT') {
              planSteps.push(`- Call update_summary_draft with instruction="${intent.instruction}"`);
            } else if (intent.kind === 'SHARE_INTENT') {
              planSteps.push(`- Apply any DRAFT_EDIT calls above first, then call share_summary with the recipients matching: "${intent.recipients_hint}"`);
            } else if (intent.kind === 'UNRELATED') {
              planSteps.push(`- This message wasn't about the summary (${intent.reason}). Acknowledge briefly and answer it normally — don't touch the summary.`);
            }
          }

          let mustReplyWith: string;
          if (intents.length === 0) {
            mustReplyWith = 'The owner\'s message had no actionable summary intent. Reply with a brief ack ("Got it.") and stop.';
          } else if (unrelatedCount > 0) {
            mustReplyWith = 'Handle the unrelated question normally. Don\'t mention the summary unless asked.';
          } else if (shareCount > 0) {
            mustReplyWith = 'After share_summary returns, write ONE confirmation summarizing every action you took (style rules saved + edits applied + recipients sent to). One short paragraph.';
          } else if (editCount > 0 && styleCount > 0) {
            mustReplyWith = 'After update_summary_draft returns, post the rendered draft + ONE short paragraph that mentions the style rules saved AND what you changed in the draft. Like: "Saved both as style rules — first person + empty lines between paragraphs. Updated this draft to drop Yael."';
          } else if (editCount > 0) {
            mustReplyWith = 'After update_summary_draft returns, post the rendered draft + ONE short note about what changed.';
          } else {
            // styleCount > 0 only
            mustReplyWith = 'After saving the style rule(s), reply with ONE short confirmation listing what you remembered ("Got it — I\'ll write summaries in first person from now on.").';
          }

          return {
            ok: true,
            intents,
            _action_plan: planSteps,
            _must_reply_with: mustReplyWith,
            _critical: 'You MUST execute every action in _action_plan and write the confirmation in _must_reply_with. Do NOT end this turn without text. Do NOT use learn_preference for any of the STYLE_RULE intents — use learn_summary_style.',
          };
        } catch (err) {
          logger.warn('summary.stage2 — classification failed, defaulting to single DRAFT_EDIT', { err: String(err) });
          // Safer default: treat as a draft edit using the verbatim message
          return {
            ok: true,
            intents: [{ kind: 'DRAFT_EDIT', instruction: ownerMessage }],
            _action_plan: [`- Call update_summary_draft with instruction="${ownerMessage}"`],
            _must_reply_with: 'After update_summary_draft returns, post the rendered draft + ONE short note about what changed.',
            _critical: 'You MUST execute the action and write a reply. Do NOT end this turn without text.',
          };
        }
      }

      // ── Persist style preference ──────────────────────────────────────────
      case 'learn_summary_style': {
        const key = String(args.key ?? '').trim();
        const value = String(args.value ?? '').trim();
        if (!key || !value) return { ok: false, reason: 'missing_key_or_value' };

        savePreference({
          userId: ownerUserId,
          category: 'summary',
          key: key.startsWith('summary_') ? key : `summary_${key}`,
          value,
          source: 'user_taught',
        });
        logger.info('summary.stage2 — style preference saved', { ownerUserId, key, value });
        return {
          ok: true,
          saved: true,
          key,
          value,
          _must_reply_with: 'If this is the only intent left in the action plan, write ONE short confirmation listing what you remembered ("Got it — from now on I\'ll [restate the rule].") and stop. If more intents remain, continue executing them; reply once at the end.',
        };
      }

      // ── Apply a draft edit and re-render ──────────────────────────────────
      case 'update_summary_draft': {
        const session = getSummarySessionByThread(threadTs);
        if (!session) return { ok: false, reason: 'no_active_summary_session' };
        const draft = parseDraft(session);
        if (!draft) return { ok: false, reason: 'no_current_draft' };

        const instruction = String(args.instruction ?? '').trim();
        if (!instruction) return { ok: false, reason: 'missing_instruction' };

        const currentType = inferSummaryType(draft.subject);
        const styleBlock = summaryStylePromptBlock(ownerUserId, currentType);
        const prompt = `You are revising an in-progress meeting summary based on the owner's instruction. Output the COMPLETE updated summary as STRICT JSON in the same shape — no prose, no markdown, no fences.

INSTRUCTION: ${instruction}

CURRENT DRAFT:
${JSON.stringify(draft, null, 2)}

Rules:
- Apply the instruction precisely. If unclear, make the most reasonable interpretation.
- Keep summary in English.
- Don't invent attendees or action items not previously in the draft (unless the instruction explicitly adds one).
- Preserve fields the instruction didn't touch.${styleBlock}

Output the full updated draft JSON.`;

        try {
          const resp = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }],
          });
          const raw = ((resp.content[0] as Anthropic.TextBlock).text ?? '').trim();
          const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
          const parsed = JSON.parse(cleaned) as Partial<SummaryDraft>;
          const updated: SummaryDraft = {
            subject: String(parsed.subject ?? draft.subject),
            main_topic: String(parsed.main_topic ?? draft.main_topic),
            is_external: Boolean(parsed.is_external ?? draft.is_external),
            attendees: Array.isArray(parsed.attendees) ? parsed.attendees as SummaryAttendee[] : draft.attendees,
            paragraphs: Array.isArray(parsed.paragraphs) ? parsed.paragraphs as string[] : draft.paragraphs,
            action_items: Array.isArray(parsed.action_items) ? parsed.action_items as SummaryActionItem[] : draft.action_items,
            speakers_unresolved: Array.isArray(parsed.speakers_unresolved) ? parsed.speakers_unresolved as string[] : draft.speakers_unresolved,
          };
          replaceSummaryDraft(threadTs, updated);
          logger.info('summary.stage2 — draft updated', {
            threadTs,
            instruction: instruction.slice(0, 100),
            paragraphCount: updated.paragraphs.length,
            actionItemCount: updated.action_items.length,
          });

          // v1.8.8 — passive style-rule learner. Runs asynchronously so it
          // doesn't block the reply back to owner. Judges whether this
          // feedback was a generalizable style rule worth saving.
          classifyAndSaveStylePreference({
            feedback: instruction,
            draftSubjectBefore: draft.subject,
            draftBefore: draft,
            draftAfter: updated,
            ownerUserId,
            anthropic,
          }).catch(err => logger.warn('style-learner: async run failed', { err: String(err) }));

          return {
            ok: true,
            rendered: renderDraftForOwner(updated),
            _must_reply_with: 'Post a reply containing: (1) ONE short sentence about what changed (e.g. "Updated to drop Yael."), then a blank line, then (2) the rendered draft verbatim from the `rendered` field above. Do NOT end this turn without writing this reply.',
          };
        } catch (err) {
          logger.error('summary.stage2 — draft update failed', { err: String(err) });
          return { ok: false, reason: 'update_failed', detail: String(err) };
        }
      }

      // ── List unresolved speakers ──────────────────────────────────────────
      case 'list_speaker_unknowns': {
        const session = getSummarySessionByThread(threadTs);
        if (!session) return { ok: false, reason: 'no_active_summary_session' };
        const draft = parseDraft(session);
        return {
          ok: true,
          unresolved: draft?.speakers_unresolved ?? [],
        };
      }

      // ── Stage 3 — Share ───────────────────────────────────────────────────
      case 'share_summary': {
        const session = getSummarySessionByThread(threadTs);
        if (!session) return { ok: false, reason: 'no_active_summary_session' };
        let draft = parseDraft(session);
        if (!draft) return { ok: false, reason: 'no_current_draft' };

        const app = context.app;
        if (!app) return { ok: false, reason: 'no_slack_app' };
        const botToken = profile.assistant.slack.bot_token;

        // Resolve action-item assignees BEFORE rendering for share so @mentions land
        draft = await resolveActionItemAssignees(app, botToken, draft, profile);
        replaceSummaryDraft(threadTs, draft);

        const rawRecipients = (args.recipients ?? []) as Array<{
          type: 'user' | 'channel' | 'mpim';
          id_or_name: string;
          display_name?: string;
        }>;
        if (!Array.isArray(rawRecipients) || rawRecipients.length === 0) {
          return { ok: false, reason: 'no_recipients' };
        }

        // Resolve recipients to concrete IDs
        const resolved: Array<{ type: 'user' | 'channel' | 'mpim'; id: string; name: string; ids?: string[] }> = [];
        const refused: Array<{ original: string; reason: string }> = [];
        for (const r of rawRecipients) {
          if (r.type === 'user') {
            // Already a slack ID?
            if (/^U[A-Z0-9]+$/.test(r.id_or_name)) {
              resolved.push({ type: 'user', id: r.id_or_name, name: r.display_name ?? r.id_or_name });
              continue;
            }
            const matches = await findUserByName(app, botToken, r.id_or_name);
            const first = matches.find(m => isInternalEmail(m.email, profile)) ?? matches[0];
            if (first) {
              resolved.push({ type: 'user', id: first.id, name: first.real_name });
            } else {
              refused.push({ original: r.id_or_name, reason: 'user not found in workspace' });
            }
          } else if (r.type === 'channel') {
            if (/^C[A-Z0-9]+$/.test(r.id_or_name)) {
              resolved.push({ type: 'channel', id: r.id_or_name, name: r.display_name ?? r.id_or_name });
              continue;
            }
            const matches = await findChannelByName(app, botToken, r.id_or_name);
            if (matches.length > 0) {
              resolved.push({ type: 'channel', id: matches[0].id, name: `#${matches[0].name}` });
            } else {
              refused.push({ original: r.id_or_name, reason: 'channel not found' });
            }
          } else if (r.type === 'mpim') {
            // Expect comma-separated slack IDs in id_or_name
            const ids = r.id_or_name.split(',').map(s => s.trim()).filter(Boolean);
            if (ids.length === 0) {
              refused.push({ original: r.id_or_name, reason: 'no user IDs supplied for mpim' });
              continue;
            }
            resolved.push({ type: 'mpim', id: ids.join(','), name: r.display_name ?? `MPIM(${ids.length})`, ids });
          }
        }

        if (resolved.length === 0) {
          return {
            ok: false,
            reason: 'all_recipients_refused',
            refused,
          };
        }

        // Render share text once
        const shareText = renderDraftForShare(draft, profile);

        // Send to each
        const sentTo: Array<{ type: 'user' | 'channel' | 'mpim'; id: string; name: string }> = [];
        const sendFailures: Array<{ name: string; reason: string }> = [];
        for (const r of resolved) {
          let outcome;
          if (r.type === 'user') outcome = await sendDM(app, botToken, r.id, shareText);
          else if (r.type === 'channel') outcome = await postToChannel(app, botToken, r.id, shareText);
          else outcome = await sendMpim(app, botToken, r.ids ?? [], shareText);

          if (outcome.ok) {
            sentTo.push({ type: r.type, id: r.id, name: r.name });
          } else {
            sendFailures.push({ name: r.name, reason: outcome.reason });
          }
        }

        // Create summary_action_followup tasks for items WITH deadlines AND resolved internal Slack IDs
        const followupTasksCreated: Array<{ task_id: string; target: string; description: string; due_at: string }> = [];
        const followupSkipped: Array<{ description: string; reason: string }> = [];
        for (const item of draft.action_items) {
          if (!item.deadline_iso) {
            followupSkipped.push({ description: item.description, reason: 'no_deadline' });
            continue;
          }
          if (!item.assignee_slack_id || !item.assignee_internal) {
            followupSkipped.push({ description: item.description, reason: 'assignee_external_or_unmatched' });
            continue;
          }
          // Skip if assignee IS the owner — Maelle DMing the owner about his own commitment is weird
          if (item.assignee_slack_id === ownerUserId) {
            followupSkipped.push({ description: item.description, reason: 'assignee_is_owner' });
            continue;
          }

          // Compute fire time = 2pm in target's timezone on the deadline date
          // Falls back to owner timezone if target's tz unknown
          const targetPersonRaw = item.assignee_slack_id;
          const dueAtForFire = computeFireTime({
            deadlineIso: item.deadline_iso,
            targetSlackId: targetPersonRaw,
            ownerTimezone: profile.user.timezone,
          });

          const taskId = createTask({
            owner_user_id: ownerUserId,
            owner_channel: channelId,
            owner_thread_ts: threadTs,
            type: 'summary_action_followup',
            status: 'new',
            title: `Check in with ${item.assignee_name ?? item.assignee_text} — ${item.description.slice(0, 60)}`,
            due_at: dueAtForFire.iso,
            skill_ref: String(session.id),
            context: JSON.stringify({
              summary_session_id: session.id,
              target_slack_id: item.assignee_slack_id,
              target_name: item.assignee_name ?? item.assignee_text,
              action_description: item.description,
              meeting_subject: draft.subject,
            }),
            who_requested: ownerUserId,
            target_slack_id: item.assignee_slack_id,
            target_name: item.assignee_name ?? item.assignee_text,
            skill_origin: 'summary',
            created_context: 'dm',
          });
          followupTasksCreated.push({
            task_id: taskId,
            target: item.assignee_name ?? item.assignee_text,
            description: item.description,
            due_at: dueAtForFire.iso,
          });
        }

        // Mark session as shared (clears current_draft per persistence rule)
        markSummaryShared({ threadTs, sharedTo: sentTo });

        logger.info('summary.stage3 — shared', {
          threadTs,
          summarySessionId: session.id,
          subject: draft.subject,
          recipientCount: sentTo.length,
          taskCount: followupTasksCreated.length,
          refused: refused.length,
          sendFailures: sendFailures.length,
          skill_origin: 'summary',
        });

        return {
          ok: true,
          sent_to: sentTo,
          tasks_created: followupTasksCreated,
          tasks_skipped: followupSkipped,
          refused,
          send_failures: sendFailures,
          _must_reply_with: 'Reply to the owner with a short confirmation: who got it (names from sent_to), how many follow-up tasks were created (and to whom), and any refusals/failures. Be human and brief — one or two sentences. Do NOT end this turn without writing this confirmation.',
        };
      }

      default:
        return null;
    }
  }

  getSystemPromptSection(profile: UserProfile): string {
    const ownerFirst = profile.user.name.split(' ')[0];
    return `## SUMMARIES (meeting transcript → summary → distribute)

When ${ownerFirst} uploads a transcript file, the system creates a summary session for that thread automatically — the draft is already posted to the thread before your turn runs. Your job is to handle his FOLLOW-UP messages in that thread (Stage 2 iteration) and his SHARE request (Stage 3).

STAGE 2 — Iterating on the draft:
- ANY reply from ${ownerFirst} in a thread with an active summary session → call classify_summary_feedback first to decide what to do.
- Returns one of: STYLE_RULE (persist), DRAFT_EDIT (revise), SHARE_INTENT (distribute).
- STYLE_RULE → call learn_summary_style with the key/value extracted, then a one-line acknowledgement ("Got it — I'll remember that for future summaries.").
- DRAFT_EDIT → call update_summary_draft with a precise instruction (you interpret what they want). Reply with the rendered draft and ONE short sentence about what changed.
- SHARE_INTENT → go to Stage 3 (share_summary).

STAGE 3 — Sharing:
- The owner names recipients explicitly. Never infer.
  - "Send to Brett and Moshe" → two type=user recipients
  - "Post in #leadership" → type=channel recipient
  - "DM the three of us — me, Brett, Sarah" → type=mpim with comma-joined slack IDs
- External attendees (not in our Slack workspace) CANNOT receive the summary — there's no Slack account to send to. Email distribution is planned but not yet built. If the owner asks to share with an external person, say so plainly: "I can't DM John from CompanyX yet — he's not in our Slack. We're adding email distribution; for now you'd need to forward it yourself."
- Action items in the summary:
  - With a deadline + internal Slack assignee → I'll DM that person at 2pm their local time on the deadline to check status; their reply comes back to you.
  - Without a deadline OR external/unmatched assignee → stays as text in the shared summary, no task.
  - Don't promise specific follow-up timing for items I won't actually track.

UNRESOLVED SPEAKERS:
- The draft may have "Speaker 2" / "Speaker 4" placeholders if the transcript didn't name them. Call list_speaker_unknowns if ${ownerFirst} asks who's still unnamed. Treat naming corrections from him as DRAFT_EDIT.

LANGUAGE:
- Summaries are ALWAYS in English even if the source transcript was Hebrew. Don't translate at owner's request — that's a deliberate product rule.

WHAT NEVER GETS PERSISTED:
- The full summary text. After share, the draft is wiped. Meta we KEEP: meeting date/time/subject/main topic/attendees. If ${ownerFirst} asks about a past meeting, you can recall the meta but not the paragraph text.

WHAT GETS PERSISTED:
- Style preferences via learn_summary_style. They apply to ALL future summaries automatically — don't re-apply per-meeting.`;
  }
}

// ── Helpers (private) ───────────────────────────────────────────────────────

function computeFireTime(params: {
  deadlineIso: string;
  targetSlackId: string;
  ownerTimezone: string;
}): { iso: string; usedTimezone: string } {
  // Pull target's timezone from people_memory
  let targetTz: string | undefined;
  try {
    // Lazy import to avoid circular deps at module load
    const { getPersonMemory } = require('../db');
    const person = getPersonMemory(params.targetSlackId);
    targetTz = person?.timezone ?? undefined;
  } catch (_) { /* fall back below */ }

  const tz = targetTz ?? params.ownerTimezone;

  // Take the deadline's DATE in the chosen timezone, fire at 2pm local
  let datePart: string;
  try {
    datePart = DateTime.fromISO(params.deadlineIso).setZone(tz).toFormat('yyyy-MM-dd');
  } catch {
    // If parse fails, use the date portion of the input verbatim
    datePart = params.deadlineIso.slice(0, 10);
  }
  const fireAtLocal = DateTime.fromISO(`${datePart}T14:00:00`, { zone: tz });
  return { iso: fireAtLocal.toUTC().toISO()!, usedTimezone: tz };
}

// ── Public helpers used by the Slack file_share branch ──────────────────────

export interface IngestTranscriptResult {
  kind: 'created' | 'overridden_new_meeting' | 'replaced_with_corrected_summary';
  draft: SummaryDraft;
  rendered: string;
  sessionId: number;
}

/**
 * Called by app.ts when a .txt file lands in DM. Decides between three paths
 * based on existing-session presence + content classification:
 *   - No existing session → create new
 *   - Existing + content looks like transcript → override (new meeting)
 *   - Existing + content looks like summary → replace draft (corrected version)
 */
export async function ingestTranscriptUpload(params: {
  text: string;
  caption: string;
  ownerUserId: string;
  threadTs: string;
  channelId: string;
  profile: UserProfile;
}): Promise<IngestTranscriptResult> {
  const existing = getSummarySessionByThread(params.threadTs);

  // Classify what we received (only matters if a session already exists in this thread)
  let contentKind: 'transcript' | 'summary' = 'transcript';
  if (existing) {
    contentKind = await classifyUploadedFile(params.text);
  }

  // Try calendar correlation if the caption hints at a meeting time / "today"
  const calendarMatch = await tryCalendarMatch(params.caption, params.profile);
  const meetingDateTime = calendarMatch
    ? DateTime.fromISO(calendarMatch.start.dateTime, { zone: calendarMatch.start.timeZone || params.profile.user.timezone })
    : DateTime.now().setZone(params.profile.user.timezone);

  // ── Branch A: NEW SESSION (or override-as-new-transcript) ────────────────
  if (!existing || contentKind === 'transcript') {
    const draft = await draftSummaryFromTranscript({
      transcript: params.text,
      ownerUserId: params.ownerUserId,
      ownerName: params.profile.user.name,
      calendarEvent: calendarMatch ?? undefined,
      agendaText: calendarMatch?.bodyPreview,
      profile: params.profile,
    });

    // Mark internal/external on attendees by domain (overrides whatever Sonnet wrote)
    draft.attendees = draft.attendees.map(a => ({
      ...a,
      internal: isInternalEmail(a.email, params.profile),
    }));
    draft.is_external = draft.attendees.some(a => !a.internal && a.email);

    if (existing) {
      overrideSummarySessionWithNewTranscript({
        threadTs: params.threadTs,
        draft,
        meetingDate: meetingDateTime.toFormat('yyyy-MM-dd'),
        meetingTime: meetingDateTime.toFormat('HH:mm'),
        transcriptChars: params.text.length,
      });
      logger.info('summary.stage1 — session OVERRIDDEN with new transcript', {
        threadTs: params.threadTs,
        sessionId: existing.id,
        subject: draft.subject,
        attendeeCount: draft.attendees.length,
        actionItemCount: draft.action_items.length,
        transcriptChars: params.text.length,
        skill_origin: 'summary',
      });
      return { kind: 'overridden_new_meeting', draft, rendered: renderDraftForOwner(draft), sessionId: existing.id };
    }

    const session = createSummarySession({
      ownerUserId: params.ownerUserId,
      threadTs: params.threadTs,
      channelId: params.channelId,
      draft,
      meetingDate: meetingDateTime.toFormat('yyyy-MM-dd'),
      meetingTime: meetingDateTime.toFormat('HH:mm'),
      transcriptChars: params.text.length,
    });
    logger.info('summary.stage1 — session CREATED', {
      threadTs: params.threadTs,
      sessionId: session.id,
      subject: draft.subject,
      attendeeCount: draft.attendees.length,
      actionItemCount: draft.action_items.length,
      transcriptChars: params.text.length,
      calendarMatch: !!calendarMatch,
      skill_origin: 'summary',
    });
    return { kind: 'created', draft, rendered: renderDraftForOwner(draft), sessionId: session.id };
  }

  // ── Branch B: EXISTING SESSION + content is a corrected summary ──────────
  const existingDraft = parseDraft(existing);
  const updated = await parseSummaryFromText({
    summaryText: params.text,
    existing: existingDraft,
    profile: params.profile,
  });
  updated.attendees = updated.attendees.map(a => ({
    ...a,
    internal: isInternalEmail(a.email, params.profile),
  }));
  updated.is_external = updated.attendees.some(a => !a.internal && a.email);

  replaceSummaryDraft(params.threadTs, updated);
  logger.info('summary.stage1 — corrected summary REPLACED draft (same meeting)', {
    threadTs: params.threadTs,
    sessionId: existing.id,
    subject: updated.subject,
    paragraphCount: updated.paragraphs.length,
    actionItemCount: updated.action_items.length,
    transcriptChars: params.text.length,
    skill_origin: 'summary',
  });
  return { kind: 'replaced_with_corrected_summary', draft: updated, rendered: renderDraftForOwner(updated), sessionId: existing.id };
}

/**
 * Try to match the caption to a calendar event. Best-effort, fails silently.
 * If the caption mentions a time ("2pm", "today's meeting", "with Brett"),
 * pull events ±1 day and let Sonnet pick the most likely match.
 */
async function tryCalendarMatch(
  caption: string,
  profile: UserProfile,
): Promise<CalendarEvent | null> {
  if (!caption.trim()) return null;

  const today = DateTime.now().setZone(profile.user.timezone);
  const events = await lookupNearbyEvents(profile, today);
  if (events.length === 0) return null;

  // Filter to events that have already STARTED (a transcript is usually for a meeting that happened)
  const now = DateTime.now();
  const candidates = events.filter(e => {
    try {
      const start = DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone || profile.user.timezone });
      return start <= now.plus({ minutes: 15 });   // include ones starting very soon (in case owner uploads right after)
    } catch {
      return false;
    }
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Multiple candidates — narrow Sonnet pass to pick best match
  const candidateBlock = candidates.slice(0, 12).map((e, i) => {
    const attendees = (e.attendees ?? []).map(a => a.emailAddress.name).slice(0, 6).join(', ');
    return `${i}. "${e.subject}" at ${e.start.dateTime} (attendees: ${attendees || 'n/a'})`;
  }).join('\n');

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 50,
      messages: [{ role: 'user', content: `OUTPUT FORMAT: a single line of JSON, nothing else. Do not explain. Do not add prose.
{"index": <integer>}

The owner uploaded a meeting transcript with this caption: "${caption}".

Pick the BEST matching calendar event index from the list. Consider time mentions ("2pm", "this morning"), participant names, subject keywords. If none clearly matches, output {"index": -1}.

CANDIDATES:
${candidateBlock}

Reply with ONLY {"index": N} — no other text.` }],
    });
    const raw = ((resp.content[0] as Anthropic.TextBlock).text ?? '').trim();
    // Tolerant parse: strip code fences, then if the response has prose,
    // pull the first {...} block out before parsing. Sonnet sometimes ignores
    // the strict-format instruction on this kind of selection prompt.
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    if (!cleaned.startsWith('{')) {
      const jsonBlock = cleaned.match(/\{[^{}]*"index"[^{}]*\}/);
      if (jsonBlock) cleaned = jsonBlock[0];
    }
    const parsed = JSON.parse(cleaned) as { index?: number };
    if (typeof parsed.index === 'number' && parsed.index >= 0 && parsed.index < candidates.length) {
      return candidates[parsed.index];
    }
  } catch (err) {
    logger.warn('summary: calendar candidate selection failed', { err: String(err) });
  }

  return null;
}

export { renderDraftForOwner };
