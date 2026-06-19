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
 * Uses Sonnet to interpret a participant's scheduling reply against the slots
 * they were offered: which slot (if any) they picked, a counter-offer, and
 * online/location preference — in any language. Forced structured output.
 */
export async function interpretReplyWithAI(
  replyText: string,
  slots: string[],
  timezone: string,
): Promise<{ response: 'yes' | 'no' | 'maybe'; slotIndex: number | null; suggestedAlternative: string | null; preferOnline?: boolean; locationOverride?: string }> {
  try {
    const onlineNote =
      `\n- preferOnline = true if they want it online/remote/Teams/Zoom/virtual/call/video; false if in-person/office/face-to-face; omit if not mentioned ("call" usually means online/Teams).` +
      `\n- locationOverride = a specific location they ask for (e.g. "meeting room", "huddle", "office"); omit otherwise.`;

    const slotLines = slots
      .map((s, i) => `${i + 1}. ${DateTime.fromISO(s).setZone(timezone).toFormat("EEEE d MMM 'at' HH:mm")}`)
      .join('\n');
    const systemPrompt =
      `You are parsing a scheduling reply, in ANY language. The person was offered these slots:\n${slotLines}\n\n` +
      `- response="yes" when they accept one of the offered slots; set slotIndex to the 1-indexed slot.\n` +
      `  • If what they say points to exactly ONE offered slot — a day name ("Monday"), a time ("3pm"), an ordinal ("the first one", "2"), or quoting the slot back — that IS a yes for that slot. Do NOT ask for more detail when only one offered slot can match.\n` +
      `  • If they accept but more than one offered slot still fits ("any works", "all good"), response="yes" and leave slotIndex unset.\n` +
      `- response="no" when they can't make any offered slot, OR they propose a time matching none of them — put that time in suggestedAlternative.\n` +
      `- response="maybe" only when truly unclear.` +
      onlineNote;

    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      tools: [{
        name: 'record_reply',
        description: 'Record the structured interpretation of the scheduling reply.',
        input_schema: {
          type: 'object' as const,
          properties: {
            response: { type: 'string', enum: ['yes', 'no', 'maybe'] },
            slotIndex: { type: 'integer', description: '1-indexed offered slot they accepted. Omit when none or any apply.' },
            suggestedAlternative: { type: 'string', description: 'A time they proposed that is not an offered slot. Omit if none.' },
            preferOnline: { type: 'boolean', description: 'Omit if not mentioned.' },
            locationOverride: { type: 'string', description: 'A specific location they ask for. Omit if none.' },
          },
          required: ['response'],
        },
      }],
      tool_choice: { type: 'tool', name: 'record_reply' },
      system: systemPrompt,
      messages: [{ role: 'user', content: replyText }],
    });

    const toolUse = result.content.find((b: any) => b.type === 'tool_use') as any;
    const v = (toolUse?.input ?? {}) as {
      response?: 'yes' | 'no' | 'maybe';
      slotIndex?: number;
      suggestedAlternative?: string;
      preferOnline?: boolean;
      locationOverride?: string;
    };
    const alt = v.suggestedAlternative?.trim();
    const loc = v.locationOverride?.trim();
    return {
      response: v.response ?? 'maybe',
      slotIndex: typeof v.slotIndex === 'number' ? v.slotIndex - 1 : null,
      suggestedAlternative: alt && alt.length > 0 ? alt : null,
      preferOnline: typeof v.preferOnline === 'boolean' ? v.preferOnline : undefined,
      locationOverride: loc && loc.length > 0 ? loc : undefined,
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
  proposedSlotLabels: string[] = [],
): Promise<boolean> {
  try {
    const peopleLine = participantNames.length
      ? `The meeting is with: ${participantNames.join(', ')}. `
      : '';
    // Give the model the times offered in THIS thread so a reply that quotes or
    // names one of them routes here — restores the quoted-slot routing the old
    // English label-matcher did, but as reasoning, not a substring regex.
    const slotsLine = proposedSlotLabels.length
      ? `The times offered in this thread were: ${proposedSlotLabels.join('; ')}. A message that names, quotes, or picks one of these times is about THIS thread. `
      : '';
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 10,
      system:
        `You're checking if a message is a continuation of an EXISTING scheduling thread titled "${subject}". ` +
        peopleLine +
        slotsLine +
        `Reply with only "yes" or "no". ` +
        `"yes" if the message refers to THIS specific meeting (picking/quoting one of the offered times, confirming, changing time for THIS one, mentioning a counterpart by name). ` +
        `"no" if the message is a BRAND-NEW scheduling request (different topic, different people, a new meeting entirely), even if it's about scheduling generally. ` +
        `When genuinely unsure, answer "no".`,
      messages: [{ role: 'user', content: text }],
    });
    const raw = ((result.content[0] as Anthropic.TextBlock).text ?? '').trim().toLowerCase();
    return raw.startsWith('yes');
  } catch {
    return false;
  }
}
