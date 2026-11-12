import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentKeys, CODEX_KEY_ENV, CODEX_PROVIDER } from '../apps/local-server/src/agent-keys.js';
import { openChatSession } from '../apps/local-server/src/chat.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/fake-chat-rpc.mjs', import.meta.url));
const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('chat did not settle'); };

async function store() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-keys-'));
  const file = path.join(dir, 'agent-keys.json');
  const keys = createAgentKeys({ file });
  await keys.load();
  return { dir, file, keys };
}

test('agent keys: the login is used until a key is saved, and the browser only sees the masked tail', async () => {
  const { dir, file, keys } = await store();
  try {
    assert.deepEqual(keys.launch('claude'), { env: {}, args: [] });
    assert.equal(keys.signature('claude'), 'login');
    const status = await keys.write({ agent: 'claude', key: '  sk-ant-api03-abcdefgh1234  ' });
    assert.deepEqual(status.claude, { use: true, key: '••••••••1234' });
    assert.ok(!JSON.stringify(status).includes('abcdefgh'));
    assert.deepEqual(keys.launch('claude'), { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefgh1234' }, args: [] });
    assert.notEqual(keys.signature('claude'), 'login');
    assert.ok(!keys.signature('claude').includes('1234'));
    // Other agents are untouched.
    assert.deepEqual(keys.launch('codex'), { env: {}, args: [] });
    // Survives a restart.
    const again = createAgentKeys({ file }); await again.load();
    assert.deepEqual(again.launch('claude').env, { ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefgh1234' });
    // Switching back to the login keeps the key for later.
    await keys.write({ agent: 'claude', use: false });
    assert.deepEqual(keys.launch('claude'), { env: {}, args: [] });
    assert.deepEqual(keys.status().claude, { use: false, key: '••••••••1234' });
    // Removing the key goes back to the login.
    await keys.write({ agent: 'claude', key: '' });
    assert.deepEqual(keys.status().claude, { use: false, key: '' });
  } finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('agent keys: codex gets an env-key provider through -c overrides, cursor gets CURSOR_API_KEY', async () => {
  const { dir, keys } = await store();
  try {
    await keys.write({ agent: 'codex', key: 'sk-proj-codexkey9999' });
    const codex = keys.launch('codex');
    assert.deepEqual(codex.env, { [CODEX_KEY_ENV]: 'sk-proj-codexkey9999' });
    assert.ok(codex.args.includes(`model_provider="${CODEX_PROVIDER}"`));
    assert.ok(codex.args.some(arg => arg.startsWith(`model_providers.${CODEX_PROVIDER}=`) && arg.includes(`env_key="${CODEX_KEY_ENV}"`)));
    assert.ok(!codex.args.join(' ').includes('codexkey'), 'the key never goes on the command line');
    await keys.write({ agent: 'cursor', key: 'key_cursor0000' });
    assert.deepEqual(keys.launch('cursor'), { env: { CURSOR_API_KEY: 'key_cursor0000' }, args: [] });
  } finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('agent keys: bad input is rejected', async () => {
  const { dir, keys } = await store();
  try {
    await assert.rejects(keys.write({ agent: 'gemini', key: 'abcdefgh1234' }), { code: 'INVALID_INPUT' });
    await assert.rejects(keys.write({ agent: 'claude', key: 'has space inside' }), { code: 'INVALID_INPUT' });
    await assert.rejects(keys.write({ agent: 'claude', key: 'short' }), { code: 'INVALID_INPUT' });
    await assert.rejects(keys.write({ agent: 'claude', use: true }), { code: 'INVALID_INPUT' });
    await assert.rejects(keys.write({ agent: 'claude', use: 'yes' }), { code: 'INVALID_INPUT' });
  } finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('chat launch reads env and executableArgs functions at every spawn', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-keys-chat-'));
  const calls = [];
  let env = { [CODEX_KEY_ENV]: 'sk-proj-first' };
  const spawnProcess = (file, args, options) => { calls.push({ args, env: options.env }); return spawn(file, args, options); };
  const options = { directory: dir, id: 'c1', cwd: dir, agent: 'codex', executable: process.execPath, spawnProcess, env: () => env, executableArgs: () => [fixture, 'codex'] };
  let chat;
  try {
    chat = await openChatSession(options);
    await chat.send('hello');
    await until(() => chat.state().status === 'idle');
    assert.deepEqual(calls.at(-1).args, [fixture, 'codex', 'app-server']);
    assert.equal(calls.at(-1).env[CODEX_KEY_ENV], 'sk-proj-first');
    // The key is switched on for an existing chat: the next start gets the new key, and its resume asks for the provider configured now
    // (the fake app-server reports FAKE_PROVIDER from config/read and fails a resume without EXPECT_PROVIDER).
    env = { [CODEX_KEY_ENV]: 'sk-proj-second', FAKE_PROVIDER: CODEX_PROVIDER, EXPECT_PROVIDER: CODEX_PROVIDER };
    await chat.close();
    chat = await openChatSession(options);
    await chat.send('again');
    await until(() => chat.state().status === 'idle');
    assert.equal(calls.at(-1).env[CODEX_KEY_ENV], 'sk-proj-second', 'a restart picks up the new key');
    assert.equal(chat.replay().events.filter(event => event.kind === 'user').length, 2, 'the same conversation went on');
    // And back to the login: resume with the default provider.
    env = { EXPECT_PROVIDER: 'openai' };
    await chat.close();
    chat = await openChatSession(options);
    await chat.send('third');
    await until(() => chat.state().status === 'idle');
    assert.equal(chat.state().error ?? null, null);
  } finally {
    await chat?.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
