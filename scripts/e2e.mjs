/** Headless-Chrome smoke of the real server + built web UI (needs `pnpm web:build` and a local Chrome). */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WebSocket = createRequire(new URL('../apps/local-server/package.json', import.meta.url))('ws');
const CHROME = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!CHROME) { console.error('Chrome not found; set CHROME_PATH'); process.exit(2); }
if (!existsSync(new URL('../apps/web/dist/index.html', import.meta.url))) { console.error('Run `pnpm web:build` first'); process.exit(2); }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanup = [];
async function main() {
  const data = await mkdtemp(join(tmpdir(), 'ade-e2e-data-')), repo = await realpath(await mkdtemp(join(tmpdir(), 'ade-e2e-repo-'))), profile = await mkdtemp(join(tmpdir(), 'ade-e2e-chrome-'));
  cleanup.push(() => rm(data, { recursive: true, force: true }), () => rm(repo, { recursive: true, force: true }), () => rm(profile, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@e2e', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); await writeFile(join(repo, 'hello-e2e.txt'), 'hello\n'); git('add', '.'); git('commit', '-q', '-m', 'init');

  const server = spawn(process.execPath, ['apps/local-server/src/index.js'], { env: { ...process.env, ADE_PORT: '0', ADE_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'inherit'] });
  cleanup.push(() => { server.kill('SIGTERM'); });
  const line = await new Promise((resolve, reject) => { server.stdout.once('data', c => resolve(String(c))); server.once('exit', () => reject(new Error('server exited'))); });
  const url = /(http:\/\/127\.0\.0\.1:\d+\/#token=\w+)/.exec(line)[1];

  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  cleanup.push(() => { chrome.kill('SIGTERM'); });
  let port;
  for (let i = 0; i < 100 && !port; i++) { await sleep(100); port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0] || undefined; }
  if (!port) throw new Error('Chrome DevTools port not available');
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const problems = []; let id = 0; const waiting = new Map();
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.id && waiting.has(message.id)) { const { resolve, reject } = waiting.get(message.id); waiting.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }
    else if (message.method === 'Runtime.exceptionThrown') problems.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(message.params.args.map(a => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { waiting.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  const until = async (expression, what, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await evaluate(expression)) return; throw new Error(`timeout: ${what}`); };
  await send('Runtime.enable'); await send('Page.enable');

  await send('Page.navigate', { url });
  await until(`Boolean(document.querySelector('form input'))`, 'project path form');
  await evaluate(`(() => { const input = document.querySelector('form input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(repo)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.form.requestSubmit(); })()`);
  await until(`document.body.innerText.includes('hello-e2e.txt')`, 'explorer lists repo files');
  await until(`Boolean(document.querySelector('[aria-label="화면 모드"]'))`, 'view switch');
  await evaluate(`[...document.querySelectorAll('[aria-label="화면 모드"] button')].find(b => b.textContent === 'IDE').click()`);
  await until(`[...document.querySelectorAll('[aria-label="화면 모드"] button')].find(b => b.textContent === 'IDE').getAttribute('aria-pressed') === 'true'`, 'IDE mode');
  await evaluate(`[...document.querySelectorAll('[aria-label="화면 모드"] button')].find(b => b.textContent === 'ADE').click()`);
  await evaluate(`document.querySelector('[aria-label="AI 작업"]').click()`);
  await until(`Boolean(document.querySelector('textarea[aria-label="메시지 입력"]'))`, 'AI composer');
  if (problems.length) throw new Error(`browser errors:\n${problems.join('\n')}`);
  console.log('e2e: auth, project open, explorer, ADE/IDE switch and AI composer passed');
}

let failed = false;
try { await main(); } catch (error) { failed = true; console.error(`e2e: ${error.message}`); }
for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {});
process.exit(failed ? 1 : 0);
