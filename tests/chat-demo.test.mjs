import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// chat-demo.ts imports ./chat-model without an extension, so bundle it with the esbuild that ships with vite (as onboarding.test.mjs does).
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
const load = async (entry, names) => {
  const bundle = await build({ stdin: { contents: `export { ${names} } from './${entry}';`, resolveDir: 'apps/web/src', loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'neutral' });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
};
const { SCENARIOS, needsApproval, commandRule, demoChatState } = await load('chat-demo', 'SCENARIOS, needsApproval, commandRule, demoChatState');
const { parseUi } = await load('ui-spec', 'parseUi');

const fences = text => [...text.matchAll(/```ui\n([\s\S]*?)\n```/g)].map(match => match[1]);
const texts = scenario => scenario.turns.flatMap(turn => turn.reply.flatMap(part => 'say' in part ? [part.say] : []));

test('every showcase scenario draws valid Interactive UI, and a form turn always follows a form', () => {
  assert.ok(SCENARIOS.length >= 12, 'a varied pool');
  for (const scenario of SCENARIOS) {
    for (const code of texts(scenario).flatMap(fences)) assert.ok(parseUi(code), `${scenario.title}: ${code}`);
    scenario.turns.forEach((turn, index) => {
      if (turn.send) return;
      const before = scenario.turns[index - 1]?.reply.flatMap(part => 'say' in part ? fences(part.say) : []).flatMap(code => parseUi(code) ?? []) ?? [];
      assert.ok(before.some(spec => spec.t === 'form'), `${scenario.title}: turn ${index} answers a form that is not there`);
    });
  }
  assert.ok(SCENARIOS.some(scenario => scenario.turns.some(turn => turn.reply.some(part => 'ask' in part))), 'a question card');
  assert.ok(SCENARIOS.some(scenario => texts(scenario).some(text => text.includes('```ade-ui'))), 'an ade-ui frame');
});

test('the showcase chat asks only what its mode asks: commands that change things, not edits or reads', () => {
  const state = demoChatState();
  assert.deepEqual([state.model, state.effort, state.permissionMode], ['claude-opus-5-5', 'high', 'acceptEdits']);
  const allowed = new Set(), bash = command => ({ tool: 'Bash', input: { command } });
  assert.equal(needsApproval({ tool: 'Edit', input: { file_path: 'a.ts' } }, allowed), false, 'edits go ahead in acceptEdits');
  assert.equal(needsApproval(bash('git log --oneline origin/stage..HEAD'), allowed), false, 'read-only');
  assert.equal(needsApproval(bash('npm run build'), allowed), true);
  assert.equal(commandRule('npm run build -- --watch'), 'npm run build');
  allowed.add(commandRule('npm run build'));
  assert.equal(needsApproval(bash('npm run build'), allowed), false, '"항상 허용" covers the same command');
  assert.equal(needsApproval(bash('npm run deploy'), allowed), true, 'but not another script');
  // The pool does show approval cards.
  assert.ok(SCENARIOS.some(scenario => scenario.turns.some(turn => turn.reply.some(part => needsApproval(part, new Set())))));
});
