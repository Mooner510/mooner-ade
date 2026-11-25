// Phone <-> test PC end to end (docs/REMOTE_UI.md "폰 종단 테스트"): a real phone with the debug MoonerADE app (com.roufin.ade.dev) pairs with a throwaway ADE
// through the real remote-access plugin over a local Hub, shows that ADE's own UI in RemoteUiActivity and chats with the fake `claude`. No fingerprint, no real
// Hub login, no AI usage; nothing of the installed app or the user's data is touched.
//
//   node scripts/verify/t-phone-e2e.mjs up      [--hub <hub checkout>] [--plugins <plugins checkout>] [--keep]   start the Hub, relay, ADE (background owner)
//   node scripts/verify/t-phone-e2e.mjs link                                                                      the test ADE's plugin: approve, link the account, turn on
//   node scripts/verify/t-phone-e2e.mjs apk     [--webapps <mooner-webapps checkout>] [--no-build]                build + install the debug APK pointed at the local Hub
//   node scripts/verify/t-phone-e2e.mjs login | pair | open                                                       the phone: sign in, pair with the test ADE, open its UI
//   node scripts/verify/t-phone-e2e.mjs scenarios [names…]                                                        the ready checks (see `help`)
//   node scripts/verify/t-phone-e2e.mjs all     [same options]                                                    up, link, apk, login, pair, open, scenarios
//   node scripts/verify/t-phone-e2e.mjs shot <name> | status | down
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adeClient, alive, dir, ensureSession, EXPECT, freePort, pickPort, hex, hubApprove, hubBinary, lib, log, mainCheckout, needRig, readManifest, relayProxy, ROOT, shotsDir, sleep, startHub, stagePlugin, stopRecorded, until, writeManifest } from './phone-rig.mjs';

const argv = process.argv.slice(2), cmd = argv[0] ?? 'help';
const flag = name => argv.includes(name), opt = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
// Sibling checkouts: this checkout's own neighbours (mooner-apps/{wt/<x>|mooner-ade-hub,…}); pass --hub/--plugins/--webapps for others.
const sibling = (name, wt) => [process.env[`PHONE_E2E_${name.toUpperCase()}`], join(ROOT, '..', wt), join(mainCheckout(), '..', name)].filter(Boolean).map(p => resolve(p)).find(p => existsSync(p));
const where = { hub: () => resolve(opt('--hub', sibling('mooner-ade-hub', 'hub-e2e') ?? '')), plugins: () => resolve(opt('--plugins', sibling('mooner-ade-plugins', 'plugins-e2e') ?? '')), webapps: () => resolve(opt('--webapps', sibling('mooner-webapps', 'webapps-e2e') ?? '')) };

// ---- up: the owner process keeps the Hub, the relay and the ADE server alive --------------------------------------------------------------
async function up() {
  const existing = readManifest();
  if (existing?.ready && alive(existing.pids?.owner)) { log('이미 떠 있습니다(status 참고).'); return; }
  ensureSession(dir, { kind: 'phone-e2e', reason: 'phone <-> test PC end-to-end rig' });
  for (const name of ['hub.log', 'owner.log', 'blocked-connections.log']) rmSync(join(dir, name), { force: true });
  if (!flag('--keep')) for (const name of ['data', 'home', 'repo', 'fake-claude.jsonl', 'ctl.json', 'plugin-src', 'rig.json']) rmSync(join(dir, name), { recursive: true, force: true });
  const hub = where.hub(), plugins = where.plugins();
  for (const [what, p, probe] of [['Hub', hub, 'cmd/hub/main.go'], ['plugins', plugins, 'remote/plugin.json']]) if (!existsSync(join(p, probe))) throw new Error(`${what} checkout을 찾지 못했습니다(${p}). --${what === 'Hub' ? 'hub' : 'plugins'} <경로>로 알려 주세요.`);
  if (!existsSync(join(ROOT, 'apps/web/dist/index.html'))) throw new Error('apps/web/dist가 없습니다. 폰은 이 빌드를 받습니다: pnpm --filter @mooner/ade-web build');
  writeManifest({ ready: false, config: { hub, plugins, port: Number(opt('--port', process.env.PHONE_E2E_PORT ?? 47213)) }, startedAt: Date.now() });
  const out = openSync(join(dir, 'owner.log'), 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'owner'], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: { ...process.env, VERIFY_OUT: dir, ...loopbackOnly() } });
  child.unref();
  const m = await until(() => { const x = readManifest(); if (x?.error) throw new Error(x.error); return x?.ready && x; }, 180000, 500).catch(error => { throw new Error(`owner가 준비되지 않았습니다: ${error.message} (로그: ${join(dir, 'owner.log')})`); });
  log(`rig 시작: Hub ${m.hubUrl}  ADE ${m.ade.origin}  세션 폴더 ${dir}`);
}

// Every Node process of the rig (owner, ADE server, plugin host) preloads loopback-only.cjs: no socket leaves this machine, refusals go to blocked-connections.log.
const loopbackOnly = () => ({ NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${join(ROOT, 'scripts/verify/loopback-only.cjs').replaceAll('\\', '/')}`.trim(), PHONE_E2E_GUARD_LOG: join(dir, 'blocked-connections.log') });

async function owner() {
  const config = readManifest().config;
  try {
    const bin = hubBinary(config.hub), hubPort = await freePort(), relayPort = await pickPort(config.port), ctlPort = await freePort(), ctlToken = hex(16);
    const hub = startHub(bin, hubPort);
    await until(() => fetch(`http://127.0.0.1:${hubPort}/readyz`).then(r => r.ok), 20000, 200);
    const relay = relayProxy({ port: relayPort, targetPort: hubPort }); await relay.start();
    const hubUrl = `http://127.0.0.1:${relayPort}`;
    const plugin = stagePlugin(config.plugins, join(dir, 'plugin-src'));
    // An onboarded profile in chat mode (as a user's PC has), so no tour is on screen, on the phone either.
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'app-state.json'), JSON.stringify({ version: 1, openProjects: [], activeProjectId: '', settings: { theme: 'dark', onboarded: true, tourVersion: 2, tipsVersion: 1, tips: false, gitTipPending: false, defaultMode: 'chat', chatTipPending: false, chatPermissionAutoSet: true } }));
    const devToken = hex(32), adePort = await freePort();
    const ade = await lib.boot({ dir, root: ROOT, port: adePort, env: {
      ADE_DEV: '1', ADE_DEV_TOKEN: devToken, ADE_VERIFY_PLUGINS: '1', VERIFY_PLUGIN_DIR: plugin.dir,
      // The plugin's own Hub address; the plugin host runs with this env minus ADE_*/VERIFY_*. ADE_HUB_URL (feedback, plugin market) stays the dead port boot() sets.
      MOONER_REMOTE_HUB_URL: hubUrl, MOONER_REMOTE_TEST_NO_BROWSER: '1' } });
    const m = writeManifest({ ready: true, error: null, hubUrl, hubPort, relayPort, ctlPort, ctlToken, plugin,
      ade: { origin: ade.origin, port: adePort, devToken, cookie: ade.cookie, projectId: ade.projectId, repo: ade.repo, data: ade.data },
      pids: { owner: process.pid, hub: hub.pid, ade: ade.child.pid } });
    log(`rig 준비: ${JSON.stringify({ hubUrl, ade: ade.origin, pids: m.pids })}`);
    const control = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x'), reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (url.searchParams.get('token') !== ctlToken) return reply(403, { error: 'token' });
      if (url.pathname === '/cut') { const ms = Number(url.searchParams.get('ms') ?? 8000); void relay.cut(ms); return reply(200, { cutMs: ms }); }
      if (url.pathname === '/relay') return reply(200, { open: relay.open, accepted: relay.accepted, events: relay.events.slice(-20) });
      if (url.pathname === '/stop') { reply(200, { stopping: true }); setTimeout(() => shutdown(0), 100); return; }
      reply(404, {});
    });
    await new Promise(r => control.listen(ctlPort, '127.0.0.1', r));
    let closing = false;
    const shutdown = async code => {
      if (closing) return; closing = true;
      log('rig 종료');
      await ade.stop().catch(() => {}); hub.kill(); await relay.stop().catch(() => {}); control.close();
      writeManifest({ ready: false, stoppedAt: Date.now() });
      process.exit(code);
    };
    ade.child.once('exit', code => { if (!closing) { log(`ADE 서버가 스스로 끝났습니다(코드 ${code}): ${ade.stderr.slice(-800)}`); void shutdown(1); } });
    hub.once('exit', code => { if (!closing) { log(`Hub가 스스로 끝났습니다(코드 ${code})`); void shutdown(1); } });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown(0));
  } catch (error) {
    log(`owner 실패: ${error.stack ?? error}`);
    writeManifest({ ready: false, error: String(error.message ?? error) });
    process.exit(1);
  }
}

const control = async (path, params = {}) => { const m = needRig(); const url = new URL(`http://127.0.0.1:${m.ctlPort}${path}`); url.search = new URLSearchParams({ token: m.ctlToken, ...params }); return (await fetch(url)).json(); };

// ---- link: the test ADE's remote-access plugin -------------------------------------------------------------------------------------------------
async function link() {
  const m = needRig(), ade = adeClient(m), plugins = ade.plugins;
  let state = await plugins.state();
  if (!state.enabled) {
    log('플러그인 기능 켜기(확인 창은 이 스크립트가 승인)');
    let finished = false; const call = ade.api('verify/plugins/setEnabled', { args: [true] }).finally(() => { finished = true; });
    await plugins.accept(() => true, () => finished, 15000); state = await call;
  }
  let item = (await ade.api('verify/plugins/rescan')).plugins.find(p => p.id === m.plugin.id);
  if (!item) throw new Error(`플러그인 ${m.plugin.id}가 목록에 없습니다: ${JSON.stringify((await plugins.state()).plugins.map(p => [p.folder, p.id, p.state, p.error]))}`);
  if (item.state === 'new' || item.state === 'changed') {
    log(`플러그인 승인: ${item.folder} ${item.version}`);
    let finished = false; const call = ade.api('verify/plugins/approve', { args: [item.folder] }).finally(() => { finished = true; });
    await plugins.accept(() => true, () => finished, 15000); await call;
  }
  await ade.api('verify/plugins/setUpdateMode', { args: ['manual'] }); // never ask GitHub for a newer plugin
  await until(async () => (await plugins.state()).plugins.find(p => p.id === m.plugin.id)?.state === 'running', 30000, 300);
  let view = await plugins.view();
  if (!view?.info?.some(i => i.key === 'account')) {
    log('계정 연결: 플러그인이 Hub에 기기 코드를 요청');
    await ade.api('verify/plugins/action', { args: [m.plugin.id, 'connect', {}] });
    const code = await until(async () => plugins.info('code'), 10000, 200), verifyUrl = await plugins.info('loginUrl');
    log(`  코드 ${code}, 로그인 주소 ${verifyUrl} → Hub dev-login 폼으로 승인`);
    await hubApprove(m.hubUrl, { verifyUrl, userCode: code, name: 'e2e' });
    await until(async () => plugins.info('account'), 30000, 500);
    log(`  연결된 계정: ${await plugins.info('account')}`);
  }
  view = await plugins.view();
  if (!view.actions.some(a => a.id === 'disable')) {
    log('원격 접속 켜기');
    const { dialogs } = await plugins.actionWithDialog('enable');
    log(`  확인 창: ${dialogs.join(' | ')}`);
  }
  await until(async () => /켜져 있습니다/.test((await plugins.view())?.status?.text ?? '') && (await plugins.view()).status.tone === 'ok', 40000, 500)
    .catch(async () => log(`  Hub 연결 대기 중: ${JSON.stringify((await plugins.view())?.status)}`));
  log(`플러그인 상태: ${JSON.stringify((await plugins.view()).status)}`);
}

async function status() {
  const m = readManifest();
  if (!m) return log('rig 기록이 없습니다.');
  console.log(JSON.stringify({ ready: m.ready, hubUrl: m.hubUrl, ade: m.ade?.origin, pids: Object.fromEntries(Object.entries(m.pids ?? {}).map(([k, p]) => [k, `${p}${alive(p) ? '' : ' (꺼짐)'}`])), phone: m.phone, error: m.error }, null, 2));
}

async function down() {
  const m = readManifest();
  if (!m) return log('rig 기록이 없습니다.');
  if (m.phone?.serial) await (await import('./phone-steps.mjs')).signOutApp(m, log).catch(error => log(`폰 앱 로그아웃 실패: ${error.message}`));
  const phone = await import('./phone-adb.mjs');
  await phone.cleanupPhone(m, log).catch(error => log(`폰 정리 실패: ${error.message}`));
  if (m.ready && alive(m.pids?.owner)) { await control('/stop').catch(() => {}); await until(() => !alive(m.pids.owner), 15000, 300).catch(() => {}); }
  stopRecorded(readManifest(), log);
  writeManifest({ ready: false, stoppedAt: Date.now(), phone: null });
  log(`정리 끝. 세션 폴더(${dir})는 남겨 둡니다. 지우려면 폴더를 직접 지우세요.`);
}

const commands = { up, owner, link, status, down };
const later = ['apk', 'login', 'pair', 'open', 'scenarios', 'shot', 'all', 'describe', 'help'];
if (commands[cmd]) await commands[cmd]();
else if (later.includes(cmd)) await (await import('./phone-steps.mjs')).run(cmd, { argv, where, up, link, down, control });
else { console.log('명령: up | link | apk | login | pair | open | scenarios | all | shot | status | down'); process.exitCode = 2; }
if (cmd !== 'owner') { await sleep(50); process.exit(process.exitCode ?? 0); }
