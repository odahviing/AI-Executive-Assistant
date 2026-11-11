const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, after, test } = require('node:test');

// Modes and types of the five existing columns in maelle_logs_20261111.
const columns = [
  { field: 'resolved', repeated: true, alias: 'resolvedScalar', scalar: 'person@example.test' },
  { field: 'dropped', repeated: true, alias: 'droppedCount', scalar: 2 },
  { field: 'notes', repeated: true, alias: 'notesCount', scalar: 1 },
  { field: 'added', repeated: false, alias: 'addedList', scalar: 3 },
  { field: 'summary', repeated: false, alias: 'summaryList', scalar: 'summary' },
];
const values = ['first value', 'שני'];

if (process.argv[2] === '--emit') {
  const logger = require('../src/utils/logger.ts').default;
  for (const { field, scalar } of columns) {
    logger.info('scalar-' + field, { [field]: scalar, unrelated: ['keep'] });
    logger.info('collection-' + field, { [field]: values });
    logger.info('empty-' + field, { [field]: [] });
  }
  logger.error('collision', { resolved: 'old value', resolvedScalar: 'existing', resolvedScalarFromLegacy: 'also existing' });
  const nested = { detail: { allowed: false }, labels: ['א', 'b'] };
  logger.error('historical', { code: 'invalid_client', err: nested, requested: '2026-09-17T17:45:00+03:00',
    items: [nested], moving_event_ids: 'legacy-id' });
  logger.info('historical-controls', { code: 403, err: 'failure', requested: 30, items: 4, moving_event_ids: ['event-1'] });
  const cycle = {}; cycle.self = cycle;
  logger.error('cycle', { err: cycle });
  logger.info('ordinary', { detail: 'preserved' });
} else {
  let directory;
  let entries;

  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maelle-sink-'));
    const child = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', __filename, '--emit'], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, LOG_PATH: directory, NODE_ENV: 'production' },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    const files = fs.readdirSync(directory).filter(name => /^maelle-.*\.log$/.test(name));
    entries = files.flatMap(name => fs.readFileSync(path.join(directory, name), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
  });
  after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

  for (const { field, alias, scalar, repeated } of columns) {
    test(field + ' keeps values compatible with its existing BigQuery column and preserves the other shape', () => {
      for (const [prefix, expected] of [['scalar-', scalar], ['collection-', values], ['empty-', []]]) {
        const entry = entries.find(row => row.message === prefix + field);
        assert.ok(entry);
        const compatible = Array.isArray(expected) === repeated;
        assert.deepEqual(entry[compatible ? field : alias], expected);
        assert.equal(Object.hasOwn(entry, compatible ? alias : field), false);
        if (prefix === 'scalar-') assert.deepEqual(entry.unrelated, ['keep']);
      }
    });
  }
  test('an existing alias and its metadata survive in both rotating transports', () => {
    const errorFiles = fs.readdirSync(directory).filter(name => /^error-.*\.log$/.test(name));
    const errorEntries = errorFiles.flatMap(name => fs.readFileSync(path.join(directory, name), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
    for (const rows of [entries, errorEntries]) {
      const entry = rows.find(row => row.message === 'collision');
      assert.equal(entry.resolvedScalar, 'existing');
      assert.equal(entry.resolvedScalarFromLegacy, 'also existing');
      assert.equal(entry.resolvedScalarFromLegacyFromLegacy, 'old value');
      assert.equal(Object.hasOwn(entry, 'resolved'), false);
    }
  });
  test('ordinary log entries keep their metadata', () => {
    const entry = entries.find(row => row.message === 'ordinary');
    assert.equal(entry.service, 'maelle');
    assert.equal(entry.detail, 'preserved');
  });
  test('historically rejected fields preserve the full nested objects and original string values', () => {
    const row = entries.find(r => r.message === 'historical');
    assert.equal(row.codeText, 'invalid_client');
    assert.equal(row.requestedText, '2026-09-17T17:45:00+03:00');
    assert.equal(row.movingEventIdsText, 'legacy-id');
    const nested = { detail: { allowed: false }, labels: ['א', 'b'] };
    assert.deepEqual(JSON.parse(row.err), nested);
    assert.deepEqual(JSON.parse(row.itemsJson), [nested]);
    for (const key of ['code', 'requested', 'moving_event_ids', 'items']) assert.equal(Object.hasOwn(row, key), false);
  });
  test('existing scalar and array columns keep their legitimate values', () => {
    const row = entries.find(r => r.message === 'historical-controls');
    assert.deepEqual([row.code, row.err, row.requested, row.items, row.moving_event_ids], [403, 'failure', 30, 4, ['event-1']]);
  });
  test('Winston retains its circular-reference handling for nested errors', () => {
    const row = entries.find(r => r.message === 'cycle');
    assert.equal(JSON.parse(row.err).self, '[Circular]');
  });
}
