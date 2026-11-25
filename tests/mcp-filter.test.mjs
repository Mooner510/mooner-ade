import test from 'node:test';
import assert from 'node:assert/strict';
import { hiddenToolNames, rewriteClientMessage, rewriteServerMessage } from '../apps/local-server/src/mcp-filter.js';

test('a filter hides turned-off tools and refuses their calls', () => {
  const hidden = hiddenToolNames('rm\nwrite');
  const pending = new Set();
  const list = rewriteClientMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, hidden);
  assert.equal(list.listId, 1);
  pending.add(list.listId);
  const answer = rewriteServerMessage({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'rm' }, { name: 'read' }] } }, hidden, pending);
  assert.deepEqual(answer.result.tools, [{ name: 'read' }]);
  assert.equal(pending.size, 0);
  const call = rewriteClientMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'rm' } }, hidden);
  assert.equal(call.forward, null);
  assert.equal(call.reply.result.isError, true);
  assert.match(call.reply.result.content[0].text, /꺼져/);
  const kept = rewriteClientMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read' } }, hidden);
  assert.equal(kept.forward.method, 'tools/call');
  assert.equal(kept.reply, null);
});
