const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'scripts/check-stale-citations.cjs'), 'utf8');
const base = ['function processThing() {', ...Array(38).fill('  // body'), '  return 42;', '}', ...Array(39).fill('// padding')];
const cases = [
  { name: 'valid body anchor', citation: 40, expected: 1 },
  { name: 'valid declaration anchor', citation: 1, expected: 0 },
  { name: 'genuine drift outside function', citation: 75, expected: 1 },
  { name: 'genuine drift within same function', citation: 35, expected: 1 },
  { name: 'valid explicit use site', citation: 60, expected: 0, use: true },
  { name: 'past EOF', citation: 100, expected: 1 },
];
console.log('checker sha256 ' + crypto.createHash('sha256').update(source).digest('hex'));
for (const c of cases) {
  const target = [...base];
  if (c.use) target[59] = 'processThing();';
  const files = { 'fixture.ts': target.join('\n'), 'source.md': '`processThing` returns the answer at fixture.ts:' + c.citation };
  const output = [];
  let exit;
  try {
    vm.runInNewContext(source, {
      __dirname: path.join(root, 'scripts'),
      require(name) {
        if (name === 'path') return path;
        if (name === 'fs') return { existsSync: () => true, readFileSync: p => files[path.basename(p)] };
        if (name === 'child_process') return { execFileSync: (_cmd, args) => args.includes('--others') ? '' : 'fixture.ts\nsource.md\n' };
        throw Error(name);
      },
      process: { argv: ['node', 'checker', '--all'], env: {}, exit(code) { exit = code; throw new Error('exit'); } },
      console: { log: s => output.push(s), error: s => output.push(s) },
    });
  } catch (e) { if (e.message !== 'exit') throw e; }
  console.log(JSON.stringify({ case: c.name, exit, expected: c.expected, output: output.join('\n') }));
  if (exit !== c.expected) process.exitCode = 1;
}
