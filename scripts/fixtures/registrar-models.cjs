// Execute the real central policy; no SDK client or network is loaded.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../../src/llm/models.ts'), 'utf8');
const moduleFixture = { exports: {} };
vm.runInNewContext('(function(module,exports){' + ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText + '\n})')(moduleFixture, moduleFixture.exports);
module.exports = moduleFixture.exports;
