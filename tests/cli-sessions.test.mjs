import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliProjectFolder, importCliSession, listCliSessions } from '../apps/local-server/src/cli-sessions.js';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const line = (type, message, extra = {}) => JSON.stringify({ type, message, timestamp: '2026-11-10T01:00:00.000Z', uuid: crypto.randomUUID(), ...extra });
const transcript = prompt => [line('user', { role: 'user', content: prompt }), line('assistant', { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '답변' }] })].join('\n') + '\n';

test('plain CLI conversations of the project are listed, deduped against ADE chats, and imported', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ade-cli-sessions-')), dir = join(root, 'claude'), directory = join(root, 'data'), cwd = join(root, 'project');
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = cliProjectFolder(dir, cwd);
  await mkdir(folder, { recursive: true }); await mkdir(join(directory, 'chat', 'known'), { recursive: true });
  await writeFile(join(folder, `${A}.jsonl`), transcript('첫 번째\n작업'));
  await writeFile(join(folder, `${B}.jsonl`), transcript('이미 가져온 대화'));
  await writeFile(join(folder, `${C}.jsonl`), line('system', {}, { subtype: 'init' }) + '\n'); // nothing the user said: skipped
  await writeFile(join(folder, 'not-a-session.jsonl'), transcript('무시'));
  await writeFile(join(directory, 'chat', 'known', 'meta.json'), JSON.stringify({ sessionId: B }));

  const sessions = await listCliSessions({ directory, cwd, configDirs: [dir, dir] });
  assert.deepEqual(sessions.map(item => item.sessionId).sort(), [A, B].sort());
  assert.equal(sessions.find(item => item.sessionId === A).title, '첫 번째 작업');
  assert.equal(sessions.find(item => item.sessionId === A).chatId, null);
  assert.equal(sessions.find(item => item.sessionId === B).chatId, 'known');
  assert.deepEqual(await listCliSessions({ directory, cwd: join(root, 'elsewhere'), configDirs: [dir] }), []);

  const { events } = await importCliSession({ directory, id: 'imported', sessionId: A, cwd, configDirs: [dir] });
  assert.ok(events >= 2);
  const meta = JSON.parse(await readFile(join(directory, 'chat', 'imported', 'meta.json'), 'utf8'));
  assert.equal(meta.sessionId, A); assert.equal(meta.configDir, dir);
  await assert.rejects(importCliSession({ directory, id: 'x', sessionId: '../etc', cwd, configDirs: [dir] }), { code: 'INVALID_INPUT' });
  await assert.rejects(importCliSession({ directory, id: 'x', sessionId: '44444444-4444-4444-8444-444444444444', cwd, configDirs: [dir] }), { code: 'NOT_FOUND' });
});

test('titles prefer the rename, then the AI title, and skip slash commands and paste wrappers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ade-cli-title-')), dir = join(root, 'claude'), cwd = join(root, 'project');
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = cliProjectFolder(dir, cwd), D = '55555555-5555-4555-8555-555555555555', E = '66666666-6666-4666-8666-666666666666', F = '77777777-7777-4777-8777-777777777777';
  await mkdir(folder, { recursive: true });
  const ai = title => JSON.stringify({ type: 'ai-title', aiTitle: title }), custom = title => JSON.stringify({ type: 'custom-title', customTitle: title });
  const NL = String.fromCharCode(10);
  await writeFile(join(folder, `${A}.jsonl`), [line('user', { role: 'user', content: '/clear' }), ai('첫 제목'), transcript('질문') + ai('나중 제목')].join(NL) + NL);
  await writeFile(join(folder, `${D}.jsonl`), [ai('AI 제목'), custom('내가 붙인 이름'), transcript('질문')].join(NL));
  await writeFile(join(folder, `${E}.jsonl`), [line('user', { role: 'user', content: '/effort medium' }), transcript('<pasted_content id="a1"> 붙여넣은 내용 </pasted_content>')].join(NL));
  await writeFile(join(folder, `${F}.jsonl`), line('user', { role: 'user', content: '/clear' }) + NL); // commands only: skipped
  const titles = Object.fromEntries((await listCliSessions({ directory: join(root, 'data'), cwd, configDirs: [dir] })).map(item => [item.sessionId, item.title]));
  assert.deepEqual(titles, { [A]: '나중 제목', [D]: '내가 붙인 이름', [E]: '붙여넣은 내용' });
});

test('a conversation still open in a running claude is refused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ade-cli-live-')), dir = join(root, 'claude'), cwd = join(root, 'project');
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = cliProjectFolder(dir, cwd);
  await mkdir(folder, { recursive: true }); await mkdir(join(dir, 'sessions'), { recursive: true });
  await writeFile(join(folder, `${A}.jsonl`), transcript('실행 중'));
  await writeFile(join(dir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: A, cwd }));
  assert.equal((await listCliSessions({ directory: join(root, 'data'), cwd, configDirs: [dir] }))[0].running, true);
  await assert.rejects(importCliSession({ directory: join(root, 'data'), id: 'x', sessionId: A, cwd, configDirs: [dir] }), { code: 'CHAT_SWITCH_UNSAFE' });
});
