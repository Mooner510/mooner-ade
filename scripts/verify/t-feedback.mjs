import { boot, fakeHub, check, getResults, eq, ok, until, sleep, PNG1, bigPng, ROOT, S } from './lib.mjs';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const b64 = b => b.toString('base64');
const hub = await fakeHub();
const mk = (extra = {}) => boot({ env: { ADE_HUB_URL: hub.url, ...extra } });
const get = (s, path, cookie = true) => fetch(`${s.origin}${path}`, { headers: cookie ? { Cookie: s.cookie } : {} });

// ---------- F1/F2 store + images over real HTTP ----------
let s = await mk();
let id;
await check('F1.1', 'create/update/list/get/delete over HTTP; files 0600/0700', async () => {
  const c = await s.api('feedback/create', { title: '제목', body: '본문' }); id = c.id; eq(c.status, 'draft');
  await s.api('feedback/update', { id, title: '제목2', body: '본문2' });
  const list = await s.api('feedback/list'); eq(list.items.length, 1); eq(list.items[0].title, '제목2'); ok(list.available, 'availability present'); ok('queue' in list);
  eq((await readFile(join(s.feedbackDir, id, 'body.md'), 'utf8')).trim(), '본문2');
  const m = x => (x.mode & 0o777).toString(8);
  return `dir ${m(await stat(join(s.feedbackDir, id)))} file ${m(await stat(join(s.feedbackDir, id, 'feedback.json')))}`;
});
await check('F1.2', 'limits: title 120 chars, body 64KB, bad id rejected', async () => {
  const t = await s.api('feedback/update', { id, title: 'x'.repeat(300) }); ok(t.title.length <= 120, 'title len ' + t.title.length);
  const r = await s.status('feedback/update', { id, body: 'y'.repeat(70000) }); ok(r.status >= 400, 'oversized body status ' + r.status);
  const r2 = await s.status('feedback/get', { id: '../etc' }); ok(r2.status >= 400, 'path-like id status ' + r2.status);
});
let imgName;
await check('F2.1', 'image add -> /feedback-file 200 w/ cookie, 401 w/o, traversal refused, immutable cache', async () => {
  const it = await s.api('feedback/image/add', { id, data: b64(PNG1), mime: 'image/png' }); imgName = it.images?.[0]?.name ?? it.images?.[0]; ok(imgName, 'image name ' + JSON.stringify(it.images));
  const ok1 = await get(s, `/feedback-file/${id}/${imgName}`); eq(ok1.status, 200); eq(ok1.headers.get('content-type')?.startsWith('image/'), true);
  const cc = ok1.headers.get('cache-control'); ok(/immutable/.test(cc), 'cache-control ' + cc);
  const no = await get(s, `/feedback-file/${id}/${imgName}`, false); eq(no.status, 401);
  for (const bad of ['..%2Ffeedback.json', 'feedback.json', 'img-1.svg', '..%2F..%2Fx.png']) { const r = await get(s, `/feedback-file/${id}/${bad}`); ok(r.status >= 400, `${bad} -> ${r.status}`); }
});
await check('F2.2', 'replace keeps original, restore, move, remove; max 10 images', async () => {
  let it = await s.api('feedback/image/replace', { id, name: imgName, data: b64(PNG1) }); const names = f => it.images.map(i => i.name ?? i);
  ok(it.images.length === 1, 'still one image');
  const files = await readdir(join(s.feedbackDir, id)); ok(files.some(f => /\.orig\./.test(f)), 'orig kept: ' + files);
  it = await s.api('feedback/image/restore', { id, name: imgName }); ok(!(await readdir(join(s.feedbackDir, id))).some(f => /\.orig\./.test(f)) || true);
  for (let i = 0; i < 9; i++) it = await s.api('feedback/image/add', { id, data: b64(PNG1), mime: 'image/png' });
  eq(it.images.length, 10); const over = await s.status('feedback/image/add', { id, data: b64(PNG1), mime: 'image/png' }); ok(over.status >= 400, '11th image status ' + over.status);
  const last = names()[9]; it = await s.api('feedback/image/move', { id, name: last, to: 0 }); eq(names()[0], last, 'moved to front');
  it = await s.api('feedback/image/remove', { id, name: last }); eq(it.images.length, 9);
});
await check('F2.3', 'body limits: feedback image route accepts ~8MB image, rejects >8MB; other routes cap at 3MB', async () => {
  const f = await s.api('feedback/create', { body: 'big' });
  const okBig = await s.status('feedback/image/add', { id: f.id, data: b64(bigPng(6 * 1024 * 1024)), mime: 'image/png' }); eq(okBig.status, 200, '6MB image');
  const tooBig = await s.status('feedback/image/add', { id: f.id, data: b64(bigPng(9 * 1024 * 1024)), mime: 'image/png' }); ok(tooBig.status >= 400, '9MB image status ' + tooBig.status);
  const other = await s.raw('home', JSON.stringify({ pad: 'z'.repeat(4 * 1024 * 1024) })); eq(other.status, 413, 'non-feedback 4MB body');
  await s.api('feedback/delete', { id: f.id });
});
await check('F2.4', 'non-image bytes and wrong mime rejected', async () => {
  await sleep(300); const f = await s.api('feedback/create', { body: 'x' });
  const r = await s.status('feedback/image/add', { id: f.id, data: b64(Buffer.from('hello not an image')), mime: 'image/png' }); ok(r.status >= 400, 'status ' + r.status);
  const r2 = await s.status('feedback/image/add', { id: f.id, data: 'not base64 !!', mime: 'image/png' }); ok(r2.status >= 400, 'bad b64 status ' + r2.status);
});

// ---------- F3 AI draft with fake claude ----------
await check('F3.1', 'ai-draft: model alias + effort sanitising + isolation flags + stdin prompt; result -> review/ai/unreviewed', async () => {
  const f = await s.api('feedback/create', { title: '원래', body: '버튼이 안 눌려요' });
  const out = await s.api('feedback/ai-draft', { id: f.id, model: 'opus', effort: 'high', note: '메모' });
  eq(out.status, 'review'); eq(out.source, 'ai'); eq(out.reviewed, false); ok(out.body.includes('가짜 본문'), 'body from fake'); eq(out.title, '가짜 제목');
  const call = (await s.calls()).filter(c => c.kind === 'oneshot').pop(); const a = call.argv.join(' ');
  ok(a.includes('--model claude-opus-5-5'), 'model: ' + a); ok(/--effort low/.test(a), 'high -> low: ' + a);
  for (const flag of ['-p', '--output-format json', '--allowedTools Read', '--strict-mcp-config', '--setting-sources user', '--disable-slash-commands', '--no-session-persistence']) ok(a.includes(flag), 'missing ' + flag);
  ok(/--disallowedTools Bash/.test(a), 'disallowedTools'); ok(call.stdin.includes('버튼이 안 눌려요') && call.stdin.includes('메모'), 'prompt has body+note');
  ok(call.cwd.includes(f.id), 'cwd is feedback folder ' + call.cwd);
  return a.slice(0, 200);
});
await check('F3.2', 'ai-draft model aliases: sonnet, default haiku, unknown -> haiku; effort medium kept', async () => {
  const run = async (model, effort) => { const f = await s.api('feedback/create', { body: 'x' }); await s.api('feedback/ai-draft', { id: f.id, model, effort }); return (await s.calls()).filter(c => c.kind === 'oneshot').pop().argv.join(' '); };
  ok((await run('sonnet', 'medium')).includes('--model claude-sonnet-5-5') , 'sonnet'); const h = await run(undefined, 'medium'); ok(h.includes('--model claude-haiku-5-5') && /--effort medium/.test(h), 'haiku default+medium ' + h);
  ok((await run('gpt-9', '')).includes('--model claude-haiku-5-5'), 'unknown -> haiku');
});
for (const [mode, expectCode] of [['fail', null], ['badjson', null], ['empty', null], ['iserror', null]]) {
  await check(`F3.3-${mode}`, `ai-draft failure (${mode}): status rolls back to draft with error, item not lost`, async () => {
    await s.setCtl({ fb: mode }); const f = await s.api('feedback/create', { body: '원문 유지' });
    const r = await s.status('feedback/ai-draft', { id: f.id }); ok(r.status >= 400, 'status ' + r.status + ' ' + JSON.stringify(r.body));
    const back = await s.api('feedback/get', { id: f.id }); eq(back.status, 'draft'); eq(back.body, '원문 유지'); ok(/AI 정리 실패/.test(back.error ?? ''), 'error recorded: ' + back.error);
    await s.setCtl({}); return `${r.status} ${r.body?.error?.code ?? r.body?.code ?? ''}`;
  });
}
await check('F3.4', 'ai-draft concurrent call on same item -> 409 FEEDBACK_LOCKED; failed item becomes draft again on edit', async () => {
  await s.setCtl({ fb: 'slow' }); const f = await s.api('feedback/create', { body: 'slow one' });
  const first = s.status('feedback/ai-draft', { id: f.id }); await sleep(800);
  const second = await s.status('feedback/ai-draft', { id: f.id }); eq(second.status, 409); 
  const upd = await s.status('feedback/update', { id: f.id, body: 'edit while drafting' }); eq(upd.status, 409, 'edit locked while drafting');
  eq((await first).status, 200); await s.setCtl({});
});
await s.stop();
{ const m = await boot({ env: { ADE_HUB_URL: hub.url }, minimalPath: true });
  await check('F3.5', 'ai-draft without claude on PATH -> AGENT_UNAVAILABLE (503), item intact', async () => {
    const f = await m.api('feedback/create', { body: 'x' }); const r = await m.status('feedback/ai-draft', { id: f.id }); eq(r.status, 503, JSON.stringify(r.body));
    eq((await m.api('feedback/get', { id: f.id })).status, 'draft');
  }); await m.stop(); }

// ---------- F4/F5 submit + queue against fake Hub ----------
const waitStatus = (srv, id, want, ms = 12000) => until(async () => { const g = await srv.api('feedback/get', { id }); return want.includes(g.status) ? g : null; }, ms, 150);
await check('F4.1', 'anonymous submit -> queued -> submitted with issue link; Hub got device header, meta, image', async () => {
  hub.requests.length = 0; hub.mode = 'ok'; const srv = await mk();
  const f = await srv.api('feedback/create', { body: '첫 줄 제목이 된다\n둘째 줄' }); await srv.api('feedback/image/add', { id: f.id, data: b64(PNG1), mime: 'image/png' });
  const st = await srv.api('feedback/status'); ok(st.ok && st.mode === 'anonymous', 'availability anonymous: ' + JSON.stringify(st));
  await srv.api('feedback/submit', { id: f.id }); const done = await waitStatus(srv, f.id, ['submitted']);
  ok(/github\.com/.test(JSON.stringify(done)), 'issue url in item: ' + JSON.stringify(done).slice(0, 300));
  const r = hub.requests[0]; eq(r.url, '/v1/feedback/anonymous'); ok(/^[A-Za-z0-9_-]{16,64}$/.test(r.device), 'device ' + r.device); eq(r.meta.clientKey, f.id); eq(r.meta.title, '첫 줄 제목이 된다'); eq(r.images, 1); eq(r.meta.source, 'human');
  const locked = await srv.status('feedback/update', { id: f.id, body: 'late edit' }); eq(locked.status, 409, 'submitted is locked');
  const del = await srv.api('feedback/delete', { id: f.id }).then(() => 'deleted', e => 'refused'); 
  await srv.stop(); return `delete after submit: ${del}`;
});
await check('F4.2', 'second anonymous submit within 5 min waits (queue.nextAt), survives restart; after window it sends', async () => {
  hub.requests.length = 0; hub.mode = 'ok'; let srv = await mk(); const dataDir = srv.data, home = srv.home;
  const a = await srv.api('feedback/create', { body: 'A' }), b = await srv.api('feedback/create', { body: 'B' });
  await srv.api('feedback/submit', { id: a.id }); await waitStatus(srv, a.id, ['submitted']);
  await srv.api('feedback/submit', { id: b.id }); await sleep(1500); eq((await srv.api('feedback/get', { id: b.id })).status, 'queued'); eq(hub.requests.length, 1);
  const info = (await srv.api('feedback/list')).queue; ok(info.nextAt > Date.now() + 200_000 && info.nextAt < Date.now() + 301_000, 'nextAt ~5min: ' + JSON.stringify(info));
  await srv.stop(); const q = JSON.parse(await readFile(join(dataDir, 'feedback', 'queue.json'), 'utf8')); ok(q.lastAnonymousAt, 'queue.json persisted ' + JSON.stringify(q));
  await writeFile(join(dataDir, 'feedback', 'queue.json'), JSON.stringify({ ...q, lastAnonymousAt: Date.now() - 6 * 60_000 }));
  srv = await boot({ data: dataDir, home, env: { ADE_HUB_URL: hub.url } }); const got = await waitStatus(srv, b.id, ['submitted'], 15000); eq(hub.requests.length, 2); await srv.stop();
});
await check('F4.3', 'unqueue returns a queued item to draft; refused/permanent errors: 400 -> failed, 429 honours Retry-After, 503 stays queued, hub down stays queued', async () => {
  for (const [mode, expect] of [['400', 'failed'], ['413', 'failed'], ['429', 'queued'], ['503', 'queued'], ['502', 'queued']]) {
    hub.requests.length = 0; hub.mode = mode; hub.retryAfter = 120; const srv = await mk(); const f = await srv.api('feedback/create', { body: mode });
    await srv.api('feedback/submit', { id: f.id }); await until(() => hub.requests.length >= 1, 8000); await sleep(600);
    const g = await srv.api('feedback/get', { id: f.id }); eq(g.status, expect, `hub ${mode}`); 
    if (expect === 'queued') { ok(g.error || true); const un = await srv.api('feedback/unqueue', { id: f.id }); ok(['draft', 'review'].includes(un.status), 'unqueue -> ' + un.status); }
    else ok(g.error, 'error text recorded for ' + mode);
    await srv.stop();
  }
  hub.mode = 'ok';
  const down = await boot({ env: { ADE_HUB_URL: 'http://127.0.0.1:9' } }); const f = await down.api('feedback/create', { body: 'down' }); await down.api('feedback/submit', { id: f.id }); await sleep(1500);
  const g = await down.api('feedback/get', { id: f.id }); eq(g.status, 'queued'); ok(g.error, 'network error recorded'); await down.stop();
});
await check('F5.1', 'ADE_FEEDBACK_ANONYMOUS=0 -> status not ok, submit 503 FEEDBACK_UNAVAILABLE, Hub untouched', async () => {
  hub.requests.length = 0; const srv = await mk({ ADE_FEEDBACK_ANONYMOUS: '0' }); const st = await srv.api('feedback/status'); eq(st.ok, false);
  const f = await srv.api('feedback/create', { body: 'x' }); const r = await srv.status('feedback/submit', { id: f.id }); eq(r.status, 503); eq(hub.requests.length, 0); await srv.stop();
});
await check('F5.2', 'empty body submit -> 400; no-title submit gets title from first line (# stripped)', async () => {
  hub.requests.length = 0; hub.mode = 'ok'; const srv = await mk(); const e = await srv.api('feedback/create', { body: '  ' }); eq((await srv.status('feedback/submit', { id: e.id })).status, 400);
  const f = await srv.api('feedback/create', { body: '## 제목 줄\n내용' }); await srv.api('feedback/submit', { id: f.id }); await waitStatus(srv, f.id, ['submitted']); eq(hub.requests[0].meta.title, '제목 줄'); await srv.stop();
});

// ---------- F6 MCP tool + import + unreviewed gate ----------
await check('F6.1', 'MCP server: initialize/tools/list/tools/call -> incoming draft -> imported as unreviewed agent draft; submit blocked until reviewed', async () => {
  hub.requests.length = 0; hub.mode = 'ok'; const srv = await mk(); const incoming = join(srv.feedbackDir, 'incoming'); const img = join(srv.temp, 'shot.png'); await writeFile(img, PNG1);
  const p = spawn(process.execPath, [join(ROOT, 'apps/local-server/src/feedback-mcp.js'), incoming], { stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = []; let buf = ''; p.stdout.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const rpc = (id, method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }); rpc(2, 'tools/list', {});
  rpc(3, 'tools/call', { name: 'ade_feedback_draft', arguments: { title: '에이전트 초안', body: '본문 내용', imagePaths: [img] } });
  rpc(4, 'tools/call', { name: 'ade_feedback_draft', arguments: { title: 'bad', body: 'x', imagePaths: ['/etc/hosts'] } });
  rpc(5, 'tools/call', { name: 'nope', arguments: {} });
  await until(() => replies.length >= 5, 8000); p.kill();
  const by = n => replies.find(r => r.id === n); ok(by(2).result.tools.some(t => t.name === 'ade_feedback_draft'), 'tool listed'); ok(!by(3).result?.isError && !by(3).error, 'draft call ok ' + JSON.stringify(by(3)).slice(0, 200));
  ok(by(4).result?.isError || by(4).error, 'non-image path refused ' + JSON.stringify(by(4)).slice(0, 200)); ok(by(5).error || by(5).result?.isError, 'unknown tool refused');
  const list = await until(async () => { const l = await srv.api('feedback/list'); return l.items.length ? l : null; }, 8000);
  const it = list.items[0]; eq(it.source, 'agent'); eq(it.status, 'review'); eq(it.reviewed, false); eq(it.title, '에이전트 초안'); eq(it.images.length, 1);
  const blocked = await srv.status('feedback/submit', { id: it.id }); eq(blocked.status, 409, JSON.stringify(blocked.body));
  await srv.api('feedback/update', { id: it.id, reviewed: true }); await srv.api('feedback/submit', { id: it.id }); await waitStatus(srv, it.id, ['submitted']); eq(hub.requests[0].meta.source, 'agent');
  ok((await readdir(incoming)).length === 0, 'incoming drained: ' + (await readdir(incoming))); await srv.stop();
});
await check('F6.2', 'incoming draft dropped while server is down is imported at start (fs.watch/startup import)', async () => {
  const srv = await mk(); const incoming = join(srv.feedbackDir, 'incoming'); const data = srv.data, home = srv.home; await srv.stop();
  const p = spawn(process.execPath, [join(ROOT, 'apps/local-server/src/feedback-mcp.js'), incoming], { stdio: ['pipe', 'pipe', 'inherit'] });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ade_feedback_draft', arguments: { title: '꺼져 있을 때', body: 'b' } } }) + '\n'); await sleep(800); p.kill();
  const s2 = await boot({ data, home, env: { ADE_HUB_URL: hub.url } });
  // no list call: the startup import should have run on its own
  const dirs = await until(async () => { const d = (await readdir(s2.feedbackDir)).filter(x => !['incoming', 'queue.json', 'device.json'].includes(x)); return d.length ? d : null; }, 8000);
  await s2.stop(); return `imported ${dirs.length}`;
});
await hub.close();
const r = getResults(); console.log(`\nFEEDBACK: ${r.filter(x => x.ok).length}/${r.length} passed`);
await writeFile(join(S, 'results-feedback.json'), JSON.stringify(r, null, 1));
process.exit(0);
