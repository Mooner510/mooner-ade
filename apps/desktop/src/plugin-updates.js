// Plugin updates from a GitHub repository's releases (docs/PLUGINS.md "업데이트"). A plugin names where it comes from in
// plugin.json (`source: { github: 'owner/repo', asset: 'name.zip' }`); MoonerADE checks that repository's releases, takes
// the newest release that carries the asset, and checks every file it takes against the release's SHA256SUMS and/or the
// digest GitHub reports for the asset. Only GitHub releases: a plain download link is not a source.
//
// Credentials, in this order: the GitHub account connected in MoonerADE (a token sealed in plugins.bin, from a personal
// access token or a device-flow sign-in), then this PC's own `gh auth token` / `git credential fill` (never prompting), then
// none (public repositories). A token is only ever sent to the GitHub API, never to the signed storage link an asset
// redirects to, never logged, never shown and never handed to a plugin.
//
// Kept free of Electron: `fetchImpl` and `run` are injectable for tests.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_WEB = 'https://github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'MoonerADE-plugin-updates';
export const MAX_ASSET = 32 * 1024 * 1024;
export const UPDATE_MODES = ['auto', 'notify', 'manual'];
export const DEFAULT_UPDATE_MODE = 'notify';
export const FIRST_CHECK_MS = 60_000;
export const CHECK_EVERY_MS = 6 * 60 * 60_000;
// A GitHub App or OAuth App (device flow enabled) that MoonerADE signs in with. Without one, a personal access token
// connects the account instead. ADE_GITHUB_CLIENT_ID overrides it (a client id is public, not a secret).
export const GITHUB_CLIENT_ID = '';
export const githubClientId = (env = process.env) => (/^[\w.-]{8,64}$/.test(env.ADE_GITHUB_CLIENT_ID ?? '') ? env.ADE_GITHUB_CLIENT_ID : GITHUB_CLIENT_ID) || null;

const fail = (message, code = 'UPDATE_FAILED') => Object.assign(new Error(message), { code });

// ---- versions --------------------------------------------------------------------------------------------------------
// "0.3.0", "v0.3.0", "plugin-v0.3.0", "plugin/0.3.0" -> { parts: [0, 3, 0], pre: '' }; anything else -> null.
export function parseVersion(text) {
  const match = /(?:^|[\s/v-])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(String(text ?? '').trim());
  return match ? { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? '' } : null;
}
export const versionText = text => { const value = parseVersion(text); return value ? `${value.parts.join('.')}${value.pre ? `-${value.pre}` : ''}` : null; };
// Semver order: numbers first, then a pre-release sorts before the release itself. Unparsable sorts lowest.
export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let index = 0; index < 3; index++) if (left.parts[index] !== right.parts[index]) return left.parts[index] > right.parts[index] ? 1 : -1;
  if (left.pre === right.pre) return 0;
  if (!left.pre || !right.pre) return left.pre ? -1 : 1;
  const x = left.pre.split('.'), y = right.pre.split('.');
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    if (x[index] === undefined || y[index] === undefined) return x[index] === undefined ? -1 : 1;
    if (x[index] === y[index]) continue;
    const nx = /^\d+$/.test(x[index]), ny = /^\d+$/.test(y[index]);
    if (nx && ny) return Number(x[index]) > Number(y[index]) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x[index] > y[index] ? 1 : -1;
  }
  return 0;
}
export const isNewer = (latest, current) => Boolean(parseVersion(latest)) && compareVersions(latest, current) > 0;

// ---- plugin.json `source` --------------------------------------------------------------------------------------------
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
// The asset's file name; `{version}` stands for the version when every release names the zip after it.
const ASSET = /^(?:[\w.+-]|\{version\}){1,100}$/;
export function validSource(value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('source 항목이 올바르지 않습니다.', 'PLUGIN_INVALID');
  const repo = typeof value.github === 'string' ? value.github.trim() : '';
  if (!REPO.test(repo) || /\/\.{1,2}$/.test(repo)) throw fail('source.github는 "소유자/저장소" 모양이어야 합니다.', 'PLUGIN_INVALID');
  const asset = value.asset === undefined ? `${id}.zip` : value.asset;
  if (typeof asset !== 'string' || !ASSET.test(asset) || !asset.endsWith('.zip') || asset.startsWith('.')) throw fail('source.asset은 .zip 파일 이름이어야 합니다.', 'PLUGIN_INVALID');
  return { github: repo, asset };
}
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Which asset of a release is the plugin, and the version its name carries when the name has `{version}`.
export function matchAsset(template, name) {
  if (!template.includes('{version}')) return name === template ? { version: null } : null;
  const pattern = new RegExp(`^${template.split('{version}').map(escapeRegex).join('(v?\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)')}$`);
  const match = pattern.exec(name);
  return match ? { version: versionText(match[1]) } : null;
}

// ---- credentials -----------------------------------------------------------------------------------------------------
// Runs a command without a shell or a window; resolves { code, stdout } (stdout capped), never rejects.
export function runCommand(command, args, { input = null, env = process.env, timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { resolve({ code: -1, stdout: '' }); return; }
    let stdout = '', done = false;
    const finish = code => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout }); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(-1); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (stdout.length < 64 * 1024) stdout += chunk; });
    child.on('error', () => finish(-1));
    child.on('close', code => finish(code ?? -1));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}
export const plausibleToken = value => typeof value === 'string' && /^[\x21-\x7e]{20,255}$/.test(value);

// This PC's own GitHub login: `gh auth token`, else what git's credential helper has for github.com. Never prompts (no
// terminal prompt, no credential manager window, no askpass). Resolves { token, via: 'gh'|'git' } or null.
export async function machineToken({ run = runCommand, env = process.env } = {}) {
  const gh = await run('gh', ['auth', 'token', '-h', 'github.com'], { timeoutMs: 5000 });
  const fromGh = gh.code === 0 ? gh.stdout.trim() : '';
  if (plausibleToken(fromGh)) return { token: fromGh, via: 'gh' };
  const quiet = { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };
  const git = await run('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', env: quiet, timeoutMs: 10_000 });
  if (git.code === 0) {
    const password = git.stdout.split(/\r?\n/).find(line => line.startsWith('password='))?.slice('password='.length).trim();
    if (plausibleToken(password)) return { token: password, via: 'git' };
  }
  return null;
}

// ---- releases --------------------------------------------------------------------------------------------------------
export function parseSums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) [ *]?(\S.*)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}
export const sha256 = data => createHash('sha256').update(data).digest('hex');
const digestOf = asset => (/^sha256:([a-f0-9]{64})$/.exec(String(asset?.digest ?? '')) ?? [])[1] ?? null;
const VIA_LABEL = { ade: 'MoonerADE에 연결한 GitHub 계정', gh: '이 PC의 gh 로그인', git: '이 PC의 git 로그인' };
export const credentialLabel = via => VIA_LABEL[via] ?? '로그인 없이';

// credential() resolves { token, via } or null (then requests go without Authorization: public repositories only).
// `api` and `web` are replaceable for tests (a fake GitHub on this machine).
export function createGithub({ api = GITHUB_API, web = GITHUB_WEB, credential = async () => null, fetchImpl = globalThis.fetch, timeoutMs = 30_000, downloadTimeoutMs = 5 * 60_000 } = {}) {
  const base = String(api).replace(/\/+$/, ''), webBase = String(web).replace(/\/+$/, '');
  const local = url => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(new URL(url).origin);
  const headers = auth => ({ ...(auth && { Authorization: `Bearer ${auth}` }), 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': USER_AGENT });
  async function request(url, init, what) {
    try { return await fetchImpl(url, init); }
    catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw fail(`GitHub가 제때 응답하지 않아 ${what}하지 못했습니다.`, 'TIMEOUT');
      throw fail(`GitHub에 연결할 수 없어 ${what}하지 못했습니다. 인터넷 연결을 확인하세요.`, 'NETWORK');
    }
  }
  function statusError(response, what, via, repo) {
    if (response.status === 401) return fail(`${credentialLabel(via)}이 만료되었거나 올바르지 않아 ${what}하지 못했습니다. 설정 → 플러그인 → GitHub 연결을 확인하세요.`, 'UNAUTHORIZED');
    if (response.status === 403 || response.status === 429) {
      const limited = response.headers.get('x-ratelimit-remaining') === '0';
      return fail(limited ? `GitHub 요청 한도를 넘었습니다. ${via ? '잠시 뒤' : 'GitHub 계정을 연결하거나 잠시 뒤'} 다시 시도하세요.` : `GitHub가 요청을 거절했습니다(권한 없음). ${what}하지 못했습니다.`, 'FORBIDDEN');
    }
    if (response.status === 404) return via
      ? fail(`${repo ?? '저장소'}를 찾지 못했습니다. ${credentialLabel(via)}에 이 저장소를 볼 권한이 있는지 확인하세요.`, 'NOT_FOUND')
      : fail(`${repo ?? '저장소'}를 찾지 못했습니다. 비공개 저장소라면 설정 → 플러그인 → GitHub 연결에서 계정을 연결하세요.`, 'NOT_FOUND');
    return fail(`GitHub에서 ${what}하지 못했습니다 (HTTP ${response.status}).`, 'HTTP');
  }
  async function readBody(response, name, max = MAX_ASSET) {
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > max) throw fail(`${name}이(가) 너무 큽니다.`, 'TOO_LARGE');
    const parts = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > max) throw fail(`${name}이(가) 너무 큽니다.`, 'TOO_LARGE');
      parts.push(Buffer.from(chunk));
    }
    return Buffer.concat(parts);
  }
  async function json(url, auth, what, via, repo) {
    const response = await request(url, { headers: { ...headers(auth), Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(timeoutMs) }, what);
    if (!response.ok) throw statusError(response, what, via, repo);
    try { return JSON.parse((await readBody(response, 'GitHub 응답', 4 * 1024 * 1024)).toString('utf8')); }
    catch (error) { if (error.code) throw error; throw fail('GitHub의 응답이 올바르지 않습니다.', 'HTTP'); }
  }
  // The asset through the API, then its storage address WITHOUT the Authorization header (a signed link elsewhere).
  async function fetchAsset(repo, asset, auth, via, max = MAX_ASSET) {
    const what = '파일을 받지';
    let url = `${base}/repos/${repo}/releases/assets/${asset.id}`;
    let response = await request(url, { headers: { ...headers(auth), Accept: 'application/octet-stream' }, redirect: 'manual', signal: AbortSignal.timeout(downloadTimeoutMs) }, what);
    for (let hops = 0; response.status >= 300 && response.status < 400; hops++) {
      const location = response.headers.get('location');
      if (!location || hops >= 3) throw fail('GitHub가 파일 위치를 알려 주지 않았습니다.', 'HTTP');
      const next = new URL(location, url);
      if (next.protocol !== 'https:' && !(local(base) && next.origin === new URL(base).origin)) throw fail('GitHub가 안전하지 않은 주소로 보냈습니다.', 'HTTP');
      await response.body?.cancel().catch(() => {});
      url = next.href;
      response = await request(url, { headers: { Accept: 'application/octet-stream', 'User-Agent': USER_AGENT }, redirect: 'manual', signal: AbortSignal.timeout(downloadTimeoutMs) }, what);
    }
    if (!response.ok) throw statusError(response, what, via, repo);
    return readBody(response, asset.name, max);
  }
  const cleanAsset = item => ({ id: item.id, name: item.name, size: Number(item.size) || 0, digest: item.digest ?? null });

  return {
    // The newest release (not a draft or pre-release) of source.github that carries the plugin's asset:
    // { repo, tag, version, asset, sha256, sums: {name: sha256}, via }. `version` comes from the release's versions.json
    // (plugin id -> version, for a repository that releases several plugins together), else the asset name's {version},
    // else the tag. Throws when no release has it, or when it has no checksum to check the download against.
    async latest(source, id) {
      const found = await credential(), auth = found?.token ?? null, via = found?.via ?? null, repo = source.github;
      const releases = await json(`${base}/repos/${repo}/releases?per_page=30`, auth, '업데이트를 확인', via, repo);
      if (!Array.isArray(releases)) throw fail('GitHub의 응답이 올바르지 않습니다.', 'HTTP');
      for (const release of releases) {
        if (!release || release.draft || release.prerelease) continue;
        const assets = (Array.isArray(release.assets) ? release.assets : []).filter(item => item && Number.isSafeInteger(item.id) && typeof item.name === 'string').map(cleanAsset);
        let asset = null, named = null;
        for (const item of assets) { const match = matchAsset(source.asset, item.name); if (match) { asset = item; named = match.version; break; } }
        if (!asset) continue;
        const tag = String(release.tag_name ?? '').slice(0, 100);
        const sumsAsset = assets.find(item => item.name === 'SHA256SUMS');
        let sums = new Map();
        if (sumsAsset) {
          const data = await fetchAsset(repo, sumsAsset, auth, via, 1024 * 1024);
          if (digestOf(sumsAsset) && digestOf(sumsAsset) !== sha256(data)) throw fail(`${repo}의 SHA256SUMS가 손상되었습니다.`, 'CHECKSUM');
          sums = parseSums(data.toString('utf8'));
        }
        let version = null;
        const versionsAsset = assets.find(item => item.name === 'versions.json');
        if (versionsAsset) {
          const data = await fetchAsset(repo, versionsAsset, auth, via, 256 * 1024), actual = sha256(data);
          const expected = sums.get('versions.json') ?? digestOf(versionsAsset);
          if (!expected || expected !== actual) throw fail(`${repo}의 versions.json을 확인할 수 없습니다(SHA256SUMS와 맞지 않음).`, 'CHECKSUM');
          let versions;
          try { versions = JSON.parse(data.toString('utf8')); } catch { throw fail(`${repo}의 versions.json이 올바르지 않습니다.`, 'HTTP'); }
          if (typeof versions?.[id] === 'string') version = versionText(versions[id]);
        }
        version ??= named ?? versionText(tag);
        if (!version) throw fail(`${repo}의 릴리스 ${tag || '(태그 없음)'}에서 플러그인 버전을 알 수 없습니다.`, 'NO_VERSION');
        const expected = sums.get(asset.name) ?? null, digest = digestOf(asset);
        if (!expected && !digest) throw fail(`${repo}의 릴리스 ${tag}에 ${asset.name}의 체크섬(SHA256SUMS)이 없어 받지 않습니다.`, 'NO_CHECKSUM');
        if (expected && digest && expected !== digest) throw fail(`${asset.name}의 SHA256SUMS와 GitHub의 체크섬이 다릅니다. 받지 않습니다.`, 'CHECKSUM');
        return { repo, tag, version, asset, sha256: expected ?? digest, via };
      }
      throw fail(`${repo}의 릴리스에서 ${source.asset}을(를) 찾지 못했습니다.`, 'MISSING');
    },
    // The asset of latest(), checked against the checksum latest() found: { data, sha256 }.
    async download(found) {
      const credentialNow = await credential();
      const data = await fetchAsset(found.repo, found.asset, credentialNow?.token ?? null, credentialNow?.via ?? null);
      const actual = sha256(data);
      if (actual !== found.sha256 || (digestOf(found.asset) && digestOf(found.asset) !== actual)) throw fail(`받은 ${found.asset.name}이(가) 릴리스의 체크섬과 맞지 않습니다. 설치하지 않았습니다.`, 'CHECKSUM');
      return { data, sha256: actual };
    },
    // The account a token belongs to: { login }.
    async whoami(token) {
      if (!plausibleToken(token)) throw fail('토큰 모양이 올바르지 않습니다.', 'INVALID_TOKEN');
      const response = await request(`${base}/user`, { headers: { ...headers(token), Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(timeoutMs) }, '계정을 확인');
      if (response.status === 401) throw fail('GitHub가 이 토큰을 받지 않았습니다. 만료되었거나 잘못 붙여 넣었는지 확인하세요.', 'UNAUTHORIZED');
      if (!response.ok) throw statusError(response, '계정을 확인', 'ade');
      let body;
      try { body = JSON.parse((await readBody(response, 'GitHub 응답', 1024 * 1024)).toString('utf8')); } catch { throw fail('GitHub의 응답이 올바르지 않습니다.', 'HTTP'); }
      const login = typeof body?.login === 'string' && /^[A-Za-z0-9-]{1,39}(\[bot\])?$/.test(body.login) ? body.login : null;
      if (!login) throw fail('GitHub 계정 이름을 받지 못했습니다.', 'HTTP');
      return { login };
    },
    // Device flow (GitHub App or OAuth App with device flow enabled): { deviceCode, userCode, verifyUrl, interval, expiresAt }.
    async deviceStart(clientId) {
      const response = await request(`${webBase}/login/device/code`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }, body: JSON.stringify({ client_id: clientId, scope: 'repo' }), signal: AbortSignal.timeout(timeoutMs) }, '로그인을 시작');
      if (!response.ok) throw fail(`GitHub 로그인을 시작하지 못했습니다 (HTTP ${response.status}).`, 'HTTP');
      const body = await response.json().catch(() => null);
      const verifyUrl = typeof body?.verification_uri === 'string' && /^https:\/\/github\.com\//.test(body.verification_uri) ? body.verification_uri : null;
      if (typeof body?.device_code !== 'string' || typeof body?.user_code !== 'string' || !verifyUrl) throw fail('GitHub 로그인 응답이 올바르지 않습니다.', 'HTTP');
      return { deviceCode: body.device_code, userCode: body.user_code.slice(0, 20), verifyUrl, interval: Math.max(5, Number(body.interval) || 5), expiresAt: Date.now() + Math.min(900, Number(body.expires_in) || 900) * 1000 };
    },
    // One poll: { token } once the user approved, { wait: seconds } while pending; throws when denied or expired.
    async devicePoll(clientId, deviceCode) {
      const response = await request(`${webBase}/login/oauth/access_token`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }, body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }), signal: AbortSignal.timeout(timeoutMs) }, '로그인을 확인');
      const body = await response.json().catch(() => null);
      if (plausibleToken(body?.access_token)) return { token: body.access_token };
      if (body?.error === 'authorization_pending') return { wait: 0 };
      if (body?.error === 'slow_down') return { wait: 5 };
      if (body?.error === 'access_denied') throw fail('GitHub 로그인을 거절했습니다.', 'DENIED');
      if (body?.error === 'expired_token') throw fail('로그인 시간이 지났습니다. 다시 시도하세요.', 'EXPIRED');
      throw fail(`GitHub 로그인을 마치지 못했습니다${body?.error ? ` (${String(body.error).slice(0, 40)})` : ''}.`, 'HTTP');
    }
  };
}
