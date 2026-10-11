/**
 * Central Claude model and thinking policy for both direct and Vertex clients.
 * The fixed 5.5 IDs have no dated suffix on either provider.
 *
 * Sonnet 5.5 rejects disabled thinking and forced tool choice. Classifiers use
 * between_tools (no up-front thinking); their callers validate tool results.
 * Agentic callers explicitly override to adaptive/high and keep their existing
 * output budgets. Thinking shares max_tokens with the visible answer.
 *
 * Haiku 5.5 defaults to adaptive thinking. Explicit disabled preserves the
 * existing classifier spending policy; forced tool calls remain supported.
 * Changing that policy requires a separately measured owner decision.
 */
export const MODEL_SONNET = 'claude-sonnet-5-5';

export const SONNET = {
  model: MODEL_SONNET,
  thinking: { type: 'between_tools' },
} as const;

export const MODEL_HAIKU = 'claude-haiku-5-5';

export const HAIKU = {
  model: MODEL_HAIKU,
  thinking: { type: 'disabled' },
} as const;
