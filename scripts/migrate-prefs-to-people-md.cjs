#!/usr/bin/env node
/**
 * One-shot migration — `people`-category preferences → per-person markdown.
 *
 * Background: pre-v2.3.9 the learn_preference tool description told Sonnet to
 * save person facts via category=people. Result: 48 rows in user_preferences
 * holding role descriptions, communication-style notes, slack-id mappings, and
 * travel context. v2.2.1 introduced the proper home for this content
 * (config/users/<owner>_people/<slug>.md) but the legacy rows never moved.
 *
 * v2.3.9 dropped 'people' from the learn_preference enum and updated the tool
 * description to point at update_person_memory / update_person_profile. This
 * script migrates the legacy rows.
 *
 * Behaviour split:
 *   - PERSON: row contains durable bio facts about a single person → merge into
 *     <slug>.md under a chosen section.
 *   - SLACK_ID: row is a useless role→slack-id mapping (Maelle re-saving data
 *     that already lives in people_memory.slack_id). Just delete.
 *   - HEBREW_NAME: special case — write into people_memory.name_he, then drop.
 *   - DUP: byte-equivalent to another row → drop.
 *
 * Usage:
 *   node scripts/migrate-prefs-to-people-md.cjs           # dry-run (default)
 *   node scripts/migrate-prefs-to-people-md.cjs --commit  # actually write + delete
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
const peopleRoot = path.join(repoRoot, 'config', 'users', `${OWNER_NAME}_people`);

const db = new Database(dbPath);

/**
 * Migration plan — explicit per-key decisions.
 * 'section' is the markdown h2 the row's value will be merged under in the
 * person's md file. 'into' is the slug (file basename without .md).
 */
const PLAN = [
  // Slack-id rows: useless duplicates of people_memory.slack_id — drop without migration
  { key: 'close_advisor_slack_id',                action: 'slack_id' },
  { key: 'cto_cofounder_slack_id',                action: 'slack_id' },
  { key: 'director_customer_success_slack_id',    action: 'slack_id' },
  { key: 'director_finance_slack_id',             action: 'slack_id' },
  { key: 'director_ops_hr_slack_id',              action: 'slack_id' },
  { key: 'product_marketing_slack_id',            action: 'slack_id' },
  { key: 'sales_operations_slack_id',             action: 'slack_id' },
  { key: 'vp_engineering_slack_id',               action: 'slack_id' },
  { key: 'vp_product_slack_id',                   action: 'slack_id' },
  { key: 'vp_sales_americas_slack_id',            action: 'slack_id' },
  { key: 'vp_sales_emea_slack_id',                action: 'slack_id' },

  // Special: Hebrew name → people_memory.name_he
  { key: 'ysrael_gurt_hebrew_name',               action: 'hebrew_name', name: 'Ysrael Gurt', name_he: 'ישראל' },

  // Dup row (ali_amomin and ali_amomin_contact have near-identical content)
  { key: 'ali_amomin_contact',                    action: 'dup_of', dup_of: 'ali_amomin' },

  // Person bio rows — merge into <slug>.md under chosen section
  { key: 'alex_wiggins_work_week',                action: 'person', into: 'alex-wiggins',     name: 'Alex Wiggins',     section: 'Working hours' },
  { key: 'ali_amomin',                            action: 'person', into: 'ali-amomin',       name: 'Ali Amomin',       section: 'Profile' },
  { key: 'amazia_keidar_profile',                 action: 'person', into: 'amazia-keidar',    name: 'Amazia Keidar',    section: 'Profile' },
  { key: 'brett_johnson_profile',                 action: 'person', into: 'brett-johnson',    name: 'Brett Johnson',    section: 'Profile' },
  { key: 'brett_johnson_vp_sales_americas',       action: 'person', into: 'brett-johnson',    name: 'Brett Johnson',    section: 'Profile' },
  { key: 'cs_team_profile',                       action: 'person', into: 'elinor-avny',      name: 'Elinor Avny',      section: 'Team' },
  { key: 'dan_beauregard_profile',                action: 'person', into: 'dan-beauregard',   name: 'Dan Beauregard',   section: 'Profile' },
  { key: 'dina_shkolnik_profile',                 action: 'person', into: 'dina-shkolnik',    name: 'Dina Shkolnik',    section: 'Profile' },
  { key: 'dina_shkolnik_sales_operations',        action: 'person', into: 'dina-shkolnik',    name: 'Dina Shkolnik',    section: 'Profile' },
  { key: 'elan_hershcovitz_profile',              action: 'person', into: 'elan-hershcovitz', name: 'Elan Hershcovitz', section: 'Profile' },
  { key: 'elan_hershcovitz_vp_engineering',       action: 'person', into: 'elan-hershcovitz', name: 'Elan Hershcovitz', section: 'Profile' },
  { key: 'elinor_avny_profile',                   action: 'person', into: 'elinor-avny',      name: 'Elinor Avny',      section: 'Profile' },
  { key: 'elinor_avny_director_customer_success', action: 'person', into: 'elinor-avny',      name: 'Elinor Avny',      section: 'Profile' },
  { key: 'gidon_pely_close_advisor',              action: 'person', into: 'gidon-pely',       name: 'Gidon Pely',       section: 'Profile' },
  { key: 'gidon_pely_role',                       action: 'person', into: 'gidon-pely',       name: 'Gidon Pely',       section: 'Profile' },
  { key: 'isaac_moddel_profile',                  action: 'person', into: 'isaac-moddel',     name: 'Isaac Moddel',     section: 'Profile' },
  { key: 'isaac_moddel_vp_sales_emea',            action: 'person', into: 'isaac-moddel',     name: 'Isaac Moddel',     section: 'Profile' },
  { key: 'julia_rainesh_profile',                 action: 'person', into: 'julia-rainesh',    name: 'Julia Rainesh',    section: 'Profile' },
  { key: 'levana_bagants_profile',                action: 'person', into: 'levana-bagants',   name: 'Levana Bagants',   section: 'Profile' },
  { key: 'maayan_sulami_profile',                 action: 'person', into: 'maayan-sulami',    name: 'Maayan Sulami',    section: 'Profile' },
  { key: 'maayan_sulami_product_marketing',       action: 'person', into: 'maayan-sulami',    name: 'Maayan Sulami',    section: 'Profile' },
  { key: 'michal_schwartz_profile',               action: 'person', into: 'michal-schwartz',  name: 'Michal Schwartz',  section: 'Profile' },
  { key: 'michal_schwartz_director_finance',      action: 'person', into: 'michal-schwartz',  name: 'Michal Schwartz',  section: 'Profile' },
  { key: 'onn_nir_profile',                       action: 'person', into: 'onn-nir',          name: 'Onn Nir',          section: 'Profile' },
  { key: 'oran_frenkel_profile',                  action: 'person', into: 'oran-frenkel',     name: 'Oran Frenkel',     section: 'Profile' },
  { key: 'oran_replies_outside_threads',          action: 'person', into: 'oran-frenkel',     name: 'Oran Frenkel',     section: 'Communication style' },
  { key: 'simon_arazi_profile',                   action: 'person', into: 'simon-arazi',      name: 'Simon Arazi',      section: 'Profile' },
  { key: 'simon_arazi_context',                   action: 'person', into: 'simon-arazi',      name: 'Simon Arazi',      section: 'Profile' },
  { key: 'simon_arazi_vp_product',                action: 'person', into: 'simon-arazi',      name: 'Simon Arazi',      section: 'Profile' },
  { key: 'yael_aharon_context',                   action: 'person', into: 'yael-aharon',      name: 'Yael Aharon',      section: 'Profile' },
  { key: 'yael_aharon_director_ops_hr',           action: 'person', into: 'yael-aharon',      name: 'Yael Aharon',      section: 'Profile' },
  { key: 'yael_boston_june_2026',                 action: 'person', into: 'yael-aharon',      name: 'Yael Aharon',      section: 'Travel' },
  { key: 'ysrael_gurt_profile',                   action: 'person', into: 'ysrael-gurt',      name: 'Ysrael Gurt',      section: 'Profile' },
  { key: 'ysrael_gurt_context',                   action: 'person', into: 'ysrael-gurt',      name: 'Ysrael Gurt',      section: 'Profile' },
  { key: 'ysrael_gurt_cto_cofounder',             action: 'person', into: 'ysrael-gurt',      name: 'Ysrael Gurt',      section: 'Profile' },
];

const getRow = db.prepare('SELECT key, value FROM user_preferences WHERE user_id = ? AND key = ?');
const deleteRow = db.prepare('DELETE FROM user_preferences WHERE user_id = ? AND key = ?');
const setNameHe = db.prepare('UPDATE people_memory SET name_he = ? WHERE name = ?');

console.log(`\n${'='.repeat(72)}`);
console.log(`people-prefs → per-person md migration  (${COMMIT ? 'COMMIT' : 'DRY RUN'})`);
console.log(`${'='.repeat(72)}\n`);

// Group person rows by slug so we write each file once with all merged content
const personGroups = new Map(); // slug → { name, sections: Map<sectionName, string[]> }

const summary = { person: 0, slackId: 0, dup: 0, hebrew: 0, missing: 0, errors: 0 };

for (const item of PLAN) {
  const row = getRow.get(OWNER_ID, item.key);
  if (!row) {
    summary.missing++;
    console.log(`SKIP   ${item.key}    (already migrated or never present)`);
    continue;
  }

  if (item.action === 'slack_id') {
    summary.slackId++;
    console.log(`DROP   ${item.key}    → useless slack-id mapping (people_memory already has this)`);
    if (COMMIT) deleteRow.run(OWNER_ID, item.key);
    continue;
  }

  if (item.action === 'dup_of') {
    summary.dup++;
    console.log(`DUP    ${item.key}    → drop (near-equiv of ${item.dup_of})`);
    if (COMMIT) deleteRow.run(OWNER_ID, item.key);
    continue;
  }

  if (item.action === 'hebrew_name') {
    summary.hebrew++;
    console.log(`SET    ${item.key}    → people_memory.name_he = '${item.name_he}' for "${item.name}", then drop pref`);
    if (COMMIT) {
      const result = setNameHe.run(item.name_he, item.name);
      if (result.changes === 0) {
        console.log(`       (note: people_memory row for "${item.name}" not found — content lost; consider re-saving manually)`);
      }
      deleteRow.run(OWNER_ID, item.key);
    }
    continue;
  }

  if (item.action === 'person') {
    summary.person++;
    if (!personGroups.has(item.into)) {
      personGroups.set(item.into, { name: item.name, sections: new Map() });
    }
    const grp = personGroups.get(item.into);
    if (!grp.sections.has(item.section)) grp.sections.set(item.section, []);
    grp.sections.get(item.section).push(row.value.trim());
  }
}

// Write/preview the merged files
console.log(`\n${'='.repeat(72)}\nFiles to write\n${'='.repeat(72)}\n`);
for (const [slug, grp] of personGroups) {
  const fullPath = path.join(peopleRoot, `${slug}.md`);
  const exists = fs.existsSync(fullPath);

  let content = `# ${grp.name}\n`;
  for (const [section, items] of grp.sections) {
    content += `\n## ${section}\n\n`;
    // De-dupe near-identical lines (when a person had `_profile` and `_<role>` rows
    // that say almost the same thing, take the longer one only)
    const unique = collapseSimilar(items);
    content += unique.join('\n\n') + '\n';
  }
  // Pad with empty template sections so future writePersonSection calls find them
  const TEMPLATE_SECTIONS = ['Residence', 'Workplace', 'Working hours', 'Communication style', "What we've discussed"];
  for (const tmpl of TEMPLATE_SECTIONS) {
    if (!grp.sections.has(tmpl) && !content.includes(`\n## ${tmpl}\n`)) {
      content += `\n## ${tmpl}\n\n`;
    }
  }

  const action = exists ? 'OVERWRITE' : 'WRITE';
  console.log(`${action.padEnd(10)} ${slug}.md   sections: [${[...grp.sections.keys()].join(', ')}]   bytes: ${content.length}`);

  if (COMMIT) {
    fs.mkdirSync(peopleRoot, { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    // Now delete every pref that fed into this file
    for (const item of PLAN) {
      if (item.action === 'person' && item.into === slug) {
        deleteRow.run(OWNER_ID, item.key);
      }
    }
  }
}

console.log(`\n${'='.repeat(72)}`);
console.log(`Summary  (mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'})`);
console.log(`${'='.repeat(72)}`);
console.log(`  person rows merged into md files:    ${summary.person}`);
console.log(`  person md files written:             ${personGroups.size}`);
console.log(`  slack_id rows dropped:               ${summary.slackId}`);
console.log(`  hebrew_name → name_he:               ${summary.hebrew}`);
console.log(`  dup rows dropped:                    ${summary.dup}`);
console.log(`  already migrated (skipped):          ${summary.missing}`);
console.log(`  errors:                              ${summary.errors}`);

if (!COMMIT) {
  console.log(`\nNothing was actually written or deleted. Re-run with --commit to apply.`);
} else {
  console.log(`\n✅ Migration committed.`);
}

/**
 * When two row values are near-identical (e.g. simon_arazi_profile +
 * simon_arazi_context where one is a strict subset of the other), keep only
 * the longer one. Falls back to keeping both if they're substantially
 * different.
 */
function collapseSimilar(items) {
  const sorted = [...items].sort((a, b) => b.length - a.length);
  const kept = [];
  for (const item of sorted) {
    const isSubset = kept.some(k => k.includes(item) || normalize(k) === normalize(item));
    if (!isSubset) kept.push(item);
  }
  return kept;
}
function normalize(s) { return s.toLowerCase().replace(/\s+/g, ' ').trim(); }
