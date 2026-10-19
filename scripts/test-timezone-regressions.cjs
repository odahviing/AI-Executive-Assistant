// Runs the durable timezone suites against current source under every supported host zone.
const path = require('node:path');
const { inventory, plan, execute, testResult } = require('./workshop-release.cjs');
const root = path.resolve(__dirname, '..');

(async () => {
  const entries = plan(inventory(root).filter(file => file.startsWith('test-timezone-')));
  if (!entries.length) process.exitCode = 1;
  for (const { file, zone } of entries) {
    const run = await execute([file], { root, env: { TZ: zone } });
    const { ok, passed } = testResult(run);
    console.log(`${ok ? 'ok' : 'not ok'} - ${file} ${zone}: ${passed} passed`);
    if (!ok) {
      process.exitCode = 1;
      process.stdout.write(run.stdout);
      process.stderr.write(run.stderr);
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
