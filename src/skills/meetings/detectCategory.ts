/**
 * detectCategory (v2.7.0) — single-event LLM classification, with one
 * deterministic pre-check ahead of it.
 *
 * autoCategorize.ts already does this for batches (overnight 7-day sweep);
 * this is the per-booking version called by planMeeting before location +
 * rule application. First checks `profile.meetings.private_emails` in code
 * (a hard override, no LLM call needed when it fires — see below); otherwise
 * runs ONE Sonnet pass against the proposed subject / attendees / body and
 * returns the best yaml-category match or null.
 *
 * Conservative: returns null when no category clearly fits, so the
 * pipeline falls back to default rules (day-type / external defaults).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../../llm/client';
import { SONNET } from '../../llm/models';
import { config } from '../../config';
import type { UserProfile } from '../../config/userProfile';
import logger from '../../utils/logger';

export interface DetectCategoryInput {
  profile: UserProfile;
  subject: string;
  body?: string;
  attendees: Array<{ email?: string; name?: string }>;
  isRecurring?: boolean;
  // v4.0.x — the category the caller (the model's create_meeting arg) suggested.
  // A HINT to reconcile, not a command: honor it when it fits, override it when
  // it clearly doesn't. This classifier's output is authoritative for the write.
  requestedCategory?: string | null;
  // v4.3.x — the caller's raw location/venue text (create_meeting's args.location,
  // e.g. "in our offices", "23 Main St", "Zoom"). Without this the classifier
  // judged a "Physical" suggestion purely from subject/body, so a genuine onsite
  // request with no address MENTIONED IN THE SUBJECT read as "no physical location
  // indicated" and got overridden to a generic Meeting — even though the caller's
  // OWN location argument said otherwise and resolveLocation (runs right after
  // this, given the category this call returns) independently agreed it was
  // physical. Passed through verbatim, never parsed here (G8) — the model reads it.
  locationHint?: string;
}

export interface DetectCategoryResult {
  category: string | null;       // canonical yaml name, or null when no match
  reason: string;
}

export async function detectCategory(input: DetectCategoryInput): Promise<DetectCategoryResult> {
  const cats = input.profile.categories ?? [];
  if (cats.length === 0) return { category: null, reason: 'no categories defined in profile' };

  // 2026-08-16 — deterministic private-contact override (W3: code before
  // prompt). profile.meetings.private_emails (userProfile.ts) is a list of
  // attendee emails that are always personal, never work — spouse, kids,
  // family. When any attendee matches, force the tenant's private/sensitive
  // category here in CODE, before the LLM call even runs — no relationship
  // claim or email list is ever rendered into the prompt below for the model
  // to pattern-match against. Unconditional: a private contact does not
  // attend work meetings, so a work-sounding subject does not lift the
  // override (unlike the solo-block heuristic in the Personal category's own
  // description, which is a much weaker signal and does yield to a clear
  // work subject).
  //
  // The category is found by its schema-defined `sets_sensitivity_private:
  // true` flag (userProfile.ts:312), never by the literal name "Personal" —
  // category names are tenant-configurable YAML (the whole `categories` list
  // is user-defined), so matching on the name would silently stop firing for
  // any tenant who named their equivalent category something else (e.g.
  // "Family"), reintroducing exactly the naming-coupling private_emails was
  // built to avoid. YAML order is priority order (categories schema above,
  // and the classifier prompt below: "first match wins"), so if more than
  // one category carries the flag — an unusual config — the first one wins,
  // same tie-break as everywhere else categories are ordered. When NO
  // category has the flag configured, `personal` is undefined and this
  // override no-ops, falling through to the LLM pass below.
  const privateEmails = new Set((input.profile.meetings?.private_emails ?? []).map(e => e.toLowerCase()));
  if (privateEmails.size > 0) {
    const matched = input.attendees
      .map(a => (a.email ?? '').toLowerCase())
      .find(e => e && privateEmails.has(e));
    if (matched) {
      const personal = cats.find(c => c.sets_sensitivity_private === true);
      if (personal) {
        return { category: personal.name, reason: `attendee ${matched} is on the private_emails list` };
      }
    }
  }

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

  // v2.9.0 — caller (normalizeBookingRequest) guarantees owner is in
  // input.attendees with isOwner flag. Legacy callers may still omit the
  // owner; we inject defensively when missing. Either way: deduplicate so
  // we never count or list the owner twice. The previous (v2.8.6) fix
  // injected the owner unconditionally — under the v2.9 contract that
  // produced a double-row when called via the normalizer.
  const externalSuffixForAttendee = (e: string) => {
    if (!ownerDomain) return e;
    return e.endsWith('@' + ownerDomain) ? e : `${e} (external)`;
  };
  const emails = input.attendees
    .map(a => (a.email ?? '').toLowerCase())
    .filter(e => !!e);
  // otherAttendees filters owner OUT and we re-prepend owner unconditionally
  // — guarantees no double-row regardless of whether the caller pre-injected
  // owner. The v2.8.6 fix injected unconditionally but missed that the
  // v2.9 normalizer always pre-injects, producing the duplicate; this
  // filter-and-prepend pattern is the durable shape.
  const otherAttendees = emails
    .filter(e => e !== ownerEmail)
    .slice(0, 7)
    .map(externalSuffixForAttendee);
  const allAttendees = [ownerEmail, ...otherAttendees];
  const attendeesLine = allAttendees.join(', ');
  const attendeeCount = allAttendees.length;

  const prompt = `You are categorizing ONE meeting for ${input.profile.user.name}. Pick the FIRST category from the list whose description matches. Use subject, attendees, body, and recurrence.

CATEGORIES (priority order — top wins on ambiguity):
${categoryBlock}

RULES:
- Walk top-down; first match wins.
- If NOTHING fits clearly, output "UNMATCHED" (case-sensitive).${input.requestedCategory ? `
- The requester SUGGESTED "${input.requestedCategory}". Honor it ONLY if it genuinely fits this meeting's description above. If it clearly does not fit — e.g. a physical/in-person category for a meeting with no physical address, or a category whose description plainly describes a different situation — IGNORE the suggestion and classify by the descriptions. Your classification wins over the suggestion.` : ''}

MEETING:
Subject: ${input.subject.slice(0, 200)}
Recurring: ${input.isRecurring ? 'YES (part of a series)' : 'NO (one-time)'}
Attendee count: ${attendeeCount} (${input.profile.user.name.split(' ')[0]} included)
Attendees: ${attendeesLine}
${input.locationHint ? `Location given: ${input.locationHint.slice(0, 200)}` : ''}
${input.body ? `Body: ${input.body.slice(0, 300)}` : ''}

OUTPUT — ONE LINE in this exact format:
CATEGORY_NAME | one-sentence reason

Example: Physical | External attendee from accept2.com coming for an in-person meeting.`;

  let raw = '';
  try {
    const anthropic = getAnthropicClient();
    const resp = await anthropic.messages.create({
      ...SONNET,
      // gh#193 — Sonnet 5 (and every model after Opus 4.6) rejects any
      // explicit `temperature` with a 400 ("temperature is deprecated for
      // this model"); only 1.0 (the no-op default) is accepted. The
      // `temperature: 0` pin below was added deliberately (v4.5.1) to keep
      // this boundary-condition judgment (e.g. "5 or more people" read off
      // a fixed attendee list) deterministic run-to-run — that knob no
      // longer exists on this tier, so the param is dropped rather than
      // relaxed to 1.0 (which would silently reintroduce sampling noise
      // while looking like it still pins something). Re-verified live
      // against the exact 4-vs-5-attendee "Physical" boundary that
      // motivated v4.5.1 (4 calls per side, default sampling, no
      // temperature arg): 4/4 "Meeting" at 4 attendees, 4/4 "Physical" at
      // 5 — determinism holds without the param on this model. If it ever
      // regresses, the fix is a code-side re-check of the boundary, not
      // reaching for a sampling param this tier no longer has.
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
