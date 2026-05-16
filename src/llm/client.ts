/**
 * Anthropic client factory.
 *
 * Returns a Claude-capable client based on `config.LLM_PROVIDER`:
 *
 *   'anthropic' (default) — direct Anthropic API. Uses ANTHROPIC_API_KEY.
 *   'vertex'              — Google Vertex AI hosting Claude. Uses
 *                           VERTEX_PROJECT_ID + VERTEX_REGION +
 *                           GOOGLE_APPLICATION_CREDENTIALS.
 *
 * The Anthropic SDK and Vertex SDK share the same `messages.create()` API
 * contract — tool use, prompt caching, streaming, and content blocks are all
 * identical. Only the client construction + auth differ. Call sites can
 * treat the returned object as `Anthropic`-typed.
 *
 * The Vertex SDK is loaded LAZILY via require — only when LLM_PROVIDER=vertex.
 * That way, profiles staying on direct Anthropic don't need
 * `@anthropic-ai/vertex-sdk` installed.
 *
 * Returned client is a singleton — built once per process, cached.
 *
 * Migrating between providers:
 *   1. Install @anthropic-ai/vertex-sdk: `npm install @anthropic-ai/vertex-sdk`
 *   2. Set env: LLM_PROVIDER=vertex, VERTEX_PROJECT_ID=…, VERTEX_REGION=…,
 *      GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   3. Restart. Smoke-test a single Claude call (any orchestrator turn).
 *   4. To rollback: unset LLM_PROVIDER (defaults back to anthropic), restart.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import logger from '../utils/logger';

let cachedClient: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (cachedClient) return cachedClient;

  if (config.LLM_PROVIDER === 'vertex') {
    try {
      // Lazy require so non-vertex deploys don't need the package installed.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AnthropicVertex } = require('@anthropic-ai/vertex-sdk') as {
        AnthropicVertex: new (opts: { projectId: string; region: string }) => Anthropic;
      };
      cachedClient = new AnthropicVertex({
        projectId: config.VERTEX_PROJECT_ID,
        region: config.VERTEX_REGION,
      });
      logger.info('LLM provider — Vertex', {
        projectId: config.VERTEX_PROJECT_ID,
        region: config.VERTEX_REGION,
      });
    } catch (err) {
      logger.error('LLM_PROVIDER=vertex but @anthropic-ai/vertex-sdk could not be loaded', {
        err: String(err).slice(0, 300),
      });
      throw new Error(
        'Vertex provider selected but @anthropic-ai/vertex-sdk is not installed. ' +
        'Run: npm install @anthropic-ai/vertex-sdk',
      );
    }
  } else {
    cachedClient = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    logger.info('LLM provider — Anthropic direct');
  }

  return cachedClient;
}
