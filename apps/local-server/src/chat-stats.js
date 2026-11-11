// Statistics of one Claude conversation, read from its transcript (<config>/projects/<cwd>/<session>.jsonl and its sub-agent files).
// Same counting rules as ccusage: one request is one `message.id:requestId` (a request is written once per content block, the last/largest usage wins),
// sub-agent requests are included, 5-hour billing blocks start at the hour of their first request. Nothing is sent anywhere and no model is called.
// Money: the CLI records its own running totals per model (`cost-state`); those are used as is. Only the split of a model's cost over its requests is an
// estimate: every request is weighed with the usual price ratios (output 5x input, cache read 0.1x, cache write 1.25x / 2x) and scaled to that model's real cost.
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const HOUR = 3_600_000, BLOCK = 5 * HOUR, MAX_LINE = 16 * 1024 * 1024, MAX_POINTS = 240, MAX_TURNS = 200;
const weight = u => u.input + u.output * 5 + u.read * 0.1 + u.w5 * 1.25 + u.w1 * 2;
const num = value => Number.isFinite(value) ? value : 0;
const usageOf = raw => {
  const created = raw.cache_creation ?? {}, split = num(created.ephemeral_5m_input_tokens) + num(created.ephemeral_1h_input_tokens), total = num(raw.cache_creation_input_tokens);
  return { input: num(raw.input_tokens), output: num(raw.output_tokens), thinking: num(raw.output_tokens_details?.thinking_tokens), read: num(raw.cache_read_input_tokens),
    w1: num(created.ephemeral_1h_input_tokens), w5: split ? num(created.ephemeral_5m_input_tokens) : total };
};
const isPrompt = content => typeof content === 'string' ? content.trim() !== '' : Array.isArray(content) && content.some(part => part?.type === 'text' && String(part.text ?? '').trim() !== '');

export async function readSessionStats(files) {
  const requests = new Map(), tools = new Map(), toolName = new Map(), turns = [{ at: null, ms: 0 }], compactions = [];
  let costState = null;
  for (const file of files) {
    const lines = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length > MAX_LINE) continue;
      const interesting = line.includes('"type":"assistant"') ? 'assistant' : line.includes('"type":"user"') ? 'user' : line.includes('"cost-state"') ? 'cost' : line.includes('turn_duration') ? 'turn' : line.includes('compact_boundary') ? 'compact' : null;
      if (!interesting) continue;
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      const at = Date.parse(entry.timestamp);
      if (entry.type === 'assistant' && entry.message?.usage) {
        if (entry.message.model === '<synthetic>') continue; // the CLI's own error/interrupt notes, not a request
        const message = entry.message, key = `${message.id ?? entry.uuid}:${entry.requestId ?? ''}`, usage = usageOf(message.usage), found = requests.get(key);
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block?.type !== 'tool_use' || !block.id || toolName.has(block.id)) continue;
          toolName.set(block.id, block.name);
          const row = tools.get(block.name) ?? { name: block.name, count: 0, errors: 0 }; row.count += 1; tools.set(block.name, row);
        }
        if (!found) requests.set(key, { at, model: message.model || 'unknown', usage, turn: turns.length - 1, sub: entry.isSidechain === true });
        else if (usage.output >= found.usage.output) { found.usage = usage; if (message.model) found.model = message.model; }
      } else if (entry.type === 'user' && !entry.isSidechain && !entry.isMeta) {
        const content = entry.message?.content;
        if (isPrompt(content)) turns.push({ at, ms: 0 });
        for (const part of Array.isArray(content) ? content : []) if (part?.type === 'tool_result' && part.is_error === true) { const row = tools.get(toolName.get(part.tool_use_id)); if (row) row.errors += 1; }
      } else if (entry.type === 'cost-state') costState = entry;
      else if (entry.subtype === 'turn_duration' && typeof entry.durationMs === 'number') turns[turns.length - 1].ms += entry.durationMs;
      else if (entry.subtype === 'compact_boundary') compactions.push(at);
    }
  }

  const list = [...requests.values()].filter(item => Number.isFinite(item.at)).sort((a, b) => a.at - b.at);
  // price per weight unit of each model, from the CLI's own totals
  const unit = new Map(), spend = costState?.modelUsage ?? {};
  for (const [model, row] of Object.entries(spend)) {
    const created5 = num(row.cacheCreationEphemeral5mInputTokens), created1 = num(row.cacheCreationEphemeral1hInputTokens);
    const w = weight({ input: num(row.inputTokens), output: num(row.outputTokens), read: num(row.cacheReadInputTokens), w5: created5 + created1 ? created5 : num(row.cacheCreationInputTokens), w1: created1 });
    if (w > 0 && num(row.costUSD) > 0) unit.set(model, row.costUSD / w);
  }
  const costOf = item => unit.has(item.model) ? unit.get(item.model) * weight(item.usage) : null;
  const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);
  const tokens = { input: 0, output: 0, thinking: 0, read: 0, write5m: 0, write1h: 0 };
  for (const item of list) { tokens.input += item.usage.input; tokens.output += item.usage.output; tokens.thinking += item.usage.thinking; tokens.read += item.usage.read; tokens.write5m += item.usage.w5; tokens.write1h += item.usage.w1; }
  const promptSide = tokens.input + tokens.read + tokens.write5m + tokens.write1h;

  const models = [...new Set(list.map(item => item.model))].map(model => {
    const mine = list.filter(item => item.model === model);
    return { model, requests: mine.length, input: sum(mine, i => i.usage.input), output: sum(mine, i => i.usage.output), read: sum(mine, i => i.usage.read), write: sum(mine, i => i.usage.w5 + i.usage.w1),
      costUsd: spend[model] ? num(spend[model].costUSD) : null };
  }).sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.requests - a.requests);

  // the context size a request saw: everything it sent in (fresh + cached)
  const ctxOf = item => item.usage.input + item.usage.read + item.usage.w5 + item.usage.w1;
  const stride = Math.max(1, Math.ceil(list.length / MAX_POINTS));
  const timeline = list.filter((_, index) => index % stride === 0 || index === list.length - 1).map(item => ({ at: item.at, ctx: ctxOf(item), output: item.usage.output, costUsd: costOf(item), turn: item.turn, sub: item.sub }));

  const perTurn = turns.map((turn, index) => {
    const mine = list.filter(item => item.turn === index);
    return { index, at: turn.at ?? mine[0]?.at ?? null, requests: mine.length, output: sum(mine, i => i.usage.output), ctx: mine.length ? Math.max(...mine.map(ctxOf)) : 0,
      costUsd: mine.some(item => costOf(item) !== null) ? sum(mine, i => costOf(i) ?? 0) : null, ms: turn.ms };
  }).filter(turn => turn.requests > 0).slice(-MAX_TURNS);

  const blocks = [];
  for (const item of list) {
    const last = blocks.at(-1);
    if (!last || item.at - last.start >= BLOCK || item.at - last.lastAt >= BLOCK) blocks.push({ start: Math.floor(item.at / HOUR) * HOUR, lastAt: item.at, requests: 0, tokens: 0, costUsd: null });
    const block = blocks.at(-1), cost = costOf(item);
    block.lastAt = item.at; block.requests += 1; block.tokens += item.usage.input + item.usage.output + item.usage.read + item.usage.w5 + item.usage.w1;
    if (cost !== null) block.costUsd = (block.costUsd ?? 0) + cost;
  }

  return {
    requests: list.length, subRequests: list.filter(item => item.sub).length, turns: perTurn.length, compactions: compactions.length, compactionAt: compactions,
    startedAt: list[0]?.at ?? null, endedAt: list.at(-1)?.at ?? null, activeMs: costState ? num(costState.totalAPIDuration) : sum(turns, turn => turn.ms),
    tokens, cacheHitRate: promptSide ? tokens.read / promptSide : null, peakContext: list.length ? Math.max(...list.map(ctxOf)) : 0,
    cost: costState ? { totalUsd: num(costState.totalCostUSD), toolMs: num(costState.totalToolDuration), linesAdded: num(costState.totalLinesAdded), linesRemoved: num(costState.totalLinesRemoved) } : null,
    models, tools: [...tools.values()].sort((a, b) => b.count - a.count).slice(0, 12), toolCalls: sum([...tools.values()], row => row.count),
    timeline, turnSeries: perTurn, blocks: blocks.map(({ lastAt, ...rest }) => ({ ...rest, end: rest.start + BLOCK }))
  };
}

// The transcript files of a session: the main one plus its sub-agents (<session>/subagents/*.jsonl), in the first config dir/cwd that has it.
export async function sessionFiles({ sessionId, configDirs, cwds }) {
  if (!/^[0-9a-f-]{8,64}$/i.test(String(sessionId))) return [];
  for (const dir of configDirs) for (const cwd of cwds) {
    const folder = path.join(dir, 'projects', String(cwd).replace(/[^a-zA-Z0-9]/g, '-')), main = path.join(folder, `${sessionId}.jsonl`);
    if (!(await fs.stat(main).catch(() => null))?.isFile()) continue;
    const subs = (await fs.readdir(path.join(folder, sessionId, 'subagents')).catch(() => [])).filter(name => name.endsWith('.jsonl')).map(name => path.join(folder, sessionId, 'subagents', name));
    return [main, ...subs];
  }
  return [];
}
