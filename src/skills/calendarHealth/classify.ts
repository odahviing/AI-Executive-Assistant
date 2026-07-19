/**
 * classify — extracted VERBATIM from ../calendarHealth.ts (module-level helpers
 * `parseGraphDt` + `classifyEventCategory`). Bodies are byte-for-byte identical;
 * only relative import depth was deepened one level for this dir and `export`
 * was added so calendarHealth.ts + the handlers can import them back.
 */
import { DateTime } from 'luxon';
import { getAnthropicClient } from '../../llm/client';
import type { CalendarEvent } from '../../connectors/graph/calendar';
import type { UserProfile } from '../../config/userProfile';
import logger from '../../utils/logger';

/**
 * Parse a Graph datetime string into Luxon DateTime.
 * Handles the trailing fractional-seconds Graph sometimes returns.
 */
export function parseGraphDt(dateTimeStr: string, eventTz: string, fallbackTz: string): DateTime {
  const clean = dateTimeStr.replace(/\.\d+$/, '');
  const tz = eventTz || fallbackTz;
  if (clean.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(clean)) {
    return DateTime.fromISO(clean).setZone(tz);
  }
  return DateTime.fromISO(clean, { zone: tz });
}

/**
 * v2.1.1 — high-confidence category classifier. Returns the picked category
 * name only when Sonnet says confidence='high'. Anything else returns null,
 * which means "don't auto-tag, leave for owner". Deliberately conservative —
 * mis-tagging is more annoying than leaving a category empty.
 */
export async function classifyEventCategory(
  event: CalendarEvent,
  profile: UserProfile,
): Promise<string | null> {
  if (!profile.categories || profile.categories.length === 0) return null;
  const catalog = profile.categories.map(c => `- ${c.name}: ${c.description}`).join('\n');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Anthropic = (require('@anthropic-ai/sdk') as typeof import('@anthropic-ai/sdk')).default;
    const client = getAnthropicClient();
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      tools: [{
        name: 'pick_category',
        description: 'Pick the single best-fit category for this event, or return confidence=low to skip.',
        input_schema: {
          type: 'object' as const,
          properties: {
            category: { type: 'string', description: 'Category name, exactly as listed. Empty string if none fits.' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['category', 'confidence'],
        },
      }],
      tool_choice: { type: 'tool', name: 'pick_category' },
      messages: [{
        role: 'user',
        content: `Event: "${event.subject}"
Body preview: ${(event.bodyPreview ?? '').slice(0, 200)}
All-day: ${event.isAllDay}
Online: ${event.isOnlineMeeting ?? 'unknown'}

Available categories:
${catalog}

Pick the single best-fit category. Return confidence=high ONLY when the match is unambiguous. Default to low/medium for anything borderline — the owner prefers an untagged event over a mis-tagged one.`,
      }],
    });
    const toolUse = resp.content.find(b => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') return null;
    const input = toolUse.input as Record<string, unknown>;
    const confidence = input.confidence as string | undefined;
    const category = input.category as string | undefined;
    if (confidence !== 'high' || !category) return null;
    // Defense: only return a name that's actually in the profile.
    const match = profile.categories.find(c => c.name === category);
    return match ? match.name : null;
  } catch (err) {
    logger.warn('classifyEventCategory failed — skipping auto-tag', { err: String(err).slice(0, 200) });
    return null;
  }
}
