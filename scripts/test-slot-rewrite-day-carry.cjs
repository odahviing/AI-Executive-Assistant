// Gatekeeper regression — two output-time facts, exercised on the real modules.
//
// A) claimChecker's ungrounded-slot rewrite may not carry a substituted time
//    across days without its date (live incident 2026-09-14T07:39:39Z: the
//    precheck's 2026-09-15 alternatives shipped inside a "today" sentence).
// B) turnHelpers' find_available_slots tool line states WHICH attendee
//    calendars the search actually read, so a later "I had no access to
//    Levana's calendar" (2026-09-14T07:43:08Z) is contradictable from the tape.
//
// Real module behaviour, isolated fixtures: the Anthropic client, the logger
// and the usage log are mocks; no network, no DB. Run the same file against a
// pre-change tree with CLAIMCHECK_BEFORE_ROOT=<dir> to see the A cases fail.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), ts = require('typescript');
const root = path.resolve(__dirname, '..');
const beforeRoot = process.env.CLAIMCHECK_BEFORE_ROOT;
const source = rel => {
  const beforeFile = beforeRoot ? path.join(beforeRoot, rel) : null;
  return fs.readFileSync(beforeFile && fs.existsSync(beforeFile) ? beforeFile : path.join(root, rel), 'utf8');
};
const compile = rel => ts.transpileModule(source(rel), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

const noop = () => {};
const calls = { warns: [], prompts: [] };
const loggerMock = { __esModule: true, default: { info: noop, warn: (...a) => calls.warns.push(a), error: noop, debug: noop } };

let modelReply = null;
const clientMock = {
  getAnthropicClient: () => ({
    messages: {
      create: async params => {
        calls.prompts.push(params.messages[0].content);
        return { content: [{ type: 'tool_use', name: 'verdict', input: modelReply }], usage: {} };
      },
    },
  }),
};

const mocks = {
  'src/llm/client.ts': clientMock,
  'src/llm/models.ts': { SONNET: { model: 'fixture-sonnet' }, MODEL_SONNET: 'fixture-sonnet', MODEL_HAIKU: 'fixture-haiku' },
  'src/utils/logger.ts': loggerMock,
  'src/utils/usageLog.ts': { logLlmUsage: noop },
  'src/utils/detectMessageLanguage.ts': { detectMessageLanguage: () => 'he' },
  // real value, copied from utils/attendeeAvailability.ts:398
  'src/utils/attendeeAvailability.ts': { ATTENDEE_REASON_PREFIXES: ['attendee_busy_collision', 'outside_attendee_work_hours'] },
};
const loaded = new Map();
function load(rel) {
  if (mocks[rel]) return mocks[rel];
  if (loaded.has(rel)) return loaded.get(rel).exports;
  const mod = { exports: {} };
  loaded.set(rel, mod);
  const req = spec => {
    if (!spec.startsWith('.')) return require(spec);
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)) + '.ts';
    return load(resolved);
  };
  vm.runInNewContext('(function(require,module,exports){' + compile(rel) + '\n})',
    { console, Date, Set, Map, JSON, RegExp, Number, String, Promise, setTimeout, clearTimeout },
    { filename: rel })(req, mod, mod.exports);
  return mod.exports;
}

const { rewriteOwningTheMiss } = load('src/utils/claimChecker.ts');
const { summarizeToolCall } = load('src/core/orchestrator/turnHelpers.ts');

// ── The live incident's own inputs ──────────────────────────────────────────
const GROUNDED_TWO_DAYS = [
  '[availability_precheck 2026-09-14T13:30:00.000+03:00 Asia/Jerusalem dur=25m: not bookable (owner_busy_collision)]',
  '[availability_precheck alternatives (bookable, Asia/Jerusalem): 2026-09-15T09:45, 2026-09-15T10:15, 2026-09-15T10:45, 2026-09-15T11:15, 2026-09-15T15:00]',
  '(earlier turn) [find_available_slots 2026-09-14T10:45→2026-09-14T19:00 dur=25m: 0 slots reason=in_the_past]',
];
const GROUNDED_ONE_DAY = [
  '[availability_precheck 2026-09-14T13:30:00.000+03:00 Asia/Jerusalem dur=25m: not bookable (owner_busy_collision)]',
  '[availability_precheck alternatives (bookable, Asia/Jerusalem): 2026-09-14T14:45, 2026-09-14T15:15, 2026-09-14T17:15]',
];
const DRAFT = '13:30 לא עובד היום, יש לו משהו אחר בלוח באותה שעה.\nיש לי היום עוד שלושה חלונות פנויים: 14:45, 15:15 או 17:15. איזה מהם הכי נוח לך?';
const REDACTION = '13:30 לא עובד היום, יש לו משהו אחר בלוח באותה שעה.\nאיזה יום נוח לך?';

const rewrite = (lines, message, extra = {}) => {
  modelReply = {
    verdict: 'rewrite',
    message,
    noUngroundedTimeClaim: true,
    minimalRedaction: REDACTION,
    minimalRedactionPreservesRest: true,
    ...extra,
  };
  return rewriteOwningTheMiss({
    draft: DRAFT,
    actionSummary: '14:45, 15:15, or 17:15 today',
    actionType: 'ungrounded_slot_claim',
    ownerFirstName: 'Idan',
    toolSummaries: lines,
    groundedToolLines: lines,
  });
};

const cases = [];
const test = (id, fn) => cases.push([id, fn]);

// A — the incident itself: next-day times, no date on them, "today" framing.
test('A1 cross-day substitution with no date is discarded for the minimal redaction', async () => {
  const out = await rewrite(GROUNDED_TWO_DAYS,
    '13:30 לא עובד היום. יש לי היום עוד כמה חלונות פנויים: 09:45, 10:15, 10:45, 11:15 או 15:00. איזה מהם הכי נוח לך?');
  assert.equal(out, REDACTION);
  assert.ok(calls.warns.some(w => String(w[0]).includes('carried a substituted time across days')));
});

// A — same substitution, done correctly: the date rides with the times.
test('A2 cross-day substitution that names the date ships unchanged', async () => {
  const good = '13:30 לא עובד היום. מה שיש לי פנוי זה ב-15/09: 09:45, 10:15, 10:45, 11:15 או 15:00. מתאים לך?';
  assert.equal(await rewrite(GROUNDED_TWO_DAYS, good), good);
});

// A — control: one day in play, nothing can be lost, no date demanded.
test('A3 same-day substitution with no date ships unchanged', async () => {
  const good = '13:30 לא עובד היום. יש לי היום 14:45, 15:15 או 17:15. מה מתאים?';
  assert.equal(await rewrite(GROUNDED_ONE_DAY, good), good);
});

// A — control: a time the draft already had is not a substitution.
test('A4 a time carried over from the draft is never treated as substituted', async () => {
  const good = 'היום 17:15 עדיין פתוח, נסגור על זה?';
  assert.equal(await rewrite(GROUNDED_TWO_DAYS, good), good);
});

// A — control: the ISO form counts as naming the date.
test('A5 an ISO date in the rewrite satisfies the day-carry rule', async () => {
  const good = 'הזמנים שמאושרים הם ב-2026-09-15: 09:45 ו-10:15.';
  assert.equal(await rewrite(GROUNDED_TWO_DAYS, good), good);
});

// A — the prompt clause appears only when the tape really spans two days.
test('A6 the day-carry clause is in the prompt only on a multi-day tape', async () => {
  calls.prompts.length = 0;
  await rewrite(GROUNDED_TWO_DAYS, 'ב-15/09 יש 09:45.');
  assert.match(calls.prompts[0], /NOT all on the same day/);
  calls.prompts.length = 0;
  await rewrite(GROUNDED_ONE_DAY, 'היום 14:45.');
  assert.doesNotMatch(calls.prompts[0], /NOT all on the same day/);
});

// ── bouncer overturn 2026-09-14: the audit must key on the draft's OWN day,
//    not on "the tape has two dates" — a multi-date tape is the norm once
//    prior turns' searches are folded in.
const GROUNDED_TODAY_AMONG_MANY = [
  '[availability_precheck 2026-09-14T13:30:00.000+03:00 Asia/Jerusalem dur=25m: not bookable (owner_busy_collision)]',
  '[availability_precheck alternatives (bookable, Asia/Jerusalem): 2026-09-14T16:30, 2026-09-15T09:45, 2026-09-15T10:15]',
  '(earlier turn) [find_available_slots 2026-09-20T09:00→2026-10-01T19:00 dur=25m → 1 slots: 2026-10-01 11:00-11:25 Asia/Jerusalem]',
];

test('A9 same-day substitution on a multi-day tape ships unchanged', async () => {
  // 13:30 is in the draft and only the 2026-09-14 line offers it, so the
  // draft's day is 09-14; 16:30 comes off that same day and needs no date.
  const good = '13:30 לא עובד היום, יש לו משהו אחר. יש 16:30 פנוי, מתאים?';
  assert.equal(await rewrite(GROUNDED_TODAY_AMONG_MANY, good), good);
});

test('A10 a month-name date satisfies the day-carry rule', async () => {
  const good = "13:30 doesn't work today. The next confirmed window is Tuesday 15 Sep 09:45 — want it?";
  assert.equal(await rewrite(GROUNDED_TODAY_AMONG_MANY, good), good);
});

test('A11 cross-day substitution still discarded on that same multi-day tape', async () => {
  const bad = '13:30 לא עובד היום. יש לי היום 09:45 ו-10:15, מה עדיף?';
  assert.equal(await rewrite(GROUNDED_TODAY_AMONG_MANY, bad), REDACTION);
});

// bouncer discovery (owner-approved): no anchor is the incident minus its
// 13:30 line, so the date is demanded of every substituted time instead.
const noAnchor = (lines, message) => {
  modelReply = { verdict: 'rewrite', message, noUngroundedTimeClaim: true, minimalRedaction: REDACTION, minimalRedactionPreservesRest: true };
  return rewriteOwningTheMiss({
    draft: 'יש לי היום 08:05 או 19:55, מה מתאים?',
    actionType: 'ungrounded_slot_claim', ownerFirstName: 'Idan',
    toolSummaries: lines, groundedToolLines: lines,
  });
};

test('A12 no anchor day on a multi-day tape demands the date', async () => {
  assert.equal(await noAnchor(GROUNDED_TWO_DAYS, 'יש 09:45 פנוי.'), REDACTION);
});

test('A14 no anchor day, date named, ships unchanged', async () => {
  const good = 'ב-15/09 יש 09:45 פנוי.';
  assert.equal(await noAnchor(GROUNDED_TWO_DAYS, good), good);
});

test('A15 no anchor day on a single-date tape still ships unchanged', async () => {
  const good = 'יש 14:45 פנוי.';
  assert.equal(await noAnchor(GROUNDED_ONE_DAY, good), good);
});

test('A13 the prompt clause states the same rule the code enforces', async () => {
  calls.prompts.length = 0;
  await rewrite(GROUNDED_TODAY_AMONG_MANY, 'ב-15/09 יש 09:45.');
  assert.match(calls.prompts[0], /SAME day the draft is already speaking about needs nothing extra/);
});

// A — a find_available_slots line renders its instants with a space, not a `T`;
//     a day must be carried off those lines too.
test('A8 a search line in the slot-list render is read for its date as well', async () => {
  const lines = [
    '[find_available_slots 2026-09-14T10:45→2026-09-16T19:00 dur=25m → 2 slots: 2026-09-14 17:15-17:40 Asia/Jerusalem, 2026-09-16 09:30-09:55 Asia/Jerusalem]',
  ];
  const out = await rewrite(lines, 'יש לי 09:30 פנוי, מתאים?');
  assert.equal(out, REDACTION);
});

// A — the pre-existing keep-veto still wins before any of this runs.
test('A7 verdict=keep still keeps the original draft', async () => {
  modelReply = { verdict: 'keep' };
  const out = await rewriteOwningTheMiss({
    draft: DRAFT, actionType: 'ungrounded_slot_claim', ownerFirstName: 'Idan',
    toolSummaries: GROUNDED_TWO_DAYS, groundedToolLines: GROUNDED_TWO_DAYS,
  });
  assert.equal(out, null);
});

// A — the rewriter itself unavailable: fail open, caller keeps the draft.
test('A16 an unavailable rewriter leaves the draft to the caller', async () => {
  const failing = { messages: { create: async () => { throw new Error('fixture model unavailable'); } } };
  const saved = clientMock.getAnthropicClient;
  clientMock.getAnthropicClient = () => failing;
  try {
    // the module captured its client at load time; call through a fresh load
    const fresh = new Map(loaded);
    loaded.clear();
    const mod = load('src/utils/claimChecker.ts');
    loaded.clear();
    for (const [k, v] of fresh) loaded.set(k, v);
    const out = await mod.rewriteOwningTheMiss({
      draft: DRAFT, actionType: 'ungrounded_slot_claim', ownerFirstName: 'Idan',
      toolSummaries: GROUNDED_TWO_DAYS, groundedToolLines: GROUNDED_TWO_DAYS,
    });
    assert.equal(out, null);
  } finally {
    clientMock.getAnthropicClient = saved;
  }
});

// B — the tool line names the calendars the search really read.
const slotsResult = {
  slots: [{
    start: '2026-09-14T17:15:00+03:00', end: '2026-09-14T17:40:00+03:00',
    attendee_status: [
      { email: 'daniel.s@reflectiz.com', kind: 'internal', status: 'free' },
      { email: 'levana.b@reflectiz.com', kind: 'internal', status: 'free' },
      { email: 'outside@partner.com', kind: 'external', status: 'unknown' },
    ],
  }],
};
const slotsInput = { duration_minutes: 25, search_from: '2026-09-14T10:45:00', search_to: '2026-09-14T19:00:00' };

test('B1 a real per-attendee calendar read is named on the line', () => {
  const line = summarizeToolCall('find_available_slots', slotsInput, slotsResult, 'Asia/Jerusalem');
  assert.match(line, /calendars_read=daniel\.s@reflectiz\.com\+levana\.b@reflectiz\.com/);
  assert.doesNotMatch(line, /outside@partner\.com/);
});

test('B2 an unread calendar is never claimed as read', () => {
  const unknownOnly = { slots: [{ ...slotsResult.slots[0], attendee_status: [{ email: 'outside@partner.com', kind: 'external', status: 'unknown' }] }] };
  const line = summarizeToolCall('find_available_slots', slotsInput, unknownOnly, 'Asia/Jerusalem');
  assert.doesNotMatch(line, /calendars_read=/);
});

test('B3 a search with no attendee annotation renders exactly as before', () => {
  const bare = { slots: [{ start: '2026-09-14T17:15:00+03:00', end: '2026-09-14T17:40:00+03:00' }] };
  const line = summarizeToolCall('find_available_slots', slotsInput, bare, 'Asia/Jerusalem');
  assert.doesNotMatch(line, /calendars_read=/);
  assert.match(line, /^\[find_available_slots .*1 slots: /);
});

(async () => {
  let failed = 0;
  for (const [id, fn] of cases) {
    try {
      await fn();
      console.log('PASS ' + id);
    } catch (err) {
      failed++;
      console.log('FAIL ' + id + ' — ' + err.message);
    }
  }
  // Summary shape the release runner parses (scripts/workshop-release.cjs's
  // testResult): `^(\d+) passed` and `^\d+ passed; (\d+) failed`.
  console.log(`${cases.length - failed} passed; ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
