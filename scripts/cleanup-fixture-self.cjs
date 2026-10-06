// Exact historical fixture repair. Default is read-only; rehearsal mutates only a backup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const TARGET = { person_id: 'p_SELF_U12345TEST', slack_id: 'SELF:U12345TEST' };
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const quote = name => '"' + name.replaceAll('"', '""') + '"';
function rowsHash(db) {
  return hash(db.prepare('SELECT * FROM people_memory ORDER BY person_id').all());
}
function inspect(db, owners) {
  if (!owners.length || owners.includes('U12345TEST')) throw new Error('fixture is a configured owner or owners unavailable');
  const row = db.prepare('SELECT * FROM people_memory WHERE person_id=? OR slack_id=?').get(TARGET.person_id, TARGET.slack_id);
  if (!row) return { absent: true };
  if (row.person_id !== TARGET.person_id || row.slack_id !== TARGET.slack_id || row.name !== 'Maelle' || row.email !== null || row.kind !== 'self' || row.created_at !== '2026-05-24 18:33:37' || row.last_seen !== '2026-05-24 18:33:37') throw new Error('fixture identity changed');
  if (row.notes !== '[]' || row.interaction_log !== '[]' || row.profile_json !== '{}' || row.currently_traveling || row.last_social_at || row.last_initiated_at || row.proactive_pending || row.last_social_capture_unknown_at) throw new Error('fixture acquired meaningful content');
  for (const owner of owners) {
    if (!db.prepare('SELECT 1 FROM people_memory WHERE slack_id=? AND kind=?').get(`SELF:${owner}`, 'self')) throw new Error('configured self missing');
  }
  const refs = [];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    if (name === 'people_memory') continue;
    for (const col of db.prepare(`PRAGMA table_info(${quote(name)})`).all()) {
      // SQLite permits TEXT values even in columns declared without a text affinity.
      for (const id of [TARGET.person_id, TARGET.slack_id, 'U12345TEST']) {
        const { n } = db.prepare(`SELECT count(*) n FROM ${quote(name)} WHERE instr(CAST(${quote(col.name)} AS TEXT),?)>0`).get(id);
        if (n) refs.push({ table: name, column: col.name, id, count: n });
      }
    }
  }
  if (refs.length) throw new Error(`fixture referenced: ${JSON.stringify(refs)}`);
  return { absent: false, row, rowHash: hash(row), peopleHash: rowsHash(db) };
}
function remove(db, owners, expectedHash) {
  return db.transaction(() => {
    const before = inspect(db, owners);
    if (before.absent) return { alreadyAbsent: true };
    if (before.rowHash !== expectedHash) throw new Error('reviewed row changed');
    const unrelated = hash(db.prepare('SELECT * FROM people_memory WHERE person_id<>? ORDER BY person_id').all(TARGET.person_id));
    const result = db.prepare('DELETE FROM people_memory WHERE person_id=? AND slack_id=?').run(TARGET.person_id, TARGET.slack_id);
    if (result.changes !== 1 || !inspect(db, owners).absent) throw new Error('exact deletion postcondition failed');
    if (unrelated !== rowsHash(db)) throw new Error('unrelated person changed');
    return { removed: 1, row: before.row, unrelatedHash: unrelated };
  }).immediate();
}
function restore(db, row) {
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM people_memory WHERE person_id=? OR slack_id=?').get(row.person_id, row.slack_id)) throw new Error('restore identity conflict');
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO people_memory (${keys.map(quote).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k]));
  }).immediate();
}
async function main() {
  const [mode = 'inspect', appArg = process.cwd(), destination] = process.argv.slice(2);
  if (!['inspect', 'rehearse'].includes(mode)) throw new Error('only inspect and rehearse are exposed; live apply requires reviewed maintenance invocation');
  const app = path.resolve(appArg);
  const Database = require(require.resolve('better-sqlite3', { paths: [app] }));
  const yaml = require(require.resolve('js-yaml', { paths: [app] }));
  const users = path.join(app, 'config/users');
  const owners = fs.readdirSync(users).filter(n => n.endsWith('.yaml')).map(n => yaml.load(fs.readFileSync(path.join(users, n), 'utf8'))?.user?.slack_user_id);
  if (owners.some(o => typeof o !== 'string' || !o)) throw new Error('invalid configured owner');
  const source = path.join(app, 'data/maelle.db');
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    const before = inspect(db, owners);
    if (mode === 'inspect' || before.absent) return console.log(JSON.stringify({ mode, before, owners }, null, 2));
    if (!destination) throw new Error('fresh backup directory required');
    const output = path.resolve(destination);
    if (output === app || output.startsWith(app + path.sep)) throw new Error('backup must be outside application');
    fs.mkdirSync(output, { recursive: false });
    const backup = path.join(output, 'original.db');
    await db.backup(backup);
    const backed = new Database(backup, { readonly: true, fileMustExist: true });
    let snapshot;
    try {
      if (backed.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('backup integrity failed');
      snapshot = inspect(backed, owners);
      if (snapshot.rowHash !== before.rowHash) throw new Error('fixture changed during backup');
    } finally { backed.close(); }
    fs.writeFileSync(path.join(output, 'fixture-row.json'), JSON.stringify(snapshot.row, null, 2));
    const backupHash = hash(fs.readFileSync(backup));
    const rehearsal = path.join(output, 'rehearsal.db');
    fs.copyFileSync(backup, rehearsal, fs.constants.COPYFILE_EXCL);
    const isolated = new Database(rehearsal, { fileMustExist: true });
    let deletion;
    try {
      deletion = remove(isolated, owners, snapshot.rowHash);
      if (!remove(isolated, owners, snapshot.rowHash).alreadyAbsent) throw new Error('repeat deletion not idempotent');
      restore(isolated, snapshot.row);
      if (rowsHash(isolated) !== snapshot.peopleHash) throw new Error('reversal did not restore exact people state');
      if (isolated.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('rehearsal integrity failed');
    } finally { isolated.close(); }
    const report = { mode, observedAt: new Date().toISOString(), source, sourceReadonly: true, productionDeletes: 0, owners, backup, backupHash, rowHash: snapshot.rowHash, originalPeopleHash: snapshot.peopleHash, removedInIsolatedCopy: deletion.removed, repeatNoop: true, exactReversal: true, integrity: 'ok' };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { db.close(); }
}
module.exports = { inspect, remove, restore, hash, rowsHash };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

