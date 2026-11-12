import test from 'node:test';
import assert from 'node:assert/strict';
import { holdBack, INLINE, parse, stableSplit } from '../apps/web/src/markdown-parse.ts';

test('a single newline inside a paragraph is kept as a line break', () => {
  assert.deepEqual(parse('첫 줄\n둘째 줄\n\n새 문단'), [{ t: 'p', text: '첫 줄\n둘째 줄' }, { t: 'p', text: '새 문단' }]);
  assert.deepEqual(parse('> a\n> b'), [{ t: 'quote', text: 'a\nb' }]);
});

test('streaming text is cut at the last blank line outside a code fence', () => {
  assert.deepEqual(stableSplit('one\n\ntwo'), ['one', 'two']);
  assert.deepEqual(stableSplit('no break yet'), ['', 'no break yet']);
  assert.deepEqual(stableSplit('intro\n\n```js\na\n\nb'), ['intro', '```js\na\n\nb'], 'a blank line inside an open fence is not a cut');
  const [head, tail] = stableSplit('p1\n\n- a\n- b\n\nlast line');
  assert.deepEqual([...parse(head), ...parse(tail)], parse('p1\n\n- a\n- b\n\nlast line'), 'head + tail parse like the whole');
});

test('a line that could still change shape waits until it ends', () => {
  assert.equal(holdBack('done line\n1'), 'done line', 'a bare "1" may become a list item');
  assert.equal(holdBack('done line\n1. item in progress'), 'done line\n1. item in progress', 'a list item already is one');
  assert.equal(holdBack('text\n#'), 'text');
  assert.equal(holdBack('text\n# Title so'), 'text\n# Title so');
  assert.equal(holdBack('text\n```py'), 'text', 'a fence line waits for its language');
  assert.equal(holdBack('| a | b |\n'), '', 'a table head waits for its |---| row');
  assert.equal(holdBack('| a | b |\n|---|---|\n| 1 | 2'), '| a | b |\n|---|---|', 'a half row waits, the table stays');
  assert.equal(holdBack('plain words'), 'plain words');
});

const spans = text => [...text.matchAll(INLINE)].map(match => match[0]);

test('double underscores only make bold at a word edge, so identifiers stay plain', () => {
  assert.deepEqual(spans('mcp__mooner__status'), [], 'a tool name is not bold');
  assert.deepEqual(spans('snake_case_name and a__b__c'), [], 'underscores inside words stay plain');
  assert.deepEqual(spans('a __bold__ word'), ['__bold__']);
  assert.deepEqual(spans('__bold__ at the start, (__bold__) in parentheses'), ['__bold__', '__bold__']);
  assert.deepEqual(spans('_it_ and **strong** and `code`'), ['_it_', '**strong**', '`code`']);
});

test('ordered list items keep the number they were written with', () => {
  const nums = text => parse(text).filter(node => node.t === 'list').flatMap(list => list.items.map(item => item.num));
  assert.deepEqual(nums('5. 내용\n내용이 있음\n\n6. 내용이 있음\n내용'), [5, 6]);
  assert.deepEqual(nums('3. a\n4. b\n\n본문\n\n6. c\n7. d\n\n본문\n\n9. e\n11. f'), [3, 4, 6, 7, 9, 11]);
  assert.deepEqual(nums('- a\n- b'), [undefined, undefined]);
});

test('a code fence is `open` only while its closing fence has not arrived', () => {
  assert.deepEqual(parse('```ade-ui\n<b>x</b>\n```'), [{ t: 'code', lang: 'ade-ui', code: '<b>x</b>' }]);
  assert.deepEqual(parse('```ade-ui\n<b>x'), [{ t: 'code', lang: 'ade-ui', code: '<b>x', open: true }]);
  assert.deepEqual(parse('```ade-ui'), [{ t: 'code', lang: 'ade-ui', code: '', open: true }]);
});

test('a code fence indented under a list item is that item\'s code block, not text glued onto its line', () => {
  const [list] = parse('- Create `a.ts` with:\n  ```ts\n  export const x = 1;\n    nested();\n  ```\n  then run it.\n- next');
  assert.deepEqual(list, { t: 'list', ordered: false, items: [
    { text: 'Create `a.ts` with:', depth: 0, num: undefined, blocks: [{ t: 'code', lang: 'ts', code: 'export const x = 1;\n  nested();' }, { t: 'p', text: 'then run it.' }] },
    { text: 'next', depth: 0, num: undefined },
  ] });
  assert.deepEqual(parse('1. a\n   ```sh\n   ls')[0].items[0].blocks, [{ t: 'code', lang: 'sh', code: 'ls', open: true }], 'still open while streaming');
  assert.deepEqual(parse('1. a\n2. b')[0].items.map(item => 'blocks' in item), [false, false], 'items without code carry no blocks');
});
