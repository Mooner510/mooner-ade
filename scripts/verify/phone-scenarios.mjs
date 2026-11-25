// The ready scenario checks of the phone <-> PC end-to-end rig (t-phone-e2e.mjs scenarios [names…]). Each one drives the real phone (RemoteUiActivity of the debug app),
// the test ADE and, where a second client is needed, a desktop-mode Chrome of its own (headless, its own profile, never the shared session's).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adeClient, alive, dir, log, needRig, netCheck, readManifest, shotsDir, sleep, until, writeManifest } from './phone-rig.mjs';
import { adbTool, attach, findPage, listPages, PKG } from './phone-adb.mjs';
import { isRemote, open as openPc } from './phone-steps.mjs';
import { defaultChrome } from './session-dirs.mjs';

const COMPOSER = 'textarea[aria-label="메시지 입력"]';
const nonce = () => Math.random().toString(36).slice(2, 8);

// ---- a desktop-mode browser of our own ---------------------------------------------------------------------------------------------------------
export async function startDesktop(m) {
  const profile = join(dir, 'chrome-desktop');
  rmSync(join(profile, 'DevToolsActivePort'), { force: true });
  const chrome = spawn(defaultChrome(), [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--no-pings', '--metrics-recording-only', '--disable-features=OptimizationHints,MediaRouter,Translate,CertificateTransparencyComponentUpdater',
    // Nothing may leave this machine: every proxied request goes to a dead local port, and no host name but loopback resolves.
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost',
    '--window-size=1400,900', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  chrome.unref();
  writeManifest({ pids: { ...readManifest().pids, chrome: chrome.pid } });
  const port = await until(() => { try { return readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] || null; } catch { return null; } }, 20000, 200);
  const cdp = `http://127.0.0.1:${port}`;
  const version = await (await fetch(`${cdp}/json/version`)).json();
  // The sign-in cookie the dev server derives from ADE_DEV_TOKEN (scripts/verify/start-ui.mjs does the same), so the page loads signed in.
  const browser = await attach({ webSocketDebuggerUrl: version.webSocketDebuggerUrl });
  await browser.send('Storage.setCookies', { cookies: [{ name: 'ade_session', value: createHash('sha256').update(`ade-dev-session:${m.ade.devToken}`).digest('hex'), domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }] });
  browser.close();
  const target = (await (await fetch(`${cdp}/json/list`)).json()).find(t => t.type === 'page');
  const page = await attach(target, { mouse: true });
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.navigate', { url: `${m.ade.origin}/` });
  page.shot = async name => { const r = await page.send('Page.captureScreenshot', { format: 'png' }); mkdirSync(shotsDir, { recursive: true }); const file = join(shotsDir, `${name}.png`); writeFileSync(file, Buffer.from(r.data, 'base64')); return file; };
  page.quit = async () => { try { const b = await attach({ webSocketDebuggerUrl: version.webSocketDebuggerUrl }); await b.send('Browser.close').catch(() => {}); b.close(); } catch { /* gone */ } };
  return page;
}

// ---- chat helpers (both pages run the same ADE web UI) ---------------------------------------------------------------------------------------------
// Gets a page to the project's chat: opens the recent project, then a Claude chat from the launcher when there is none yet; dismisses the one-time hints.
export async function ensureChat(page, who) {
  for (let tries = 0; tries < 40; tries++) {
    if (await page.ev(`return Boolean(document.querySelector(${JSON.stringify(COMPOSER)}))`)) return;
    const step = await page.ev(`
      const vis = e => e.getClientRects().length > 0, find = (sel, text) => [...document.querySelectorAll(sel)].find(e => vis(e) && (!text || (e.textContent || '').includes(text)));
      for (const t of ['나중에', '알겠어요', '확인']) if (find('button', t) && !find('.recent-open')) { find('button', t).click(); return 'dismiss ' + t; }
      if (document.body.innerText.includes('변경 내역') && find('button', 'close') && !find('textarea')) return 'changelog';
      if (find('button.recent-open')) return 'project';
      if (find('button', 'Claude') && find('button', 'Chat 모드') || find('button', 'Claude') && find('.launcher, .launchers, main, .pane')) return 'launch';
      return 'wait';`);
    if (step === 'changelog') await page.pressKey('Escape', 'Escape', 27);
    else if (step === 'project') await page.tap('button.recent-open');
    else if (step === 'launch') await page.tap('button', 'Claude');
    else if (step.startsWith('dismiss')) { /* handled in page */ }
    await sleep(900);
  }
  throw new Error(`${who}: 채팅 입력창이 나타나지 않았습니다. 화면: ${await page.ev('return document.body.innerText.replace(/\\s+/g, " ").slice(0, 300)')}`);
}
export const dismissHints = page => page.ev(`for (const t of ['나중에', '알겠어요']) { const b = [...document.querySelectorAll('button')].find(e => e.getClientRects().length && (e.textContent || '').trim() === t); if (b) b.click(); }`);
// What the chat shows: user messages, the answer text, how far the view is from its bottom, and how many stream lines are in it.
export const chatView = (page, tag = '') => page.ev(`const s = document.querySelector('.chat-scroll'); if (!s) return null;
  const text = s.innerText, re = new RegExp('스트림 ' + ${JSON.stringify(tag ? tag + ' ' : '')} + '\\\\d+/\\\\d+번째 줄입니다', 'g'), found = text.match(re) || [];
  return { users: [...s.querySelectorAll('.chat-msg.user')].map(e => e.innerText.trim()), text, gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), scrollHeight: s.scrollHeight, client: s.clientHeight,
    lines: new Set(found).size, all: found };`);
const composerValue = page => page.ev(`return document.querySelector(${JSON.stringify(COMPOSER)})?.value ?? ''`);
// Types into the composer like a user and presses send. On the phone: a touch on the field, then real key events (adb input text); if the keys do not land
// (the keyboard is slow to come up), once more, then DevTools text input. In the desktop browser: DevTools text input.
export async function sendChat(page, text, adb = null) {
  const typed = async () => (await composerValue(page)).includes(text);
  if (adb) {
    for (let attempt = 0; attempt < 2 && !await typed(); attempt++) { await page.tap(COMPOSER); await sleep(700); adb.typeText(text); await sleep(500); }
    if (!await typed()) { await page.ev(`document.querySelector(${JSON.stringify(COMPOSER)}).focus()`); await page.insertText(text); await sleep(300); }
  } else { await page.ev(`const t = document.querySelector(${JSON.stringify(COMPOSER)}); t.focus(); t.select?.();`); await page.insertText(text); await sleep(250); }
  await page.waitFor(`document.querySelector(${JSON.stringify(COMPOSER)}).value.includes(${JSON.stringify(text)})`, 5000, '입력창에 글자가 들어감');
  await page.tap('button.chat-send');
}
const fakeLog = m => { try { return readFileSync(join(dir, 'fake-claude.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

// ---- scenarios ------------------------------------------------------------------------------------------------------------------------------------------
export async function scenarios({ argv }) {
  const m = needRig(), adb = adbTool(), ade = adeClient(m);
  const wanted = argv.slice(argv.indexOf('scenarios') + 1).filter(a => !a.startsWith('--'));
  const results = [];
  const shots = [];
  const run = async (id, title, fn) => {
    if (wanted.length && !wanted.includes(id)) return;
    const t0 = Date.now();
    try { const note = await fn(); results.push({ id, title, ok: true, note }); console.log(`PASS ${id} ${title}${note ? ' — ' + note : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
    catch (error) { results.push({ id, title, ok: false, note: String(error.message ?? error).slice(0, 500) }); console.log(`FAIL ${id} ${title}\n     ${String(error.message ?? error).slice(0, 500)}`); try { shots.push(adb.screencap(`FAIL-${id}`)); } catch { /* best effort */ } }
  };
  const shot = name => { const file = adb.screencap(name); shots.push(file); return file; };

  let phone = await openPc({ argv: [] });
  let desktop = null;
  try {
    await ensureChat(phone, '폰'); await dismissHints(phone);
    const base = await chatView(phone);

    await run('s1-phone-roundtrip', '폰에서 친 메시지가 테스트 ADE에 닿고, fake claude의 답이 폰에 나타난다', async () => {
      const n = nonce(), text = `e2e-echo phone-${n}`;
      await sendChat(phone, text, adb);
      await until(() => fakeLog(m).some(c => c.kind === 'user' && c.text === text), 15000, 200).catch(() => { throw new Error('fake claude가 폰의 메시지를 받지 못했습니다'); });
      await phone.waitFor(`document.querySelector('.chat-scroll').innerText.includes(${JSON.stringify('echo: ' + text)})`, 20000, '폰에 답이 나타남');
      shot('s1-phone-roundtrip');
      return `받은 메시지 "${text}"`;
    });

    await run('s2-live-stream', 'fake claude의 답이 폰에 실시간으로 이어서 나타난다(줄이 하나씩 늘어난다)', async () => {
      const tag = 'live' + nonce();
      await sendChat(phone, `e2e-stream 10 ${tag}`, adb);
      const seen = new Set(); let midShot = false;
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        const v = await chatView(phone, tag); seen.add(v.lines);
        if (!midShot && v.lines >= 4 && v.lines < 10) { shot('s2-live-stream-mid'); midShot = true; }
        if (v.lines >= 10) break;
        await sleep(200);
      }
      if (!seen.has(10)) throw new Error(`10줄이 끝까지 나타나지 않았습니다(본 값: ${[...seen]})`);
      const progressive = [...seen].filter(n => n > 0 && n < 10).length;
      if (progressive < 3) throw new Error(`한꺼번에 나타났습니다(중간 상태 ${progressive}개)`);
      return `폰이 본 중간 상태 ${progressive}개(${[...seen].sort((a, b) => a - b)})`;
    });

    if (!wanted.length || wanted.some(w => /^s[345]/.test(w))) {
      desktop = await startDesktop(m);
      await until(async () => (await desktop.ev('return document.readyState')) === 'complete', 20000, 200);
      await ensureChat(desktop, '데스크톱'); await dismissHints(desktop);
    }
    await run('s3-desktop-to-phone', '데스크톱 모드 브라우저에서 보낸 메시지가 폰에 나타난다', async () => {
      const n = nonce(), text = `e2e-echo desktop-${n}`;
      await desktop.shot('s3-desktop-before');
      await sendChat(desktop, text);
      await phone.waitFor(`document.querySelector('.chat-scroll').innerText.includes(${JSON.stringify('echo: ' + text)})`, 25000, '폰에 데스크톱의 메시지와 답이 나타남');
      const view = await chatView(phone);
      if (!view.users.some(u => u.includes(text))) throw new Error('폰 화면에 데스크톱이 보낸 사용자 메시지가 없습니다');
      shot('s3-desktop-to-phone'); await desktop.shot('s3-desktop-after');
      return `폰이 받은 "${text}"`;
    });

    await run('s4-autoscroll', '맨 아래에 있는 동안 새 줄이 올 때 폰의 스크롤이 따라간다', async () => {
      await phone.ev(`const s = document.querySelector('.chat-scroll'); s.scrollTop = s.scrollHeight;`); await sleep(400);
      const before = await chatView(phone), tag = 'scroll' + nonce();
      await sendChat(desktop, `e2e-stream 24 ${tag}`);
      const gaps = []; let maxScrollHeight = before.scrollHeight, grew = false; const end = Date.now() + 40000;
      while (Date.now() < end) {
        const v = await chatView(phone, tag); gaps.push(v.gap); maxScrollHeight = Math.max(maxScrollHeight, v.scrollHeight); if (v.scrollHeight > before.scrollHeight + 100) grew = true;
        if (v.lines >= 24 && v.gap <= 4) break;
        await sleep(250);
      }
      const last = await chatView(phone, tag);
      if (!grew) throw new Error(`대화가 화면보다 길어지지 않아 스크롤을 확인할 수 없습니다(scrollHeight ${before.scrollHeight}→${maxScrollHeight})`);
      shot('s4-autoscroll-end');
      const during = gaps.slice(2); const worst = Math.max(...during.slice(0, -1), 0);
      if (last.gap > 4) throw new Error(`끝났는데 맨 아래가 아닙니다(gap ${last.gap})`);
      if (worst > last.client) throw new Error(`스트리밍 중 맨 아래를 놓쳤습니다(최대 gap ${worst}px)`);
      return `스트림 24줄, scrollHeight ${before.scrollHeight}→${last.scrollHeight}, 최대 gap ${worst}px, 끝 gap ${last.gap}px`;
    });

    await run('s5-reconnect', '중계를 일부러 끊었다 되살려도 폰이 다시 붙고 대화가 따라잡는다', async () => {
      const relay = async path => (await fetch(`http://127.0.0.1:${m.ctlPort}${path}${path.includes('?') ? '&' : '?'}token=${m.ctlToken}`)).json();
      const sessionsBefore = (await ade.plugins.view()).status?.text ?? '';
      await phone.ev(`const s = document.querySelector('.chat-scroll'); s.scrollTop = s.scrollHeight;`);
      const tag = 'cut' + nonce();
      await sendChat(desktop, `e2e-stream 24 ${tag}`); // ~14 s of lines, produced on the PC whether or not the phone listens
      await until(async () => (await chatView(phone, tag)).lines >= 3, 20000, 200);
      const accepted = (await relay('/relay')).accepted;
      await relay('/cut?ms=9000');
      await sleep(2500);
      const during = await chatView(phone, tag).catch(() => null);
      shot('s5-during-cut');
      const status = await ade.plugins.view().then(v => v.status?.text);
      log(`  끊긴 동안: 폰 줄 ${during?.lines ?? '?'}, 플러그인 상태 "${status}"`);
      await until(async () => (await relay('/relay')).accepted > accepted + 1, 60000, 500).catch(() => { throw new Error('끊은 뒤 연결(폰이나 플러그인)이 중계에 다시 붙지 않았습니다'); });
      await phone.waitFor(`document.querySelector('.chat-scroll')?.innerText.includes('스트림 ${tag} 24/24번째 줄입니다')`, 90000, '폰이 마지막 줄(24/24)까지 따라잡음');
      const final = await chatView(phone, tag), dups = final.all.length - new Set(final.all).size;
      const missing = Array.from({ length: 24 }, (_, i) => i + 1).filter(i => !final.all.some(l => l === `스트림 ${tag} ${i}/24번째 줄입니다`));
      shot('s5-after-reconnect');
      if (missing.length) throw new Error(`빠진 줄: ${missing.join(',')}`);
      if (during && during.lines >= 24) throw new Error('끊긴 동안 이미 24줄이 보였습니다(끊김이 효과가 없었습니다)');
      return `끊김 9초, 중계 새 연결 ${(await relay('/relay')).accepted - accepted}개, 폰 줄 24/24 중복 ${dups}, (끊긴 동안 폰이 보던 줄 ${during?.lines ?? '?'}개)`;
    });

    await run('s6-offline-safety', '이 rig의 모든 프로세스가 loopback 밖으로 나가지 않았다', async () => {
      const net = netCheck(readManifest());
      const guard = existsSync(join(dir, 'blocked-connections.log')) ? readFileSync(join(dir, 'blocked-connections.log'), 'utf8').trim() : '';
      if (net.external.length) throw new Error(`loopback 밖 연결: ${JSON.stringify(net.external)}`);
      return `Get-NetTCPConnection 외부 연결 0건(프로세스 ${net.processes.length}개 검사), 가드가 막은 시도: ${guard ? guard.split('\n').length + '건 ' + guard.split('\n').map(l => l.split(' blocked ')[1]).join(', ') : '0건'}`;
    });
  } finally {
    if (desktop) { await desktop.quit(); desktop.close(); }
    phone.close();
  }
  const failed = results.filter(r => !r.ok);
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), results, shots }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} 통과. 증거 스크린샷: ${shotsDir}`);
  if (failed.length) process.exitCode = 1;
}
