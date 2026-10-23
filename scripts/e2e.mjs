/** Real server + built terminal UI. Uses an isolated home, data directory and Chrome profile; no model calls. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const WebSocket = createRequire(new URL('../apps/local-server/package.json', import.meta.url))('ws');
const root = resolve(import.meta.dirname, '..');
const chromePath = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')
].filter(Boolean).find(existsSync);
if (!chromePath) throw new Error('Chrome not found; set CHROME_PATH');
if (!existsSync(join(root, 'apps/web/dist/index.html'))) throw new Error('Build the web UI first: pnpm --filter @mooner/ade-web build');

const cleanup = [];
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function main() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ade-e2e-')));
  cleanup.push(() => rm(temp, { recursive: true, force: true }));
  const data = join(temp, 'data'), home = join(temp, 'home'), repo = join(temp, 'repo'), profile = join(temp, 'chrome');
  for (const folder of [data, home, repo]) await mkdir(folder);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  await writeFile(join(repo, 'hello-e2e.txt'), 'hello\n'); git('add', '.'); git('commit', '-q', '-m', 'init');
  const server = spawn(process.execPath, ['apps/local-server/src/index.js'], {
    cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, ADE_DEV: '0', ADE_PTY_ENDPOINT: '', ADE_PORT: '0', ADE_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'inherit']
  });
  cleanup.push(() => stop(server));
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 15000);
    server.stdout.on('data', chunk => { output += chunk; const match = /http:\/\/127\.0\.0\.1:\d+\/#token=\w+/.exec(output); if (match) { clearTimeout(timer); resolve(match[0]); } });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', () => { clearTimeout(timer); reject(new Error('server exited before startup')); });
  });
  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  cleanup.push(() => stop(chrome));
  let chromeError;
  chrome.once('error', error => { chromeError = error; });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    if (chromeError) throw chromeError;
    await sleep(100); port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0] || undefined;
  }
  if (!port) throw new Error('Chrome DevTools port not available');
  const endpoint = `http://127.0.0.1:${port}`;
  const target = (await (await fetch(`${endpoint}/json/list`)).json()).find(item => item.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  cleanup.push(() => socket.close());
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const problems = [], waiting = new Map(); let id = 0;
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.id && waiting.has(message.id)) {
      const pending = waiting.get(message.id); waiting.delete(message.id); clearTimeout(pending.timer);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') problems.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(message.params.args.map(a => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id, timer = setTimeout(() => { waiting.delete(key); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    waiting.set(key, { resolve, reject, timer }); socket.send(JSON.stringify({ id: key, method, params }));
  });
  cleanup.push(() => { for (const pending of waiting.values()) clearTimeout(pending.timer); });
  const evaluate = async expression => {
    const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  };
  const until = async (expression, what) => {
    for (const end = Date.now() + 20000; Date.now() < end; await sleep(100)) {
      try { if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return; }
      catch (error) { if (!/Inspected target navigated|Execution context was destroyed|Cannot find context/.test(error.message)) throw error; }
    }
    throw new Error(`timeout: ${what}`);
  };
  const visible = selector => `([...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.getClientRects().length))`;
  await send('Runtime.enable'); await send('Page.enable'); await send('Page.navigate', { url });
  await until(visible('[aria-label="프로젝트 열기"]'), 'authenticated shell');
  await evaluate(`${visible('[aria-label="프로젝트 열기"]')}.click()`);
  await until(visible('input[aria-label="프로젝트 절대 경로"]'), 'project picker');
  await evaluate(`(() => { const input = document.querySelector('input[aria-label="프로젝트 절대 경로"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(repo)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.form.requestSubmit(); })()`);
  await until(`Boolean(${visible('main.app .xterm-helper-textarea')}) && document.querySelector('main.app:not([hidden])').innerText.includes('repo')`, 'project terminal');
  await until(`!location.hash`, 'token removed from URL');
  await evaluate(`(async () => {
    const recent = await (await fetch('/api/recent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    const projectId = recent.find(item => item.root === ${JSON.stringify(repo)}).id;
    window.e2eProjectId = projectId;
    window.e2eTerminalOutput = '';
    window.e2eSocket = new WebSocket(location.origin.replace('http', 'ws') + '/ws');
    window.e2eSocket.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.type === 'terminal' || message.type === 'terminal/replay') window.e2eTerminalOutput += message.data; };
    await new Promise((resolve, reject) => { window.e2eSocket.onopen = resolve; window.e2eSocket.onerror = reject; });
    window.e2eSocket.send(JSON.stringify({ type: 'subscribe', projectId }));
  })()`);
  const activeTerminal = 'main.app:not([hidden]) .xterm-helper-textarea';
  await evaluate(`document.querySelector(${JSON.stringify(activeTerminal)}).focus()`);
  const command = process.platform === 'win32' ? 'echo ade-e2e-42; Set-Content hello-e2e.txt changed-e2e' : "echo ade-e2e-42; printf 'changed-e2e\\n' > hello-e2e.txt";
  await send('Input.insertText', { text: command });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(`window.e2eTerminalOutput.includes('ade-e2e-42')`, 'PTY output');
  for (let i = 0; i < 100 && !(await readFile(join(repo, 'hello-e2e.txt'), 'utf8')).includes('changed-e2e'); i++) await sleep(100);
  assert.match(await readFile(join(repo, 'hello-e2e.txt'), 'utf8'), /changed-e2e/);
  console.log('e2e: authenticated project and PTY file write passed');
  const enter = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const viewport = 'document.querySelector("main.app:not([hidden]) .tab-page:not([hidden]) .xterm-viewport")';
  await send('Input.insertText', { text: `"${process.execPath}" -e "for(let i=0;i<2000;i++) console.log('scroll-history-'+i)"` }); await enter();
  await until(`(() => { const v = ${viewport}; return v && v.scrollHeight > v.clientHeight * 5; })()`, 'terminal scrollback');
  const projectId = await evaluate('window.e2eReloadPending = true; window.e2eProjectId');
  await send('Page.reload');
  await until(`!window.e2eReloadPending && (() => { const v = ${viewport}; return v && v.scrollHeight > v.clientHeight * 5; })()`, 'scrollback restored after reload');
  const bottomGap = `(() => { const v = ${viewport}; return v.scrollHeight - v.clientHeight - v.scrollTop; })()`;
  assert.ok(await evaluate(bottomGap) <= 1, 'reload must show the bottom as soon as scrollback is ready');
  await sleep(700);
  assert.ok(await evaluate(bottomGap) <= 1, 'late layout must keep the restored terminal at the bottom');
  await evaluate(`${viewport}.scrollTop = 0`);
  await sleep(300);
  assert.equal(await evaluate(`${viewport}.scrollTop`), 0, 'finished restoration must allow reading older output');
  await evaluate(`${viewport}.scrollTop = ${viewport}.scrollHeight`);
  await evaluate(`window.e2eProjectId = ${JSON.stringify(projectId)}`);
  console.log('e2e: long scrollback reload starts at the bottom and preserves subsequent manual scrolling');
  for (const [agent, folder, name, app] of [['claude', '@anthropic-ai/claude-code', 'cli.js', 'claude-code'], ['codex', '@openai/codex/bin', 'codex.js', 'codex']]) {
    const directory = join(repo, 'node_modules', folder), script = join(directory, name);
    await mkdir(directory, { recursive: true });
    await writeFile(script, `process.stdin.setRawMode(true); process.stdin.resume();
      const report = state => process.stdout.write('\\x1b]7501;state=' + state + ':app=${app}\\x1b\\\\');
      let ready = false, input = '';
      process.stdout.write('\\x1b]7501;?\\x1b\\\\');
      process.stdin.on('data', data => {
        input += data;
        if (input.includes('\\x03')) process.exit();
        if (!ready && input.includes('\\x1b]7501;?\\x1b\\\\')) { ready = true; input = ''; report('idle'); }
        else if (ready) { for (const key of data.toString()) { const state = {w:'working', b:'blocked', d:'done', i:'idle'}[key]; if (state) report(state); } }
      });
      setInterval(() => process.stdout.write('\\rStatus redraw — ready for input\\x1b[K'), 200);`);
    await evaluate(`document.querySelector(${JSON.stringify(activeTerminal)}).focus()`);
    await send('Input.insertText', { text: `"${process.execPath}" "${script}"` }); await enter();
    const pane = `main.app:not([hidden]) .terminal-pane[data-agent="${agent}"]`;
    await until(`document.querySelector(${JSON.stringify(pane)})?.dataset.agentState === 'idle'`, `${agent} negotiated idle state`);
    await evaluate(`window.e2eFalseWork = false; window.e2eStatusObserver = new MutationObserver(records => {
      for (const record of records) if (record.oldValue === 'working' || record.target.dataset.agentState === 'working') window.e2eFalseWork = true;
    }); window.e2eStatusObserver.observe(document.querySelector(${JSON.stringify(pane)}), { attributes: true, attributeFilter: ['data-agent-state'], attributeOldValue: true });`);
    await sleep(700);
    assert.equal(await evaluate('window.e2eStatusObserver.disconnect(); window.e2eFalseWork'), false, `${agent} idle redraw started work`);
    await send('Input.insertText', { text: 'w' });
    await until(`document.querySelector(${JSON.stringify(pane)})?.dataset.agentState === 'working'`, `${agent} working report without a spinner`);
    await sleep(5200);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(pane)}).dataset.agentState`), 'working', `${agent} work timed out`);
    for (const [key, state] of [['b', 'attention'], ['w', 'working'], ['d', 'idle'], ['i', 'idle']]) {
      await send('Input.insertText', { text: key });
      await until(`document.querySelector(${JSON.stringify(pane)})?.dataset.agentState === ${JSON.stringify(state)}`, `${agent} ${state} report`);
    }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', modifiers: 2, windowsVirtualKeyCode: 67 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', modifiers: 2, windowsVirtualKeyCode: 67 });
    await until(`!document.querySelector(${JSON.stringify(pane)})`, `${agent} cleared on process exit`);
  }
  console.log('e2e: Claude/Codex explicit status, idle redraws, long work, approvals and process exit passed');
  await evaluate(`${visible('[aria-label="변경사항 Diff 패널"]')}.click()`);
  await until(`Boolean(${visible('.review-file')}) && ${visible('.review-file')}.innerText.includes('hello-e2e.txt')`, 'Git changes panel');
  await until(`Boolean(${visible('.monaco-diff-editor')})`, 'read-only diff');
  console.log('e2e: read-only Git diff passed');
  await evaluate(`${visible('button[aria-label="새 터미널 탭"]')}.click()`);
  await until(`document.querySelector('main.app:not([hidden])').querySelectorAll('.tab-page').length === 2`, 'second terminal tab');
  // A new tab first shows the launcher; its first entry opens a plain shell.
  await until(`document.querySelector('main.app:not([hidden]) .tab-page:not([hidden]) .launchers button')`, 'new tab launcher');
  await evaluate(`document.querySelector('main.app:not([hidden]) .tab-page:not([hidden]) .launchers button').click()`);
  await until(`document.querySelector('main.app:not([hidden]) .tab-page:not([hidden]) .xterm-helper-textarea')`, 'second terminal ready');
  await until(`fetch('/api/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: window.e2eProjectId }) }).then(response => response.json()).then(state => state.ui.paneTabs?.length === 2)`, 'layout saved');
  await send('Page.reload');
  await until(`document.querySelector('main.app:not([hidden])')?.querySelectorAll('.tab-page').length === 2`, 'layout restored after reload');
  assert.deepEqual(problems, [], `browser errors: ${problems.join('\n')}`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', 'tests/sidebar-drag.test.mjs'], { cwd: root, env: { ...process.env, ADE_TEST_CDP: endpoint }, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`sidebar browser test exited ${code}`)));
  });
  console.log('e2e: auth, project open, PTY input/file write, Git diff, tabs, reload and sidebar dragging passed');
}
let failed = false;
try { await main(); } catch (error) { failed = true; console.error(`e2e: ${error.message}`); }
for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(error => { failed = true; console.error(`e2e cleanup: ${error.message}`); });
process.exitCode = failed ? 1 : 0;
