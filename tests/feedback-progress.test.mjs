import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { compareVersions, createFeedbackProgress, settle, signature, viewOf } from '../apps/local-server/src/feedback-progress.js';
import { createFeedbackStore } from '../apps/local-server/src/feedback-store.js';
import { fetchAnonymousStatus } from '../apps/local-server/src/feedback-hub.js';
import { progressAnnouncer, progressBadge, progressInApp, progressNews, progressNewsText } from '../apps/web/src/feedback-model.ts';

// ---- versions and states -------------------------------------------------------------------------------------------------
test('versions compare like semver, with "beta10" after "beta5" and a release after its betas', () => {
  const order = ['0.5.7', '0.6.0-beta1', '0.6.0-beta5', '0.6.0-beta10', '0.6.0', '0.6.1-beta1', '0.6.1', '1.0.0'];
  for (let i = 0; i < order.length; i++) for (let j = 0; j < order.length; j++) assert.equal(compareVersions(order[i], order[j]), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
  assert.equal(compareVersions('v0.6.0', '0.6.0'), 0);
  assert.equal(compareVersions('abc', '0.6.0'), null);
  assert.equal(compareVersions(undefined, '0.6.0'), null);
});

test('settle: a beta fix becomes "released" once a stable release (the Hub\'s or this app\'s own) has taken it in; bad states are dropped', () => {
  assert.deepEqual(settle({ state: 'beta', version: '0.6.0-beta5' }, {}), { state: 'beta', version: '0.6.0-beta5' });
  assert.deepEqual(settle({ state: 'beta', version: '0.6.0-beta5' }, { latestStable: '0.5.7' }), { state: 'beta', version: '0.6.0-beta5' });
  assert.equal(settle({ state: 'beta', version: '0.6.0-beta5' }, { latestStable: '0.6.0' }).state, 'released');
  assert.equal(settle({ state: 'beta', version: '0.6.0-beta5' }, { appVersion: '0.6.1' }).state, 'released');
  assert.equal(settle({ state: 'beta', version: '0.6.0-beta5' }, { appVersion: '0.6.0-beta9' }).state, 'beta');
  assert.deepEqual(settle({ state: 'released', version: '0.6.0' }, {}), { state: 'released', version: '0.6.0' });
  assert.deepEqual(settle({ state: 'closed', version: 'nonsense' }, {}), { state: 'closed' });
  assert.equal(settle({ state: 'shipped' }, {}), null);
  assert.equal(settle(null, {}), null);
});

test('viewOf: news until the stored change is seen, and whether this app already has the fix', () => {
  const track = { state: 'beta', version: '0.6.0-beta5', sig: 'beta:0.6.0-beta5', checkedAt: 5, changedAt: 4 };
  assert.deepEqual(viewOf(track, '0.6.0-beta5'), { state: 'beta', version: '0.6.0-beta5', inApp: true, news: true, checkedAt: 5, changedAt: 4 });
  assert.equal(viewOf(track, '0.5.7').inApp, false);
  assert.equal(viewOf(track, '0.6.0').inApp, true);
  assert.equal(viewOf({ ...track, seenSig: track.sig }, '0.5.7').news, false);
  assert.equal(viewOf({ state: 'pending', sig: 'pending:' }, '0.5.7').news, false);
  assert.equal(viewOf({ state: 'closed', sig: 'closed:' }, '0.5.7').inApp, undefined);
  assert.equal(viewOf(undefined, '1.0.0'), null);
  assert.equal(viewOf({ state: 'weird' }, '1.0.0'), null);
});

// ---- the poller, against a store and a stand-in for the Hub --------------------------------------------------------------------
async function submitted(t, count = 1, via = 'anonymous') {
  const root = await mkdtemp(join(tmpdir(), 'ade-progress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFeedbackStore({ root }), ids = [];
  for (let i = 0; i < count; i++) {
    const item = await store.create({ title: `t${i}`, body: 'b' });
    await store.setStatus(item.id, 'submitted', { issueNumber: 10 + i, via });
    ids.push(item.id);
  }
  return { store, ids };
}
const quiet = { warn() {}, debug() {} };

test('the poller stores what the Hub says, only writes on a change, and reads a first "pending" as nothing new', async t => {
  const { store, ids } = await submitted(t, 2);
  let clock = 1000, answers = [], calls = [];
  const progress = createFeedbackProgress({ store, appVersion: '0.5.7', now: () => clock, setTimer: () => null, clearTimer() {}, log: quiet,
    fetchers: { anonymous: async keys => { calls.push(keys); return answers.shift(); } } });
  answers.push({ ok: true, items: { [ids[0]]: { state: 'pending' } } });
  await progress.poll();
  assert.deepEqual(calls[0].sort(), [...ids].sort());
  let [first, second] = await Promise.all(ids.map(id => store.get(id)));
  assert.equal(first.track.state, 'pending'); assert.equal(first.track.seenSig, first.track.sig);
  assert.equal(second.track, undefined); // the Hub knew nothing of it: left as it was
  assert.equal(viewOf(first.track, '0.5.7').news, false);

  clock += 1; const written = (await store.get(ids[0])).updatedAt;
  answers.push({ ok: true, items: { [ids[0]]: { state: 'pending' } } });
  await progress.poll();
  assert.equal((await store.get(ids[0])).track.checkedAt, first.track.checkedAt); // unchanged: not rewritten
  assert.equal((await store.get(ids[0])).updatedAt, written);

  clock += 1;
  answers.push({ ok: true, items: { [ids[0]]: { state: 'beta', version: '0.6.0-beta5' }, [ids[1]]: { state: 'closed' } } });
  await progress.poll();
  [first, second] = await Promise.all(ids.map(id => store.get(id)));
  assert.equal(first.status, 'submitted');
  assert.deepEqual([first.track.state, first.track.version], ['beta', '0.6.0-beta5']);
  assert.equal(viewOf(first.track, '0.5.7').news, true);
  assert.equal(viewOf(first.track, '0.5.7').inApp, false);
  assert.equal(viewOf(second.track, '0.5.7').news, true); // first sight of anything but pending is news
  await store.markSeen(ids[0]);
  assert.equal(viewOf((await store.get(ids[0])).track, '0.5.7').news, false);

  // beta → released is a new change: news again; and a released item is not asked about any more
  clock += 1;
  answers.push({ ok: true, items: { [ids[0]]: { state: 'released', version: '0.6.0-beta5' } }, latestStable: '0.6.0' });
  await progress.poll();
  assert.equal(viewOf((await store.get(ids[0])).track, '0.5.7').news, true);
  calls = []; answers.push({ ok: true, items: {} });
  await progress.poll();
  assert.deepEqual(calls[0], [ids[1]]);
});

test('the poller stays quiet on trouble: backoff on errors, a day\'s pause when the Hub has no endpoint, account items wait for a plugin that can answer', async t => {
  const { store, ids } = await submitted(t);
  let clock = 1000, calls = 0, answer = { ok: false, error: { code: 'network_error' } };
  const progress = createFeedbackProgress({ store, appVersion: '0.5.7', now: () => clock, setTimer: () => null, clearTimer() {}, intervalMs: 1000, log: quiet,
    fetchers: { anonymous: async () => { calls += 1; return answer; } } });
  await progress.poll(); assert.equal(calls, 1);
  await progress.poll(); assert.equal(calls, 1); // inside the backoff
  clock += 1500; await progress.poll(); assert.equal(calls, 2);
  clock += 1500; await progress.poll(); assert.equal(calls, 2); // 2nd failure: longer wait
  assert.equal((await store.get(ids[0])).track, undefined);
  answer = { ok: false, error: { code: 'unsupported' } };
  clock += 10_000; await progress.poll(); assert.equal(calls, 3);
  assert.equal(progress.info().unsupported, true);
  clock += 3_600_000; await progress.poll(); assert.equal(calls, 3); // paused for a day
  answer = { ok: true, items: { [ids[0]]: { state: 'pending' } } };
  assert.deepEqual(await progress.refresh(), { skipped: false }); assert.equal(calls, 4); // "지금 확인" lifts the pause
  assert.equal((await store.get(ids[0])).track.state, 'pending');
  assert.deepEqual(await progress.refresh(), { skipped: true }); // not twice within 20 s

  const accountSide = await submitted(t, 1, 'account');
  let asked = 0, plugin = false;
  const forAccount = createFeedbackProgress({ store: accountSide.store, appVersion: '0.5.7', now: () => clock, setTimer: () => null, clearTimer() {}, log: quiet,
    canAsk: () => ({ anonymous: true, account: plugin }), fetchers: { anonymous: async () => { throw new Error('account items never go this way'); }, account: async () => { asked += 1; return { ok: true, items: { [accountSide.ids[0]]: { state: 'beta', version: '0.6.0-beta5' } } }; } } });
  await forAccount.poll(); assert.equal(asked, 0);
  plugin = true; await forAccount.poll();
  assert.equal(asked, 1); assert.equal((await accountSide.store.get(accountSide.ids[0])).track.state, 'beta');
});

test('a thrown fetcher is treated as a network error, and a deleted item does not break the round', async t => {
  const { store, ids } = await submitted(t, 2);
  const progress = createFeedbackProgress({ store, appVersion: '0.5.7', now: () => 1, setTimer: () => null, clearTimer() {}, log: quiet,
    fetchers: { anonymous: async keys => { await store.remove(ids[0]); return { ok: true, items: Object.fromEntries(keys.map(key => [key, { state: 'pending' }])) }; } } });
  await progress.poll();
  assert.equal((await store.get(ids[1])).track.state, 'pending');
});

test('fetchAnonymousStatus sends the install id and only keys, and maps a missing endpoint to "unsupported"', async t => {
  const seen = [], answers = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, device: request.headers['x-ade-device'], method: request.method });
    const answer = answers.shift() ?? { status: 200, body: { items: { abcdefgh: { state: 'beta', version: '0.6.0-beta5' } }, latestStable: '0.5.7' } };
    response.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers }); response.end(JSON.stringify(answer.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const hubUrl = `http://127.0.0.1:${server.address().port}`;
  const ok = await fetchAnonymousStatus({ hubUrl, deviceId: 'D'.repeat(32), keys: ['abcdefgh', 'k2k2k2k2'] });
  assert.deepEqual(ok, { ok: true, items: { abcdefgh: { state: 'beta', version: '0.6.0-beta5' } }, latestStable: '0.5.7' });
  assert.equal(seen[0].method, 'GET'); assert.equal(seen[0].url, '/v1/feedback/status?keys=abcdefgh%2Ck2k2k2k2'); assert.equal(seen[0].device, 'D'.repeat(32));
  answers.push({ status: 404, body: { error: { code: 'not_found' } } });
  assert.equal((await fetchAnonymousStatus({ hubUrl, deviceId: 'D'.repeat(32), keys: ['abcdefgh'] })).error.code, 'unsupported');
  answers.push({ status: 429, headers: { 'retry-after': '90' }, body: { error: { code: 'rate_limited' } } });
  assert.deepEqual((await fetchAnonymousStatus({ hubUrl, deviceId: 'D'.repeat(32), keys: ['abcdefgh'] })).error, { code: 'rate_limited', message: 'Hub 응답 429', retryAfter: 90 });
  answers.push({ status: 200, body: 'not an object' });
  assert.equal((await fetchAnonymousStatus({ hubUrl, deviceId: 'D'.repeat(32), keys: ['abcdefgh'] })).ok, false);
  assert.equal((await fetchAnonymousStatus({ hubUrl: 'http://127.0.0.1:9', deviceId: 'D'.repeat(32), keys: ['abcdefgh'] })).error.code, 'network_error');
});

// ---- what the panel shows ------------------------------------------------------------------------------------------------------
test('badges, the in-this-version sentence and the news toast read as the issue asks', () => {
  assert.equal(progressBadge(undefined), null);
  assert.deepEqual(progressBadge({ state: 'pending', news: false }), { text: '대기', tone: 'wait' });
  assert.deepEqual(progressBadge({ state: 'beta', version: '0.6.0-beta5', news: true }), { text: 'beta 반영 v0.6.0-beta5', tone: 'beta' });
  assert.deepEqual(progressBadge({ state: 'released', version: '0.6.0', news: true }), { text: '릴리스 반영 v0.6.0', tone: 'done' });
  // 처리됨(closed)과 반영하지 않음(declined)은 같은 회색이 아니다.
  assert.deepEqual(progressBadge({ state: 'closed', news: false }), { text: '처리됨', tone: 'muted' });
  assert.deepEqual(progressBadge({ state: 'declined', news: false }), { text: '반영하지 않음', tone: 'declined' });
  assert.equal(progressBadge({ state: 'released', version: '0.6.0-beta5', news: true }).text, '릴리스 반영 (v0.6.0-beta5부터)');
  assert.equal(progressBadge({ state: 'closed', news: false }).text, '처리됨');
  assert.match(progressInApp({ state: 'beta', version: '0.6.0-beta5', inApp: true, news: false }), /이미 반영/);
  assert.match(progressInApp({ state: 'beta', version: '0.6.0-beta5', inApp: false, news: false }), /v0\.6\.0-beta5 이상으로 업데이트/);
  assert.equal(progressInApp({ state: 'pending', news: false }), '');
  assert.equal(progressInApp({ state: 'closed', news: false }), '');
  const a = { id: 'a', status: 'submitted', issueNumber: 18, progress: { state: 'beta', version: '0.6.0-beta5', news: true } };
  const b = { id: 'b', status: 'submitted', issueNumber: 22, progress: { state: 'pending', news: false } };
  assert.deepEqual(progressNews([a, b]), [a]);
  assert.equal(progressNewsText([a]), '피드백 #18: beta 반영 v0.6.0-beta5');
  assert.equal(progressNewsText([a, { ...a, id: 'c' }]), '제출한 피드백 2건의 처리 상태가 바뀌었어요');
  assert.equal(progressNewsText([]), '');
});

test('the news toast is told once per change, again for a later change, never for what was opened', () => {
  const announce = progressAnnouncer();
  const item = (state, version, news = true) => ({ id: 'a', status: 'submitted', issueNumber: 18, progress: { state, version, news } });
  assert.match(announce([item('beta', '0.6.0-beta5')]), /beta 반영/);
  assert.equal(announce([item('beta', '0.6.0-beta5')]), ''); // the list loads again: not told again
  assert.equal(announce([item('beta', '0.6.0-beta5', false)]), ''); // opened
  assert.match(announce([item('released', '0.6.0')]), /릴리스 반영/);
  assert.equal(announce([{ id: 'p', status: 'submitted', progress: { state: 'pending', news: false } }]), '');
  assert.equal(announce([{ id: 'x', status: 'draft' }]), '');
});

// ---- the server end to end: the real server against a stand-in Hub --------------------------------------------------------------
async function fakeHub(t) {
  const requests = [], statuses = [], state = { status: null };
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    if (request.url.startsWith('/v1/feedback/status')) {
      requests.push({ url: request.url, device: request.headers['x-ade-device'] });
      const answer = state.status?.() ?? { status: 404, body: { error: { code: 'not_found' } } };
      statuses.push(answer.status);
      response.writeHead(answer.status, { 'content-type': 'application/json' }); response.end(JSON.stringify(answer.body)); return;
    }
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'h', issueNumber: 18, issueUrl: 'https://github.com/o/r/issues/18' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, statuses, state };
}
async function boot(t, env = {}) {
  const data = await mkdtemp(join(tmpdir(), 'ade-data-'));
  const gitConfig = join(data, 'gitconfig');
  await writeFile(gitConfig, '[user]\nname = T\nemail = t@example.com\n');
  const child = spawn(process.execPath, ['apps/local-server/src/index.js'], { env: { ...process.env, GH_CONFIG_DIR: join(data, 'gh'), GH_TOKEN: '', GITHUB_TOKEN: '', GIT_CONFIG_GLOBAL: gitConfig, ADE_PORT: '0', ADE_DATA_DIR: data, ADE_PTY_ENDPOINT: '', ADE_PTY_TOKEN: '', ADE_HUB_URL: 'http://127.0.0.1:9', ADE_FEEDBACK_STATUS_FIRST_MS: '200', ADE_FEEDBACK_STATUS_MS: '400', ...env }, stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  const messages = [];
  child.on('message', message => messages.push(message));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; }
    await rm(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', () => reject(new Error('server exited'))); });
  const until = async (predicate, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const index = messages.findIndex(predicate); if (index >= 0) return messages.splice(index, 1)[0]; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('timeout');
  };
  let ids = 0;
  child.send({ type: 'plugin/workspace', plugin: 'example', op: 'open', session: 's' });
  const api = async (action, input = {}) => {
    const id = ++ids;
    child.send({ type: 'plugin/workspace', plugin: 'example', op: 'api', session: 's', id, action, input });
    const reply = await until(message => message.type === 'plugin/workspace' && message.op === 'api-result' && message.id === id);
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.value;
  };
  const eventually = async (action, input, predicate, tries = 300) => {
    for (let i = 0; i < tries; i++) { const value = await api(action, input); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`timeout waiting on ${action}`);
  };
  return { child, until, api, eventually };
}
const submitAnonymously = async (api, eventually) => {
  const item = await api('feedback/create', { title: '상태바 글자가 겹침', body: '겹칩니다' });
  await api('feedback/submit', { id: item.id });
  await eventually('feedback/get', { id: item.id }, value => value.status === 'submitted');
  return item;
};

test('server: an anonymous submission is followed on the Hub, news shows until it is opened, and a missing endpoint changes nothing', async t => {
  const hub = await fakeHub(t), { api, eventually } = await boot(t, { ADE_HUB_URL: hub.url });
  const item = await submitAnonymously(api, eventually);
  // The Hub has no status endpoint yet (404): the item just stays "제출됨", no progress, nothing broken.
  await eventually('feedback/list', {}, value => hub.requests.length > 0 && value.progress.unsupported === true);
  let listed = await api('feedback/list');
  assert.equal(listed.items[0].status, 'submitted'); assert.equal(listed.items[0].progress, undefined);
  assert.match(hub.requests[0].url, new RegExp(`^/v1/feedback/status\\?keys=${item.id}$`));
  assert.ok(hub.requests[0].device.length >= 16);

  // The endpoint appears; "지금 확인" asks again right away: pending first (nothing to read), then beta (news)
  hub.state.status = () => ({ status: 200, body: { items: { [item.id]: { state: 'pending', issueNumber: 18 } }, latestStable: '0.5.7' } });
  await api('feedback/refresh');
  listed = await eventually('feedback/list', {}, value => value.items[0].progress);
  assert.deepEqual([listed.items[0].progress.state, listed.items[0].progress.news], ['pending', false]);
  hub.state.status = () => ({ status: 200, body: { items: { [item.id]: { state: 'beta', version: '0.6.0-beta5' } }, latestStable: '0.5.7' } });
  listed = await eventually('feedback/list', {}, value => value.items[0].progress?.state === 'beta', 600);
  const progress = listed.items[0].progress;
  assert.equal(progress.news, true); assert.equal(progress.version, '0.6.0-beta5'); assert.equal(typeof progress.inApp, 'boolean');
  // Opening it reads the news; the later release is news again.
  assert.equal((await api('feedback/seen', { id: item.id })).progress.news, false);
  assert.equal((await api('feedback/list')).items[0].progress.news, false);
  assert.equal((await api('feedback/get', { id: item.id })).status, 'submitted');
});

test('server: an account\'s feedback is followed through the plugin that said it can look it up', async t => {
  const { child, until, api, eventually } = await boot(t, { ADE_FEEDBACK_ANONYMOUS: '0' });
  child.send({ type: 'feedback/status', status: { ok: true, account: 'tester', plugin: 'remote', statusQuery: true } });
  await eventually('feedback/status', {}, value => value.mode === 'account');
  const item = await api('feedback/create', { title: '제목', body: '본문' });
  await api('feedback/submit', { id: item.id });
  const request = await until(message => message.type === 'feedback/submit');
  child.send({ type: 'feedback/result', id: request.id, ok: true, issueUrl: 'https://github.com/o/r/issues/7', issueNumber: 7 });
  await eventually('feedback/get', { id: item.id }, value => value.status === 'submitted');
  const query = await until(message => message.type === 'feedback/status-query', 25000);
  assert.deepEqual(query.keys, [item.id]);
  child.send({ type: 'feedback/status-result', id: query.id, ok: true, items: { [item.id]: { state: 'released', version: '0.6.0' } } });
  const listed = await eventually('feedback/list', {}, value => value.items[0].progress);
  assert.deepEqual([listed.items[0].progress.state, listed.items[0].progress.version, listed.items[0].progress.news], ['released', '0.6.0', true]);
});

test('server: a plugin that cannot look feedback up is never asked', async t => {
  const { child, until, api, eventually } = await boot(t, { ADE_FEEDBACK_ANONYMOUS: '0' });
  child.send({ type: 'feedback/status', status: { ok: true, account: 'tester', plugin: 'remote' } });
  await eventually('feedback/status', {}, value => value.mode === 'account');
  const item = await api('feedback/create', { title: '제목', body: '본문' });
  await api('feedback/submit', { id: item.id });
  const request = await until(message => message.type === 'feedback/submit');
  child.send({ type: 'feedback/result', id: request.id, ok: true, issueUrl: 'https://github.com/o/r/issues/7', issueNumber: 7 });
  await eventually('feedback/get', { id: item.id }, value => value.status === 'submitted');
  await assert.rejects(until(message => message.type === 'feedback/status-query', 2500), /timeout/);
  assert.equal((await api('feedback/list')).items[0].progress, undefined);
});
