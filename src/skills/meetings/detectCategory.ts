/**
 * detectCategory (v2.7.0) — single-event LLM classification.
 *
 * autoCategorize.ts already does this for batches (overnight 7-day sweep);
 * this is the per-booking version called by planMeeting before location +
 * rule application. Runs ONE Sonnet pass against the proposed subject /
 * attendees / body and returns the best yaml-category match or null.
 *
 * Conservative: returns null when no category clearly fits, so the
 * pipeline falls back to default rules (day-type / external defaults).
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import type { UserProfile } from '../../config/userProfile';
import logger from '../../utils/logger';

export interface DetectCategoryInput {
  profile: UserProfile;
  subject: string;
  body?: string;
  attendees: Array<{ email?: string; name?: string }>;
  isRecurring?: boolean;
}

export interface DetectCategoryResult {
  category: string | null;       // canonical yaml name, or null when no match
  reason: string;
}

export async function detectCategory(input: DetectCategoryInput): Promise<DetectCategoryResult> {
  const cats = input.profile.categories ?? [];
  if (cats.length === 0) return { category: null, reason: 'no categories defined in profile' };
  if (!config.ANTHROPIC_API_KEY) {
    return { category: null, reason: 'no Anthropic key' };
  }

  const ownerEmail = input.profile.user.email.toLowerCase();
  const ownerDomain = ownerEmail.includes('@') ? ownerEmail.split('@')[1] : '';

  const categoryBlock = cats.map((c, idx) => {
    const tags: string[] = [];
    if (c.limits?.per_day !== undefined) tags.push(`max ${c.limits.per_day}/day`);
    if (c.limits?.per_week !== undefined) tags.push(`max ${c.limits.per_week}/week`);
    if (c.day_type === 'office_days') tags.push('office days only');
    if (c.day_type === 'home_days') tags.push('home days only');
    const tagPart = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
    return `${idx + 1}. ${c.name} — ${c.description.replace(/\n/g, ' ').trim()}${tagPart}`;
  }).join('\n');

  const attendeesLine = input.attendees
    .map(a => {
      const e = (a.email ?? '').toLowerCase();
      if (!e) return null;
      const isExternal = ownerDomain && !e.endsWith('@' + ownerDomain);
      return isExternal ? `${e} (external)` : e;
    })
    .filter(Boolean)
    .slice(0, 8)
    .join(', ');

  const attendeeCount = input.attendees.length;

  const prompt = `You are categorizing ONE meeting for ${input.profile.user.name}. Pick the FIRST category from the list whose description matches. Use subject, attendees, body, and recurrence.

CATEGORIES (priority order — top wins on ambiguity):
${categoryBlock}

RULES:
- Walk top-down; first match wins.
- If NOTHING fits clearly, output "UNMATCHED" (case-sensitive).

MEETING:
Subject: ${input.subject.slice(0, 200)}
Recurring: ${input.isRecurring ? 'YES (part of a series)' : 'NO (one-time)'}
Attendee count: ${attendeeCount}
${attendeesLine ? `Attendees: ${attendeesLine}` : 'Attendees: (none / owner only)'}
${input.body ? `Body: ${input.body.slice(0, 300)}` : ''}

OUTPUT — ONE LINE in this exact format:
CATEGORY_NAME | one-sentence reason

Example: Physical | External attendee from accept2.com coming for an in-person meeting.`;

  let raw = '';
  try {
    const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    });
    raw = ((resp.content[0] as Anthropic.TextBlock)?.text ?? '').trim();
  } catch (err) {
    logger.warn('detectCategory — Sonnet call failed', { err: String(err).slice(0, 200) });
    return { category: null, reason: 'LLM call failed' };
  }

  // Parse "CATEGORY | reason"
  const line = raw.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  const m = line.match(/^([^|]+?)\s*(?:\|\s*(.+))?$/);
  if (!m) return { category: null, reason: `unparseable: ${raw.slice(0, 80)}` };

  const rawName = m[1].trim();
  const reason = (m[2] ?? '').trim();
  if (rawName.toUpperCase() === 'UNMATCHED') {
    return { category: null, reason: reason || 'no clear match' };
  }

  const canonical = cats.find(c => c.name.toLowerCase() === rawName.toLowerCase());
  if (!canonical) {
    logger.info('detectCategory — Sonnet returned unknown category', { returned: rawName });
    return { category: null, reason: `Sonnet returned unknown category "${rawName}"` };
  }

  return { category: canonical.name, reason };
}
