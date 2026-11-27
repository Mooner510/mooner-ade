import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { UPDATE_CHECK_INTERVAL_MS, RETRY_AFTER_FAILURE_MS, compareVersions, createDeclined, createFailures, describeFailure, describeReasons, isNewer, isPrerelease, normalizeReport, pickRelease, pluginApiSupported, quitPrompt, staleUpdateDirs, unknownReport, VERSION_PATTERN } from '../apps/desktop/src/update-policy.js';

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
  assert.deepEqual(normalizeReport({ busy: false, reasons: [] }), { busy: false, reasons: [], kept: [], keepsTerminals: false, keepsChats: false });
  assert.deepEqual(normalizeReport({ busy: true, reasons: [null, 'x', { kind: 'turn' }] }), { busy: true, reasons: [{ kind: 'turn' }], kept: [], keepsTerminals: false, keepsChats: false });
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
  assert.match(text, /^• mooner-ade \/ web: Claude가 작업 중$/m);
  assert.match(text, /^• mooner-ade \/ api: 백그라운드 작업\(shell\/monitor\)이 실행 중/m);
  assert.match(text, /^• tts \/ train: 명령 실행 중 \(python\)$/m);
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
  assert.deepEqual(normalizeReport({ busy: true, keepsTerminals: true, reasons: [turn] }), { busy: false, reasons: [], kept: [turn], keepsTerminals: true, keepsChats: false });
  assert.deepEqual(normalizeReport({ busy: true, keepsTerminals: true, reasons: [turn, plugin] }), { busy: true, reasons: [plugin], kept: [turn], keepsTerminals: true, keepsChats: false });
  // A `keeps` mark means nothing unless the server says its terminals are kept.
  assert.equal(normalizeReport({ busy: true, reasons: [turn] }).busy, true);
  assert.equal(normalizeReport({ busy: true, keepsTerminals: 'yes', reasons: [turn] }).busy, true);
  assert.equal(unknownReport('x').keepsTerminals, false);
  // A chat turn in the pty-host is kept like a terminal; keepsChats only counts with the terminals' host.
  assert.deepEqual(normalizeReport({ busy: true, keepsTerminals: true, keepsChats: true, reasons: [{ ...turn, agent: 'claude' }] }), { busy: false, reasons: [], kept: [{ ...turn, agent: 'claude' }], keepsTerminals: true, keepsChats: true });
  assert.equal(normalizeReport({ busy: true, keepsChats: true, reasons: [] }).keepsChats, false);
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

test('a failed update is explained in words a user can act on, an unknown failure keeps its own message', () => {
  const coded = (message, code, cause) => Object.assign(new Error(message), { code, ...cause && { cause: Object.assign(new Error('inner'), cause) } });
  assert.match(describeFailure(coded('ENOSPC: no space left on device, write', 'ENOSPC')), /^디스크 공간이 부족합니다/);
  assert.match(describeFailure(new Error('write failed: no space left on device')), /^디스크 공간이 부족합니다/);
  assert.match(describeFailure(coded('EACCES: permission denied', 'EACCES')), /^파일을 쓸 권한이 없습니다/);
  // fetch hides the real reason in `cause`; an interrupted body is just "terminated".
  for (const error of [coded('fetch failed', undefined, { code: 'ECONNREFUSED' }), coded('terminated', undefined, { code: 'UND_ERR_SOCKET' }), new Error('terminated'), new Error('fetch failed'), Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })]) {
    assert.match(describeFailure(error), /^네트워크 연결이 끊겼거나/, error.message);
  }
  for (const own of ['다운로드 실패 (HTTP 404)', '받은 업데이트 파일의 해시가 릴리스와 다릅니다.', '업데이트 파일 구성이 올바르지 않습니다.', 'C:/x 폴더에 쓸 수 없어 업데이트를 설치할 수 없습니다. (EPERM)']) assert.equal(describeFailure(new Error(own)), own);
  assert.equal(describeFailure('plain'), 'plain');
});

// ---- the quit question and the wait after a failed install --------------------------------------------------------------------------------------------

const NL = String.fromCharCode(10), lines = (...parts) => parts.join(NL);
const KEEP_FOREVER = '백그라운드로 남기기: 창을 닫아도 터미널과 채팅은 계속 실행되고, 다음에 앱을 열면 그대로 이어집니다.';
const END = '종료: 터미널과 채팅을 모두 끝냅니다. 대화는 저장되어 나중에 다시 열 수 있습니다.';

test('the quit question without an update waiting is worded as it always was', () => {
  const open = '터미널 2개와 채팅 1개(응답 중 1개)';
  assert.deepEqual(quitPrompt({ open, canKeep: true, chatsStop: false, lingerForever: true }), { buttons: ['백그라운드로 남기기', '종료', '취소'], detail: lines(`${open}가 열려 있습니다.`, '', lines(KEEP_FOREVER, END)) });
  assert.equal(quitPrompt({ open, canKeep: true, chatsStop: false, lingerForever: false }).detail, lines(`${open}가 열려 있습니다.`, '', lines(`${KEEP_FOREVER} (이번에는 30분 동안만 남습니다.)`, END)));
  assert.equal(quitPrompt({ open, canKeep: true, chatsStop: true, lingerForever: true }).detail, lines(`${open}가 열려 있습니다.`, '', lines(`${KEEP_FOREVER} (이번에는 채팅 응답이 중단됩니다. 앱을 한 번 다시 시작하면 채팅도 남길 수 있습니다.)`, END)));
  assert.deepEqual(quitPrompt({ open, canKeep: false, chatsStop: false, lingerForever: false }), { buttons: ['종료', '취소'], detail: lines(`${open}가 열려 있습니다.`, '', END) });
});

test('with an update waiting, the quit question says what the quit does: install, start again, terminals go on', () => {
  const open = '터미널 1개', staged = quitPrompt({ open, canKeep: true, chatsStop: false, lingerForever: true, stagedVersion: '0.6.0' });
  assert.deepEqual(staged.buttons, ['백그라운드로 남기기', '업데이트하고 다시 시작', '취소'], 'the plain 종료 is gone: it would promise an end that does not happen');
  assert.ok(!staged.detail.includes('모두 끝냅니다'), 'nothing says the terminals end');
  assert.match(staged.detail, /^터미널 1개가 열려 있습니다\./);
  assert.match(staged.detail, /업데이트하고 다시 시작: 받아 둔 업데이트\(v0\.6\.0\)를 설치하고 앱을 다시 실행합니다\. 터미널과 채팅은 끝나지 않고 새 창에서 이어집니다\./);
  assert.match(staged.detail, /백그라운드로 남기기: .*받아 둔 업데이트\(v0\.6\.0\)는 설치하지 않고 다음에 종료할 때로 미룹니다\./, 'staying in the background does not install it');
  // Chats a pty-host of an older version cannot keep are cut off by the restart, and the question says so.
  assert.match(quitPrompt({ open, canKeep: true, chatsStop: true, lingerForever: true, stagedVersion: '0.6.0' }).detail, /이어집니다\. \(이번에는 채팅 응답이 중단됩니다\.\)/);
  // Where terminals cannot be kept at all, the restart ends them, and that is what the question says.
  const noHost = quitPrompt({ open, canKeep: false, chatsStop: false, lingerForever: false, stagedVersion: '0.6.0' });
  assert.deepEqual(noHost.buttons, ['업데이트하고 다시 시작', '취소']);
  assert.match(noHost.detail, /이 환경에서는 터미널과 채팅이 이어지지 않고 끝납니다\./);
  assert.ok(!noHost.detail.includes('끝나지 않고'));
});

test('a version that failed to install is held back a little longer each time, and only the settings button or a newer version brings it back', () => {
  let time = 1_000_000;
  const failures = createFailures(() => time), minutes = count => count * 60_000;
  assert.equal(failures.blocked('0.6.0'), false, 'a version that never failed is not held back');
  assert.equal(failures.record('0.6.0'), 1);
  assert.equal(failures.blocked('0.6.0'), true);
  time += minutes(9); assert.equal(failures.blocked('0.6.0'), true);
  time += minutes(2); assert.equal(failures.blocked('0.6.0'), false, 'ten minutes after the first failure it is asked about again');
  assert.equal(failures.record('0.6.0'), 2);
  time += minutes(59); assert.equal(failures.blocked('0.6.0'), true);
  time += minutes(2); assert.equal(failures.blocked('0.6.0'), false, 'an hour after the second');
  assert.equal(failures.record('0.6.0'), 3);
  time += minutes(60 * 24 * 30); assert.equal(failures.blocked('0.6.0'), true, 'after the third it stays left alone for the rest of the session');
  assert.equal(failures.blocked('0.6.1'), false, 'a newer version is another version');
  assert.equal(failures.count('0.6.0'), 3);
  failures.clear('0.6.0');
  assert.deepEqual([failures.blocked('0.6.0'), failures.count('0.6.0')], [false, 0], 'an install that worked wipes the record');
  assert.deepEqual(RETRY_AFTER_FAILURE_MS, [minutes(10), minutes(60)]);
});

test('main.js asks the quit question through quitPrompt with the update that is waiting', () => {
  const main = readFileSync(new URL('../apps/desktop/src/main.js', import.meta.url), 'utf8');
  assert.match(main, /import \{[^}]*stagedUpdateVersion[^}]*\} from '\.\/updater\.js'/);
  assert.match(main, /quitPrompt\(\{[^}]*stagedVersion: stagedUpdateVersion\(\) \}\)/, 'the staged version reaches the question');
  assert.match(main, /buttons\[response\] === QUIT_CANCEL/);
  assert.match(main, /buttons\[response\] === QUIT_KEEP/);
  assert.ok(!main.includes("'종료: 터미널과 채팅을 모두 끝냅니다."), 'the wording lives in update-policy.js only');
});

test('a remote update needs the new release to still run the remote plugin’s API version', () => {
  const versions = JSON.parse(readFileSync(new URL('../apps/plugin-api/versions.json', import.meta.url), 'utf8'));
  assert.equal(pluginApiSupported(versions, 1), true, 'the shipped list runs v1');
  assert.equal(pluginApiSupported({ supported: [{ version: 1, status: 'deprecated' }], removed: [] }, 1), true);
  assert.equal(pluginApiSupported({ supported: [{ version: 2, status: 'supported' }], removed: [1] }, 1), false, 'removed');
  assert.equal(pluginApiSupported({ supported: [{ version: 2, status: 'supported' }], removed: [] }, 1), false, 'not listed');
  assert.equal(pluginApiSupported({ supported: [{ version: 1, status: 'gone' }] }, 1), false, 'unknown status');
  for (const bad of [null, undefined, {}, { supported: 'v1' }, 'x']) assert.equal(pluginApiSupported(bad, 1), false, JSON.stringify(bad));
  assert.equal(pluginApiSupported(versions, undefined), false, 'a plugin without a version is not assumed to fit');
});
