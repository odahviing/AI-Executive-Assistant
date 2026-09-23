const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const before = process.argv.includes('--before');
const evidence = 'artifacts/workshop-verification/v5-readiness-20260923/handyman/attempt1';
const source = fs.readFileSync(path.join(root, before ? `${evidence}/before/scripts/deploy-watcher.mjs` : 'scripts/deploy-watcher.mjs'), 'utf8').replace(/^import .*;\r?$/gm, '');
const old = 'a'.repeat(40), next = 'b'.repeat(40);
function fixture(options = {}, state = { head: old, remote: next, applied: old, persisted: old, online: true, commands: [] }) {
  let failure = options.failure;
  const logs = [];
  const sandbox = {
    process: { cwd: () => '/isolated', env: {} }, console: { log: (...args) => logs.push(args.join(' ')) },
    setInterval() {}, readFileSync: () => JSON.stringify({ version: '4.fixture' }), join: path.join,
    execSync(command, opts) {
      state.commands.push(command);
      if (command === failure) { failure = undefined; throw Error('fixture unavailable'); }
      if (command.startsWith('git fetch')) return '';
      if (command === 'git rev-parse HEAD') return state.head;
      if (command.startsWith('git rev-parse origin/')) return state.remote;
      if (command === 'pm2 jlist') {
        if (options.badPm2) return 'not json';
        return JSON.stringify([{ name: 'maelle', pm2_env: { status: state.online ? 'online' : 'errored', GIT_SHA: state.applied } }]);
      }
      if (command.includes('git diff')) return options.lockChanged === false ? 'README.md' : 'package-lock.json';
      if (command.startsWith('git pull')) { state.head = options.advanceDuringPull ? 'c'.repeat(40) : state.remote; return ''; }
      if (command.startsWith('pm2 restart')) {
        state.applied = opts?.env?.GIT_SHA ?? state.head;
        state.version = opts?.env?.APP_VERSION;
        state.online = !options.restartUnconfirmed;
      }
      if (command === 'pm2 save') state.persisted = state.applied;
      return state.head;
    },
  };
  vm.runInNewContext(source + '\nglobalThis.tickForTest = tick;', sandbox);
  return { state, logs, tick: sandbox.tickForTest, count: cmd => state.commands.filter(c => c === cmd).length };
}
for (const stage of ['npm ci --include=dev', 'npm run typecheck', 'npm run build', 'pm2 restart maelle --update-env']) {
  for (const restart of [false, true]) {
    test(`${stage} recovers after ${restart ? 'watcher restart' : 'next tick'}`, () => {
      const f = fixture({ failure: stage });
      assert.equal(f.state.applied, old);
      if (restart) fixture({}, f.state); else f.tick();
      assert.equal(f.state.applied, next);
      assert.equal(f.state.persisted, next);
      assert.equal(f.count(stage), 2);
    });
  }
}
test('successful new revision applies exact SHA/version and saves PM2', () => {
  const f = fixture();
  f.tick();
  assert.equal(f.state.applied, next);
  assert.equal(f.state.version, '4.fixture');
  assert.equal(f.state.persisted, next);
  assert.equal(f.count('pm2 restart maelle --update-env'), 1);
});
test('up-to-date online process skips install/build/restart', () => {
  const f = fixture({}, { head: next, remote: next, applied: next, persisted: next, online: true, commands: [] });
  f.tick();
  assert.equal(f.count('npm run build'), 0);
  assert.equal(f.count('pm2 restart maelle --update-env'), 0);
});
test('unknown identity forces one rebuild even with checkout current', () => {
  const f = fixture({}, { head: next, remote: next, applied: undefined, online: true, commands: [] });
  f.tick();
  assert.equal(f.state.applied, next);
  assert.equal(f.count('npm ci --include=dev'), 1);
  assert.equal(f.count('npm run build'), 1);
});
test('failed PM2 persistence retries without duplicate restart', () => {
  const f = fixture({ failure: 'pm2 save' });
  f.tick();
  assert.equal(f.state.persisted, next);
  assert.equal(f.count('pm2 save'), 2);
  assert.equal(f.count('pm2 restart maelle --update-env'), 1);
});
test('watcher restart retries failed PM2 persistence without duplicate restart', () => {
  const f = fixture({ failure: 'pm2 save' });
  fixture({}, f.state);
  assert.equal(f.state.persisted, next);
  assert.equal(f.count('pm2 restart maelle --update-env'), 1);
});
test('non-online restart remains unconfirmed and never logs deployed', () => {
  const f = fixture({ restartUnconfirmed: true });
  assert.equal(f.state.persisted, old);
  assert.ok(!f.logs.some(l => l.includes('deployed + restarted')));
  fixture({}, f.state);
  assert.equal(f.state.online, true);
  assert.equal(f.state.persisted, next);
});
test('unreadable PM2 state does not alter checkout or deploy', () => {
  const f = fixture({ badPm2: true });
  assert.equal(f.state.head, old);
  assert.equal(f.count('npm run build'), 0);
});
test('fetch outage keeps old process and next tick recovers', () => {
  const f = fixture({ failure: 'git fetch --quiet origin master' });
  assert.equal(f.state.applied, old);
  f.tick();
  assert.equal(f.state.applied, next);
});
test('version-only changes avoid reinstall when applied lockfile unchanged', () => {
  const f = fixture({ lockChanged: false });
  assert.equal(f.count('npm ci --include=dev'), 0);
  assert.equal(f.state.applied, next);
});
test('unreadable dependency diff conservatively reinstalls', () => {
  const f = fixture({ failure: `git diff --name-only ${old} ${next}` });
  assert.equal(f.count('npm ci --include=dev'), 1);
  assert.equal(f.state.applied, next);
});
test('branch advances during pull never stamps mismatched source revision', () => {
  const f = fixture({ advanceDuringPull: true });
  assert.equal(f.count('npm run build'), 0);
  assert.equal(f.state.applied, old);
});
