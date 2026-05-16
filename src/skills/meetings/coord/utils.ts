/**
 * Coord utility helpers.
 *
 * Two stateless helpers that don't touch coord DB state or send Slack
 * messages on their own:
 *   - interpretReplyWithAI: a Sonnet micro-prompt that parses a participant's
 *     scheduling reply into a structured verdict (yes/no/maybe + slot index +
 *     alternative + location overrides).
 *   - isCoordReplyByContext: a Sonnet yes/no check that decides whether an
 *     out-of-thread message continues an existing coord thread, or is a new
 *     request. Used for out-of-thread reply support.
 *
 * v2.7.0 — determineSlotLocation REMOVED. All location decisions now flow
 * through src/utils/resolveLocation.ts (one source of truth).
 *
 * Pure — zero DB, zero transport.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../../../llm/client';
import { DateTime } from 'luxon';
import type { UserProfile } from '../../../config/userProfile';
import { config } from '../../../config';

const anthropic = getAnthropicClient();

// ── Shared types ────────────────────────────────────────────────────────────

export interface SlotWithLocation {
  start: string;
  end: string;
  location: string;       // "" when fully online
  isOnline: boolean;      // true = Teams link on invite
}

// determineSlotLocation removed v2.7.0 — see src/utils/resolveLocation.ts.

// ── AI reply interpretation ──────────────────────────────────────────────────

/**
 * Uses Sonnet to interpret an ambiguous scheduling reply.
 *
 * Two modes:
 * - Normal (slots array): person was offered N slots, we figure out which one they picked
 * - Focus (focusSlot set): we asked them specifically if one slot works — yes/no/suggest alternative
 */
/**
 * v2.4.3 (B3) — code-side fast-path before the LLM call. When the participant's
 * reply contains a day-of-week (or day+time) that maps to exactly ONE of the
 * proposed slots, accept it directly. Closes the "Yael said 'Monday' for a
 * proposed Mon-12:00 + 2× Wed slots, Maelle re-asked 'what time?' instead of
 * just booking the only Monday slot" bug. Same for "Monday 3pm" → if a Mon
 * slot at 15:00 was proposed, that's a clear pick. Saves an LLM call AND is
 * deterministic — Sonnet sometimes mis-bound the slot index even when the
 * day was unambiguous.
 *
 * Returns { matched: true, slotIndex } when exactly one slot matches the
 * day (or day+time) in the reply; { matched: false } when 0 or ≥2 slots
 * match, falling through to the LLM interpretation.
 *
 * Multi-language: looks for English day names + Hebrew day names (ראשון
 * Sunday, שני Monday, ...). Times are HH:MM, h(am|pm), or HH digits only.
 */
function fastPathDayMatch(
  replyText: string,
  slots: string[],
  timezone: string,
): { matched: false } | { matched: true; slotIndex: number } {
  if (slots.length === 0) return { matched: false };
  const text = replyText.toLowerCase().trim();
  if (text.length === 0) return { matched: false };

  // Day name → 0-6 (Mon=1, Sun=7 in Luxon's weekday numbering)
  const DAY_TOKENS: Record<string, number> = {
    'sun': 7, 'sunday': 7, 'ראשון': 7, 'יום ראשון': 7,
    'mon': 1, 'monday': 1, 'שני': 1, 'יום שני': 1,
    'tue': 2, 'tues': 2, 'tuesday': 2, 'שלישי': 2, 'יום שלישי': 2,
    'wed': 3, 'wednesday': 3, 'רביעי': 3, 'יום רביעי': 3,
    'thu': 4, 'thur': 4, 'thurs': 4, 'thursday': 4, 'חמישי': 4, 'יום חמישי': 4,
    'fri': 5, 'friday': 5, 'שישי': 5, 'יום שישי': 5,
    'sat': 6, 'saturday': 6, 'שבת': 6,
  };

  let mentionedDay: number | null = null;
  for (const [token, weekday] of Object.entries(DAY_TOKENS)) {
    // Word-boundary check (English word boundary regex doesn't work on Hebrew,
    // so include it as substring for Hebrew tokens — collisions are unlikely)
    const isHebrew = /[֐-׿]/.test(token);
    const matched = isHebrew
      ? text.includes(token)
      : new RegExp(`\\b${token}\\b`).test(text);
    if (matched) {
      // If multiple days mentioned, abort fast-path
      if (mentionedDay !== null && mentionedDay !== weekday) return { matched: false };
      mentionedDay = weekday;
    }
  }
  if (mentionedDay === null) return { matched: false };

  // Optional time mention: "15:00", "3pm", "3 pm", "15", "at 15"
  let mentionedHour: number | null = null;
  let mentionedMinute = 0;
  const timeMatch = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (timeMatch) {
    mentionedHour = parseInt(timeMatch[1], 10);
    mentionedMinute = parseInt(timeMatch[2], 10);
  } else {
    const ampmMatch = text.match(/\b(\d{1,2})\s*(am|pm)\b/i);
    if (ampmMatch) {
      let h = parseInt(ampmMatch[1], 10);
      const isPm = ampmMatch[2].toLowerCase() === 'pm';
      if (isPm && h < 12) h += 12;
      if (!isPm && h === 12) h = 0;
      mentionedHour = h;
    }
  }

  // Find slots matching the day (and time, if mentioned)
  const matches: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    const dt = DateTime.fromISO(slots[i]).setZone(timezone);
    if (!dt.isValid) continue;
    if (dt.weekday !== mentionedDay) continue;
    if (mentionedHour !== null) {
      if (dt.hour !== mentionedHour) continue;
      if (dt.minute !== mentionedMinute) continue;
    }
    matches.push(i);
  }
  // Exactly one match → fast-path success. 0 or 2+ → fall through to LLM.
  if (matches.length === 1) return { matched: true, slotIndex: matches[0] };
  return { matched: false };
}

export async function interpretReplyWithAI(
  replyText: string,
  slots: string[],
  timezone: string,
  focusSlot?: string,
): Promise<{ response: 'yes' | 'no' | 'maybe'; slotIndex: number | null; suggestedAlternative: string | null; preferOnline?: boolean; locationOverride?: string }> {
  // v2.4.3 (B3) — fast-path: deterministic day (or day+time) match against
  // proposed slots. Skips the LLM when there's exactly one matching slot.
  // Only runs when offering a list of slots (not focusSlot mode).
  if (!focusSlot && slots.length > 0) {
    const fp = fastPathDayMatch(replyText, slots, timezone);
    if (fp.matched) {
      return {
        response: 'yes',
        slotIndex: fp.slotIndex,
        suggestedAlternative: null,
      };
    }
  }
  try {
    let systemPrompt: string;

    const onlineNote =
      `\n- preferOnline = true if they want it online/remote/Teams/Zoom/virtual/call/video call; false if in-person/office/face-to-face; null if not mentioned. Note: "call" usually means an online meeting (Teams).` +
      `\n- locationOverride = if they mention a specific location change (e.g. "meeting room", "huddle", "office"), extract it; otherwise null`;

    if (focusSlot) {
      const slotLabel = DateTime.fromISO(focusSlot).setZone(timezone).toFormat("EEEE d MMM 'at' HH:mm");
      systemPrompt =
        `You are parsing a scheduling reply. The person was asked if ${slotLabel} works for them.\n\n` +
        `Reply with a JSON object only: {"response":"yes"|"no"|"maybe","suggestedAlternative":string|null,"preferOnline":true|false|null,"locationOverride":string|null}\n` +
        `- "yes" = they accepted that slot\n` +
        `- "no" = they can't make that slot\n` +
        `- "maybe" = unclear\n` +
        `- suggestedAlternative = if they proposed a different time, extract it as a readable string; otherwise null` +
        onlineNote +
        `\nDo not include any other text.`;
    } else {
      const slotLines = slots
        .map((s, i) => `${i + 1}. ${DateTime.fromISO(s).setZone(timezone).toFormat("EEEE d MMM 'at' HH:mm")}`)
        .join('\n');
      systemPrompt =
        `You are parsing a scheduling reply. The person was offered these time slots:\n${slotLines}\n\n` +
        `Reply with a JSON object only: {"response":"yes"|"no"|"maybe","slotIndex":1|2|3|null,"suggestedAlternative":string|null,"preferOnline":true|false|null,"locationOverride":string|null}\n` +
        `- "yes" = they clearly accepted one of the EXACT offered slots (slotIndex = which one, 1-indexed; null if any/all work)\n` +
        `- "no" = they can't make any slot, OR they proposed completely different times that don't match any offered slot\n` +
        `- "maybe" = truly unclear\n` +
        `- suggestedAlternative = if they proposed a different time NOT in the offered slots, extract it; null if they accepted an offered slot\n` +
        `IMPORTANT: If they suggest a specific time like "10AM" that does NOT match any of the offered slots, set response="no" and suggestedAlternative to their proposed time. Only use "yes" when they clearly accept one of the slots listed above.` +
        onlineNote +
        `\nDo not include any other text.`;
    }

    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: replyText }],
    });

    const raw = ((result.content[0] as Anthropic.TextBlock).text ?? '').trim();
    const parsed = JSON.parse(raw);
    return {
      response: parsed.response ?? 'maybe',
      slotIndex: parsed.slotIndex != null ? parsed.slotIndex - 1 : null,
      suggestedAlternative: parsed.suggestedAlternative ?? null,
      preferOnline: parsed.preferOnline ?? undefined,
      locationOverride: parsed.locationOverride ?? undefined,
    };
  } catch {
    return { response: 'maybe', slotIndex: null, suggestedAlternative: null };
  }
}

/**
 * Uses Sonnet to determine if a message is a coordination reply
 * (for out-of-thread reply support).
 */
export async function isCoordReplyByContext(
  text: string,
  subject: string,
  participantNames: string[] = [],
): Promise<boolean> {
  try {
    const peopleLine = participantNames.length
      ? `The meeting is with: ${participantNames.join(', ')}. `
      : '';
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 10,
      system:
        `You're checking if a message is a continuation of an EXISTING scheduling thread titled "${subject}". ` +
        peopleLine +
        `Reply with only "yes" or "no". ` +
        `"yes" ONLY if the message refers to THIS specific meeting (picking a slot, confirming, changing time for THIS one, mentioning a counterpart by name). ` +
        `"no" if the message is a BRAND-NEW scheduling request (different topic, different people, a new meeting entirely), even if it's about scheduling generally. ` +
        `When in doubt between "same thread" and "new request", answer "no".`,
      messages: [{ role: 'user', content: text }],
    });
    const raw = ((result.content[0] as Anthropic.TextBlock).text ?? '').trim().toLowerCase();
    return raw.startsWith('yes');
  } catch {
    return false;
  }
}
