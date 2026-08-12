/**
 * Central model + thinking policy for every Claude call.
 *
 * `MODEL_SONNET` = the one place the Sonnet tier is pinned. v4.0.0 swapped it
 * `claude-sonnet-4-6` → `claude-sonnet-5`; v4.0.1 REVERTED it to 4.6 after a broad
 * behavioral-regression wave — attendee-set drift, availability answers flipping
 * turn-to-turn, fabricated "I checked / can't find it" with no tool call — all on
 * judgment/agentic paths. Forensics traced the wave to Sonnet 5 being run
 * thinking-DISABLED: with reasoning off it's markedly less tool-eager and more
 * literal, so it answered from memory instead of calling the tool. This is the
 * STAGED RETRY — Sonnet 5 is back on, but the orchestrator agentic loop now runs
 * ADAPTIVE thinking at `high` effort (see orchestrator/index.ts + buildTurnContext),
 * restoring tool-reaching + self-verification on the exact layer that broke. Guards
 * + classifiers stay thinking-off (the SONNET bundle). Revert = flip this one line
 * back to 'claude-sonnet-4-6'. `thinking:{type:'disabled'}` is valid on BOTH 5 and
 * 4.6, so the SONNET bundle below is unchanged either way.
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
 * Bare-ID shape on Vertex is STILL UNVERIFIED end-to-end for Sonnet, but the
 * blocker has moved. gh#199 retry (2026-08-11, same call shape as the first
 * smoke test, run from the VM's own service-account auth chain
 * `maelle-runner@reflectiz-ai-backoffice.iam.gserviceaccount.com`) against
 * `claude-sonnet-5` (bare) in `us-east5` no longer 404s — the model is now
 * recognized (Model Garden entitlement was evidently granted after the first
 * test). It now fails differently: HTTP 429 `RESOURCE_EXHAUSTED`, "Quota
 * exceeded for aiplatform.googleapis.com/online_prediction_input_tokens_per_minute_per_base_model
 * with base model: anthropic-claude-sonnet-5" — reproduced twice in a row
 * (a fresh 16-token and then an 8-token request, seconds apart, both denied
 * immediately), so this reads as a provisioned-at-zero per-model quota, not
 * a burst limit. Checking the actual quota value failed too: the runner SA
 * got 403 `PERMISSION_DENIED` calling `serviceusage.googleapis.com`
 * consumerQuotaMetrics, and `gcloud alpha services quota` isn't installed
 * and can't be added non-interactively from this session. The fix is a
 * Vertex AI quota increase request for that metric (base model
 * `anthropic-claude-sonnet-5`) — a console action, same as the original
 * "Enable" — the docs link Google returns in the error is
 * https://cloud.google.com/vertex-ai/docs/generative-ai/quotas-genai.
 * `claude-haiku-4-5` still returns a real completion in the same project —
 * so Haiku's quota is provisioned and Sonnet's is not. Until the quota
 * increase lands, do NOT flip LLM_PROVIDER=vertex on the live VM: the
 * entire Sonnet-backed orchestrator path would 429 every turn (100% failure,
 * strictly worse than staying on Anthropic-direct).
 *
 * Re-checked 2026-08-12 (gh#199, same rawPredict call, same VM SA
 * `maelle-runner@reflectiz-ai-backoffice.iam.gserviceaccount.com`, confirmed
 * as BOTH the VM's attached metadata identity and the active gcloud
 * credential on-box): identical 429 RESOURCE_EXHAUSTED on
 * `online_prediction_input_tokens_per_minute_per_base_model` for
 * `anthropic-claude-sonnet-5`. No `.env` change was made — this stays
 * Anthropic-direct until the quota increase actually lands. Next retry
 * should check the quota value directly (console, or `serviceusage`/
 * `gcloud alpha services quota` with a role that isn't 403'd) before
 * re-running the smoke test, to tell "still zero" from "increased but not
 * yet enough."
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
 * The bare alias resolves on both Anthropic-direct and Vertex — CONFIRMED by
 * the gh#199 smoke test (2026-08-11): a real Vertex rawPredict call to
 * `claude-haiku-4-5` in us-east5 returned a completed response (model id
 * echoed back as `claude-haiku-4-5-20251001`). This is the only Claude model
 * currently enabled for this project in Vertex Model Garden — Sonnet/Opus
 * are not yet (see MODEL_SONNET comment above).
 *
 * No thinking policy: Haiku doesn't support adaptive thinking, and an omitted
 * `thinking` runs it off (today's behavior) — so callers just pass
 * `model: MODEL_HAIKU` and nothing else changes.
 */
export const MODEL_HAIKU = 'claude-haiku-4-5';
