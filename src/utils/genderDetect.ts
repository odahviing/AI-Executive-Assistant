import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import { SONNET } from '../llm/models';
import { config } from '../config';
import { getPersonMemory, setCoreFieldWithProvenance } from '../db';
import type { PersonGender, CoreFieldSetBy } from '../db';
import logger from './logger';

// ── Step 1: Pronouns ──────────────────────────────────────────────────────────

export function detectGenderFromPronouns(pronouns: string | undefined): PersonGender {
  if (!pronouns) return 'unknown';
  const p = pronouns.toLowerCase();
  if (p.includes('he/') || p.startsWith('he ') || p === 'he' || p.includes('/him')) return 'male';
  if (p.includes('she/') || p.startsWith('she ') || p === 'she' || p.includes('/her')) return 'female';
  return 'unknown';
}

// ── Step 2: Profile image via Claude vision ───────────────────────────────────

async function fetchImageAsBase64(
  url: string,
  botToken?: string,
): Promise<{ data: string; mediaType: string } | null> {
  try {
    const headers: Record<string, string> = {};
    // Slack CDN URLs sometimes need the bot token as Bearer auth
    if (botToken && url.includes('slack')) {
      headers['Authorization'] = `Bearer ${botToken}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const data = Buffer.from(buf).toString('base64');
    const ct = res.headers.get('content-type') || 'image/jpeg';
    const mediaType = ct.split(';')[0].trim();
    return { data, mediaType };
  } catch {
    return null;
  }
}

async function detectGenderFromImage(
  imageUrl: string,
  name: string,
  botToken?: string,
): Promise<PersonGender> {
  if (!config.ANTHROPIC_API_KEY) return 'unknown';

  const image = await fetchImageAsBase64(imageUrl, botToken);
  if (!image) return 'unknown';

  try {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      ...SONNET,
      max_tokens: 5,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType as any, data: image.data },
          },
          {
            type: 'text',
            text: `Profile photo of "${name}". Reply with ONLY one word: male, female, or unknown.`,
          },
        ],
      }],
    });

    const answer = ((response.content[0] as any)?.text ?? '').toLowerCase().trim();
    if (answer === 'male')   return 'male';
    if (answer === 'female') return 'female';
    return 'unknown';
  } catch (err) {
    logger.debug('Gender image detection failed', { name, err: String(err) });
    return 'unknown';
  }
}

// v3.5.x — the name-based LLM gender guess was REMOVED. It mis-cast a female
// "Daniel" as male and shipped masculine Hebrew before any real signal existed
// (2026-06-29). Guessing gender from a name is unsafe in any language; we now
// rely only on a self-declaration (pronouns) or a weak image signal, and stay
// 'unknown' otherwise (the reply goes gender-neutral; ask only if unavoidable).

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Detect and persist gender for a workspace contact.
 *
 * Priority (each tier is a tentative auto-detection — NEVER overrides a
 * gender_confirmed=1 row, enforced in people.ts):
 *   1. Slack pronouns field  → self-declaration → recorded as 'person' (steers)
 *   2. Profile photo vision  → a weak guess → recorded as 'auto' (does NOT steer
 *                              gendered forms until confirmed — see people.ts)
 *   3. Stays 'unknown'       → reply stays gender-neutral; ask only if a gendered
 *                              form is unavoidable. We NEVER guess from the name.
 *
 * Runs fire-and-forget in the background — never blocks message handling.
 * Skips entirely if gender is already known (confirmed or not).
 */
export async function detectAndSaveGender(params: {
  slackId: string;
  name: string;
  pronouns?: string;
  imageUrl?: string;
  botToken?: string;
}): Promise<void> {
  const { slackId, name, pronouns, imageUrl, botToken } = params;

  // Skip if we already have a value — a tentative guess is still better than
  // nothing and can be overwritten on the NEXT strong signal via the normal
  // upsert paths. A confirmed value is also skipped here (can't be overridden
  // by auto-detection regardless).
  const existing = getPersonMemory(slackId);
  if (existing?.gender && existing.gender !== 'unknown') return;

  // Step 1 — pronouns. A Slack pronouns field is the person's OWN declaration,
  // so record it as 'person': it steers gendered forms and an 'auto' signal
  // can't clobber it (owner can still override).
  let gender = detectGenderFromPronouns(pronouns);
  let setBy: CoreFieldSetBy = 'person';

  // Step 2 — profile image. A guess, not a declaration → 'auto'. Under the
  // people.ts render gate an 'auto' gender does NOT steer Hebrew forms until
  // confirmed, so a wrong photo read can't reproduce the masculine-default bug.
  if (gender === 'unknown' && imageUrl) {
    gender = await detectGenderFromImage(imageUrl, name, botToken);
    setBy = 'auto';
  }

  if (gender !== 'unknown') {
    const wrote = setCoreFieldWithProvenance(slackId, 'gender', gender, setBy);
    logger.debug('Gender saved', { slackId, name, gender, setBy, wrote });
  }
}
