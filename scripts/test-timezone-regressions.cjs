// Runs the durable timezone suites against current source under every supported host zone.
const cp = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const suites = [
  {name: 'matchmaker-spine', script: 'scripts/test-timezone-spine.cjs', args: ['--test'], expected: 41},
  {name: 'matchmaker-owner-interval', script: 'scripts/test-timezone-owner-interval.cjs', args: ['--test'], expected: 12},
  {name: 'matchmaker-owner-decisions', script: 'scripts/test-timezone-owner-decisions.cjs', args: ['--test'], expected: 22},
  {name: 'matchmaker-configured-dst', script: 'scripts/test-timezone-configured-dst.cjs', args: ['--test'], expected: 9},
  {name: 'context-authority', script: 'scripts/test-timezone-context-authority.cjs', args: ['--test'], expected: 7},
  {name: 'librarian-people-summary', script: 'scripts/test-timezone-people-summary.cjs', args: ['--test'], expected: 50},
  {name: 'librarian-venue-contacts', script: 'scripts/test-timezone-venue-contacts.cjs', args: ['--test'], expected: 16},
  {name: 'instructor-prompt-people', script: 'scripts/test-timezone-prompt-people.cjs', args: ['--test'], expected: 4},
  {name: 'instructor-slot-narration', script: 'scripts/test-timezone-slot-narration.cjs', args: ['--test'], expected: 4},
  {name: 'registrar', script: 'scripts/test-timezone-registrar-deadline.cjs', args: ['--test'], expected: 33},
  {name: 'registrar-approval-interval', script: 'scripts/test-timezone-approval-interval.cjs', args: ['--test'], expected: 37},
  {name: 'gatekeeper', script: 'scripts/test-timezone-gatekeeper-precheck.cjs', args: [], expected: 42},
  {name: 'gatekeeper-reverify', script: 'scripts/test-timezone-gatekeeper-reverify.cjs', args: ['--test'], expected: 10},
  {name: 'diplomat', script: 'scripts/test-timezone-diplomat-email.cjs', args: ['--test'], expected: 21},
];
const zones = ['UTC', 'Asia/Jerusalem', 'America/Los_Angeles'];
let failed = false;

for (const suite of suites) {
  for (const zone of zones) {
    const run = cp.spawnSync(process.execPath, [...suite.args, suite.script], {
      cwd: root,
      encoding: 'utf8',
      env: {...process.env, TZ: zone},
    });
    const passed = suite.args.includes('--test')
      ? +(run.stdout.match(/^# pass (\d+)/m)?.[1] || 0)
      : +(run.stdout.match(/^(\d+) passed; \d+ failed$/m)?.[1] || 0);
    const failures = suite.args.includes('--test')
      ? +(run.stdout.match(/^# fail (\d+)/m)?.[1] || 0)
      : +(run.stdout.match(/^\d+ passed; (\d+) failed$/m)?.[1] || 0);
    const ok = run.status === 0 && passed === suite.expected && failures === 0;
    console.log(`${ok ? 'ok' : 'not ok'} - ${suite.name} ${zone}: ${passed}/${suite.expected} passed`);
    if (!ok) {
      failed = true;
      process.stdout.write(run.stdout);
      process.stderr.write(run.stderr);
    }
  }
}

if (failed) process.exitCode = 1;
