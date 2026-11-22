// The web UI for the MoonerADE phone app (docs/REMOTE_UI.md). The phone has no network path to this server: it reaches it only
// through the remote-access plugin's encrypted link, whose requests land in route() like the window's own. So the phone also
// loads the UI itself from here, file by file: `ui/manifest` lists the built files with their hashes (the app keeps what it has
// and asks only for new ones), and `ui/file` returns one of them, base64. The phone then runs the same version as this PC.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fault } from './files.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm' };
// The page has no server of its own on the phone: no fetch or socket may leave it (connect-src 'none'); the app answers every request.
export const REMOTE_PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'none'; img-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const FRAME = '/ade-ui-frame.html', FEEDBACK = '/feedback-file/';
const MAX_FILE = 24 * 1024 * 1024; // a remote message holds at most 32 MiB, base64 adds a third
const sha = data => createHash('sha256').update(data).digest('hex');
// The link to a phone is slow (a relay, often mobile data): a phone that asks for `encoding: 'gzip'` gets text files and the manifest
// compressed, about a quarter of the size. The hash stays the one of the plain bytes. Images and fonts are compressed already.
const SQUEEZE = /^(text\/|application\/(json|javascript|wasm)|image\/svg)/;
function encode(content, type, input) {
  if (input?.encoding !== 'gzip' || !SQUEEZE.test(type) || content.length < 1024) return { data: content.toString('base64') };
  return { encoding: 'gzip', data: gzipSync(content, { level: 6 }).toString('base64') };
}

// What the first screen needs, so the phone can ask for all of it at once instead of finding it one step at a time (page → its
// script and stylesheet → their fonts), each step a wait on the slow link. Page files before fonts, biggest first: the script blocks
// the longest. Fonts: those of one file (the icon font) and the Latin part of the split ones. The split Korean font is left out: the
// phone draws Korean with its own system font (mobile.css), which is the same Noto Sans.
export async function firstScreen(webRoot) {
  const html = await fs.readFile(path.join(webRoot, 'index.html'), 'utf8').catch(() => '');
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="(\/[^"?#]+)"/g)].map(match => match[1]);
  const fonts = [];
  for (const ref of refs.filter(item => item.endsWith('.css'))) {
    const css = await fs.readFile(path.join(webRoot, ref), 'utf8').catch(() => '');
    for (const [face] of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
      if (/Noto Sans KR/i.test(face)) continue;
      const range = /unicode-range:\s*([^;}]*)/i.exec(face)?.[1];
      if (range && !/U\+0000-00FF/i.test(range)) continue;
      const url = /url\(["']?(\/[^"')?#]+)/.exec(face)?.[1];
      if (url) fonts.push(url);
    }
  }
  const size = async item => (await fs.stat(path.join(webRoot, item)).catch(() => null))?.size ?? 0;
  const bySize = async items => (await Promise.all([...new Set(items)].map(async item => [item, await size(item)]))).sort((a, b) => b[1] - a[1]).map(([item]) => item);
  return [...new Set(['/index.html', ...await bySize(refs), ...await bySize(fonts)])];
}

// `frame`: { csp, html } of the interactive UI iframe page; `feedbackFile(id, name)`: path of a feedback screenshot.
export function createRemoteUi({ webRoot, frame, feedbackFile }) {
  // Hashing the whole bundle costs a moment; it is kept until a file under it changes size or time.
  let cached = null;
  async function walk(dir, out = []) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, out);
      else if (entry.isFile() && !entry.name.endsWith('.map')) out.push(file);
    }
    return out;
  }
  async function manifest(input) {
    const value = await listing();
    if (input?.encoding !== 'gzip') return value;
    return { encoding: 'gzip', data: gzipSync(Buffer.from(JSON.stringify(value)), { level: 6 }).toString('base64') };
  }
  async function listing() {
    const files = await walk(webRoot).catch(error => {
      if (error.code === 'ENOENT') throw fault('UI_UNAVAILABLE', '이 PC의 ADE에 빌드된 화면이 없습니다.', 404);
      throw error;
    });
    const stats = await Promise.all(files.map(async file => ({ file, stat: await fs.stat(file) })));
    const key = stats.map(({ file, stat }) => `${file}:${stat.size}:${stat.mtimeMs}`).join('|');
    if (cached?.key === key) return cached.value;
    const list = await Promise.all(stats.map(async ({ file, stat }) => ({
      path: '/' + path.relative(webRoot, file).split(path.sep).join('/'), size: stat.size, hash: sha(await fs.readFile(file)), type: TYPES[path.extname(file)] || 'application/octet-stream'
    })));
    list.push({ path: FRAME, size: Buffer.byteLength(frame.html), hash: sha(frame.html), type: TYPES['.html'] });
    list.sort((a, b) => a.path.localeCompare(b.path));
    const known = new Set(list.map(item => item.path));
    const preload = (await firstScreen(webRoot)).filter(item => known.has(item));
    const value = { version: sha(list.map(item => `${item.path}:${item.hash}`).join('\n')).slice(0, 16), entry: '/index.html', csp: REMOTE_PAGE_CSP, files: list, preload };
    cached = { key, value };
    return value;
  }
  async function file(input) {
    const wanted = typeof input?.path === 'string' ? input.path : '';
    if (!wanted.startsWith('/') || wanted.length > 1024 || wanted.includes('\0')) throw fault('INVALID_PATH', '잘못된 경로입니다.', 403);
    // The interactive UI frame has its own CSP; `%ORIGIN%` is where the app serves the page, so the frame can load the app's fonts.
    if (wanted === FRAME) return { path: wanted, type: TYPES['.html'], csp: frame.csp.replace('font-src data:', 'font-src data: %ORIGIN%'), cache: 'immutable', hash: sha(frame.html), ...encode(Buffer.from(frame.html), TYPES['.html'], input) };
    if (wanted.startsWith(FEEDBACK)) {
      const [id, name] = wanted.slice(FEEDBACK.length).split('?')[0].split('/').map(part => decodeURIComponent(part ?? ''));
      const content = await fs.readFile(feedbackFile(id ?? '', name ?? ''));
      return { path: wanted, type: name?.endsWith('.png') ? 'image/png' : 'image/jpeg', cache: 'none', hash: sha(content), ...encode(content, 'image/png', input) };
    }
    const target = path.resolve(webRoot, `.${decodeURIComponent(wanted.split('?')[0])}`);
    if (!target.startsWith(webRoot + path.sep) || target.endsWith('.map')) throw fault('INVALID_PATH', '잘못된 경로입니다.', 403);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) throw fault('NOT_FOUND', '파일이 없습니다.', 404);
    if (stat.size > MAX_FILE) throw fault('PAYLOAD_TOO_LARGE', '파일이 너무 큽니다.', 413);
    const content = await fs.readFile(target);
    const type = TYPES[path.extname(target)] || 'application/octet-stream';
    return { path: wanted, type, ...(target.endsWith('index.html') ? { csp: REMOTE_PAGE_CSP } : {}), cache: 'immutable', hash: sha(content), ...encode(content, type, input) };
  }
  return { manifest, file };
}

// The phone's folder chooser: the desktop opens the system dialog on this PC, which a phone cannot see. It lists the subfolders of an
// absolute folder (hidden ones last) so the page can browse to one; with no path it starts at `start`.
export async function listFolders(input, start) {
  const wanted = typeof input?.path === 'string' && input.path ? input.path : start;
  if (!path.isAbsolute(wanted) || wanted.length > 4096 || wanted.includes('\0')) throw fault('INVALID_PATH', '절대 경로가 필요합니다.', 400);
  const folder = path.resolve(wanted);
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(error => { throw fault(error.code === 'ENOENT' ? 'NOT_FOUND' : 'UNREADABLE', '폴더를 읽을 수 없습니다.', 404); });
  const folders = entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name)
    .sort((a, b) => Number(a.startsWith('.')) - Number(b.startsWith('.')) || a.localeCompare(b, undefined, { sensitivity: 'base' })).slice(0, 2000);
  const parent = path.dirname(folder);
  return { path: folder, parent: parent === folder ? null : parent, folders, sep: path.sep };
}
