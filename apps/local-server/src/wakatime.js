import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fault } from './files.js';

// Official plugins repeat a heartbeat for the same entity at most every 2 minutes; WakaTime joins heartbeats under 15 minutes apart.
export const PULSE = 2 * 60 * 1000;
// wakatime-cli exit codes worth telling the user about.
const exitMessages = { 102: '오프라인 상태라 heartbeat를 저장해 두었습니다. 연결되면 전송됩니다.', 103: '~/.wakatime.cfg 설정을 읽지 못했습니다.', 104: 'API 키가 올바르지 않습니다.', 112: 'WakaTime 전송 한도에 걸렸습니다.' };
const MISSING_KEY = 110;

// The CLI the official plugins install under ~/.wakatime comes first, then one on PATH.
export function findWakaTimeCli({ home = os.homedir(), platform = process.platform, arch = process.arch, env = process.env, exists = fs.existsSync } = {}) {
  const exe = platform === 'win32' ? '.exe' : '';
  const osName = platform === 'win32' ? 'windows' : platform, archName = { x64: 'amd64', ia32: '386' }[arch] || arch;
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path') || 'PATH';
  const candidates = [path.join(home, '.wakatime', `wakatime-cli${exe}`), path.join(home, '.wakatime', `wakatime-cli-${osName}-${archName}${exe}`),
    ...(env[key] || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, `wakatime-cli${exe}`))];
  return candidates.find(file => exists(file)) || null;
}

// WakaTime names the editor after the first User-Agent token as written, so this one shows up as "MoonerADE".
export const pluginName = version => `MoonerADE/${version} MoonerADE-wakatime/${version}`;

export function heartbeatArgs({ entity, entityType = 'file', project, folder, category = 'coding', write = false, plugin }) {
  const args = ['--entity', entity, '--entity-type', entityType, '--category', category, '--plugin', plugin];
  if (folder) args.push('--project-folder', folder);
  // An app entity has no file to detect the project from, so the folder name is the fallback.
  if (project) args.push('--alternate-project', project);
  if (write) args.push('--write');
  return args;
}

const runCli = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 60_000 }, (error, stdout) => error ? reject(Object.assign(new Error(exitMessages[error.code] || error.message), { code: error.code })) : resolve(stdout));
});
const maskKey = key => key ? `${'•'.repeat(8)}${key.slice(-4)}` : '';

export function createWakaTime({ version, find = findWakaTimeCli, run = runCli, now = Date.now }) {
  const plugin = pluginName(version);
  const sent = new Map(), inflight = new Set();
  let enabled = false, cli, lastSent = 0, lastError = null, config = null, today = { at: 0, text: '' };
  const locate = () => (cli ??= find());
  const read = key => run(locate(), ['--config-read', key]).then(value => value.trim(), error => { if (error.code === MISSING_KEY) return ''; throw error; });
  return {
    configure(on) {
      if (on && !enabled) cli = undefined; // re-detect after the user installs the CLI and toggles again
      enabled = on;
    },
    get enabled() { return enabled; },
    // Returns whether a heartbeat was sent. Saves (`write`) and `force` skip the per-activity PULSE throttle.
    heartbeat(beat) {
      if (!enabled) return false;
      const key = `${beat.entity}\0${beat.category || 'coding'}\0${beat.folder || ''}`, at = now();
      if (!beat.write && (inflight.has(key) || (!beat.force && at - (sent.get(key) ?? -Infinity) < PULSE))) return false;
      if (!locate()) { lastError = 'wakatime-cli를 찾을 수 없습니다. WakaTime 플러그인을 하나 설치하거나 wakatime-cli를 PATH에 두세요.'; return false; }
      sent.set(key, at); inflight.add(key);
      if (sent.size > 256) sent.delete(sent.keys().next().value);
      run(cli, heartbeatArgs({ ...beat, plugin }))
        .then(() => { lastSent = now(); lastError = null; }, error => { if (error.code === 102) lastSent = now(); lastError = error.message; })
        .finally(() => inflight.delete(key));
      return true;
    },
    async status() {
      const base = { enabled, cli: locate(), lastSent, lastError, apiKey: '', apiUrl: '', today: '' };
      if (!base.cli) return base;
      config ??= Promise.all([read('api_key'), read('api_url')]).then(([apiKey, apiUrl]) => ({ apiKey: maskKey(apiKey), apiUrl }), error => { config = null; throw error; });
      // Today's total comes from the API, so it is refreshed at most once a minute.
      if (enabled && now() - today.at >= 60_000) {
        today.at = now();
        today.text = await run(cli, ['--today', '--plugin', plugin]).then(value => value.trim(), () => today.text);
      }
      return { ...base, ...await config.catch(() => ({})), today: enabled ? today.text : '' };
    },
    // Writes to ~/.wakatime.cfg, which every WakaTime plugin on this machine shares.
    async writeConfig({ apiKey, apiUrl }) {
      if (!locate()) throw fault('WAKATIME_MISSING', 'wakatime-cli를 찾을 수 없습니다.', 404);
      if (apiKey !== undefined && !(typeof apiKey === 'string' && /^(waka_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(apiKey.trim()))) throw fault('INVALID_INPUT', 'API 키 형식이 올바르지 않습니다.');
      if (apiUrl !== undefined && !(typeof apiUrl === 'string' && (apiUrl === '' || (apiUrl.length <= 512 && /^https?:\/\/[^\s]+$/.test(apiUrl))))) throw fault('INVALID_INPUT', 'API 주소는 http(s):// 로 시작해야 합니다.');
      config = null; today.at = 0;
      if (apiKey !== undefined) await run(cli, ['--config-write', `api_key=${apiKey.trim()}`]);
      if (apiUrl !== undefined) await run(cli, ['--config-write', `api_url=${apiUrl}`]);
      return {};
    }
  };
}
