// Run: node --test scripts/test-instructor-location-tool-contract.cjs
// Baseline replay: node scripts/test-instructor-location-tool-contract.cjs --source-revision 63221e4
//
// Captures the real create_meeting tool description with isolated imports.
// These assertions prove structural agreement with the resolver contract;
// they do not prove model obedience.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');

const repo = path.resolve(__dirname, '..');
const revisionAt = process.argv.indexOf('--source-revision');
const sourceRevision = revisionAt >= 0 ? process.argv[revisionAt + 1] : null;

function source(rel) {
  if (sourceRevision) return cp.execFileSync('git', ['show', `${sourceRevision}:${rel}`], { cwd: repo, encoding: 'utf8' });
  return fs.readFileSync(path.join(repo, rel), 'utf8');
}

function loadDescription() {
  const rel = 'src/skills/meetings.ts';
  const code = ts.transpileModule(source(rel), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: path.join(repo, rel),
  }).outputText;
  const noop = () => {};
  const deps = {
    '../connectors/graph/calendar': { getOwnerEventsForDecision: noop, updateMeeting: noop },
    './meetings/ops': { SchedulingSkill: class { async executeToolCall() { return null; } } },
    './meetings/calendarOffline': { withCalendarOfflineRefusal: async (_name, _context, run) => run() },
    '../utils/logger': { __esModule: true, default: { info: noop, warn: noop, error: noop } },
    luxon: require('luxon'),
    // This structural fixture never executes availability; reject accidental use.
    '../utils/timezoneConvert': { renderClockInZone: () => { throw Error('Timezone rendering is outside this prompt-capture fixture'); } },
    '../utils/calendarListingFormat': { calendarListingFormatRule: () => '' },
    '../utils/scheduleRules': { checkSlot: noop, occupancyRoleOf: noop },
    '../utils/displaySubject': { displaySubject: noop, subjectViewerFor: noop, viewerEmailFor: noop, PRIVATE_MASK: 'Private appointment' },
  };
  const isolatedRequire = name => {
    assert.ok(Object.hasOwn(deps, name), `unexpected meetings dependency: ${name}`);
    return deps[name];
  };
  const module = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {}, { filename: rel })(isolatedRequire, module, module.exports);
  const profile = {
    user: { name: 'Owner Example', slack_user_id: 'U_OWNER', timezone: 'Asia/Jerusalem' },
    assistant: { name: 'Maelle' },
    categories: [],
    meetings: { allowed_durations: [15, 30, 45, 60], default_meeting_duration: 30 },
  };
  const tool = new module.exports.MeetingsSkill().getTools(profile).find(candidate => candidate.name === 'create_meeting');
  assert.ok(tool, 'real create_meeting tool is present');
  return tool.description;
}

const description = loadDescription();
if (process.argv.includes('--metrics')) console.log(`# prompt-metrics ${JSON.stringify({ descriptionChars: description.length })}`);

// Day/roster defaults are executed in test-location-rules-and-venue.cjs.
// The tool should delegate that decision instead of duplicating its algorithm.
test('unspecified modality and venue defer to the location handler', () => {
  assert.match(description, /handler chooses location and online mode from the configured day and roster/i);
  assert.match(description, /Omit is_online and location unless the conversation specifies them/i);
});
test('location questions follow a real handler result and preserve the human choice', () => {
  assert.match(description, /ask a location question only if the handler returns one/i);
  assert.match(description, /Preserve a previously stated visit, online choice or venue/i);
});
