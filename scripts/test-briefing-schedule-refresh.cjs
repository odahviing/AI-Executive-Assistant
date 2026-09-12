const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');
const { DateTime, Settings } = require('luxon');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const root = path.resolve(__dirname, '..');

function loadCrons(existing) {
  const revision = process.env.CRONS_SOURCE_REVISION;
  const source = revision
    ? cp.execFileSync('git', ['show', `${revision}:src/tasks/crons.ts`], { cwd: root, encoding: 'utf8' })
    : fs.readFileSync(path.join(root, 'src/tasks/crons.ts'), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const updates = [];
  const db = {
    prepare(sql) {
      return {
        get() { return existing; },
        run(...args) { updates.push({ sql, args }); return { changes: 1 }; },
        all() { return []; },
      };
    },
  };
  const module = { exports: {} };
  const requireMock = name => ({
    luxon: { DateTime },
    '../db': { getDb: () => db },
    '../utils/logger': { info() {}, warn() {}, error() {} },
    './briefs': { getBriefingHourMin: () => [7, 30] },
  }[name] ?? (() => { throw new Error(`Unmocked ${name}`); })());
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Date })(requireMock, module, module.exports);
  return { crons: module.exports, updates };
}

const profile = {
  user: { slack_user_id: 'owner', timezone: 'Asia/Jerusalem' },
  schedule: {
    office_days: { days: ['Monday'] },
    home_days: { days: ['Sunday', 'Tuesday'] },
  },
};

before(() => { Settings.now = () => Date.parse('2026-09-11T00:00:00Z'); });
after(() => { Settings.now = () => Date.now(); });

test('same briefing clock refreshes a future cursor after workday/profile timezone change', () => {
  const { crons, updates } = loadCrons({
    id: 'system_briefing_owner', schedule_time: '07:30',
    next_run_at: '2026-09-14T07:30:00.000Z',
  });
  crons.ensureBriefingCron(profile);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].args[0], '07:30');
  assert.equal(updates[0].args[1], '2026-09-13T04:30:00.000Z');
});

test('matching future cursor remains unchanged', () => {
  const { crons, updates } = loadCrons({
    id: 'system_briefing_owner', schedule_time: '07:30',
    next_run_at: '2026-09-13T04:30:00.000Z',
  });
  crons.ensureBriefingCron(profile);
  assert.equal(updates.length, 0);
});

test('overdue cursor remains available for materializer catch-up', () => {
  const { crons, updates } = loadCrons({
    id: 'system_briefing_owner', schedule_time: '07:30',
    next_run_at: '2026-09-10T04:30:00.000Z',
  });
  crons.ensureBriefingCron(profile);
  assert.equal(updates.length, 0);
});
