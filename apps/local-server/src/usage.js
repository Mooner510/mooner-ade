import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fault } from './files.js';

// Plan limits move slowly and both endpoints are rate limited, so a reading is reused for a few minutes.
export const TTL = 3 * 60_000;
const FORCE_GAP = 30_000, BACKOFF = 10 * 60_000;
export const providers = ['claude', 'codex'];

// Claude Code keeps its OAuth login in the macOS keychain; a custom CLAUDE_CONFIG_DIR gets its own entry suffixed with a hash of that path.
export function claudeKeychainServices(env = process.env) {
  const base = 'Claude Code-credentials', dir = env.CLAUDE_CONFIG_DIR;
  return dir ? [`${base}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`, base] : [base];
}

const keychain = service => new Promise(resolve => {
  execFile('security', ['find-generic-password', '-s', service, '-w'], { timeout: 10_000 }, (error, stdout) => resolve(error ? null : stdout.trim()));
});

export async function readClaudeLogin({ env = process.env, platform = process.platform, home = os.homedir(), readSecret = keychain, readFile = fs.readFile } = {}) {
  const sources = platform === 'darwin' ? claudeKeychainServices(env).map(service => () => readSecret(service)) : [];
  sources.push(() => readFile(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), '.credentials.json'), 'utf8').catch(() => null));
  for (const source of sources) {
    const text = await source();
    if (!text) continue;
    try {
      const login = JSON.parse(text).claudeAiOauth;
      if (login?.accessToken) return { token: login.accessToken, expiresAt: Number(login.expiresAt) || 0, plan: login.subscriptionType || '' };
    } catch { /* a corrupt entry falls through to the next source */ }
  }
  return null;
}

export async function readCodexLogin({ env = process.env, home = os.homedir(), readFile = fs.readFile } = {}) {
  const text = await readFile(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'), 'utf8').catch(() => null);
  if (!text) return null;
  try {
    const tokens = JSON.parse(text).tokens;
    return tokens?.access_token ? { token: tokens.access_token, account: tokens.account_id || '' } : null;
  } catch { return null; }
}

const percent = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
const windowKey = seconds => seconds <= 6 * 3600 ? 'session' : seconds >= 6 * 86400 ? 'weekly' : 'other';

// { five_hour: { utilization, resets_at }, seven_day: …, seven_day_opus: … } from api.anthropic.com/api/oauth/usage.
export function parseClaudeUsage(body) {
  const windows = [];
  const add = (key, label, value) => { if (value && value.utilization !== null && value.utilization !== undefined) windows.push({ key, label, percent: percent(value.utilization), resetsAt: Date.parse(value.resets_at) || null }); };
  add('session', '5시간', body?.five_hour);
  add('weekly', '주간', body?.seven_day);
  add('weekly-opus', '주간 Opus', body?.seven_day_opus);
  add('weekly-sonnet', '주간 Sonnet', body?.seven_day_sonnet);
  return windows;
}

// { plan_type, rate_limit: { primary_window: { used_percent, limit_window_seconds, reset_at }, secondary_window } } from chatgpt.com/backend-api/wham/usage.
export function parseCodexUsage(body, now = Date.now()) {
  const windows = [];
  for (const value of [body?.rate_limit?.primary_window, body?.rate_limit?.secondary_window]) {
    if (!value) continue;
    const seconds = Number(value.limit_window_seconds) || 0, key = windowKey(seconds);
    const resetsAt = value.reset_at ? Number(value.reset_at) * 1000 : value.reset_after_seconds !== undefined ? now + Number(value.reset_after_seconds) * 1000 : null;
    windows.push({ key, label: key === 'session' ? '5시간' : key === 'weekly' ? '주간' : `${Math.round(seconds / 3600)}시간`, percent: percent(value.used_percent), resetsAt });
  }
  return windows;
}

// Codex also writes its rate limits into every session log, which works offline and for API-key logins once a session has run.
export function parseCodexLogLine(line) {
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  const limits = entry?.payload?.rate_limits ?? entry?.rate_limits;
  if (!limits) return null;
  const at = Date.parse(entry.timestamp) || 0, windows = [];
  for (const value of [limits.primary, limits.secondary]) {
    if (!value) continue;
    const key = windowKey((Number(value.window_minutes) || 0) * 60);
    const resetsAt = value.resets_at ? Number(value.resets_at) * 1000 : value.resets_in_seconds !== undefined && at ? at + Number(value.resets_in_seconds) * 1000 : null;
    windows.push({ key, label: key === 'session' ? '5시간' : key === 'weekly' ? '주간' : `${Math.round(value.window_minutes / 60)}시간`, percent: percent(value.used_percent), resetsAt });
  }
  return windows.length ? { at, windows } : null;
}

// Newest rollout under sessions/YYYY/MM/DD, read from its tail.
export async function readCodexLog({ env = process.env, home = os.homedir() } = {}) {
  let dir = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
  for (let depth = 0; depth < 3; depth++) {
    const names = (await fs.readdir(dir).catch(() => [])).filter(name => /^\d+$/.test(name)).sort().reverse();
    if (!names.length) return null;
    dir = path.join(dir, names[0]);
  }
  const files = (await fs.readdir(dir).catch(() => [])).filter(name => name.endsWith('.jsonl'));
  const stats = await Promise.all(files.map(async name => ({ name, mtime: (await fs.stat(path.join(dir, name)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
  for (const { name } of stats.sort((a, b) => b.mtime - a.mtime).slice(0, 5)) {
    const handle = await fs.open(path.join(dir, name)).catch(() => null);
    if (!handle) continue;
    try {
      const { size } = await handle.stat(), length = Math.min(size, 512 * 1024), buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n');
      for (let index = lines.length - 1; index >= 0; index--) if (lines[index].includes('rate_limits')) { const found = parseCodexLogLine(lines[index]); if (found) return found; }
    } finally { await handle.close(); }
  }
  return null;
}

class UsageError extends Error { constructor(message, status) { super(message); this.status = status; } }
async function getJson(fetchImpl, url, headers) {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403) throw new UsageError('로그인이 만료되었습니다. CLI를 한 번 실행해 다시 로그인하세요.', response.status);
  if (response.status === 429) throw new UsageError('사용량 조회 한도에 걸렸습니다. 잠시 뒤 다시 확인합니다.', 429);
  if (!response.ok) throw new UsageError(`사용량 조회 실패 (HTTP ${response.status})`, response.status);
  return response.json();
}

export const accountVariable = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };

// macOS `ps -E` appends the environment to the arguments, space-joined, so a value runs until the next NAME= token.
export function envFromPs(output, name) {
  const pattern = new RegExp(`(?:^|\\s)${name}=(.*?)(?=\\s[A-Za-z_][A-Za-z0-9_]*=|\\s*$)`, 'g');
  let value = null;
  for (const match of output.matchAll(pattern)) value = match[1];
  return value;
}

const run = (file, args, options = {}) => new Promise(resolve => {
  execFile(file, args, { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout) => resolve(error ? null : stdout));
});

// One variable from a live process: '' when the process runs without it, null when it cannot be read.
export async function processVariable(pid, name, { platform = process.platform, readFile = fs.readFile, exec = run } = {}) {
  if (platform === 'linux') {
    const environ = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => null);
    if (environ === null) return null;
    const entry = environ.split('\0').find(item => item.startsWith(`${name}=`));
    return entry ? entry.slice(name.length + 1) : '';
  }
  if (platform !== 'darwin') return null;
  const output = await exec('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)]);
  return output?.trim() ? envFromPs(output.trim(), name) ?? '' : null;
}

export function findDirenv({ env = process.env, exists = file => fs.access(file).then(() => true, () => false) } = {}) {
  const dirs = [...(env.PATH || '').split(path.delimiter).filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.nix-profile', 'bin')];
  return dirs.reduce((found, dir) => found.then(hit => hit || exists(path.join(dir, 'direnv')).then(ok => ok ? path.join(dir, 'direnv') : null)), Promise.resolve(null));
}

// A project's account is its agent CLI's config folder: the one a running agent in its terminals actually uses,
// else what the project's .envrc sets through direnv, else the server's own environment, which terminals inherit.
export function createAccountResolver({ env = process.env, platform = process.platform, home = os.homedir(), readVariable = processVariable, direnv = findDirenv, exec = run, exists = file => fs.access(file).then(() => true, () => false), now = Date.now } = {}) {
  const loaded = new Map(), seen = new Set();
  let direnvPath;
  const fromDirenv = async (root, name) => {
    if (platform === 'win32') return null;
    const key = `${root}\0${name}`, hit = loaded.get(key);
    if (hit && now() - hit.at < 60_000) return hit.value;
    direnvPath ??= direnv();
    const file = await direnvPath;
    // A blocked or missing .envrc makes direnv fail, which leaves the decision to the next source.
    const value = file ? await exec(file, ['exec', root, '/bin/sh', '-c', `printf %s "\${${name}-}"`], { cwd: root, env: { ...env, DIRENV_LOG_FORMAT: '' } }) : null;
    loaded.set(key, { at: now(), value });
    if (loaded.size > 64) loaded.delete(loaded.keys().next().value);
    return value;
  };
  // macOS hides other processes' environments, but Claude Code leaves <config>/sessions/<pid>.json while it runs.
  const claudeDirOf = async (pid, candidates) => {
    for (const dir of new Set([...candidates, ...seen])) if (await exists(path.join(dir || path.join(home, '.claude'), 'sessions', `${pid}.json`))) return dir;
    return null;
  };
  // The folder one running agent uses: '' for the default, null when it cannot be told.
  const byPid = new Map();
  const agentDir = async (provider, pid, configured) => {
    const name = accountVariable[provider], server = env[name] || '', key = `${provider}:${pid}`;
    // A process keeps its environment for life; a reused PID only lands back here if it runs the same CLI.
    if (byPid.has(key)) return byPid.get(key);
    let dir = await readVariable(pid, name, { platform });
    // An empty read is trusted only where environments are visible; on macOS it may just mean hidden.
    if ((dir === null || (dir === '' && platform === 'darwin')) && provider === 'claude') dir = await claudeDirOf(pid, [configured ?? '', server, '']);
    if (dir) seen.add(dir);
    if (dir !== null) { byPid.set(key, dir); if (byPid.size > 256) byPid.delete(byPid.keys().next().value); }
    return dir;
  };
  const resolve = async (provider, project) => {
    const name = accountVariable[provider], server = env[name] || '';
    if (!project) return { dir: server, from: 'server' };
    const configured = await fromDirenv(project.root, name);
    for (const terminal of project.terminals?.values?.() ?? []) {
      if (terminal.exited || terminal.agent !== provider || !terminal.agentPid) continue;
      const dir = await agentDir(provider, terminal.agentPid, configured);
      if (dir !== null) return { dir, from: 'process' };
    }
    if (configured !== null) return { dir: configured, from: 'direnv' };
    return { dir: server, from: 'server' };
  };
  return Object.assign(resolve, {
    // For per-process files such as Claude's sessions/<pid>.json: the agent's own folder, else what the project would give it.
    async agentFolder(provider, pid, root) {
      const configured = await fromDirenv(root, accountVariable[provider]);
      const dir = await agentDir(provider, pid, configured) ?? configured ?? (env[accountVariable[provider]] || '');
      return dir || path.join(home, provider === 'claude' ? '.claude' : '.codex');
    }
  });
}

export function createUsage({ version = '0.0.0', fetch: fetchImpl = globalThis.fetch, claudeLogin = readClaudeLogin, codexLogin = readCodexLogin, codexLog = readCodexLog, account = async () => ({ dir: '', from: 'server' }), now = Date.now } = {}) {
  const userAgent = `MoonerADE/${version}`;
  const sources = {
    async claude(env) {
      const login = await claudeLogin({ env });
      if (!login) throw new UsageError('Claude Code 로그인 정보를 찾지 못했습니다. claude를 실행해 로그인하세요.');
      if (login.expiresAt && login.expiresAt < now()) throw new UsageError('Claude Code 로그인 토큰이 만료되었습니다. claude를 한 번 실행하면 갱신됩니다.');
      const body = await getJson(fetchImpl, 'https://api.anthropic.com/api/oauth/usage', { Authorization: `Bearer ${login.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': userAgent });
      return { windows: parseClaudeUsage(body), plan: login.plan, source: 'api', at: now() };
    },
    async codex(env) {
      const login = await codexLogin({ env });
      try {
        if (!login) throw new UsageError('Codex ChatGPT 로그인 정보를 찾지 못했습니다.');
        const body = await getJson(fetchImpl, 'https://chatgpt.com/backend-api/wham/usage', { Authorization: `Bearer ${login.token}`, ...(login.account ? { 'ChatGPT-Account-Id': login.account } : {}), 'User-Agent': userAgent });
        return { windows: parseCodexUsage(body, now()), plan: body?.plan_type || '', source: 'api', at: now() };
      } catch (error) {
        const log = await codexLog({ env }).catch(() => null);
        if (!log) throw error;
        return { windows: log.windows, plan: '', source: 'log', at: log.at, note: error.message };
      }
    }
  };
  const cache = new Map();
  return {
    // Keeps the last good reading on failure so a flaky network or a 429 does not blank the indicator.
    // Each account folder has its own reading, so projects on different logins never share one.
    async status(provider, { force = false, project } = {}) {
      if (!providers.includes(provider)) throw fault('INVALID_INPUT', '알 수 없는 사용량 공급자입니다.');
      const { dir, from } = await account(provider, project);
      const key = `${provider}\0${dir}`, entry = cache.get(key) ?? { checked: -Infinity, retryAt: 0, value: null, error: null, pending: null };
      cache.set(key, entry);
      const age = now() - entry.checked;
      const stale = force ? age >= FORCE_GAP : age >= TTL;
      if (stale && now() >= entry.retryAt && !entry.pending) {
        entry.pending = sources[provider](dir ? { [accountVariable[provider]]: dir } : {}).then(value => { entry.value = value; entry.error = null; }, error => {
          entry.error = error.message;
          if (error.status === 429) entry.retryAt = now() + BACKOFF;
        }).finally(() => { entry.checked = now(); entry.pending = null; });
      }
      if (entry.pending) await entry.pending;
      return { provider, ...(entry.value ?? { windows: [], plan: '', source: null, at: 0 }), error: entry.error, checked: entry.checked, account: { dir, from } };
    }
  };
}
