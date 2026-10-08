import { JsonlCliAgent } from '@mooner/ade-agent-core';

export function normalizeCodex(raw) {
  if (!raw || typeof raw !== 'object') return [];
  switch (raw.type) {
    case 'thread.started': return [{ kind: 'session', threadId: raw.thread_id }];
    case 'turn.started': return [{ kind: 'progress', phase: 'turn.started' }];
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = raw.item ?? {};
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        return [{ kind: 'text', text: item.text, phase: raw.type, itemId: item.id }];
      }
      return [{ kind: 'tool', phase: raw.type, tool: item.type ?? 'unknown', itemId: item.id, data: item }];
    }
    case 'turn.completed': return [{ kind: 'usage', usage: raw.usage ?? null }, { kind: 'result', status: 'success' }];
    case 'turn.failed': return [{ kind: 'error', message: raw.error?.message ?? 'Codex turn failed' }];
    case 'error': return [{ kind: 'error', message: raw.message ?? 'Codex error' }];
    default: return [{ kind: 'raw', data: raw }];
  }
}

export function buildCodexArgs({ threadId, fullAccess = false, model } = {}) {
  const args = ['exec'];
  if (threadId) args.push('resume', threadId);
  args.push('--json');
  if (fullAccess) args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('--full-auto');
  if (model) args.push('--model', model);
  args.push('-');
  return args;
}

export class CodexAgent extends JsonlCliAgent {
  constructor(options = {}) {
    super({ id: 'codex', executable: options.executable ?? 'codex', buildArgs: buildCodexArgs,
      normalize: normalizeCodex, spawnProcess: options.spawnProcess });
  }
}
