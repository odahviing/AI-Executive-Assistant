/**
 * Central model + thinking policy for every Claude call.
 *
 * `MODEL_SONNET` = the one place the Sonnet tier is pinned. Swapped from
 * `claude-sonnet-4-6` → `claude-sonnet-5` in v3.8.x (near-Opus quality at
 * Sonnet cost).
 *
 * `SONNET` bundles the model with an explicit `thinking: disabled`. This is
 * load-bearing: on Sonnet 5 an OMITTED `thinking` runs adaptive-ON by default,
 * so leaving it off would silently turn thinking on at every site — slower,
 * costlier, and it changes the turn shape (thinking blocks in `response.content`
 * that the tool loop then round-trips). Disabled keeps every pass snappy and
 * byte-identical in behavior to the pre-migration Sonnet 4.6 (which ran
 * thinking-off). Spread it into `messages.create(...)` so model + policy always
 * travel together and can't drift apart:
 *
 *     client.messages.create({ ...SONNET, max_tokens, system, messages })
 *
 * To opt a single call into reasoning, override locally AND give it a larger
 * `max_tokens` (thinking shares the output budget):
 *
 *     client.messages.create({ ...SONNET, thinking: { type: 'adaptive' }, max_tokens: 12000, ... })
 *
 * Haiku 4.5 (`claude-haiku-4-5-20251001`) is the cheap/fast guard+classifier
 * tier — unchanged, doesn't support adaptive thinking, and is not routed here.
 *
 * Bare IDs work on both Anthropic-direct and Vertex for current-gen models
 * (Sonnet 5 needs no Vertex @-version suffix), so no `resolveModelId`
 * indirection is required at the Sonnet sites.
 */
export const MODEL_SONNET = 'claude-sonnet-5';

export const SONNET = {
  model: MODEL_SONNET,
  thinking: { type: 'disabled' },
} as const;

/**
 * Haiku 4.5 — the cheap/fast guard + classifier tier (addressee gate, security
 * gate, date verifier, capture pass, turn classifier, etc.). Unchanged in tier;
 * this only centralizes the ID and makes it Vertex-safe.
 *
 * Bare alias, NOT the dated `claude-haiku-4-5-20251001`: the hyphenated-dated
 * form is the wrong shape for Vertex (dated snapshots use `@`, e.g.
 * `claude-haiku-4-5@20251001`) and would 404 the moment LLM_PROVIDER=vertex.
 * The bare alias resolves on both Anthropic-direct and Vertex. Anthropic maps
 * the alias to the current 4.5 snapshot — identical to the old pinned ID today;
 * re-confirm the exact Vertex ID during the Vertex smoke test.
 *
 * No thinking policy: Haiku doesn't support adaptive thinking, and an omitted
 * `thinking` runs it off (today's behavior) — so callers just pass
 * `model: MODEL_HAIKU` and nothing else changes.
 */
export const MODEL_HAIKU = 'claude-haiku-4-5';
