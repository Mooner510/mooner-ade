import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fault } from './files.js';
import { approvalLine, buildClaudeArgs, controlLine, EFFORTS, normalizeClaude, PERMISSION_MODES, transcriptEvents, userLine, validMessageUuid } from './chat-claude.js';
import { chatAgents, chatCapabilities, createChatProtocol, cursorEffortOption } from './chat-rpc.js';
import { createLocalRuntime } from './runtime.js';
import { mcpServers } from './terminal-sessions.js';

const ID = /^[a-zA-Z0-9-]{1,128}$/;
const MAX_LINE = 8 * 1024 * 1024, KEEP_EVENTS = 4000, IDLE_MS = 10 * 60_000;
export const chatFolder = (directory, id) => {
  if (typeof id !== 'string' || !ID.test(id)) throw fault('INVALID_INPUT', '잘못된 채팅 ID입니다.');
  return path.join(directory, 'chat', id);
};
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });

// One chat tab = one transcript + (while a turn or an approval is open) one `claude -p` child. The child starts on the first
// message and is resumed with `--resume <session id>` when it ended in between, so closing the app never loses the conversation.
export async function openChatSession({ directory, id, cwd, agent = 'claude', env = {}, spawnProcess = spawn, executable = agent === 'cursor' ? 'cursor-agent' : agent, executableArgs = [], onEvent, onState, prepare, recover, defaults }) {
  if (!chatAgents.includes(agent)) throw fault('INVALID_INPUT', '지원하지 않는 에이전트입니다.');
  const root = chatFolder(directory, id);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const metaFile = path.join(root, 'meta.json'), logFile = path.join(root, 'events.jsonl');
  const saved = await fs.readFile(metaFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const meta = { sessionId: undefined, configDir: undefined, model: undefined, effort: undefined, worktree: false, addDirs: [], permissionMode: 'default', costBase: 0, resumeAt: undefined, fork: false, ...JSON.parse(saved ?? '{}') };
  // Settings' defaults for a brand-new Claude chat only; a saved chat keeps what it has. bypassPermissions is never a default.
  if (saved === null && agent === 'claude' && defaults) {
    if (['default', 'acceptEdits', 'plan'].includes(defaults.permissionMode)) meta.permissionMode = defaults.permissionMode;
    if (chatCapabilities(agent).efforts.includes(defaults.effort)) meta.effort = defaults.effort;
  }
  if (saved !== null && (meta.agent ?? 'claude') !== agent) throw fault('INVALID_INPUT', '저장된 대화의 에이전트가 다릅니다.');
  cwd = meta.cwd ?? cwd;
  let events = [], seq = 0;
  try {
    for (const line of (await fs.readFile(logFile, 'utf8')).split('\n')) { if (!line) continue; try { const event = JSON.parse(line); events.push(event); seq = Math.max(seq, event.seq); } catch { /* torn last line after a crash */ } }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  events = events.slice(-KEEP_EVENTS);

  const state = { agent, capabilities: chatCapabilities(agent), status: 'idle', model: meta.model ?? null, effort: meta.effort ?? null, worktree: meta.worktree === true, addDirs: meta.addDirs, permissionMode: meta.permissionMode, sessionId: meta.sessionId ?? null, costUsd: agent === 'claude' ? meta.costBase : null, turns: 0, durationMs: 0,
    contextTokens: 0, contextWindow: null, tokens: zero(), slashCommands: [], tools: [], pending: 0, error: null, startedAt: Date.now() };
  function retainedEvents() {
    let kept = [];
    for (const event of events) {
      if (event.kind === 'rewind') { const at = kept.findIndex(item => item.kind === 'message' && item.uuid === event.uuid); if (at >= 0) kept = kept.slice(0, at + 1); }
      else kept.push(event);
    }
    return kept;
  }
  for (const event of retainedEvents()) fold(event, true);
  state.sessionId = meta.sessionId ?? null;
  let configuring = false;
  let child = null, protocol = null, closed = false, turnOpen = false, restartAfterTurn = false, idleTimer = null, writing = Promise.resolve();
  const approvals = new Map(), controls = new Map(), steers = new Map(); // steers: uuid -> { text, images } sent into a running turn, not yet taken in by it

  const snapshotMeta = () => ({ configValues: meta.configValues, agent, cwd, worktreePath: meta.worktreePath, configDir: meta.configDir, resumeAt: meta.resumeAt, fork: meta.fork || undefined, sessionId: state.sessionId ?? undefined, model: meta.model, lastModel: state.model ?? undefined, effort: meta.effort, worktree: meta.worktree, addDirs: meta.addDirs, permissionMode: meta.permissionMode, costBase: meta.costBase,
    title: events.slice(events.findLastIndex(event => event.kind === 'divider') + 1).find(event => event.kind === 'user')?.text?.replace(/\s+/g, ' ').trim().slice(0, 80) });
  const saveMeta = () => {
    const data = JSON.stringify(snapshotMeta());
    const saved = writing.then(async () => { await fs.writeFile(`${metaFile}.tmp`, data, { mode: 0o600 }); await fs.rename(`${metaFile}.tmp`, metaFile); });
    writing = saved.catch(reportStorage); return saved;
  };
  const publish = () => onState?.({ ...state, tokens: { ...state.tokens }, pending: approvals.size });
  const setStatus = () => {
    state.status = closed ? 'closed' : approvals.size ? 'attention' : turnOpen ? 'working' : 'idle'; state.pending = approvals.size; publish();
    // An idle child holds a few hundred MB; the conversation resumes from its session id, so it can go.
    clearTimeout(idleTimer);
    if (child && !turnOpen && !approvals.size) { const proc = child; idleTimer = setTimeout(() => { if (child === proc && !turnOpen) proc.kill('SIGTERM'); }, IDLE_MS); idleTimer.unref(); }
  };
  // The view of the world the status line shows, derived from events so that a replayed transcript gives the same numbers.
  function fold(event, replay = false) {
    if (event.kind === 'session') {
      state.sessionId = event.sessionId ?? state.sessionId; state.model = event.model ?? state.model;
      if (event.slashCommands?.length) state.slashCommands = event.slashCommands;
      if (event.tools?.length) state.tools = event.tools;
    } else if (event.kind === 'capabilities') state.capabilities = event.capabilities;
    else if (event.kind === 'settings') { if (event.permissionMode !== undefined) state.permissionMode = event.permissionMode; if (event.effort !== undefined) state.effort = event.effort; }
    else if (event.kind === 'usage') {
      if (event.tokens) state.tokens = event.tokens;
      state.contextTokens = event.contextTokens ?? state.contextTokens; state.contextWindow = event.contextWindow ?? state.contextWindow;
      state.capabilities = { ...state.capabilities, context: true, tokens: Boolean(event.tokens) || state.capabilities.tokens };
    } else if (event.kind === 'message' && event.usage && !event.parentToolUseId) {
      state.contextTokens = event.usage.input + event.usage.cacheRead + event.usage.cacheCreate + event.usage.output;
    } else if (event.kind === 'result') {
      state.turns += 1; state.durationMs += event.durationMs ?? 0; if (event.contextWindow) state.contextWindow = event.contextWindow;
      if (event.usage) for (const key of Object.keys(state.tokens)) state.tokens[key] += event.usage[key];
      // shortcut: total_cost_usd is read as cumulative per process; `costBase` carries earlier processes over a --resume.
      if (!replay && event.costUsd != null) state.costUsd = meta.costBase + event.costUsd;
      if (event.status === 'failed') state.error = event.text || '실패했습니다.'; else state.error = null;
    } else if (event.kind === 'divider') { state.tokens = zero(); state.turns = 0; state.durationMs = 0; state.contextTokens = 0; }
    else if (event.kind === 'error') state.error = event.message;
  }
  function emit(event, { store = true } = {}) {
    const stamped = store ? { ...event, seq: ++seq, at: Date.now() } : event;
    if (store) {
      events.push(stamped); if (events.length > KEEP_EVENTS * 1.5) events = events.slice(-KEEP_EVENTS);
      writing = writing.then(() => fs.appendFile(logFile, JSON.stringify(stamped) + '\n', { mode: 0o600 })).catch(reportStorage);
      fold(stamped);
    }
    onEvent?.(stamped);
  }
  const live = () => { if (closed) throw fault('NOT_FOUND', '닫힌 채팅입니다.', 404); };

  // A steering message is "applied" when the CLI echoes it back (--replay-user-messages) at the moment the running turn takes it in.
  function dropSteers(emitCancelled = true) {
    for (const [uuid, item] of steers) if (emitCancelled) emit({ kind: 'steer', phase: 'cancelled', uuid, text: item.text });
    steers.clear();
  }
  function handleRaw(raw) {
    if (raw?.type === 'user' && raw.isReplay === true) {
      const steer = steers.get(raw.uuid);
      if (steer) { steers.delete(raw.uuid); emit({ kind: 'steer', phase: 'applied', uuid: raw.uuid, text: steer.text, images: steer.images }); }
      return;
    }
    // A reply to something we asked (set_model, interrupt, ...).
    if (raw?.type === 'control_response') { controls.get(raw.response?.request_id)?.(raw.response); controls.delete(raw.response?.request_id); }
    if (protocol) { protocol.handle(raw); return; }
    for (const event of normalizeClaude(raw)) handleEvent(event);
  }
  function handleEvent(event) {
      if (event.kind === 'approval') {
        if (event.phase === 'request') approvals.set(event.requestId, event); else approvals.delete(event.requestId);
        emit(event); setStatus(); return;
      }
      if (event.kind === 'delta') { emit(event, { store: false }); return; }
      if (event.kind === 'raw') { emit(event, { store: false }); return; }
      emit(event);
      if (event.kind === 'session') { meta.sessionId = state.sessionId ?? undefined; meta.resumeAt = undefined; meta.fork = false; void saveMeta().catch(reportStorage); publish(); }
      if (event.kind === 'capabilities' || event.kind === 'usage' || event.kind === 'settings') publish();
      // A steer the turn never took in (it finished first) becomes the next turn on its own: stay working until it has run.
      if (event.kind === 'result') { turnOpen = steers.size > 0; setStatus(); if (!turnOpen && restartAfterTurn) restart(); }
  }
  const reportStorage = error => { state.error = `채팅 저장 실패: ${error.message}`; publish(); };

  // --effort is a startup flag: a running child is replaced (the next message resumes the session) once it is not mid-turn.
  function restart() {
    restartAfterTurn = false;
    if (child) { const proc = child; child = null; protocol?.dispose(); protocol = null; proc.kill('SIGTERM'); }
    setStatus();
  }
  async function start() {
    if (child) return;
    if (closed) throw fault('NOT_FOUND', '닫힌 채팅입니다.', 404);
    if (agent !== 'claude' && meta.worktree && !meta.worktreePath) {
      const target = path.join(directory, 'worktrees', `chat-${id}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await createLocalRuntime({ root: cwd }).git.createWorktree(target, `ade/chat-${id}`);
      meta.worktreePath = target; cwd = target; await saveMeta();
    }
    const extra = agent === 'claude' && prepare ? await prepare(root) : {};
    const args = [...executableArgs, ...(agent === 'claude' ? buildClaudeArgs({ sessionId: meta.sessionId, model: meta.model, effort: meta.effort, worktree: meta.worktree, addDirs: meta.addDirs, permissionMode: meta.permissionMode, resumeAt: meta.resumeAt, fork: meta.fork, ...extra }) : agent === 'codex' ? ['app-server'] : ['acp'])];
    if (agent !== 'claude') protocol = createChatProtocol(agent, { write, emit: handleEvent });
    // shell:false and argv only: the message text never reaches a shell.
    const run = () => {
      const launchEnv = { ...process.env, ...(typeof env === 'function' ? env() : env), NO_COLOR: '1' };
      if (agent === 'codex') { meta.configDir ??= launchEnv.CODEX_HOME || path.join(os.homedir(), '.codex'); launchEnv.CODEX_HOME = meta.configDir; }
      if (agent === 'claude' && meta.configDir) launchEnv.CLAUDE_CONFIG_DIR = meta.configDir;
      return spawnProcess(executable, args, { cwd, env: launchEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    };
    let proc = run();
    // The app may have been started before `claude` was installed or before its PATH was known: let the caller refresh PATH once.
    const spawned = await new Promise(resolve => { proc.once('spawn', () => resolve(true)); proc.once('error', error => resolve(error)); });
    if (spawned !== true) {
      if (spawned.code === 'ENOENT' && recover && await recover().then(() => true, () => false)) { proc = run(); const again = await new Promise(resolve => { proc.once('spawn', () => resolve(true)); proc.once('error', error => resolve(error)); }); if (again !== true) throw fault('AGENT_UNAVAILABLE', `${executable} 명령을 시작하지 못했습니다. 설치와 로그인을 확인하세요.`, 503); }
      else throw fault('AGENT_UNAVAILABLE', `${executable} 명령을 시작하지 못했습니다. 설치와 로그인을 확인하세요.`, 503);
    }
    attach(proc);
    if (protocol) { try { await protocol.initialize(meta, cwd, mcpServers()); await saveMeta(); } catch (error) { restart(); throw error; } }
  }
  function attach(proc) {
    child = proc;
    let buffer = '', stderr = '';
    const decoder = new StringDecoder('utf8');
    proc.stdout.on('data', chunk => {
      if (child !== proc || closed) return;
      buffer += decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line) continue;
        if (Buffer.byteLength(line) > MAX_LINE) { emit({ kind: 'error', message: '응답 한 줄이 너무 큽니다.' }); proc.kill('SIGTERM'); return; }
        let raw; try { raw = JSON.parse(line); } catch { emit({ kind: 'raw', original: 'unparsed' }, { store: false }); continue; }
        try { handleRaw(raw); } catch (error) { emit({ kind: 'error', message: error.message }); proc.kill('SIGTERM'); }
      }
      if (Buffer.byteLength(buffer) > MAX_LINE) { buffer = ''; emit({ kind: 'error', message: '응답 한 줄이 너무 큽니다.' }); proc.kill('SIGTERM'); }
    });
    proc.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
    proc.stdin.on('error', () => {}); // EPIPE once the child is gone; the exit handler reports it
    proc.once('close', (code, signal) => {
      if (child !== proc) return;
      child = null; protocol?.dispose(); protocol = null; turnOpen = false; meta.costBase = state.costUsd; approvals.clear(); controls.clear(); dropSteers();
      // A clean end after an interrupt/close is not an error.
      if (!closed && code !== 0 && signal !== 'SIGTERM') emit({ kind: 'error', message: `${agent}가 종료되었습니다 (${code ?? signal}). 설치와 로그인을 확인하세요.` });
      void saveMeta().catch(reportStorage); setStatus();
    });
    setStatus();
  }
  const write = line => new Promise((resolve, reject) => child.stdin.write(line, error => error ? reject(error) : resolve()));
  const control = (request, timeoutMs = 5000) => new Promise(resolve => {
    if (!child) return resolve(null);
    const requestId = randomUUID(), timer = setTimeout(() => { controls.delete(requestId); resolve(null); }, timeoutMs);
    controls.set(requestId, response => { clearTimeout(timer); resolve(response); });
    void write(controlLine(requestId, request)).catch(() => { clearTimeout(timer); controls.delete(requestId); resolve(null); });
  });

  await saveMeta(); setStatus();
  return {
    id, agent, get cwd() { return cwd; },
    loadCatalog(catalog, defaultModel, configOptions = []) {
      if (agent === 'cursor' && child) return;
      state.capabilities.catalog = catalog;
      const selected = catalog.find(item => item.id === (meta.model ?? defaultModel));
      if (agent === 'cursor') {
        if (!meta.model) { state.capabilities.configOptions = configOptions; state.model = defaultModel ?? state.model; }
        const effort = cursorEffortOption(state.capabilities.configOptions ?? []);
        state.capabilities.efforts = effort?.options.map(item => item.value) ?? [];
        state.effort = effort?.currentValue ?? null;
      } else state.capabilities.efforts = selected?.efforts ?? [];
      state.capabilities.images = selected?.images !== false;
      publish();
    },
    state: () => ({ ...state, tokens: { ...state.tokens }, pending: approvals.size }),
    replay: since => ({ events: events.filter(event => event.seq > (Number.isSafeInteger(since) ? since : 0)), seq, state: { ...state, tokens: { ...state.tokens }, pending: approvals.size },
      approvals: [...approvals.values()] }),
    // `steer` sends into the running turn: the CLI folds the line into that turn (one `result` for both; checked with claude 2.1.322),
    // so turn state is left alone. ponytail: a steer racing the turn's last event may open a second turn, status then flickers idle once.
    async send(text, images = [], { steer = false } = {}) {
      live();
      if (configuring) throw fault('CHAT_BUSY', '모델 설정이 끝난 뒤 보내세요.', 409);
      if (typeof text !== 'string' || !text.trim() || text.length > 200_000 || text.includes('\0')) throw fault('INVALID_INPUT', '메시지를 확인하세요.');
      if (turnOpen && steer && child) {
        if (!state.capabilities.steer) throw fault('CHAT_UNSUPPORTED', state.capabilities.limitations.steer, 409);
        const uuid = randomUUID(); steers.set(uuid, { text, images: images.length });
        emit({ kind: 'steer', phase: 'queued', uuid, text, images: images.length });
        try { if (protocol) { await protocol.send(text, images, { steer: true }); steers.delete(uuid); emit({ kind: 'steer', phase: 'applied', uuid, text, images: images.length }); } else await write(userLine(text, images, uuid)); } catch (error) { steers.delete(uuid); emit({ kind: 'steer', phase: 'cancelled', uuid, text }); throw error; }
        return;
      }
      if (turnOpen) throw fault('CHAT_BUSY', '이전 응답이 끝난 뒤 보내세요.', 409);
      state.error = null; turnOpen = true;
      try { await start(); emit({ kind: 'user', text, images: images.length }); await saveMeta(); if (protocol) await protocol.send(text, images); else await write(userLine(text, images)); }
      catch (error) { turnOpen = false; if (protocol) restart(); setStatus(); throw error; }
      setStatus();
    },
    async approve(requestId, answer) {
      live();
      const pending = approvals.get(requestId);
      if (!pending || !child) throw fault('NOT_FOUND', '이미 처리된 승인입니다.', 404);
      if (pending.questions && answer.allow) {
        if (!answer.answers || typeof answer.answers !== 'object' || Array.isArray(answer.answers)) throw fault('INVALID_INPUT', '질문에 답변하세요.');
        for (const question of pending.questions) {
          const values = answer.answers[question.id];
          if (!Array.isArray(values) || !values.length || values.length > (question.allowMultiple ? 32 : 1) || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 4000 || value.includes('\0') || (question.options?.length && !question.options.some(option => option.id === value)))) throw fault('INVALID_INPUT', '질문 답변을 확인하세요.');
        }
      }
      if (protocol) await protocol.approve(requestId, answer);
      else await write(approvalLine(requestId, { allow: answer.allow === true, input: pending.input, message: answer.message, suggestions: answer.always === true ? pending.suggestions : [] }));
      approvals.delete(requestId);
      emit({ kind: 'approval', phase: 'answer', requestId, tool: pending.tool, allow: answer.allow === true });
      setStatus();
    },
    async interrupt() {
      live();
      if (!child) return;
      if (protocol) { await protocol.interrupt(); return; }
      approvals.clear(); dropSteers();
      const response = await control({ subtype: 'interrupt' }, 3000);
      // No answer from the CLI: end the child; the next message resumes the session.
      if (!response) child?.kill('SIGTERM');
      turnOpen = false; setStatus();
    },
    async set({ model, effort, worktree, addDirs, permissionMode, configOption }) {
      live();
      if (configOption !== undefined && (agent !== 'cursor' || !configOption || typeof configOption !== 'object' || typeof configOption.configId !== 'string' || typeof configOption.value !== 'string' || configOption.configId.length > 200 || configOption.value.length > 200)) throw fault('INVALID_INPUT', '모델 옵션을 확인하세요.');
      if (configuring) throw fault('CHAT_BUSY', '모델 설정을 적용 중입니다.', 409);
      if (agent !== 'claude') {
        const caps = state.capabilities;
        if (worktree !== undefined && typeof worktree !== 'boolean') throw fault('INVALID_INPUT', '워크트리 설정을 확인하세요.');
        if (permissionMode !== undefined && !caps.permissionModes.includes(permissionMode)) throw fault('INVALID_INPUT', '지원하지 않는 권한 모드입니다.');
        if (model !== undefined && model !== null && !(typeof model === 'string' && /^[\w.\[\],=:-]{1,200}$/.test(model))) throw fault('INVALID_INPUT', '잘못된 모델입니다.');
        if (effort != null && !caps.efforts.includes(effort)) throw fault('INVALID_INPUT', '선택한 모델이 지원하지 않는 Effort입니다.');
        if (worktree !== undefined && (meta.sessionId || child)) throw fault('INVALID_INPUT', '워크트리는 대화 시작 전에만 정할 수 있습니다.');
        if (addDirs !== undefined) {
          if (!caps.addDirs) throw fault('CHAT_UNSUPPORTED', caps.limitations.addDirs, 409);
          if (!Array.isArray(addDirs) || addDirs.length > 8 || !addDirs.every(item => typeof item === 'string' && path.isAbsolute(item) && item.length <= 1024 && !item.includes('\0'))) throw fault('INVALID_INPUT', '잘못된 폴더 목록입니다.');
          for (const dir of addDirs) if (!(await fs.stat(dir).then(info => info.isDirectory(), () => false))) throw fault('INVALID_INPUT', `폴더를 찾을 수 없습니다: ${dir}`);
        }
        if (agent === 'cursor' && (model !== undefined || effort !== undefined || configOption !== undefined || permissionMode !== undefined)) {
          if (turnOpen || approvals.size) throw fault('CHAT_BUSY', '응답이 끝난 뒤 모델 설정을 바꾸세요.', 409);
          if ([model, effort, configOption, permissionMode].filter(value => value !== undefined).length > 1 || worktree !== undefined || addDirs !== undefined) throw fault('INVALID_INPUT', '모델 설정은 한 번에 하나씩 바꾸세요.');
          configuring = true;
          try {
            await start();
            await protocol.configure({ model, permissionMode, configOption: effort !== undefined ? { configId: state.capabilities.effortConfigId, value: effort } : configOption });
            if (model !== undefined) { meta.model = model ?? undefined; meta.configValues = {}; meta.effort = undefined; }
            if (permissionMode !== undefined) meta.permissionMode = permissionMode;
            if (configOption || effort !== undefined) {
              meta.model = state.model ?? meta.model;
              const option = configOption ?? { configId: state.capabilities.effortConfigId, value: effort };
              meta.configValues = { ...meta.configValues, [option.configId]: option.value };
            }
            await saveMeta(); publish(); return;
          } finally { configuring = false; }
        }
        for (const [key, value] of Object.entries({ model, effort, worktree, addDirs, permissionMode })) if (value !== undefined) { meta[key] = value ?? undefined; state[key] = value; }
        if (model !== undefined) { const chosen = caps.catalog.find(item => item.id === model) ?? (model === null ? caps.catalog[0] : undefined); caps.efforts = chosen?.efforts ?? []; caps.images = chosen?.images !== false; meta.effort = undefined; state.effort = null; }
        if (child) { if (turnOpen || approvals.size) restartAfterTurn = true; else restart(); }
        await saveMeta(); publish(); return;
      }
      if (permissionMode !== undefined) {
        if (!PERMISSION_MODES.includes(permissionMode)) throw fault('INVALID_INPUT', '잘못된 권한 모드입니다.');
        meta.permissionMode = state.permissionMode = permissionMode;
        if (child) await control({ subtype: 'set_permission_mode', mode: permissionMode });
      }
      if (model !== undefined) {
        if (model !== null && !(typeof model === 'string' && /^[\w.\[\]-]{1,100}$/.test(model))) throw fault('INVALID_INPUT', '잘못된 모델입니다.');
        meta.model = model ?? undefined;
        if (model === null) {
          // "Default model": the running CLI has no way to go back to its default, so it is restarted without --model (same session). Until the next
          // answer's init event reports the real model, none is shown as chosen.
          state.model = null;
          if (child) { if (turnOpen || approvals.size) restartAfterTurn = true; else restart(); }
        } else {
          state.model = model;
          if (child) await control({ subtype: 'set_model', model });
        }
      }
      if (effort !== undefined) {
        if (effort !== null && !EFFORTS.includes(effort)) throw fault('INVALID_INPUT', '잘못된 Effort입니다.');
        meta.effort = effort ?? undefined; state.effort = effort;
        if (child) { if (turnOpen || approvals.size) restartAfterTurn = true; else restart(); }
      }
      if (worktree !== undefined) {
        // Only a conversation that has not started yet can move into a worktree.
        if (meta.sessionId || child) throw fault('INVALID_INPUT', '워크트리는 새 대화를 시작하기 전에만 정할 수 있습니다.');
        meta.worktree = state.worktree = worktree === true;
      }
      if (addDirs !== undefined) {
        if (!Array.isArray(addDirs) || addDirs.length > 8 || !addDirs.every(item => typeof item === 'string' && path.isAbsolute(item) && item.length <= 1024)) throw fault('INVALID_INPUT', '잘못된 폴더 목록입니다.');
        for (const dir of addDirs) if (!(await fs.stat(dir).then(info => info.isDirectory(), () => false))) throw fault('INVALID_INPUT', `폴더를 찾을 수 없습니다: ${dir}`);
        meta.addDirs = state.addDirs = [...new Set(addDirs)];
        if (child) { if (turnOpen || approvals.size) restartAfterTurn = true; else restart(); }
      }
      await saveMeta(); publish();
    },
    // The state to start a Branch from: the transcript up to one assistant message, and the settings that make `claude` resume there as a fork.
    branchSnapshot(uuid) {
      live();
      if (!state.capabilities.branch) throw fault('CHAT_UNSUPPORTED', state.capabilities.limitations.branch, 409);
      if (turnOpen || approvals.size) throw fault('CHAT_BUSY', '응답이 끝난 뒤 분기할 수 있습니다.', 409);
      const at = events.findIndex(event => event.kind === 'message' && event.uuid === uuid);
      const kept = retainedEvents(), selected = kept.findIndex(event => event.kind === 'message' && event.uuid === uuid);
      if ((agent === 'claude' && !validMessageUuid(uuid)) || !meta.sessionId || at < 0 || selected < 0 || (agent === 'codex' && (!events[at].turnId || kept.slice(selected + 1).some(event => event.kind === 'message' && event.turnId === events[at].turnId)))) throw fault('INVALID_INPUT', '이 지점에서는 분기할 수 없습니다.');
      return { events: kept.slice(0, selected + 1), meta: { agent, cwd, worktree: meta.worktree, worktreePath: meta.worktreePath, configDir: meta.configDir, sessionId: meta.sessionId, resumeAt: agent === 'codex' ? events[at].turnId : uuid, fork: true, model: meta.model, effort: meta.effort, addDirs: meta.addDirs, permissionMode: meta.permissionMode } };
    },
    // Rewind: drop everything after one assistant message. The next message starts a fork of the session at that point (conversation only; files Claude already changed stay).
    async rewind(uuid) {
      live();
      if (turnOpen || approvals.size) throw fault('CHAT_BUSY', '응답이 끝난 뒤 되돌릴 수 있습니다.', 409);
      const snapshot = this.branchSnapshot(uuid);
      restart();
      meta.resumeAt = snapshot.meta.resumeAt; meta.fork = true;
      emit({ kind: 'rewind', uuid }); await saveMeta(); setStatus();
    },
    // Chat -> terminal: only while nothing runs. The child is ended (and waited for), so the session has a single writer again when the terminal resumes it.
    async handoff() {
      live();
      if (turnOpen || approvals.size || steers.size) throw fault('CHAT_BUSY', '응답이 끝난 뒤 전환할 수 있습니다.', 409);
      if (!meta.sessionId) throw fault('INVALID_INPUT', '아직 시작하지 않은 대화입니다. 새 터미널을 여세요.', 409);
      if (meta.resumeAt) throw fault('INVALID_INPUT', '되돌린 직후에는 전환할 수 없습니다. 메시지를 한 번 보낸 뒤 전환하세요.', 409);
      if (child) {
        const proc = child; child = null; protocol?.dispose(); protocol = null; proc.kill('SIGTERM');
        await new Promise(resolve => { if (proc.exitCode !== null || proc.signalCode) return resolve(); const timer = setTimeout(resolve, 3000); proc.once('close', () => { clearTimeout(timer); resolve(); }); });
        if (proc.exitCode === null && !proc.signalCode) throw fault('CHAT_SWITCH_FAILED', 'Claude를 종료하지 못해 전환을 중단했습니다.', 500);
      }
      setStatus();
      return { agent, sessionId: meta.sessionId, configDir: meta.configDir };
    },
    // Esc on a queued steering message: the CLI withdraws it if the running turn has not taken it in yet (cancel_async_message).
    async cancelSteer() {
      live();
      if (!state.capabilities.cancelSteer) throw fault('CHAT_UNSUPPORTED', state.capabilities.limitations.cancelSteer, 409);
      const uuid = [...steers.keys()].at(-1), item = steers.get(uuid);
      if (!item || !child) return false;
      const response = await control({ subtype: 'cancel_async_message', message_uuid: uuid }, 3000);
      if (response?.response?.cancelled !== true) return false;
      steers.delete(uuid); emit({ kind: 'steer', phase: 'cancelled', uuid, text: item.text });
      return true;
    },
    // /clear: forget the Claude-side session and start a fresh one; the old transcript stays as history above a divider.
    async reset() {
      live();
      if (configuring) throw fault('CHAT_BUSY', '모델 설정을 적용 중입니다.', 409);
      if (turnOpen || approvals.size) throw fault('CHAT_BUSY', '응답이 끝난 뒤 새 대화를 시작할 수 있습니다.', 409);
      if (state.sessionId) await seedChat({ directory, id: randomUUID(), events: retainedEvents(), meta: snapshotMeta() });
      restart();
      meta.resumeAt = undefined; meta.fork = false;
      approvals.clear(); dropSteers(false); turnOpen = false; meta.sessionId = undefined; meta.costBase = 0; state.sessionId = null; state.costUsd = agent === 'claude' ? 0 : null; state.contextTokens = 0; state.tokens = zero(); state.turns = 0; state.durationMs = 0;
      emit({ kind: 'divider', reason: 'clear' }); await saveMeta(); setStatus();
    },
    async close({ forget = false } = {}) {
      if (closed) return;
      closed = true; clearTimeout(idleTimer);
      if (child) { const proc = child; child = null; protocol?.dispose(); protocol = null; proc.kill('SIGTERM'); setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 3000).unref(); }
      await writing.catch(() => {});
      if (forget) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      else { await saveMeta(); }
    }
  };
}

// Only this project's stored Chat sessions are listed; the provider's private CLI history stays with its CLI.
export async function listChatSessions({ directory, agent, exclude }) {
  if (!chatAgents.includes(agent)) throw fault('INVALID_INPUT', '잘못된 에이전트입니다.');
  const root = path.join(directory, 'chat');
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID.test(entry.name) || entry.name === exclude) continue;
    try {
      const file = path.join(root, entry.name, 'meta.json'), meta = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!meta || (meta.agent ?? 'claude') !== agent || typeof meta.sessionId !== 'string' || !meta.sessionId) continue;
      sessions.push({ id: entry.name, title: typeof meta.title === 'string' && meta.title ? meta.title : `대화 ${String(meta.sessionId).slice(0, 8)}`, model: [meta.lastModel, meta.model].find(value => typeof value === 'string' && value) ?? null, updatedAt: (await fs.stat(file)).mtimeMs });
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Writes a new chat's folder from a Branch snapshot; `openChatSession` then loads it like any stored chat.
export async function seedChat({ directory, id, events, meta }) {
  const root = chatFolder(directory, id);
  if (await fs.stat(path.join(root, 'meta.json')).then(() => true, () => false)) throw fault('INVALID_INPUT', '이미 있는 채팅입니다.');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, 'events.jsonl'), events.map(event => JSON.stringify(event) + '\n').join(''), { mode: 0o600 });
  await fs.writeFile(path.join(root, 'meta.json'), JSON.stringify({ ...meta, costBase: 0 }), { mode: 0o600 });
}

// Cursor publishes its catalog on a new ACP session; this empty session makes no model call.
export async function probeAgentModels({ agent, cwd, env = {}, spawnProcess = spawn, executable = agent === 'cursor' ? 'cursor-agent' : agent, executableArgs = [], timeoutMs = 30_000 }) {
  if (!['codex', 'cursor'].includes(agent)) throw fault('INVALID_INPUT', '잘못된 에이전트입니다.');
  const proc = spawnProcess(executable, [...executableArgs, agent === 'codex' ? 'app-server' : 'acp'], { cwd, env: { ...process.env, ...(typeof env === 'function' ? env() : env), NO_COLOR: '1' }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', catalog = [], configOptions = [], model = null;
  const decoder = new StringDecoder('utf8');
  const protocol = createChatProtocol(agent, { write: line => new Promise((resolve, reject) => proc.stdin.write(line, error => error ? reject(error) : resolve())),
    emit: event => { if (event.kind === 'capabilities') { catalog = event.capabilities.catalog; configOptions = event.capabilities.configOptions; } if (event.kind === 'session' && event.model) model = event.model; } });
  proc.stderr.resume(); proc.stdin.on('error', () => {});
  proc.on('error', () => protocol.dispose()); proc.on('close', () => protocol.dispose());
  proc.stdout.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > MAX_LINE) { protocol.dispose(); proc.kill(); return; }
    let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); try { protocol.handle(JSON.parse(line)); } catch {} }
  });
  const timer = setTimeout(() => { protocol.dispose(); proc.kill(); }, timeoutMs);
  try { await protocol.initialize({ discoverOnly: true, addDirs: [], permissionMode: 'default' }, cwd); return { models: model ? { '': model } : {}, catalog, configOptions }; }
  finally { clearTimeout(timer); protocol.dispose(); proc.kill(); const force = setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 3000); force.unref(); }
}

// A terminal's Claude conversation continued as a chat: its transcript becomes the stored events, and `claude -p --resume` takes over the same session.
// `configDir` keeps the account whose folder holds that session. ponytail: only the last 16 MB of a transcript are read (the chat keeps 4000 events anyway).
export async function seedFromTranscript({ directory, id, file, sessionId, configDir, model }) {
  const handle = await fs.open(file, 'r');
  let text;
  try { const { size } = await handle.stat(), length = Math.min(size, 16 * 1024 * 1024), buffer = Buffer.alloc(length); await handle.read(buffer, 0, length, size - length); text = buffer.toString('utf8'); } finally { await handle.close(); }
  const events = transcriptEvents(text).map((event, index) => ({ ...event, seq: index + 1, at: event.at ?? Date.now() }));
  const last = events.findLast(event => event.kind === 'message' && /^claude-/.test(event.model ?? ''));
  await seedChat({ directory, id, events, meta: { sessionId, configDir, model: model ?? last?.model, addDirs: [], permissionMode: 'default' } });
  return events.length;
}

// Slash commands the CLI would offer before its first reply: user and project commands and skills. The live list from the
// session's init message replaces this once the child has started.
export async function listCommands(cwd, home) {
  const out = new Map();
  const add = (name, file, source) => fs.readFile(file, 'utf8').then(body => {
    const description = /^description:\s*(.+)$/m.exec(body.slice(0, 1500))?.[1]?.replace(/^["']|["']$/g, '').trim();
    if (!out.has(name)) out.set(name, { name, description: description ?? '', source });
  }, () => {});
  async function walk(dir, prefix, source) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${prefix}${entry.name}:`, source);
      else if (entry.name.endsWith('.md')) await add(prefix + entry.name.slice(0, -3), path.join(dir, entry.name), source);
    }
  }
  for (const [base, source] of [[path.join(cwd, '.claude'), 'project'], [path.join(home, '.claude'), 'user']]) {
    await walk(path.join(base, 'commands'), '', source);
    for (const entry of await fs.readdir(path.join(base, 'skills'), { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await add(entry.name, path.join(base, 'skills', entry.name, 'SKILL.md'), source);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Which concrete model each alias means right now. The CLI answers this for free: a local slash command (`/cost`) makes `claude -p` print
// its init event (with the resolved model) and finish with no model call (cost 0, 0 turns). No login data is read; the child is stopped at init.
// Result: { '': default model, opus: id, sonnet: id, haiku: id } (an alias that failed is left out).
export async function probeModels({ env = {}, spawnProcess = spawn, executable = 'claude', cwd = os.tmpdir(), aliases = ['', 'opus', 'sonnet', 'haiku'], timeoutMs = 25_000 } = {}) {
  const one = alias => new Promise(resolve => {
    let proc, buffer = '', done = false;
    const finish = model => { if (done) return; done = true; clearTimeout(timer); try { proc?.kill(); } catch {} resolve(model); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      proc = spawnProcess(executable, ['-p', '/cost', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', ...(alias ? ['--model', alias] : [])],
        { cwd, env: { ...process.env, ...(typeof env === 'function' ? env() : env), NO_COLOR: '1' }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return finish(null); }
    proc.once('error', () => finish(null)); proc.once('close', () => finish(null));
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try { const event = JSON.parse(line); if (event.type === 'system' && event.subtype === 'init') return finish(typeof event.model === 'string' ? event.model : null); } catch {}
      }
    });
  });
  const found = await Promise.all(aliases.map(async alias => [alias, await one(alias)]));
  return Object.fromEntries(found.filter(([, model]) => model));
}

// Every model the CLI offers right now. The CLI keeps its own catalog (fetched with the user's login, refreshed about hourly while it runs) in
// ~/.claude/cache/model-catalog/*-cc.json; only the model list is read from the newest one: id, name, family, context window. Nothing else in the
// file (and no credential) is used. [] when the CLI has no catalog yet or its format changed.
export async function readModelCatalog(home = os.homedir()) {
  const dir = path.join(home, '.claude', 'cache', 'model-catalog');
  let best = null;
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!name.endsWith('-cc.json')) continue;
    try {
      const file = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')), models = file?.catalog?.config?.models;
      if (Array.isArray(models) && Number(file.fetchedAt) > (best?.at ?? 0)) best = { at: Number(file.fetchedAt), models };
    } catch {}
  }
  return (best?.models ?? []).slice(0, 64).flatMap(item => {
    const id = item?.id, name = item?.name;
    if (typeof id !== 'string' || typeof name !== 'string' || !/^[\w.-]{1,100}$/.test(id) || name.length > 40) return [];
    const family = String(typeof item.runtime?.family === 'string' ? item.runtime.family : name.split(' ')[0]).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    return [{ id, name, family, window: Number(item.runtime?.max_input_tokens) || 0, main: item.section === 'main' }];
  });
}
