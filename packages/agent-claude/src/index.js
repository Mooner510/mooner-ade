import { JsonlCliAgent } from '@mooner/ade-agent-core';

export function normalizeClaude(raw) {
  if (!raw || typeof raw !== 'object') return [];
  if (raw.type === 'system' && raw.subtype === 'init') return [{ kind: 'session', threadId: raw.session_id }];
  if (raw.type === 'stream_event') {
    const event = raw.event ?? {};
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      return [{ kind: 'text', text: event.delta.text, phase: 'delta' }];
    }
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      return [{ kind: 'tool', phase: 'started', tool: event.content_block.name, itemId: event.content_block.id, data: event.content_block }];
    }
    return [{ kind: 'raw', data: raw }];
  }
  if (raw.type === 'assistant') {
    return (raw.message?.content ?? []).filter(block => block.type === 'tool_use').map(block => ({
      kind: 'tool', phase: 'completed', tool: block.name, itemId: block.id, data: block
    }));
  }
  if (raw.type === 'user') return [{ kind: 'tool', phase: 'result', data: raw.message?.content ?? [] }];
  if (raw.type === 'result') {
    return [
      ...(raw.is_error ? [{ kind: 'error', message: raw.result ?? 'Claude failed' }] : []),
      { kind: 'usage', usage: raw.usage ?? null, costUsd: raw.total_cost_usd ?? null },
      { kind: 'result', status: raw.is_error ? 'failed' : 'success', text: raw.result, threadId: raw.session_id }
    ];
  }
  return [{ kind: 'raw', data: raw }];
}

export function buildClaudeArgs({ threadId, fullAccess = false, model, maxTurns } = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (threadId) args.push('--resume', threadId);
  if (fullAccess) args.push('--dangerously-skip-permissions');
  if (model) args.push('--model', model);
  if (maxTurns !== undefined) args.push('--max-turns', String(maxTurns));
  return args;
}

export class ClaudeAgent extends JsonlCliAgent {
  constructor(options = {}) {
    super({ id: 'claude', executable: options.executable ?? 'claude', buildArgs: buildClaudeArgs,
      normalize: normalizeClaude, spawnProcess: options.spawnProcess });
  }
}
