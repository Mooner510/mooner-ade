// The feedback inbox (피드백 요청): drafts of "n screenshots + one markdown body" that a person, the AI draft button or an agent's
// MCP tool (feedback-mcp.js) starts, and a person reviews and submits. Everything lives under <dataRoot>/feedback:
//   <id>/feedback.json   metadata (title, source, status, image list, submit result)
//   <id>/body.md         the markdown body
//   <id>/img-<n>.png|jpg images in order; an annotated one keeps its original once as img-<n>.orig.<ext>
//   incoming/            drafts an agent dropped (feedback-mcp.js); imported as `agent` drafts waiting for review
// Folders are 0700 and files 0600, like pasted images; nothing here expires.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fault, serial } from './files.js';

export const MAX_IMAGES = 10, MAX_IMAGE_BYTES = 8 * 1024 * 1024, MAX_BODY = 64 * 1024, MAX_TITLE = 120;
export const ID = /^[a-z0-9]{6,16}-[a-f0-9]{12}$/;
const IMAGE = /^img-(\d{1,6})\.(png|jpg)$/;
const INCOMING = /^[\w-]{8,64}\.json$/;
const SOURCES = new Set(['human', 'ai', 'agent']);
// Waiting in the submit queue counts as locked too: cancel it (feedback-queue.js) to edit again.
const LOCKED = new Set(['drafting', 'queued', 'submitting', 'submitted']);
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg' };
export const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg' };

export const newFeedbackId = (now = Date.now()) => `${now.toString(36)}-${randomBytes(6).toString('hex')}`;

// What the bytes are, by their magic numbers, with the pixel size. null when it is neither PNG nor JPEG.
export function imageInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) return null;
  if (bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a && bytes.toString('latin1', 12, 16) === 'IHDR')
    return { ext: 'png', mime: 'image/png', w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    // Walk the segments to the first start-of-frame marker, which holds the size.
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
      const length = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { ext: 'jpg', mime: 'image/jpeg', w: bytes.readUInt16BE(at + 7), h: bytes.readUInt16BE(at + 5) };
      at += 2 + length;
    }
    return { ext: 'jpg', mime: 'image/jpeg', w: 0, h: 0 };
  }
  return null;
}

export function checkImage(bytes, mime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw fault('INVALID_INPUT', '이미지가 비어 있습니다.');
  if (bytes.length > MAX_IMAGE_BYTES) throw fault('INVALID_INPUT', `이미지는 ${MAX_IMAGE_BYTES / 1024 / 1024}MB까지 넣을 수 있습니다.`, 413);
  const info = imageInfo(bytes);
  if (!info || (mime !== undefined && MIME_EXT[mime] !== info.ext)) throw fault('INVALID_INPUT', 'PNG 또는 JPEG 이미지만 넣을 수 있습니다.');
  return info;
}

const cleanTitle = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
function cleanBody(value) {
  const body = String(value ?? '').replace(/\r\n?/g, '\n').replace(/\0/g, '');
  if (Buffer.byteLength(body) > MAX_BODY) throw fault('INVALID_INPUT', `본문은 ${MAX_BODY / 1024}KB까지 쓸 수 있습니다.`, 413);
  return body;
}

// On Windows a rename onto a file someone is reading at that moment (e.g. the list being fetched) fails with EPERM/EBUSY
// for a few milliseconds; it is tried again briefly.
async function writeAtomic(file, data) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(tmp, file); break; }
      catch (error) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 20) throw error; await new Promise(resolve => setTimeout(resolve, 10 + attempt * 10)); }
    }
  } finally { await fs.rm(tmp, { force: true }); }
}

// onChange(id?) is called after every change (the server broadcasts `feedback/changed`).
export function createFeedbackStore({ root, now = Date.now, onChange = () => {} }) {
  const incomingDir = path.join(root, 'incoming');
  const locks = new Map();
  const locked = (id, operation) => { if (!locks.has(id)) locks.set(id, serial()); return locks.get(id)(operation); };
  const folder = id => { if (!ID.test(String(id))) throw fault('INVALID_INPUT', '잘못된 피드백 ID입니다.'); return path.join(root, id); };
  const imageName = name => { if (!IMAGE.test(String(name))) throw fault('INVALID_INPUT', '잘못된 이미지 이름입니다.'); return String(name); };
  const original = name => name.replace(/\.(png|jpg)$/, '.orig.$1');

  async function read(id) {
    const dir = folder(id);
    let meta;
    try { meta = JSON.parse(await fs.readFile(path.join(dir, 'feedback.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw fault('NOT_FOUND', '피드백을 찾을 수 없습니다.', 404); throw error; }
    const body = await fs.readFile(path.join(dir, 'body.md'), 'utf8').catch(() => '');
    return { ...meta, id, body };
  }
  async function write(item) {
    const dir = folder(item.id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const { body, ...meta } = item;
    await writeAtomic(path.join(dir, 'body.md'), body ?? '');
    await writeAtomic(path.join(dir, 'feedback.json'), JSON.stringify(meta));
    return item;
  }
  const changed = (id, value) => { onChange(id); return value; };
  // A change made under the item's lock; `mutate` returns the new item (or throws). Locked states refuse edits unless allowed.
  function change(id, mutate, { allow = [] } = {}) {
    return locked(id, async () => {
      const item = await read(id);
      if (LOCKED.has(item.status) && !allow.includes(item.status)) throw fault('FEEDBACK_LOCKED', item.status === 'submitted' ? '제출한 피드백은 고칠 수 없습니다.' : item.status === 'queued' ? '전송 대기 중입니다. 대기를 취소한 뒤에 고치세요.' : '작업이 끝난 뒤에 다시 시도하세요.', 409);
      const next = await mutate(item);
      next.updatedAt = now();
      return changed(id, await write(next));
    });
  }

  async function create({ title = '', body = '', source = 'human', status } = {}) {
    if (!SOURCES.has(source)) throw fault('INVALID_INPUT', '잘못된 출처입니다.');
    const at = now(), id = newFeedbackId(at);
    const item = { id, title: cleanTitle(title), body: cleanBody(body), source, status: status ?? (source === 'human' ? 'draft' : 'review'), reviewed: source === 'human', images: [], createdAt: at, updatedAt: at };
    return changed(id, await write(item));
  }
  async function list() {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(root, { withFileTypes: true });
    const items = await Promise.all(entries.filter(entry => entry.isDirectory() && ID.test(entry.name)).map(entry => read(entry.name).catch(() => null)));
    return items.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  }
  async function update(id, input) {
    return change(id, item => {
      const next = { ...item };
      if (input.title !== undefined) next.title = cleanTitle(input.title);
      if (input.body !== undefined) next.body = cleanBody(input.body);
      if (input.reviewed === true) next.reviewed = true;
      // Editing a failed submission makes it a draft again (the next submit is a new attempt with the same key).
      if (next.status === 'failed' && (input.title !== undefined || input.body !== undefined)) { next.status = item.source === 'human' ? 'draft' : 'review'; delete next.error; }
      return next;
    }, { allow: input.title === undefined && input.body === undefined ? ['submitted'] : [] });
  }
  async function remove(id) {
    return locked(id, async () => {
      const item = await read(id);
      if (item.status === 'drafting' || item.status === 'submitting') throw fault('FEEDBACK_LOCKED', '작업이 끝난 뒤에 지우세요.', 409);
      // A queued item may simply be deleted: the queue skips what is gone.
      await fs.rm(folder(id), { recursive: true, force: true });
      locks.delete(id);
      return changed(id, { ok: true });
    });
  }
  async function storeImage(dir, item, bytes, info) {
    const used = new Set(item.images.map(image => Number(IMAGE.exec(image.name)[1])));
    let n = 1; while (used.has(n)) n++;
    const name = `img-${n}.${info.ext}`;
    await writeAtomic(path.join(dir, name), bytes);
    return { name, w: info.w, h: info.h, annotated: false };
  }
  async function addImage(id, bytes, mime) {
    const info = checkImage(bytes, mime);
    return change(id, async item => {
      if (item.images.length >= MAX_IMAGES) throw fault('INVALID_INPUT', `이미지는 ${MAX_IMAGES}장까지 넣을 수 있습니다.`);
      return { ...item, images: [...item.images, await storeImage(folder(id), item, bytes, info)] };
    });
  }
  // An annotated version replaces the image; the first original is kept beside it so it can be restored.
  async function replaceImage(id, name, bytes) {
    imageName(name);
    const info = checkImage(bytes, 'image/png');
    return change(id, async item => {
      const at = item.images.findIndex(image => image.name === name);
      if (at < 0) throw fault('NOT_FOUND', '이미지를 찾을 수 없습니다.', 404);
      const dir = folder(id), current = item.images[at];
      const target = current.name.endsWith('.png') ? current.name : current.name.replace(/\.jpg$/, '.png');
      if (!current.annotated) await fs.rename(path.join(dir, current.name), path.join(dir, original(current.name)));
      else if (current.original && current.original !== current.name) await fs.rm(path.join(dir, current.name), { force: true });
      await writeAtomic(path.join(dir, target), bytes);
      const images = [...item.images];
      images[at] = { name: target, w: info.w, h: info.h, annotated: true, original: current.annotated ? current.original : current.name };
      return { ...item, images };
    });
  }
  async function restoreImage(id, name) {
    imageName(name);
    return change(id, async item => {
      const at = item.images.findIndex(image => image.name === name);
      if (at < 0) throw fault('NOT_FOUND', '이미지를 찾을 수 없습니다.', 404);
      const current = item.images[at];
      if (!current.annotated) return item;
      const dir = folder(id), bytes = await fs.readFile(path.join(dir, original(current.original)));
      const info = imageInfo(bytes);
      await fs.rm(path.join(dir, current.name), { force: true });
      await fs.rename(path.join(dir, original(current.original)), path.join(dir, current.original));
      const images = [...item.images];
      images[at] = { name: current.original, w: info?.w ?? 0, h: info?.h ?? 0, annotated: false };
      return { ...item, images };
    });
  }
  async function removeImage(id, name) {
    imageName(name);
    return change(id, async item => {
      const current = item.images.find(image => image.name === name);
      if (!current) throw fault('NOT_FOUND', '이미지를 찾을 수 없습니다.', 404);
      const dir = folder(id);
      await fs.rm(path.join(dir, current.name), { force: true });
      if (current.annotated) await fs.rm(path.join(dir, original(current.original)), { force: true });
      return { ...item, images: item.images.filter(image => image !== current) };
    });
  }
  async function moveImage(id, name, to) {
    imageName(name);
    return change(id, item => {
      const at = item.images.findIndex(image => image.name === name);
      if (at < 0) throw fault('NOT_FOUND', '이미지를 찾을 수 없습니다.', 404);
      if (!Number.isInteger(to)) throw fault('INVALID_INPUT', '잘못된 위치입니다.');
      const images = [...item.images], [moved] = images.splice(at, 1);
      images.splice(Math.max(0, Math.min(images.length, to)), 0, moved);
      return { ...item, images };
    });
  }
  // Status changes the server makes itself (AI draft, submit). `fields` may also carry title/body/source/issue/error.
  async function setStatus(id, status, fields = {}, { from } = {}) {
    return locked(id, async () => {
      const item = await read(id);
      if (from && !from.includes(item.status)) throw fault('FEEDBACK_LOCKED', item.status === 'submitted' ? '이미 제출한 피드백입니다.' : '다른 작업이 진행 중입니다.', 409);
      const next = { ...item, ...fields, status, updatedAt: now() };
      if (fields.title !== undefined) next.title = cleanTitle(fields.title);
      if (fields.body !== undefined) next.body = cleanBody(fields.body);
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
      return changed(id, await write(next));
    });
  }
  const filePath = (id, name) => {
    const base = String(name);
    if (!IMAGE.test(base) && !IMAGE.test(base.replace('.orig.', '.'))) throw fault('INVALID_INPUT', '잘못된 이미지 이름입니다.');
    return path.join(folder(id), base);
  };
  // Work the app was doing when it stopped cannot finish now. A submit may have gone through; submitting again is safe
  // because the Hub answers the same key with the same issue.
  async function recover() {
    for (const item of await list()) {
      if (item.status === 'drafting') await setStatus(item.id, item.source === 'human' ? 'draft' : 'review', { error: 'AI 정리 중에 앱이 종료되었습니다.' });
      // Sent again from the queue: the Hub answers the same key with the same issue, so nothing is doubled.
      else if (item.status === 'submitting') await setStatus(item.id, 'queued', { nextAttemptAt: now(), error: '전송 결과를 확인하지 못해 다시 보냅니다.' });
    }
  }
  // Drafts an agent left in incoming/ (feedback-mcp.js writes the images first and the .json last).
  async function importIncoming() {
    const entries = await fs.readdir(incomingDir).catch(() => []);
    const imported = [];
    for (const entry of entries.filter(name => INCOMING.test(name))) {
      const file = path.join(incomingDir, entry);
      let draft;
      try { draft = JSON.parse(await fs.readFile(file, 'utf8')); } catch { await fs.rm(file, { force: true }); continue; }
      const images = Array.isArray(draft?.images) ? draft.images.filter(name => typeof name === 'string' && /^[\w-]{8,64}-\d{1,2}\.(png|jpg)$/.test(name)).slice(0, MAX_IMAGES) : [];
      try {
        const item = await create({ title: draft?.title, body: typeof draft?.body === 'string' ? draft.body.slice(0, MAX_BODY) : '', source: 'agent' });
        for (const name of images) {
          const bytes = await fs.readFile(path.join(incomingDir, name)).catch(() => null);
          if (bytes && imageInfo(bytes)) await addImage(item.id, bytes).catch(() => {});
        }
        imported.push(item.id);
      } finally {
        await fs.rm(file, { force: true });
        for (const name of images) await fs.rm(path.join(incomingDir, name), { force: true });
      }
    }
    return imported;
  }
  // The body plus where the images are, for copying by hand when submitting is not possible.
  async function markdown(id) {
    const item = await read(id), dir = folder(id);
    const lines = [item.title ? `# ${item.title}\n` : '', item.body.trim(), item.images.length ? `\n---\n첨부 이미지 (${dir}):\n${item.images.map((image, index) => `${index + 1}. ${image.name}`).join('\n')}` : ''];
    return { markdown: lines.filter(Boolean).join('\n').trim() + '\n', folder: dir };
  }

  return {
    root, incomingDir, folder, filePath, list, get: read, create, update, remove, addImage, replaceImage, restoreImage, removeImage, moveImage,
    setStatus, recover, importIncoming, markdown,
    imagesOf: item => item.images.map(image => ({ path: path.join(folder(item.id), image.name), mime: EXT_MIME[image.name.split('.').pop()] }))
  };
}
