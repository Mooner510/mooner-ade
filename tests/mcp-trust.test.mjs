import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeMcp, cursorMcp, isTrusted, validMcpTrust } from '../apps/local-server/src/mcp-trust.js';

test('an MCP tool is told from the name the agent uses: Claude mcp__server__tool, Cursor "server: tool" (never a shell, file or fetch request)', () => {
  assert.deepEqual(claudeMcp('mcp__mooner_server__server_exec'), { server: 'mooner_server', tool: 'server_exec' });
  assert.deepEqual(claudeMcp('mcp__a__b__c'), { server: 'a', tool: 'b__c' });
  assert.equal(claudeMcp('Bash'), null); assert.equal(claudeMcp('mcp__only'), null); assert.equal(claudeMcp(undefined), null);
  assert.deepEqual(cursorMcp({ title: 'agent_bus: send_message', kind: 'other' }), { server: 'agent_bus', tool: 'send_message' });
  assert.deepEqual(cursorMcp({ title: 'agent_bus: send_message' }), { server: 'agent_bus', tool: 'send_message' });
  assert.equal(cursorMcp({ title: 'rm -rf agent_bus', kind: 'execute' }), null);
  assert.equal(cursorMcp({ title: 'git: status', kind: 'execute' }), null, 'a shell kind never counts');
  assert.equal(cursorMcp({ title: 'Bash' }), null); assert.equal(cursorMcp(undefined), null);
});

test('a trusted tool matches itself, a trusted server matches all its tools, nothing else', () => {
  const tool = { server: 'srv', tool: 'run' };
  assert.equal(isTrusted([{ server: 'srv', tool: 'run' }], tool), true);
  assert.equal(isTrusted([{ server: 'srv' }], tool), true);
  assert.equal(isTrusted([{ server: 'srv', tool: 'other' }, { server: 'other' }], tool), false);
  assert.equal(isTrusted([], tool), false); assert.equal(isTrusted(undefined, tool), false); assert.equal(isTrusted([{ server: 'srv' }], null), false);
});

test('the settings value is three provider lists of { server, tool? } and nothing else', () => {
  assert.equal(validMcpTrust({ claude: [{ server: 'a' }, { server: 'a', tool: 'b' }], codex: [], cursor: [{ server: 'c' }] }), true);
  assert.equal(validMcpTrust({}), true);
  for (const bad of [null, [], { gemini: [] }, { claude: {} }, { claude: [{}] }, { claude: [{ server: '' }] }, { claude: [{ server: 'a', tool: 3 }] }, { claude: [{ server: 'a', extra: 1 }] }, { claude: [{ server: 'a\nb' }] }, { claude: Array.from({ length: 201 }, () => ({ server: 'a' })) }])
    assert.equal(validMcpTrust(bad), false, JSON.stringify(bad).slice(0, 60));
});
