import test from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_LEAD, idleCompactDue, idleCompactOn, idleCompactSkip, minTokens } from '../apps/local-server/src/chat-idle-compact.js';
import { IDLE_LEAD as cacheLead } from '../apps/local-server/src/claude-cache.js';
import { autoCompactDisabled } from '../apps/local-server/src/claude-auto-compact.js';
import { validateAppState } from '../apps/local-server/src/ui-state.js';
import { compactLabel, fromReplay, idleCompactNote } from '../apps/web/src/chat-model.ts';
import { cacheReadShare } from '../apps/web/src/cache-read-share.ts';

const cache = { at: 1_000_000, ttl: 3600, tokens: 250_000, model: 'claude-opus-5-5' };
const base = { on: true, minK: 200, cache, lead: IDLE_LEAD };

test('the lead is the one the terminal timer uses', () => assert.equal(IDLE_LEAD, cacheLead));

test('the per-chat choice wins over the global setting; unset follows it', () => {
  assert.equal(idleCompactOn(undefined, { enabled: true }), true);
  assert.equal(idleCompactOn(undefined, { enabled: false }), false);
  assert.equal(idleCompactOn(undefined, null), false);
  assert.equal(idleCompactOn(false, { enabled: true }), false);
  assert.equal(idleCompactOn(true, { enabled: false }), true);
});

test('the threshold is in K tokens, never below 100K', () => {
  assert.equal(minTokens(200), 200_000);
  assert.equal(minTokens(100), 100_000);
  assert.equal(minTokens(50), 200_000, 'an out-of-range value falls back to the default');
  assert.equal(minTokens(undefined), 200_000);
});

test('the compact is due at lead x TTL of the window, only for a big 1h cache not yet compacted', () => {
  assert.equal(idleCompactDue(base), cache.at + 3600 * 1000 * 0.9);
  assert.equal(idleCompactDue({ ...base, lead: 0.5 }), cache.at + 1_800_000);
  assert.equal(idleCompactDue({ ...base, on: false }), undefined);
  assert.equal(idleCompactDue({ ...base, cache: { ...cache, ttl: 300 } }), undefined, '5-minute caches are left alone');
  assert.equal(idleCompactDue({ ...base, cache: { ...cache, tokens: 199_999 } }), undefined);
  assert.equal(idleCompactDue({ ...base, minK: 100, cache: { ...cache, tokens: 150_000 } }), cache.at + 3_240_000);
  assert.equal(idleCompactDue({ ...base, cache: { ...cache, compacted: { at: 1, trigger: 'auto' } } }), undefined);
  assert.equal(idleCompactDue({ ...base, cache: null }), undefined);
});

test('at fire time every condition is looked at again, and a window gets one chance', () => {
  const now = cache.at + 3_240_000, ask = extra => idleCompactSkip({ ...base, now, ...extra });
  assert.equal(ask({}), null);
  assert.equal(ask({ busy: 'busy' }), 'busy');
  assert.equal(ask({ tried: cache.at }), 'tried');
  assert.equal(ask({ tried: cache.at - 1 }), null, 'another window\'s chance does not count');
  assert.equal(ask({ now: cache.at + 3_600_000 }), 'expired');
  assert.equal(ask({ now: cache.at + 3_700_000 }), 'expired');
  assert.equal(ask({ on: false }), 'not-due');
  assert.equal(ask({ cache: { ...cache, ttl: 300 } }), 'not-due');
  assert.equal(ask({ cache: { ...cache, tokens: 10 } }), 'not-due');
  assert.equal(ask({ cache: { ...cache, compacted: { at: 1, trigger: 'manual' } } }), 'not-due');
});

test('the CLI auto compact switches turn it off', () => {
  assert.equal(autoCompactDisabled({ autoCompactEnabled: false }, {}), true);
  assert.equal(autoCompactDisabled({}, { DISABLE_AUTO_COMPACT: '1' }), true);
  assert.equal(autoCompactDisabled({}, { DISABLE_AUTO_COMPACT: 'true' }), true);
  assert.equal(autoCompactDisabled({ autoCompactEnabled: true }, { DISABLE_AUTO_COMPACT: '0' }), false);
});

test('the settings are validated: the switch is a boolean, the threshold 100-1000K', () => {
  const state = settings => ({ openProjects: [], activeProjectId: '', settings });
  assert.doesNotThrow(() => validateAppState(state({ idleCompact: true, idleCompactMinK: 100 })));
  assert.doesNotThrow(() => validateAppState(state({ idleCompactMinK: 1000 })));
  for (const bad of [{ idleCompact: 'yes' }, { idleCompactMinK: 99 }, { idleCompactMinK: 1001 }, { idleCompactMinK: 200.5 }, { idleCompactMinK: '200' }]) assert.throws(() => validateAppState(state(bad)), undefined, JSON.stringify(bad));
});

test('the thread folds an idle compact into its own divider and keeps it on replay', () => {
  const events = [{ seq: 1, kind: 'user', text: '/compact' }, { seq: 2, kind: 'compact', trigger: 'idle', preTokens: 250000, postTokens: 12000 }, { seq: 3, kind: 'compact', trigger: 'auto', preTokens: 1, postTokens: 1 }, { seq: 4, kind: 'compact', trigger: 'manual', preTokens: 1, postTokens: 1 }];
  const items = fromReplay({ events, seq: 4, state: {}, approvals: [] }, 0).items.filter(item => item.kind === 'compact');
  assert.deepEqual(items.map(item => item.trigger), ['idle', 'auto', 'manual']);
  assert.deepEqual(items.map(item => compactLabel(item.trigger)), ['캐시 만료 전 자동 압축', '자동 압축', '컨텍스트 압축']);
});

test('/idlecompact tells where the choice comes from', () => {
  assert.match(idleCompactNote({ chat: null, on: false }, 200), /꺼짐 \(앱 설정을 따름\).*200K/);
  assert.match(idleCompactNote({ chat: true, on: true }, 150), /켜짐 \(이 채팅 설정\).*150K/);
  assert.match(idleCompactNote(undefined, 200), /꺼짐/);
});

test('cache reads cost 0.025x for Fable/Mythos 5.1-5.2, 0.05x for Opus/Sonnet 5.5, 0.1x for the rest (Anthropic pricing, 2026-11)', () => {
  for (const model of ['claude-fable-5-1', 'claude-fable-5-2', 'claude-mythos-5-1', 'claude-mythos-5-2', 'claude-fable-5-2[1m]']) assert.equal(cacheReadShare(model), 0.025, model);
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]']) assert.equal(cacheReadShare(model), 0.05, model);
  for (const model of ['claude-fable-5', 'claude-mythos-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-5-5', 'claude-haiku-4-5', 'claude-fable-5-10', '']) assert.equal(cacheReadShare(model), 0.1, model);
});
