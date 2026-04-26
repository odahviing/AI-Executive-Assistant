/**
 * Coord utility helpers.
 *
 * Three stateless helpers that don't touch coord DB state or send Slack
 * messages on their own:
 *   - determineSlotLocation: office/home + internal/external + party size →
 *     human-readable location label + isOnline flag for the invite.
 *   - interpretReplyWithAI: a Sonnet micro-prompt that parses a participant's
 *     scheduling reply into a structured verdict (yes/no/maybe + slot index +
 *     alternative + location overrides).
 *   - isCoordReplyByContext: a Sonnet yes/no check that decides whether an
 *     out-of-thread message continues an existing coord thread, or is a new
 *     request. Used for out-of-thread reply support.
 *
 * Pure — zero DB, zero transport. Moved from connectors/slack/coord/utils.ts
 * as part of the Connection-interface port (issue #1 sub-phase D).
 */

import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import type { UserProfile } from '../../../config/userProfile';
import { config } from '../../../config';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

// ── Location helpers ─────────────────────────────────────────────────────────

export interface SlotWithLocation {
  start: string;
  end: string;
  location: string;       // "Idan's Office" | "Meeting Room" | "Huddle" | "Teams" | "+972..." | custom
  isOnline: boolean;      // true = Teams link, false = Huddle (no Teams)
}

/**
 * Determines location for a slot based on the day (office/home),
 * participant count, and whether attendees are internal (same domain).
 *
 * v2.2.4 (bug 8b) — `anyParticipantRemote` short-circuits the in-person
 * branches. When ANY participant is currently traveling, joining remotely
 * by company policy, or otherwise can't physically be at the office, the
 * meeting MUST default to Teams (online). Owner could be at the office,
 * the colleague is in Boston — booking "Idan's Office" as the location is
 * a lie. Caller computes this flag from people_memory.currently_traveling
 * (or other signals) and passes it through.
 */
export function determineSlotLocation(
  slotStart: string,
  profile: UserProfile,
  participantCount: number,
  isInternal: boolean,
  customLocation?: string,
  anyParticipantRemote?: boolean,
): { location: string; isOnline: boolean } {
  if (customLocation) {
    // Phone number (e.g. "+972-54-123-4567"): no Teams link, location is the number itself
    const isPhone = /^\+?\d[\d\s\-().]{5,}$/.test(customLocation.trim());
    return { location: customLocation, isOnline: !isPhone };
  }

  // v2.2.4 (bug 8b) — any participant can't physically be there → online by
  // default. Skip every in-person branch below.
  if (anyParticipantRemote) {
    return { location: '', isOnline: true };
  }

  const dt = DateTime.fromISO(slotStart).setZone(profile.user.timezone);
  const dayName = dt.toFormat('EEEE');
  const isOfficeDay = (profile.schedule.office_days.days as string[]).includes(dayName);

  if (isOfficeDay) {
    // Office day: ≤3 people → Idan's Office, >3 → Meeting Room. Always Teams link.
    const location = participantCount > 3 ? 'Meeting Room' : `${profile.user.name.split(' ')[0]}'s Office`;
    return { location, isOnline: true };
  }

  // Home day
  if (isInternal) {
    return { location: 'Huddle', isOnline: false };
  }
  return { location: '', isOnline: true }; // external on home day = Teams only
}

// ── AI reply interpretation ──────────────────────────────────────────────────

/**
 * Uses Sonnet to interpret an ambiguous scheduling reply.
 *
 * Two modes:
 * - Normal (slots array): person was offered N slots, we figure out which one they picked
 * - Focus (focusSlot set): we asked them specifically if one slot works — yes/no/suggest alternative
 */
export async function interpretReplyWithAI(
  replyText: string,
  slots: string[],
  timezone: string,
  focusSlot?: string,
): Promise<{ response: 'yes' | 'no' | 'maybe'; slotIndex: number | null; suggestedAlternative: string | null; preferOnline?: boolean; locationOverride?: string }> {
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
