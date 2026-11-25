// The PC side of the phone <-> PC end-to-end rig (docs/REMOTE_UI.md "폰 종단 테스트", driver: t-phone-e2e.mjs, phone side: phone-adb.mjs).
// Everything here runs against a throwaway environment, in a session folder of its own (tmp/ade-phone-e2e):
//   - a local Hub (mooner-ade-hub, `DEV_LOGIN=1`: in-memory store, name-only login) on a loopback port, behind a relay proxy that can be cut on purpose;
//   - a real ADE server of this checkout (lib.mjs boot, `ADE_DEV=1` for the desktop-mode page, a built apps/web/dist for the phone's ui/manifest) that hosts the
//     real remote-access plugin through the production plugin manager (plugins.mjs harness: the plugin's own host process, its real gateway and Noise link,
//     confirmation dialogs queued for this script instead of drawn natively), with the fake `claude` of this folder: no AI usage;
//   - no fingerprint, no Authentik: the Hub's dev-login form is driven with plain HTTP.
// Safety: the Hub URL is set explicitly everywhere (never ade-hub.mooner510.kr), the Hub gets a clean environment, plugin update checks are off, and
// processes are stopped by their recorded PID after their command line was checked.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { commandLines, ensureSession, mainCheckout, norm, real, sessionDir, tmpRoot, HERE, ROOT } from './session-dirs.mjs';

export { HERE, ROOT };
export const RIG = 'ade-phone-e2e';
export const dir = sessionDir(RIG);
// lib.mjs makes <VERIFY_OUT>/shots on import and falls back to the shared tmp/main without it: it must never be that one.
process.env.VERIFY_OUT = dir;
export const lib = await import('./lib.mjs');
export const { sleep, until, WebSocket } = lib;

// ---- manifest ------------------------------------------------------------------------------------------------------------------
const manifestFile = join(dir, 'rig.json');
export const readManifest = () => { try { return JSON.parse(readFileSync(manifestFile, 'utf8')); } catch { return null; } };
export function writeManifest(patch) {
  const next = { ...(readManifest() ?? {}), ...patch };
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestFile + '.tmp', JSON.stringify(next, null, 2)); renameSync(manifestFile + '.tmp', manifestFile);
  return next;
}
export const needRig = () => { const m = readManifest(); if (!m?.ready) throw new Error('rig가 떠 있지 않습니다. 먼저: node scripts/verify/t-phone-e2e.mjs up'); return m; };
export const shotsDir = process.env.PHONE_E2E_SHOTS ?? 'C:\\AI\\claude-temp\\phone-e2e';

// ---- small helpers ---------------------------------------------------------------------------------------------------------------
export const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
// The relay's port is baked into the debug APK (BuildConfig.HUB_URL), so it is the same every run (the APK is only rebuilt when it changes); a busy one falls back to a free port.
export const pickPort = preferred => new Promise(res => { const s = net.createServer(); s.once('error', () => freePort().then(res)); s.listen(preferred, '127.0.0.1', () => s.close(() => res(preferred))); });
export const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
export const log = (...a) => console.log(`[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}]`, ...a);
export const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---- the local Hub -------------------------------------------------------------------------------------------------------------------
// A binary built from the Hub checkout (`go build`, cached in the session folder; rebuilt when a .go file is newer). Clean environment: no OIDC, no
// database, no GitHub tokens, so nothing in it can reach beyond this machine; it listens on loopback only (HUB_ADDR is refused in production).
export function hubBinary(hubDir) {
  const bin = join(dir, 'bin', 'hub-e2e.exe');
  const newest = d => readdirSync(d, { withFileTypes: true, recursive: true }).filter(e => e.isFile() && /\.(go|html|css|mod|sum)$/.test(e.name)).reduce((t, e) => Math.max(t, statSync(join(e.parentPath, e.name)).mtimeMs), 0);
  if (existsSync(bin) && statSync(bin).mtimeMs >= newest(hubDir)) return bin;
  mkdirSync(dirname(bin), { recursive: true });
  log(`Hub 빌드: go build ./cmd/hub (${hubDir})`);
  execFileSync('go', ['build', '-o', bin, './cmd/hub'], { cwd: hubDir, stdio: 'inherit', windowsHide: true });
  return bin;
}
export function startHub(bin, port) {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SYSTEMROOT: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, DEV_LOGIN: '1', HUB_ADDR: `127.0.0.1:${port}`, ENVIRONMENT: 'dev' };
  const out = openSync(join(dir, 'hub.log'), 'a');
  const child = spawn(bin, [], { env, stdio: ['ignore', out, out], windowsHide: true });
  return child;
}

// A transparent TCP relay in front of the Hub: what the phone (through `adb reverse`) and the plugin both reach. `cut(ms)` drops every connection
// and refuses new ones for a while, the way a real network break does, while the Hub keeps its accounts (it is in memory: restarting it would sign everything out).
export function relayProxy({ port, targetPort }) {
  const sockets = new Set(), events = [];
  let server = null, accepted = 0;
  const note = what => events.push({ at: Date.now(), what });
  const listen = () => new Promise((res, rej) => {
    const s = net.createServer(client => {
      accepted++;
      const upstream = net.connect(targetPort, '127.0.0.1');
      for (const sock of [client, upstream]) { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); sock.on('error', () => sock.destroy()); }
      client.pipe(upstream); upstream.pipe(client);
    });
    s.once('error', rej); s.listen(port, '127.0.0.1', () => { server = s; res(); });
  });
  const stop = () => new Promise(res => { const s = server; server = null; for (const sock of [...sockets]) sock.destroy(); if (!s) return res(); s.close(() => res()); });
  return {
    start: async () => { await listen(); note('listening'); },
    stop,
    // Down for `ms`, then listening again on the same port (the clients' retries find it there).
    async cut(ms) { note(`cut ${ms}ms`); await stop(); await sleep(ms); await listen(); note('listening again'); },
    get open() { return sockets.size; }, get accepted() { return accepted; }, events
  };
}

// ---- driving the Hub's dev-login pages with plain HTTP ---------------------------------------------------------------------------------
class Jar {
  cookies = new Map();
  absorb(res) { for (const line of res.headers.getSetCookie?.() ?? []) { const [pair] = line.split(';'), i = pair.indexOf('='); const name = pair.slice(0, i).trim(), value = pair.slice(i + 1); if (/max-age=0|expires=thu, 01 jan 1970/i.test(line) || value === '') this.cookies.delete(name); else this.cookies.set(name, value); } }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}
const field = (html, name) => new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1] ?? new RegExp(`<input[^>]*value="([^"]*)"[^>]*name="${name}"`).exec(html)?.[1];
// Approves a pending device enrollment as the Hub account `name` (the dev login makes it on first use): what the user does in the browser. `verifyUrl` is the
// Hub's own /enroll?request=<id> page the device showed or opened; `userCode` is the 8-character code the device displays.
export async function hubApprove(hubUrl, { verifyUrl, userCode, name = 'e2e' }) {
  const origin = new URL(hubUrl).origin;
  if (new URL(verifyUrl).origin !== origin) throw new Error(`verifyUrl이 이 rig의 Hub가 아닙니다: ${verifyUrl}`);
  const jar = new Jar(), headers = () => ({ cookie: jar.header(), origin });
  const go = async (path, init = {}) => { const res = await fetch(new URL(path, origin), { redirect: 'manual', ...init, headers: { ...headers(), ...init.headers } }); jar.absorb(res); return res; };
  const form = values => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() });
  let res = await go(new URL(verifyUrl).pathname + new URL(verifyUrl).search), html = await res.text();
  if (/name="csrf"/.test(html) && /\/enroll\/dev-login/.test(html)) {
    res = await go('/enroll/dev-login', form({ csrf: field(html, 'csrf'), code: field(html, 'code') ?? '', name }));
    if (res.status !== 303) throw new Error(`dev-login ${res.status}: ${(await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`);
    res = await go('/enroll'); html = await res.text();
  }
  const enrollId = field(html, 'enrollId'), csrf = field(html, 'csrf');
  if (!enrollId || !csrf) throw new Error(`승인 화면이 아닙니다(${res.status}): ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 240)}`);
  res = await go('/enroll/decide', form({ csrf, enrollId, deviceCode: userCode, decision: 'approve' }));
  const text = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  if (res.status !== 200 || !/연결했습니다|이미/.test(text)) throw new Error(`승인 실패(${res.status}): ${text.slice(0, 240)}`);
  return { enrollId };
}

// ---- the plugin, staged like its release zip ----------------------------------------------------------------------------------------------
// scripts/build-plugins.mjs of the plugins repo, for the remote plugin only and without the zip: the same files, `// @shared` stubs replaced by the shared
// module. The one difference: plugin.json loses `source`, so MoonerADE's update check never asks GitHub for a newer release (the rig must not leave this machine).
export function stagePlugin(pluginsDir, out) {
  const entries = ['plugin.json', 'package.json', 'host.js', 'lib', 'README.md'], src = join(pluginsDir, 'remote'), stage = join(out, 'mooner-remote');
  rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
  for (const entry of entries) cpSync(join(src, entry), join(stage, entry), { recursive: true });
  for (const file of readdirSync(stage, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.js')).map(e => join(e.parentPath, e.name))) {
    const stub = /^\/\/ @shared ([\w.-]+\.js):/.exec(readFileSync(file, 'utf8').split('\n', 1)[0]);
    if (stub) cpSync(join(pluginsDir, 'shared', stub[1]), file);
  }
  const manifest = JSON.parse(readFileSync(join(stage, 'plugin.json'), 'utf8')); delete manifest.source;
  writeFileSync(join(stage, 'plugin.json'), JSON.stringify(manifest, null, 2));
  return { dir: stage, id: manifest.id, version: manifest.version };
}

// ---- the ADE server, as a client of the plugin harness -----------------------------------------------------------------------------------------
export function adeClient(m) {
  const origin = m.ade.origin, cookie = m.ade.cookie;
  const raw = (action, body = {}) => fetch(`${origin}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
  const api = async (action, body = {}, expected = 200) => { const r = await raw(action, body); const v = await r.json().catch(() => null); if (r.status !== expected) throw new Error(`${action} -> ${r.status} ${JSON.stringify(v).slice(0, 300)}`); return v; };
  const project = body => ({ projectId: m.ade.projectId, ...body });
  const plugins = {
    state: () => api('verify/plugins/state'),
    poll: (revision = -1) => api('verify/plugins/poll', { revision }),
    view: async () => (await plugins.state()).plugins.find(p => p.id === m.plugin.id)?.view ?? null,
    info: async key => (await plugins.view())?.info?.find(i => i.key === key)?.value,
    // Accepts the dialogs the plugin manager queues (the harness's stand-in for the native ones) that `want(options)` recognises, until `stop()` is true.
    async accept(want = () => true, stop = () => false, ms = 60000) {
      const end = Date.now() + ms, done = [];
      while (Date.now() < end && !stop()) {
        const { confirmations } = await plugins.poll();
        for (const c of confirmations) if (want(c.options)) { await api('verify/plugins/confirm', { id: c.id, accept: true }); done.push(c.options.message ?? c.options.title); }
        await sleep(150);
      }
      return done;
    },
    // An action that waits for a dialog (enable, pairing approval): started first, its dialog accepted meanwhile.
    async actionWithDialog(action, values = {}, item) {
      let finished = false;
      const call = api('verify/plugins/action', { args: [m.plugin.id, action, values, item] }).finally(() => { finished = true; });
      const dialogs = await plugins.accept(() => true, () => finished, 30000);
      return { result: await call, dialogs };
    }
  };
  return { api, raw, plugins, project, origin, cookie };
}

// ---- processes ---------------------------------------------------------------------------------------------------------------------------
// What each recorded process must still be running for its PID to be ours (PIDs are reused).
export const EXPECT = { hub: 'hub-e2e.exe', ade: 'local-server/src/index.js', owner: 't-phone-e2e.mjs' };
export function stopRecorded(m, log = console.log) {
  const pids = Object.entries(m?.pids ?? {}).filter(([, pid]) => pid && alive(pid));
  const lines = commandLines(pids.map(([, pid]) => pid));
  for (const [what, pid] of pids) {
    if (!norm(lines.get(pid)).includes(norm(EXPECT[what]))) { log(`건너뜀 ${what} pid ${pid}: 명령줄이 달라 우리 프로세스가 아닙니다`); continue; }
    try { process.kill(pid); log(`종료 ${what} pid ${pid}`); } catch (e) { log(`종료 실패 ${what} pid ${pid}: ${e.message}`); }
  }
}
export { ensureSession, mainCheckout, real, tmpRoot, resolve };

// ---- the safety check: nothing of the rig talks beyond this machine ---------------------------------------------------------------------------------
// The rig's process tree (owner, Hub, ADE server and everything they started) against Get-NetTCPConnection: any remote address that is not loopback is a finding
// (the real Hub sits behind Cloudflare, 104.21.18.14 and 172.67.179.42). Also lists the tree, so a stray process shows up.
export function netCheck(m) {
  const roots = Object.values(m?.pids ?? {}).filter(Boolean);
  const script = `$roots = @(${roots.join(',')}); $all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine;
    $set = [System.Collections.Generic.HashSet[int]]::new(); foreach ($r in $roots) { [void]$set.Add([int]$r) };
    do { $n = $set.Count; foreach ($p in $all) { if ($set.Contains([int]$p.ParentProcessId)) { [void]$set.Add([int]$p.ProcessId) } } } while ($set.Count -gt $n);
    $procs = @($all | Where-Object { $set.Contains([int]$_.ProcessId) } | ForEach-Object { @{ pid = $_.ProcessId; name = $_.Name } });
    $ext = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $set.Contains([int]$_.OwningProcess) -and $_.RemoteAddress -notin @('127.0.0.1','::1','0.0.0.0','::') } | ForEach-Object { @{ pid = $_.OwningProcess; remote = "$($_.RemoteAddress):$($_.RemotePort)"; state = "$($_.State)" } });
    @{ processes = $procs; external = $ext } | ConvertTo-Json -Compress -Depth 4`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 }).trim();
  const value = JSON.parse(out);
  return { processes: [].concat(value.processes ?? []), external: [].concat(value.external ?? []) };
}
