import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const percent = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
const num = value => { const n = Number(value); return Number.isFinite(n) ? n : null; };

export function cursorAppSupport({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (env.CURSOR_APP_SUPPORT) return env.CURSOR_APP_SUPPORT;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor');
  return path.join(home, '.config', 'Cursor');
}

export function cursorStatePath(options = {}) {
  return path.join(cursorAppSupport(options), 'User', 'globalStorage', 'state.vscdb');
}

const run = (file, args) => new Promise(resolve => {
  execFile(file, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout));
});

export async function readCursorStateValue(key, { db = cursorStatePath(), query = run } = {}) {
  const sql = `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}' LIMIT 1;`;
  const text = await query('sqlite3', [db, sql]);
  const value = text?.trim();
  return value || null;
}

const jwtPart = token => {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return null; }
};

export const jwtExpiry = token => {
  const exp = jwtPart(token)?.exp;
  return exp ? Number(exp) * 1000 : null;
};

export function cursorUserId(token) {
  const subject = jwtPart(token)?.sub;
  if (!subject) return null;
  const parts = subject.split('|');
  return (parts.length > 1 ? parts[1] : parts[0])?.trim() || null;
}

export function cursorSessionCookie(token) {
  const userId = cursorUserId(token);
  return userId ? `WorkosCursorSessionToken=${userId}%3A%3A${token}` : null;
}

const keychain = (service, account) => new Promise(resolve => {
  const args = ['find-generic-password', '-s', service, '-w'];
  if (account) args.splice(2, 0, '-a', account);
  execFile('security', args, { timeout: 10_000 }, (error, stdout) => resolve(error ? null : stdout.trim()));
});

async function decryptSafeStorage(stored, readPassword = keychain) {
  if (!stored.startsWith('cursor-safe-storage:v1:')) return null;
  const blob = Buffer.from(stored.slice('cursor-safe-storage:v1:'.length), 'base64');
  if (!blob.subarray(0, 3).equals(Buffer.from('v10'))) return null;
  const password = await readPassword('Cursor Safe Storage') ?? await readPassword('Cursor Safe Storage', 'Cursor Key');
  if (!password) return null;
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]).toString('utf8');
  return jwtPart(plain) ? plain : null;
}

async function resolveStoredToken(stored, readPassword, platform) {
  if (!stored) return null;
  if (stored.startsWith('eyJ')) return stored;
  if (platform !== 'darwin') return null;
  return decryptSafeStorage(stored, readPassword);
}

const LOGIN_CACHE_GAP = 30 * 60_000;
let loginCache = null;

export function resetCursorLoginCache() {
  loginCache = null;
}

const cacheUntil = (login, now) => {
  const floor = now + LOGIN_CACHE_GAP;
  if (login.expiresAt) return Math.min(login.expiresAt - 5 * 60_000, floor);
  return floor;
};

async function readIdeLogin({ env, platform, readPassword, readState }) {
  // Cursor 앱 토큰은 Safe Storage Keychain 복호화가 필요해 앱마다 비밀번호 창이 뜰 수 있음. 기본은 끔.
  if (platform === 'darwin' && env.CURSOR_IDE_AUTH !== '1') return null;
  const stored = await readState('cursorAuth/accessToken');
  const refreshStored = await readState('cursorAuth/refreshToken');
  const token = await resolveStoredToken(stored, readPassword, platform);
  if (!token) return null;
  const refreshToken = (await resolveStoredToken(refreshStored, readPassword, platform)) || token;
  return { token, refreshToken, expiresAt: jwtExpiry(token), source: 'ide' };
}

// cursor-agent가 Keychain에 두는 JWT를 우선 사용한다. IDE 경로는 CURSOR_IDE_AUTH=1일 때만.
export async function readCursorLogin({ env = process.env, platform = process.platform, now = Date.now, readPassword = keychain, readState = key => readCursorStateValue(key, { db: cursorStatePath({ env, platform }) }) } = {}) {
  if (loginCache && now() < loginCache.until) return loginCache.value;

  const accessEnv = env.CURSOR_ACCESS_TOKEN?.trim();
  if (accessEnv) {
    const login = { token: accessEnv, refreshToken: env.CURSOR_REFRESH_TOKEN?.trim() || accessEnv, expiresAt: jwtExpiry(accessEnv), source: 'env' };
    loginCache = { value: login, until: cacheUntil(login, now()) };
    return login;
  }

  let login = null;
  if (platform === 'darwin') {
    const access = await readPassword('cursor-access-token', 'cursor-user') ?? await readPassword('cursor-access-token');
    if (access) {
      const refresh = await readPassword('cursor-refresh-token', 'cursor-user') ?? await readPassword('cursor-refresh-token');
      login = { token: access, refreshToken: refresh || access, expiresAt: jwtExpiry(access), source: 'cli' };
    }
  }
  login ??= await readIdeLogin({ env, platform, readPassword, readState });

  if (login) loginCache = { value: login, until: cacheUntil(login, now()) };
  return login;
}

export const cursorRefreshClientID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';

const billingResets = body => {
  const end = num(body?.billingCycleEnd);
  return end && end > 0 ? end : null;
};

const planLabel = (planInfoName, membershipType) => {
  const membership = membershipType?.trim()?.toLowerCase();
  const planInfo = planInfoName?.trim();
  if (membership && ['enterprise', 'team'].includes(membership) && (!planInfo || ['pro', 'pro plan'].includes(planInfo.toLowerCase()))) return membership;
  if (planInfo) return planInfo;
  return membership || '';
};

const onDemandPercent = (bucket, resetsAt) => {
  const limit = num(bucket?.individualLimit) ?? num(bucket?.pooledLimit) ?? num(bucket?.limit);
  if (!limit || limit <= 0) return null;
  const used = num(bucket?.individualUsed) ?? num(bucket?.pooledUsed) ?? num(bucket?.totalSpend) ?? num(bucket?.used);
  const remaining = num(bucket?.individualRemaining) ?? num(bucket?.pooledRemaining) ?? num(bucket?.remaining);
  const spent = used ?? (remaining != null ? Math.max(0, limit - remaining) : 0);
  return { key: 'on-demand', label: bucket?.limitType === 'team' ? '팀 온디맨드' : '온디맨드', percent: percent(spent / limit * 100), resetsAt };
};

// GetCurrentPeriodUsage 응답 → 상태바에 맞는 창 목록 (OpenUsage CursorUsageMapper 요약).
export function parseCursorUsage(body, { planName = '' } = {}) {
  const windows = [];
  if (body?.enabled === false) return { windows, needsFallback: true, plan: planName };
  const planUsage = body?.planUsage;
  if (!planUsage) return { windows, needsFallback: true, plan: planName };
  const resetsAt = billingResets(body);
  const limit = num(planUsage.limit);
  const totalPct = num(planUsage.totalPercentUsed);
  const autoPct = num(planUsage.autoPercentUsed);
  const apiPct = num(planUsage.apiPercentUsed);
  const hasPools = (autoPct ?? 0) > 0 || (apiPct ?? 0) > 0;

  if (totalPct != null) windows.push({ key: 'total', label: '전체', percent: percent(totalPct), resetsAt });
  else if (limit != null && limit > 0) {
    const spent = num(planUsage.totalSpend) ?? Math.max(0, limit - (num(planUsage.remaining) ?? limit));
    windows.push({ key: 'total', label: '전체', percent: percent(spent / limit * 100), resetsAt });
  } else if (!hasPools) return { windows, needsFallback: true, plan: planName };

  if (autoPct != null) windows.push({ key: 'auto', label: 'Cursor 모델', percent: percent(autoPct), resetsAt });
  if (apiPct != null) windows.push({ key: 'api', label: '기타 모델', percent: percent(apiPct), resetsAt });

  const spend = body.spendLimitUsage;
  if (spend) {
    const row = onDemandPercent(spend, resetsAt);
    if (row) windows.push(row);
  }
  return { windows, needsFallback: windows.length === 0, plan: planName };
}

export function parseCursorGrokUsage(body, { autoPercent = null, totalPercent = null } = {}) {
  if (body?.usesPooledEnterpriseAllowance === true || body?.hasNonZeroIncludedLimit === false || body?.hasAvailableUsage === false) return null;
  const value = num(body?.usagePercent);
  if (value == null || value < 0) return null;
  const rounded = percent(value);
  if (autoPercent != null && rounded === percent(autoPercent)) return null;
  if (totalPercent != null && rounded === percent(totalPercent)) return null;
  const reset = body?.nextResetTimestampUtc ? Date.parse(body.nextResetTimestampUtc) : null;
  return { key: 'grok', label: 'Grok Bot', percent: rounded, resetsAt: reset && !Number.isNaN(reset) ? reset : null };
}

const summaryCycle = summary => {
  const start = summary?.billingCycleStart ? Date.parse(summary.billingCycleStart) : null;
  const end = summary?.billingCycleEnd ? Date.parse(summary.billingCycleEnd) : null;
  return end && !Number.isNaN(end) ? end : null;
};

const dollarBucket = bucket => {
  if (!bucket || bucket.enabled === false) return null;
  const limit = num(bucket.limit);
  if (!limit || limit <= 0) return null;
  const used = num(bucket.used);
  const remaining = num(bucket.remaining);
  const spent = used ?? (remaining != null ? Math.max(0, limit - remaining) : 0);
  return { spent, limit };
};

// Enterprise·팀 계정 REST/요약 fallback (OpenUsage CursorUsageSummaryMapper).
export function parseCursorUsageFallback({ summary, requestUsage, planName = '' } = {}) {
  const windows = [];
  const resetsAt = summaryCycle(summary) ?? (requestUsage?.startOfMonth ? Date.parse(requestUsage.startOfMonth) : null);

  const requests = requestUsage?.['gpt-4'];
  const reqLimit = num(requests?.maxRequestUsage);
  if (reqLimit && reqLimit > 0) {
    const used = Math.max(0, num(requests?.numRequests) ?? num(requests?.numRequestsTotal) ?? 0);
    windows.push({ key: 'total', label: '요청', percent: percent(used / reqLimit * 100), resetsAt });
  }

  const individual = summary?.individualUsage;
  const team = summary?.teamUsage;
  if (!windows.length) {
    const plan = individual?.plan;
    const totalPct = num(plan?.totalPercentUsed);
    if (totalPct != null) windows.push({ key: 'total', label: '전체', percent: percent(totalPct), resetsAt });
    else {
      const meter = dollarBucket(individual?.overall) ?? dollarBucket(team?.pooled);
      if (meter) windows.push({ key: 'total', label: '전체', percent: percent(meter.spent / meter.limit * 100), resetsAt });
    }
  }

  const plan = individual?.plan;
  for (const [key, label, field] of [['auto', 'Cursor 모델', 'autoPercentUsed'], ['api', '기타 모델', 'apiPercentUsed']]) {
    const value = num(plan?.[field]);
    if (value != null) windows.push({ key, label, percent: percent(value), resetsAt });
  }

  const onDemand = dollarBucket(individual?.onDemand) ?? dollarBucket(team?.onDemand);
  if (onDemand) windows.push({ key: 'on-demand', label: '온디맨드', percent: percent(onDemand.spent / onDemand.limit * 100), resetsAt });

  return { windows, plan: planLabel(planName, summary?.membershipType) };
}
