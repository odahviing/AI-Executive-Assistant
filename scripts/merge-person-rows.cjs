#!/usr/bin/env node
/**
 * Collapse two people_memory rows that are ONE human into one — from the
 * command line, executing a ruling the owner has already given.
 *
 * Why this exists: the store merges on its own only when two rows share an
 * EMAIL (`resolvePerson` / `setPersonEmail` / the boot sweep, src/db/people.ts).
 * A person who changes address — the interview candidate booked under a
 * personal email who is then hired and DMs from Slack under a company one — is
 * two rows with two emails, which no automatic path will ever collapse. Only
 * the owner can say they are the same person; this is the hand that carries
 * out that ruling. It is NOT a duplicate finder: both ids are given
 * explicitly, nothing is matched or guessed. Two Slack-less rows are outside
 * it on purpose.
 *
 * A MERGE IS NOT REVERSIBLE. The loser row is deleted and its per-person md
 * file is folded into the survivor's. Dry run is the default: the script
 * prints both rows and every field that would change, then stops. Only
 * `--confirm` writes.
 *
 * Refuses when: an id is missing, the two ids are the same, or the survivor is
 * not the Slack-keyed row (the canonical survivor rule — `getPersonByEmail`,
 * src/db/people.ts: Slack wins). `planPersonMerge` adds its own identity
 * refusals (a SELF row, two distinct slack_ids); those print the same way.
 *
 * Runs against the COMPILED app (dist/), so it must run from the app root —
 * on the VM that is /mnt/disks/maelle/app — because the modules it loads
 * resolve `.env`, `./data/maelle.db` and `config/users/` from process.cwd()
 * (src/config/index.ts, src/memory/peopleMemory.ts). Opening the DB goes
 * through the app's own `getDb()`, i.e. the same idempotent schema/migration
 * pass every boot runs; the merge write itself is `mergePersonRows`, the one
 * function every runtime merge path uses — nothing is re-implemented here.
 *
 * Usage (from the app root):
 *   node scripts/merge-person-rows.cjs <survivorId> <loserId>            # dry run
 *   node scripts/merge-person-rows.cjs <survivorId> <loserId> --confirm  # write
 */

const path = require('path');
const fs = require('fs');

function die(msg) {
  process.stderr.write(`merge-person-rows: ${msg}\n`);
  process.exit(2);
}
const out = (s) => process.stdout.write(`${s}\n`);
const fmt = (v) => (v === undefined || v === null ? 'NULL' : JSON.stringify(v));

function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const ids = args.filter((a) => a !== '--confirm');
  if (ids.length !== 2 || ids.some((a) => a.startsWith('--'))) {
    die('usage: node scripts/merge-person-rows.cjs <survivorId> <loserId> [--confirm]');
  }
  const [survivorId, loserId] = ids;
  if (survivorId === loserId) die('survivor and loser are the same id — nothing to merge');

  const appRoot = path.resolve(__dirname, '..');
  if (path.relative(appRoot, process.cwd()) !== '') {
    die(`run from the app root (${appRoot}) — .env, data/maelle.db and config/users resolve from cwd`);
  }
  const distPeople = path.join(appRoot, 'dist', 'db', 'people.js');
  if (!fs.existsSync(distPeople)) die(`${distPeople} not found — build first (npm run build)`);
  const { getPersonById, planPersonMerge, mergePersonRows } = require(distPeople);
  if (typeof planPersonMerge !== 'function') {
    die('dist/ predates this script (no planPersonMerge) — deploy and wait for the watcher build');
  }

  const survivor = getPersonById(survivorId);
  const loser = getPersonById(loserId);
  if (!survivor) die(`no people_memory row with person_id ${survivorId}`);
  if (!loser) die(`no people_memory row with person_id ${loserId}`);
  if (!survivor.slack_id) {
    die(`survivor ${survivorId} has no slack_id — the Slack-keyed row must survive (getPersonByEmail rule). `
      + (loser.slack_id ? `${loserId} is the Slack row: swap the arguments.` : 'Neither row is Slack-keyed; this script does not merge that pair.'));
  }

  out(`== SURVIVOR (kept): ${survivorId} ==`);
  out(JSON.stringify(survivor, null, 2));
  out(`\n== LOSER (deleted): ${loserId} ==`);
  out(JSON.stringify(loser, null, 2));

  const plan = planPersonMerge(survivorId, loserId);
  if (!plan.ok) die(`mergePersonRows would refuse: ${plan.reason}`);
  const { merged } = plan;

  out(`\n== CHANGES to ${survivorId} ==`);
  const changed = Object.keys(merged).filter((k) => k !== 'person_id' && String(merged[k] ?? '') !== String(survivor[k] ?? ''));
  for (const k of changed) out(`  ${k}: ${fmt(survivor[k])} -> ${fmt(merged[k])}`);
  if (changed.length === 0) out('  (no field changes — the survivor already holds everything)');

  const emailKept = merged.email ?? null;
  const emailDropped = [survivor.email, loser.email].filter((e) => e && e !== emailKept);
  out(`\n  email kept:    ${emailKept ?? 'NULL'}`);
  out(`  email dropped: ${emailDropped.length ? emailDropped.join(', ') : '(none)'}`);
  out(`  slack_id:      ${merged.slack_id}`);
  out(`  row deleted:   ${loserId}`);

  // Per-person md files live at config/users/<owner>_people/<person_id>.md
  // (src/memory/peopleMemory.ts). Listed here read-only so the fold is visible
  // before it happens; the fold itself is mergePersonMdFiles, inside the merge.
  const usersRoot = path.join(appRoot, 'config', 'users');
  const mdFiles = [];
  for (const dir of fs.existsSync(usersRoot) ? fs.readdirSync(usersRoot) : []) {
    if (!dir.endsWith('_people')) continue;
    for (const id of [survivorId, loserId]) {
      const p = path.join(usersRoot, dir, `${id}.md`);
      if (fs.existsSync(p)) mdFiles.push(path.relative(appRoot, p));
    }
  }
  const loserMd = mdFiles.some((f) => f.endsWith(`${loserId}.md`));
  out(`  md files:      ${mdFiles.length ? mdFiles.join(', ') : '(none)'}${loserMd ? ` — ${loserId}.md is folded into ${survivorId}.md` : ''}`);

  if (!confirm) {
    out('\nDRY RUN — nothing written. Re-run with --confirm to apply. A merge is not reversible.');
    return;
  }

  if (!mergePersonRows(survivorId, loserId)) {
    process.exitCode = 1;
    out('\nMERGE DID NOT APPLY — see the "person store —" warning above; both rows are intact.');
    return;
  }
  out(`\nMERGED. ${loserId} deleted; ${survivorId} now:`);
  out(JSON.stringify(getPersonById(survivorId), null, 2));
}

main();
