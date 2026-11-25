import test from 'node:test';
import assert from 'node:assert/strict';
import { addTrust, trustLabel } from '../apps/web/src/mcp-trust.ts';

test('trusting adds an entry once, and a whole server replaces its single tools', () => {
  const tool = { server: 'srv', tool: 'run' };
  assert.deepEqual(addTrust([], tool), [tool]);
  assert.deepEqual(addTrust([tool], tool), [tool]);
  assert.deepEqual(addTrust([tool, { server: 'srv', tool: 'other' }, { server: 'b', tool: 'x' }], { server: 'srv' }), [{ server: 'b', tool: 'x' }, { server: 'srv' }]);
  assert.deepEqual(addTrust([{ server: 'srv' }], tool), [{ server: 'srv' }], 'already covered by the server');
  assert.equal(trustLabel({ server: 'srv' }), 'srv: 모든 도구'); assert.equal(trustLabel(tool), 'srv: run');
});
