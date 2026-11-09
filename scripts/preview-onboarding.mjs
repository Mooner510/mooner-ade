// First-run preview: the real local server and built UI with a brand-new, throwaway profile, so the setup screen, the tour and the
// launch animation play exactly as a new user sees them. Your own projects and settings are not touched.
// Reload the page after finishing to see the launch animation every later start shows. Ctrl+C stops it and deletes the profile.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'), temp = await mkdtemp(join(tmpdir(), 'ade-preview-'));
const home = join(temp, 'home'), data = join(temp, 'data');
await mkdir(home); await mkdir(data);
const server = spawn(process.execPath, ['apps/local-server/src/index.js'], {
  cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, ADE_DEV: '0', ADE_PTY_ENDPOINT: '', ADE_PORT: process.env.ADE_PORT || '0', ADE_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'inherit']
});
let shown = false;
server.stdout.on('data', chunk => {
  const url = /http:\/\/127\.0\.0\.1:\d+\/#token=\w+/.exec(String(chunk))?.[0];
  if (!url || shown) return;
  shown = true;
  console.log(`\n첫 실행 미리보기: ${url}\n(완료 후 새로고침하면 다음 실행부터 나오는 시작 화면을 볼 수 있습니다. 종료: Ctrl+C)\n`);
  if (!process.env.NO_OPEN) spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
});
const stop = async () => { server.kill('SIGTERM'); await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
server.on('exit', code => { if (!shown) { console.error(`서버가 시작되지 않았습니다 (exit ${code}).`); process.exit(1); } });
