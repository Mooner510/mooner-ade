import { StringDecoder } from 'node:string_decoder';
import { spawnAgent } from './agent-spawn.js';
import { seedChat } from './chat.js';
import { createChatProtocol } from './chat-rpc.js';
import { forkCursorSession, listCursorSessions } from './cursor-sessions.js';
import { fault } from './files.js';

// Copies a Cursor CLI session into a new ADE chat. The original store is left as it is. History replay is best-effort.
export async function importCursorCliSession({ directory, id, sessionId, cwd, configDir, running = false, readEvents }) {
  if (running) throw fault('CHAT_BUSY', '터미널에서 실행 중인 대화는 불러올 수 없습니다.', 409);
  const found = (await listCursorSessions({ cwd, configDir })).find(item => item.sessionId.toLowerCase() === String(sessionId).toLowerCase());
  if (!found) throw fault('NOT_FOUND', 'Cursor 대화를 찾을 수 없습니다.', 404);
  const next = await forkCursorSession({ checkpoint: found.file, cwd, configDir });
  const events = await Promise.resolve(readEvents?.(next)).catch(() => []) ?? [];
  await seedChat({ directory, id, events, meta: { agent: 'cursor', cwd, configDir, sessionId: next, addDirs: [] } });
  return { id, sessionId: next };
}

// Short-lived protocol client for history and metadata only; never starts a model turn or resumes a writer.
export async function withAgentRpc({ agent, cwd, env = {}, executable = agent === 'cursor' ? 'cursor-agent' : agent, executableArgs = [], spawnProcess = spawnAgent }, read) {
  const child = spawnProcess(executable, [...executableArgs, agent === 'codex' ? 'app-server' : 'acp'], {
    cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const notifications = [], protocol = createChatProtocol(agent, { write: async line => { child.stdin.write(line); }, emit: () => {} });
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  child.stderr.resume(); child.stdin.on('error', () => protocol.dispose());
  child.once('error', () => protocol.dispose()); child.once('close', () => protocol.dispose());
  child.stdout.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { protocol.dispose(); child.kill(); return; }
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let raw; try { raw = JSON.parse(line); } catch { continue; }
      if (raw.method === 'session/update') notifications.push(raw.params);
      protocol.handle(raw);
    }
  });
  try {
    await protocol.request('initialize', agent === 'codex'
      ? { clientInfo: { name: 'mooner_ade', version: '0.5.10' }, capabilities: { experimentalApi: true } }
      : { protocolVersion: 1, clientCapabilities: { _meta: { parameterizedModelPicker: true, subagents: true } }, clientInfo: { name: 'mooner_ade', version: '0.5.10' } });
    if (agent === 'codex') child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    else await protocol.request('authenticate', { methodId: 'cursor_login' });
    return await read(protocol.request, notifications);
  } finally {
    protocol.dispose(); child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }, 3000); timer.unref();
  }
}

export async function readCursorConversation(options, sessionId) {
  return withAgentRpc({ ...options, agent: 'cursor' }, async (request, notifications) => {
    const response = await request('session/load', { sessionId, cwd: options.cwd, mcpServers: [] });
    const events = [{ kind: 'session', sessionId, model: response.models?.currentModelId }];
    const protocol = createChatProtocol('cursor', { write: async () => {}, emit: event => events.push(event) });
    try { protocol.replayCursor(sessionId, notifications); }
    finally { protocol.dispose(); }
    return events.map((event, index) => ({ ...event, seq: index + 1, at: Date.now() }));
  });
}

export function codexHistoryEvents(thread) {
  const events = [], protocol = createChatProtocol('codex', { write: async () => {}, emit: event => events.push(event) });
  try { protocol.replayCodex(thread); }
  finally { protocol.dispose(); }
  return events.map((event, index) => ({ ...event, seq: index + 1, at: (thread.updatedAt || thread.createdAt) ? (thread.updatedAt || thread.createdAt) * 1000 : Date.now() }));
}

export async function readCodexConversation(options, sessionId) {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw fault('INVALID_INPUT', '잘못된 세션 ID입니다.');
  return withAgentRpc({ ...options, agent: 'codex' }, async request => {
    const { thread } = await request('thread/read', { threadId: sessionId, includeTurns: true });
    if (!thread.turns?.length) {
      const turns = []; let cursor;
      do {
        const page = await request('thread/turns/list', { threadId: sessionId, limit: 100, sortDirection: 'asc', itemsView: 'full', ...(cursor && { cursor }) });
        turns.push(...page.data); cursor = page.nextCursor;
        if (turns.length > 4000) throw fault('CHAT_UNSUPPORTED', '대화가 너무 큽니다. CLI에서 대화를 줄인 뒤 전환하세요.', 409);
      } while (cursor);
      thread.turns = turns;
    }
    return { thread, events: codexHistoryEvents(thread) };
  });
}
