// Run: node --test scripts/test-instructor-image-booking-grounding.cjs
// Baseline replay: node scripts/test-instructor-image-booking-grounding.cjs --source-revision 63221e4
//
// Captures the real create_meeting tool contract with a closed dependency
// allowlist. Prompt assertions establish what is presented to the model; they
// do not establish that a model will follow the instruction.
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

function loadCreateMeetingTool() {
  const rel = 'src/skills/meetings.ts';
  const code = ts.transpileModule(source(rel), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: path.join(repo, rel),
  }).outputText;
  const module = { exports: {} };
  const noop = () => {};
  const deps = {
    '../connectors/graph/calendar': { getOwnerEventsForDecision: noop, updateMeeting: noop },
    './meetings/ops': { SchedulingSkill: class { async executeToolCall() { return null; } } },
    './meetings/calendarOffline': { withCalendarOfflineRefusal: async (_name, _context, run) => run() },
    '../utils/logger': { __esModule: true, default: { info: noop, warn: noop, error: noop } },
    luxon: require('luxon'),
    '../utils/calendarListingFormat': { calendarListingFormatRule: () => '' },
    '../utils/scheduleRules': { checkSlot: noop, occupancyRoleOf: noop },
    '../utils/displaySubject': {
      displaySubject: noop,
      subjectViewerFor: noop,
      viewerEmailFor: noop,
      PRIVATE_MASK: 'Private appointment',
    },
  };
  const isolatedRequire = name => {
    assert.ok(Object.hasOwn(deps, name), `unexpected meetings dependency: ${name}`);
    return deps[name];
  };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {}, { filename: rel })(isolatedRequire, module, module.exports);
  const profile = {
    user: { name: 'Idan Cohen', slack_user_id: 'U_OWNER', timezone: 'Asia/Jerusalem' },
    assistant: { name: 'Maelle' },
    categories: [],
    meetings: { allowed_durations: [15, 30, 45, 60], default_meeting_duration: 30 },
  };
  const tool = new module.exports.MeetingsSkill().getTools(profile).find(candidate => candidate.name === 'create_meeting');
  assert.ok(tool, 'real create_meeting tool is present');
  return tool;
}

const tool = loadCreateMeetingTool();
const description = tool.description;
const subjectDescription = tool.input_schema.properties.subject.description;
if (process.argv.includes('--metrics')) {
  console.log(`# prompt-metrics ${JSON.stringify({
    createMeetingToolChars: JSON.stringify(tool).length,
    descriptionChars: description.length,
    subjectDescriptionChars: subjectDescription.length,
  })}`);
}

test('attached-image title and roster facts are first-class subject sources', () => {
  assert.match(description, /current request, attached image, and current thread/i);
  assert.match(subjectDescription, /current request, attached image, and current thread/i);
});

test('explicit purpose and actual participants ground the subject', () => {
  assert.match(description, /explicit title or purpose/i);
  assert.match(description, /name exactly the participants included/i);
  assert.match(subjectDescription, /explicit title or purpose/i);
  assert.match(subjectDescription, /actual participants/i);
});

test('a stated exclusion constrains both attendee set and title', () => {
  assert.match(description, /excludes someone or a group/i);
  assert.match(description, /exclusion applies to both the attendee set and the subject/i);
});

test('ordinary text keeps its named title authoritative', () => {
  assert.match(description, /ordinary text and images follow the same rule/i);
  assert.match(description, /Positioning with Einav/);
});

test('legitimate multi-person requests retain every named participant', () => {
  assert.match(description, /multi-person meeting names every participant explicitly included/i);
  assert.match(description, /Strategy with Anna and Ben/);
  const attendees = tool.input_schema.properties.attendees;
  assert.equal(attendees.type, 'array');
  assert.deepEqual(Array.from(attendees.items.required), ['name']);
  assert.equal(attendees.maxItems, undefined);
});

test('message and calendar actions remain separate completion obligations', () => {
  assert.match(description, /message_colleague completes only the message/i);
  assert.match(description, /create_meeting completes the calendar action/i);
  assert.match(description, /unavailable, fails, or has an unknown result/i);
  assert.match(description, /calendar part remains incomplete/i);
});

test('external missing-subject flow still asks before booking', () => {
  assert.match(description, /with an EXTERNAL on the invite, ASK for a real subject BEFORE create_meeting/i);
  assert.match(description, /batched with other missing fields; a later rename sends a second notification/i);
});

test('colleague missing-subject flow still asks instead of inventing', () => {
  assert.match(description, /On the COLLEAGUE path/);
  assert.match(description, /instead of inventing a placeholder/i);
});

test('shared invite fields remain English-only', () => {
  assert.match(subjectDescription, /ENGLISH ONLY/);
  assert.match(description, /keep subject \+ body in English/i);
});
