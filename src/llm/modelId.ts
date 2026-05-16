/**
 * Model ID resolver.
 *
 * Anthropic direct uses bare model names: `claude-sonnet-4-6`.
 * Vertex requires versioned model IDs: `claude-sonnet-4-6@20251220`.
 *
 * This helper maps a logical name to whatever the active provider expects.
 * Call sites pass logical names (`claude-sonnet-4-6`, `claude-haiku-4-6`);
 * the helper rewrites if needed.
 *
 * The Vertex versioning suffix is provider-specific and tied to Google's
 * deployment cadence — they pin Anthropic models to specific snapshot dates
 * for stability. Updating these requires checking Vertex's current published
 * model IDs (https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude).
 */
import { config } from '../config';

// Update these snapshot IDs when Vertex publishes new versions of Claude models.
// Leave at empty string to use the unsuffixed name on Vertex too (rare; only if Google
// later supports floating names).
const VERTEX_MODEL_SUFFIX: Record<string, string> = {
  'claude-sonnet-4-6': '@20251220',
  'claude-haiku-4-6':  '@20251220',
  // Add other models as needed.
};

export function resolveModelId(logicalName: string): string {
  if (config.LLM_PROVIDER !== 'vertex') return logicalName;
  const suffix = VERTEX_MODEL_SUFFIX[logicalName];
  if (suffix === undefined) {
    // Unknown model — pass through as-is. Vertex will return an error if the
    // exact name isn't supported; that's a better failure mode than silently
    // sending the wrong model.
    return logicalName;
  }
  return `${logicalName}${suffix}`;
}
