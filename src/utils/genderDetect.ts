import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { getPersonMemory, setCoreFieldWithProvenance } from '../db';
import type { PersonGender } from '../db';
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
    const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
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

// ── Step 3: Name-based LLM inference ──────────────────────────────────────────
// Works for Hebrew and English names. "Yael", "Rachel", "Dana" → female.
// "Idan", "David", "Moshe" → male. Names that are ambiguous (Noa, Alex) or
// genuinely unknown → 'unknown' and Maelle will ask once naturally.
async function detectGenderFromName(name: string): Promise<PersonGender> {
  if (!config.ANTHROPIC_API_KEY || !name || !name.trim()) return 'unknown';

  try {
    const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 5,
      messages: [{
        role: 'user',
        content: `Given this first/full name, what gender is the person most likely to be in Israeli / Hebrew-speaking culture? Consider English names too.

Name: "${name}"

Reply with ONLY one word: male, female, or unknown.
- "unknown" for genuinely ambiguous names (Noa, Alex, Yuval used for both, Shai, etc.) or names you can't place.
- Prefer "unknown" over a low-confidence guess — a wrong guess is worse than no guess.`,
      }],
    });
    const answer = ((response.content[0] as any)?.text ?? '').toLowerCase().trim();
    if (answer === 'male')   return 'male';
    if (answer === 'female') return 'female';
    return 'unknown';
  } catch (err) {
    logger.debug('Gender name-LLM detection failed', { name, err: String(err) });
    return 'unknown';
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Detect and persist gender for a workspace contact.
 *
 * Priority (each tier is a tentative auto-detection — NEVER overrides a
 * gender_confirmed=1 row, enforced in updatePersonGender):
 *   1. Slack pronouns field  → immediate, no API call
 *   2. Profile photo vision  → Claude Haiku, one-shot
 *   3. Name-based LLM guess  → Claude Haiku, covers Hebrew + English names
 *                              (picks up Yael/Dana/Rachel → female, etc.)
 *   4. Stays 'unknown'       → agent will ask once if needed
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

  // Step 1 — pronouns (instant)
  let gender = detectGenderFromPronouns(pronouns);

  // Step 2 — profile image (async API call)
  if (gender === 'unknown' && imageUrl) {
    gender = await detectGenderFromImage(imageUrl, name, botToken);
  }

  // Step 3 — name-based LLM (covers Hebrew names like Yael, Dana, etc.
  // where there's no pronouns and image detection didn't succeed).
  if (gender === 'unknown') {
    gender = await detectGenderFromName(name);
  }

  if (gender !== 'unknown') {
    // v2.2.2 (#46) — go through the provenance choke-point. set_by='auto' so
    // any direct statement from the person or owner overrides this guess.
    // The helper writes the gender column itself; no separate update needed.
    const wrote = setCoreFieldWithProvenance(slackId, 'gender', gender, 'auto');
    logger.debug('Gender saved (auto-detected)', { slackId, name, gender, wrote });
  }
}
