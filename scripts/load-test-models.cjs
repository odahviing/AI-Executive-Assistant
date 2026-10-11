// Test fixtures consume the actual central policy without loading the app/client.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const file = path.resolve(__dirname, '../src/llm/models.ts');
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
vm.runInNewContext('(function(exports,module){' + code + '\n})', {}, { filename: file })(loaded.exports, loaded);
module.exports = loaded.exports;
