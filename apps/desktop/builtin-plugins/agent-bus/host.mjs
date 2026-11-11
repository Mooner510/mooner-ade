// Agent bus host: the built-in plugin process. It listens on a loopback port for the MCP servers the chats' agents run (mcp.mjs), applies
// the bus rules (bus.mjs) and reaches the chats through a workspace session of the local server (chat/peers, chat/send).
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BusError, createBus } from './bus.mjs';
import { AGENT_NAMES, DEFAULTS, cleanSettings, fieldsFor, parseValues } from './settings.mjs';

const SESSION = 'bus', MAX_REQUEST = 256 * 1024;
const toApp = message => { if (process.send) process.send(message); };
const log = (level, message) => toApp({ type: 'log', level, message });

let settings = { ...DEFAULTS }, link = null, server = null, bus = null, stopping = false, viewTimer = null;
let apiId = 0, sessionOpen = false, idleTimer = null;
const pendingApi = new Map();

// ---- the local server ---------------------------------------------------------------------------------------------------
// The workspace session is open only while the bus talks to the server (and for a few seconds after). An open session counts as work in
// progress for the auto-updater, so one kept open all day would keep the app from ever updating.
const SESSION_IDLE_MS = 15_000;
function useSession() {
  if (!sessionOpen) { toApp({ type: 'workspace', op: 'open', session: SESSION }); sessionOpen = true; }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(function close() {
    if (pendingApi.size) { idleTimer = setTimeout(close, 1000); idleTimer.unref?.(); return; }
    if (sessionOpen) { toApp({ type: 'workspace', op: 'close', session: SESSION }); sessionOpen = false; }
  }, SESSION_IDLE_MS);
  idleTimer.unref?.();
}
function api(action, input) {
  return new Promise((resolve, reject) => {
    useSession();
    const id = ++apiId, timer = setTimeout(() => { pendingApi.delete(id); reject(new BusError('The ADE server did not answer.', 'TIMEOUT')); }, 30_000);
    timer.unref?.();
    pendingApi.set(id, { resolve, reject, timer });
    toApp({ type: 'workspace', op: 'api', session: SESSION, id, action, input });
  });
}
function onWorkspace(message) {
  if (message.op === 'api-result') {
    const pending = pendingApi.get(message.id);
    if (!pending) return;
    pendingApi.delete(message.id); clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(Object.assign(new Error(message.error?.message ?? 'The ADE server refused the request.'), { code: message.error?.code }));
  } else if (message.op === 'closed' || message.op === 'reset') {
    // The server restarted (or refused the session): every call in flight is lost, and the next call opens the session again.
    sessionOpen = false;
    for (const pending of pendingApi.values()) { clearTimeout(pending.timer); pending.reject(new BusError('The ADE server restarted.', 'SERVER_RESET')); }
    pendingApi.clear();
  }
}

// ---- what the agents' MCP servers ask --------------------------------------------------------------------------------
async function handle(request) {
  if (request.op === 'peers') return bus.peers(request.self);
  if (request.op === 'send') return bus.send(request.self, { to: request.to, message: request.message });
  throw new BusError('Unknown request.', 'INVALID_INPUT');
}
const sameToken = (given, wanted) => typeof given === 'string' && given.length === wanted.length && timingSafeEqual(Buffer.from(given), Buffer.from(wanted));
function onConnection(socket) {
  let buffer = '', answered = false;
  socket.setEncoding('utf8'); socket.setTimeout(120_000, () => socket.destroy());
  socket.on('error', () => {});
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > MAX_REQUEST) { socket.destroy(); return; }
    const end = buffer.indexOf('\n');
    if (end < 0 || answered) return;
    answered = true;
    const reply = value => socket.end(`${JSON.stringify(value)}\n`);
    let request;
    try { request = JSON.parse(buffer.slice(0, end)); } catch { reply({ ok: false, error: { message: 'Invalid request.', code: 'INVALID_INPUT' } }); return; }
    if (!request || typeof request !== 'object' || !sameToken(request.token, link.token)) { reply({ ok: false, error: { message: 'Not allowed.', code: 'FORBIDDEN' } }); return; }
    handle(request).then(value => reply({ ok: true, value }), error => reply({ ok: false, error: { message: String(error?.message ?? error).slice(0, 600), code: error?.code ?? 'ERROR' } }));
  });
}
// The port and token stay the same across restarts, so chats started earlier keep reaching the bus; another program on the port makes a new one.
function listen(port) {
  return new Promise((resolve, reject) => {
    const candidate = net.createServer(onConnection);
    candidate.once('error', error => { if (port && error.code === 'EADDRINUSE') resolve(listen(0)); else reject(error); });
    candidate.listen(port, '127.0.0.1', () => { candidate.removeAllListeners('error'); candidate.on('error', () => {}); resolve(candidate); });
  });
}

// ---- the settings page ---------------------------------------------------------------------------------------------------
const STATUS = { delivered: '전달함', queued: '대기 중', failed: '실패', rejected: '거부함' };
const REASON = { rate: '전송 한도', hops: '연쇄 한도', timeout: '시간 초과', closed: '채팅이 닫힘' };
const clock = at => new Date(at).toTimeString().slice(0, 8);
function view() {
  const { stats, history } = bus.snapshot();
  const recent = [...history].reverse().slice(0, 12).map(entry => ({
    label: `${clock(entry.at)} ${AGENT_NAMES[entry.from.agent] ?? entry.from.agent} → ${entry.to ? AGENT_NAMES[entry.to.agent] ?? entry.to.agent : '—'}`.slice(0, 60),
    value: [STATUS[entry.status] ?? entry.status, REASON[entry.reason] ?? entry.reason, entry.length ? `${entry.length}자` : '', entry.hop ? `답장 ${entry.hop}단계` : '', entry.preview].filter(Boolean).join(' · ')
  }));
  return {
    status: { tone: 'ok', text: `실행 중 · 전달 ${stats.delivered}건 · 대기 ${stats.queued}건 · 실패 ${stats.failed}건 · 거부 ${stats.rejected}건` },
    info: [
      { label: '사용법', value: '채팅의 에이전트에게 "Codex 채팅에 이 내용을 전달해"처럼 말하면, 에이전트가 list_peers로 채팅을 찾고 send_message로 보냅니다. 받는 채팅에는 사용자 승인 없이 바로 전달됩니다.' },
      { label: '적용 시점', value: '규칙 설정은 바로 적용됩니다. 에이전트 도구(MCP)는 새로 시작하는 에이전트부터 받습니다. 이미 응답 중인 채팅은 쉬었다가 다음 메시지부터 받습니다.' },
      ...(recent.length ? recent : [{ label: '최근 메시지', value: '아직 없습니다.' }])
    ],
    fields: fieldsFor(settings),
    actions: [{ id: 'save', label: '저장', primary: true }, { id: 'reset', label: '기본값으로' }, { id: 'clear-log', label: '기록 지우기' }]
  };
}
const publish = () => toApp({ type: 'view', view: view() });
// Messages can come in bursts: the page is drawn again at most once a second.
function publishSoon() { if (!viewTimer) { viewTimer = setTimeout(() => { viewTimer = null; publish(); }, 1000); viewTimer.unref?.(); } }
const persist = () => toApp({ type: 'storage', value: { settings, link: { port: link.port, token: link.token } } });
const offer = () => toApp({ type: 'terminal', mcpArgs: ['--port', String(link.port), '--token', link.token], autoApprove: settings.autoApprove });

function onAction({ id, action, values }) {
  const done = (ok, text) => toApp({ type: 'action-result', id, ok, ...(ok ? { message: text } : { error: text }) });
  try {
    if (action === 'save' || action === 'reset') {
      const before = settings.autoApprove;
      settings = action === 'reset' ? cleanSettings() : parseValues(values, settings);
      bus.setSettings(settings); persist();
      if (settings.autoApprove !== before) offer();
      publish(); done(true, action === 'reset' ? '기본값으로 되돌렸습니다.' : '저장했습니다.');
    } else if (action === 'clear-log') { bus.clearLog(); publish(); done(true, '기록을 지웠습니다.'); }
    else done(false, '알 수 없는 작업입니다.');
  } catch (error) { done(false, error.message); }
}

async function start({ storage }) {
  settings = cleanSettings(storage?.settings);
  const saved = storage?.link;
  link = { port: Number.isInteger(saved?.port) ? saved.port : 0, token: typeof saved?.token === 'string' && /^[0-9a-f]{48}$/.test(saved.token) ? saved.token : randomBytes(24).toString('hex') };
  bus = createBus({ api, settings, onChange: publishSoon });
  server = await listen(link.port);
  link.port = server.address().port;
  persist(); publish(); offer();
  toApp({ type: 'ready' });
}

process.on('message', message => {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'init') start(message).catch(error => { log('error', `agent bus failed to start: ${error.message}`); process.exit(1); });
  else if (message.type === 'action') onAction(message);
  else if (message.type === 'workspace') onWorkspace(message);
  else if (message.type === 'shutdown') { stopping = true; bus?.stop(); server?.close(); process.exit(0); }
});
