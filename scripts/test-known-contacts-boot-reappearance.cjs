// Reappearance audit only: execute the real internal initSchema twice on SQLite.
// Exposing the private function does not rewrite its statements. No live DB used.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
function bootFunction() {
  const source = fs.readFileSync(path.join(root, 'src/db/client.ts'), 'utf8');
  const js = ts.transpileModule(source + '\nexport const auditInitSchema = initSchema;', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const m = { exports: {} }, logger = { info() {}, warn() {}, error() {} };
  vm.runInNewContext('(function(require,module,exports){' + js + '\n})', {})(name => {
    if (['better-sqlite3', 'path', 'fs'].includes(name)) return require(name);
    if (name === '../config') return { config: {} };
    if (name === '../config/userProfile') return { loadAllProfiles: () => new Map() };
    if (name === '../utils/logger') return { __esModule: true, default: logger };
    if (name.startsWith('./migrations/')) return {}; // These are invoked by getDb, not initSchema.
    throw Error('unexpected dependency ' + name);
  }, m, m.exports);
  return m.exports.auditInitSchema;
}
test('current boot does not resurrect known_contacts, repeats safely, and preserves actual person/event rows', () => {
  const init = bootFunction(), db = new Database(':memory:');
  try {
    init(db);
    db.prepare('INSERT INTO people_memory(slack_id,name) VALUES (?,?)').run('PERSON', 'Fixture');
    // Existing table shape, not an invented old known_contacts row.
    const personBefore = db.prepare('SELECT * FROM people_memory').all();
    const eventsBefore = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get('events');
    init(db);
    assert.deepEqual(db.prepare('SELECT * FROM people_memory').all(), personBefore);
    assert.deepEqual(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get('events'), eventsBefore);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='known_contacts'").get(), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='events'").get().n, 1);
  } finally { db.close(); }
});
test('older-version resurrected empty dead table is retired at first boot, never recreated at second', () => {
  const init = bootFunction(), db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE known_contacts(id TEXT)');
    init(db); init(db);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='known_contacts'").get(), undefined);
  } finally { db.close(); }
});
