/**
 * Owner-says-done scanner — LLM-only (v2.7.0 spine).
 *
 * Reads open `requests` (the spine). When the owner's free-text message says
 * "done / dropped / handled" about one of them, closes via `closeRequest`.
 *
 * Per owner direction (v2.6.5): no keyword pre-filter. LLM-only is the gate.
 * Conservative SYSTEM_PROMPT keeps false positives near zero. Empty open-items
 * → no LLM call (cost bound).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import type { UserProfile } from '../config/userProfile';
import { getOpenScannerItems } from '../db/requests';
import { closeRequest } from '../core/requests/closeRequest';
import { parseDetails, type RequestRow } from '../core/requests/types';
import logger from './logger';

interface ScannerResult {
  scanned: boolean;
  closedItems: Array<{ id: string; kind: string; reason: string }>;
}

const SYSTEM_PROMPT = `You scan an owner message for closure signals against a list of open tracked requests.

Your job: identify which requests (if any) the owner just told the assistant are DONE / DROPPED / HANDLED / NO LONGER NEEDED.

Be conservative. ONLY mark a request closed if:
  - The owner's message clearly references it (by name, colleague, topic, or unambiguous context)
  - AND the message clearly signals closure ("done", "drop it", "I handled it", "no need anymore", "cancel that", etc.)

Do NOT close requests based on:
  - Vague affirmations ("ok", "yes", "thanks") — those are conversation flow, not closure signals
  - Discussion / questions about the request ("how's the X coord going?") — that's interest, not closure
  - Future-tense plans ("I'll handle it tomorrow") — that's not done yet
  - Generic positive statements ("good", "looks good") — context-dependent, default skip

When in doubt, return EMPTY closed_items. False positives close real work; false negatives leave a row open for tomorrow's brief to surface again — second chance.

Output strict JSON, no markdown:
{ "closed_items": [ { "id": "...", "reason": "<short — what owner said>" } ] }

If nothing closes: { "closed_items": [] }`;

export async function closeLoopOnOwnerHandled(params: {
  profile: UserProfile;
  ownerMessage: string;
}): Promise<ScannerResult> {
  const result: ScannerResult = { scanned: false, closedItems: [] };
  if (!params.ownerMessage || params.ownerMessage.length < 3) return result;

  const open = getOpenScannerItems(params.profile.user.slack_user_id);
  if (open.length === 0) return result;
  result.scanned = true;

  let closedIds: Array<{ id: string; reason: string }> = [];
  try {
    const client = getAnthropicClient();
    const userPrompt = [
      `Owner just said: "${params.ownerMessage.slice(0, 800)}"`,
      ``,
      `Open tracked requests (${open.length}):`,
      ...open.slice(0, 25).map(r => {
        const det = parseDetails<Record<string, unknown>>(r) ?? {};
        const counterpart = r.target_name || r.requester_name || (det.requester_name as string | undefined) || '';
        const cp = counterpart ? ` [counterpart: ${counterpart}]` : '';
        const kindLabel = r.subkind ? `${r.kind}/${r.subkind}` : r.kind;
        return `  - id=${r.id} (${kindLabel}, ${r.state}): ${r.subject}${cp}`;
      }),
      ``,
      `Which requests did the owner just close? JSON only.`,
    ].join('\n');

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const text = resp.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('')
      .trim();
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '');
    const parsed = JSON.parse(cleaned) as { closed_items?: Array<{ id?: string; reason?: string }> };
    if (Array.isArray(parsed.closed_items)) {
      closedIds = parsed.closed_items
        .filter(c => typeof c.id === 'string' && c.id.length > 0)
        .map(c => ({ id: c.id as string, reason: typeof c.reason === 'string' ? c.reason : '' }));
    }
  } catch (err) {
    logger.warn('closeLoopOnOwnerHandled: LLM pass failed — fail-open', {
      err: String(err).slice(0, 300),
    });
    return result;
  }

  if (closedIds.length === 0) return result;

  const idToRow = new Map<string, RequestRow>(open.map(r => [r.id, r]));
  for (const { id, reason } of closedIds) {
    const row = idToRow.get(id);
    if (!row) {
      logger.warn('closeLoopOnOwnerHandled: LLM returned unknown id — skipping', { id });
      continue;
    }
    try {
      closeRequest({
        id,
        state: 'cancelled',
        closureReason: `owner_said_done: ${reason.slice(0, 120)}`,
        closedBy: 'scanner',
      });
      result.closedItems.push({ id, kind: row.kind, reason });
      logger.info('closeLoopOnOwnerHandled: closed request', {
        id, kind: row.kind, reason: reason.slice(0, 100),
      });
    } catch (err) {
      logger.warn('closeLoopOnOwnerHandled: closeRequest threw — skipping', {
        id, err: String(err).slice(0, 200),
      });
    }
  }
  return result;
}
