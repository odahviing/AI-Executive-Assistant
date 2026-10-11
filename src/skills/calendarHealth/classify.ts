/** Owner-zone Graph datetime parsing and the existing category classifier. */
import { DateTime } from 'luxon';
import { getAnthropicClient } from '../../llm/client';
import { SONNET } from '../../llm/models';
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
  const instant = clean.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(clean)
    ? DateTime.fromISO(clean, { setZone: true })
    : DateTime.fromISO(clean, { zone: tz });
  // The Graph zone identifies the instant; all health day/hour comparisons
  // use the owner's requested calendar zone, including UTC Graph responses.
  return instant.setZone(fallbackTz);
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
    const client = getAnthropicClient();
    const resp = await client.messages.create({
      ...SONNET,
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
      tool_choice: { type: 'auto' },
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
    // Sonnet 5.5 may finish a complete tool result with either stop reason.
    // Never act on a truncated, refused, missing, or ambiguous selection.
    if (resp.stop_reason !== 'tool_use' && resp.stop_reason !== 'end_turn') return null;
    const toolUses = resp.content.filter(b => b.type === 'tool_use');
    if (toolUses.length !== 1 || toolUses[0].name !== 'pick_category') return null;
    const toolUse = toolUses[0];
    if (!toolUse.input || typeof toolUse.input !== 'object' || Array.isArray(toolUse.input)) return null;
    const input = toolUse.input as Record<string, unknown>;
    const { confidence, category } = input;
    if (confidence !== 'high' || typeof category !== 'string' || !category) return null;
    // Defense: only return a name that's actually in the profile.
    const match = profile.categories.find(c => c.name === category);
    return match ? match.name : null;
  } catch (err) {
    logger.warn('classifyEventCategory failed — skipping auto-tag', { err: String(err).slice(0, 200) });
    return null;
  }
}
