// The phone half of t-phone-e2e.mjs: build/install the debug app, sign in, pair, open the PC, scenarios. See that file for usage.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adeClient, dir, hubApprove, log, needRig, readManifest, shotsDir, sleep, until, writeManifest } from './phone-rig.mjs';
import { adbTool, attach, findPage, listPages, PKG, USER_PKG, webviewPort } from './phone-adb.mjs';

// The PC's UI is served on a per-PC subdomain of ade.remote (https://h<hash>.ade.remote/).
const REMOTE_URL = /^https:\/\/([\w-]+\.)?ade\.remote\//;
export const isRemote = target => REMOTE_URL.test(target.url);
export const isMain = target => !isRemote(target) && /appassets|localhost|127\.0\.0\.1/.test(target.url);

// ---- apk: build and install the debug app pointed at the local Hub ------------------------------------------------------------------------------
async function apk({ argv, where }) {
  const m = needRig(), adb = adbTool(), webapps = where.webapps(), gradleDir = join(webapps, 'apps/ade/android');
  if (!existsSync(join(gradleDir, 'gradlew.bat'))) throw new Error(`mooner-webapps checkout을 찾지 못했습니다(${webapps}). --webapps <경로>`);
  const apkFile = join(gradleDir, 'app/build/outputs/apk/debug/app-debug.apk'), marker = join(dir, 'apk.json');
  const built = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null;
  const need = argv.includes('--rebuild') || !existsSync(apkFile) || built?.hubUrl !== m.hubUrl || built?.webapps !== webapps;
  if (need && !argv.includes('--no-build')) {
    // The web UI of the app is reused when its dist exists (a plain -PskipWebUi build); --web builds it first.
    const skipWeb = existsSync(join(webapps, 'apps/ade/web/dist/index.html')) && !argv.includes('--web');
    const args = [...(skipWeb ? ['-PskipWebUi'] : []), '--offline', 'assembleDebug', `-PhubUrl=${m.hubUrl}`];
    const logFile = join(dir, 'gradle.log');
    log(`APK 빌드: gradlew ${args.join(' ')}  (로그: ${logFile})`);
    const code = await new Promise(res => {
      const child = spawn(join(gradleDir, 'gradlew.bat'), args, { cwd: gradleDir, shell: true, windowsHide: true, env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? 'C:\\Program Files\\Java\\jdk-21', ANDROID_HOME: process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') } });
      let text = ''; child.stdout.on('data', c => { text += c; }); child.stderr.on('data', c => { text += c; });
      child.on('exit', c => { writeFileSync(logFile, text); res(c); });
    });
    if (code !== 0) throw new Error(`gradle 실패(코드 ${code}), 로그: ${logFile}`);
    writeFileSync(marker, JSON.stringify({ hubUrl: m.hubUrl, webapps, builtAt: Date.now() }));
  } else log(`APK 재사용(Hub 주소 ${m.hubUrl} 같음): ${apkFile}`);
  log(`설치 ${PKG}: ${adb.install(apkFile).trim().split('\n').pop()}`);
  writeManifest({ phone: { ...readManifest().phone, serial: adb.serial, pkg: PKG } });
}

// ---- phone plumbing: adb reverse, the app, its WebView pages ---------------------------------------------------------------------------------
function ensureReverse(m, adb) {
  const port = m.relayPort, phone = readManifest().phone ?? {};
  if (!new RegExp(`tcp:${port}\\s+tcp:${port}`).test(adb.reverseList())) {
    adb.reverse(port);
    writeManifest({ phone: { ...phone, serial: adb.serial, pkg: PKG, reverses: [...new Set([...(phone.reverses ?? []), port])] } });
    log(`adb reverse tcp:${port} 추가`);
  }
}
const mainPage = (adb, ms) => findPage(adb, isMain, ms);
const remotePage = (adb, ms) => findPage(adb, isRemote, ms);

// A compact view of what is on a page: visible buttons/links/inputs and the text, to drive and to debug.
export const describe = page => page.ev(`
  const vis = e => e.getClientRects().length > 0, label = e => (e.getAttribute('aria-label') || e.textContent || e.value || e.placeholder || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
  return { url: location.href, title: document.title,
    controls: [...document.querySelectorAll('button, [role=button], a[href], [role=tab], input, textarea, select')].filter(vis).map(e => (e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '') + ': ' + label(e))).slice(0, 80),
    text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 700) };`);

const signedIn = page => page.ev(`return [...document.querySelectorAll('nav.bottom-nav button')].some(b => b.textContent.trim() === 'PC')`);
const tabTo = async (page, label) => { await page.tap('nav.bottom-nav button', label); await sleep(500); };

// Signs the phone in: the app's own "계정으로 로그인" in Settings, then what a user does in the browser (the Hub's dev-login form) over plain HTTP.
async function login() {
  const m = needRig(), adb = adbTool();
  ensureReverse(m, adb);
  adb.start();
  const page = await mainPage(adb, 40000);
  await page.waitFor('document.querySelector("#root")?.children.length > 0', 30000);
  if (await signedIn(page)) { log('폰은 이미 로그인되어 있습니다.'); return page.close(); }
  await tabTo(page, '설정');
  if (!await page.ev('return Boolean(document.querySelector(".user-code"))')) await page.tap('button.btn', '계정으로 로그인');
  const code = await page.waitFor('document.querySelector(".user-code")?.textContent', 20000, '기기 코드');
  log(`폰에 보이는 기기 코드: ${code}`);
  adb.screencap('login-1-phone-shows-code'); // usually the browser is already in front, it is the evidence either way
  await hubApprove(m.hubUrl, { verifyUrl: `${m.hubUrl}/enroll?code=${code}`, userCode: code, name: 'e2e' });
  log('Hub에서 승인(dev-login 폼, 일반 HTTP)');
  adb.start(); // back to the app: the browser stays behind it
  await page.waitFor(`[...document.querySelectorAll('nav.bottom-nav button')].some(b => b.textContent.trim() === 'PC')`, 60000, '로그인 완료(PC 탭)');
  log('폰 로그인 완료(PC 탭이 열렸습니다).');
  page.close();
}

// Pairing, the way a user does it with the link of the PC's plugin: the pairing link goes to the app as a deep link (what scanning the QR does),
// the app's sheet is confirmed on the phone, the confirmation window of the plugin on the PC is accepted by this script.
async function pair({ argv }) {
  const m = needRig(), adb = adbTool(), ade = adeClient(m), plugins = ade.plugins;
  ensureReverse(m, adb);
  const control = !argv.includes('--view');
  if ((await plugins.view()).lists?.[0]?.items?.length) { log('PC 쪽에 이미 페어링된 기기가 있습니다. 다시 하려면 down 뒤 up.'); return; }
  if (!await plugins.info('pairing')) await ade.api('verify/plugins/action', { args: [m.plugin.id, control ? 'pair-control' : 'pair-view', {}] });
  const uri = await until(() => plugins.info('pairing'), 10000, 200), hostPrint = await plugins.info('hostKey');
  log(`페어링 링크: ${uri.replace(/&t=[^&]+/, '&t=…')}  (PC 키 지문 ${hostPrint})`);
  adb.start();
  const page = await mainPage(adb, 30000);
  await page.waitFor('document.querySelector("#root")?.children.length > 0', 30000);
  adb.view(uri);
  await page.waitFor('document.body.innerText.includes("PC 페어링")', 20000, '페어링 시트');
  const shown = await page.ev('return [...document.querySelectorAll(".fingerprint")].map(e => e.textContent.replace(/\s+/g, ""))');
  log(`앱이 보여 준 지문(PC 키, 폰 키): ${shown.join(', ')}`);
  if (shown[0] && hostPrint && shown[0].replace(/[^0-9a-f]/gi, '').toLowerCase() !== hostPrint.replace(/[^0-9a-f]/gi, '').toLowerCase()) log('  주의: 앱의 PC 키 지문이 플러그인의 것과 다릅니다');
  adb.screencap('pair-1-offer');
  await page.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.includes("페어링 요청") && !b.disabled)', 10000, '페어링 요청 버튼');
  let paired = false;
  const accept = plugins.accept(() => true, () => paired, 60000);
  await page.tap('button', '페어링 요청');
  await until(async () => { paired = Boolean((await plugins.view()).lists?.[0]?.items?.length); return paired; }, 60000, 400);
  const dialogs = await accept;
  log(`PC에서 승인한 확인 창: ${dialogs.join(' | ')}`);
  await page.waitFor('document.body.innerText.includes("페어링했습니다")', 30000, '페어링 완료 표시');
  adb.screencap('pair-2-done');
  await page.tap('button', '확인');
  log(`페어링 완료: ${JSON.stringify((await plugins.view()).lists[0].items.map(i => [i.label, i.detail]))}`);
  page.close();
}

// Opens the paired PC from the app's PC list (the card), which connects through the Hub and the plugin and starts RemoteUiActivity with the PC's own UI.
export async function open({ argv } = { argv: [] }) {
  const m = needRig(), adb = adbTool();
  ensureReverse(m, adb);
  adb.start();
  const page = await mainPage(adb, 30000);
  await page.waitFor('document.querySelector("#root")?.children.length > 0', 30000);
  if (adb.focusedPackage() === PKG && !(await listPages(webviewPort(adb))).some(isRemote)) {
    await tabTo(page, 'PC');
    await page.waitFor('document.querySelector(".card-main")', 20000, 'PC 카드');
    const name = (await page.ev('return document.querySelector(".card-name")?.textContent')) ?? '';
    log(`PC 카드: ${name} → 탭`);
    await page.tap('button.card-main');
    page.close();
  } else page.close();
  const remote = await findPage(adb, isRemote, 90000);
  await remote.waitFor('document.documentElement.dataset.remote', 30000, 'data-remote');
  await remote.waitFor('document.querySelector(".shell, .welcome, .projects, main, #root > *")', 60000, 'PC 화면');
  log(`RemoteUiActivity: ${remote.url} remote=${await remote.ev('return document.documentElement.dataset.remote + "/" + document.documentElement.dataset.remoteClient')}`);
  return remote;
}

async function debugPage({ argv }) {
  const adb = adbTool(), which = argv.includes('--remote') ? isRemote : argv.includes('--any') ? () => true : isMain;
  const page = await findPage(adb, which, 8000);
  const i = argv.indexOf('--eval');
  if (i >= 0) console.log(JSON.stringify(await page.ev(argv[i + 1]), null, 1));
  else console.log(JSON.stringify(await describe(page), null, 1));
  page.close();
}

export async function run(cmd, ctx) {
  const table = { apk, login, pair, open: async ctx => { const r = await open(ctx); r.close(); }, describe: debugPage };
  if (!table[cmd]) throw new Error(`아직 없는 명령: ${cmd}`);
  await table[cmd](ctx);
}
