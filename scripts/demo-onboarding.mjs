// First-run demo you can watch: starts the same throwaway preview as preview-onboarding.mjs, opens a Chrome window and plays
// everything a new user sees at a human pace (setup → welcome → all 11 feature steps → launch animation → adding the first
// project → the next launch), then leaves the window to you. A white dot shows where it clicks.
// Nothing touches your own projects or settings. Ctrl+C (or closing the window) ends it and deletes every temporary file.
// SPEED=2 plays twice as fast. CHROME=/path/to/chrome picks the browser. HEADLESS=1 runs without a window (for checking the script).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..'), speed = Number(process.env.SPEED) || 1;
const chromePath = process.env.CHROME || {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
}[process.platform] || 'google-chrome';
if (chromePath.includes('/') && !existsSync(chromePath)) { console.error(`Chrome을 찾지 못했습니다: ${chromePath}\nCHROME=<경로>로 지정하세요.`); process.exit(1); }
const pause = ms => sleep(ms / speed), say = text => console.log(`  · ${text}`);

// A small project to open at the end, the way a new user would pick their first folder.
const temp = await mkdtemp(join(tmpdir(), 'ade-demo-')), sample = join(temp, 'my-app'), profile = join(temp, 'chrome');
await mkdir(join(sample, 'src'), { recursive: true });
await writeFile(join(sample, 'package.json'), JSON.stringify({ name: 'my-app', private: true, scripts: { dev: 'node src/server.js' } }, null, 2) + '\n');
await writeFile(join(sample, 'src/server.js'), "import { createServer } from 'node:http';\n\ncreateServer((req, res) => res.end('hello')).listen(3000);\n");
await writeFile(join(sample, 'README.md'), '# my-app\n\n무너에이드 시연용 예시 프로젝트\n');
try {
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', ...args], { cwd: sample, stdio: 'ignore' });
  git('init', '-b', 'main'); git('add', '.'); git('commit', '-m', 'init');
} catch { /* git is optional; the project opens without it */ }

// ---- server and browser ----
const preview = spawn(process.execPath, ['scripts/preview-onboarding.mjs'], { cwd: root, env: { ...process.env, NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((done, fail) => {
  preview.stdout.on('data', chunk => { const found = /http:\/\/127\.0\.0\.1:\d+\/#token=\w+/.exec(String(chunk))?.[0]; if (found) done(found); });
  preview.on('exit', () => fail(new Error('미리보기 서버가 시작되지 않았습니다.')));
});
const chrome = spawn(chromePath, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--window-size=1440,920', ...(process.env.HEADLESS ? ['--headless=new', url] : [`--app=${url}`])], { stdio: 'ignore' });

let ending = false;
const end = async code => {
  if (ending) return; ending = true;
  chrome.kill(); preview.kill('SIGTERM');
  await new Promise(done => preview.exitCode !== null ? done() : preview.once('exit', done));
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  process.exit(code);
};
process.on('SIGINT', () => end(0)); process.on('SIGTERM', () => end(0));
chrome.on('exit', () => end(0));

let port; for (let i = 0; i < 100 && !port; i++) { await sleep(100); port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0] || undefined; }
let page; for (let i = 0; i < 50 && !page; i++) { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); if (!page) await sleep(100); }
const socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise(done => socket.addEventListener('open', done, { once: true }));
let nextId = 0; const waiting = new Map();
socket.addEventListener('message', event => { const message = JSON.parse(event.data); waiting.get(message.id)?.(message); waiting.delete(message.id); });
const send = (method, params = {}) => new Promise((done, fail) => { const id = ++nextId; waiting.set(id, m => m.error ? fail(new Error(`${method}: ${m.error.message}`)) : done(m.result)); socket.send(JSON.stringify({ id, method, params })); });
const js = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const until = async (expression, what, ms = 20000) => { for (const stop = Date.now() + ms; Date.now() < stop; await sleep(100)) { if (await js(`Boolean(${expression})`).catch(() => false)) return; } throw new Error(`기다리다 멈춤: ${what}`); };

// Every page load gets the visible cursor and answers the folder dialog with the sample project instead of opening the OS one.
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => String(input).endsWith('/api/dialog/folder') ? new Promise(done => setTimeout(() => done(new Response(JSON.stringify({ path: ${JSON.stringify(sample)} }), { headers: { 'Content-Type': 'application/json' } })), 600)) : realFetch(input, init);
  addEventListener('DOMContentLoaded', () => { const dot = document.createElement('div'); dot.id = 'demo-cursor';
    dot.style.cssText = 'position:fixed;left:50%;top:110%;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:#ffffff59;border:2px solid #fff;box-shadow:0 0 0 2px #00000059,0 3px 10px #00000066;z-index:2147483647;pointer-events:none;transition:left .6s cubic-bezier(.2,.8,.2,1),top .6s cubic-bezier(.2,.8,.2,1),scale .15s';
    document.documentElement.append(dot); });` });
await send('Page.reload'); await sleep(300);

// ---- actions ----
const point = async selector => {
  await until(`document.querySelector(${JSON.stringify(selector)})`, selector);
  return js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 60) }; })()`);
};
const press = async ({ x, y }) => {
  await js(`(() => { const d = document.getElementById('demo-cursor'); if (d) { d.style.left = '${x}px'; d.style.top = '${y}px'; } })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await pause(700);
  await js(`(() => { const d = document.getElementById('demo-cursor'); if (d) { d.style.scale = '.7'; setTimeout(() => d.style.scale = '1', 150); } })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await pause(500);
};
const click = async selector => press(await point(selector));
const clickText = async (selector, text) => {
  const at = await js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(n => n.textContent.includes(${JSON.stringify(text)})); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!at) throw new Error(`찾지 못함: ${text}`); await press(at);
};
const type = async text => { for (const ch of text) { await send('Input.insertText', { text: ch }); await pause(70); } };
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const key = async (keyName, code, keyCode, modifiers = 0, text) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text && { text }) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers }); await pause(250);
};
const enter = () => key('Enter', 'Enter', 13, 0, '\r');
const next = async () => { await until(`!document.querySelector('.tour-coach footer .primary')?.disabled`, '다음 버튼'); await pause(1200); await click('.tour-coach footer .primary'); await pause(1500); };
const shown = '.tour .app:not([hidden]) .tab-page:not([hidden])';

try {
  console.log('\n무너에이드 첫 실행 시연을 시작합니다. 창을 지켜보세요. (끝내기: Ctrl+C)\n');
  await until(`document.querySelector('.setup')`, '화면 설정'); await pause(2500);
  say('화면 설정: 테마, 강조 색, 터미널 글꼴');
  await click('.setup-theme:nth-child(2)'); await pause(1500);
  await click('.setup-theme:nth-child(1)'); await pause(900);
  await click('.setup-accents button[aria-label="바이올렛"]'); await pause(1200);
  await click('.setup-accents button[aria-label="기본"]'); await pause(700);
  if (await js(`document.querySelectorAll('.setup-font-list button').length > 1`)) { await click('.setup-font-list button:nth-child(2)'); await pause(900); await click('.setup-font-list button:nth-child(1)'); await pause(700); }
  await click('.setup footer .primary'); await pause(3500);

  say('환영 카드'); await click('.tour-coach footer .primary'); await pause(1500);
  say('1 / 11 프로젝트');
  await click('.tour [data-project="api-server"] .folder-head'); await pause(1200); await click('.tour [data-project="my-app"] .folder-head'); await next();
  say('2 / 11 탭');
  await click('.tour [data-tab="server"] .folder-tab'); await pause(1000); await click('.tour [data-tab="web"] .folder-tab'); await pause(600);
  if (await js(`document.querySelector('.tour-coach footer .primary').disabled`)) { await click('.tour [data-tab="server"] .folder-tab'); await pause(600); await click('.tour [data-tab="web"] .folder-tab'); }
  await next();
  say('3 / 11 AI 에이전트 탭');
  await click('.tour .app:not([hidden]) .new-tab'); await pause(900); await clickText(`${shown} .launchers button`, 'Claude'); await next();
  say('4 / 11 다음 요청 예약');
  await click('.tour [data-agent="claude"] .xterm'); await type('포트를 환경 변수로 바꿔 줘'); await pause(400); await enter(); await pause(900);
  await type('테스트도 추가해 줘'); await pause(400); await key('Tab', 'Tab', 9, 0, '\t'); await next();
  say('5 / 11 알림');
  await click('.tour [data-tab="web"] .folder-tab');
  await until(`document.querySelector('.tour .folder-tabs [data-agent-state="attention"]')`, '에이전트 알림'); await pause(1500);
  await click('.tour .folder-tabs [data-agent-state="attention"]'); await pause(900);
  await click('.tour [data-agent="claude"] .xterm'); await pause(400); await key('1', 'Digit1', 49, 0, '1'); await pause(300); await enter(); await next();
  say('6 / 11 Diff');
  await click('.tour .app:not([hidden]) .tabbar [aria-label="변경사항 Diff 패널"]'); await pause(3000);
  await click('.tour .app:not([hidden]) .tabbar [aria-label="변경사항 Diff 패널"]'); await next();
  say('7 / 11 분할');
  await click(`${shown} .terminal-pane [aria-label="분할"]`); await pause(300); await click(`${shown} [aria-label="좌우 분할"]`); await pause(900); await clickText(`${shown} .launcher-pane .launchers button`, '터미널'); await pause(900);
  await click(`${shown} .terminal-pane.focused [aria-label="분할"]`); await pause(300); await click(`${shown} .terminal-pane.focused [aria-label="상하 분할"]`); await pause(600);
  if (await js(`Boolean(document.querySelector(${JSON.stringify(shown + ' .launcher-pane')}))`)) await clickText(`${shown} .launcher-pane .launchers button`, '터미널');
  await next();
  say('8 / 11 칸 이동과 최대화');
  await click(`${shown} .terminal-pane:not(.focused) .xterm`); await pause(900); await click(`${shown} .terminal-pane.focused [aria-label="최대화"]`); await pause(1500);
  if (await js(`document.querySelector('.tour-coach footer .primary').disabled`)) { await click(`${shown} [aria-label="최대화 해제"], ${shown} .terminal-pane.focused [aria-label="최대화"]`); }
  await next();
  say('9 / 11 탭 정리');
  await click('.tour [data-tab="build"] .folder-tab'); await pause(700);
  await key('[', 'BracketLeft', 219, MOD.alt | MOD.shift); await pause(700); await key('[', 'BracketLeft', 219, MOD.alt | MOD.shift); await next();
  say('10 / 11 명령 팔레트');
  await click('.tour .app:not([hidden]) .palette-button'); await pause(800); await type('codex'); await pause(900); await enter(); await next();
  say('11 / 11 설정');
  await click('.tour .app:not([hidden]) .tabbar [aria-label="설정"]'); await pause(2500); await key('Escape', 'Escape', 27); await next();

  say('마무리 카드 → 무너에이드 시작'); await pause(3000);
  await click('.tour-coach footer .primary');
  await until(`!document.querySelector('.splash') && !document.querySelector('.tour')`, '시작 화면'); await pause(2500);

  say('첫 프로젝트 추가 (폴더 선택 창 대신 예시 프로젝트가 골라집니다)');
  await clickText('.picker-tabs button', '기존 프로젝트 추가'); await pause(600);
  await click('.picker .folder-field button'); await until(`document.querySelector('.picker .folder-path')?.value`, '폴더 선택'); await pause(1200);
  await click('.picker-actions .primary');
  await until(`!document.querySelector('.picker')`, '프로젝트 열기'); await pause(5000);

  say('다음 실행: 앱을 다시 켜면 시작 화면 뒤에 하던 작업이 그대로 열립니다');
  await send('Page.reload'); await until(`document.querySelector('.splash')`, '재실행 시작 화면');
  await until(`!document.querySelector('.splash')`, '재실행'); await pause(1000);
  console.log('\n시연이 끝났습니다. 창은 그대로 두니 직접 눌러 보세요. 책 버튼으로 둘러보기를 다시 볼 수 있어요.');
  console.log('끝내려면 Ctrl+C 또는 창을 닫으세요. 임시 프로필과 예시 프로젝트는 그때 지워집니다.\n');
} catch (error) {
  console.error(`\n시연이 중간에 멈췄습니다: ${error.message}\n창은 그대로 두니 이어서 직접 진행할 수 있습니다. 끝내려면 Ctrl+C.\n`);
}
