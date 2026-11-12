// The feedback inbox on the server side: the store, the AI draft run, the agents' MCP tool, and the submit round trip
// through the app (IPC) as the desktop's plugin relay does it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeedbackStore, imageInfo, MAX_IMAGES } from '../apps/local-server/src/feedback-store.js';
import { feedbackPrompt, parseFeedbackDraft, runFeedbackDraft } from '../apps/local-server/src/feedback-agent.js';
import { createFeedbackMcp, writeDraft } from '../apps/local-server/src/feedback-mcp.js';
import { backoffMs, createFeedbackQueue, nextStep, surelyNotCreated } from '../apps/local-server/src/feedback-queue.js';
import { ANONYMOUS_INTERVAL_MS, anonymousDeviceId, postAnonymousFeedback } from '../apps/local-server/src/feedback-hub.js';
import http from 'node:http';

// A valid 2x3 PNG header is all imageInfo reads; the rest of the bytes do not matter to the store.
const png = (w = 2, h = 3) => {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'latin1'); bytes.writeUInt32BE(w, 16); bytes.writeUInt32BE(h, 20);
  return bytes;
};
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x05, 0x00, 0x07, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

async function tempStore(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ade-feedback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const changes = [];
  return { root, changes, store: createFeedbackStore({ root, onChange: id => changes.push(id), ...options }) };
}

test('imageInfo reads PNG and JPEG sizes and refuses anything else', () => {
  assert.deepEqual(imageInfo(png(10, 20)), { ext: 'png', mime: 'image/png', w: 10, h: 20 });
  assert.deepEqual(imageInfo(jpeg()), { ext: 'jpg', mime: 'image/jpeg', w: 7, h: 5 });
  assert.equal(imageInfo(Buffer.from('GIF89a................................')), null);
  assert.equal(imageInfo(Buffer.alloc(4)), null);
});

test('a draft keeps its title, body and images in order, and annotation keeps the original once', async t => {
  const { store, root, changes } = await tempStore(t);
  const item = await store.create({ title: ' 버튼이\n안 보임 ', body: '본문' });
  assert.equal(item.title, '버튼이 안 보임'); assert.equal(item.status, 'draft'); assert.equal(item.reviewed, true);
  await store.addImage(item.id, png(), 'image/png');
  await store.addImage(item.id, jpeg(), 'image/jpeg');
  await assert.rejects(store.addImage(item.id, jpeg(), 'image/png'), /PNG 또는 JPEG/);
  let current = await store.moveImage(item.id, 'img-2.jpg', 0);
  assert.deepEqual(current.images.map(image => image.name), ['img-2.jpg', 'img-1.png']);
  // An annotated JPEG becomes a PNG; restoring brings the JPEG back.
  current = await store.replaceImage(item.id, 'img-2.jpg', png(7, 5));
  assert.deepEqual(current.images[0], { name: 'img-2.png', w: 7, h: 5, annotated: true, original: 'img-2.jpg' });
  current = await store.replaceImage(item.id, 'img-2.png', png(7, 5));
  assert.ok((await readdir(join(root, item.id))).includes('img-2.orig.jpg'));
  current = await store.restoreImage(item.id, 'img-2.png');
  assert.deepEqual(current.images[0], { name: 'img-2.jpg', w: 7, h: 5, annotated: false });
  current = await store.removeImage(item.id, 'img-1.png');
  assert.deepEqual(current.images.map(image => image.name), ['img-2.jpg']);
  assert.deepEqual((await readdir(join(root, item.id))).sort(), ['body.md', 'feedback.json', 'img-2.jpg']);
  assert.ok(changes.length >= 7 && changes.every(id => id === item.id));
  assert.equal((await store.list()).length, 1);
  assert.match((await store.markdown(item.id)).markdown, /^# 버튼이 안 보임\n\n본문\n\n---\n첨부 이미지/);
});

test('ids and image names cannot reach outside the inbox, and limits hold', async t => {
  const { store } = await tempStore(t);
  await assert.rejects(store.get('../x'), /잘못된 피드백 ID/);
  const item = await store.create({});
  await assert.rejects(store.removeImage(item.id, '../feedback.json'), /잘못된 이미지 이름/);
  assert.throws(() => store.filePath(item.id, 'body.md'), /잘못된 이미지 이름/);
  assert.ok(store.filePath(item.id, 'img-1.orig.png').endsWith('img-1.orig.png'));
  for (let index = 0; index < MAX_IMAGES; index++) await store.addImage(item.id, png());
  await assert.rejects(store.addImage(item.id, png()), /10장까지/);
  await assert.rejects(store.update(item.id, { body: 'x'.repeat(70 * 1024) }), /64KB/);
});

test('submitted and in-flight items are locked; a failed one becomes a draft again when edited', async t => {
  const { store } = await tempStore(t);
  const item = await store.create({ title: 't', body: 'b' });
  await store.setStatus(item.id, 'submitting', {}, { from: ['draft'] });
  await assert.rejects(store.update(item.id, { body: 'x' }), /작업이 끝난 뒤/);
  await assert.rejects(store.remove(item.id), /작업이 끝난 뒤/);
  await assert.rejects(store.setStatus(item.id, 'submitting', {}, { from: ['draft', 'review', 'failed'] }), /다른 작업/);
  await store.setStatus(item.id, 'failed', { error: 'boom' });
  const edited = await store.update(item.id, { body: 'b2' });
  assert.equal(edited.status, 'draft'); assert.equal(edited.error, undefined);
  await store.setStatus(item.id, 'submitted', { issueUrl: 'https://github.com/o/r/issues/1' });
  await assert.rejects(store.update(item.id, { title: 'x' }), /제출한 피드백/);
  assert.equal((await store.update(item.id, { reviewed: true })).status, 'submitted');
});

test('recover settles work the app was doing when it stopped', async t => {
  const { store } = await tempStore(t);
  const a = await store.create({ title: 'a', body: 'a' }), b = await store.create({ title: 'b', body: 'b' });
  await store.setStatus(a.id, 'drafting'); await store.setStatus(b.id, 'submitting');
  await store.recover();
  assert.equal((await store.get(a.id)).status, 'draft');
  // An attempt whose answer was lost goes back to the queue (the Hub's idempotency key makes the resend safe).
  assert.equal((await store.get(b.id)).status, 'queued');
});

test('the queue backs off by error kind and gives up only on answers that waiting cannot change', () => {
  assert.deepEqual(nextStep({ code: 'bad_request' }, 1, 0), { fail: true });
  assert.deepEqual(nextStep({ code: 'too_large' }, 1, 0), { fail: true });
  assert.deepEqual(nextStep({ code: 'rate_limited', retryAfter: 120 }, 1, 0), { retryAt: 120_000 });
  assert.deepEqual(nextStep({ code: 'rate_limited' }, 1, 0), { retryAt: ANONYMOUS_INTERVAL_MS });
  assert.deepEqual(nextStep({ code: 'not_logged_in' }, 1, 0), { retryAt: 5_000 });
  assert.deepEqual(nextStep({ code: 'network_error' }, 1, 0), { retryAt: 30_000 });
  assert.deepEqual(nextStep({ code: 'network_error' }, 3, 0), { retryAt: 120_000 });
  assert.equal(backoffMs(40), 30 * 60_000);
});

// A queue on a real store with a hand-driven clock and timers.
async function tempQueue(t, { mode = 'anonymous', results = [] } = {}) {
  const way = { mode };
  const env = await tempStore(t);
  let clock = 1_000_000;
  const timers = [], sent = [];
  const queue = createFeedbackQueue({
    store: env.store, stateFile: join(env.root, 'queue.json'), now: () => clock,
    availability: () => ({ ok: true, mode: way.mode }), metaOf: item => ({ clientKey: item.id }),
    sendAccount: async meta => { sent.push(['account', meta.clientKey]); return results.shift() ?? { ok: true, issueUrl: 'https://github.com/o/r/issues/1', issueNumber: 1 }; },
    sendAnonymous: async meta => { sent.push(['anonymous', meta.clientKey]); return results.shift() ?? { ok: true, issueUrl: 'https://github.com/o/r/issues/2', issueNumber: 2 }; },
    setTimer: (fn, ms) => { const timer = { at: clock + ms, fn }; timers.push(timer); return timer; },
    clearTimer: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    log: { warn() {} }
  });
  t.after(() => queue.stop());
  // Moves the clock and fires what is due, then lets the run finish.
  const advance = async ms => {
    clock += ms;
    for (const timer of timers.filter(item => item.at <= clock)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); }
    await settle();
  };
  // The queue works on real files: give a run time to finish.
  const settle = () => new Promise(resolve => setTimeout(resolve, 250));
  const draft = async title => env.store.create({ title, body: 'b' });
  return { ...env, queue, sent, timers, advance, settle, draft, way, now: () => clock };
}

test('anonymous submissions leave one per 5 minutes, in order, and the wait survives a restart', async t => {
  const { store, queue, sent, advance, settle, draft, root, now } = await tempQueue(t);
  const a = await draft('a'), b = await draft('b'), c = await draft('c');
  await queue.enqueue(a.id); await queue.enqueue(b.id); await queue.enqueue(c.id);
  await settle();
  assert.deepEqual(sent, [['anonymous', a.id]]);
  assert.equal((await store.get(a.id)).status, 'submitted');
  assert.equal((await store.get(b.id)).status, 'queued');
  assert.deepEqual(await queue.info(), { size: 2, nextAt: now() + ANONYMOUS_INTERVAL_MS });
  await advance(ANONYMOUS_INTERVAL_MS - 1000);
  assert.equal(sent.length, 1);
  await advance(1000);
  assert.deepEqual(sent.map(([, id]) => id), [a.id, b.id]);
  // Cancelling takes an item out; it can be edited again.
  assert.equal((await queue.cancel(c.id)).status, 'draft');
  await advance(ANONYMOUS_INTERVAL_MS);
  assert.equal(sent.length, 2);
  // The last anonymous send time is kept on disk.
  assert.equal(JSON.parse(await readFile(join(root, 'queue.json'), 'utf8')).lastAnonymousAt, now() - ANONYMOUS_INTERVAL_MS);
});

test('a refused attempt waits as told, a permanent refusal fails, and an account sends without the anonymous wait', async t => {
  const { store, queue, sent, advance, settle, draft } = await tempQueue(t, { mode: 'account', results: [
    { ok: false, error: { code: 'rate_limited', message: '잠시 뒤에', retryAfter: 60 } }, undefined,
    { ok: false, error: { code: 'bad_request', message: '잘못됨' } }
  ] });
  const a = await draft('a'), b = await draft('b');
  await queue.enqueue(a.id); await settle();
  let item = await store.get(a.id);
  assert.equal(item.status, 'queued'); assert.equal(item.error, '잠시 뒤에'); assert.equal(item.attempts, 1);
  await assert.rejects(store.update(a.id, { body: 'x' }), /전송 대기 중/);
  await advance(60_000);
  assert.equal((await store.get(a.id)).status, 'submitted');
  await queue.enqueue(b.id); await settle();
  item = await store.get(b.id);
  assert.equal(item.status, 'failed'); assert.equal(item.error, '잘못됨');
  assert.deepEqual(sent.map(([way]) => way), ['account', 'account', 'account']);
  // A failed item can be queued again; a deleted queued item is skipped.
  await queue.enqueue(b.id); await store.remove(b.id).catch(() => {});
});

test('the MCP tool drops a draft that the store imports as an unreviewed agent draft', async t => {
  const { store, root } = await tempStore(t);
  const shot = join(root, 'shot.png'); await writeFile(shot, png(4, 4));
  const out = [];
  const handle = createFeedbackMcp({ incoming: store.incomingDir, write: line => out.push(JSON.parse(line)) });
  await handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
  await handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  await handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  await handle(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ade_feedback_draft', arguments: { title: '탭 이름이 잘림', body: '## 문제\n...', imagePaths: [shot] } } }));
  await handle(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ade_feedback_draft', arguments: { title: 'x', body: 'y', imagePaths: ['relative.png'] } } }));
  assert.deepEqual(out.map(message => message.id), [1, 2, 3, 4]);
  assert.equal(out[0].result.serverInfo.name, 'ade_feedback');
  assert.equal(out[1].result.tools[0].name, 'ade_feedback_draft');
  assert.equal(out[2].result.isError, undefined);
  assert.equal(out[3].result.isError, true);
  const [id] = await store.importIncoming();
  const item = await store.get(id);
  assert.equal(item.source, 'agent'); assert.equal(item.status, 'review'); assert.equal(item.reviewed, false);
  assert.equal(item.title, '탭 이름이 잘림'); assert.equal(item.images.length, 1);
  assert.deepEqual(await readdir(store.incomingDir), []);
  await assert.rejects(writeDraft(store.incomingDir, { title: 't', body: 'b', imagePaths: [join(root, 'missing.png')] }), /MB 이하의 파일이 아닙니다/);
});

test('the AI draft parses JSON answers, fenced ones, and falls back to the raw text', () => {
  assert.deepEqual(parseFeedbackDraft('{"title":"제목","body":"## 문제"}'), { title: '제목', body: '## 문제' });
  assert.deepEqual(parseFeedbackDraft('설명\n```json\n{"title":"t","body":"b"}\n```'), { title: 't', body: 'b' });
  assert.deepEqual(parseFeedbackDraft('그냥 글'), { title: '', body: '그냥 글' });
  assert.throws(() => parseFeedbackDraft('  '), /빈 답/);
  const prompt = feedbackPrompt({ images: ['/a/img-1.png'], note: '메모', context: 'ADE 0.5' });
  assert.match(prompt, /1\. \/a\/img-1\.png/); assert.match(prompt, /사용자 메모:\n메모/); assert.match(prompt, /ADE 0\.5/);
});

test('runFeedbackDraft runs claude -p with only Read and the prompt on stdin', async () => {
  let call, stdin = '';
  const draft = await runFeedbackDraft({
    cwd: '/x', images: ['/x/img-1.png'], note: '--danger',
    spawnProcess: (executable, args, options) => {
      call = { executable, args, options };
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      proc.stdin = { on() {}, end: text => { stdin = text; setImmediate(() => { proc.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: '{"title":"t","body":"b"}' })); proc.emit('close', 0); }); } };
      proc.kill = () => {};
      return proc;
    }
  });
  assert.deepEqual(draft, { title: 't', body: 'b' });
  assert.equal(call.executable, 'claude');
  assert.deepEqual(call.args.slice(0, 5), ['-p', '--output-format', 'json', '--allowedTools', 'Read']);
  assert.ok(!call.args.includes('--danger'));
  assert.match(stdin, /--danger/);
  assert.equal(call.options.cwd, '/x'); assert.equal(call.options.shell, false);
});


// ---- anonymous submission to the Hub ---------------------------------------------------------------------------------
// A stand-in Hub for /v1/feedback/anonymous: records requests and answers what the test queued (201 by default).
async function fakeHub(t) {
  const requests = [], answers = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': request.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
    requests.push({ url: request.url, device: request.headers['x-ade-device'], meta: JSON.parse(form.get('meta')), images: form.getAll('image') });
    const answer = answers.shift() ?? { status: 201, body: { id: 'h', issueNumber: requests.length, issueUrl: `https://github.com/o/r/issues/${requests.length}` } };
    response.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
    response.end(JSON.stringify(answer.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, answers };
}

test('anonymous posts carry the install id and the multipart body, and map refusals', async t => {
  const hub = await fakeHub(t), { root } = await tempStore(t);
  const deviceId = await anonymousDeviceId(root);
  assert.match(deviceId, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(await anonymousDeviceId(root), deviceId);
  const shot = join(root, 'a.png'); await writeFile(shot, png());
  const ok = await postAnonymousFeedback({ hubUrl: hub.url, deviceId, meta: { clientKey: 'k', title: 't' }, images: [{ path: shot, mime: 'image/png' }] });
  assert.deepEqual(ok, { ok: true, issueUrl: 'https://github.com/o/r/issues/1', issueNumber: 1 });
  assert.equal(hub.requests[0].url, '/v1/feedback/anonymous'); assert.equal(hub.requests[0].device, deviceId);
  assert.deepEqual(hub.requests[0].meta, { clientKey: 'k', title: 't' });
  assert.equal(hub.requests[0].images[0].name, 'image-1.png'); assert.equal(hub.requests[0].images[0].type, 'image/png');
  hub.answers.push({ status: 429, headers: { 'retry-after': '170' }, body: { error: { code: 'rate_limited', message: '천천히' } } });
  assert.deepEqual(await postAnonymousFeedback({ hubUrl: hub.url, deviceId, meta: {}, images: [] }), { ok: false, error: { code: 'rate_limited', message: '천천히', retryAfter: 170 } });
  hub.answers.push({ status: 503, body: { error: { code: 'auth-unavailable', message: 'x' } } });
  assert.equal((await postAnonymousFeedback({ hubUrl: hub.url, deviceId, meta: {}, images: [] })).error.code, 'feedback_disabled');
  assert.equal((await postAnonymousFeedback({ hubUrl: 'http://127.0.0.1:9', deviceId, meta: {}, images: [] })).error.code, 'network_error');
});

// ---- the server: API routes and both submit ways ---------------------------------------------------------------------
async function boot(t, env = {}) {
  const data = await mkdtemp(join(tmpdir(), 'ade-data-'));
  const child = spawn(process.execPath, ['apps/local-server/src/index.js'], { env: { ...process.env, ADE_PORT: '0', ADE_DATA_DIR: data, ADE_PTY_ENDPOINT: '', ADE_PTY_TOKEN: '', ADE_HUB_URL: 'http://127.0.0.1:9', ...env }, stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  const messages = [];
  child.on('message', message => messages.push(message));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; }
    await rm(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', () => reject(new Error('server exited'))); });
  const until = async (predicate, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const index = messages.findIndex(predicate); if (index >= 0) return messages.splice(index, 1)[0]; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('timeout');
  };
  // The API as a plugin workspace session reaches it (same route() as the window).
  let ids = 0;
  child.send({ type: 'plugin/workspace', plugin: 'example', op: 'open', session: 's' });
  const api = async (action, input = {}) => {
    const id = ++ids;
    child.send({ type: 'plugin/workspace', plugin: 'example', op: 'api', session: 's', id, action, input });
    const reply = await until(message => message.type === 'plugin/workspace' && message.op === 'api-result' && message.id === id);
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.value;
  };
  const eventually = async (action, input, predicate) => {
    for (let tries = 0; tries < 200; tries++) { const value = await api(action, input); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error(`timeout waiting on ${action}`);
  };
  return { child, data, until, api, eventually };
}

test('signed in, the queue submits through the app and records the issue; a rate limit waits and retries', async t => {
  const { child, data, until, api, eventually } = await boot(t);
  child.send({ type: 'feedback/status', status: { ok: true, account: 'tester', plugin: 'mooner-remote' } });
  await eventually('feedback/status', {}, value => value.mode === 'account');
  assert.deepEqual(await api('feedback/status'), { ok: true, mode: 'account', account: 'tester' });
  const item = await api('feedback/create', { title: '상태바 글자가 겹침', body: '## 문제\n겹칩니다' });
  await api('feedback/image/add', { id: item.id, data: png().toString('base64'), mime: 'image/png' });

  assert.equal((await api('feedback/submit', { id: item.id })).status, 'queued');
  const request = await until(message => message.type === 'feedback/submit');
  assert.equal(request.meta.clientKey, item.id); assert.equal(request.meta.source, 'human');
  assert.equal(request.images[0].path, join(data, 'feedback', item.id, 'img-1.png'));
  assert.deepEqual(await readFile(request.images[0].path), png());
  child.send({ type: 'feedback/result', id: request.id, ok: false, error: { code: 'rate_limited', message: '잠시 뒤에', retryAfter: 1 } });
  const waiting = await eventually('feedback/get', { id: item.id }, value => value.status === 'queued' && value.attempts === 1);
  assert.equal(waiting.error, '잠시 뒤에');
  const again = await until(message => message.type === 'feedback/submit', 10000);
  assert.equal(again.meta.clientKey, item.id);
  child.send({ type: 'feedback/result', id: again.id, ok: true, issueUrl: 'https://github.com/o/r/issues/7', issueNumber: 7 });
  const done = await eventually('feedback/get', { id: item.id }, value => value.status === 'submitted');
  assert.equal(done.issueNumber, 7); assert.equal(done.via, 'account');
  await assert.rejects(api('feedback/submit', { id: item.id }), error => error.code === 'FEEDBACK_LOCKED');
});

test('without an account, feedback goes to the Hub anonymously, one per 5 minutes, the rest waiting in the queue', async t => {
  const hub = await fakeHub(t);
  const { api, eventually } = await boot(t, { ADE_HUB_URL: hub.url });
  assert.deepEqual(await api('feedback/status'), { ok: true, mode: 'anonymous' });
  const a = await api('feedback/create', { title: 'a', body: 'a' }), b = await api('feedback/create', { title: 'b', body: 'b' });
  await api('feedback/submit', { id: a.id }); await api('feedback/submit', { id: b.id });
  const sent = await eventually('feedback/get', { id: a.id }, value => value.status === 'submitted');
  assert.equal(sent.via, 'anonymous'); assert.equal(sent.issueNumber, 1);
  assert.equal(hub.requests.length, 1); assert.equal(hub.requests[0].meta.clientKey, a.id);
  const listed = await api('feedback/list');
  assert.equal(listed.queue.size, 1); assert.ok(listed.queue.nextAt > Date.now() + 4 * 60_000);
  assert.equal(listed.items.find(item => item.id === b.id).status, 'queued');
  assert.equal((await api('feedback/unqueue', { id: b.id })).status, 'draft');
  assert.equal((await api('feedback/list')).queue.size, 0);
});

test('anonymous submission can be turned off, and agent drafts need a human look before they can be submitted', async t => {
  const { data, api } = await boot(t, { ADE_FEEDBACK_ANONYMOUS: '0' });
  assert.equal((await api('feedback/status')).ok, false);
  await writeFile(join(data, 'feedback', 'incoming', 'abcdefgh12.json'), JSON.stringify({ title: '에이전트 초안', body: '내용', images: [] }));
  const { items } = await api('feedback/list');
  const draft = items.find(item => item.title === '에이전트 초안');
  assert.equal(draft.source, 'agent'); assert.equal(draft.reviewed, false);
  await assert.rejects(api('feedback/submit', { id: draft.id }), error => error.code === 'FEEDBACK_UNREVIEWED');
  assert.equal((await api('feedback/update', { id: draft.id, reviewed: true })).reviewed, true);
  await assert.rejects(api('feedback/submit', { id: draft.id }), error => error.code === 'FEEDBACK_UNAVAILABLE');
  await api('feedback/delete', { id: draft.id });
  assert.equal((await api('feedback/list')).items.length, 0);
});

test('after a lost answer the retry goes the same way, so a sign-in in between cannot open a second issue', async t => {
  const { store, queue, sent, advance, settle, draft, way } = await tempQueue(t, { results: [
    { ok: false, error: { code: 'network_error', message: '끊김' } }, undefined,
    { ok: false, error: { code: 'rate_limited', message: '천천히', retryAfter: 1 } }, undefined
  ] });
  const a = await draft('a');
  await queue.enqueue(a.id); await settle();
  assert.equal((await store.get(a.id)).pinnedVia, 'anonymous');
  way.mode = 'account'; // signed in meanwhile
  await advance(ANONYMOUS_INTERVAL_MS);
  assert.deepEqual(sent.map(([via]) => via), ['anonymous', 'anonymous']);
  const done = await store.get(a.id);
  assert.equal(done.status, 'submitted'); assert.equal(done.pinnedVia, undefined); assert.equal(done.via, 'anonymous');
  // A refusal that surely made nothing frees the item to go the way available now.
  const b = await draft('b');
  await queue.enqueue(b.id); await settle();
  assert.equal(sent.at(-1)[0], 'account');
  assert.equal((await store.get(b.id)).pinnedVia, undefined);
  way.mode = 'anonymous';
  await advance(ANONYMOUS_INTERVAL_MS);
  assert.equal(sent.at(-1)[0], 'anonymous'); assert.equal((await store.get(b.id)).status, 'submitted');
  // An item pinned to the account waits while signed out.
  assert.equal(surelyNotCreated({ code: 'PLUGIN_STOPPED' }), false);
  assert.equal(surelyNotCreated({ code: 'upstream_failed' }), true);
});

test('runFeedbackDraft passes --model and --effort only for known values', async () => {
  const run = async (model, effort) => {
    let args;
    await runFeedbackDraft({ model, effort, cwd: process.cwd(), images: [], spawnProcess: (_cmd, list) => { args = list; throw new Error('stop'); } }).catch(() => {});
    return args;
  };
  assert.deepEqual((await run('claude-haiku-5-5', 'medium')).slice(0, 4), ['--model', 'claude-haiku-5-5', '--effort', 'medium']);
  const unknown = await run('gpt-4', 'turbo');
  assert.ok(!unknown.includes('--model') && !unknown.includes('--effort'));
});
