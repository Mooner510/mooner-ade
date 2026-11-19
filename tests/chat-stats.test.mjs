import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chatEventStats, eventWeightSince, readSessionStats, sessionFiles, subagentExtra, weightSince, withSubagents } from '../apps/local-server/src/chat-stats.js';

test('ADE statistics difference cumulative tokens once per response and leave missing usage unavailable', () => {
  const stats = chatEventStats([
    { kind: 'session', model: 'codex', at: 1 }, { kind: 'user', at: 2 },
    { kind: 'usage', at: 3, tokens: { input: 10, output: 2, cacheRead: 100 }, contextTokens: 110 },
    { kind: 'message', at: 4, blocks: [{ type: 'tool_use', id: 't', name: 'Bash' }] },
    { kind: 'tool_result', at: 5, toolUseId: 't', isError: true },
    { kind: 'usage', at: 6, tokens: { input: 20, output: 4, cacheRead: 200 }, contextTokens: 220 },
    { kind: 'result', at: 7, durationMs: 50 }, { kind: 'user', at: 8 },
    { kind: 'usage', at: 9, tokens: { input: 30, output: 10, cacheRead: 300 }, contextTokens: 330 },
    { kind: 'result', at: 10, durationMs: 100 },
  ]);
  assert.equal(stats.turns, 2); assert.equal(stats.requests, 2); assert.equal(stats.activeMs, 150);
  assert.deepEqual(stats.turnSeries.map(row => row.output), [4, 6]);
  assert.equal(stats.tokens.input, 30); assert.equal(stats.tokens.read, 300); assert.equal(stats.tokens.output, 10);
  const withSub = chatEventStats([
    { kind: 'user', at: 1 }, { kind: 'result', at: 2, costUsd: 0.5 },
    { kind: 'message', id: 'sub', parentToolUseId: 'agent', at: 3, usage: { input: 8, output: 2, cacheRead: 4, cacheCreate: 1 } }
  ]);
  assert.equal(withSub.subRequests, 1);
  assert.equal(withSub.tokens.input, 8); assert.equal(withSub.tokens.output, 2); assert.equal(withSub.tokens.read, 4);
  assert.equal(stats.cost, null); assert.equal(stats.tokensAvailable, true); assert.equal(stats.contextAvailable, true);
  assert.deepEqual(stats.tools, [{ name: 'Bash', count: 1, errors: 1 }]);
  const cursor = chatEventStats([{ kind: 'user', at: 1 }, { kind: 'result', at: 2 }]);
  assert.equal(cursor.tokensAvailable, false); assert.equal(cursor.contextAvailable, false); assert.equal(cursor.cacheHitRate, null); assert.equal(cursor.cost, null);
  assert.equal(chatEventStats([{ kind: 'result' }, { kind: 'divider' }]).requests, 0);
});

const at = minutes => new Date(Date.UTC(2026, 10, 12, 0, minutes)).toISOString();
const usage = (input, output, read, w1) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: w1, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: w1 } });
const line = entry => JSON.stringify(entry);
const assistant = (id, req, minutes, u, content = [{ type: 'text', text: 'ok' }]) => line({ type: 'assistant', requestId: req, timestamp: at(minutes), isSidechain: false, message: { id, model: 'claude-opus-5-5', content, usage: u } });
const user = (minutes, content) => line({ type: 'user', timestamp: at(minutes), message: { role: 'user', content } });

async function fixture(lines) {
  const root = await mkdtemp(path.join(tmpdir(), 'ade-stats-')), file = path.join(root, 's.jsonl');
  await writeFile(file, lines.join('\n') + '\n');
  return { root, file };
}

test('stats: a request written once per content block counts once, with the largest usage; turns, tools and errors are counted', async () => {
  const { root, file } = await fixture([
    user(0, '첫 질문'),
    assistant('m1', 'r1', 1, usage(10, 5, 1000, 0), [{ type: 'text', text: '...' }]),
    assistant('m1', 'r1', 1, usage(10, 40, 1000, 0), [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]), // same request, final output count
    line({ type: 'user', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] } }),
    assistant('m2', 'r2', 3, usage(20, 7, 2000, 500), [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }]),
    user(4, [{ type: 'text', text: '두번째 질문' }]),
    assistant('m3', 'r3', 5, usage(30, 9, 3000, 0)),
    line({ type: 'assistant', timestamp: at(6), message: { id: 'syn', model: '<synthetic>', content: [], usage: usage(0, 0, 0, 0) } })
  ]);
  try {
    const stats = await readSessionStats([file]);
    assert.equal(stats.requests, 3); assert.equal(stats.turns, 2);
    assert.deepEqual(stats.tokens, { input: 60, output: 56, thinking: 0, read: 6000, write5m: 0, write1h: 500 });
    assert.deepEqual(stats.tools.map(tool => [tool.name, tool.count, tool.errors]), [['Bash', 1, 1], ['Read', 1, 0]]);
    assert.equal(stats.peakContext, 3030);
    assert.ok(Math.abs(stats.cacheHitRate - 6000 / 6560) < 1e-9);
    assert.equal(stats.models.length, 1, 'the CLI synthetic notes are not a model');
    assert.equal(stats.cost, null, 'without a cost-state nothing is invented');
    assert.equal(stats.turnSeries.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stats: the CLI per-model cost is kept and split over requests by token weight; 5-hour blocks follow ccusage', async () => {
  const state = line({ type: 'cost-state', timestamp: at(7), totalCostUSD: 3, totalAPIDuration: 12000, totalToolDuration: 500, totalLinesAdded: 4, totalLinesRemoved: 1,
    modelUsage: { 'claude-opus-5-5': { inputTokens: 60, outputTokens: 56, cacheReadInputTokens: 6000, cacheCreationInputTokens: 500, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 500, costUSD: 3 } } });
  const { root, file } = await fixture([
    user(0, 'a'), assistant('m1', 'r1', 1, usage(10, 5, 1000, 0)), assistant('m2', 'r2', 2, usage(20, 7, 2000, 500)),
    user(3, 'b'), assistant('m3', 'r3', 4, usage(30, 9, 3000, 0)),
    user(400, 'c'), assistant('m4', 'r4', 401, usage(1, 1, 1, 0)), state
  ]);
  try {
    const stats = await readSessionStats([file]);
    assert.equal(stats.cost.totalUsd, 3); assert.equal(stats.models[0].costUsd, 3);
    const split = stats.turnSeries.reduce((total, turn) => total + (turn.costUsd ?? 0), 0);
    assert.ok(split > 0 && split <= 3.0001, `split ${split}`);
    assert.equal(stats.blocks.length, 2, 'a request 5+ hours later opens a new block');
    assert.equal(stats.blocks[0].requests, 3); assert.equal(new Date(stats.blocks[0].start).getUTCMinutes(), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stats: spentSince is what the requests from a time on cost (the usage share window), by the CLI price or, in a live session, the chat total split by token weight', async () => {
  const state = line({ type: 'cost-state', timestamp: at(7), totalCostUSD: 3, modelUsage: { 'claude-opus-5-5': { inputTokens: 60, outputTokens: 21, cacheReadInputTokens: 6000, cacheCreationInputTokens: 500, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 500, costUSD: 3 } } });
  const rows = [user(0, 'a'), assistant('m1', 'r1', 1, usage(10, 5, 1000, 0)), assistant('m2', 'r2', 2, usage(20, 7, 2000, 500)), assistant('m3', 'r3', 4, usage(30, 9, 3000, 0))];
  const { root, file } = await fixture([...rows, state]), bare = await fixture(rows);
  try {
    const [all, late, none] = (await readSessionStats([file], [Date.parse(at(0)), Date.parse(at(3)), Date.parse(at(60))])).spentSince;
    assert.ok(Math.abs(all - 3) < 1e-9, `all ${all}`); assert.ok(late > 0 && late < all, `late ${late}`); assert.equal(none, 0);
    assert.deepEqual((await readSessionStats([bare.file], [0])).spentSince, [null], 'no price and no chat total');
    const [live, liveLate] = (await readSessionStats([bare.file], [0, Date.parse(at(3))], 2)).spentSince;
    assert.ok(Math.abs(live - 2) < 1e-9 && liveLate > 0 && liveLate < 2, 'a live session: the chat total split by token weight');
    assert.deepEqual((await readSessionStats([file])).spentSince, []);
  } finally { await rm(root, { recursive: true, force: true }); await rm(bare.root, { recursive: true, force: true }); }
});

test('stats: a sidechain request and a subagent file count toward tokens, cost split and the sub request total', async () => {
  const subLine = line({ type: 'assistant', requestId: 'rs', timestamp: at(2), parent_tool_use_id: 'toolu', message: { id: 'sub', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'sub' }], usage: usage(4, 6, 0, 0) } });
  const { root, file } = await fixture([
    user(0, '질문'),
    assistant('m1', 'r1', 1, usage(10, 5, 0, 0)),
    line({ type: 'assistant', requestId: 'rside', timestamp: at(1), isSidechain: true, message: { id: 'side', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'side' }], usage: usage(1, 2, 0, 0) } })
  ]);
  const subFile = path.join(root, 'subagents', 'agent-1.jsonl');
  await mkdir(path.dirname(subFile), { recursive: true });
  await writeFile(subFile, subLine + '\n');
  try {
    const stats = await readSessionStats([file, subFile]);
    assert.equal(stats.subRequests, 2);
    assert.equal(stats.tokens.output, 5 + 2 + 6);
    assert.equal(stats.requests, 3);
    assert.deepEqual(stats.timeline.map(point => point.ctx), [10]);
    assert.ok(stats.timeline.every(point => point.sub === false));
    assert.equal(stats.turnSeries[0].requests, 1);
    assert.equal(stats.turnSeries[0].subRequests, 2);
    assert.equal(stats.subagents.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stats: the context graph keeps the main thread, and one subagent run stays together across the sidechain copy and its file', async () => {
  const state = line({ type: 'cost-state', timestamp: at(12), totalCostUSD: 10, modelUsage: {
    'claude-opus-5-5': { inputTokens: 40, outputTokens: 14, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 0, costUSD: 4 },
    'claude-haiku-5-5': { inputTokens: 900004, outputTokens: 8, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 0, costUSD: 6 }
  } });
  const { root, file } = await fixture([
    user(0, '질문'),
    assistant('m1', 'r1', 1, usage(10, 5, 0, 0), [{ type: 'tool_use', id: 'toolu', name: 'Agent', input: { description: '코드 탐색', subagent_type: 'Explore', prompt: '찾아 줘' } }]),
    line({ type: 'assistant', requestId: 'rside', timestamp: at(2), isSidechain: true, agentId: 'agent-1', parent_tool_use_id: 'toolu', message: { id: 'side', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'side' }], usage: usage(900000, 2, 0, 0) } }),
    line({ type: 'user', timestamp: at(5), isSidechain: true, agentId: 'agent-2', parent_tool_use_id: 'toolu2', message: { role: 'user', content: '테스트 이름을 정리해 줘' } }),
    line({ type: 'assistant', requestId: 'r2sub', timestamp: at(6), isSidechain: true, agentId: 'agent-2', parent_tool_use_id: 'toolu2', message: { id: 'side2', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], usage: usage(8, 1, 0, 0) } }),
    user(10, '두번째'),
    assistant('m2', 'r2', 11, usage(30, 9, 0, 0)),
    state
  ]);
  const subFile = path.join(root, 'subagents', 'agent-1.jsonl');
  await mkdir(path.dirname(subFile), { recursive: true });
  await writeFile(subFile, [
    line({ type: 'user', timestamp: at(2), isSidechain: true, agentId: 'agent-1', message: { role: 'user', content: '저장소에서 그래프 코드를 찾아 줘' } }),
    line({ type: 'assistant', requestId: 'rs', timestamp: at(3), isSidechain: true, agentId: 'agent-1', parent_tool_use_id: 'toolu', message: { id: 'sub', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'sub' }], usage: usage(4, 6, 0, 0) } }),
    line({ type: 'system', subtype: 'compact_boundary', timestamp: at(4) })
  ].join('\n') + '\n');
  try {
    const stats = await readSessionStats([file, subFile]);
    assert.equal(stats.subRequests, 3);
    assert.equal(stats.peakContext, 30);
    assert.equal(stats.compactions, 0);
    assert.deepEqual(stats.timeline.map(point => [point.ctx, point.sub]), [[10, false], [30, false]]);
    assert.equal(stats.subagents.length, 2);
    const [explore, named] = stats.subagents;
    assert.equal(explore.label, '코드 탐색');
    assert.equal(explore.type, 'Explore');
    assert.equal(explore.requests, 2);
    assert.equal(explore.peak, 900000);
    assert.equal(explore.turn, 1);
    assert.equal(explore.points.length, 2);
    assert.equal(named.label, '테스트 이름을 정리해 줘');
    assert.equal(named.requests, 1);
    assert.equal(named.turn, 1);
    const first = stats.turnSeries.find(turn => turn.index === 1);
    const second = stats.turnSeries.find(turn => turn.index === 2);
    assert.equal(first.requests, 1);
    assert.equal(first.output, 5);
    assert.equal(first.subRequests, 3);
    assert.equal(first.subPeak, 900000);
    assert.ok(first.costUsd < first.subCostUsd, `main ${first.costUsd} sub ${first.subCostUsd}`);
    assert.equal(second.requests, 1);
    assert.equal(second.subRequests, 0);
    assert.equal(second.output, 9);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('subagent usage after the last result is priced on top of the session total; usage already in the transcript is not added twice', () => {
  const covered = { seq: 1, kind: 'message', id: 's', parentToolUseId: 'a', at: 1_000, usage: { input: 100, output: 0, cacheRead: 7, cacheCreate: 0 } };
  const result = { seq: 2, kind: 'result', costUsd: 1, at: 2_000 };
  const later = { seq: 3, kind: 'message', id: 's2', parentToolUseId: 'b', at: 3_000, usage: { input: 0, output: 4, cacheRead: 0, cacheCreate: 0 } };
  const extra = subagentExtra([covered, result, later], { unitPrice: 0.01, since: [0] });
  assert.equal(extra.cost, 0.2); // 4 output × 5 × $0.01; the earlier call is already inside total_cost_usd
  assert.equal(extra.tokens.input, 100);
  assert.deepEqual(extra.spent, [0.2]);
  const seen = { subRequests: 2, endedAt: 2_000, tokens: { input: 10, output: 5, thinking: 0, read: 0, write5m: 0, write1h: 0 }, cost: { totalUsd: 1, toolMs: 0, linesAdded: 0, linesRemoved: 0 }, spentSince: [1] };
  const merged = withSubagents(seen, [covered, result, later], 0.01, [0]);
  assert.equal(merged.tokens.output, 9);
  assert.equal(merged.subRequests, 3);
  assert.equal(merged.cost.totalUsd, 1);
  assert.equal(merged.spentSince[0], 1.2);
  const hidden = withSubagents({ ...seen, subRequests: 0, endedAt: null }, [covered, result], 0.01, [0]);
  assert.equal(hidden.tokens.input, 110); // the transcript never saw the subagent, so its tokens are added
  // Cache reads are summed too. A NaN here is `null` in the JSON, and the statistics window crashed on it (toLocaleString of null) for a chat with subagents.
  assert.equal(hidden.tokens.read, 7);
  for (const value of Object.values(hidden.tokens)) assert.ok(Number.isFinite(value), 'every token count stays a number');
  assert.equal(hidden.spentSince[0], 1); // and its dollars are already in the session total, so they are not added again
});

test('spend: Codex and Cursor usage snapshots are differenced, a clear starts over, and a context-only line does not reset the total', async () => {
  const tokens = (input, output = 0) => ({ input, output, cacheRead: 0, cacheCreate: 0 });
  const events = [
    { seq: 1, kind: 'usage', at: 1_000, tokens: tokens(10) },
    { seq: 2, kind: 'usage', at: 1_500, contextTokens: 9 },
    { seq: 3, kind: 'usage', at: 2_000, tokens: tokens(10, 2) },
    { seq: 4, kind: 'divider', at: 2_500 },
    { seq: 5, kind: 'usage', at: 3_000, tokens: tokens(4) }
  ];
  assert.deepEqual(weightSince(events, [0, 2_500]), [24, 4]);
  const root = await mkdtemp(path.join(tmpdir(), 'ade-spend-')), file = path.join(root, 'events.jsonl');
  try {
    await writeFile(file, events.slice(0, 3).map(event => JSON.stringify(event)).join('\n') + '\n');
    assert.deepEqual(await eventWeightSince(file, events, [0]), [24], 'a line on disk and still in memory counts once; the tail still in memory is included');
    assert.deepEqual(await eventWeightSince(path.join(root, 'missing.jsonl'), [], [0]), [0]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stats: session files are found under the config dir by cwd, with sub-agent files, and only for a plain session id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ade-stats-files-')), id = '7105c835-0000-4000-8000-000000000000', cwd = 'C:/work/app';
  const folder = path.join(root, 'projects', 'C--work-app');
  try {
    await mkdir(path.join(folder, id, 'subagents'), { recursive: true });
    await writeFile(path.join(folder, `${id}.jsonl`), ''); await writeFile(path.join(folder, id, 'subagents', 'agent-1.jsonl'), '');
    const files = await sessionFiles({ sessionId: id, configDirs: [path.join(root, 'nope'), root], cwds: [cwd] });
    assert.deepEqual(files.map(file => path.basename(file)), [`${id}.jsonl`, 'agent-1.jsonl']);
    assert.deepEqual(await sessionFiles({ sessionId: '../escape', configDirs: [root], cwds: [cwd] }), []);
    assert.deepEqual(await sessionFiles({ sessionId: id, configDirs: [root], cwds: ['C:/other'] }), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stats: a subagent tool call and its failed result count together, and its prompt does not open a turn', async () => {
  const { root, file } = await fixture([
    user(0, '질문'),
    assistant('m1', 'r1', 1, usage(10, 5, 0, 0)),
    line({ type: 'assistant', requestId: 'rside', timestamp: at(2), isSidechain: true, agentId: 'agent-1', message: { id: 'side', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'ts1', name: 'Grep', input: {} }], usage: usage(1, 2, 0, 0) } }),
    line({ type: 'user', timestamp: at(3), isSidechain: true, agentId: 'agent-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ts1', content: 'boom', is_error: true }] } })
  ]);
  const subFile = path.join(root, 'subagents', 'agent-2.jsonl');
  await mkdir(path.dirname(subFile), { recursive: true });
  await writeFile(subFile, [
    line({ type: 'user', timestamp: at(4), isSidechain: true, agentId: 'agent-2', message: { role: 'user', content: '찾아 줘' } }),
    line({ type: 'assistant', requestId: 'rs', timestamp: at(5), isSidechain: true, agentId: 'agent-2', message: { id: 'sub', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'ts2', name: 'Grep', input: {} }], usage: usage(1, 2, 0, 0) } }),
    line({ type: 'user', timestamp: at(6), isSidechain: true, agentId: 'agent-2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ts2', content: 'boom', is_error: true }] } })
  ].join('\n') + '\n');
  try {
    const stats = await readSessionStats([file, subFile]);
    assert.deepEqual(stats.tools, [{ name: 'Grep', count: 2, errors: 2 }]);
    assert.equal(stats.turns, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
