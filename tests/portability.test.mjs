import test from 'node:test';
import assert from 'node:assert/strict';
import { AdeEngine, AllowAllPolicy } from '../packages/core/src/index.js';

test('same ADE Core runs against a container-like injected runtime with no host imports', async () => {
  const calls = [];
  const runtime = {
    workspace: {
      async readFile(p) { calls.push(['read', p]); return 'from-container'; },
      async writeFile(p, content) { calls.push(['write', p, content]); },
      async listFiles() { return [{ name: 'hello', kind: 'file' }]; }
    },
    processes: { async exec(file, args) { calls.push(['exec', file, args]); return { exitCode: 0, stdout: '' }; } },
    git: { async status() { return { clean: true }; } },
    terminal: { async open() { return { pid: 3, close() {} }; } }
  };
  const engine = new AdeEngine({ runtime, policy: new AllowAllPolicy() });
  assert.equal(await engine.readFile('hello'), 'from-container');
  await engine.writeFile('hello', 'updated');
  await engine.execute('pwd', []);
  assert.equal((await engine.openTerminal()).pid, 3);
  assert.deepEqual(calls, [['read', 'hello'], ['write', 'hello', 'updated'], ['exec', 'pwd', []]]);
});
