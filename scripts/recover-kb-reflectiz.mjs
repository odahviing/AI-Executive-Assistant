#!/usr/bin/env node
/**
 * One-off recovery script: re-ingest the Reflectiz URLs that were fetched via
 * web_extract between Apr 17-20 2026 but never persisted (KB ingest path didn't
 * exist yet). Pulls content via Tavily, runs through the new
 * ingestKnowledgeDoc pipeline, files under the owner's KB.
 *
 * Usage:
 *   npm run build && node scripts/recover-kb-reflectiz.mjs
 *
 * Safe to re-run — ingest pipeline handles duplicates via merge/sibling logic.
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import Anthropic from '@anthropic-ai/sdk';

const URLS = [
  // files.reflectiz.com — product / marketing PDFs
  'https://files.reflectiz.com/hubfs/Documents/Collaterals/Our%20proactive%20approach.pdf',
  'https://files.reflectiz.com/hubfs/Documents/Collaterals/PCI/Reflectiz%20Shopify%20pager.pdf',
  'https://files.reflectiz.com/hubfs/Documents/Collaterals/Product%20explainers/AI%20Explainer.pdf',
  'https://files.reflectiz.com/hubfs/Documents/Collaterals/Product%20explainers/Exposure%20Rating%20explained.pdf',
  'https://files.reflectiz.com/hubfs/Documents/Collaterals/Reflectiz%20strategic%20pager.pdf',
  'https://files.reflectiz.com/hubfs/Documents/Collaterals/Why%20we%20choose%20Remote%3F.pdf',
  // www.reflectiz.com — public site pages
  'https://www.reflectiz.com/about/',
  'https://www.reflectiz.com/blog/',
  'https://www.reflectiz.com/magecart/',
  'https://www.reflectiz.com/pci-dss/',
  'https://www.reflectiz.com/product/',
  'https://www.reflectiz.com/solutions/',
  'https://www.reflectiz.com/use-cases/',
];

// Resolve profile path (idan.yaml)
const profilePath = resolve(process.cwd(), 'config', 'users', 'idan.yaml');
const profile = yaml.load(readFileSync(profilePath, 'utf-8'));

if (!process.env.TAVILY_API_KEY) {
  console.error('Missing TAVILY_API_KEY in env.');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in env.');
  process.exit(1);
}

// Import the compiled helpers from dist/
let tavilyExtract, ingestKnowledgeDoc;
try {
  ({ tavilyExtract } = await import('../dist/skills/general.js'));
  ({ ingestKnowledgeDoc } = await import('../dist/skills/knowledge.js'));
} catch (err) {
  console.error('Could not load compiled helpers from dist/. Did you run `npm run build` first?');
  console.error(String(err));
  process.exit(1);
}

const anthropic = new Anthropic();

let created = 0, merged = 0, sibling = 0, rejected = 0, errors = 0;

for (const [i, url] of URLS.entries()) {
  const idx = `[${i + 1}/${URLS.length}]`;
  console.log(`\n${idx} Fetching ${url}`);
  try {
    const extracted = await tavilyExtract(url);
    if (!extracted || !extracted.content || extracted.content.trim().length < 50) {
      console.log(`${idx}   SKIP — page unreadable / empty`);
      errors++;
      continue;
    }
    console.log(`${idx}   Extracted ${extracted.content.length} chars, ingesting...`);
    const result = await ingestKnowledgeDoc({
      profile,
      text: extracted.content,
      sourceHint: extracted.url || url,
      ownerCaption: `Reflectiz company content — recovered from pre-2.0.2 web_extract logs.`,
      anthropic,
    });
    if (result.kind === 'created') {
      console.log(`${idx}   CREATED  →  ${result.sectionId}.md  (${result.title})`);
      created++;
    } else if (result.kind === 'merged') {
      console.log(`${idx}   MERGED   →  ${result.mergedInto}.md  (${result.title})`);
      merged++;
    } else if (result.kind === 'sibling') {
      console.log(`${idx}   SIBLING  →  ${result.sectionId}.md  (${result.title})`);
      sibling++;
    } else if (result.kind === 'ambiguous') {
      console.log(`${idx}   AMBIGUOUS — ${result.question}`);
      rejected++;
    } else {
      console.log(`${idx}   REJECTED — ${result.reason}`);
      rejected++;
    }
  } catch (err) {
    console.error(`${idx}   ERROR — ${String(err).slice(0, 300)}`);
    errors++;
  }
}

console.log(`\n────────────────────────────────────`);
console.log(`Done. created=${created}  merged=${merged}  sibling=${sibling}  rejected=${rejected}  errors=${errors}`);
console.log(`KB now lives under: config/users/${(profile?.user?.name || 'owner').split(' ')[0].toLowerCase()}_kb/`);
