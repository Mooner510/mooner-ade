import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { parseCursorGrokUsage, parseCursorUsage, parseCursorUsageFallback, cursorSessionCookie, cursorUserId, jwtExpiry, readCursorLogin, resetCursorLoginCache } from '../apps/local-server/src/cursor-usage.js';
import { createUsage } from '../apps/local-server/src/usage.js';

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('Cursor usage bodies become billing-cycle windows', () => {
  const body = {
    billingCycleEnd: '1764547200000',
    enabled: true,
    planUsage: { totalPercentUsed: 25, autoPercentUsed: 20, apiPercentUsed: 40, limit: 40000, remaining: 30000 },
    spendLimitUsage: { individualLimit: 50000, individualUsed: 12000, individualRemaining: 38000, limitType: 'user' }
  };
  const { windows, needsFallback } = parseCursorUsage(body, { planName: 'Pro' });
  assert.equal(needsFallback, false);
  assert.deepEqual(windows.map(item => item.key), ['total', 'auto', 'api', 'on-demand']);
  assert.equal(windows[0].percent, 25);
  assert.equal(windows[3].percent, 24);
});

test('Grok Bot weekly usage is parsed when present', () => {
  const row = parseCursorGrokUsage({ usagePercent: 30, nextResetTimestampUtc: '2026-10-27T00:00:00Z', hasNonZeroIncludedLimit: true, hasAvailableUsage: true });
  assert.equal(row.key, 'grok');
  assert.equal(row.percent, 30);
  assert.equal(row.resetsAt, Date.parse('2026-10-27T00:00:00Z'));
});

test('Grok Bot is omitted when it matches Cursor or total usage', () => {
  assert.equal(parseCursorGrokUsage({ usagePercent: 22.26, hasNonZeroIncludedLimit: true, hasAvailableUsage: true }, { autoPercent: 22.26 }), null);
  assert.equal(parseCursorGrokUsage({ usagePercent: 10, hasNonZeroIncludedLimit: true, hasAvailableUsage: true }, { totalPercent: 10 }), null);
});

test('Enterprise fallback uses request and summary endpoints', () => {
  const fallback = parseCursorUsageFallback({
    planName: 'Enterprise',
    requestUsage: { 'gpt-4': { numRequests: 120, maxRequestUsage: 500 } },
    summary: { membershipType: 'enterprise', individualUsage: { onDemand: { enabled: true, used: 2500, limit: 10000 } } }
  });
  assert.equal(fallback.windows[0].key, 'total');
  assert.equal(fallback.windows[0].percent, 24);
});

test('cursor session cookie and jwt helpers', () => {
  const token = 'e30.' + Buffer.from(JSON.stringify({ sub: 'auth0|user_fake', exp: 2_000_000_000 })).toString('base64url') + '.sig';
  assert.equal(cursorUserId(token), 'user_fake');
  assert.equal(cursorSessionCookie(token), `WorkosCursorSessionToken=user_fake%3A%3A${token}`);
  assert.equal(jwtExpiry(token), 2_000_000_000_000);
});

test('readCursorLogin prefers CLI keychain tokens', async () => {
  const login = await readCursorLogin({
    platform: 'darwin',
    readPassword: async service => (service === 'cursor-access-token' ? 'tok-a' : service === 'cursor-refresh-token' ? 'tok-r' : null),
    readState: async () => 'cursor-safe-storage:v1:ignored'
  });
  assert.deepEqual(login, { token: 'tok-a', refreshToken: 'tok-r', expiresAt: null, source: 'cli' });
});

test('encrypted IDE tokens decrypt with Cursor Safe Storage', async () => {
  resetCursorLoginCache();
  const secret = 'test-password-24-chars!!';
  const jwt = 'e30.' + Buffer.from(JSON.stringify({ sub: 'auth0|user_x' })).toString('base64url') + '.sig';
  const key = pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const encrypted = Buffer.concat([Buffer.from('v10'), cipher.update(jwt, 'utf8'), cipher.final()]);
  const stored = `cursor-safe-storage:v1:${encrypted.toString('base64')}`;
  const login = await readCursorLogin({
    env: { CURSOR_IDE_AUTH: '1' },
    platform: 'darwin',
    readPassword: async service => (service === 'Cursor Safe Storage' ? secret : null),
    readState: async key => (key === 'cursorAuth/accessToken' ? stored : null)
  });
  assert.equal(login.token, jwt);
  assert.equal(login.source, 'ide');
});

test('macOS skips IDE login unless CURSOR_IDE_AUTH is set', async () => {
  resetCursorLoginCache();
  const login = await readCursorLogin({
    env: {},
    platform: 'darwin',
    readPassword: async () => null,
    readState: async () => 'eyJ.plain.jwt'
  });
  assert.equal(login, null);
});

test('cursor login is read from the keychain at most once per cache window', async () => {
  resetCursorLoginCache();
  let reads = 0;
  const login = await readCursorLogin({
    platform: 'darwin',
    now: () => 1000,
    readPassword: async service => { if (service === 'cursor-access-token') { reads++; return 'tok'; } return null; },
    readState: async () => null
  });
  await readCursorLogin({ platform: 'darwin', now: () => 2000, readPassword: async () => { reads++; return 'x'; }, readState: async () => null });
  assert.equal(login?.token, 'tok');
  assert.equal(reads, 1);
});

test('Cursor usage is fetched from dashboard APIs', async () => {
  const usageBody = { enabled: true, billingCycleEnd: '1764547200000', planUsage: { totalPercentUsed: 12, autoPercentUsed: 8 } };
  const usage = createUsage({
    now: () => 1,
    cursorLogin: async () => ({ token: 't', refreshToken: 'r', expiresAt: 9_999_999_999_000, source: 'cli' }),
    fetch: async (url, init) => {
      if (url.includes('GetCurrentPeriodUsage')) return json(usageBody);
      if (url.includes('GetPlanInfo')) return json({ planInfo: { planName: 'Pro' } });
      if (url.includes('GetSandUsageStatus')) return json({ usagePercent: 5, hasNonZeroIncludedLimit: true, hasAvailableUsage: true });
      throw new Error(url);
    }
  });
  const result = await usage.status('cursor');
  assert.equal(result.plan, 'Pro');
  assert.equal(result.windows.find(item => item.key === 'total')?.percent, 12);
  assert.equal(result.windows.find(item => item.key === 'grok')?.percent, 5);
});
