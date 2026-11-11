import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSessionStats, sessionFiles } from '../apps/local-server/src/chat-stats.js';

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
