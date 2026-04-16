import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Infrastructure-level config only.
 * No user-specific data here — that all lives in config/users/<name>.yaml
 * Slack tokens also live in the YAML per user, not here.
 */
const configSchema = z.object({
  // Anthropic
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-'),

  // Azure / Microsoft Graph (app-only service principal)
  AZURE_TENANT_ID: z.string().uuid(),
  AZURE_CLIENT_ID: z.string().uuid(),
  AZURE_CLIENT_SECRET: z.string().min(1),

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

export const config = parsed.data;
export type Config = typeof config;
