// IPC contract and normalization from ADE 0.6.3.
import path from 'node:path';
import { fail, plainText, pluginSource, str, UNSAFE_TEXT } from '../metadata.js';

const features = Object.freeze(['view.setup', 'view.lists', 'view.document', 'view.password', 'view.folder', 'header', 'updates', 'hub']);
const STEP_ID = /^[a-z][a-z0-9-]{0,31}$/;
const ITEM_ID = /^[\w.-]{1,64}$/;
const MCP_NAME = /^[a-z][a-z0-9_]{1,39}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const FIELD_KEY = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const ACTION_ID = /^[a-z][a-z0-9-]{0,31}$/;
// A prefix may not reach into what the app, Node or the agents read themselves, nor into variables that run code or move
// trust in every shell and tool started there (shell startup, proxies, TLS trust, language runtimes).
const RESERVED_PREFIX = /^(ADE_|NODE_|ELECTRON_|NPM_|CLAUDE|CODEX|OPENAI|ANTHROPIC|GIT_|SSH_|PATH|HOME|USER|SHELL|TERM|LD_|DYLD_|BASH_|PROMPT_|HTTP_|HTTPS_|ALL_|FTP_|SSL_|CURL_|REQUESTS_|JAVA_|JDK_|DOTNET_|COR_|CORECLR_|PYTHON|PIP_|SUDO_|XDG_|OTEL_|MCP_|DISABLE_|MAX_|API_)/;

const MAX_STORAGE = 64 * 1024;
const NOTIFY_PER_MINUTE = 10;

// A path inside the plugin folder, written with forward slashes, never absolute and never climbing out. No `:` anywhere:
// besides drive letters, on NTFS `host.js:x.js` names an alternate data stream, which the tree hash never reads.
function relative(value, what) {
  if (!str(value, 200) || /^[\\/]|[\\:]/.test(value)) throw fail(`${what} 경로가 올바르지 않습니다.`);
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw fail(`${what} 경로가 올바르지 않습니다.`);
  return parts.join('/');
}

export function validManifest(value, identity) {
  const manifest = { ...identity, main: relative(value.main, 'main') };
  if (!/\.(m?js)$/.test(manifest.main)) throw fail('main은 .js 또는 .mjs 파일이어야 합니다.');
  if (value.terminal !== undefined) {
    const terminal = value.terminal;
    if (!terminal || typeof terminal !== 'object') throw fail('terminal 항목이 올바르지 않습니다.');
    manifest.terminal = {};
    if (terminal.bin !== undefined) manifest.terminal.bin = relative(terminal.bin, 'terminal.bin');
    if (terminal.envPrefix !== undefined) {
      if (!str(terminal.envPrefix, 32) || !/^[A-Z][A-Z0-9]*_([A-Z0-9]+_)*$/.test(terminal.envPrefix) || terminal.envPrefix.length < 4 || RESERVED_PREFIX.test(terminal.envPrefix)) throw fail('terminal.envPrefix가 올바르지 않습니다.');
      manifest.terminal.envPrefix = terminal.envPrefix;
    }
  }
  if (value.mcp !== undefined) {
    const mcp = value.mcp;
    if (!mcp || typeof mcp !== 'object' || !str(mcp.name, 40) || !MCP_NAME.test(mcp.name)) throw fail('mcp.name이 올바르지 않습니다.');
    const args = mcp.args ?? [];
    if (!Array.isArray(args) || args.length > 8 || !args.every(arg => str(arg, 200) && !arg.includes("'"))) throw fail('mcp.args가 올바르지 않습니다.');
    manifest.mcp = { name: mcp.name, script: relative(mcp.script, 'mcp.script'), args: [...args] };
    // Only for chats (never terminals), and told which chat it serves. A plugin that talks between chats needs this.
    if (mcp.chatOnly !== undefined) {
      if (typeof mcp.chatOnly !== 'boolean') throw fail('mcp.chatOnly가 올바르지 않습니다.');
      if (mcp.chatOnly) manifest.mcp.chatOnly = true;
    }
  }
  if (value.workspace !== undefined) {
    if (typeof value.workspace !== 'boolean') throw fail('workspace 항목이 올바르지 않습니다.');
    if (value.workspace) manifest.workspace = true;
  }
  if (value.feedback !== undefined) {
    if (typeof value.feedback !== 'boolean') throw fail('feedback 항목이 올바르지 않습니다.');
    if (value.feedback) manifest.feedback = true;
  }
  if (value.icon !== undefined) {
    manifest.icon = relative(value.icon, 'icon');
    if (!/\.svg$/i.test(manifest.icon)) throw fail('icon은 .svg 파일이어야 합니다.');
  }
  if (value.header !== undefined) {
    if (typeof value.header !== 'boolean') throw fail('header 항목이 올바르지 않습니다.');
    if (value.header) manifest.header = true;
  }
  // Where updates come from: MoonerADE Hub and/or a GitHub repository's releases (plugin-updates.js).
  if (value.source !== undefined) manifest.source = pluginSource(value, manifest.id);
  // The steps that make the plugin work, shown as a guide before it even runs; the running plugin reports how far it got
  // (view.setup). Shown by MoonerADE as plain text.
  if (value.setup !== undefined) {
    if (!Array.isArray(value.setup) || value.setup.length > 8) throw fail('setup 항목이 올바르지 않습니다.');
    const seen = new Set();
    manifest.setup = value.setup.map(step => {
      if (!step || typeof step !== 'object' || !STEP_ID.test(step.id ?? '') || seen.has(step.id)) throw fail('setup 단계의 id가 올바르지 않습니다.');
      if (!str(step.label, 60) || UNSAFE_TEXT.test(step.label)) throw fail('setup 단계의 label이 올바르지 않습니다.');
      seen.add(step.id);
      return { id: step.id, label: step.label, detail: typeof step.detail === 'string' ? plainText(step.detail.slice(0, 300)) : '', ...(step.optional === true && { optional: true }) };
    });
  }
  return manifest;
}

const TONES = ['ok', 'warn', 'error', 'info'];
const FIELD_TYPES = ['text', 'select', 'switch', 'number', 'password', 'folder', 'textarea'];
// How far a setup step got: done, todo (not started), active (in progress, e.g. waiting for a browser sign-in), error.
const STEP_STATUS = ['done', 'todo', 'active', 'error'];
// The settings page draws this as plain text; nothing a plugin sends becomes markup.
export function validView(view) {
  if (!view || typeof view !== 'object') return null;
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  const list = (value, max) => Array.isArray(value) ? value.slice(0, max) : [];
  const keys = (value, test, max = 12) => [...new Set(list(value, max).filter(key => typeof key === 'string' && test.test(key)))];
  const button = item => ({ id: item.id, label: item.label, primary: item.primary === true, ...(item.danger === true && { danger: true }) });
  const validButton = item => item && ACTION_ID.test(item.id ?? '') && str(item.label, 40);
  return {
    status: view.status && TONES.includes(view.status.tone) ? { tone: view.status.tone, text: text(view.status.text, 300) } : null,
    // `key` lets a setup step show the row inside the step.
    info: list(view.info, 30).filter(item => item && str(item.label, 60)).map(item => ({ label: item.label, value: text(item.value, 2000), mono: item.mono === true, copy: item.copy === true, ...(FIELD_KEY.test(item.key ?? '') && { key: item.key }) })),
    // `type` is how the page draws the input: text (default), select (needs `options`), switch ('true' / 'false') or number. The value stays a string.
    fields: list(view.fields, 24).filter(item => item && FIELD_KEY.test(item.key ?? '') && str(item.label, 60)).map(item => {
      const type = FIELD_TYPES.includes(item.type) ? item.type : 'text';
      const options = type === 'select' ? list(item.options, 12).filter(option => option && str(option.value, 60) && str(option.label, 60)).map(option => ({ value: option.value, label: option.label })) : [];
      return { key: item.key, label: item.label, type: type === 'select' && !options.length ? 'text' : type, value: type === 'password' ? '' : text(item.value, 4096), placeholder: text(item.placeholder, 200), hint: text(item.hint, 300), ...(item.required === true && { required: true }), ...(options.length && type === 'select' && { options }) };
    }),
    actions: list(view.actions, 12).filter(validButton).map(button),
    formId: text(view.formId, 64),
    // What the plugin's header panel shows. `view` itself is the settings page, so the two can differ.
    panel: view.panel && typeof view.panel === 'object' && !Array.isArray(view.panel) ? validView({ ...view.panel, panel: undefined }) : null,
    document: view.document && str(view.document.title, 100) && str(view.document.text, 65536) ? { title: view.document.title, text: view.document.text } : null,
    // Only the text to encode; the settings page draws the code itself.
    qr: view.qr && str(view.qr.value, 1000) ? { label: text(view.qr.label, 60), value: view.qr.value } : null,
    // How far each setup step got (merged with plugin.json `setup` by id), and which fields, info rows, buttons and the QR
    // code belong to it: those are drawn inside the step instead of in the settings below.
    setup: list(view.setup?.steps ?? view.setup, 8).filter(step => step && STEP_ID.test(step.id ?? '') && STEP_STATUS.includes(step.status)).map(step => ({
      id: step.id, status: step.status,
      ...(str(step.label, 60) && !UNSAFE_TEXT.test(step.label) && { label: step.label }),
      ...(typeof step.detail === 'string' && step.detail && { detail: plainText(step.detail.slice(0, 300)) }),
      ...(typeof step.optional === 'boolean' && { optional: step.optional }),
      fields: keys(step.fields, FIELD_KEY), info: keys(step.info, FIELD_KEY), actions: keys(step.actions, ACTION_ID, 4), ...(step.qr === true && { qr: true })
    })),
    // Things the user manages one by one (paired devices, keys, ...), each with its own buttons. A button sends `action`
    // with `item` set to the item's id.
    lists: list(view.lists, 4).filter(group => group && STEP_ID.test(group.id ?? '') && str(group.title, 60)).map(group => ({
      id: group.id, title: group.title, empty: text(group.empty, 200),
      items: list(group.items, 50).filter(item => item && ITEM_ID.test(item.id ?? '') && str(item.label, 100)).map(item => ({
        id: item.id, label: item.label, detail: text(item.detail, 300),
        ...(item.tag && TONES.includes(item.tag.tone) && str(item.tag.text, 20) && { tag: { text: item.tag.text, tone: item.tag.tone } }),
        actions: list(item.actions, 4).filter(validButton).map(button)
      }))
    }))
  };
}
// A short status-bar item. Single line: it sits between MoonerADE's own items.
export function validBadge(badge) {
  if (!badge || typeof badge !== 'object' || !TONES.includes(badge.tone) || typeof badge.text !== 'string') return null;
  const text = plainText(badge.text).replace(/\s+/g, ' ').slice(0, 24).trim();
  return text ? { text, tone: badge.tone } : null;
}
// Terminal additions are limited to what the manifest declared: its own env prefix, its own bin folder, its own MCP script.
// `builtin` plugins (shipped with the app, so trusted like the app) may also ask for their MCP tools to run without a permission prompt.
export function pluginTerminal(manifest, dir, report, nodeBinary, { builtin = false } = {}) {
  const env = {};
  if (manifest.terminal?.envPrefix && report?.env && typeof report.env === 'object') {
    for (const [name, value] of Object.entries(report.env).slice(0, 32)) if (ENV_NAME.test(name) && name.startsWith(manifest.terminal.envPrefix) && typeof value === 'string' && value.length <= 4096 && !value.includes('\0')) env[name] = value;
  }
  const extra = Array.isArray(report?.mcpArgs) ? report.mcpArgs.slice(0, 16).filter(arg => str(arg, 1024) && !arg.includes("'")) : [];
  return {
    id: manifest.id, env,
    path: manifest.terminal?.bin ? [path.join(dir, ...manifest.terminal.bin.split('/'))] : [],
    mcp: manifest.mcp ? { name: manifest.mcp.name, command: nodeBinary, args: [path.join(dir, ...manifest.mcp.script.split('/')), ...manifest.mcp.args, ...extra],
      ...(manifest.mcp.chatOnly && { chatOnly: true }), ...(builtin && report?.autoApprove === true && { autoApprove: true }) } : null
  };
}

export function onMessage(host, message, context) {
  const { ask, changed, dataRoot, discoverTools, emitFeedback, emitTerminal, log, notify,
    relayWorkspace, sendHost, store, terminalNode, writeStorageFile } = context;
  const { manifest } = host.item;
  switch (message.type) {
    case 'ready': host.status = 'running'; host.error = null; changed(); emitTerminal(); break;
    case 'view': host.view = validView(message.view); changed(); break;
    case 'badge': host.badge = validBadge(message.badge); changed(); break;
    case 'notify': {
      const now = Date.now();
      host.notices = host.notices.filter(at => now - at < 60_000);
      if (host.notices.length >= NOTIFY_PER_MINUTE) break;
      const title = plainText(String(message.title ?? '')).slice(0, 100), body = plainText(String(message.body ?? '')).slice(0, 300);
      if (!title && !body) break;
      host.notices.push(now);
      // Titled by MoonerADE with the plugin's name, like its dialogs, so it cannot pass for MoonerADE's own.
      notify({ id: manifest.id, title: `플러그인: ${manifest.name}`, body: [title, body].filter(Boolean).join('\n') });
      break;
    }
    case 'storage': {
      const text = JSON.stringify(message.value ?? null);
      if (text.length > MAX_STORAGE) { log.warn(`[plugin ${host.id}] 저장할 데이터가 너무 큽니다.`); break; }
      if (host.item.builtin) { writeStorageFile(path.join(dataRoot, manifest.id), text); break; }
      // Plugins send it on every start; sealing the same value again would read the Keychain for nothing.
      if (store.state.data[manifest.id] !== text) store.update(state => ({ ...state, data: { ...state.data, [manifest.id]: text } }));
      break;
    }
    case 'confirm': {
      const id = message.id;
      // One dialog at a time, always titled with the plugin's name so it cannot pass for MoonerADE's own.
      host.confirms = host.confirms.then(async () => {
        const answer = await ask({
          type: 'warning', title: `플러그인: ${manifest.name}`, message: String(message.message ?? '').slice(0, 300) || '계속할까요?',
          detail: `${String(message.detail ?? '').slice(0, 2000)}\n\n이 확인 창은 플러그인 “${manifest.name}”(${manifest.id})이 요청했습니다.`.trim(),
          buttons: [String(message.confirmLabel ?? '').slice(0, 30) || '확인', '취소'], defaultId: 1, cancelId: 1
        }).catch(() => 1);
        if (host.child?.connected) sendHost(host, { type: 'confirm-result', id, ok: answer === 0 });
      });
      break;
    }
    // `enabled: false` withdraws the additions (e.g. a plugin that is not set up yet).
    case 'terminal':
      host.terminal = message.enabled === false ? null : pluginTerminal(manifest, host.item.dir, message, terminalNode, { builtin: host.item.builtin === true });
      if (host.status === 'running') emitTerminal();
      discoverTools(host);
      changed();
      break;
    case 'action-result': {
      const pending = host.pending.get(message.id);
      if (!pending) break;
      host.pending.delete(message.id);
      message.ok ? pending.resolve(message.message ?? null) : pending.reject(fail(String(message.error ?? '플러그인 작업이 실패했습니다.').slice(0, 500), 'PLUGIN_ACTION'));
      break;
    }
    case 'workspace': relayWorkspace(host, message); break;
    // Only for a plugin whose approved manifest declared `feedback` (docs/PLUGINS.md).
    case 'feedback': {
      if (!manifest.feedback) break;
      const account = typeof message.account === 'string' ? plainText(message.account).slice(0, 100) : '';
      const reason = typeof message.reason === 'string' ? plainText(message.reason).slice(0, 200) : '';
      host.feedback = { available: message.available === true, ...(account && { account }), ...(reason && { reason }), ...(message.statusQuery === true && { statusQuery: true }) };
      emitFeedback();
      break;
    }
    // The answer to `feedback/status`: only well-formed {state, version?, commentCount?, comments?} entries are passed on. The comments are the maintainers' answers ({at, body}, no author); none of the feedback's own text is in it.
    case 'feedback/status-result': {
      const answer = host.feedbackStatusPending.get(message.id);
      if (!answer) break;
      host.feedbackStatusPending.delete(message.id);
      if (message.ok !== true) { answer({ ok: false, error: { code: typeof message.error?.code === 'string' ? message.error.code.slice(0, 40) : 'network_error', ...(Number.isInteger(message.error?.retryAfter) && message.error.retryAfter > 0 && { retryAfter: Math.min(message.error.retryAfter, 86_400) }) } }); break; }
      const items = {};
      for (const [key, value] of Object.entries(message.items && typeof message.items === 'object' ? message.items : {}).slice(0, 50)) {
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(key) || !value || !['pending', 'beta', 'released', 'closed', 'declined'].includes(value.state)) continue;
        items[key] = { state: value.state, ...(typeof value.version === 'string' && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/.test(value.version) && { version: value.version }),
          ...(Number.isSafeInteger(value.commentCount) && value.commentCount >= 0 && { commentCount: value.commentCount }),
          ...(Array.isArray(value.comments) && { comments: value.comments.slice(-50).filter(entry => typeof entry?.body === 'string' && typeof entry.at === 'string').map(entry => ({ at: entry.at.slice(0, 40), body: entry.body.slice(0, 4000) })) }) };
      }
      answer({ ok: true, items, ...(typeof message.latestStable === 'string' && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/.test(message.latestStable) && { latestStable: message.latestStable }) });
      break;
    }
    case 'feedback/result': {
      const answer = host.feedbackPending.get(message.id);
      if (!answer) break;
      host.feedbackPending.delete(message.id);
      answer(message.ok === true
        ? { ok: true, ...(Number.isSafeInteger(message.issueNumber) && { issueNumber: message.issueNumber }) }
        : { ok: false, error: { code: typeof message.error?.code === 'string' ? message.error.code.slice(0, 40) : 'PLUGIN_FEEDBACK', message: plainText(String(message.error?.message ?? '피드백을 보내지 못했습니다.')).slice(0, 500) || '피드백을 보내지 못했습니다.',
          ...(Number.isInteger(message.error?.retryAfter) && message.error.retryAfter > 0 && { retryAfter: Math.min(message.error.retryAfter, 86_400) }) } });
      break;
    }
    case 'log': log[message.level === 'error' ? 'error' : message.level === 'warn' ? 'warn' : 'log'](`[plugin ${host.id}] ${String(message.message ?? '').slice(0, 2000)}`); break;
  }
}

export function actionValues(actionId, values, item) {
  if (!ACTION_ID.test(String(actionId))) throw fail('잘못된 작업입니다.');
  if (item !== undefined && item !== null && !ITEM_ID.test(String(item))) throw fail('잘못된 항목입니다.');
  const clean = {};
  if (values && typeof values === 'object') for (const [key, value] of Object.entries(values).slice(0, 24)) if (FIELD_KEY.test(key) && typeof value === 'string') clean[key] = value.slice(0, 4096);
  return clean;
}

export function encode(message) {
  return message.type === 'init' ? { ...message, features: [...features] } : message;
}
