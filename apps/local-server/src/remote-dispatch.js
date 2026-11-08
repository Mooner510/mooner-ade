// What a remote device may ask of this ADE. Deny by default: an action is allowed only if it is listed here for the device's
// scope, and only the listed fields of its input reach route() (anything else, such as `force`, is dropped). This runs
// before route() and before the WebSocket message handler, so a remote request can never reach code the list does not name.
// Specified in docs/REMOTE_ACCESS.md ("원격 권한").
import { fault } from './files.js';

export const SCOPES = ['view', 'control'];
export const REMOTE_TERMINAL_LIMIT = 8;

const id = (max = 128) => value => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const optional = check => value => value === undefined || check(value);
const filePath = id(4096);
const PROJECT = { projectId: id(), repositoryId: optional(id()) };

// action → { scope, fields, check? }. `check` names a dynamic condition the gateway verifies against live state.
const API = {
  'system/info': { scope: 'view', fields: {} },
  'shell/list': { scope: 'view', fields: {} },
  home: { scope: 'view', fields: {} },
  recent: { scope: 'view', fields: {} },
  // Reading only: an input with `state` would be a write and is refused below.
  'app/state': { scope: 'view', fields: {} },
  // `force` re-runs checks and API calls on the host; a remote reader gets the cached answer.
  readiness: { scope: 'view', fields: { projectId: optional(id()) } },
  'usage/status': { scope: 'view', fields: { provider: value => value === 'claude' || value === 'codex', projectId: optional(id()) } },
  snapshot: { scope: 'view', fields: { projectId: id() } },
  'git/status': { scope: 'view', fields: PROJECT },
  'git/branches': { scope: 'view', fields: PROJECT },
  // HEAD and staged contents come from git; the working tree file is read from disk, which needs control.
  'git/show': { scope: 'view', fields: { ...PROJECT, path: filePath, staged: optional(value => typeof value === 'boolean'), working: optional(value => typeof value === 'boolean') } },
  'project/open': { scope: 'control', fields: { path: filePath }, check: 'known-project' },
  'git/checkout': { scope: 'control', fields: { ...PROJECT, branch: id(256) } },
  'git/worktree-setting': { scope: 'control', fields: { ...PROJECT, enabled: value => typeof value === 'boolean' } },
  'git/worktree/integrate': { scope: 'control', fields: { ...PROJECT, confirm: id(256) } },
  // restoreId resumes a saved agent session, which only the window that saved it knows about.
  'terminal/open': { scope: 'control', fields: { projectId: id(), path: optional(filePath), agent: optional(value => ['claude', 'codex', 'cursor'].includes(value)), args: optional(value => typeof value === 'string' && value.length <= 512) }, check: 'remote-terminal' },
  'terminal/close': { scope: 'control', fields: { projectId: id(), id: id() } },
  'terminal/follow-up': { scope: 'control', fields: { projectId: id(), id: id(), prompt: value => typeof value === 'string' && value.length <= 16000, requestId: id(100), sequence: Number.isSafeInteger } }
};

// Messages a remote device may send on its session, in the same shape as the window's /ws messages.
const WS = {
  subscribe: { scope: 'view', fields: { projectId: id() } },
  unsubscribe: { scope: 'view', fields: { projectId: id() } },
  'terminal/input': { scope: 'control', fields: { projectId: id(), id: id(), data: value => typeof value === 'string' && value.length <= 16384 } },
  'terminal/resize': { scope: 'control', fields: { projectId: id(), id: id(), cols: value => Number.isInteger(value) && value >= 1 && value <= 1000, rows: value => Number.isInteger(value) && value >= 1 && value <= 1000 } },
  'terminal/paste-image': { scope: 'control', fields: { projectId: id(), id: id(), mime: value => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(value), data: value => typeof value === 'string' && value.length <= 28 * 1024 * 1024 } }
};

const allows = (scope, needed) => scope === 'control' || (scope === 'view' && needed === 'view');
const denied = () => fault('REMOTE_FORBIDDEN', '원격 기기에서 허용되지 않은 작업입니다.', 403);
function pick(rule, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('INVALID_INPUT', '객체 요청이 필요합니다.');
  const out = {};
  for (const [key, valid] of Object.entries(rule.fields)) {
    if (!valid(input[key])) throw fault('INVALID_INPUT', `잘못된 입력입니다: ${key}`);
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

// Returns { action, input, check } with only the allowed fields, or throws REMOTE_FORBIDDEN / INVALID_INPUT.
export function remoteApi(action, input, scope) {
  if (!SCOPES.includes(scope) || typeof action !== 'string' || !Object.hasOwn(API, action)) throw denied();
  const rule = API[action];
  if (!allows(scope, rule.scope)) throw denied();
  if (action === 'app/state' && input && 'state' in input) throw denied();
  const clean = pick(rule, input ?? {});
  if (action === 'git/show' && clean.working && scope !== 'control') throw denied();
  return { action, input: clean, check: rule.check ?? null };
}

export function remoteMessage(message, scope) {
  if (!SCOPES.includes(scope) || !message || typeof message !== 'object' || typeof message.type !== 'string' || !Object.hasOwn(WS, message.type)) throw denied();
  const rule = WS[message.type];
  if (!allows(scope, rule.scope)) throw denied();
  return { type: message.type, ...pick(rule, message) };
}

// What the host tells a remote device it may do, so the app can hide controls it would only be refused.
export const scopeSummary = scope => ({
  scope,
  api: Object.keys(API).filter(action => allows(scope, API[action].scope)),
  messages: Object.keys(WS).filter(type => allows(scope, WS[type].scope))
});
