import test from 'node:test';
import assert from 'node:assert/strict';
import { GIT_STATUS_RETRY_MS, clearErrors, dismissError, errorLog, errorText, gitStatusPause, notAGitRepository, pushError } from '../apps/web/src/errors.ts';

test('errors stack newest first, ignore a repeat while its toast is up, and cap the list', () => {
  const scope = `t-${Date.now()}`;
  pushError(scope, '  ');
  assert.equal(errorLog(scope).items.length, 0);
  pushError(scope, '열지 못했습니다');
  const first = errorLog(scope);
  assert.equal(first.items.length, 1);
  assert.equal(first.toastId, first.items[0].id);
  pushError(scope, '열지 못했습니다');
  assert.equal(errorLog(scope).items.length, 1);
  assert.equal(errorLog(scope).toastAt, first.toastAt);
  pushError(scope, '브랜치를 바꾸지 못했습니다');
  assert.deepEqual(errorLog(scope).items.map(item => item.message), ['브랜치를 바꾸지 못했습니다', '열지 못했습니다']);
  for (let i = 0; i < 50; i++) pushError(scope, `e${i}`);
  assert.equal(errorLog(scope).items.length, 40);
  assert.equal(errorLog(scope).items[0].message, 'e49');
  dismissError(scope, errorLog(scope).items[0].id);
  assert.equal(errorLog(scope).items[0].message, 'e48');
  assert.equal(errorLog(scope).toastId, 0);
  clearErrors(scope);
  assert.equal(errorLog(scope).items.length, 0);
  assert.equal(errorText(new Error('끊김')), '끊김');
  assert.equal(errorText(''), '알 수 없는 오류');
  // A fetch that never reached the server is not shown as the browser's bare English text.
  for (const text of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) assert.match(errorText(new TypeError(text)), /서버에 연결할 수 없습니다/);
  assert.equal(errorText(new Error('Failed to fetch')), 'Failed to fetch');
});

test('git status polling pauses for one selection and resumes when the selection or the delay changes', () => {
  const paused = gitStatusPause(1_000, '1:main', 500, 1, '1:main');
  assert.equal(paused.poll, false);
  assert.equal(gitStatusPause(1_000, '1:main', 500, 1, '2:other').poll, true);
  assert.equal(gitStatusPause(1_000, '1:main', 500, 0, '0:').poll, false);
  assert.equal(gitStatusPause(1_000, '1:main', 1_000 + GIT_STATUS_RETRY_MS, 1, '1:main').poll, true);
});

test('a non-repository git status is recognized in English and Korean', () => {
  assert.equal(notAGitRepository('fatal: not a git repository (or any of the parent directories): .git'), true);
  assert.equal(notAGitRepository('치명적 오류: Git 저장소가 아닙니다 (또는 상위 디렉터리 중 어디에도): .git'), true);
  assert.equal(notAGitRepository('fatal: ambiguous argument \'HEAD\''), false);
  assert.equal(notAGitRepository(''), false);
});

test('a raw Node file-system error is shown as a Korean sentence that keeps the path and says what to check', () => {
  assert.equal(errorText(new Error("ENOENT: no such file or directory, realpath 'C:\work\gone'")), "C:\work\gone 찾을 수 없습니다. 이름이 바뀌었거나 삭제되었는지 확인하세요.");
  assert.match(errorText(new Error("EACCES: permission denied, open '/root/x'")), /^\/root\/x 접근 권한이 없습니다/);
  assert.match(errorText(new Error('ENOSPC: no space left on device, write')), /^디스크 공간이 부족합니다/);
  // Anything that is not that shape is passed through untouched.
  assert.equal(errorText(new Error('ENOENT은 파일이 없다는 뜻')), 'ENOENT은 파일이 없다는 뜻');
  assert.equal(errorText(new Error('열지 못했습니다')), '열지 못했습니다');
});

test('git 사용자 정보가 없을 때의 영어 오류는 설정 방법을 알려 주는 문장이 된다', () => {
  const text = errorText(new Error('Committer identity unknown *** Please tell me who you are. Run git config --global user.email "you@example.com" fatal: unable to auto-detect email address'));
  assert.match(text, /^Git 사용자 이름과 이메일이 설정되어 있지 않습니다/);
  assert.match(text, /git config --global user.name/);
});
