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

test('owner and one external on an office day defaults online regardless of timezone', () => {
  assert.match(description, /regardless of the external's timezone:[^\n]+owner plus one external[^\n]+online/i);
  assert.doesNotMatch(description, /External \+ office \+ different TZ[^\n]+online/);
});

test('owner office-day roster of three or more asks once regardless of timezone', () => {
  assert.match(description, /regardless of the external's timezone:[^\n]+three or more total participants[^\n]+asks/i);
  assert.match(description, /create, move, or an update_meeting attendee change/i);
});

test('colleague-path external office-day booking defaults online without owner approval', () => {
  assert.match(description, /colleague path[^\n]+external office-day[^\n]+online without owner approval/i);
});

test('explicit online and physical choices still override defaults', () => {
  assert.match(description, /Pass `is_online: true` ONLY when the conversation explicitly said online/i);
  assert.match(description, /Pass `is_online: false` ONLY when the conversation explicitly said in-person/i);
});

test('an explicit venue remains an in-person signal', () => {
  assert.match(description, /Specific venue mentioned[^\n]+pass `location` as the venue/i);
  assert.match(description, /Helper will mark in-person/i);
});

test('external home-day booking remains online', () => {
  assert.match(description, /External \+ home[^\n]+online with Teams/i);
});

test('internal home and office defaults remain delegated to the handler', () => {
  assert.match(description, /home day \+ internal-only[^\n]+Huddle/i);
  assert.match(description, /office day \+ internal-only[^\n]+Office/i);
  assert.match(description, /THE HANDLER DECIDES/i);
});
