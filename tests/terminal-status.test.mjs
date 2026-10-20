import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalStatus } from '../apps/local-server/src/terminal-status.js';

const osc = body => `\x1b]7501;${body}\x1b\\`;

test('OSC 7501 negotiates support, accepts split reports and never treats ordinary output as work', () => {
  const replies = [], status = createTerminalStatus(data => replies.push(data));
  const query = osc('?');
  for (const char of query) status.feed(char);
  assert.deepEqual(replies, [query]);
  status.feed(query, true);
  assert.equal(replies.length, 1); // Replayed queries must not be typed into the current prompt.
  status.feed('Working…\n• Thinking (esc to interrupt)\n❯ \x1b]9;4;3;\x07');
  assert.equal(status.status, null);
  for (const app of ['claude-code', 'codex']) {
    for (const char of osc(`state=working:app=${app}`)) status.feed(char);
    assert.deepEqual(status.status, { agent: app === 'codex' ? 'codex' : 'claude', state: 'working' });
    status.feed('❯ \n? for shortcuts'.repeat(20000));
    status.feed('');
    assert.equal(status.status.state, 'working');
    for (const state of ['blocked', 'working', 'done', 'error', 'idle']) {
      status.feed(`\x1b]7501;state=${state}:app=${app}\x07`);
      assert.equal(status.status.state, state);
    }
    status.feed(osc('state=clear'));
    assert.equal(status.status, null);
  }
});

test('status ignores malformed reports and does not infer state from titles or unknown apps', () => {
  const status = createTerminalStatus(() => {});
  status.feed(osc('state=working:app=codex'));
  for (const body of ['state=unknown:app=codex', 'app=codex', 'state=done:id=/bad:app=codex', 'state=done:id=:msg=AA==', 'state=done:msg=A', 'state=done:msg=YQ=', 'state=done:title=' + 'YQ=='.repeat(100), 'state=done:msg=' + 'x'.repeat(5000)]) {
    status.feed(osc(body));
    assert.equal(status.status.state, 'working', body.slice(0, 100));
  }
  status.feed(osc('state=idle:state=blocked:app=codex:kind=question:future=value'));
  assert.equal(status.status.state, 'blocked');
  status.feed(osc('state=working:app=other'));
  assert.equal(status.status, null);
});

test('child reports inherit the agent, clear by subtree, and shell prompts drop live work', () => {
  const status = createTerminalStatus(() => {});
  status.feed(osc('state=idle:app=claude-code'));
  status.feed(osc('state=working:id=worker'));
  assert.deepEqual(status.status, { state: 'working', agent: 'claude' });
  status.feed(osc('state=blocked:id=worker/tool'));
  assert.equal(status.status.state, 'blocked');
  status.feed(osc('state=clear:id=worker'));
  assert.equal(status.status.state, 'idle');
  status.feed(osc('state=working:app=codex'));
  status.feed('\x1b]133;A\x07');
  assert.equal(status.status, null);
  status.feed(osc('state=done:app=codex'));
  status.feed('\x1b]133;A\x07');
  assert.equal(status.status.state, 'done');
  status.feed('\x1bc');
  assert.equal(status.status, null);
});
