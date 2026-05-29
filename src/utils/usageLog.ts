/**
 * LLM token-usage logging (v3.0.6).
 *
 * Emits one structured `LLM usage` log line per Anthropic call so we can
 * attribute spend per call-site after the fact — the cost analogue to the
 * timing instrumentation. No token data was logged before this; cost
 * attribution was guesswork.
 *
 * Each line carries: a stable `label` (the call-site), the model, and the
 * four token counts that drive cost (input / output / cache-read /
 * cache-creation). A log parser can multiply these by the per-model,
 * per-token-class rates to get $ per label per day.
 *
 * Cheap and fail-safe: if usage is missing (shouldn't happen on a normal
 * response) we log nothing rather than throw. Never on a hot path that
 * can't absorb a log line.
 */

import type Anthropic from '@anthropic-ai/sdk';
import logger from './logger';

interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Log token usage from an Anthropic response.
 *
 * @param label  Stable call-site identifier (e.g. 'orchestrator', 'claim_checker',
 *               'human_gate'). Used to group spend in analysis.
 * @param model  The model string passed to the API call.
 * @param response  The Anthropic message response (or anything with `.usage`).
 * @param extra  Optional extra fields (iteration, senderRole, etc.).
 */
export function logLlmUsage(
  label: string,
  model: string,
  response: { usage?: UsageLike | null } | null | undefined,
  extra?: Record<string, unknown>,
): void {
  try {
    const u = response?.usage;
    if (!u) return;
    logger.info('LLM usage', {
      label,
      model,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      ...extra,
    });
  } catch {
    /* logging must never break a turn */
  }
}

export type { Anthropic };
