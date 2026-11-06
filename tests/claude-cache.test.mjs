import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readClaudeCache } from '../apps/local-server/src/claude-cache.js';

const session = '5450d9b4-ef97-4365-80a9-40e9e92cc1a0', cwd = '/Users/me/my_project';
const request = (id, timestamp) => JSON.stringify({ type: 'api-request', id, timestamp });
const reply = (fields, usage) => JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: '2026-11-06T10:00:30.000Z', ...fields,
  message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, ...usage } } });

test('the cache timer runs from the start of the latest main-thread request, with the TTL it asked for', async () => {
  const config = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-cache-'));
  await fs.mkdir(path.join(config, 'sessions'));
  await fs.writeFile(path.join(config, 'sessions', '42.json'), JSON.stringify({ pid: 42, sessionId: session, cwd }));
  const dir = path.join(config, 'projects', '-Users-me-my-project'), file = path.join(dir, `${session}.jsonl`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, [
    request('r1', '2026-11-06T10:00:00.000Z'),
    reply({ requestRef: 'r1', promptCacheRequested: '1h' }, { cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 40 } }),
    reply({ isSidechain: true, timestamp: '2026-11-06T11:00:00.000Z' }, {})
  ].join('\n') + '\n');

  const first = await readClaudeCache(config, 42);
  assert.deepEqual(first.value, { at: Date.parse('2026-11-06T10:00:00.000Z'), ttl: 3600, tokens: 1002, model: 'claude-opus-5-5' });
  assert.equal(await readClaudeCache(config, 42, first), first, 'an unchanged transcript is not read again');

  // Appended lines are read incrementally; without a requested TTL the written tokens decide, and the default is 5 minutes.
  await fs.appendFile(file, `${request('r2', '2026-11-06T10:20:00.000Z')}\n${reply({ requestRef: 'r2' }, { cache_creation: { ephemeral_5m_input_tokens: 10 } })}\n`);
  const second = await readClaudeCache(config, 42, first);
  assert.equal(second.value.at, Date.parse('2026-11-06T10:20:00.000Z'));
  assert.equal(second.value.ttl, 300);

  assert.equal(await readClaudeCache(config, 7), null, 'no session file, no timer');
  await fs.rm(config, { recursive: true, force: true });
});
