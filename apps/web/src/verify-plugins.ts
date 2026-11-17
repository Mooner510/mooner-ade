import { api } from './api';
import { bytesToBase64 } from './feedback-model';
import type { PluginsBridge, PluginsState } from './PluginSettings';

declare global { interface Window { adeVerifyPlugins?: PluginsBridge } }
type Confirmation = { id: string; expiresAt: number; options: { title?: string; message: string; detail?: string; buttons?: string[] } };

// A real DOM dialog: CDP's automatic JavaScript-dialog handler must never approve plugin execution or publishing.
function confirmRequest(request: Confirmation): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'), title = document.createElement('h2'), detail = document.createElement('pre'), accept = document.createElement('button'), cancel = document.createElement('button');
    dialog.className = 'verify-plugin-confirm'; title.textContent = request.options.title ?? '플러그인 확인';
    detail.textContent = [request.options.message, request.options.detail].filter(Boolean).join('\n\n');
    accept.textContent = request.options.buttons?.[0] ?? '확인'; cancel.textContent = request.options.buttons?.[1] ?? '취소';
    const done = (result: boolean) => { clearTimeout(timer); dialog.close(); dialog.remove(); resolve(result); };
    const timer = setTimeout(() => done(false), Math.max(0, request.expiresAt - Date.now()));
    accept.onclick = () => done(true); cancel.onclick = () => done(false); dialog.oncancel = event => { event.preventDefault(); done(false); };
    dialog.setAttribute('aria-label', title.textContent); dialog.append(title, detail, cancel, accept); document.body.append(dialog); dialog.showModal(); cancel.focus();
  });
}
export function installVerifyPlugins() {
  if (window.adeVerifyPlugins) return;
  const listeners = new Set<(state: PluginsState) => void>(), confirming = new Set<string>();
  let revision = -1, polling = false, timer: ReturnType<typeof setInterval> | undefined;
  const call = (name: string, ...args: unknown[]) => api<any>(`verify/plugins/${name}`, { args });
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const result = await api<{ revision: number; state?: PluginsState; confirmations: Confirmation[] }>('verify/plugins/poll', { revision });
      revision = result.revision;
      if (result.state) for (const listener of listeners) listener(result.state);
      const request = result.confirmations[0];
      if (request && !confirming.size) {
        confirming.add(request.id);
        void confirmRequest(request).then(accept => api('verify/plugins/confirm', { id: request.id, accept })).catch(() => {}).finally(() => confirming.delete(request.id));
      }
    } catch { /* A server restart navigates this same tab; never retry a mutation. */ }
    finally { polling = false; }
  }
  const names = ['state', 'setEnabled', 'setBuiltin', 'rescan', 'approve', 'revoke', 'restart', 'action', 'setMcp', 'refreshTools', 'openFolder', 'checkUpdates', 'installUpdate', 'setUpdateMode', 'connectGithub', 'disconnectGithub', 'signInGithub', 'cancelSignIn', 'probeGithub', 'selectGithubAccount', 'openSource', 'openTokenPage', 'signInHub', 'cancelHubSignIn', 'signOutHub', 'hubCatalog', 'hubInstall'];
  const bridge = Object.fromEntries(names.map(name => [name, async (...args: unknown[]) => {
    const result = await call(name, ...args);
    if (typeof result.openUrl === 'string' && /^https:\/\/github\.com\//.test(result.openUrl)) window.open(result.openUrl, '_blank', 'noopener,noreferrer');
    void poll(); return result;
  }])) as unknown as PluginsBridge;
  bridge.onState = listener => { listeners.add(listener); timer ??= setInterval(() => void poll(), 750); void poll(); return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } }; };
  bridge.onOpen = () => () => {};
  bridge.installZip = () => Promise.reject(new Error('브라우저에서는 zip 선택 버튼을 사용하세요.'));
  bridge.pickZip = () => new Promise((resolve, reject) => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.zip';
    input.oncancel = () => { void bridge.state().then(resolve, reject); };
    input.onchange = async () => {
      try {
        const file = input.files?.[0]; if (!file) { resolve(await bridge.state()); return; }
        if (file.size > 8 * 1024 * 1024) throw new Error('8MB 이하의 플러그인 zip을 선택하세요.');
        resolve(await api('verify/plugins/uploadZip', { zip: bytesToBase64(new Uint8Array(await file.arrayBuffer())) }));
      } catch (error) { reject(error); }
    };
    input.click();
  });
  window.adeVerifyPlugins = bridge;
  window.dispatchEvent(new Event('ade:verify-plugins-ready'));
}
