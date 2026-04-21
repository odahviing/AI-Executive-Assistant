/**
 * Post-turn engagement classifier for social topics (v2.0.2).
 *
 * When Maelle asks a personal question, the mandatory rule in the prompt says
 * she logs it via `note_about_self` / `note_about_person` with quality=neutral
 * by default. If the person then engages with real depth, quality should be
 * upgraded — but relying on Sonnet to call the tool a SECOND time with higher
 * quality is fragile (she almost never does).
 *
 * This module moves the upgrade out of prompt judgment into deterministic code:
 *
 *   1. When a social-moment tool fires, we stash a PendingCheck keyed on the
 *      thread so we know what's in flight.
 *   2. On the next user message in that thread, `checkAndUpgradeEngagement` runs
 *      a narrow Sonnet classifier (tool_use with schema, guaranteed JSON) over
 *      the topic/subject + the user's reply.
 *   3. If engagement > neutral, we call `recordSocialMoment` with the upgraded
 *      quality. `recordSocialMoment` already applies monotonic upgrade
 *      (neutral → engaged → good, never downgrade) so this is safe.
 *
 * Layering: deterministic trigger (code), judgment (LLM). No regex trying to
 * detect "was this engagement"; Sonnet classifies by meaning.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { recordSocialMoment, type SocialTopicQuality } from '../db';
import logger from '../utils/logger';

interface PendingCheck {
  slackId: string;
  topic: string;
  subject: string;
  expiresAt: number;
}

const PENDING_TTL_MS = 30 * 60 * 1000; // 30 min — stale signals don't upgrade
const pending: Map<string, PendingCheck[]> = new Map();

export function markPendingEngagement(params: {
  threadTs: string;
  slackId: string;
  topic: string;
  subject: string;
}): void {
  const { threadTs, slackId, topic, subject } = params;
  if (!subject || !subject.trim()) return; // bare-subject entries skipped
  const expiresAt = Date.now() + PENDING_TTL_MS;
  const existing = pending.get(threadTs) ?? [];
  // Replace if same topic+subject, else append
  const filtered = existing.filter(c => !(c.topic === topic && c.subject === subject));
  filtered.push({ slackId, topic, subject, expiresAt });
  pending.set(threadTs, filtered);
  logger.info('socialEngagement — pending marked', { threadTs, topic, subject, expiresAt });
}

export async function checkAndUpgradeEngagement(params: {
  threadTs: string;
  userReply: string;
  anthropic: Anthropic;
}): Promise<void> {
  const { threadTs, userReply, anthropic } = params;
  const now = Date.now();
  const entries = pending.get(threadTs);
  if (!entries || entries.length === 0) return;
  const fresh = entries.filter(e => e.expiresAt > now);
  // Always clear — this is a one-shot per pending check. If user reply is
  // unrelated, they've missed their window; we won't re-classify later turns.
  pending.delete(threadTs);
  if (fresh.length === 0) return;
  if (!userReply || userReply.trim().length < 3) return;

  for (const entry of fresh) {
    try {
      const prompt = `Maelle asked the person about [topic: ${entry.topic}${entry.subject ? `, subject: ${entry.subject}` : ''}]. Their reply was:\n\n"""\n${userReply.slice(0, 3000)}\n"""\n\nJudge engagement. Use these thresholds:\n- neutral: brief/one-word, polite deflection, off-topic reply, redirected back to work\n- engaged: opened up a bit, shared details, showed interest in continuing\n- good: really connected, volunteered extra context or feelings, clearly enjoying the topic\n\nengaged="yes" if quality is engaged or good. engaged="no" if neutral.`;

      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        tools: [{
          name: 'classify_engagement',
          description: 'Judge how engaged the person was with a social topic.',
          input_schema: {
            type: 'object' as const,
            properties: {
              engaged: { type: 'string', enum: ['yes', 'no'] },
              quality: { type: 'string', enum: ['neutral', 'engaged', 'good'] },
            },
            required: ['engaged', 'quality'],
          },
        }],
        tool_choice: { type: 'tool', name: 'classify_engagement' },
        messages: [{ role: 'user', content: prompt }],
      });

      const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
      const verdict = toolUse?.input as { engaged?: string; quality?: SocialTopicQuality } | undefined;
      if (!verdict) {
        logger.warn('socialEngagement — classifier returned no tool_use', { threadTs, topic: entry.topic, subject: entry.subject });
        continue;
      }

      if (verdict.engaged === 'yes' && (verdict.quality === 'engaged' || verdict.quality === 'good')) {
        // initiated_by='person' so we don't reset Maelle's 24h gate —
        // recordSocialMoment's monotonic upgrade handles the quality jump.
        recordSocialMoment(entry.slackId, entry.topic, verdict.quality, 'person', entry.subject);
        logger.info('socialEngagement — quality upgraded', {
          threadTs,
          slackId: entry.slackId,
          topic: entry.topic,
          subject: entry.subject,
          quality: verdict.quality,
        });
      } else {
        logger.info('socialEngagement — no upgrade', {
          threadTs,
          topic: entry.topic,
          subject: entry.subject,
          engaged: verdict.engaged,
          quality: verdict.quality,
        });
      }
    } catch (err) {
      logger.warn('socialEngagement — classifier failed', { err: String(err).slice(0, 300) });
    }
  }
}
