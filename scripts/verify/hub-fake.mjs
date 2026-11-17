// A fake MoonerADE Hub for the plugin market (docs/PLUGINS.md "Hub 마켓"): enrolling the app (device code), token refresh with rotation,
// the plugin list, the download and sign-out. Used by tests/hub-client.test.mjs and tests/hub-market.test.mjs, and (through
// scripts/verify/lib.mjs fakeHub) by the isolated browser session. It speaks the same JSON as the real Hub, nothing more.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import zlib from 'node:zlib';

export const sha256 = data => createHash('sha256').update(data).digest('hex');

// A stored (uncompressed) zip from { 'folder/file': text|Buffer }; bsdtar and the plugin installer read it.
export function zipBuffer(files) {
  const locals = [], centrals = [], entries = Object.entries(files);
  let offset = 0;
  for (const [entryName, content] of entries) {
    const name = Buffer.from(entryName), data = Buffer.from(content), crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// A small plugin that runs: it reports ready and a status line with its version.
export function demoPluginZip({ id = 'hub-demo', name = 'Hub 데모', version = '1.0.0', description = 'Hub에서 받은 시험용 플러그인입니다.', ...manifest } = {}) {
  const host = `process.send({ type: 'ready' });\nprocess.send({ type: 'view', view: { status: { tone: 'ok', text: '${id} ${version} 실행 중' } } });\nprocess.on('message', message => { if (message.type === 'shutdown') process.exit(0); });\n`;
  return zipBuffer({ [`${id}/plugin.json`]: JSON.stringify({ id, name, version, apiVersion: 1, description, main: 'host.js', source: { hub: true }, ...manifest }), [`${id}/host.js`]: host });
}

const token = prefix => `${prefix}${randomBytes(18).toString('base64url')}`;

// `plugins` are added with hub.publish({ id, version, name, description, grants, zip }); the zip is whatever bytes the test wants served.
export function createHubRoutes() {
  const hub = {
    requests: [], plugins: new Map(), enrolls: new Map(),
    account: { id: 'acc-1', name: '시험 계정', email: 'tester@example.invalid' },
    // 'auto': the first poll after the enroll is approved; 'manual': approve(); 'deny': the enroll is refused.
    approval: 'auto', accessTtl: 3600, access: null, refresh: null, deviceId: null, refreshCalls: 0, signedOut: 0,
    // 403 access-denied on API calls (the account lost its access), 503 on the plugin list (the Hub has none ready yet).
    denied: false, unavailable: false, disabled: false,
    publish({ id, version, name = id, description = '', grants = {}, zip }) {
      const bytes = zip ?? demoPluginZip({ id, name, version, description });
      hub.plugins.set(id, { id, version, name, description, grants, zip: bytes, sha256: sha256(bytes), size: bytes.length, publishedAt: Date.now() });
    },
    // The next call with the current access token is told it ran out; the refresh token still works.
    expireAccess() { hub.access = null; },
    // Every token is dead: the refresh token is refused too.
    revokeAll() { hub.access = null; hub.refresh = null; },
    approve() { for (const enroll of hub.enrolls.values()) enroll.approved = true; }
  };
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const error = (res, status, code, message = code) => send(res, status, { error: { code, message } });
  const entry = plugin => ({ id: plugin.id, name: plugin.name, version: plugin.version, description: plugin.description, size: plugin.size, sha256: plugin.sha256, grants: { terminal: false, mcp: false, workspace: false, feedback: false, header: false, ...plugin.grants }, publishedAt: plugin.publishedAt });
  const issue = () => { hub.access = token('aha_'); hub.refresh = token('ahr_'); return { accessToken: hub.access, refreshToken: hub.refresh, accessExpiresIn: hub.accessTtl }; };

  // Resolves true when the request was one of the Hub's plugin-market routes (and answered). `/__test/*` is how a script in another
  // process drives this fake (the real Hub has nothing like it): POST /__test/publish { id, version, name?, description?, grants? }
  // (a small plugin that runs), POST /__test/state { approval?, denied?, unavailable?, disabled?, expireAccess?, revokeAll? },
  // GET /__test/requests.
  hub.handle = async (req, res) => {
    const url = new URL(req.url, 'http://hub.invalid'), path = url.pathname;
    if (!/^\/(v1\/(enroll|token|plugins|me)|__test)(\/|$)/.test(path)) return false;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* not JSON */ }
    const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '') || null;
    if (path.startsWith('/__test/')) {
      if (req.method === 'GET' && path === '/__test/requests') return send(res, 200, { requests: hub.requests, refreshCalls: hub.refreshCalls, signedOut: hub.signedOut }), true;
      if (req.method === 'POST' && path === '/__test/publish') {
        if (typeof body.id !== 'string' || typeof body.version !== 'string') return error(res, 400, 'bad-request'), true;
        hub.publish({ id: body.id, version: body.version, name: body.name ?? body.id, description: body.description ?? '', grants: body.grants ?? {}, zip: demoPluginZip({ id: body.id, name: body.name ?? body.id, version: body.version, description: body.description ?? '', ...body.manifest }) });
        return send(res, 200, { ok: true }), true;
      }
      if (req.method === 'POST' && path === '/__test/state') {
        for (const key of ['approval', 'denied', 'unavailable', 'disabled']) if (key in body) hub[key] = body[key];
        if (body.expireAccess) hub.expireAccess();
        if (body.revokeAll) hub.revokeAll();
        if (body.approve) hub.approve();
        return send(res, 200, { ok: true }), true;
      }
      return error(res, 404, 'not_found'), true;
    }
    hub.requests.push({ method: req.method, path, auth, body });

    if (req.method === 'POST' && path === '/v1/enroll/start') {
      if (body.kind !== 'app' || typeof body.name !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(body.platform ?? '')) return error(res, 400, 'bad-request'), true;
      const enroll = { id: `enroll-${hub.enrolls.size + 1}`, pollToken: token('ahp_'), code: 'BCDF-GHJK', approved: false, polls: 0 };
      hub.enrolls.set(enroll.id, enroll);
      send(res, 200, { enrollId: enroll.id, pollToken: enroll.pollToken, userCode: enroll.code, verifyUrl: `${hub.url}/enroll?code=${enroll.code}`, interval: 2, expiresIn: 600 });
      return true;
    }
    if (req.method === 'POST' && path === '/v1/enroll/poll') {
      const enroll = hub.enrolls.get(body.enrollId);
      if (!enroll || enroll.pollToken !== body.pollToken || hub.approval === 'deny') return error(res, 410, 'enroll-ended'), true;
      enroll.polls++;
      if (hub.approval === 'auto' && enroll.polls >= 1) enroll.approved = true;
      if (!enroll.approved) return send(res, 200, { status: 'pending' }), true;
      hub.deviceId = 'device-1';
      send(res, 200, { status: 'approved', device: { id: hub.deviceId }, account: hub.account, ...issue() });
      return true;
    }
    if (req.method === 'POST' && path === '/v1/token/refresh') {
      hub.refreshCalls++;
      if (!hub.refresh || body.refreshToken !== hub.refresh) return error(res, 401, 'invalid-token'), true;
      if (hub.denied) return error(res, 403, 'access-denied'), true;
      send(res, 200, issue());
      return true;
    }
    // Everything below needs the current access token.
    if (!hub.access || auth !== hub.access) return error(res, 401, 'token-expired'), true;
    if (hub.denied) return error(res, 403, 'access-denied'), true;
    if (req.method === 'DELETE' && path === '/v1/me') { hub.signedOut++; hub.revokeAll(); send(res, 200, {}); return true; }
    if (hub.disabled && path.startsWith('/v1/plugins')) return error(res, 503, 'plugins_disabled'), true;
    if (hub.unavailable && path.startsWith('/v1/plugins')) return error(res, 503, 'plugins_unavailable'), true;
    if (req.method === 'GET' && path === '/v1/plugins') {
      send(res, 200, { plugins: [...hub.plugins.values()].sort((a, b) => a.id.localeCompare(b.id)).map(entry), checkedAt: Date.now() });
      return true;
    }
    const match = /^\/v1\/plugins\/([a-z0-9][a-z0-9-]{1,39})(\/download)?$/.exec(path);
    const plugin = match && hub.plugins.get(match[1]);
    if (req.method === 'GET' && match && !plugin) return error(res, 404, 'plugin_not_found'), true;
    if (req.method === 'GET' && match && !match[2]) { send(res, 200, entry(plugin)); return true; }
    if (req.method === 'GET' && match && match[2]) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': plugin.zip.length, 'x-plugin-version': plugin.version, 'x-plugin-sha256': plugin.sha256 });
      res.end(plugin.zip);
      return true;
    }
    error(res, 404, 'not_found');
    return true;
  };
  return hub;
}

// A Hub of its own, for tests: { url, close, ...createHubRoutes() }.
export async function startFakeHub() {
  const hub = createHubRoutes();
  const server = http.createServer((req, res) => { hub.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }, () => { res.writeHead(500); res.end(); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  hub.url = `http://127.0.0.1:${server.address().port}`;
  hub.close = () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
  return hub;
}
