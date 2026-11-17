// MoonerADE Hub as a place plugins come from (docs/PLUGINS.md "Hub 마켓"). The Hub lists the plugins it serves to signed-in
// accounts, MoonerADE installs one the way it installs a zip (plugin-core.js), and checks the Hub for newer versions of the
// ones whose plugin.json says `source.hub`.
//
// The app signs in to the Hub as its own device (kind `app`): the browser opens the Hub's page, the user approves the code
// shown in MoonerADE, and the Hub hands over an access token (1 hour) and a refresh token (30 days, rotated at every use).
// The session is sealed in plugins.bin next to the GitHub token (plugin-core.js createPluginStore). A token is only ever sent
// to the Hub's own address, which is the app's setting (ADE_HUB_URL), never something a plugin names; redirects are not
// followed; the tokens are never logged, shown or given to a plugin.
//
// `latest` and `download` resolve what plugin-updates.js createGithub resolves, so the update code treats both the same way.
// Kept free of Electron: `fetchImpl` and `now` are injectable for tests.
import { createHash } from 'node:crypto';
import os from 'node:os';
import { MAX_ASSET, readBody, sha256, versionText } from './plugin-updates.js';

export const DEFAULT_HUB_URL = 'https://ade-hub.mooner510.kr';
const USER_AGENT = 'MoonerADE-hub';
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
// Refresh this long before the access token runs out.
export const REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_JSON = 2 * 1024 * 1024;
const MAX_PLUGINS = 100;

const fail = (message, code = 'HUB_FAILED') => Object.assign(new Error(message), { code });
const isLocal = origin => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
// Hub JSON is data, not trusted: every field is checked to be the shape the page and the installer expect.
const GRANTS = ['terminal', 'mcp', 'workspace', 'feedback', 'header'];
export function validEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const version = versionText(value.version);
  if (typeof value.id !== 'string' || !PLUGIN_ID.test(value.id) || !version) return null;
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) return null;
  const grants = Object.fromEntries(GRANTS.map(key => [key, value.grants?.[key] === true]));
  return {
    id: value.id, version, sha256: value.sha256, name: text(value.name, 60) || value.id, description: text(value.description, 300),
    size: Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : 0, grants,
    publishedAt: Number.isFinite(value.publishedAt) ? value.publishedAt : null
  };
}

// The name this PC has in the account's device list.
const deviceName = () => `ADE · ${String(os.hostname() || 'PC').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40).trim() || 'PC'}`;
// The same for this user on this PC every time (a hash of the host and user name, not a secret). The Hub replaces an earlier device of
// the account that has the same key, so signing in again does not leave another copy in the account's device list.
const deviceKey = () => {
  let user = '';
  try { user = os.userInfo().username; } catch { /* no user information here */ }
  return createHash('sha256').update(`mooner-ade-app\0${os.hostname()}\0${user}`).digest('base64');
};

// `store` is plugin-core.js createPluginStore: `store.state.hub` is { account, at } (not secret) with a non-enumerable `secret`
// ({ access, refresh, accessExpiresAt, deviceId }, which opens the sealed file), and update() seals what is written.
export function createHubClient({ store, baseUrl = process.env.ADE_HUB_URL || DEFAULT_HUB_URL, fetchImpl = globalThis.fetch, now = Date.now, name = deviceName, key = deviceKey, platform = process.platform, timeoutMs = 30_000, downloadTimeoutMs = 5 * 60_000, refreshMarginMs = REFRESH_MARGIN_MS } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { base = null; }
  if (base && base.protocol !== 'https:' && !isLocal(base.origin)) base = null;
  const origin = base?.origin ?? null;
  const unavailable = () => fail('MoonerADE Hub 주소가 올바르지 않습니다(https 주소여야 합니다).', 'HUB_UNAVAILABLE');

  async function request(path, { method = 'GET', body, token = null, accept = 'application/json', timeout = timeoutMs, what = '요청' } = {}) {
    if (!origin) throw unavailable();
    const headers = { Accept: accept, 'User-Agent': USER_AGENT, ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) };
    let response;
    try { response = await fetchImpl(new URL(path, origin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeout) }); }
    catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw fail(`MoonerADE Hub가 제때 응답하지 않아 ${what}하지 못했습니다.`, 'TIMEOUT');
      throw fail(`MoonerADE Hub에 연결할 수 없어 ${what}하지 못했습니다. 인터넷 연결을 확인하세요.`, 'NETWORK');
    }
    // The Hub answers directly; a redirect would carry the token somewhere else.
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); throw fail('MoonerADE Hub가 예상하지 못한 주소로 보내 요청을 중단했습니다.', 'HTTP'); }
    return response;
  }
  // { code, message } of the Hub's error body (`{"error":{"code","message"}}`), codes with dashes and underscores alike.
  async function errorOf(response) {
    try {
      const body = JSON.parse((await readBody(response, 'Hub 응답', 64 * 1024)).toString('utf8'));
      return { code: typeof body?.error?.code === 'string' ? body.error.code.replace(/_/g, '-').slice(0, 40) : '', message: text(body?.error?.message, 300) };
    } catch { return { code: '', message: '' }; }
  }
  async function readJson(response, what) {
    try { return JSON.parse((await readBody(response, `Hub ${what}`, MAX_JSON)).toString('utf8')); }
    catch (error) { if (error.code) throw error; throw fail(`MoonerADE Hub의 ${what} 응답이 올바르지 않습니다.`, 'HTTP'); }
  }
  async function statusError(response, what) {
    const { code, message } = await errorOf(response);
    if (response.status === 401) return fail('MoonerADE Hub 로그인이 끝났습니다. 다시 로그인하세요.', 'UNAUTHORIZED');
    if (response.status === 403) return fail('이 계정은 MoonerADE Hub를 쓸 수 없습니다. 계정 권한을 확인하세요.', 'FORBIDDEN');
    if (response.status === 404) return fail(message || `MoonerADE Hub에서 ${what}을(를) 찾지 못했습니다.`, 'NOT_FOUND');
    if (response.status === 429) return fail('MoonerADE Hub 요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.', 'RATE_LIMITED');
    if (code === 'plugins-disabled') return fail('이 MoonerADE Hub는 플러그인을 제공하지 않습니다.', 'HUB_DISABLED');
    if (code === 'plugins-unavailable') return fail('MoonerADE Hub가 플러그인 목록을 아직 준비하지 못했습니다. 잠시 뒤 다시 시도하세요.', 'HUB_BUSY');
    if (code === 'auth-unavailable') return fail('MoonerADE Hub가 계정 서버(Authentik)에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.', 'HUB_BUSY');
    return fail(`MoonerADE Hub에서 ${what}하지 못했습니다 (HTTP ${response.status}).`, 'HTTP');
  }

  // ---- the session -----------------------------------------------------------------------------------------------------
  // null when signed out. A session whose sealed half cannot be read (plugins.bin lost) is signed out too, and forgotten.
  function session() {
    const meta = store.state.hub;
    if (!meta) return null;
    const secret = meta.secret;
    if (secret?.access && secret.refresh) return { ...meta, ...secret };
    try { store.update(state => ({ ...state, hub: null })); } catch { /* no encryption: nothing to forget */ }
    return null;
  }
  const save = next => store.update(state => ({ ...state, hub: next }));
  const signedOut = () => fail('MoonerADE Hub에 로그인하지 않았습니다. 설정 → 플러그인 → 마켓에서 로그인하세요.', 'NOT_SIGNED_IN');

  let refreshing = null;
  // One refresh at a time, and the rotated refresh token is sealed before anything uses the new access token: the Hub revokes a
  // device that sends an old refresh token again after a short grace period.
  function refresh() {
    refreshing ??= (async () => {
      const current = session();
      if (!current) throw signedOut();
      let response;
      for (let attempt = 0; ; attempt++) {
        try { response = await request('/v1/token/refresh', { method: 'POST', body: { refreshToken: current.refresh }, what: '로그인을 갱신' }); break; }
        catch (error) { if (error.code !== 'NETWORK' || attempt >= 1) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        try { save(null); } catch { /* nothing sealed */ }
        throw fail(response.status === 403 ? '이 계정은 MoonerADE Hub를 쓸 수 없어 로그아웃했습니다.' : 'MoonerADE Hub 로그인이 끝나 로그아웃했습니다. 다시 로그인하세요.', 'UNAUTHORIZED');
      }
      if (!response.ok) throw await statusError(response, '로그인을 갱신');
      const body = await readJson(response, '로그인');
      const ok = typeof body?.accessToken === 'string' && typeof body.refreshToken === 'string' && Number.isFinite(body.accessExpiresIn) && body.accessExpiresIn > 0;
      if (!ok) throw fail('MoonerADE Hub의 로그인 응답이 올바르지 않습니다.', 'HTTP');
      const next = { account: current.account, at: current.at, deviceId: current.deviceId, access: body.accessToken, refresh: body.refreshToken, accessExpiresAt: now() + body.accessExpiresIn * 1000 };
      save(next);
      return next;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function accessToken() {
    const current = session();
    if (!current) throw signedOut();
    return current.accessExpiresAt - now() > refreshMarginMs ? current.access : (await refresh()).access;
  }
  // A call with the access token; a 401 refreshes once and retries (the token may have been revoked or aged out early).
  async function authed(path, options) {
    let response = await request(path, { ...options, token: await accessToken() });
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      response = await request(path, { ...options, token: (await refresh()).access });
    }
    if (response.status === 403) {
      // The account lost its access: the Hub revoked this device with it.
      const { code } = await errorOf(response);
      if (code === 'access-denied') { try { save(null); } catch { /* nothing sealed */ } }
      throw fail('이 계정은 MoonerADE Hub를 쓸 수 없습니다. 계정 권한을 확인하세요.', 'FORBIDDEN');
    }
    return response;
  }

  return {
    get available() { return Boolean(origin); },
    get url() { return origin; },
    get host() { return base?.host ?? null; },
    get signedIn() { return Boolean(store.state.hub); },
    get account() { return store.state.hub?.account ?? null; },

    // ---- signing in (device code) -------------------------------------------------------------------------------------
    // The browser page to open and the code to show: { enrollId, pollToken, userCode, verifyUrl, interval, expiresAt }.
    async deviceStart() {
      const response = await request('/v1/enroll/start', { method: 'POST', body: { kind: 'app', name: name(), platform: String(platform).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32) || 'unknown', key: key() }, what: '로그인을 시작' });
      if (!response.ok) throw await statusError(response, '로그인을 시작');
      const body = await readJson(response, '로그인');
      let verify = null;
      try { verify = new URL(body?.verifyUrl); } catch { /* checked below */ }
      // Only the Hub's own page: the code is approved there.
      if (typeof body?.enrollId !== 'string' || typeof body.pollToken !== 'string' || typeof body.userCode !== 'string' || verify?.origin !== origin) throw fail('MoonerADE Hub의 로그인 응답이 올바르지 않습니다.', 'HTTP');
      return { enrollId: body.enrollId, pollToken: body.pollToken, userCode: body.userCode.slice(0, 20), verifyUrl: verify.href, interval: Math.max(2, Number(body.interval) || 5), expiresAt: now() + Math.min(900, Number(body.expiresIn) || 600) * 1000 };
    },
    // One poll: { account } once approved (the session is sealed), { wait: seconds } while pending; throws when denied or expired.
    async devicePoll({ enrollId, pollToken }) {
      const response = await request('/v1/enroll/poll', { method: 'POST', body: { enrollId, pollToken }, what: '로그인을 확인' });
      if (response.status === 429) { await response.body?.cancel().catch(() => {}); return { wait: 5 }; }
      if (response.status === 410) { await response.body?.cancel().catch(() => {}); throw fail('로그인이 거부되었거나 시간이 지났습니다. 다시 시도하세요.', 'DENIED'); }
      if (!response.ok) throw await statusError(response, '로그인을 확인');
      const body = await readJson(response, '로그인');
      if (body?.status === 'pending') return { wait: 0 };
      const deviceId = typeof body?.device?.id === 'string' && /^[\w.-]{1,64}$/.test(body.device.id) ? body.device.id : null;
      const ok = body?.status === 'approved' && deviceId && typeof body.accessToken === 'string' && typeof body.refreshToken === 'string' && Number.isFinite(body.accessExpiresIn) && body.accessExpiresIn > 0;
      if (!ok) throw fail('MoonerADE Hub의 로그인 응답이 올바르지 않습니다.', 'HTTP');
      const account = text(body.account?.name, 100).trim() || text(body.account?.email, 100).trim() || '계정';
      save({ account, at: now(), deviceId, access: body.accessToken, refresh: body.refreshToken, accessExpiresAt: now() + body.accessExpiresIn * 1000 });
      return { account };
    },
    // Ends the session: the Hub is told to drop this device (best effort), the sealed tokens are always removed.
    async signOut() {
      const current = session();
      if (current) {
        try { const response = await request('/v1/me', { method: 'DELETE', token: current.access, timeout: 10_000, what: '로그아웃' }); await response.body?.cancel().catch(() => {}); } catch { /* the device stays on the account's list until it is removed there */ }
      }
      save(null);
    },

    // ---- plugins ------------------------------------------------------------------------------------------------------
    // Everything the Hub serves this account: { plugins: [entry], checkedAt }.
    async catalog() {
      const response = await authed('/v1/plugins', { what: '플러그인 목록을 받지' });
      if (!response.ok) throw await statusError(response, '플러그인 목록을 받지');
      const body = await readJson(response, '플러그인 목록');
      if (!Array.isArray(body?.plugins)) throw fail('MoonerADE Hub의 플러그인 목록이 올바르지 않습니다.', 'HTTP');
      return { plugins: body.plugins.slice(0, MAX_PLUGINS).map(validEntry).filter(Boolean), checkedAt: now() };
    },
    // The same call plugin-updates.js createGithub().latest makes: what the Hub has now for plugin `id`.
    async latest(_source, id) {
      if (!PLUGIN_ID.test(String(id))) throw fail('플러그인 id가 올바르지 않습니다.', 'NOT_FOUND');
      const response = await authed(`/v1/plugins/${id}`, { what: '업데이트를 확인' });
      if (response.status === 404) { await response.body?.cancel().catch(() => {}); throw fail(`MoonerADE Hub에 ${id} 플러그인이 없습니다.`, 'MISSING'); }
      if (!response.ok) throw await statusError(response, '업데이트를 확인');
      const entry = validEntry(await readJson(response, '플러그인 정보'));
      if (!entry || entry.id !== id) throw fail('MoonerADE Hub의 플러그인 정보가 올바르지 않습니다.', 'HTTP');
      return { ...entry, via: 'hub', asset: { name: `${id}-${entry.version}.zip` } };
    },
    // The zip `latest` found, checked against the checksum the Hub listed: { data, sha256 }.
    async download(found) {
      if (!found || !PLUGIN_ID.test(String(found.id))) throw fail('받을 플러그인이 올바르지 않습니다.', 'NOT_FOUND');
      const response = await authed(`/v1/plugins/${found.id}/download`, { accept: 'application/zip', timeout: downloadTimeoutMs, what: '파일을 받지' });
      if (!response.ok) throw await statusError(response, '파일을 받지');
      // Published again between the check and the download: ask again instead of installing something nobody looked at.
      if (response.headers.get('x-plugin-version') !== found.version || response.headers.get('x-plugin-sha256') !== found.sha256) {
        await response.body?.cancel().catch(() => {});
        throw fail('그 사이 MoonerADE Hub의 플러그인이 새로 올라왔습니다. 목록을 새로고침하고 다시 시도하세요.', 'CHANGED');
      }
      const data = await readBody(response, `${found.id}.zip`, MAX_ASSET), actual = sha256(data);
      if (actual !== found.sha256) throw fail(`받은 ${found.id}.zip이 MoonerADE Hub가 알려 준 체크섬과 맞지 않습니다. 설치하지 않았습니다.`, 'CHECKSUM');
      return { data, sha256: actual };
    }
  };
}
