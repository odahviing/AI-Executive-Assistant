/**
 * Brief auto-categorize — Sonnet pre-pass that tags uncategorized events
 * based on the owner's category descriptions in yaml.
 *
 * Why this exists:
 *   v2.6 categories carry per_day / per_week limits + day_type rules. Those
 *   rules count category occurrences; an uncategorized event isn't counted,
 *   even when its content matches a category. The brief's daily flow is the
 *   right hook: each morning, walk the next ~7 days, find events with no
 *   category, classify them via Sonnet (using yaml descriptions), apply via
 *   updateMeeting. Surface what changed back to the owner so he sees what
 *   Maelle inferred.
 *
 *   Owner direction (2026-05-05): "she can do auto, if I see she is doing
 *   many mistakes will improve definition. also in the brief she can let
 *   me know of the changes she met."
 *
 * Idempotent — only fires on events whose `categories` field is empty or
 * doesn't include any name from `profile.categories`. Once tagged, the
 * event's categories field has a name from profile, so the next run skips
 * it. Owner can correct via chat ("no, that's Outside meeting") and
 * `update_meeting` overrides this run.
 *
 * Single Sonnet call per brief — batches all uncategorized events into one
 * prompt with the categories list + event details. Cheap enough for daily.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import { config } from '../config';
import { updateMeeting, type CalendarEvent } from '../connectors/graph/calendar';
import type { UserProfile } from '../config/userProfile';
import { displaySubject } from './displaySubject';
import logger from './logger';

export interface AutoCategorizeChange {
  event_id: string;
  subject: string;
  start_iso: string;
  category_assigned: string;
  reason?: string;
}

export interface AutoCategorizeResult {
  attempted: number;
  applied: AutoCategorizeChange[];
  skipped_unmatched: Array<{ event_id: string; subject: string; reason: string }>;
}

/**
 * Filter a list of events to those that need a category assigned. Excludes:
 *   - cancelled / all-day events
 *   - events with non-mine origin (delegated calendars where owner isn't organizer
 *     and isn't the only attendee — leave external-driven categories alone)
 *   - events whose `categories` already contains at least one name from
 *     profile.categories[] (already tagged)
 *
 * Caller is responsible for the date range — this helper just filters by
 * category-presence + cancellation + day type.
 */
export function pickUncategorizedEvents(
  events: CalendarEvent[],
  profile: UserProfile,
): CalendarEvent[] {
  const cats = profile.categories ?? [];
  if (cats.length === 0) return [];
  const knownCategoryNames = new Set(cats.map(c => c.name.toLowerCase()));
  return events.filter(ev => {
    if (ev.isCancelled) return false;
    if (ev.isAllDay) return false;
    const evCategories = ev.categories ?? [];
    const hasKnown = evCategories.some(c => knownCategoryNames.has(c.toLowerCase()));
    return !hasKnown;
  });
}

/**
 * Classify a batch of uncategorized events via Sonnet using the profile's
 * category descriptions. Applies the chosen category via updateMeeting.
 *
 * Returns a structured result describing every applied change so the brief
 * data collector can render a "what changed" item.
 */
export async function autoCategorizeEvents(opts: {
  events: CalendarEvent[];
  profile: UserProfile;
}): Promise<AutoCategorizeResult> {
  const result: AutoCategorizeResult = {
    attempted: opts.events.length,
    applied: [],
    skipped_unmatched: [],
  };

  if (opts.events.length === 0) return result;
  const cats = opts.profile.categories ?? [];
  if (cats.length === 0) return result;
  if (!config.ANTHROPIC_API_KEY) {
    logger.warn('autoCategorizeEvents — no Anthropic key, skipping');
    return result;
  }

  const ownerEmail = opts.profile.user.email.toLowerCase();
  const ownerDomain = ownerEmail.includes('@') ? ownerEmail.split('@')[1] : '';
  const timezone = opts.profile.user.timezone;

  // Build the prompt — categories with descriptions + event details.
  const categoryBlock = cats.map((c, idx) => {
    const parts: string[] = [];
    if (c.limits?.per_day !== undefined) parts.push(`max ${c.limits.per_day}/day`);
    if (c.limits?.per_week !== undefined) parts.push(`max ${c.limits.per_week}/week`);
    if (c.day_type === 'office_days') parts.push('office days only');
    if (c.day_type === 'home_days') parts.push('home days only');
    const tags = parts.length > 0 ? ` [${parts.join(', ')}]` : '';
    return `${idx + 1}. ${c.name} — ${c.description.replace(/\n/g, ' ').trim()}${tags}`;
  }).join('\n');

  const eventBlock = opts.events.map((ev, idx) => {
    const start = ev.start.dateTime?.slice(0, 16) ?? '?';
    const subject = (ev.subject ?? '(no subject)').slice(0, 120);
    const attendees = (ev.attendees ?? [])
      .map(a => {
        const e = (a.emailAddress?.address ?? '').toLowerCase();
        if (!e) return null;
        const isExternal = ownerDomain && !e.endsWith('@' + ownerDomain);
        return isExternal ? `${e} (external)` : e;
      })
      .filter(Boolean)
      .slice(0, 6)
      .join(', ');
    const location = ev.location?.displayName?.trim() ?? '';
    const bodyPreview = (ev.bodyPreview ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    // v2.5.4 — recurrence flag surfaced. Cadence (and any future "is this
    // recurring?" rule) needs Sonnet to read calendar truth, not infer from
    // subject text. event.type values: 'singleInstance' | 'occurrence' |
    // 'seriesMaster' | 'exception'. Anything other than singleInstance is
    // part of a recurring series.
    const evType = (ev as unknown as { type?: string }).type ?? 'singleInstance';
    const isRecurring = evType !== 'singleInstance';
    const attendeeCount = (ev.attendees ?? []).length;
    return `[${idx + 1}] ID: ${ev.id}
Subject: ${subject}
Start: ${start}
Recurring: ${isRecurring ? 'YES (part of a recurring series)' : 'NO (one-time event)'}
${attendees ? `Attendees: ${attendees}` : 'Attendees: (none / owner only)'}
Attendee count: ${attendeeCount}
${location ? `Location: ${location}` : ''}
${bodyPreview ? `Body: ${bodyPreview}` : ''}`;
  }).join('\n---\n');

  const prompt = `You are categorizing meetings for ${opts.profile.user.name}'s calendar. Each event below needs ONE category from the list — pick the best match using the descriptions.

CATEGORIES (in priority order — first match wins when an event fits multiple):
${categoryBlock}

RULES:
- Walk the categories TOP-DOWN; pick the FIRST one that matches the event.
- Use subject, attendees, location, and body to decide.
- External attendees + interview-style cues → "Interview" if present.
- Off-site venue (cafe, restaurant, customer site) → "Outside meeting" if present.
- If NOTHING fits, return "UNMATCHED" for that event — don't force a category.

EVENTS TO CATEGORIZE:
---
${eventBlock}
---

OUTPUT — one line per event in this exact format, in the same order as input:
[index] CATEGORY_NAME | one-sentence reason

Example: [1] Interview | Subject mentions "candidate", external attendee from a recruiter domain.
`;

  let raw = '';
  try {
    const anthropic = getAnthropicClient();
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 60 * opts.events.length + 200,
      messages: [{ role: 'user', content: prompt }],
    });
    raw = ((resp.content[0] as Anthropic.TextBlock)?.text ?? '').trim();
  } catch (err) {
    logger.warn('autoCategorizeEvents — Sonnet call failed, skipping batch', {
      err: String(err).slice(0, 200), batchSize: opts.events.length,
    });
    return result;
  }

  // Parse: each line "[N] CATEGORY | reason"
  const validNames = new Set(cats.map(c => c.name.toLowerCase()));
  const validNamesByLower = new Map(cats.map(c => [c.name.toLowerCase(), c.name]));
  for (const line of raw.split('\n').map(l => l.trim()).filter(Boolean)) {
    const m = line.match(/^\[(\d+)\]\s*([^|]+?)\s*(?:\|\s*(.+))?$/);
    if (!m) continue;
    const idx = parseInt(m[1], 10) - 1;
    const rawName = m[2].trim();
    const reason = (m[3] ?? '').trim();
    if (!Number.isFinite(idx) || idx < 0 || idx >= opts.events.length) continue;
    const event = opts.events[idx];
    if (rawName.toUpperCase() === 'UNMATCHED') {
      result.skipped_unmatched.push({
        event_id: event.id,
        // v2.7.4 — mask subject if event is private. Owner reads the brief
        // but quoted subjects can also reach colleagues via shared
        // conversation history; mask universally for safety.
        subject: displaySubject(event, opts.profile),
        reason: reason || 'no clear category match',
      });
      continue;
    }
    const lower = rawName.toLowerCase();
    if (!validNames.has(lower)) {
      logger.info('autoCategorizeEvents — Sonnet returned unknown category, skipping', {
        eventId: event.id, returned: rawName,
      });
      result.skipped_unmatched.push({
        event_id: event.id,
        subject: displaySubject(event, opts.profile),
        reason: `Sonnet returned unknown category "${rawName}"`,
      });
      continue;
    }
    const canonicalName = validNamesByLower.get(lower)!;

    // Apply via Graph patch — preserve any existing categories that aren't
    // ours (e.g. someone manually tagged the event with something not in
    // profile; don't strip that).
    const existing = event.categories ?? [];
    const merged = [...existing, canonicalName];
    try {
      await updateMeeting({
        userEmail: opts.profile.user.email,
        meetingId: event.id,
        timezone,
        categories: merged,
      });
      result.applied.push({
        event_id: event.id,
        // v2.7.4 — mask private-event subjects. The newly-applied category
        // may also carry sets_sensitivity_private (e.g., Interview added
        // mid-categorization); merge that into the categories list before
        // the mask check so an event becoming-private THIS turn is masked
        // immediately in the brief item.
        subject: displaySubject(
          { ...event, categories: merged },
          opts.profile,
        ),
        start_iso: event.start.dateTime,
        category_assigned: canonicalName,
        reason: reason || undefined,
      });
      logger.info('autoCategorizeEvents — applied', {
        eventId: event.id, subject: event.subject?.slice(0, 60), category: canonicalName,
      });
    } catch (err) {
      logger.warn('autoCategorizeEvents — Graph patch failed, skipping', {
        eventId: event.id, err: String(err).slice(0, 200),
      });
    }
  }

  return result;
}
