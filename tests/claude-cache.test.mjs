import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readClaudeCache, readSessionCache } from '../apps/local-server/src/claude-cache.js';

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

test('idle compaction moves the end of the countdown to just before the 1h cache expires, only when it would run', async () => {
  const config = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-cache-'));
  await fs.mkdir(path.join(config, 'sessions'));
  await fs.writeFile(path.join(config, 'sessions', '42.json'), JSON.stringify({ pid: 42, sessionId: session, cwd }));
  const dir = path.join(config, 'projects', '-Users-me-my-project');
  await fs.mkdir(dir, { recursive: true });
  const at = Date.parse('2026-11-06T10:00:00.000Z');
  await fs.writeFile(path.join(dir, `${session}.jsonl`), `${request('r1', '2026-11-06T10:00:00.000Z')}\n${reply({ requestRef: 'r1', promptCacheRequested: '1h' }, { cache_read_input_tokens: 250000 })}\n`);

  assert.equal((await readClaudeCache(config, 42)).value.compactAt, at + 54 * 60 * 1000, 'auto-compact is on by default');
  for (const settings of [{ autoCompactEnabled: false }, { idleCompaction: false }, { env: { DISABLE_AUTO_COMPACT: '1' } }, { env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '300000' } }]) {
    await fs.writeFile(path.join(config, 'settings.json'), JSON.stringify(settings));
    assert.equal((await readClaudeCache(config, 42)).value.compactAt, undefined, JSON.stringify(settings));
  }
  // Below 100K the threshold is raised to 100K, so a 150K conversation still compacts.
  await fs.writeFile(path.join(config, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '1000' } }));
  await fs.appendFile(path.join(dir, `${session}.jsonl`), `${request('r2', '2026-11-06T10:10:00.000Z')}\n${reply({ requestRef: 'r2', promptCacheRequested: '1h' }, { cache_read_input_tokens: 50000 })}\n`);
  assert.equal((await readClaudeCache(config, 42)).value.compactAt, undefined, '52K is under the 100K floor');
  await fs.rm(config, { recursive: true, force: true });
});

test('a compaction boundary marks the cache as compacted until the next main-thread request', async () => {
  const config = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-cache-'));
  await fs.mkdir(path.join(config, 'sessions'));
  await fs.writeFile(path.join(config, 'sessions', '42.json'), JSON.stringify({ pid: 42, sessionId: session, cwd }));
  const dir = path.join(config, 'projects', '-Users-me-my-project'), file = path.join(dir, `${session}.jsonl`);
  await fs.mkdir(dir, { recursive: true });
  const boundary = (trigger, timestamp) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', isSidechain: false, timestamp, compactMetadata: { trigger, preTokens: 223036, postTokens: 18933 } });
  await fs.writeFile(file, `${request('r1', '2026-11-06T10:00:00.000Z')}\n${reply({ requestRef: 'r1', promptCacheRequested: '1h' }, {})}\n`);
  assert.equal((await readClaudeCache(config, 42)).value.compacted, undefined);

  await fs.appendFile(file, `${boundary('auto', '2026-11-06T10:54:30.000Z')}\n`);
  const compacted = await readClaudeCache(config, 42, await readClaudeCache(config, 42));
  assert.deepEqual(compacted.value.compacted, { at: Date.parse('2026-11-06T10:54:30.000Z'), trigger: 'auto', before: 223036, after: 18933 });
  assert.equal(compacted.value.at, Date.parse('2026-11-06T10:00:00.000Z'), 'the last request is kept');

  await fs.appendFile(file, `${request('r2', '2026-11-06T11:10:00.000Z')}\n${reply({ requestRef: 'r2', promptCacheRequested: '1h' }, {})}\n`);
  assert.equal((await readClaudeCache(config, 42, compacted)).value.compacted, undefined, 'the next request starts a fresh cache');
  await fs.appendFile(file, `${boundary('manual', '2026-11-06T11:20:00.000Z')}\n`);
  assert.equal((await readClaudeCache(config, 42, await readClaudeCache(config, 42))).value.compacted.trigger, 'manual');
  await fs.rm(config, { recursive: true, force: true });
});

test('a chat reads its cache clock by session id (no sessions/<pid>.json), and never promises an idle compaction', async () => {
  const config = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-cache-'));
  const dir = path.join(config, 'projects', '-Users-me-my-project');
  await fs.mkdir(dir, { recursive: true });
  // A 1h cache over a long conversation would get a compactAt from a terminal's Claude Code; a chat's child is stopped when idle, so it must not.
  await fs.writeFile(path.join(dir, `${session}.jsonl`), `${request('r1', '2026-11-06T10:00:00.000Z')}\n${reply({ requestRef: 'r1', promptCacheRequested: '1h' }, { cache_read_input_tokens: 300000 })}\n`);
  const reading = await readSessionCache(config, { sessionId: session, cwd }, null, { idle: false });
  assert.equal(reading.value.ttl, 3600);
  assert.equal(reading.value.compactAt, undefined);
  assert.equal(await readSessionCache(config, { sessionId: '../x', cwd }), null);
  await fs.rm(config, { recursive: true, force: true });
});
