import test from 'node:test';
import assert from 'node:assert/strict';
import { relativePath, toolInputFields, toolSummary } from '../apps/web/src/chat-model.ts';

test('a file under the chat folder is shown relative to it, on Windows without case or slash differences', () => {
  assert.equal(relativePath('C:\\AI\\repo\\src\\b.ts', 'C:\\AI\\repo'), 'src/b.ts');
  assert.equal(relativePath('c:/ai/REPO/a.txt', 'C:\\AI\\repo\\'), 'a.txt');
  assert.equal(relativePath('/home/u/repo/src/b.ts', '/home/u/repo'), 'src/b.ts');
});

test('anything outside the folder (or a sibling with the same prefix) keeps its full path', () => {
  assert.equal(relativePath('C:\\AI\\repo-other\\a.txt', 'C:\\AI\\repo'), 'C:\\AI\\repo-other\\a.txt');
  assert.equal(relativePath('/home/u/Repo/a.txt', '/home/u/repo'), '/home/u/Repo/a.txt');
  assert.equal(relativePath('/home/u/repo', '/home/u/repo'), '/home/u/repo');
  assert.equal(relativePath('src/b.ts', ''), 'src/b.ts');
});

test('file tools summarise with the relative path; the plan row names the step, not a possibly stale plan', () => {
  assert.equal(toolSummary('Edit', { file_path: 'C:\\AI\\repo\\untracked.md' }, 'C:\\AI\\repo'), 'untracked.md');
  assert.equal(toolSummary('ExitPlanMode', { plan: '# old plan\nold text' }), '계획 승인 요청');
});

test('an opened tool card lists its input as labelled fields with relative paths instead of raw JSON', () => {
  const root = 'C:\\AI\\repo';
  const fields = toolInputFields({ pattern: 'export', path: 'C:\\AI\\repo\\src', output_mode: 'files_with_matches', '-i': true, head_limit: 20 }, root);
  assert.deepEqual(fields.map(f => [f.label, f.value]), [['패턴', 'export'], ['경로', 'src'], ['출력', '파일 목록'], ['대소문자 무시', '예'], ['최대 개수', '20']]);
  assert.equal(toolInputFields({ path: 'C:\\AI\\repo\\' }, root)[0].value, '.');
  assert.equal(toolInputFields({ file_path: 'D:\\x\\a.txt' }, root)[0].value, 'D:\\x\\a.txt');
  assert.deepEqual(toolInputFields({ todos: [{ content: 'a' }, { content: 'b' }], custom_key: 'v' }).map(f => [f.label, f.value]), [['할 일', '2개'], ['custom_key', 'v']]);
  assert.equal(toolInputFields({ prompt: 'line1\nline2' })[0].long, true);
});

test('a plan file outside the project shows from ~/.claude', () => {
  assert.equal(toolSummary('Write', { file_path: 'C:/Users/me/.claude/plans/a.md' }, 'C:/work/repo'), '~/.claude/plans/a.md');
});

test('scheduling and argument-less tools get readable summaries, never "{}"', () => {
  assert.equal(toolSummary('CronCreate', { cron: '57 8 * * *', prompt: '테스트 알림', recurring: true }), '57 8 * * * · 테스트 알림 · 반복');
  assert.equal(toolSummary('CronDelete', { id: 'd3070457' }), 'd3070457');
  assert.equal(toolSummary('CronList', {}), '');
  assert.equal(toolSummary('ListAgents', {}), '');
  assert.equal(toolSummary('Monitor', { command: 'ping -n 3 127.0.0.1', description: 'ping three times' }), 'ping three times');
  assert.equal(toolSummary('NotebookEdit', { notebook_path: 'C:/work/repo/notes/a.ipynb', edit_mode: 'insert' }, 'C:/work/repo'), 'notes/a.ipynb · 셀 추가');
});
