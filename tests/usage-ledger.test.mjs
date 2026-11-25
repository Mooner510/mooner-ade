import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { consumeEvents, createUsageLedger, turnIdentity } from '../apps/local-server/src/usage-ledger.js';
import { EVAL_HOLD, buildReport, paceOf } from '../apps/local-server/src/usage-report.js';
import { dirAccountKey, identityFromProfile } from '../apps/local-server/src/usage-accounts.js';

const result = (over) => ({ kind: 'result', status: 'success', at: 1_700_000_000_000, seq: 1, sessionId: 'sess', ...over });

test('Claude result usage is the turn itself, Codex usage events are a running total', () => {
  const claude = consumeEvents([
    result({ usage: { input: 10, output: 2, cacheRead: 0, cacheCreate: 0 }, costUsd: 0.1, turnCostUsd: 0.1 }),
    result({ at: 1_700_000_000_000 + 1000, seq: 2, usage: { input: 4, output: 1, cacheRead: 3, cacheCreate: 0 }, costUsd: 0.2, turnCostUsd: 0.1 })
  ], {}, { projectId: 'p', chatId: 'c', provider: 'claude', accountKey: 'unknown:claude:x', auth: 'login', source: 'backfill', deviceId: 'd', projectLabel: 'app' });
  assert.equal(claude.turns[0].tokens.input, 10);
  assert.equal(claude.turns[1].tokens.input, 4);
  assert.equal(claude.turns[1].tokens.cacheRead, 3);
  assert.equal(claude.turns[0].turnCostUsd, 0.1);
  const codex = consumeEvents([
    { kind: 'usage', tokens: { input: 100, output: 0, cacheRead: 0, cacheCreate: 0 }, at: 1 },
    result({ at: 2, costUsd: null }),
    { kind: 'usage', tokens: { input: 140, output: 10, cacheRead: 0, cacheCreate: 0 }, at: 3 },
    result({ at: 4, seq: 2, costUsd: null })
  ], {}, { projectId: 'p', chatId: 'c', provider: 'codex', accountKey: 'codex:a', auth: 'login', source: 'live', deviceId: 'd', projectLabel: 'app' });
  assert.equal(codex.turns[0].tokens.input, 100);
  assert.equal(codex.turns[1].tokens.input, 40);
  assert.equal(codex.turns[1].tokens.output, 10);
  assert.equal(codex.turns[0].turnCostUsd, null);
});

test('a copied /clear transcript is one turn, and deleting the chat folder keeps the ledger', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-ledger-'));
  const data = path.join(root, 'data');
  const project = path.join(data, 'proj');
  const write = async (id, at) => {
    const dir = path.join(project, 'chat', id);
    await fs.mkdir(dir, { recursive: true });
    const event = { kind: 'result', status: 'success', at, seq: 1, sessionId: 'same', usage: { input: 3, output: 1, cacheRead: 0, cacheCreate: 0 }, turnCostUsd: 0.2, auth: 'login' };
    await fs.writeFile(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\n');
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ agent: 'claude', cwd: '/work/app', configDir: '/acc', sessionId: 'same', auth: 'login' }));
  };
  await write('chat-a', 1_700_000_100_000);
  await write('chat-b', 1_700_000_100_000);
  const ledger = createUsageLedger({ root: path.join(data, 'usage-ledger'), deviceId: 'device-1', keyOf: () => 'claude:abc' });
  await ledger.backfill(data);
  await fs.rm(project, { recursive: true, force: true });
  const review = await ledger.review({});
  assert.equal(review.turns, 1);
  assert.equal(review.tokens.input, 3);
  assert.equal(review.costUsd, 0.2);
  const again = await ledger.backfill(data);
  assert.equal(again, undefined);
  assert.equal((await ledger.review({})).turns, 1);
  const text = await fs.readFile(path.join(data, 'usage-ledger', 'turns.jsonl'), 'utf8');
  assert.match(text, /"source":"backfill"/);
  assert.equal(await ledger.dayCacheFresh(), true);
  await fs.writeFile(path.join(data, 'usage-ledger', 'days', 'index.json'), JSON.stringify({ sourceBytes: 1, days: [] }));
  assert.equal(await ledger.dayCacheFresh(), false);
  await ledger.review({});
  assert.equal(await ledger.dayCacheFresh(), true);
});

test('snapshots stay per device and a repeated reading inside 15 minutes is skipped', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-ledger-'));
  let clock = 1_000_000;
  const ledger = createUsageLedger({ root, deviceId: 'local-device', now: () => clock });
  const resetsAt = 90_000_000;
  const reading = (percent, at) => ({ provider: 'claude', at, plan: 'Max', account: { dir: '/acc' }, windows: [{ key: 'weekly', label: '주간', percent, resetsAt }], identity: identityFromProfile('claude', { organization: { id: 'org-1', plan_display_name: 'Max' } }, '/acc') });
  assert.equal(await ledger.observeSnapshot(reading(10, clock)), true);
  clock += 60_000;
  assert.equal(await ledger.observeSnapshot(reading(10, clock)), false);
  clock += 16 * 60_000;
  assert.equal(await ledger.observeSnapshot(reading(10, clock)), true);
  clock += 1000;
  assert.equal(await ledger.observeSnapshot(reading(40, clock)), true);
  await ledger.importRemote({ batches: [{ localId: 'other-device', name: '다른 PC', platform: 'darwin', records: [{ id: 'remote-turn', kind: 'turn', at: 1_500_000, payload: { projectId: 'p2', chatId: 'c2', provider: 'codex', accountKey: 'codex:acc', auth: 'login', model: 'gpt', tokens: { input: 8, output: 0, cacheRead: 0, cacheCreate: 0 }, turnCostUsd: null, status: 'success', durationMs: 0, toolCalls: 0, toolErrors: 0, tools: [], compactions: 0, projectLabel: 'other' } }, { id: 'remote-snap', kind: 'snapshot', at: clock, payload: { provider: 'codex', accountKey: 'codex:acc', plan: 'plus', windows: [{ key: 'weekly', label: '주간', percent: 3, resetsAt: null }], deviceName: '다른 PC' } }] }] });
  const combined = await ledger.review({ device: 'all' });
  assert.equal(combined.turns, 1);
  assert.equal(combined.providers.some(row => row.key === 'codex'), true);
  assert.ok(combined.snapshots.some(shot => shot.deviceId === 'local-device'));
  assert.ok(combined.snapshots.some(shot => shot.deviceId === 'other-device' && shot.provider === 'codex'));
  const local = await ledger.review({ device: 'local' });
  assert.equal(local.turns, 0);
  const other = await ledger.review({ device: 'other-device' });
  assert.equal(other.turns, 1);
  assert.equal(other.snapshots.every(shot => shot.deviceId === 'other-device'), true);
});

test('a folder with one confirmed login is grouped, and a second login is not', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-ledger-'));
  const data = path.join(root, 'data');
  const dir = path.join(data, 'proj', 'chat', 'c');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'events.jsonl'), JSON.stringify({ kind: 'result', status: 'success', at: 1_700_000_300_000, seq: 1, sessionId: 's', usage: { input: 1, output: 0, cacheRead: 0, cacheCreate: 0 } }) + '\n');
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ agent: 'claude', cwd: '/work/app', configDir: '/acc', auth: 'login' }));
  const ledger = createUsageLedger({ root: path.join(data, 'usage-ledger'), deviceId: 'd' });
  await ledger.backfill(data);
  const dirKey = dirAccountKey('claude', '/acc');
  await ledger.observeLogin(identityFromProfile('claude', { organization: { id: 'org-1', plan_display_name: 'Max' } }, '/acc'), '/acc');
  const grouped = await ledger.review({});
  assert.equal(grouped.aliasedTurns, 1);
  assert.equal(grouped.accounts.length, 1);
  assert.equal(grouped.accounts[0].key.startsWith('claude:org-1'), true);
  await ledger.observeLogin(identityFromProfile('claude', { organization: { id: 'org-2' } }, '/acc'), '/acc');
  const split = await ledger.review({});
  assert.equal(split.aliasedTurns, 0);
  assert.equal(split.accounts[0].key, dirKey);
});

test('the same turn id is stable and a provider filter drops the other agents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-ledger-'));
  const ledger = createUsageLedger({ root, deviceId: 'd' });
  const file = path.join(root, 'one.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const line = (seq, provider) => JSON.stringify({ kind: 'result', status: 'failed', at: 1_700_000_400_000 + seq, seq, sessionId: `s${seq}`, usage: { input: 1, output: 0, cacheRead: 0, cacheCreate: 0 } });
  await fs.writeFile(file, `${line(1, 'claude')}\n`);
  await fs.writeFile(path.join(root, 'meta.json'), JSON.stringify({ agent: 'cursor', cwd: '/work/app' }));
  await ledger.ingestFile({ file, projectId: 'p', chatId: 'c', meta: { agent: 'cursor', cwd: '/work/app', auth: 'login' } });
  await ledger.ingestFile({ file, projectId: 'p', chatId: 'c', meta: { agent: 'cursor', cwd: '/work/app', auth: 'login' } });
  const id = turnIdentity({ projectId: 'p', chatId: 'c', seq: 1, at: 1, provider: 'cursor', sessionId: 's1', status: 'failed', tokens: { input: 1, output: 0, cacheRead: 0, cacheCreate: 0 } });
  const review = await ledger.review({ providers: ['claude'] });
  assert.equal(review.turns, 0);
  const cursor = await ledger.review({ providers: ['cursor'] });
  assert.equal(cursor.turns, 1);
  assert.equal(cursor.failed, 1);
  const pending = await ledger.pending();
  assert.equal(pending.records[0].id, id.id);
  assert.equal(pending.records[0].payload.text, undefined);
  await ledger.ack(pending.upto);
  assert.equal((await ledger.pending()).records.length, 0);
});

test('an imported record keeps counts and drops message text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-ledger-'));
  const ledger = createUsageLedger({ root, deviceId: 'local-device' });
  await ledger.importRemote({ batches: [{ localId: 'other-device', name: '다른 PC', platform: 'darwin', records: [{ id: 't1', kind: 'turn', at: 1_700_000_000_000, payload: { projectId: 'p', chatId: 'c', provider: 'claude', accountKey: 'unknown:claude:abc', auth: 'login', model: 'opus', tokens: { input: 3, output: 1, cacheRead: 0, cacheCreate: 0 }, turnCostUsd: null, status: 'success', text: '비밀 본문', tools: [{ name: 'Bash', count: 2, errors: 1, input: 'rm -rf' }] } }] }] });
  const session = await ledger.session({ projectId: 'p', chatId: 'c', deviceId: 'other-device' });
  const dumped = JSON.stringify(session);
  assert.equal(dumped.includes('비밀'), false);
  assert.equal(dumped.includes('rm -rf'), false);
  assert.equal(session.turns[0].tools[0].name, 'Bash');
  assert.equal(session.turns[0].tools[0].count, 2);
  assert.equal(session.summary.turns, 1);
});

test('usage evaluation surfaces a short list of measured strengths and improvements', () => {
  const base = { timeZone: 'Asia/Seoul', from: 0, to: 1, device: 'local', devices: [{ id: 'd' }], turns: 0, sessions: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, weight: 0, costUsd: null, costTurns: 0, unknownCostTurns: 0, success: 0, failed: 0, interrupted: 0, activeMs: 0, compactions: 0, unknownTurns: 0, aliasedTurns: 0, cacheHitRate: null, inputFamily: 0, tools: [], models: [], providers: [], accounts: [], projects: [], days: [], weeks: [], sessionSpread: { count: 0, median: 0, p90: 0, long: [] }, snapshots: [] };
  const quiet = buildReport(base);
  assert.deepEqual(quiet.suggestions, []);
  const loud = buildReport({ ...base, turns: 12, sessions: 6, inputFamily: 60_000, cacheHitRate: 0.05, tokens: { input: 57_000, output: 100, cacheRead: 3_000, cacheCreate: 0 }, weight: 1000, unknownCostTurns: 12, success: 8, failed: 3, interrupted: 1, tools: [{ name: 'Bash', count: 10, errors: 4 }], compactions: 4, models: [{ key: 'opus', label: 'opus', turns: 12, weight: 1000, costUsd: null }], providers: [{ key: 'claude', label: 'Claude Code', turns: 12, weight: 1000, costUsd: null }], sessionSpread: { count: 6, median: 2, p90: 24, long: [{ title: '긴 대화', turns: 24 }] }, weeks: [{ week: '2026-11-16', turns: 12, weight: 1000 }] });
  assert.deepEqual(loud.suggestions.map(({ id, tone }) => [id, tone]), [['tool-errors', 'improve'], ['failures', 'improve']]);
  assert.match(loud.suggestions[0].text, /Bash.*40\.0%/);
  assert.match(loud.suggestions[1].text, /실패 3건, 중단 1건/);
  const cold = buildReport({ ...base, turns: 3, inputFamily: 60_000, cacheHitRate: 0.05 });
  assert.match(cold.suggestions[0].text, /5\.0%/);
  assert.deepEqual(buildReport({ ...base, turns: 3, inputFamily: 100, cacheHitRate: 0.9 }).suggestions, []);
  const warm = buildReport({ ...base, turns: 108, sessions: 20, inputFamily: 57_780, cacheHitRate: 0.926, tokens: { input: 1_070, output: 535, cacheRead: 53_500, cacheCreate: 3_210 }, weight: 13_107, costUsd: 0.19, costTurns: 107, unknownCostTurns: 1, success: 106, interrupted: 2, compactions: 0, models: [{ key: 'm', label: 'Model 1.0', turns: 107, weight: 13_107, costUsd: 0.19 }], providers: [{ key: 'claude', label: 'Claude Code', turns: 107, weight: 13_107, costUsd: 0.19 }, { key: 'codex', label: 'Codex', turns: 1, weight: 0, costUsd: null }], sessionSpread: { count: 20, median: 4, p90: 8, long: [{ title: '긴', turns: 28 }] }, weeks: [{ week: '2026-11-16', turns: 49, weight: 6002 }, { week: '2026-11-23', turns: 59, weight: 7105 }] });
  assert.deepEqual(warm.suggestions.map(({ id, tone }) => [id, tone]), [['completion', 'good'], ['cache', 'good']]);
  assert.match(warm.suggestions.map(item => item.text).join('\n'), /92\.6%/);
  assert.equal(warm.suggestions.some(item => item.text.includes('줄일')), false);
  assert.equal(paceOf([{ at: 0, percent: 10 }, { at: 1, percent: 20 }], 10).enough, false);
  const pace = paceOf([{ at: 0, percent: 10 }, { at: 1000, percent: 20 }, { at: 2000, percent: 30 }], 10_000);
  assert.equal(pace.enough, true);
  assert.equal(pace.hits, true);
  const thin = buildReport({ ...base, snapshots: [{ deviceId: 'd', deviceName: '이 기기', provider: 'claude', accountKey: 'a', at: 2000, windows: [{ key: 'weekly', label: '주간', percent: 30, resetsAt: 10_000 }, { key: 'weekly', label: '주간', percent: 10, resetsAt: 10_000 }] }] });
  assert.equal(thin.suggestions.some(item => item.id === 'pace'), false);
  const paced = buildReport({ ...base, turns: 3, snapshots: [0, 1000, 2000].map((at, index) => ({ deviceId: 'd', deviceName: '이 기기', provider: 'claude', accountKey: 'a', at, windows: [{ key: 'weekly', label: '주간', percent: 10 * (index + 1), resetsAt: 10_000 }] })) });
  assert.match(paced.suggestions.find(item => item.id === 'pace').text, /110%/);
});

test('an evaluation stays for the hold, and stays after that while the numbers are the same', async () => {
  let clock = 1_700_000_100_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-ledger-'));
  const ledger = createUsageLedger({ root, deviceId: 'd', now: () => clock });
  const file = path.join(root, 'one.jsonl');
  const turn = seq => JSON.stringify({ kind: 'result', status: 'success', at: 1_700_000_000_000 + seq, seq, sessionId: 's', usage: { input: 10, output: 1, cacheRead: 0, cacheCreate: 0 }, turnCostUsd: 0.1 });
  const read = async () => (await ledger.review({})).report.suggestions.map(item => item.text).join('\n');
  await fs.writeFile(file, [1, 2, 3].map(turn).join('\n') + '\n');
  await ledger.ingestFile({ file, projectId: 'p', chatId: 'c', meta: { agent: 'claude', cwd: '/work', auth: 'login' } });
  const first = await read();
  assert.match(first, /응답 3건/);
  await fs.appendFile(file, `${turn(4)}\n`);
  await ledger.ingestFile({ file, projectId: 'p', chatId: 'c', meta: { agent: 'claude', cwd: '/work', auth: 'login' } });
  clock += 60_000;
  const held = await read();
  assert.equal(held, first);
  clock += EVAL_HOLD;
  const next = await read();
  assert.match(next, /응답 4건/);
  assert.notEqual(next, first);
  clock += EVAL_HOLD;
  assert.equal(await read(), next);
  const reopened = createUsageLedger({ root, deviceId: 'd', now: () => clock });
  assert.equal((await reopened.review({})).report.suggestions.map(item => item.text).join('\n'), next);
});
