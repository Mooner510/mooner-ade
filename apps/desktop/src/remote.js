// Remote access in the main process: the account link with the Hub, turning access on, phone pairing and the paired-device
// list. Every step that grants access (turning it on, approving a phone, raising a phone to control, a new key) asks in a
// native dialog that the web page cannot draw or click; the page only gets publicState() and can only start these steps.
// The server child process gets what it needs over IPC (childConfig) and reports back events (remote/*).
import { BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fingerprint, keyPair, pairingPsk } from '../../local-server/src/noise.js';
import { createHubClient, HubError } from './hub-client.js';
import { childConfig, createAuditLog, createRemoteStore, DEFAULT_HUB_URL, expireDevices, publicState } from './remote-store.js';

const PAIRING_MS = 5 * 60_000;
const REFRESH_EARLY_MS = 5 * 60_000;
const b64url = buffer => buffer.toString('base64url');

export function setupRemote({ userData, getServer, getWindow, version, trusted }) {
  const store = createRemoteStore({ file: path.join(userData, 'remote.bin'), crypto: safeStorage });
  const audit = createAuditLog(path.join(userData, 'remote-audit.log'));
  const hubUrl = () => store.state.hubUrl ?? (process.env.ADE_HUB_URL || DEFAULT_HUB_URL);
  const host = { name: os.hostname().slice(0, 80), platform: process.platform, version };
  let pairing = null, enrolling = null, live = { hub: 'off', sessions: [] }, error = null, refreshTimer = null, refreshing = null;

  // ---- state out ------------------------------------------------------------------------------------------------
  function snapshot() {
    const state = store.state;
    return {
      available: store.available, problem: store.problem, ...publicState(state), error,
      fingerprint: state.hostKey ? fingerprint(Buffer.from(state.hostKey.publicKey, 'base64')) : null,
      enrolling: enrolling && { userCode: enrolling.userCode, verifyUrl: enrolling.verifyUrl, expiresAt: enrolling.expiresAt },
      pairing: pairing && pairing.expiresAt > Date.now() ? { uri: pairing.uri, expiresAt: pairing.expiresAt } : null,
      hub: state.enabled ? live.hub : 'off', sessions: state.enabled ? live.sessions : []
    };
  }
  function publish() {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('ade:remote-state', snapshot());
  }
  function push() {
    const child = getServer();
    if (child?.connected) child.send({ type: 'remote/config', config: childConfig(store.state, { pairing, host }) });
    publish();
  }
  const save = change => { store.update(change); push(); };
  const owner = () => getWindow() ?? undefined;
  async function ask(options) {
    const window = owner();
    const result = window ? await dialog.showMessageBox(window, { type: 'question', noLink: true, ...options }) : await dialog.showMessageBox({ type: 'question', noLink: true, ...options });
    return result.response;
  }
  const fail = message => { error = message; publish(); };

  // ---- tokens -------------------------------------------------------------------------------------------------
  function scheduleRefresh() {
    clearTimeout(refreshTimer); refreshTimer = null;
    const tokens = store.state.tokens;
    if (!tokens) return;
    refreshTimer = setTimeout(() => void refresh(), Math.max(5_000, tokens.accessExpiresAt - Date.now() - REFRESH_EARLY_MS));
    refreshTimer.unref?.();
  }
  // Rotates both tokens. 401 means the link is gone (revoked at the Hub, or the account lost access): remote access turns off.
  function refresh() {
    refreshing ??= (async () => {
      const tokens = store.state.tokens;
      if (!tokens) return;
      try {
        const next = await createHubClient(hubUrl()).refresh(tokens.refresh);
        save(state => ({ ...state, tokens: { access: next.accessToken, refresh: next.refreshToken, accessExpiresAt: Date.now() + next.accessExpiresIn * 1000 } }));
        error = null;
      } catch (failure) {
        if (failure instanceof HubError && (failure.status === 401 || failure.status === 403)) {
          audit({ at: Date.now(), kind: 'unlinked', reason: failure.code });
          save(state => ({ ...state, enabled: false, tokens: null }));
          fail('계정 연결이 끝났습니다. 원격 접속을 다시 쓰려면 계정을 다시 연결하세요.');
        } else {
          fail(failure.message);
          clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void refresh(), 60_000); refreshTimer.unref?.();
          return;
        }
      } finally { refreshing = null; }
      scheduleRefresh();
    })().catch(failure => fail(failure.message));
    return refreshing;
  }

  // ---- account link -------------------------------------------------------------------------------------------
  async function connect() {
    if (!store.available) throw new Error('이 컴퓨터에서는 설정을 안전하게 암호화할 수 없어 원격 접속을 쓸 수 없습니다.');
    if (enrolling) return snapshot();
    const base = process.env.ADE_HUB_URL || DEFAULT_HUB_URL, client = createHubClient(base);
    // The key is made here once and stays with this PC; the Hub keeps a copy only for display.
    const key = store.state.hostKey ?? (() => { const pair = keyPair(); return { privateKey: pair.privateKey.toString('base64'), publicKey: pair.publicKey.toString('base64') }; })();
    const started = await client.enrollStart({ kind: 'host', name: host.name, platform: host.platform, key: key.publicKey });
    // Opened only on the Hub's own origin, whatever the Hub answers.
    if (new URL(started.verifyUrl).origin !== new URL(base).origin) throw new Error('원격 접속 서버의 응답이 올바르지 않습니다.');
    const run = enrolling = { ...started, expiresAt: Date.now() + started.expiresIn * 1000, cancelled: false };
    error = null; publish();
    void shell.openExternal(started.verifyUrl);
    void (async () => {
      try {
        while (!run.cancelled && Date.now() < run.expiresAt) {
          await new Promise(resolve => setTimeout(resolve, Math.max(2, run.interval) * 1000));
          if (run.cancelled) return;
          const result = await client.enrollPoll(run).catch(failure => {
            if (failure instanceof HubError && failure.status === 410) throw failure;
            return { status: 'pending' }; // a network hiccup is not an answer
          });
          if (result.status !== 'approved') continue;
          // Linking another account than before drops the phones paired under the old one.
          const sameAccount = store.state.account?.id === result.account.id;
          save(state => ({
            ...state, hubUrl: base, hostKey: key, hostId: result.device.id,
            account: { id: result.account.id, name: result.account.name ?? '', email: result.account.email ?? '' },
            tokens: { access: result.accessToken, refresh: result.refreshToken, accessExpiresAt: Date.now() + result.accessExpiresIn * 1000 },
            devices: sameAccount ? state.devices : [], enabled: sameAccount && state.enabled
          }));
          audit({ at: Date.now(), kind: 'linked', account: result.account.id });
          scheduleRefresh();
          return;
        }
        if (!run.cancelled) fail('계정 연결 시간이 지났습니다. 다시 시도하세요.');
      } catch (failure) {
        fail(failure instanceof HubError && failure.status === 410 ? '계정 연결이 거부되었거나 만료되었습니다. MoonerADE 원격 접속 권한이 있는 계정인지 확인하세요.' : failure.message);
      } finally { if (enrolling === run) enrolling = null; publish(); }
    })();
    return snapshot();
  }
  async function unlink() {
    const tokens = store.state.tokens;
    if (enrolling) enrolling.cancelled = true;
    enrolling = null; pairing = null;
    // Telling the Hub is best effort; locally the link ends either way.
    if (tokens) await createHubClient(hubUrl()).unlink(tokens.access).catch(() => {});
    save(state => ({ ...state, enabled: false, account: null, tokens: null, hostId: null, hubUrl: null, devices: [] }));
    clearTimeout(refreshTimer);
    audit({ at: Date.now(), kind: 'unlinked', reason: 'user' });
    return snapshot();
  }

  // ---- on/off, pairing, devices -----------------------------------------------------------------------------------
  async function setEnabled(on) {
    if (!on) { pairing = null; save(state => ({ ...state, enabled: false })); audit({ at: Date.now(), kind: 'disabled' }); return snapshot(); }
    const state = store.state;
    if (!state.account || !state.tokens) throw new Error('먼저 계정을 연결하세요.');
    const answer = await ask({
      type: 'warning', title: '원격 접속 켜기', message: '이 PC의 원격 접속을 켤까요?',
      detail: `연결한 계정(${state.account.email || state.account.name})으로 로그인하고 이 PC와 페어링한 폰에서 이 PC의 터미널과 프로젝트에 접속할 수 있게 됩니다. 페어링한 폰은 이 PC에서 직접 승인한 폰뿐입니다.`,
      buttons: ['켜기', '취소'], defaultId: 1, cancelId: 1
    });
    if (answer !== 0) return snapshot();
    save(current => ({ ...expireDevices(current), enabled: true }));
    audit({ at: Date.now(), kind: 'enabled' });
    return snapshot();
  }
  function startPairing() {
    const state = store.state;
    if (!state.enabled) throw new Error('먼저 원격 접속을 켜세요.');
    const secret = randomBytes(32), id = randomUUID();
    const uri = `moonerade://pair?v=1&k=${b64url(Buffer.from(state.hostKey.publicKey, 'base64'))}&h=${encodeURIComponent(state.hostId)}&t=${b64url(secret)}&n=${encodeURIComponent(host.name)}`;
    // Only one QR at a time; a new one replaces the old. Kept in memory only.
    pairing = { id, psk: pairingPsk(secret).toString('base64'), expiresAt: Date.now() + PAIRING_MS, uri };
    setTimeout(() => { if (pairing?.id === id) { pairing = null; push(); } }, PAIRING_MS).unref?.();
    push();
    return snapshot();
  }
  function cancelPairing() { pairing = null; push(); return snapshot(); }
  async function setScope(id, scope) {
    const device = store.state.devices.find(item => item.id === id);
    if (!device || !['view', 'control'].includes(scope) || device.scope === scope) return snapshot();
    if (scope === 'control') {
      const answer = await ask({ type: 'warning', title: '제어 권한 주기', message: `${device.name || '이 폰'}에 제어 권한을 줄까요?`, detail: '제어 권한이 있으면 터미널에 입력하고, 브랜치를 바꾸고, 새 터미널과 에이전트를 실행할 수 있습니다.', buttons: ['제어 허용', '취소'], defaultId: 1, cancelId: 1 });
      if (answer !== 0) return snapshot();
    }
    save(state => ({ ...state, devices: state.devices.map(item => item.id === id ? { ...item, scope } : item) }));
    audit({ at: Date.now(), kind: 'scope', deviceId: id, scope });
    return snapshot();
  }
  function removeDevice(id) {
    save(state => ({ ...state, devices: state.devices.filter(item => item.id !== id) }));
    audit({ at: Date.now(), kind: 'removed', deviceId: id });
    return snapshot();
  }
  async function rotateKey() {
    const answer = await ask({ type: 'warning', title: 'PC 키 새로 만들기', message: '이 PC의 원격 접속 키를 새로 만들까요?', detail: '페어링한 폰이 모두 해제되고, 다시 QR을 스캔해야 접속할 수 있습니다. 키가 유출되었다고 의심될 때 쓰세요.', buttons: ['새로 만들기', '취소'], defaultId: 1, cancelId: 1 });
    if (answer !== 0) return snapshot();
    const pair = keyPair();
    pairing = null;
    save(state => ({ ...state, hostKey: { privateKey: pair.privateKey.toString('base64'), publicKey: pair.publicKey.toString('base64') }, devices: [] }));
    audit({ at: Date.now(), kind: 'key-rotated' });
    return snapshot();
  }

  // ---- events from the server -------------------------------------------------------------------------------------
  async function pairRequest(event) {
    const child = getServer(), decide = scope => child?.connected && child.send({ type: 'remote/decide', requestId: event.requestId, scope });
    const name = String(event.name || event.hubName || '새 폰').slice(0, 80);
    const window = owner();
    window?.show(); window?.focus();
    const answer = await ask({
      type: 'warning', title: '폰 페어링', message: `“${name}”을(를) 이 PC에 연결할까요?`,
      detail: `계정 기기 이름: ${event.hubName || '—'}\n폰 키 지문: ${event.fingerprint}\n\n폰 앱에 보이는 지문과 같은지 확인하세요. 모르는 요청이면 거부하세요.`,
      buttons: ['제어 허용', '보기만 허용', '거부'], defaultId: 2, cancelId: 2
    });
    const scope = answer === 0 ? 'control' : answer === 1 ? 'view' : null;
    if (scope && store.state.enabled) {
      save(state => ({ ...state, devices: [...state.devices.filter(item => item.id !== event.deviceId), { id: event.deviceId, name, key: event.key, scope, addedAt: Date.now(), lastSeenAt: null }] }));
    }
    decide(store.state.enabled ? scope : null);
  }
  let seenTimer = null;
  const seen = new Map();
  // A failure here (e.g. the settings cannot be saved) must not take the main process down with it.
  function onChildMessage(message) {
    if (typeof message?.type !== 'string' || !message.type.startsWith('remote/')) return;
    try { childEvent(message); } catch (failure) { console.warn(`원격 접속 이벤트 처리 실패 (${message.type}): ${failure.message}`); }
  }
  function childEvent(message) {
    switch (message.type) {
      case 'remote/status':
        live = { hub: message.hub, sessions: Array.isArray(message.sessions) ? message.sessions : [] }; publish(); break;
      case 'remote/audit':
        audit(message);
        if (message.kind === 'connected' && Notification.isSupported()) new Notification({ title: '원격 접속', body: `${message.deviceName || '폰'}이(가) 이 PC에 접속했습니다.` }).show();
        if (message.kind === 'unknown-key' && Notification.isSupported()) new Notification({ title: '원격 접속 거부', body: '페어링하지 않은 키로 접속하려는 시도를 막았습니다.' }).show();
        break;
      case 'remote/pair-request': void pairRequest(message).catch(failure => console.warn(`페어링 확인 실패: ${failure.message}`)); break;
      case 'remote/pairing-used': if (pairing?.id === message.id) { pairing = null; publish(); } break;
      case 'remote/revoked': if (store.state.devices.some(item => item.id === message.deviceId)) removeDevice(message.deviceId); break;
      case 'remote/seen':
        // Last use decides the 90-day expiry; written at most once a minute.
        seen.set(message.deviceId, message.at);
        seenTimer ??= setTimeout(() => {
          seenTimer = null;
          const updates = new Map(seen); seen.clear();
          try { store.update(state => ({ ...state, devices: state.devices.map(item => updates.has(item.id) ? { ...item, lastSeenAt: updates.get(item.id) } : item) })); }
          catch (failure) { console.warn(`마지막 접속 시각을 저장하지 못했습니다: ${failure.message}`); }
          publish();
        }, 60_000);
        break;
      case 'remote/token-expired': void refresh(); break;
      case 'remote/hub-denied':
        save(state => ({ ...state, enabled: false }));
        fail('원격 접속 서버가 이 계정의 접속을 거부했습니다. 계정에 MoonerADE 원격 접속 권한이 있는지 확인하세요.');
        break;
    }
  }

  // ---- wiring ---------------------------------------------------------------------------------------------------
  const handlers = {
    state: () => snapshot(), connect, cancelConnect: () => { if (enrolling) enrolling.cancelled = true; enrolling = null; publish(); return snapshot(); },
    unlink, setEnabled: value => setEnabled(value === true), startPairing, cancelPairing,
    setScope: (id, scope) => setScope(String(id), String(scope)), removeDevice: id => removeDevice(String(id)),
    endSession: id => { const child = getServer(); if (child?.connected) child.send({ type: 'remote/disconnect', sessionId: String(id) }); return snapshot(); },
    rotateKey
  };
  // Only the app's own page in the app's own window may call these.
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`ade:remote:${name}`, async (event, ...args) => {
    if (BrowserWindow.fromWebContents(event.sender) !== getWindow() || !trusted(event)) throw new Error('허용되지 않은 요청입니다.');
    try { return await handler(...args); }
    catch (failure) { fail(failure.message); throw failure; }
  });

  store.load();
  if (store.problem === 'unreadable') error = '저장된 원격 접속 설정을 열 수 없어 원격 접속을 껐습니다. 계정을 다시 연결하세요.';
  const expire = () => { try { if (expireDevices(store.state) !== store.state) save(expireDevices); } catch (failure) { console.warn(`만료된 폰을 정리하지 못했습니다: ${failure.message}`); } };
  expire();
  setInterval(expire, 6 * 60 * 60_000).unref();
  // A token that expired while the app was closed is refreshed before the server first connects.
  if (store.state.tokens) { if (store.state.tokens.accessExpiresAt - Date.now() < REFRESH_EARLY_MS) void refresh(); else scheduleRefresh(); }

  return {
    // Called for every server process the app starts (dev reloads and crash recovery start new ones).
    attach(child) { child.on('message', onChildMessage); live = { hub: 'off', sessions: [] }; },
    push
  };
}
