// The plugin market of MoonerADE Hub in the isolated session: sign in, the list, installing from it, updates, an expired token, signing out, a lost account.
// Usage: VERIFY_OUT=… node scripts/verify/t-hub-market.mjs   (needs a running verify session (node scripts/verify/session.mjs up); the fake Hub is driven through /__test/*)
// The background update round (auto mode) does not run in the browser session (no startUpdates); tests/hub-market.test.mjs covers it.
import { connect, env } from './cdp.mjs'; import { check, eq, getResults, ok, sleep } from './lib.mjs'; import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { S } from './lib.mjs';
const hub = env().hub, c = await connect(p => p.url.includes('127.0.0.1'));
const test = (path, body = {}) => fetch(`${hub}/__test/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const requests = () => fetch(`${hub}/__test/requests`).then(r => r.json());
// An icon button's textContent starts with its icon's glyph name ("personHub 로그인"), so the visible label is matched at the end.
const clickExact = async (sel, text) => {
  const at = await c.ev(`const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>e.textContent.replace(/\\s+/g,' ').trim().endsWith(${JSON.stringify(text)})&&e.getClientRects().length&&!e.disabled); if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]`);
  if (!at) throw new Error(`no ${sel} "${text}"`); await c.click(...at);
};
const text = sel => c.ev(`return [...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.textContent.replace(/\\s+/g,' ').trim()).join(' | ')`);
// The test session shows a plugin's confirmation as a DOM dialog: Cancel is first and focused, the accept button is last.
const confirmText = async () => { await c.waitFor(`!!document.querySelector('dialog.verify-plugin-confirm[open]')`, 15000); return c.ev(`const d=document.querySelector('dialog.verify-plugin-confirm'); return {title:d.querySelector('h2').textContent, body:d.querySelector('pre').textContent, buttons:[...d.querySelectorAll('button')].map(b=>b.textContent)}`); };
const answer = async accept => { await c.ev(`const b=[...document.querySelectorAll('dialog.verify-plugin-confirm button')]; (${accept}?b.at(-1):b[0]).click(); return 1`); await c.waitFor(`!document.querySelector('dialog.verify-plugin-confirm[open]')`, 15000); };
const tab = async label => { const at = await c.ev(`const e=[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})); if(!e) return null; const r=e.getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]`); if (!at) throw new Error(`no tab ${label}`); await c.click(...at); };
const rows = () => c.ev(`return [...document.querySelectorAll('.plugin-market-row')].map(r=>({name:r.querySelector('.plugin-row-name strong')?.textContent, text:r.textContent.replace(/\\s+/g,' ').trim(), buttons:[...r.querySelectorAll('button')].map(b=>b.textContent.trim())}))`);

// A fresh session starts with the first-run tutorial over everything: skip it (every step but the last has 건너뛰기).
const skipTour = async () => {
  for (let i = 0; i < 10 && await c.ev(`return !!document.querySelector('.tour')`); i++) {
    const skip = await c.ev(`return [...document.querySelectorAll('.tour button')].some(b=>b.textContent.trim()==='건너뛰기')`);
    if (skip) await clickExact('.tour button', '건너뛰기'); else await c.ev(`const b=[...document.querySelectorAll('.tour button')].find(b=>/다음/.test(b.textContent)); b?.click(); return 1`);
    await sleep(900);
  }
};
await check('hub.open', '설정 → 플러그인에 마켓 탭이 있다', async () => {
  await c.waitFor(`!!document.querySelector('.tour, button[aria-label="설정"], button.recent-open')`, 20000);
  await skipTour();
  // After the tutorial the app may show the project picker: open the session's own project from the recent list.
  if (!await c.ev(`return !!document.querySelector('button[aria-label="설정"]')`)) {
    // A click on a recent project opens it. The page is still settling right after the tour, so a click can miss: try again.
    for (let i = 0; i < 5 && !await c.ev(`return !!document.querySelector('button[aria-label="설정"]')`); i++) { await sleep(1000); await c.clickSel('button.recent-open').catch(() => {}); await sleep(2500); }
    await c.waitFor(`!!document.querySelector('button[aria-label="설정"]')`, 20000);
  }
  await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='알겠어요')?.click(); return 1`); // the "tutorial can be replayed" tip
  await c.clickSel('button[aria-label="설정"]');
  await c.waitFor(`[...document.querySelectorAll('button')].some(b=>/플러그인$/.test(b.textContent.trim()))`, 10000);
  await c.clickSel('button', '플러그인');
  await c.waitFor(`[...document.querySelectorAll('[role=tab]')].some(b=>b.textContent.startsWith('마켓'))`, 10000);
  return await text('[role=tab]');
});
await check('hub.signed-out', '로그아웃 상태의 마켓은 로그인을 안내하고 목록을 보이지 않는다', async () => {
  await tab('마켓'); await c.waitFor(`!!document.querySelector('.plugin-market-signin')`);
  const body = await text('.plugin-market'); ok(/Hub 로그인/.test(body) && /GitHub 계정은 필요 없습니다/.test(body), body);
  eq(await c.ev(`return document.querySelectorAll('.plugin-market-row').length`), 0);
  await c.shot('hub-1-signed-out');
});
await check('hub.sign-in', '로그인: 코드가 보이고, 승인하면 계정 이름과 목록이 나온다', async () => {
  await test('publish', { id: 'hub-demo', version: '1.0.0', name: 'Hub 데모', description: 'Hub에서 받은 시험용 플러그인입니다.', grants: { workspace: true }, manifest: { workspace: true } });
  await test('publish', { id: 'hub-other', version: '0.2.0', name: '다른 플러그인', description: '두 번째 플러그인입니다.', grants: { terminal: true, mcp: true } });
  await test('state', { approval: 'manual' });
  await clickExact('button', 'Hub 로그인');
  await c.waitFor(`/BCDF-GHJK/.test(document.querySelector('.plugin-market')?.textContent||'')`, 10000);
  await c.shot('hub-2-code');
  await test('state', { approve: true });
  await c.waitFor(`document.querySelectorAll('.plugin-market-row').length===2`, 15000);
  const account = await text('.plugin-market-account'); ok(/시험 계정/.test(account), account);
  const list = await rows(); eq(list.map(r => r.name), ['Hub 데모', '다른 플러그인']);
  ok(list[0].buttons.some(label => label.endsWith('설치')) && /프로젝트·터미널 조작/.test(list[0].text), JSON.stringify(list[0]));
  ok(/터미널 명령/.test(list[1].text) && /에이전트 도구/.test(list[1].text), JSON.stringify(list[1]));
  await c.shot('hub-3-list');
});
await check('hub.no-token-in-page', '화면이 받는 상태에 토큰이 없다', async () => {
  const state = await c.ev(`const r=await fetch('/api/verify/plugins/state',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); return await r.text()`);
  const seen = (await requests()).requests.find(r => r.path === '/v1/plugins')?.auth; ok(seen, 'the app sent a token to the Hub');
  ok(!state.includes(seen), 'token leaked into the plugin state');
});
await check('hub.install', '설치: 설치 확인 창이 Hub를 출처로 적고, 승인하면 실행되고 목록이 설치됨으로 바뀐다', async () => {
  await clickExact('.plugin-market-row button', '설치');
  const dialog = await confirmText(); console.log(JSON.stringify(dialog).slice(0, 700));
  eq(dialog.title, '플러그인 설치'); ok(/받은 곳: MoonerADE Hub/.test(dialog.body) && /업데이트 출처: MoonerADE Hub/.test(dialog.body) && /프로젝트와 터미널/.test(dialog.body) && /SHA-256: [a-f0-9]{64}/.test(dialog.body), dialog.body);
  await c.shot('hub-4-install-dialog'); await answer(true);
  await c.waitFor(`[...document.querySelectorAll('.plugin-market-row')].some(r=>r.textContent.includes('Hub 데모')&&r.textContent.includes('설치됨'))`, 20000);
  const list = await rows(); ok(list[0].buttons.length === 0 && list[1].buttons.some(label => label.endsWith('설치')), JSON.stringify(list));
  await c.shot('hub-5-installed');
});
await check('hub.installed-tab', '설치한 플러그인에 나오고, 업데이트 출처는 MoonerADE Hub다', async () => {
  await tab('설치한 플러그인'); await c.waitFor(`[...document.querySelectorAll('.plugin-row')].some(r=>r.textContent.includes('Hub 데모'))`, 15000);
  await clickExact('.plugin-row', await c.ev(`return [...document.querySelectorAll('.plugin-row')].find(r=>r.textContent.includes('Hub 데모')).textContent.replace(/\\s+/g,' ').trim()`));
  await c.waitFor(`!!document.querySelector('.plugin-update')`, 10000);
  const section = await text('.plugin-section:has(.plugin-update)'); ok(/출처 MoonerADE Hub/.test(section) && /최신 버전입니다|아직 확인하지 않았습니다/.test(section) && !/github\.com/.test(section), section);
  await c.shot('hub-6-detail');
});
await check('hub.update', '새 버전: 지금 확인 → 새 버전 안내 → 설치 확인 창이 1.0.0 → 1.1.0을 적는다', async () => {
  await test('publish', { id: 'hub-demo', version: '1.1.0', name: 'Hub 데모', description: 'Hub에서 받은 시험용 플러그인입니다.', grants: { workspace: true }, manifest: { workspace: true } });
  await clickExact('button', '지금 확인');
  await c.waitFor(`/새 버전 v1\\.1\\.0이\\(가\\) 있습니다/.test(document.querySelector('.plugin-update')?.textContent||'')`, 15000);
  await c.shot('hub-7-update-available');
  await clickExact('.plugin-update button', '설치');
  const dialog = await confirmText(); eq(dialog.title, '플러그인 업데이트'); ok(/1\.0\.0 → 1\.1\.0/.test(dialog.body) && /받은 곳: MoonerADE Hub/.test(dialog.body), dialog.body);
  await answer(true);
  await c.waitFor(`/최신 버전입니다 \\(v1\\.1\\.0\\)/.test(document.querySelector('.plugin-update')?.textContent||'')`, 20000);
  // The same update straight from the installed list: the row's own button (not a button inside the row's button).
  await test('publish', { id: 'hub-demo', version: '1.2.0', name: 'Hub 데모', description: 'Hub에서 받은 시험용 플러그인입니다.', grants: { workspace: true }, manifest: { workspace: true } });
  await clickExact('button', '지금 확인');
  await c.waitFor(`/새 버전 v1\\.2\\.0이\\(가\\) 있습니다/.test(document.querySelector('.plugin-update')?.textContent||'')`, 15000);
  await c.clickSel('button.plugin-back');
  await c.waitFor(`!!document.querySelector('.plugin-row-update button')`, 10000);
  ok(!await c.ev(`return !!document.querySelector('button .plugin-row-update, button.plugin-row')`), 'row must not be a button');
  await c.shot('hub-7b-row-update');
  await clickExact('.plugin-row-update button', '업데이트 v1.2.0');
  eq((await confirmText()).title, '플러그인 업데이트'); await answer(true);
  await c.waitFor(`!document.querySelector('.plugin-row-update')`, 20000);
  await clickExact('.plugin-row', await c.ev(`return [...document.querySelectorAll('.plugin-row')].find(r=>r.textContent.includes('Hub 데모')).textContent.replace(/\\s+/g,' ').trim()`));
  await c.waitFor(`!!document.querySelector('.plugin-update')`, 10000);
});
await check('hub.expired', '토큰이 만료돼도 목록은 다시 받아지고(갱신 한 번), 로그인은 유지된다', async () => {
  await c.waitFor(`!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('플러그인'))`, 5000).catch(() => {});
  const before = (await requests()).refreshCalls;
  await test('state', { expireAccess: true });
  await c.clickSel('button.plugin-back');
  await c.waitFor(`[...document.querySelectorAll('[role=tab]')].some(b=>b.textContent.startsWith('마켓'))`, 10000);
  await tab('마켓'); await c.waitFor(`document.querySelectorAll('.plugin-market-row').length>=1`, 10000);
  await c.clickSel('button[aria-label="목록 새로고침"]');
  await sleep(1500);
  eq((await requests()).refreshCalls, before + 1); ok(await text('.plugin-market-account'), 'still signed in');
});
await check('hub.sign-out', '로그아웃하면 마켓은 로그인 안내로, 설치한 Hub 플러그인은 로그인 필요로 바뀐다', async () => {
  await clickExact('.plugin-market-account button', '로그아웃');
  await c.waitFor(`!!document.querySelector('.plugin-market-signin')`, 10000); eq((await requests()).signedOut, 1);
  await tab('설치한 플러그인'); await c.waitFor(`!!document.querySelector('.plugin-row')`, 5000);
  await c.ev(`[...document.querySelectorAll('.plugin-row')].find(r=>r.textContent.includes('Hub 데모')).click(); return 1`);
  await c.waitFor(`/Hub에 로그인해야 새 버전을 확인할 수 있어요/.test(document.querySelector('.plugin-update')?.textContent||'')`, 10000);
  ok(await c.ev(`return [...document.querySelectorAll('.plugin-update button')].some(b=>b.textContent.trim().endsWith('Hub 로그인'))`), 'sign-in button on the update section');
  await c.shot('hub-8-needs-login');
});
await check('hub.lost', '계정이 폐기되면 로그인 해제와 이유가 마켓에 보인다', async () => {
  await test('state', { approval: 'auto' });
  await c.clickSel('button.plugin-back');
  await tab('마켓'); await clickExact('button', 'Hub 로그인');
  await c.waitFor(`document.querySelectorAll('.plugin-market-row').length===2`, 15000);
  await test('state', { revokeAll: true });
  await c.clickSel('button[aria-label="목록 새로고침"]');
  await c.waitFor(`!!document.querySelector('.plugin-market-signin') && /다시 로그인하세요/.test(document.querySelector('.plugin-market')?.textContent||'')`, 15000);
  await c.shot('hub-9-lost');
});
console.log('problems', JSON.stringify(c.problems));
writeFileSync(join(S, 'results-hub-market.json'), JSON.stringify(getResults(), null, 1));
c.close();
process.exit(getResults().every(r => r.ok) && !c.problems.length ? 0 : 1);
