// Operator CLI, not part of normal release tests. Requires built code, exact
// reviewed private plan, and quiesced writers for apply/reverse. Never logs data.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const mode = process.argv[2];
if (!['preflight','apply','reverse'].includes(mode) || process.argv.length !== 3) {
  console.error('Usage: node scripts/canonical-stores-migration.cjs preflight|apply|reverse');
  process.exit(2);
}
const { config } = require('../dist/config');
const { loadAllProfiles } = require('../dist/config/userProfile');
const { migrateCanonicalStores, reverseCanonicalStores } = require('../dist/db/migrations/canonicalStores');
const directory = path.dirname(config.DB_PATH);
const backup = path.join(directory, 'canonical-stores-backup.json');
const db = new Database(config.DB_PATH, { readonly: mode === 'preflight', fileMustExist: true });
(async () => {
  try {
    const profiles = [...loadAllProfiles().values()];
    if (mode === 'reverse') reverseCanonicalStores(db, profiles, backup);
    else {
      const plan = JSON.parse(fs.readFileSync(path.join(directory, 'canonical-stores-plan.json'), 'utf8'));
      await migrateCanonicalStores(db, profiles, plan, backup, mode === 'preflight');
    }
    console.log(`Canonical stores ${mode} completed.`);
  } catch (err) {
    // Parser/filesystem messages may quote private source bytes; print only our
    // structured refusal identifiers, retaining details in the private inputs.
    const code = err instanceof Error && /^(?:migration|canonical)_[a-z_]+$/.test(err.message) ? err.message : 'validation_or_storage_failure';
    console.error(`Canonical stores ${mode} refused: ${code}`);
    process.exitCode = 1;
  } finally { db.close(); }
})();
