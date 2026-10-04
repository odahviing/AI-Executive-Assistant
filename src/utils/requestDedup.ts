/**
 * Request dedup (v2.7.0).
 *
 * LLM-judged "is this a new ask or a duplicate of something already open?"
 * Per owner direction: Sonnet sees the open requests for (owner,
 * requester) and decides match_existing / new.
 *
 * Why LLM instead of string-normalize: "investor call Sunday" and "call with
 * Wagner on Sun" surface as duplicates only with semantic matching. Sonnet's
 * the only thing that can judge "same logical ask" without false positives.
 *
 * Fallback: when LLM unreachable or parse fails, defer to the deterministic
 * idempotency_key UNIQUE constraint at insert time (sha256 of normalized
 * subject). Better to allow a duplicate than to block a real ask.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import { parseFirstJsonObject } from './extractJson';
import { SONNET } from '../llm/models';
import type { RequestRow } from '../core/requests/types';
import logger from './logger';

interface DedupCandidate {
  id: string;
  subject: string;
  state: string;
  kind: string;
  subkind: string | null;
  age_hours: number;
}

interface DedupResult {
  match: 'new' | 'existing';
  existing_id?: string;
  reasoning?: string;
  material_change?: boolean;
}

const SYSTEM_PROMPT = `You judge whether a proposed new request is the SAME logical ask as an existing request, including an owner-declined request, or a genuinely new ask.

Same = same colleague is asking the same thing (semantically), within the last 48h. Phrasing or language differs but the underlying request is one. A prior cancelled/declined request may match: the caller will ask the requester whether to raise it again, never silently reopen it.

Different = different subject, different intent, or sufficient time has passed that owner reasonably re-asked.

Be conservative — when in doubt, return "new". A false-merge silently swallows a real request; a false-split surfaces a duplicate (which is annoying but recoverable).

For an existing match, material_change is true if the proposed subject/description changes any requested term, constraint, reason, urgency or context the owner needs to decide. A paraphrase, translation or shortened wording with identical meaning is false. If uncertain, true. This is independent of matching the same logical request: a correction still matches it.

Output strict JSON, no markdown:
{ "match": "new" | "existing", "existing_id": "req_..." | null, "material_change": true | false, "reasoning": "<one short sentence>" }`;

export async function judgeRequestDedup(params: {
  proposed: { kind: string; subkind?: string | null; subject: string; description?: string | null };
  candidates: RequestRow[];
  requesterName?: string | null;
}): Promise<DedupResult> {
  const fallback: DedupResult = { match: 'new' };
  if (params.candidates.length === 0) return fallback;

  const now = Date.now();
  const candidateRows: DedupCandidate[] = params.candidates.map(c => ({
    id: c.id,
    subject: c.subject,
    state: c.state,
    kind: c.kind,
    subkind: c.subkind,
    age_hours: Math.round((now - Date.parse(c.created_at)) / 36e5),
  }));

  try {
    const client = getAnthropicClient();
    const userPrompt = [
      params.requesterName ? `Requester: ${params.requesterName}` : '',
      `Proposed new request:`,
      `  kind: ${params.proposed.kind}${params.proposed.subkind ? ` / ${params.proposed.subkind}` : ''}`,
      `  subject: ${params.proposed.subject}`,
      params.proposed.description ? `  description: ${params.proposed.description}` : '',
      ``,
      `Existing requests for this (owner, requester), including prior owner refusals:`,
      ...candidateRows.map(c => `  - id=${c.id} (${c.state}, ${c.kind}${c.subkind ? '/' + c.subkind : ''}, ${c.age_hours}h old): ${c.subject}\n    ${params.candidates.find(row => row.id === c.id)?.description ?? ''}`),
      ``,
      `JSON only.`,
    ].filter(Boolean).join('\n');

    const resp = await client.messages.create({
      ...SONNET,
      max_tokens: 250,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = resp.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('')
      .trim();
    // v3.8.x — reuse the shared balanced-object extractor (utils/extractJson), as
    // the gate stack does: strips fences AND tolerates trailing prose. A raw
    // JSON.parse threw on trailing prose → fell to the catch → a real "existing"
    // match was silently treated as NEW (a duplicate request). null → treat as new.
    const parsed = parseFirstJsonObject<{ match?: string; existing_id?: string | null; material_change?: boolean; reasoning?: string }>(text);
    if (!parsed) {
      logger.warn('requestDedup — no JSON object in extractor output, treating as new');
      return fallback;
    }

    if (parsed.match === 'existing' && typeof parsed.existing_id === 'string' && parsed.existing_id) {
      const verified = candidateRows.find(c => c.id === parsed.existing_id);
      if (!verified) {
        logger.warn('requestDedup — LLM returned unknown existing_id, falling back to new', {
          returnedId: parsed.existing_id,
        });
        return fallback;
      }
      return { match: 'existing', existing_id: parsed.existing_id, material_change: parsed.material_change === false ? false : true, reasoning: parsed.reasoning };
    }
    return { match: 'new', reasoning: parsed.reasoning };
  } catch (err) {
    logger.warn('requestDedup — LLM threw, falling back to deterministic insert', {
      err: String(err).slice(0, 200),
    });
    return fallback;
  }
}
