import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// HERE: this folder (the fake `claude` lives in HERE/bin). ROOT: the checkout. S: where env.json, screenshots and results go (VERIFY_OUT, default a temp folder).
export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const S = process.env.VERIFY_OUT || join(tmpdir(), 'ade-verify-out');
mkdirSync(join(S, 'shots'), { recursive: true });
export const WebSocket = createRequire(join(ROOT, 'apps/local-server/package.json'))('ws');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
export const bigPng = bytes => Buffer.concat([PNG1.subarray(0, PNG1.length - 12), Buffer.alloc(bytes), PNG1.subarray(PNG1.length - 12)]); // valid header, padded body

export async function fakeHub() {
  const requests = [], hub = { requests, mode: 'ok', retryAfter: undefined };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    let meta = null, images = 0;
    try { const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData(); meta = JSON.parse(form.get('meta')); images = form.getAll('image').length; } catch {}
    requests.push({ url: req.url, device: req.headers['x-ade-device'], meta, images, at: Date.now() });
    const n = requests.length, answer = { ok: [201, { issueNumber: n, issueUrl: `https://github.com/o/r/issues/${n}` }], 429: [429, { error: { code: 'rate_limited', message: '천천히' } }], 503: [503, { error: { code: 'auth-unavailable' } }], 400: [400, { error: { code: 'bad-request', message: 'no' } }], 413: [413, {}], 502: [502, {}] }[hub.mode];
    res.writeHead(answer[0], { 'content-type': 'application/json', ...(hub.mode === '429' && hub.retryAfter && { 'retry-after': String(hub.retryAfter) }) }); res.end(JSON.stringify(answer[1]));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  hub.url = `http://127.0.0.1:${server.address().port}`; hub.close = () => new Promise(r => server.close(r));
  return hub;
}

// A server of this checkout in its own HOME/data dir; `claude` on PATH is the fake. Never touches the installed app.
// `temp`: reuse an earlier boot's folder (its data, home and repo, so a saved API key or chat survives a restart) instead of a new one.
export async function boot({ env = {}, data, home, repoFiles = true, minimalPath = false, temp: reuse } = {}) {
  const temp = await realpath(reuse || await mkdtemp(join(tmpdir(), 'ade-verify-')));
  data ??= join(temp, 'data'); home ??= join(temp, 'home'); const repo = join(temp, 'repo');
  for (const d of [data, home, repo]) await mkdir(d, { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=v', '-c', 'user.email=v@example.invalid', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: repo, stdio: 'ignore' });
  if (repoFiles && !(reuse && existsSync(join(repo, '.git')))) {
    git('init', '-q', '-b', 'main'); await mkdir(join(repo, 'src')); await writeFile(join(repo, 'a.txt'), 'hello\n'); await writeFile(join(repo, 'src/b.ts'), 'export const x = 1;\n'); await writeFile(join(repo, '.gitignore'), 'ignored.log\n');
    git('add', '.'); git('commit', '-q', '-m', 'init'); await writeFile(join(repo, 'untracked.md'), 'u\n'); await writeFile(join(repo, 'ignored.log'), 'i\n');
  }
  const log = join(temp, 'fake-claude.jsonl'), ctlFile = join(temp, 'ctl.json'); await writeFile(log, ''); await writeFile(ctlFile, '{}');
  // REAL_AGENTS=1: the real CLIs on PATH instead of the fake (still the temp HOME, so only an API key saved in Settings > AI 툴 can sign them in).
  const PATH = minimalPath ? `${dirname(process.execPath)}:/usr/bin:/bin` : process.env.REAL_AGENTS ? process.env.PATH : `${join(HERE, 'bin')}${delimiter}${process.env.PATH}`;
  const child = spawn(process.execPath, ['apps/local-server/src/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH, FAKE_LOG: log, FAKE_CTL: ctlFile, ADE_DEV: '0', ADE_PORT: '0', ADE_DATA_DIR: data, ADE_PTY_ENDPOINT: '', ADE_PTY_TOKEN: '', ADE_HUB_URL: 'http://127.0.0.1:9', ...env } });
  let stderr = ''; child.stderr.on('data', c => stderr += c);
  const line = await new Promise((resolve, reject) => { let out = ''; child.stdout.on('data', c => { out += c; if (/#token=\w+/.test(out)) resolve(out); }); child.once('exit', () => reject(new Error('server exited: ' + stderr))); setTimeout(() => reject(new Error('startup timeout')), 20000); });
  const [, origin, token] = /(http:\/\/127\.0\.0\.1:\d+)\/#token=(\w+)/.exec(line);
  const auth = await fetch(`${origin}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const rawOnce = (action, body = {}) => fetch(`${origin}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  // a server that refuses an oversized body closes that socket; the next request on the pooled socket may fail once, so retry once
  const raw = async (action, body = {}) => { try { return await rawOnce(action, body); } catch (e) { if (e.message === 'fetch failed') return rawOnce(action, body); throw e; } };
  const api = async (action, body = {}, expected = 200) => { const r = await raw(action, body); const v = await r.json().catch(() => null); if (r.status !== expected) throw new Error(`${action} -> ${r.status} (want ${expected}) ${JSON.stringify(v)}`); return v; };
  const status = async (action, body = {}) => { const r = await raw(action, body); return { status: r.status, body: await r.json().catch(() => null) }; };
  const project = await api('project/open', { path: repo });
  const call = (action, body = {}, expected) => api(action, { projectId: project.id, ...body }, expected);
  const callStatus = (action, body = {}) => status(action, { projectId: project.id, ...body });
  const stop = async () => { if (child.exitCode === null) { const ex = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await ex; } };
  const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const setCtl = obj => writeFile(ctlFile, JSON.stringify(obj));
  return { temp, data, home, repo, origin, token, cookie, api, raw, status, call, callStatus, projectId: project.id, stop, calls, setCtl, child, get stderr() { return stderr; }, chatDir: id => join(data, project.id, 'chat', id), feedbackDir: join(data, 'feedback') };
}
export async function until(fn, ms = 15000, step = 100) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(step); } throw new Error('until timeout' + (last instanceof Error ? ': ' + last.message : '')); }

const results = [];
export async function check(id, title, fn) {
  if (process.env.ONLY && !id.startsWith(process.env.ONLY)) return;
  const t0 = Date.now();
  try { const note = await fn(); results.push({ id, title, ok: true, note: note ?? '' }); console.log(`PASS ${id} ${title}${note ? ' — ' + note : ''}`); }
  catch (e) { results.push({ id, title, ok: false, note: String(e.message ?? e).slice(0, 600) }); console.log(`FAIL ${id} ${title}\n     ${String(e.message ?? e).slice(0, 600)}`); }
}
export const getResults = () => results;
export const eq = (a, b, msg = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
export const ok = (v, msg = 'assertion') => { if (!v) throw new Error(msg); };
