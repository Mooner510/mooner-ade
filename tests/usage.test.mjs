import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { claudeKeychainServices, createAccountResolver, createUsage, envFromPs, parseClaudeUsage, parseCodexLogLine, parseCodexUsage, readClaudeLogin, readCodexLogin, TTL } from '../apps/local-server/src/usage.js';

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('a custom Claude config dir is looked up under its hashed keychain entry first', () => {
  assert.deepEqual(claudeKeychainServices({}), ['Claude Code-credentials']);
  const [own, fallback] = claudeKeychainServices({ CLAUDE_CONFIG_DIR: '/x/.claude-account' });
  assert.match(own, /^Claude Code-credentials-[0-9a-f]{8}$/);
  assert.equal(fallback, 'Claude Code-credentials');
});

test('Claude logins come from the keychain on macOS and the credentials file elsewhere', async () => {
  const secret = JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: 5, subscriptionType: 'max' } });
  assert.deepEqual(await readClaudeLogin({ env: {}, platform: 'darwin', readSecret: async () => secret, readFile: async () => { throw new Error('unused'); } }), { token: 'tok', expiresAt: 5, plan: 'max' });
  const files = [];
  assert.deepEqual(await readClaudeLogin({ env: {}, platform: 'linux', home: '/h', readFile: async file => { files.push(file); return secret; } }), { token: 'tok', expiresAt: 5, plan: 'max' });
  assert.deepEqual(files, [path.join('/h', '.claude', '.credentials.json')]);
  assert.equal(await readClaudeLogin({ env: {}, platform: 'darwin', readSecret: async () => '{bad', readFile: async () => { throw new Error('none'); } }), null);
});

test('Codex logins need ChatGPT tokens, not an API key', async () => {
  assert.deepEqual(await readCodexLogin({ env: {}, home: '/h', readFile: async () => JSON.stringify({ tokens: { access_token: 'a', account_id: 'acc' } }) }), { token: 'a', account: 'acc' });
  assert.equal(await readCodexLogin({ env: {}, home: '/h', readFile: async () => JSON.stringify({ OPENAI_API_KEY: 'sk' }) }), null);
});

test('usage bodies become 5-hour and weekly windows', () => {
  assert.deepEqual(parseClaudeUsage({ five_hour: { utilization: 23.4, resets_at: '2026-10-23T10:00:00Z' }, seven_day: { utilization: 41, resets_at: null }, seven_day_opus: null }), [
    { key: 'session', label: '5시간', percent: 23, resetsAt: Date.parse('2026-10-23T10:00:00Z') },
    { key: 'weekly', label: '주간', percent: 41, resetsAt: null }
  ]);
  assert.deepEqual(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 60 }, secondary_window: { used_percent: 130, limit_window_seconds: 604800, reset_at: 1000 } } }, 0), [
    { key: 'session', label: '5시간', percent: 12, resetsAt: 60_000 },
    { key: 'weekly', label: '주간', percent: 100, resetsAt: 1_000_000 }
  ]);
  const line = JSON.stringify({ timestamp: '2026-10-23T00:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 10 }, secondary: { used_percent: 50, window_minutes: 10080, resets_at: 2 } } } });
  const at = Date.parse('2026-10-23T00:00:00Z');
  assert.deepEqual(parseCodexLogLine(line), { at, windows: [{ key: 'session', label: '5시간', percent: 5, resetsAt: at + 10_000 }, { key: 'weekly', label: '주간', percent: 50, resetsAt: 2000 }] });
  assert.equal(parseCodexLogLine('{"type":"other"}'), null);
});

test('readings are cached, forced refreshes are spaced, and a 429 keeps the last value and backs off', async () => {
  let clock = 1_000_000, calls = 0, status = 200;
  const usage = createUsage({
    now: () => clock, claudeLogin: async () => ({ token: 't', expiresAt: 0, plan: 'pro' }),
    fetch: async (url, { headers }) => { calls++; assert.equal(headers.Authorization, 'Bearer t'); return json({ five_hour: { utilization: calls, resets_at: null } }, status); }
  });
  assert.equal((await usage.status('claude')).windows[0].percent, 1);
  await usage.status('claude');
  assert.equal(calls, 1, 'cached within the TTL');
  clock += 10_000; await usage.status('claude', { force: true });
  assert.equal(calls, 1, 'a force right after a reading is ignored');
  clock += 30_000; await usage.status('claude', { force: true });
  assert.equal(calls, 2);
  status = 429; clock += TTL;
  const limited = await usage.status('claude');
  assert.equal(limited.windows[0].percent, 2, 'last good reading survives');
  assert.match(limited.error, /한도/);
  clock += TTL; await usage.status('claude');
  assert.equal(calls, 3, 'backing off after a 429');
  clock += 10 * 60_000; status = 200;
  assert.equal((await usage.status('claude')).error, null);
  assert.equal(calls, 4);
  await assert.rejects(usage.status('gemini'), /알 수 없는/);
});

test('Codex falls back to its session log when the API is unavailable', async () => {
  const usage = createUsage({
    now: () => 0, codexLogin: async () => null,
    codexLog: async () => ({ at: 7, windows: [{ key: 'weekly', label: '주간', percent: 9, resetsAt: null }] })
  });
  const result = await usage.status('codex');
  assert.equal(result.source, 'log');
  assert.equal(result.at, 7);
  assert.equal(result.error, null);
  assert.match(result.note, /로그인/);
});

test('ps -E output yields the last value of a variable, spaces included', () => {
  assert.equal(envFromPs('claude --x A=1 CLAUDE_CONFIG_DIR=/Users/a/Application Support/acc HOME=/Users/a', 'CLAUDE_CONFIG_DIR'), '/Users/a/Application Support/acc');
  assert.equal(envFromPs('claude HOME=/x', 'CLAUDE_CONFIG_DIR'), null);
});

test('a project resolves to its running agent account, then its .envrc, then the server environment', async () => {
  const files = new Set([path.join('/acc-b', 'sessions', '42.json')]);
  const make = (overrides = {}) => createAccountResolver({ env: { CLAUDE_CONFIG_DIR: '/acc-a' }, platform: 'darwin', home: '/h', readVariable: async () => '', direnv: async () => '/bin/direnv', exec: async () => null, exists: async file => files.has(file), ...overrides });
  const project = terminals => ({ root: '/p', terminals: new Map(terminals.map((terminal, index) => [String(index), terminal])) });
  assert.deepEqual(await make()('claude', null), { dir: '/acc-a', from: 'server' });
  assert.deepEqual(await make()('claude', project([])), { dir: '/acc-a', from: 'server' });
  assert.deepEqual(await make({ exec: async () => '/acc-b' })('claude', project([])), { dir: '/acc-b', from: 'direnv' });
  // macOS hides the environment, so the session PID file names the folder.
  assert.deepEqual(await make({ exec: async () => '/acc-b' })('claude', project([{ agent: 'claude', agentPid: 42 }])), { dir: '/acc-b', from: 'process' });
  files.add(path.join('/h', '.claude', 'sessions', '7.json'));
  assert.deepEqual(await make()('claude', project([{ agent: 'codex', agentPid: 42 }, { agent: 'claude', agentPid: 7 }])), { dir: '', from: 'process' });
  // Where the environment is readable it wins outright.
  assert.deepEqual(await make({ platform: 'linux', readVariable: async () => '/acc-c' })('codex', project([{ agent: 'codex', agentPid: 9 }])), { dir: '/acc-c', from: 'process' });
});

test('each account folder gets its own cached reading', async () => {
  const seen = [];
  const usage = createUsage({
    now: () => 1_000_000, account: async (provider, project) => ({ dir: project?.dir ?? '', from: 'direnv' }),
    claudeLogin: async ({ env }) => { seen.push(env.CLAUDE_CONFIG_DIR); return { token: env.CLAUDE_CONFIG_DIR || 'default', expiresAt: 0, plan: '' }; },
    fetch: async (url, { headers }) => json({ five_hour: { utilization: headers.Authorization.endsWith('/b') ? 80 : 10, resets_at: null } })
  });
  assert.equal((await usage.status('claude', { project: { dir: '/a' } })).windows[0].percent, 10);
  const b = await usage.status('claude', { project: { dir: '/b' } });
  assert.equal(b.windows[0].percent, 80);
  assert.deepEqual(b.account, { dir: '/b', from: 'direnv' });
  await usage.status('claude', { project: { dir: '/a' } });
  assert.deepEqual(seen, ['/a', '/b']);
});

test('session sync gets the folder of the Claude process itself, cached per PID', async () => {
  const files = new Set([path.join('/acc-b', 'sessions', '42.json')]);
  let reads = 0;
  const accounts = createAccountResolver({ env: {}, platform: 'darwin', home: '/h', readVariable: async () => { reads++; return ''; }, direnv: async () => '/bin/direnv', exec: async () => '/acc-b', exists: async file => files.has(file) });
  assert.equal(await accounts.agentFolder('claude', 42, '/p'), '/acc-b');
  assert.equal(await accounts.agentFolder('claude', 42, '/p'), '/acc-b');
  assert.equal(reads, 1);
  // Not found yet (the CLI has not written its file): fall back to what the project would give it.
  assert.equal(await accounts.agentFolder('claude', 43, '/p'), '/acc-b');
  const plain = createAccountResolver({ env: {}, platform: 'darwin', home: '/h', readVariable: async () => '', direnv: async () => null, exists: async () => false });
  assert.equal(await plain.agentFolder('claude', 1, '/p'), path.join('/h', '.claude'));
});
