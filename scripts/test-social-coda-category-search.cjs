// Coda grounding search: a category label is a filing key, not always a usable search phrase.
// Replays the Simon Arazi 2026-09-20 raise: category "exercise" searched as the bare word
// returned a military-exercise article. Executes the real generateCoda module with a closed
// dependency allowlist — no DB, network, model or writes.
// Before-repair replay: SOCIAL_CODA_SOURCE_FIXTURE=<preserved generateCoda.ts> node scripts/test-social-coda-category-search.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const sourcePath = process.env.SOCIAL_CODA_SOURCE_FIXTURE || path.resolve(__dirname, '../src/core/social/generateCoda.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  fileName: sourcePath,
}).outputText;
const profile = { user: { name: 'Owner Test', slack_user_id: 'U_OWNER' }, assistant: { name: 'Maelle' } };

function harness() {
  const unexpected = [];
  const searches = [];
  const tried = [];
  const composerPrompts = [];
  const forbidden = label => () => { unexpected.push(label); throw new Error(`Forbidden side effect: ${label}`); };
  const dependencies = {
    '../../llm/client': { getAnthropicClient: () => ({ messages: { create: async args => {
      composerPrompts.push(args.messages[0].content);
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', input: { sentence: 'A grounded line.' } }] };
    } } }) },
    '../../llm/models': { SONNET: { model: 'isolated-composer' } },
    '../../utils/usageLog': { logLlmUsage: () => {} },
    '../../utils/logger': { info: () => {}, warn: () => {} },
    '../../skills/general': { tavilySearch: async (...args) => {
      searches.push(args);
      return { results: [{ title: 'Fixture', url: 'https://news.example/a', content: 'Fixture excerpt.' }] };
    } },
    '../../db': {
      getPersonMemory: () => ({ name: 'Recipient Test', timezone: 'Asia/Jerusalem' }),
      getRecentChannelMessages: () => [],
    },
    '../../db/socialSubjects': {
      getCategoryByLabel: label => ({ id: `cat_global_${label}` }),
      getActiveSubjectsForPersonCategory: () => [],
      recordCategoryRaiseTried: args => tried.push(args),
      recordSubjectUnanswered: forbidden('recordSubjectUnanswered'),
    },
    '../../utils/claimChecker': { checkReplyClaims: async () => ({}) },
  };
  const sandbox = { exports: {}, require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : forbidden(`require(${name})`)() };
  vm.runInNewContext(compiled, sandbox, { filename: sourcePath });
  return {
    compose: directive => sandbox.exports.composeSocialCoda({
      directive, personSlackId: 'U_RECIPIENT', channelId: 'D_RECIPIENT',
      senderRole: 'colleague', senderFirstName: 'Recipient', language: 'en',
    }, profile),
    searches, tried, composerPrompts, unexpected,
  };
}

const raiseNew = categoryLabel => ({ mode: 'raise_new', categoryLabel, subjectLabel: null, subjectId: null, subject: null, toneCue: '', closingAck: false });

const cases = [
  ['SCS-R01 regression: raise_new "exercise" searches as fitness, not the bare word', async () => {
    const h = harness();
    const out = await h.compose(raiseNew('exercise'));
    return out && h.unexpected.length === 0
      && h.searches.length === 1
      && h.searches[0][0] === "fitness and exercise — what's new or trending right now, Israel";
  }],
  ['SCS-R02 regression: the raise is still recorded under the stored "exercise" category and the composer still names it', async () => {
    const h = harness();
    await h.compose(raiseNew('exercise'));
    return h.unexpected.length === 0
      && h.tried.length === 1 && h.tried[0].categoryId === 'cat_global_exercise'
      && h.composerPrompts.length === 1 && h.composerPrompts[0].includes('Bring up "exercise"')
      && h.searches[0][0].startsWith('fitness and exercise');
  }],
  ['SCS-P01 preserved: an unambiguous category searches with its own label', async () => {
    const h = harness();
    await h.compose(raiseNew('music'));
    return h.unexpected.length === 0
      && h.searches[0][0] === "music — what's new or trending right now, Israel"
      && h.tried[0].categoryId === 'cat_global_music';
  }],
  ['SCS-P02 preserved: continue searches the subject label, not the category', async () => {
    const h = harness();
    await h.compose({ mode: 'continue', categoryLabel: 'exercise', subjectLabel: 'half marathon training', subjectId: 's1',
      subject: { id: 's1', category_id: 'cat_global_exercise', created_by: 'colleague' }, toneCue: '', closingAck: false });
    return h.unexpected.length === 0
      && h.searches[0][0] === "half marathon training — what's new or trending right now, Israel"
      && h.tried.length === 0;
  }],
];

(async () => {
  let passed = 0; let failed = 0;
  for (const [name, run] of cases) {
    try {
      if (await run()) { passed++; console.log(`ok - ${name}`); }
      else { failed++; console.log(`not ok - ${name}`); }
    } catch (err) {
      failed++; console.log(`not ok - ${name} (${String(err).slice(0, 200)})`);
    }
  }
  console.log(`${passed} passed; ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
