import test from 'node:test';
import assert from 'node:assert/strict';
import { planFile, planVerdict, toolSummary, webSearchResult } from '../apps/web/src/chat-model.ts';

const raw = 'Web search results for query: "claude code changelog"\n\n'
  + 'Links: [{"title":"> ## Documentation Index","url":"https://code.claude.com/docs/en/changelog"},{"title":"a [bracket] title","url":"https://www.example.com/x"},{"title":"dup","url":"https://code.claude.com/docs/en/changelog"},{"title":"bad","url":"javascript:alert(1)"}]\n\n'
  + 'The official changelog is at code.claude.com.';

test('a WebSearch result splits into deduplicated http(s) links with their site, and the notes after them', () => {
  const parsed = webSearchResult(raw);
  assert.deepEqual(parsed.links, [
    { title: 'Documentation Index', url: 'https://code.claude.com/docs/en/changelog', host: 'code.claude.com' },
    { title: 'a [bracket] title', url: 'https://www.example.com/x', host: 'example.com' },
  ]);
  assert.equal(parsed.notes, 'The official changelog is at code.claude.com.');
});

test('text that is not a links result is left to the plain view', () => {
  assert.equal(webSearchResult('No results'), null);
  assert.equal(webSearchResult('Links: [not json]'), null);
});

test('ToolSearch names what it loads', () => {
  assert.equal(toolSummary('ToolSearch', { query: 'select:WebSearch,WebFetch' }), 'WebSearch, WebFetch 불러오기');
  assert.equal(toolSummary('ToolSearch', { query: 'notebook jupyter' }), 'notebook jupyter');
});

test('a decided plan keeps only the decision and the user\'s words, and its file shows from ~/.claude', () => {
  assert.deepEqual(planVerdict('User has approved your plan. …\n## Approved Plan:\n# Plan', false), { approved: true });
  assert.deepEqual(planVerdict('The user rejected this plan and asks for changes. …\n\nUser feedback:\n테스트도 추가해 줘\n', true), { approved: false, feedback: '테스트도 추가해 줘' });
  assert.deepEqual(planVerdict('The user doesn\'t want to proceed with this tool use.', true), { approved: false });
  assert.equal(planFile('C:\\Users\\me\\.claude\\plans\\foamy-lemon.md'), '~/.claude/plans/foamy-lemon.md');
  assert.equal(planFile('/home/me/.claude/plans/a.md'), '~/.claude/plans/a.md');
  assert.equal(planFile('/work/plans/a.md'), '/work/plans/a.md', 'a plan outside ~/.claude keeps its path');
});
