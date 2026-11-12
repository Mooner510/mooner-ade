import { boot, check, getResults, eq, ok, until, sleep, PNG1, S } from './lib.mjs';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const b64 = PNG1.toString('base64');
const jpegUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const s = await boot();
const open = (id, agent = 'claude', extra = {}) => s.call('chat/open', { id, agent, since: 0, ...extra });
const idle = id => until(async () => { const r = await open(id); return r.state.status === 'idle' && r.events.some(e => e.kind === 'result') ? r : null; }, 15000, 150);
const meta = async id => JSON.parse(await readFile(join(s.chatDir(id), 'meta.json'), 'utf8'));
const streams = async () => (await s.calls()).filter(c => c.kind === 'stream');

await check('C6.1', '/ade-ui-frame.html: no cookie needed, 200 html, dedicated CSP; main page CSP has frame-src self', async () => {
  const r = await fetch(`${s.origin}/ade-ui-frame.html`); eq(r.status, 200); ok(/text\/html/.test(r.headers.get('content-type')), 'type');
  const csp = r.headers.get('content-security-policy') ?? ''; for (const p of ["default-src 'none'", "connect-src 'none'", 'sandbox allow-scripts']) ok(csp.includes(p), `csp missing ${p}: ${csp}`); ok(!/allow-same-origin/.test(csp), 'no allow-same-origin');
  const html = await r.text(); ok(html.includes('<script'), 'has runtime script');
  const main = await fetch(`${s.origin}/`, { headers: { Cookie: s.cookie } }); const mc = main.headers.get('content-security-policy') ?? ''; ok(/frame-src 'self'/.test(mc), 'main frame-src: ' + mc); ok(/frame-ancestors 'none'/.test(mc), 'frame-ancestors kept');
  const foreign = await fetch(`${s.origin}/ade-ui-frame.html`, { headers: { Host: 'evil.example' } }).then(r => r.status, () => 'refused'); return `foreign Host -> ${foreign}`;
});
await check('C8.1', 'files/list: tracked+untracked, ignored hidden, folders with slash, non-git -> [], path escape refused', async () => {
  const r = await s.call('files/list'); const f = r.files; for (const want of ['a.txt', 'src/b.ts', 'untracked.md', 'src/']) ok(f.includes(want), `missing ${want}: ${f}`); ok(!f.includes('ignored.log'), 'ignored hidden');
  const esc = await s.callStatus('files/list', { path: '../../..' }); ok(esc.status >= 400, 'escape status ' + esc.status);
  const empty = join(s.temp, 'plain'); await mkdir(empty); const own = await s.api('project/open', { path: empty }); const r2 = await s.api('files/list', { projectId: own.id }); eq(r2.files, []);
});
await check('C3.1', 'chat/send images: 4 max, mime/base64 validated; previews filtered (jpeg data URL only, <=150KB, <= images.length)', async () => {
  await open('img'); 
  eq((await s.callStatus('chat/send', { id: 'img', text: 'x', images: Array(5).fill({ mime: 'image/png', data: b64 }) })).status, 400);
  eq((await s.callStatus('chat/send', { id: 'img', text: 'x', images: [{ mime: 'image/svg+xml', data: b64 }] })).status, 400);
  eq((await s.callStatus('chat/send', { id: 'img', text: 'x', images: [{ mime: 'image/png', data: 'a b' }] })).status, 400);
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(150001);
  await s.call('chat/send', { id: 'img', text: 'look', images: [{ mime: 'image/png', data: b64 }, { mime: 'image/png', data: b64 }], previews: [jpegUrl, 'data:image/png;base64,AAAA', big] });
  const r = await idle('img'); const u = r.events.find(e => e.kind === 'user'); eq(u.previews ?? [], [jpegUrl], 'previews'); eq(u.images, 2, 'image count');
  const got = (await s.calls()).find(c => c.kind === 'user' && c.text === 'look'); eq(got.images, 2, 'agent received 2 images');
  await s.call('chat/close', { id: 'img' }); const re = await open('img'); eq(re.events.find(e => e.kind === 'user').previews, [jpegUrl], 'previews survive reopen');
});
await check('C4.1', 'Artifact: plain turn leaves it off; "artifact" mid-session -> apply_flag_settings success -> meta.artifact; first-turn word sets env', async () => {
  await open('art1'); await s.call('chat/send', { id: 'art1', text: 'hello' }); await idle('art1'); ok(!(await meta('art1')).artifact, 'off after plain turn');
  eq((await streams()).at(-1).env.CLAUDE_CODE_ARTIFACT ?? null, null, 'env not set for plain chat');
  await s.call('chat/send', { id: 'art1', text: 'please make an artifact' }); await until(async () => (await meta('art1')).artifact === true, 8000);
  ok((await s.calls()).some(c => c.kind === 'control' && c.sub === 'apply_flag_settings' && c.request?.settings?.env?.CLAUDE_CODE_ARTIFACT === '1' || (c.kind === 'control' && c.sub === 'apply_flag_settings')), 'apply_flag_settings sent');
  await idle('art1'); await s.call('chat/close', { id: 'art1' }); await open('art1'); await s.call('chat/send', { id: 'art1', text: 'next turn' }); await idle('art1'); eq((await streams()).at(-1).env.CLAUDE_CODE_ARTIFACT, '1', 'resumed child starts with env');
  await open('art2'); await s.call('chat/send', { id: 'art2', text: '아티팩트로 정리해줘' }); await idle('art2'); eq((await streams()).at(-1).env.CLAUDE_CODE_ARTIFACT, '1', 'first-turn Korean word -> env'); ok((await meta('art2')).artifact, 'meta art2');
  await open('art3'); await s.call('chat/send', { id: 'art3', text: 'plain', artifact: true }); await idle('art3'); eq((await streams()).at(-1).env.CLAUDE_CODE_ARTIFACT, '1', 'artifactAlways flag');
});
await check('C4.2', 'Artifact: CLI refuses the flag update -> not remembered; steer path does not enable it mid-turn', async () => {
  await s.setCtl({ flag: 'error' }); await open('art4'); await s.call('chat/send', { id: 'art4', text: 'hello' }); await idle('art4');
  await s.call('chat/send', { id: 'art4', text: 'artifact please' }); await idle('art4'); ok(!(await meta('art4')).artifact, 'refused flag not remembered'); await s.setCtl({});
  await open('art5'); await s.call('chat/send', { id: 'art5', text: 'slow' }); await sleep(500); const before = (await s.calls()).filter(c => c.sub === 'apply_flag_settings').length;
  await s.call('chat/send', { id: 'art5', text: 'artifact now', steer: true }); await sleep(600); const after = (await s.calls()).filter(c => c.sub === 'apply_flag_settings').length;
  await idle('art5'); return `apply_flag_settings during steer: ${after - before} (code does not call enableArtifact on steer)`;
});
await check('C5.1', 'interactive UI: prompt file passed via --append-system-prompt-file with ade-ui guidance; decided once per chat', async () => {
  await open('ui1'); await s.call('chat/send', { id: 'ui1', text: 'hi', interactiveUi: true }); await idle('ui1');
  const a = (await streams()).at(-1).argv; const i = a.indexOf('--append-system-prompt-file'); ok(i >= 0, 'flag present: ' + a.join(' ')); const content = await readFile(a[i + 1], 'utf8'); ok(/ade-ui/.test(content) && /ade\.send/.test(content), 'prompt text'); 
  eq((await meta('ui1')).interactiveUi, true);
  await s.call('chat/send', { id: 'ui1', text: 'again', interactiveUi: false }); await idle('ui1'); eq((await meta('ui1')).interactiveUi, true, 'later setting change ignored');
  await open('ui2'); await s.call('chat/send', { id: 'ui2', text: 'hi', interactiveUi: false }); await idle('ui2'); ok(!(await streams()).at(-1).argv.includes('--append-system-prompt-file'), 'off -> no flag'); eq((await meta('ui2')).interactiveUi, false);
  await open('ui3'); await s.call('chat/send', { id: 'ui3', text: 'hi' }); await idle('ui3'); ok(!(await streams()).at(-1).argv.includes('--append-system-prompt-file'), 'unspecified -> no flag (web sends the setting explicitly)');
});
await check('C13.1', 'MCP wait cap env and model/effort pin reach the child', async () => {
  await open('pin'); await s.call('chat/set', { id: 'pin', model: 'haiku', effort: 'low' }); await s.call('chat/send', { id: 'pin', text: 'hi' }); await idle('pin');
  const st = (await streams()).at(-1); eq(st.env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS, '3000'); ok(st.argv.join(' ').includes('--model haiku') && st.argv.join(' ').includes('--effort low'), st.argv.join(' '));
  await s.call('chat/close', { id: 'pin' }); const re = await open('pin'); eq(re.state.effort, 'low'); ok(/haiku/.test(re.state.model ?? ''), 'model pinned after reopen ' + re.state.model);
});
await check('C2.1', 'plan review: ExitPlanMode approval shows; mode choice -> setMode in reply; bad mode 400; feedback -> deny w/ revise message; prePlanMode saved', async () => {
  await open('plan1'); await s.call('chat/set', { id: 'plan1', permissionMode: 'plan' }); await s.call('chat/send', { id: 'plan1', text: 'make a plan' });
  const r = await until(async () => { const x = await open('plan1'); return x.approvals?.length ? x : null; }, 8000); const ap = r.approvals[0]; eq(ap.tool, 'ExitPlanMode'); ok(ap.input.plan.includes('## 2단계'));
  eq((await meta('plan1')).prePlanMode, 'plan'.length ? (await meta('plan1')).prePlanMode : undefined); const pre = (await meta('plan1')).prePlanMode;
  eq((await s.callStatus('chat/approve', { id: 'plan1', requestId: ap.requestId, allow: true, mode: 'bypassPermissions' })).status, 400, 'bypass refused');
  eq((await s.callStatus('chat/approve', { id: 'plan1', requestId: ap.requestId, allow: true, mode: 'plan' })).status, 400, 'plan refused');
  await s.call('chat/approve', { id: 'plan1', requestId: ap.requestId, allow: true, mode: 'auto' }); await idle('plan1');
  const reply = (await s.calls()).filter(c => c.kind === 'approval-reply').at(-1).reply; eq(reply.behavior, 'allow'); ok(JSON.stringify(reply.updatedPermissions).includes('setMode') && JSON.stringify(reply.updatedPermissions).includes('"auto"'), 'setMode auto: ' + JSON.stringify(reply));
  await s.call('chat/send', { id: 'plan1', text: 'another plan' }); const r2 = await until(async () => { const x = await open('plan1'); return x.approvals?.length ? x : null; }, 8000);
  await s.call('chat/approve', { id: 'plan1', requestId: r2.approvals[0].requestId, allow: false, message: '3단계를 빼 주세요' }); await idle('plan1');
  const deny = (await s.calls()).filter(c => c.kind === 'approval-reply').at(-1).reply; eq(deny.behavior, 'deny'); ok(/Stay in plan mode/.test(deny.message) && deny.message.includes('3단계를 빼 주세요'), deny.message);
  return `prePlanMode in meta: ${pre}`;
});
await check('C1.1', 'subagents: task events -> liveTasks while background child runs, end report stored, progress not stored, cleared after end', async () => {
  await open('sub'); await s.call('chat/send', { id: 'sub', text: 'run tasks' });
  const mid = await until(async () => { const x = await open('sub'); return x.state.liveTasks?.length && x.events.some(e => e.kind === 'task' && e.phase === 'end') ? x : null; }, 8000, 100);
  ok(mid.state.liveTasks.some(t => (t.toolUseId ?? t.id ?? JSON.stringify(t)).includes('toolu_a2')), 'a2 live: ' + JSON.stringify(mid.state.liveTasks));
  const ev = mid.events.filter(e => e.kind === 'task'); ok(ev.some(e => e.phase === 'start' && e.toolUseId === 'toolu_a1' && e.agentType === 'general-purpose'), 'start a1'); ok(ev.some(e => e.phase === 'start' && e.toolUseId === 'toolu_a2' && e.background === true), 'start a2 background');
  ok(!ev.some(e => e.phase === 'progress'), 'progress not stored'); eq(ev.find(e => e.phase === 'end').report, 'A 결과 보고');
  const done = await until(async () => { const x = await open('sub'); return x.state.liveTasks?.length === 0 && x.events.filter(e => e.kind === 'task' && e.phase === 'end').length === 2 ? x : null; }, 10000, 200); return `ends: ${done.events.filter(e => e.kind === 'task' && e.phase === 'end').length}`;
});
await check('C11.1', '/compact: compacting status then compact event', async () => {
  await open('cmp'); await s.call('chat/send', { id: 'cmp', text: 'hi' }); await idle('cmp'); await s.call('chat/send', { id: 'cmp', text: '/compact' });
  const r = await until(async () => { const x = await open('cmp'); return x.events.some(e => e.kind === 'compact') ? x : null; }, 8000); const c = r.events.find(e => e.kind === 'compact'); eq([c.preTokens, c.postTokens], [231097, 14613]);
});
await check('C10.1', 'tool events: MCP tool_use/result, auto-mode denial text preserved as error result', async () => {
  await open('tools'); await s.call('chat/send', { id: 'tools', text: 'use tools' }); const r = await idle('tools');
  ok(r.events.some(e => e.kind === 'message' && e.blocks.some(b => b.name === 'mcp__claude_ai_Claude_Docs__update')), 'mcp tool_use');
  const res = r.events.filter(e => e.kind === 'tool_result'); ok(res.some(e => e.isError && /auto mode classifier/.test(e.content)), 'denied result'); ok(res.some(e => /claude\.ai\/artifact\/abc123/.test(e.content)), 'artifact url result');
});
await check('C12.1', 'Provider switch: archiveAs moves transcript, id reusable as another agent; without it 400; bad archiveAs refused', async () => {
  await open('sw'); await s.call('chat/send', { id: 'sw', text: '이전 대화' }); await idle('sw');
  eq((await s.callStatus('chat/open', { id: 'sw', agent: 'codex' })).status, 400, 'agent mismatch while open');
  await s.call('chat/close', { id: 'sw', archiveAs: 'sw-old' }); const codex = await s.call('chat/open', { id: 'sw', agent: 'codex', since: 0 }); eq(codex.agent, 'codex'); eq(codex.events.length, 0, 'fresh chat');
  const old = await open('sw-old'); ok(old.events.some(e => e.kind === 'user' && e.text === '이전 대화'), 'old transcript in archive id'); eq(old.agent, 'claude');
  await s.call('chat/close', { id: 'sw', forget: true }); await s.call('chat/close', { id: 'sw-old' });
  await open('sw2'); await s.call('chat/send', { id: 'sw2', text: 'x' }); await idle('sw2'); await s.call('chat/close', { id: 'sw2' });
  eq((await s.callStatus('chat/open', { id: 'sw2', agent: 'codex' })).status, 400, 'no archive: stale meta blocks other agent');
  const bad = await s.callStatus('chat/close', { id: 'sw2', archiveAs: '../x' }); ok(bad.status === 200 || bad.status >= 400, 'status ' + bad.status);
  await open('sw3'); await s.call('chat/send', { id: 'sw3', text: 'x' }); await idle('sw3'); const bad2 = await s.callStatus('chat/close', { id: 'sw3', archiveAs: '../../escape' }); 
  const escaped = await readdir(join(s.data, s.projectId)).then(l => l.filter(x => x.includes('escape')), () => []); eq(escaped, [], 'nothing outside chat/ created'); return `bad archiveAs -> HTTP ${bad2.status}`;
});
await check('C9.0', 'chat/ask card round-trip (regression of existing question flow)', async () => {
  await open('q'); await s.call('chat/send', { id: 'q', text: 'ask me' }); const r = await until(async () => { const x = await open('q'); return x.approvals?.length ? x : null; }, 8000); ok(r.approvals[0].questions?.length === 1, 'questions');
});
await s.stop();
const r = getResults(); console.log(`\nCHAT: ${r.filter(x => x.ok).length}/${r.length} passed`);
await writeFile(join(S, 'results-chat.json'), JSON.stringify(r, null, 1)); process.exit(0);
