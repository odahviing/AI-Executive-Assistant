#!/usr/bin/env node
/**
 * One-off: ingest a list of local PDFs into the KB.
 *
 * Usage:
 *   npm run build && node scripts/ingest-local-pdfs.mjs
 *
 * Edit the PATHS array below to change what gets ingested.
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import Anthropic from '@anthropic-ai/sdk';

const PATHS = [
  'D:/Downloads/618_PCI Product page 2026.pdf',
  'D:/Downloads/607_Policies Product Pager_v5.pdf',
  'D:/Downloads/Security Hub Standard Pager (1).pdf',
  'D:/Downloads/Privacy Hub Standard Pager (1).pdf',
];

const profilePath = resolve(process.cwd(), 'config', 'users', 'idan.yaml');
const profile = yaml.load(readFileSync(profilePath, 'utf-8'));

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in env.');
  process.exit(1);
}

let ingestKnowledgeDoc, PDFParse;
try {
  ({ ingestKnowledgeDoc } = await import('../dist/skills/knowledge.js'));
  ({ PDFParse } = await import('pdf-parse'));
} catch (err) {
  console.error('Could not load compiled helpers. Did you run `npm run build`?');
  console.error(String(err));
  process.exit(1);
}

const anthropic = new Anthropic();

let created = 0, merged = 0, sibling = 0, rejected = 0, errors = 0;

for (const [i, filePath] of PATHS.entries()) {
  const idx = `[${i + 1}/${PATHS.length}]`;
  console.log(`\n${idx} ${filePath}`);
  try {
    const buf = readFileSync(filePath);
    const parser = new PDFParse({ data: buf });
    const parsed = await parser.getText();
    const text = (parsed.text || '').trim();
    if (text.length < 50) {
      console.log(`${idx}   SKIP — extracted text too short (${text.length} chars)`);
      errors++;
      continue;
    }
    console.log(`${idx}   Extracted ${text.length} chars, ingesting...`);
    const fileName = filePath.split(/[/\\]/).pop();
    const result = await ingestKnowledgeDoc({
      profile,
      text,
      sourceHint: fileName,
      ownerCaption: `Reflectiz product collateral — direct PDF upload from owner.`,
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
