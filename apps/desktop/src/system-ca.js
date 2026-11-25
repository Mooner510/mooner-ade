// "Trust the OS certificate store" for every process that talks to MoonerADE Hub: this one (market, sign-in, plugin
// download — system-trust.js), plugin processes, and the local server (anonymous feedback). Off by default: Node then
// accepts every root the OS trusts, which is what a TLS-inspecting proxy needs (its root CA is in the OS store, not in
// Node's bundle). Children read the flag from their environment at spawn, and this process reads it once here, so a
// change needs an app restart. When a plugin cannot connect, `offer` checks that this is the cause and that the setting
// fixes it, and only then asks once per run.
import { app, dialog, ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { useBundledTrustStore, useSystemTrustStore } from './system-trust.js';

const CERT_ERRORS = /^(SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED)$/;
// Where plugins connect: the remote-access hub (the bundled plugin's default) and GitHub (plugin updates).
const PROBE_URLS = ['https://ade-hub.mooner510.kr', 'https://api.github.com'];
const SCRIPT = 'fetch(process.argv[1],{signal:AbortSignal.timeout(8000)}).then(()=>console.log("ok"),e=>console.log(e.cause?.code||"fail"))';

export function setupSystemCa({ userData, nodeBinary, getWindow, trusted }) {
  const file = path.join(userData, 'system-ca.json');
  const enabled = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).enabled === true; } catch { return false; } };
  try {
    if (enabled()) useSystemTrustStore();
    else if (process.env.NODE_USE_SYSTEM_CA) useBundledTrustStore();
  } catch (error) { console.warn(`시스템 인증서 저장소를 읽지 못했습니다: ${error.message}`); }
  const probe = (url, systemCa) => new Promise(resolve => {
    const env = { ...process.env }; delete env.NODE_USE_SYSTEM_CA;
    if (systemCa) env.NODE_USE_SYSTEM_CA = '1';
    execFile(nodeBinary, ['-e', SCRIPT, url], { env, timeout: 15_000, windowsHide: true }, (error, stdout) => resolve(error ? 'fail' : String(stdout).trim()));
  });
  // True when a certificate error blocks the connection without the setting and the setting lets it through.
  async function certBlocked() {
    for (const url of PROBE_URLS) {
      if (!CERT_ERRORS.test(await probe(url, false))) continue;
      if (await probe(url, true) === 'ok') return true;
    }
    return false;
  }
  async function restartPrompt(message, detail) {
    const window = getWindow();
    const options = { type: 'question', buttons: ['지금 재시작', '나중에'], defaultId: 0, cancelId: 1, noLink: true, message, detail };
    const { response } = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    if (response === 0) { app.relaunch(); app.quit(); }
  }
  function set(on) {
    fs.writeFileSync(file, JSON.stringify({ enabled: on === true }));
    return enabled();
  }
  let offered = false;
  function handle(name, fn) {
    ipcMain.handle(`ade:system-ca:${name}`, (event, ...args) => {
      const window = getWindow();
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || !trusted(event)) throw new Error('허용되지 않은 요청입니다.');
      return fn(...args);
    });
  }
  handle('get', () => enabled());
  handle('set', async on => {
    const before = enabled();
    if (on === true && !before) {
      const { response } = await dialog.showMessageBox(getWindow(), { type: 'question', buttons: ['취소', '켜기'], defaultId: 0, cancelId: 0,
        message: '시스템 인증서를 신뢰할까요?', detail: '다시 시작하면 앱과 하위 프로세스의 HTTPS 연결에 운영체제 인증서를 사용합니다.' });
      if (response !== 1) return enabled();
    }
    const now = set(on);
    if (before !== now) await restartPrompt('Hub 연결에 적용하려면 앱을 다시 시작해야 합니다.', '재시작하기 전까지는 이전 설정으로 동작합니다.');
    return now;
  });
  // Called when a plugin reports it cannot connect. Returns whether it asked.
  handle('offer', async () => {
    if (offered || enabled()) return false;
    offered = true;
    if (!await certBlocked()) return false;
    const window = getWindow();
    const options = { type: 'question', buttons: ['켜고 재시작', '그대로 두기'], defaultId: 0, cancelId: 1, noLink: true, message: '네트워크의 보안 인증서 때문에 Hub에 연결하지 못했습니다.',
      detail: '회사 등 네트워크가 HTTPS 통신을 검사하면서 쓰는 인증서를 Node가 신뢰하지 않습니다. 운영체제가 신뢰하는 인증서를 Hub로 가는 모든 연결도 신뢰하도록 켜고 앱을 다시 시작할까요?\n설정 > 정보에서 언제든 끌 수 있습니다.' };
    const { response } = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    if (response === 0) { set(true); app.relaunch(); app.quit(); }
    return true;
  });
  return { enabled };
}
