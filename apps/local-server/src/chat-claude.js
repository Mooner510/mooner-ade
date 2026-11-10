// Claude Code as a headless child: `claude -p` with stream-json in and out. The official binary is only spawned; its login,
// tokens and model calls stay entirely inside it. This file turns its JSONL into the events the chat tab draws.
// Control-request shapes follow the Agent SDK's stdio protocol; tests/fixtures/claude-stream.jsonl (scripts/record-claude-stream.mjs)
// is the real capture they should be checked against. Anything not recognised passes through as `raw`.

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']; // `claude --effort`

export const validMessageUuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
// `resumeAt` + `fork` start a new session holding the old one only up to that assistant message (Branch, Rewind); the old session stays untouched.
export function buildClaudeArgs({ sessionId, model, effort, worktree, addDirs, permissionMode, settingsFile, mcpFile, resumeAt, fork } = {}) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio',
    '--replay-user-messages']; // echoes a queued (steering) message back with its uuid once the turn takes it in
  if (sessionId) { args.push('--resume', sessionId); if (validMessageUuid(resumeAt)) args.push('--resume-session-at', resumeAt); if (fork) args.push('--fork-session'); }
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  // A new session can start in its own git worktree; a resumed one re-enters the worktree it was created in.
  if (worktree && !sessionId) args.push('--worktree');
  if (addDirs?.length) args.push('--add-dir', ...addDirs);
  // The CLI's own name for "ask me" is `manual` (its init event reports it as `default`); leaving the flag out would follow the user's own setting, e.g. `auto`.
  args.push('--permission-mode', !permissionMode || permissionMode === 'default' ? 'manual' : permissionMode);
  if (settingsFile) args.push('--settings', settingsFile);
  if (mcpFile) args.push('--mcp-config', mcpFile);
  return args;
}

// One stdin line for a user turn. `images` are { mime, data(base64) }.
export function userLine(text, images = [], uuid) {
  const content = [...images.map(({ mime, data }) => ({ type: 'image', source: { type: 'base64', media_type: mime, data } })), { type: 'text', text }];
  return JSON.stringify({ type: 'user', message: { role: 'user', content }, ...(uuid && { uuid }) }) + '\n';
}
export const controlLine = (requestId, request) => JSON.stringify({ type: 'control_request', request_id: requestId, request }) + '\n';
export function approvalLine(requestId, { allow, input, message, suggestions }) {
  const response = allow
    ? { behavior: 'allow', updatedInput: input ?? {}, ...(suggestions?.length && { updatedPermissions: suggestions }) }
    : { behavior: 'deny', message: message || '사용자가 거부했습니다.' };
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n';
}

const blocks = content => typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
const usageOf = usage => usage ? { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheCreate: usage.cache_creation_input_tokens ?? 0 } : null;

// raw JSON object from stdout -> list of events. `delta` events are live-only; the rest are stored in the transcript.
export function normalizeClaude(raw) {
  if (!raw || typeof raw !== 'object') return [];
  if (raw.type === 'system' && raw.subtype === 'init') {
    return [{ kind: 'session', sessionId: raw.session_id, model: raw.model, permissionMode: raw.permissionMode, cwd: raw.cwd,
      tools: Array.isArray(raw.tools) ? raw.tools : [], slashCommands: Array.isArray(raw.slash_commands) ? raw.slash_commands : [] }];
  }
  // The CLI reports no thinking text for current models, only a running token estimate; it is the one "what is it doing" signal there is.
  if (raw.type === 'system' && raw.subtype === 'thinking_tokens') return Number.isFinite(raw.estimated_tokens) ? [{ kind: 'delta', phase: 'thinkingTokens', tokens: raw.estimated_tokens }] : [];
  if (raw.type === 'stream_event') {
    const event = raw.event ?? {};
    if (event.type === 'message_start') return [{ kind: 'delta', phase: 'start', messageId: event.message?.id }];
    if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') return [{ kind: 'delta', phase: 'text', index: event.index, text: event.delta.text }];
      if (event.delta?.type === 'thinking_delta') return [{ kind: 'delta', phase: 'thinking', index: event.index, text: event.delta.thinking }];
    }
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      return [{ kind: 'delta', phase: 'tool', index: event.index, id: event.content_block.id, name: event.content_block.name }];
    }
    return [];
  }
  if (raw.type === 'assistant') {
    const message = raw.message ?? {};
    return [{ kind: 'message', role: 'assistant', id: message.id ?? raw.uuid, ...(typeof raw.uuid === 'string' && { uuid: raw.uuid }), model: message.model, parentToolUseId: raw.parent_tool_use_id ?? null,
      blocks: blocks(message.content).map(block => block.type === 'tool_use' ? { type: 'tool_use', id: block.id, name: block.name, input: block.input }
        : block.type === 'thinking' ? { type: 'thinking', text: block.thinking ?? '' } : block.type === 'text' ? { type: 'text', text: block.text ?? '' } : { type: 'other', original: block.type }),
      usage: usageOf(message.usage) }];
  }
  if (raw.type === 'user') {
    // Tool results come back as user messages; plain user text is already recorded by the server when it is sent.
    return blocks(raw.message?.content).filter(block => block.type === 'tool_result').map(block => ({
      kind: 'tool_result', toolUseId: block.tool_use_id, isError: block.is_error === true,
      content: typeof block.content === 'string' ? block.content : blocks(block.content).map(part => part.type === 'text' ? part.text : `[${part.type}]`).join('\n') }));
  }
  if (raw.type === 'result') {
    return [{ kind: 'result', // An interrupt ends the turn with is_error and terminal_reason `aborted_*`; that is the user's own stop, not a failure.
      status: !raw.is_error ? 'success' : /^aborted/.test(raw.terminal_reason ?? '') ? 'interrupted' : 'failed', text: typeof raw.result === 'string' ? raw.result : '', sessionId: raw.session_id,
      costUsd: raw.total_cost_usd ?? null, usage: usageOf(raw.usage), contextWindow: Object.values(raw.modelUsage ?? {}).map(item => item?.contextWindow).find(Number.isFinite) ?? null, durationMs: raw.duration_ms ?? null, turns: raw.num_turns ?? null }];
  }
  if (raw.type === 'control_request' && raw.request?.subtype === 'can_use_tool') {
    const request = raw.request;
    return [{ kind: 'approval', phase: 'request', requestId: raw.request_id, tool: request.tool_name, input: request.input ?? {}, toolUseId: request.tool_use_id,
      suggestions: Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [] }];
  }
  if (raw.type === 'control_cancel_request') return [{ kind: 'approval', phase: 'cancel', requestId: raw.request_id }];
  if (raw.type === 'control_response' || raw.type === 'keep_alive') return [];
  return [{ kind: 'raw', original: raw.type ?? null }];
}

// Claude Code's own transcript (<config>/projects/<slug>/<session>.jsonl) -> the events a chat stores, so a terminal conversation can continue as a chat.
// Assistant and tool_result lines already have the stream-json shape. Skipped: subagent lines, meta/compact-summary users, hook/command noise.
// ponytail: abandoned branches of the transcript tree (after a CLI rewind) are not pruned; walk parentUuid from the last line if that shows up.
const NOISE = /^<(?:local-command-caveat|local-command-stdout|system-reminder|command-message)\b/;
export function transcriptEvents(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let raw; try { raw = JSON.parse(line); } catch { continue; } // torn first line of a tail, or a line being written
    if (!raw || raw.isSidechain) continue;
    const at = Date.parse(raw.timestamp) || undefined;
    if (raw.type === 'system' && raw.subtype === 'compact_boundary') events.push({ kind: 'divider', reason: 'compact', at });
    else if (raw.type === 'assistant') for (const event of normalizeClaude(raw)) events.push({ ...event, at });
    else if (raw.type === 'user' && !raw.isMeta && !raw.isCompactSummary) {
      const parts = blocks(raw.message?.content), results = normalizeClaude(raw);
      if (results.length) { for (const event of results) events.push({ ...event, at }); continue; }
      const command = parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n').trim();
      const name = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(command)?.[1], args = /<command-args>([^<]*)<\/command-args>/.exec(command)?.[1]?.trim();
      const shown = name ? `${name} ${args ?? ''}`.trim() : command;
      if (shown && !NOISE.test(shown)) events.push({ kind: 'user', text: shown, images: parts.filter(part => part.type === 'image').length, at });
    }
  }
  return events;
}
