// Serves the other PC's ADE page to a remote window (docs/REMOTE_UI.md): what the phone app's RemoteUiActivity does for its WebView.
// The page has no server of its own here. `ui/manifest` lists the files of the other PC's built UI with their SHA-256; `ui/file` returns
// one. Files are kept by hash (a file that is already here is not asked for again, one that arrives with another hash is thrown away), so
// the window runs exactly the version of the PC it connects to. Free of Electron: `link.call` is the only thing it needs.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const FEEDBACK = '/feedback-file/';
const MAX_PARALLEL = 3, KEEP_MS = 30 * 24 * 3600_000;
const HASH = /^[0-9a-f]{64}$/;
const sha = data => createHash('sha256').update(data).digest('hex');
const problem = (message, code) => Object.assign(new Error(message), { code });

// `link.call(action, input)`; `cacheDir` is this PC's cache for every remote PC (hashes are the same whoever sent the file);
// `origin` is where the window loads the page (`ade-remote://<host>`), put in the CSP of files that name it (`%ORIGIN%`).
export function createUiProxy({ link, cacheDir, origin, now = Date.now }) {
  let manifest = null, files = new Map();
  const inflight = new Map();
  let running = 0;
  const queue = [];
  // At most 3 downloads at once, so the link (and its ping) is not starved by the first screen's dozens of files.
  const slot = () => new Promise(resolve => { if (running < MAX_PARALLEL) { running++; resolve(); } else queue.push(resolve); });
  const release = () => { const next = queue.shift(); if (next) next(); else running--; };

  const decode = reply => {
    const data = Buffer.from(String(reply?.data ?? ''), 'base64');
    return reply?.encoding === 'gzip' ? gunzipSync(data) : data;
  };

  async function prepare() {
    let reply;
    try { reply = await link.call('ui/manifest', { encoding: 'gzip' }); }
    catch (error) { throw error.code === 'REMOTE_FORBIDDEN' || error.code === 'NOT_FOUND' ? problem('이 PC의 MoonerADE 또는 원격 접속 플러그인이 오래되어 원격 화면을 줄 수 없습니다. 그 PC에서 업데이트하세요.', 'UI_UNSUPPORTED') : error; }
    const value = reply?.encoding === 'gzip' ? JSON.parse(decode(reply).toString('utf8')) : reply;
    const list = Array.isArray(value?.files) ? value.files.filter(item => typeof item?.path === 'string' && item.path.startsWith('/') && HASH.test(item.hash ?? '')) : [];
    if (typeof value?.entry !== 'string' || !list.some(item => item.path === value.entry) || typeof value.csp !== 'string') throw problem('그 PC가 보낸 원격 화면 목록이 올바르지 않습니다.', 'UI_INVALID');
    manifest = { entry: value.entry, csp: value.csp, version: String(value.version ?? ''), preload: Array.isArray(value.preload) ? value.preload.filter(item => typeof item === 'string') : [] };
    files = new Map(list.map(item => [item.path, item]));
    await fs.mkdir(cacheDir, { recursive: true });
    void prune(new Set(list.map(item => item.hash)));
    void Promise.allSettled(manifest.preload.filter(item => files.has(item)).map(item => bytes(files.get(item))));   // the first screen, before the page asks
    return { entry: manifest.entry, version: manifest.version };
  }

  // Cache files that no manifest of this PC names and nobody used for 30 days.
  async function prune(keep) {
    try {
      for (const name of await fs.readdir(cacheDir)) {
        const hash = name.split('.')[0];
        if (!HASH.test(hash) || keep.has(hash)) continue;
        const stat = await fs.stat(path.join(cacheDir, name)).catch(() => null);
        if (stat && now() - stat.mtimeMs > KEEP_MS) await fs.rm(path.join(cacheDir, name), { force: true });
      }
    } catch { /* the cache is only a speed-up */ }
  }

  // { data, csp } of one manifest file: from the cache, or downloaded once and checked against the hash the manifest named.
  async function bytes(item) {
    const file = path.join(cacheDir, item.hash);
    try {
      const data = await fs.readFile(file);
      if (sha(data) === item.hash) {
        const meta = await fs.readFile(`${file}.meta`, 'utf8').then(JSON.parse, () => ({}));
        return { data, csp: typeof meta.csp === 'string' ? meta.csp : null };
      }
    } catch { /* not cached */ }
    if (!inflight.has(item.hash)) {
      inflight.set(item.hash, (async () => {
        await slot();
        try {
          const reply = await link.call('ui/file', { path: item.path, encoding: 'gzip' });
          const data = decode(reply);
          if (sha(data) !== item.hash) throw problem(`받은 ${item.path} 파일이 그 PC가 알려 준 해시와 맞지 않아 버렸습니다.`, 'HASH_MISMATCH');
          const csp = typeof reply.csp === 'string' ? reply.csp : null;
          await fs.writeFile(file, data); if (csp) await fs.writeFile(`${file}.meta`, JSON.stringify({ csp }));
          return { data, csp };
        } finally { release(); }
      })().finally(() => inflight.delete(item.hash)));
    }
    return inflight.get(item.hash);
  }

  const headers = (type, csp, cache) => ({
    'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': cache,
    ...(csp && { 'Content-Security-Policy': csp.replaceAll('%ORIGIN%', origin) }),
    // The chat's sandboxed UI frame has an opaque origin and loads the app's fonts from here.
    ...(type.startsWith('font/') && { 'Access-Control-Allow-Origin': '*' })
  });
  const empty = (status) => ({ status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, body: Buffer.from(status === 404 ? 'Not found' : 'Error') });

  // The answer to a request of the window: { status, headers, body }.
  async function respond(requestUrl) {
    if (!manifest) return empty(503);
    let url;
    try { url = new URL(requestUrl); } catch { return empty(400); }
    const wanted = url.pathname === '/' ? manifest.entry : url.pathname;
    try {
      // A feedback screenshot of the other PC: never cached, asked for every time.
      if (wanted.startsWith(FEEDBACK)) {
        const reply = await link.call('ui/file', { path: wanted, encoding: 'gzip' });
        return { status: 200, headers: headers(wanted.endsWith('.png') ? 'image/png' : 'image/jpeg', null, 'no-store'), body: decode(reply) };
      }
      const item = files.get(wanted);
      if (!item) return empty(404);
      const { data, csp } = await bytes(item);
      const type = item.type || 'application/octet-stream';
      return { status: 200, headers: headers(type, wanted === manifest.entry ? manifest.csp : csp, 'private, max-age=31536000, immutable'), body: data };
    } catch (error) {
      console.warn(`원격 화면 파일을 받지 못했습니다 (${wanted}): ${error.message}`);
      return empty(error.code === 'NOT_FOUND' ? 404 : 502);
    }
  }
  return { prepare, respond, get entry() { return manifest?.entry ?? null; } };
}
