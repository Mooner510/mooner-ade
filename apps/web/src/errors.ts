// One log per project (or "shell" before any project is open). The toast reads toastId/toastAt; the sidebar reads items.
export type AppError = { id: number; message: string; at: number };
export type ErrorLog = { items: AppError[]; toastId: number; toastAt: number };

const TOAST_MS = 10_000;
const MAX = 40;
const empty: ErrorLog = { items: [], toastId: 0, toastAt: 0 };
const logs = new Map<string, ErrorLog>();
const listeners = new Map<string, Set<() => void>>();
let seq = 1;

const emit = (scope: string) => listeners.get(scope)?.forEach(fn => fn());

// A fetch that never reached the server (stopped, restarting) throws a bare TypeError: "Failed to fetch" (Chrome), "Load failed" (Safari), "NetworkError…" (Firefox).
const NETWORK_FAILURE = /^(failed to fetch|load failed|networkerror)/i;
// A raw Node file-system error ("ENOENT: no such file or directory, realpath 'C:\x'") says nothing about what to do: name the cause in Korean and keep the path.
const FS_ERROR = /^(ENOENT|ENOTDIR|EACCES|EPERM|ENOSPC|EBUSY): [^']*?(?:'([^']*)')?(?: -> '[^']*')?$/;
const FS_REASON: Record<string, string> = {
  ENOENT: '찾을 수 없습니다. 이름이 바뀌었거나 삭제되었는지 확인하세요.', ENOTDIR: '폴더가 아닙니다. 폴더 경로가 맞는지 확인하세요.',
  EACCES: '접근 권한이 없습니다. 폴더 권한을 확인하세요.', EPERM: '접근이 허용되지 않습니다. 폴더 권한을 확인하세요.',
  ENOSPC: '디스크 공간이 부족합니다. 공간을 비운 뒤 다시 시도하세요.', EBUSY: '다른 프로그램이 사용 중입니다. 잠시 뒤 다시 시도하세요.'
};
export function errorText(cause: unknown) {
  if (cause instanceof TypeError && NETWORK_FAILURE.test(cause.message)) return '서버에 연결할 수 없습니다. 연결이 돌아오면 다시 시도하세요.';
  const message = (cause instanceof Error ? cause.message : String(cause ?? '')).trim();
  // 커밋·머지에는 git 사용자 정보가 필요하다. 새 PC에서 흔한 오류라 영어 안내 대신 할 일을 적는다.
  if (/Committer identity unknown|Please tell me who you are|unable to auto-detect email address/i.test(message)) return 'Git 사용자 이름과 이메일이 설정되어 있지 않습니다. 터미널에서 git config --global user.name "이름" 과 git config --global user.email "메일" 을 실행한 뒤 다시 시도하세요.';
  const fsError = FS_ERROR.exec(message);
  if (fsError) return `${fsError[2] ? `${fsError[2]} ` : ''}${FS_REASON[fsError[1]]}`;
  return message || '알 수 없는 오류';
}

// `git status` (and the log) on a directory that is not a repository. English git, and a Korean locale build.
export function notAGitRepository(message: string) {
  return /not a git repository/i.test(message) || /git 저장소가 아닙니다/i.test(message);
}

// A "not a repository" answer pauses polling. Another repository count, another selected repo (`key`), or this delay starts it again.
export const GIT_STATUS_RETRY_MS = 30_000;
export function gitStatusPause(quietUntil: number, quietKey: string, now: number, count: number, key: string) {
  if (count <= 0) return { poll: false, quietUntil: 0, quietKey: '' };
  if (quietUntil > now && quietKey === key) return { poll: false, quietUntil, quietKey };
  return { poll: true, quietUntil: 0, quietKey: key };
}

export function errorLog(scope: string): ErrorLog {
  return logs.get(scope) ?? empty;
}

export function subscribeErrors(scope: string, fn: () => void) {
  let set = listeners.get(scope);
  if (!set) listeners.set(scope, set = new Set());
  set.add(fn);
  return () => set.delete(fn);
}

// Same text while its toast is still up is ignored, so a polling failure does not stack or restart the timer.
export function pushError(scope: string, message: string) {
  const text = message.trim();
  if (!text) return;
  const prev = logs.get(scope);
  const now = Date.now();
  const items = prev?.items ?? [];
  const same = items.find(item => item.message === text);
  if (same && prev && prev.toastId === same.id && now - prev.toastAt < TOAST_MS) return;
  const item = same ? { ...same, at: now } : { id: seq++, message: text, at: now };
  const rest = items.filter(entry => entry.id !== item.id);
  // ponytail: keep 40, drop the oldest if a project produces more distinct failures than fit on one list
  logs.set(scope, { items: [item, ...rest].slice(0, MAX), toastId: item.id, toastAt: now });
  emit(scope);
}

export function dismissError(scope: string, id: number) {
  const prev = logs.get(scope);
  if (!prev?.items.some(item => item.id === id)) return;
  logs.set(scope, { ...prev, items: prev.items.filter(item => item.id !== id), ...(prev.toastId === id ? { toastId: 0 } : {}) });
  emit(scope);
}

export function clearErrors(scope: string) {
  if (!logs.get(scope)?.items.length) return;
  logs.set(scope, { items: [], toastId: 0, toastAt: 0 });
  emit(scope);
}
