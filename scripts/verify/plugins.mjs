// Browser verification uses the production plugin manager; only its transport, confirmations and temporary key store differ.
import fs from 'node:fs';
import path from 'node:path';
import { inside, isSessionDir, real } from './session-dirs.mjs';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createPluginManager, createPluginStore, validManifest } from '../../apps/desktop/src/plugin-core.js';
import { createGithub, githubClientId, machineAccounts, machineToken } from '../../apps/desktop/src/plugin-updates.js';

export function createVerifyPlugins({ dataRoot, verifyOut, appVersion, env = process.env, onTerminal, onFeedback, toServer }) {
  // Only inside a verify session folder (<main checkout>/tmp/<session>, or the OS temp dir for tests) that start-ui/boot marked, with the data dir and
  // VERIFY_OUT both in it: never the installed app's data.
  const session = real(path.dirname(path.resolve(dataRoot))), out = verifyOut && real(verifyOut);
  if (!session || !out || !isSessionDir(session) || !(out === session || inside(session, out))) throw new Error('플러그인 검증은 격리 세션 폴더(tmp/<세션>)에서만 실행할 수 있습니다.');
  const root = path.join(dataRoot, 'verify-plugins'), dir = path.join(root, 'plugins');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(root, 'session.key');
  try { fs.writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!fs.lstatSync(keyFile).isFile() || fs.lstatSync(keyFile).isSymbolicLink()) throw new Error('잘못된 테스트 키 파일입니다.');
  const key = fs.readFileSync(keyFile); if (key.length !== 32) throw new Error('잘못된 테스트 키입니다.');
  const crypto = {
    isEncryptionAvailable: () => true,
    encryptString(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    decryptString(blob) { const cipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12), { authTagLength: 16 }); cipher.setAuthTag(blob.subarray(12, 28)); return Buffer.concat([cipher.update(blob.subarray(28)), cipher.final()]).toString('utf8'); }
  };
  if (env.VERIFY_PLUGIN_DIR) {
    const source = path.resolve(env.VERIFY_PLUGIN_DIR), manifest = validManifest(JSON.parse(fs.readFileSync(path.join(source, 'plugin.json'), 'utf8'))), target = path.join(dir, manifest.id);
    // Explicit opt-in only; never overwrite an installed copy or its approval on restart.
    if (!fs.existsSync(target)) fs.cpSync(source, target, { recursive: true });
  }
  const store = createPluginStore({ file: path.join(root, 'plugins.bin'), crypto }); store.load();
  let revision = 0, closed = false;
  const pending = new Map();
  function ask(options) {
    if (closed || pending.size >= 8) return Promise.resolve(options.cancelId ?? 1);
    const id = randomUUID(), expiresAt = Date.now() + 120000;
    return new Promise(resolve => {
      const finish = response => { clearTimeout(timer); pending.delete(id); resolve(response); };
      const timer = setTimeout(() => finish(options.cancelId ?? 1), 120000); timer.unref();
      pending.set(id, { id, options, expiresAt, finish });
    });
  }
  const github = createGithub({ credential: async () => store.state.github ? { token: store.state.github.token, via: 'ade' } : machineToken({ account: store.state.ghAccount }) });
  const manager = createPluginManager({
    dir, builtinDir: path.resolve(import.meta.dirname, '../../apps/desktop/builtin-plugins'), dataRoot: path.join(root, 'plugin-data'), store, ask, nodeBinary: process.execPath, appVersion,
    onChange: () => { revision++; }, onTerminal, onFeedback, toServer, github, clientId: githubClientId(),
    probeCredential: async () => { const accounts = await machineAccounts(); const found = accounts.ghAvailable ? null : await machineToken(); return { ...accounts, via: found?.via ?? null }; },
    spawnHost({ dir: cwd, main }) {
      const hostEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/^(ADE_|VERIFY_|ELECTRON_)/.test(name)));
      const child = spawn(process.execPath, [main], { cwd, env: { ...hostEnv, ADE_PLUGIN: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
      // Plugin output may contain credentials; views/errors use the existing bounded IPC protocol instead.
      child.stdout.resume(); child.stderr.resume(); return child;
    }
  });
  manager.rescan();
  let rescanTimer;
  const watcher = fs.watch(dir, { recursive: true }, () => { clearTimeout(rescanTimer); rescanTimer = setTimeout(() => { if (!closed) manager.rescan(); }, 500); });
  watcher.on('error', () => watcher.close());
  const handlers = {
    state: () => ({ ...manager.snapshot(), testSession: true }),
    poll: input => ({ revision, ...(input.revision !== revision && { state: handlers.state() }), confirmations: [...pending.values()].map(({ id, options, expiresAt }) => ({ id, options, expiresAt })) }),
    confirm: input => { const request = pending.get(input.id); if (!request) throw new Error('확인 요청이 만료됐습니다.'); request.finish(input.accept === true ? 0 : request.options.cancelId ?? 1); return {}; },
    setEnabled: input => manager.setEnabled(input.args?.[0] === true),
    setBuiltin: input => manager.setBuiltin(String(input.args?.[0]), input.args?.[1] === true),
    rescan: () => manager.rescan(),
    approve: input => manager.approve(String(input.args?.[0])),
    revoke: input => manager.revoke(String(input.args?.[0]), { forget: input.args?.[1]?.forget === true }),
    restart: input => manager.restart(String(input.args?.[0])),
    action: input => { const [id, action, values, item] = input.args ?? []; return manager.action(String(id), String(action), values, typeof item === 'string' ? item : undefined); },
    setMcp: input => manager.setMcp(String(input.args?.[0]), input.args?.[1] ?? {}),
    refreshTools: input => manager.refreshTools(String(input.args?.[0])),
    checkUpdates: input => manager.checkUpdates(typeof input.args?.[0] === 'string' ? input.args[0] : undefined),
    installUpdate: input => manager.installUpdate(String(input.args?.[0])),
    setUpdateMode: input => manager.setUpdateMode(String(input.args?.[0]), String(input.args?.[1])),
    connectGithub: input => manager.connectGithub(String(input.args?.[0] ?? '')),
    disconnectGithub: () => manager.disconnectGithub(), signInGithub: () => manager.signInGithub(), cancelSignIn: () => manager.cancelSignIn(), probeGithub: () => manager.probeGithub(),
    selectGithubAccount: input => manager.selectGithubAccount(String(input.args?.[0] ?? '')),
    openFolder: () => ({ ...handlers.state(), message: `테스트 플러그인 폴더: ${dir}` }),
    openSource: input => { const repo = manager.snapshot().plugins.find(plugin => plugin.id === String(input.args?.[0]))?.update?.source?.github; return { ...handlers.state(), ...(repo && { openUrl: `https://github.com/${repo}/releases` }) }; },
    openTokenPage: () => ({ ...handlers.state(), openUrl: 'https://github.com/settings/personal-access-tokens/new' }),
    uploadZip: async input => {
      if (typeof input.zip !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.zip) || input.zip.length > 12 * 1024 * 1024) throw new Error('8MB 이하의 플러그인 zip을 선택하세요.');
      const bytes = Buffer.from(input.zip, 'base64'); if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('잘못된 플러그인 zip입니다.');
      const file = path.join(root, `${randomUUID()}.zip`); fs.writeFileSync(file, bytes, { mode: 0o600 });
      try { return await manager.installZip(file, { picked: true }); } finally { fs.rmSync(file, { force: true }); }
    }
  };
  return {
    async route(name, input) { if (closed || !Object.hasOwn(handlers, name)) throw new Error('지원하지 않는 플러그인 검증 작업입니다.'); return handlers[name](input); },
    fromServer: message => manager.fromServer(message), submitFeedback: input => manager.submitFeedback(input),
    close() { closed = true; clearTimeout(rescanTimer); watcher.close(); for (const request of [...pending.values()]) request.finish(request.options.cancelId ?? 1); manager.close(); }
  };
}
