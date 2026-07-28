import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Infrastructure-level config only.
 * No user-specific data here — that all lives in config/users/<name>.yaml
 * Slack tokens also live in the YAML per user, not here.
 */
const configSchema = z.object({
  // ── LLM provider ─────────────────────────────────────────────────────────
  // Where Claude calls actually go: direct Anthropic API (default) or Google
  // Vertex AI (for company-hosted LLM access). Same model family, same tool
  // semantics — only the client construction + auth differs.
  LLM_PROVIDER: z.enum(['anthropic', 'vertex']).default('anthropic'),

  // Anthropic direct (required when LLM_PROVIDER=anthropic, ignored on vertex)
  ANTHROPIC_API_KEY: z.string().optional().default(''),

  // Vertex (required when LLM_PROVIDER=vertex, ignored on anthropic)
  // GOOGLE_APPLICATION_CREDENTIALS is the standard Google env var pointing
  // at a service account JSON; read by the Vertex SDK automatically.
  VERTEX_PROJECT_ID: z.string().optional().default(''),
  VERTEX_REGION: z.string().optional().default('us-east5'),

  // Azure / Microsoft Graph — same app registration, TWO auth modes:
  //   - app-only (ClientSecretCredential, graphClient.ts) for calendar —
  //     tenant-wide free/busy, unchanged.
  //   - delegated (authorization-code + refresh token, graph/mail.ts) for
  //     mail — scoped to one signed-in mailbox by construction (#24 owner
  //     decision: cloneable without an org IT/RBAC step). These three
  //     values are the client id/secret/tenant BOTH modes authenticate
  //     against; the mail refresh-token seed itself lives in
  //     EMAIL_REFRESH_TOKEN / channels.email.refresh_token, not here.
  AZURE_TENANT_ID: z.string().uuid(),
  AZURE_CLIENT_ID: z.string().uuid(),
  AZURE_CLIENT_SECRET: z.string().min(1),

  // v4.3.0 (#24) — optional env override for the email channel's refresh-
  // token SEED (see userProfile.ts applyEmailTokenEnvOverride). Read via
  // process.env directly there (profile-scoped, not infra-scoped), so it's
  // intentionally NOT part of this zod schema — declaring it here would make
  // it required-or-warned for every deploy even when channels.email is off.

  // Storage
  DB_PATH: z.string().default('./data/maelle.db'),
  LOG_PATH: z.string().default('./logs'),

  // OpenAI — for voice transcription (Whisper) and TTS
  OPENAI_API_KEY: z.string().optional().default(''),

  // Tavily — for general knowledge web search (free tier at tavily.com, no credit card)
  TAVILY_API_KEY: z.string().optional().default(''),

  // Brave Search — alternative web search (optional, falls back to Tavily or DuckDuckGo)
  BRAVE_SEARCH_API_KEY: z.string().optional().default(''),

  // WhatsApp — owner's phone number in international format without +
  WHATSAPP_OWNER_PHONE: z.string().optional().default(''),

  // Runtime
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Missing or invalid environment variables:');
  parsed.error.issues.forEach((issue) => {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  });
  process.exit(1);
}

// Cross-field validation — required keys depend on the chosen provider.
const cfg = parsed.data;
if (cfg.LLM_PROVIDER === 'anthropic') {
  if (!cfg.ANTHROPIC_API_KEY || !cfg.ANTHROPIC_API_KEY.startsWith('sk-ant-')) {
    console.error('❌ LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY starting with "sk-ant-".');
    process.exit(1);
  }
} else if (cfg.LLM_PROVIDER === 'vertex') {
  if (!cfg.VERTEX_PROJECT_ID) {
    console.error('❌ LLM_PROVIDER=vertex requires VERTEX_PROJECT_ID.');
    process.exit(1);
  }
  // GOOGLE_APPLICATION_CREDENTIALS is read by the Vertex SDK directly; warn if missing.
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.warn('⚠️  LLM_PROVIDER=vertex but GOOGLE_APPLICATION_CREDENTIALS is not set. Vertex SDK will look in the default Google Cloud auth chain (gcloud CLI, metadata server, etc).');
  }
}

export const config = cfg;
export type Config = typeof config;
