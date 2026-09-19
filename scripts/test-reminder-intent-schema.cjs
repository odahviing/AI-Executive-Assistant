// Structural input coverage only: executing getTools cannot prove model interpretation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const file = process.env.REMINDER_SCHEMA_SOURCE || path.join(__dirname, '../src/tasks/skill.ts');
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const klass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'TasksSkill');
const method = klass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'getTools');
// Isolate the real method from runtime imports. Approval enum is an unrelated dependency.
const code = ts.transpileModule(`const APPROVAL_SUBKINDS = []; class Captured { ${method.getText(ast)} } result = new Captured().getTools({ user: { name: 'Test Owner' } });`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const context = { result: null };
vm.runInNewContext(code, context);
const tools = JSON.parse(JSON.stringify(context.result));
const tool = name => tools.find(item => item.name === name);

for (const name of ['create_task', 'update_task']) {
  test(`${name} captures typed reminder intent and explicit/vague scheduling guidance`, () => {
    const field = tool(name).input_schema.properties.explicit_time;
    assert.equal(field?.type, 'boolean');
    assert.match(field.description, /Required.*reminder/);
    assert.match(field.description, /true.*clock time or relative duration.*honor that instant/);
    assert.match(field.description, /false.*vague day\/date.*tomorrow.*recipient work hours/);
    assert.match(field.description, /Omit for other task types/);
  });
  test(`${name} preserves other task types and their existing required fields`, () => {
    const schema = tool(name).input_schema;
    assert.deepEqual(schema.properties.type.enum, ['reminder', 'follow_up', 'research']);
    assert.deepEqual(schema.required, name === 'create_task' ? ['type', 'title', 'due_at'] : ['action', 'task_id']);
    assert.equal(schema.properties.due_at.type, 'string');
  });
}
test('update_task captures paired due_at edits and preservation on unrelated edits', () => {
  const text = tool('update_task').input_schema.properties.explicit_time?.description || '';
  assert.match(text, /Required when editing a reminder due_at/);
  assert.match(text, /Supply together with due_at; other edits retain the existing intent/);
});
test('unrelated task tools retain their existing identities', () => {
  assert.ok(tool('get_my_tasks'));
  assert.ok(tool('create_approval'));
  assert.ok(tool('resolve_approval'));
  assert.deepEqual(tool('update_task').input_schema.properties.action.enum, ['edit', 'cancel']);
});
