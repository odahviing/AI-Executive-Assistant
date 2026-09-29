// Pure copy renderer from the actual production module. Transport/DB remain the
// calling harness's explicit doubles; no runtime module or local DB is started.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const file = path.resolve(__dirname, '../../src/core/requests/requesterRelay.ts');
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = { exports: {} };
vm.runInNewContext('(function(require,module,exports){' + code + '\n})')(() => ({}), m, m.exports);
exports.relayNotice = m.exports.relayNotice;
