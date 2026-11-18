import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeUpdater, createCliUpdater, fetchLatestVersion, isNewer, parseVersion } from '../apps/local-server/src/claude-update.js';

test('versions parse out of the CLI banner and compare numerically', () => {
  assert.deepEqual(parseVersion('2.1.326 (Claude Code)\n'), [2, 1, 326]);
  assert.equal(parseVersion('no version'), null);
  assert.equal(isNewer('2.1.330', '2.1.326'), true);
  assert.equal(isNewer('2.1.326', '2.1.326'), false);
  assert.equal(isNewer('2.1.9', '2.1.10'), false, 'numeric, not text, comparison');
  assert.equal(isNewer('2.2.0', '2.1.999'), true);
  assert.equal(isNewer(null, '2.1.1'), false);
});

test('the latest version is read from the registry answer and bad answers are errors', async () => {
  const answer = (ok, body) => async () => ({ ok, status: ok ? 200 : 503, json: async () => body });
  assert.equal(await fetchLatestVersion({ fetchImpl: answer(true, { version: '2.1.330' }) }), '2.1.330');
  await assert.rejects(fetchLatestVersion({ fetchImpl: answer(false, {}) }), /503/);
  await assert.rejects(fetchLatestVersion({ fetchImpl: answer(true, { version: 'x' }) }), /읽지 못/);
});

function harness({ versions = ['2.1.326'], latest = '2.1.330', updateExit = 0, missing = false } = {}) {
  const calls = [];
  let installed = 0, clock = 0, updated = 0;
  const exec = async (file, args) => {
    calls.push(args.join(' '));
    if (missing) throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    if (args[0] === '--version') return { exitCode: 0, stdout: `${versions[Math.min(installed, versions.length - 1)]} (Claude Code)\n`, stderr: '' };
    if (args[0] === 'update') { installed++; return { exitCode: updateExit, stdout: '\x1b[32mUpdated\x1b[0m\n', stderr: '' }; }
    throw new Error(`unexpected ${args}`);
  };
  const fetchLatest = async () => { if (latest instanceof Error) throw latest; return latest; };
  const updater = createClaudeUpdater({ exec, fetchLatest, onUpdated: () => updated++, now: () => clock });
  return { updater, calls, tick: ms => { clock += ms; }, updated: () => updated };
}

test('an older CLI is reported as outdated and the answer is cached for a while', async () => {
  const { updater, calls, tick } = harness();
  const first = await updater.check();
  assert.deepEqual({ current: first.current, latest: first.latest, outdated: first.outdated }, { current: '2.1.326', latest: '2.1.330', outdated: true });
  await updater.check();
  assert.equal(calls.length, 1, 'the second call reuses the answer');
  tick(31 * 60_000);
  await updater.check();
  assert.equal(calls.length, 2);
  await updater.check(true);
  assert.equal(calls.length, 3, 'force asks again');
});

test('an offline lookup keeps the installed version, is not "up to date" news, and is retried sooner', async () => {
  const { updater, tick } = harness({ latest: new Error('offline') });
  const status = await updater.check();
  assert.equal(status.current, '2.1.326');
  assert.equal(status.outdated, false);
  assert.match(status.error, /offline/);
  tick(6 * 60_000);
  assert.notEqual(await updater.check(), status, 'retried after five minutes, not thirty');
});

test('a missing CLI is reported as not installed', async () => {
  const { updater } = harness({ missing: true });
  assert.deepEqual(await updater.check(), { installed: false, current: null, latest: null, outdated: false, checkedAt: 0 });
});

test('update runs `claude update`, strips colours, reports the new version and lets the caller drop its caches', async () => {
  const { updater, calls, updated } = harness({ versions: ['2.1.326', '2.1.330'] });
  const result = await updater.update();
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual([result.before, result.after], ['2.1.326', '2.1.330']);
  assert.equal(result.message, 'Updated');
  assert.equal(result.status.outdated, false);
  assert.ok(calls.includes('update'));
  assert.equal(updated(), 1);
});

test('a failed update says so, keeps the version and does not clear caches', async () => {
  const { updater, updated } = harness({ updateExit: 1 });
  const result = await updater.update();
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(updated(), 0);
});

test('codex checks its own command and registry, then runs `codex update`', async () => {
  const seen = [];
  let installed = 0;
  const exec = async (file, args) => {
    seen.push(`${file} ${args.join(' ')}`);
    if (args[0] === '--version') return { exitCode: 0, stdout: `${installed ? '0.169.0' : '0.160.0'}\n`, stderr: '' };
    installed++;
    return { exitCode: 0, stdout: 'Updated\n', stderr: '' };
  };
  const updater = createCliUpdater({
    agent: 'codex',
    exec,
    fetchImpl: async url => { seen.push(url); return { ok: true, status: 200, json: async () => ({ version: '0.169.0' }) }; },
  });
  const status = await updater.check();
  assert.equal(status.outdated, true);
  assert.equal(status.current, '0.160.0');
  assert.ok(seen.includes('codex --version'));
  assert.ok(seen.includes('https://registry.npmjs.org/@openai/codex/latest'));
  const result = await updater.update();
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual([result.before, result.after], ['0.160.0', '0.169.0']);
  assert.ok(seen.includes('codex update'));
});

test('two update requests at once run one update', async () => {
  const { updater, calls } = harness({ versions: ['2.1.326', '2.1.330'] });
  await Promise.all([updater.update(), updater.update()]);
  assert.equal(calls.filter(call => call === 'update').length, 1);
});
