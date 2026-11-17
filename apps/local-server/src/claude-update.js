// Is the installed Claude Code CLI behind the newest release, and update it from ADE (`claude update`).
//
// Why updating is safe while chats and terminals are running: the native installer (and `claude update`) writes the new
// binary next to the old ones and swaps `claude.exe` by renaming the one in use to `claude.exe.old.<time>`. A running
// session keeps its own process and binary until it ends; only sessions started afterwards run the new version.
// (On Windows an exe in use cannot be overwritten, only renamed, which is why those `.old.*` files exist.)
// A package-manager install (npm, brew, winget) can fail while a session runs; the CLI's own message is passed on as is.

const REGISTRY = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
const FRESH_MS = 30 * 60_000, RETRY_MS = 5 * 60_000;

// "2.1.326 (Claude Code)" or "2.1.326" -> [2, 1, 326]; null when no version is in the text.
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return match ? match.slice(1).map(Number) : null;
}
export function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}

export async function fetchLatestVersion({ fetchImpl = fetch, url = REGISTRY, timeoutMs = 8000 } = {}) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`버전 조회 실패 (HTTP ${response.status})`);
  const version = (await response.json())?.version;
  if (!parseVersion(version)) throw new Error('버전 조회 결과를 읽지 못했습니다.');
  return parseVersion(version).join('.');
}

// `exec(file, args, { timeoutMs })` resolves { exitCode, stdout, stderr } (LocalProcesses.exec). `onUpdated` runs after a successful update
// so the caller can drop what it cached about the old CLI (readiness, model catalog).
export function createClaudeUpdater({ exec, fetchLatest = fetchLatestVersion, onUpdated = () => {}, now = Date.now } = {}) {
  let cached = null, pending = null, updating = null;

  async function read() {
    let current = null, installed = true;
    try {
      const result = await exec('claude', ['--version'], { timeoutMs: 20_000 });
      current = result.exitCode === 0 ? parseVersion(result.stdout)?.join('.') ?? null : null;
    } catch (error) { if (error?.code === 'ENOENT') installed = false; }
    if (!installed) return { installed: false, current: null, latest: null, outdated: false, checkedAt: now() };
    try {
      const latest = await fetchLatest();
      return { installed: true, current, latest, outdated: isNewer(latest, current), checkedAt: now() };
    } catch (error) {
      // A failed lookup (offline) must not read as "up to date" nor hide the installed version; it is retried sooner.
      return { installed: true, current, latest: null, outdated: false, checkedAt: now(), error: String(error?.message ?? error) };
    }
  }

  function check(force = false) {
    if (!force && cached && now() - cached.checkedAt < (cached.error ? RETRY_MS : FRESH_MS)) return Promise.resolve(cached);
    pending ??= read().then(value => (cached = value), value => value).finally(() => { pending = null; });
    return pending;
  }

  // Runs `claude update` once at a time; a second call while one is running shares it.
  function update() {
    updating ??= (async () => {
      const before = (await check(true)).current;
      let result;
      try { result = await exec('claude', ['update'], { timeoutMs: 10 * 60_000 }); }
      catch (error) {
        const message = error?.code === 'ENOENT' ? 'claude 실행 파일을 PATH에서 찾을 수 없습니다.' : `업데이트를 실행하지 못했습니다: ${error?.message ?? error}`;
        return { ok: false, before, after: before, message, status: await check(true) };
      }
      const output = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
      const status = await check(true);
      const ok = result.exitCode === 0;
      if (ok) onUpdated();
      return { ok, before, after: status.current, changed: Boolean(before && status.current && before !== status.current), message: output.slice(-1500), status };
    })().finally(() => { updating = null; });
    return updating;
  }

  return { check, update };
}
