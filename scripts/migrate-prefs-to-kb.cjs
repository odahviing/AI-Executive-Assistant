#!/usr/bin/env node
/**
 * One-shot migration — Reflectiz/ICP "preferences" → KB files.
 *
 * Background: pre-v2.3.9 the learn_preference tool description allowed any
 * "general" content, including company/product knowledge. Result: 17 reflectiz_*
 * + ICP rows accumulated in user_preferences (~10K chars). Most are inferior
 * summaries of richer KB files that already exist under config/users/<owner>_kb.
 *
 * v2.3.9 tightened the tool description and dropped 'people' from the category
 * enum. This script migrates the legacy rows out so the prefs catalog stops
 * surfacing them. Behaviour split:
 *   - REDUNDANT_WITH_KB: pref content is already covered by a richer existing
 *     KB file → just delete the pref row.
 *   - NEW_KB_FILE: pref content has no KB counterpart → write a new .md file
 *     under the relevant KB folder, then delete the pref row.
 *   - DUP: pref is an exact dup of another pref → delete (no migration needed).
 *
 * Usage:
 *   node scripts/migrate-prefs-to-kb.cjs           # dry-run (default), no writes
 *   node scripts/migrate-prefs-to-kb.cjs --commit  # actually write files + delete rows
 *
 * Idempotent: re-running on already-migrated rows is a no-op.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const COMMIT = process.argv.includes('--commit');
const OWNER_ID = 'U0F28CK6H';
const OWNER_NAME = 'idan';

const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, 'data', 'maelle.db');
const kbRoot = path.join(repoRoot, 'config', 'users', `${OWNER_NAME}_kb`, 'reflectiz');

const db = new Database(dbPath);

/**
 * Migration table — explicit per-key decisions, no inference.
 * action:
 *   - 'redundant_with_kb' — content is covered by an existing KB file. Pref is deleted, no new file written.
 *   - 'new_kb_file'       — write new KB file with the pref's value as initial content.
 *   - 'dup_of'            — pref is byte-equivalent to another pref; delete this one, keep the canonical.
 */
const PLAN = [
  // Exact byte-for-byte dupes — verified in the v2.3.9 audit
  { key: 'icp_segments',                          action: 'dup_of', dup_of: 'reflectiz_icp_segments' },
  { key: 'icp_core_criteria',                     action: 'dup_of', dup_of: 'reflectiz_icp_core_criteria' },

  // Existing KB file already has the same (or richer) content
  { key: 'reflectiz_proactive_approach',          action: 'redundant_with_kb', kb_file: 'product/proactive_approach.md' },
  { key: 'reflectiz_exposure_rating',             action: 'redundant_with_kb', kb_file: 'product/exposure_rating.md' },
  { key: 'reflectiz_remote_monitoring_advantages',action: 'redundant_with_kb', kb_file: 'product/remote_monitoring_rationale.md' },
  { key: 'reflectiz_strategic_positioning',       action: 'redundant_with_kb', kb_file: 'product/strategic_overview.md' },
  { key: 'reflectiz_ai_capabilities',             action: 'redundant_with_kb', kb_file: 'product/ai_explainer.md' },
  { key: 'reflectiz_shopify_positioning',         action: 'redundant_with_kb', kb_file: 'product/shopify_pci_gap_2.md' },
  { key: 'reflectiz_company_facts',               action: 'redundant_with_kb', kb_file: 'company/about.md' },
  { key: 'reflectiz_positioning',                 action: 'redundant_with_kb', kb_file: 'product/strategic_overview.md' },

  // No existing KB file — write new
  { key: 'reflectiz_product_capabilities',        action: 'new_kb_file', kb_file: 'product/capabilities.md',    title: 'Reflectiz Platform Capabilities' },
  { key: 'reflectiz_use_cases',                   action: 'new_kb_file', kb_file: 'product/use_cases.md',       title: 'Reflectiz Primary Use Cases' },
  { key: 'reflectiz_competitive_differentiation', action: 'new_kb_file', kb_file: 'product/competitive.md',     title: 'Reflectiz Competitive Differentiation' },
  { key: 'reflectiz_customers_and_verticals',     action: 'new_kb_file', kb_file: 'customers/overview.md',      title: 'Reflectiz Customers and Verticals' },
  { key: 'reflectiz_customer_quotes_extended',    action: 'new_kb_file', kb_file: 'customers/quotes.md',        title: 'Customer Quotes (Extended)' },
  { key: 'reflectiz_recent_content_themes',       action: 'new_kb_file', kb_file: 'blog/themes_2025_2026.md',   title: 'Reflectiz Blog and Content Themes (2025-2026)' },
  { key: 'reflectiz_values_and_culture',          action: 'new_kb_file', kb_file: 'company/values.md',          title: 'Reflectiz Values and Culture' },
  { key: 'reflectiz_icp_segments',                action: 'new_kb_file', kb_file: 'company/icp_segments.md',    title: 'Reflectiz ICP — 7 Segments' },
  { key: 'reflectiz_icp_core_criteria',           action: 'new_kb_file', kb_file: 'company/icp_core_criteria.md', title: 'Reflectiz ICP — Core Criteria' },
];

const getRow = db.prepare('SELECT key, value FROM user_preferences WHERE user_id = ? AND key = ?');
const deleteRow = db.prepare('DELETE FROM user_preferences WHERE user_id = ? AND key = ?');

console.log(`\n${'='.repeat(72)}`);
console.log(`Reflectiz/ICP prefs → KB migration  (${COMMIT ? 'COMMIT' : 'DRY RUN'})`);
console.log(`${'='.repeat(72)}\n`);

const summary = { redundant: 0, new: 0, dup: 0, missing: 0, alreadyMigrated: 0, errors: 0 };

for (const item of PLAN) {
  const row = getRow.get(OWNER_ID, item.key);
  if (!row) {
    summary.alreadyMigrated++;
    console.log(`SKIP   ${item.key}    (already migrated or never present)`);
    continue;
  }

  if (item.action === 'dup_of') {
    summary.dup++;
    console.log(`DUP    ${item.key}    → drop (byte-equiv of ${item.dup_of})`);
    if (COMMIT) deleteRow.run(OWNER_ID, item.key);
    continue;
  }

  if (item.action === 'redundant_with_kb') {
    const fullPath = path.join(kbRoot, item.kb_file);
    if (!fs.existsSync(fullPath)) {
      summary.errors++;
      console.log(`ERROR  ${item.key}    → KB file missing at ${item.kb_file}; SKIPPING delete`);
      continue;
    }
    summary.redundant++;
    const kbBytes = fs.statSync(fullPath).size;
    console.log(`KEEP   ${item.key}    → KB ${item.kb_file} already has ${kbBytes} bytes; drop pref (${row.value.length} chars).`);
    if (COMMIT) deleteRow.run(OWNER_ID, item.key);
    continue;
  }

  if (item.action === 'new_kb_file') {
    const fullPath = path.join(kbRoot, item.kb_file);
    if (fs.existsSync(fullPath)) {
      const kbBytes = fs.statSync(fullPath).size;
      summary.alreadyMigrated++;
      console.log(`EXISTS ${item.key}    → KB ${item.kb_file} already exists (${kbBytes} bytes); drop pref without overwriting.`);
      if (COMMIT) deleteRow.run(OWNER_ID, item.key);
      continue;
    }
    summary.new++;
    const md = `# ${item.title}\n\n_Migrated from learn_preference key \`${item.key}\` — pre-v2.3.9 prefs path. Owner can edit/expand directly._\n\n${row.value}\n`;
    console.log(`WRITE  ${item.key}    → ${item.kb_file}  (${md.length} chars)`);
    if (COMMIT) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, md, 'utf-8');
      deleteRow.run(OWNER_ID, item.key);
    }
    continue;
  }
}

console.log(`\n${'='.repeat(72)}`);
console.log(`Summary  (mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'})`);
console.log(`${'='.repeat(72)}`);
console.log(`  redundant_with_kb (delete pref):      ${summary.redundant}`);
console.log(`  new_kb_file (write + delete pref):    ${summary.new}`);
console.log(`  dup_of (delete only):                 ${summary.dup}`);
console.log(`  already migrated (skipped):           ${summary.alreadyMigrated}`);
console.log(`  errors (KB file missing):             ${summary.errors}`);
console.log(`  total rows touched:                   ${summary.redundant + summary.new + summary.dup}`);

if (!COMMIT) {
  console.log(`\nNothing was actually written or deleted. Re-run with --commit to apply.`);
} else {
  console.log(`\n✅ Migration committed.`);
}
