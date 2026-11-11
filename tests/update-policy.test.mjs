import test from 'node:test';
import assert from 'node:assert/strict';
import { UPDATE_CHECK_INTERVAL_MS, compareVersions, createDeclined, describeReasons, isNewer, isPrerelease, normalizeReport, pickRelease, staleUpdateDirs, unknownReport, VERSION_PATTERN } from '../apps/desktop/src/update-policy.js';

test('background checks run every 30 minutes', () => {
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 10 * 60 * 1000);
});

test('a version the user turned down is remembered until the app restarts', () => {
  const declined = createDeclined();
  assert.equal(declined.has('0.2.9'), false);
  declined.add('0.2.9');
  assert.equal(declined.has('0.2.9'), true);
  assert.equal(declined.has('0.3.0'), false, 'a newer release is asked about again');
});

test('a report that cannot be understood counts as busy', () => {
  for (const bad of [null, undefined, 'idle', {}, { busy: 'no' }, { reasons: [] }]) {
    const report = normalizeReport(bad);
    assert.equal(report.busy, true, JSON.stringify(bad));
    assert.equal(report.reasons[0].kind, 'unknown');
  }
  assert.deepEqual(normalizeReport({ busy: false, reasons: [] }), { busy: false, reasons: [], kept: [], keepsTerminals: false });
  assert.deepEqual(normalizeReport({ busy: true, reasons: [null, 'x', { kind: 'turn' }] }), { busy: true, reasons: [{ kind: 'turn' }], kept: [], keepsTerminals: false });
  assert.equal(unknownReport('boom').reasons[0].detail, 'boom');
});

test('reasons are worded per kind and cut off after a few', () => {
  const text = describeReasons([
    { project: 'mooner-ade', terminal: 'web', agent: 'claude', kind: 'turn' },
    { project: 'mooner-ade', terminal: 'api', agent: 'claude', kind: 'background' },
    { project: 'tts', terminal: 'train', kind: 'command', detail: 'python' },
    { project: 'x', terminal: 'y', agent: 'claude', kind: 'scheduled', detail: '오후 3:20:00에 실행될 예정입니다' },
    { project: '', terminal: '', kind: 'unknown', detail: '서버가 응답하지 않습니다' },
  ]);
  assert.match(text, /^• mooner-ade · web: Claude가 작업 중$/m);
  assert.match(text, /^• mooner-ade · api: 백그라운드 작업\(shell·monitor\)이 실행 중/m);
  assert.match(text, /^• tts · train: 명령 실행 중 \(python\)$/m);
  assert.match(text, /^• 상태를 확인할 수 없음 \(서버가 응답하지 않습니다\)$/m);
  const many = describeReasons(Array.from({ length: 9 }, (_, index) => ({ project: 'p', terminal: String(index), kind: 'command' })), 6);
  assert.equal(many.split('\n').length, 7);
  assert.match(many, /그 밖에 3개$/);
});

test('only old update scratch folders are swept', () => {
  const now = Date.UTC(2026, 10, 7), day = 24 * 60 * 60 * 1000;
  const entries = [
    { name: 'mooner-update-abc', mtimeMs: now - 2 * day },
    { name: 'mooner-update-fresh', mtimeMs: now - 3600_000 },
    { name: '.MoonerADE-update-xyz', mtimeMs: now - 3 * day },
    { name: 'something-else', mtimeMs: now - 30 * day },
    { name: 'mooner-updater-notes', mtimeMs: now - 30 * day },
  ];
  assert.deepEqual(staleUpdateDirs(entries, now), ['mooner-update-abc', '.MoonerADE-update-xyz']);
});

test('with terminals kept through the restart, only what does not survive counts as busy', () => {
  const turn = { project: 'a', terminal: 'b', kind: 'turn', agent: 'claude', keeps: true }, plugin = { project: '', terminal: 'p', kind: 'plugin' };
  assert.deepEqual(normalizeReport({ busy: true, keepsTerminals: true, reasons: [turn] }), { busy: false, reasons: [], kept: [turn], keepsTerminals: true });
  assert.deepEqual(normalizeReport({ busy: true, keepsTerminals: true, reasons: [turn, plugin] }), { busy: true, reasons: [plugin], kept: [turn], keepsTerminals: true });
  // A `keeps` mark means nothing unless the server says its terminals are kept.
  assert.equal(normalizeReport({ busy: true, reasons: [turn] }).busy, true);
  assert.equal(normalizeReport({ busy: true, keepsTerminals: 'yes', reasons: [turn] }).busy, true);
  assert.equal(unknownReport('x').keepsTerminals, false);
});

test('versions order numerically, and a prerelease is older than its stable release', () => {
  assert.ok(isNewer('0.10.0', '0.9.9'));
  assert.ok(isNewer('0.4.1', '0.4.0'));
  assert.ok(isNewer('0.4.1-beta2', '0.4.1-beta1'));
  assert.ok(isNewer('0.4.1-beta10', '0.4.1-beta9'), 'beta10 follows beta9, not beta1');
  assert.ok(isNewer('0.4.1', '0.4.1-beta9'), 'the stable release follows its betas');
  assert.ok(isNewer('0.4.1-beta1', '0.4.0'), 'a beta of the next version is newer than the current stable');
  assert.equal(isNewer('0.4.1-beta1', '0.4.1'), false);
  assert.equal(compareVersions('0.4.1-beta1', '0.4.1-beta1'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(isPrerelease('0.4.1-beta1') && !isPrerelease('0.4.1'));
  for (const bad of ['0.4', 'v0.4.1', '0.4.1-', '0.4.1-beta_1', 'latest']) assert.equal(VERSION_PATTERN.test(bad), false, bad);
  for (const good of ['0.4.1', '0.4.1-beta1', '0.4.1-rc.2']) assert.equal(VERSION_PATTERN.test(good), true, good);
});

test('the release to offer: betas only on the beta channel, never drafts, and only with this platform zip', () => {
  const asset = 'MoonerADE-darwin-arm64.zip', files = [{ name: asset }];
  const release = (tag, extra = {}) => ({ tag_name: tag, assets: files, ...extra });
  const list = [release('v0.4.1-beta2', { prerelease: true }), release('v0.4.1-beta1', { prerelease: true }), release('v0.4.0'), release('v0.3.3')];
  assert.equal(pickRelease(list, { beta: false, asset }).version, '0.4.0');
  assert.equal(pickRelease(list, { beta: true, asset }).version, '0.4.1-beta2');
  assert.equal(pickRelease([release('v0.4.1'), ...list], { beta: true, asset }).version, '0.4.1', 'the stable release wins over its betas');
  assert.equal(pickRelease([release('v0.5.0', { draft: true }), release('v0.4.0')], { beta: true, asset }).version, '0.4.0');
  assert.equal(pickRelease([{ tag_name: 'v0.5.0', assets: [{ name: 'other.zip' }] }, release('v0.4.0')], { beta: true, asset }).version, '0.4.0');
  assert.equal(pickRelease([release('nightly'), release('v1.0')], { beta: true, asset }), null);
  assert.equal(pickRelease([{ tag_name: 'v0.4.0' }], { beta: false, asset }), null, 'a release without assets is skipped');
});
