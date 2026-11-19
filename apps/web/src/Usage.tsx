import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api } from './api';
import { usageHue } from './Editor';

// The plan-limit readings of the login a project's agent CLI uses. Shared by the bottom status bar and the chat tab's usage ring.
export type UsageWindow = { key: string; label: string; percent: number; resetsAt: number | null };
// Extra-usage credit (Claude): a null limit means no cap is set, so only the amount spent is known.
export type UsageCredit = { used: number; limit: number | null; percent: number | null; currency: string };
export type CodexCredits = { balance: number | null; unlimited: boolean; hasCredits: boolean; limit?: { used: number; limit: number; percent: number; resetsAt: number | null } };
const credits = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
export const codexCreditsLabel = (value: CodexCredits) => value.limit ? `${value.limit.percent}%` : value.unlimited ? '무제한' : value.balance !== null ? credits(value.balance) : value.hasCredits ? '잔액 있음' : '0';
export type Usage = { provider: 'claude' | 'codex' | 'cursor'; windows: UsageWindow[]; credit?: UsageCredit | null; codexCredits?: CodexCredits | null; plan: string; source: 'api' | 'log' | null; at: number; error: string | null; note?: string; account: { dir: string; from: 'process' | 'direnv' | 'server' } };
export const accountSources = { process: '실행 중인 에이전트', direnv: '프로젝트 .envrc', server: '앱 환경' };
export const defaultAccountDir = { claude: '~/.claude', codex: '~/.codex', cursor: 'Cursor 로그인(기기)' };
export const usageStatusKeys: Record<Usage['provider'], string[]> = { claude: ['session', 'weekly'], codex: ['session', 'weekly'], cursor: ['auto', 'api', 'total', 'grok'] };
export const usageStatusShort: Record<string, string> = { session: '5h', weekly: '주', total: '전체', grok: 'Grok', auto: 'Cursor', api: '기타', 'on-demand': '추가', fable: 'FB' };
export { barWindows, defaultUsageMeters, usageMeterCatalog, usageMetersOf } from './usage-meters';
export type { UsageStyle } from './usage-meters';

/** Cursor 상태바: 모델 풀( Cursor / 기타 ) 우선, Grok는 Cursor·전체와 %가 같으면 생략. */
export function cursorUsageCompact(windows: UsageWindow[]): UsageWindow[] {
  const byKey = Object.fromEntries(windows.map(item => [item.key, item]));
  const auto = byKey.auto, total = byKey.total, grok = byKey.grok;
  const grokDistinct = grok && grok.percent !== auto?.percent && grok.percent !== total?.percent;
  const order = ['auto', 'api', 'total', ...(grokDistinct ? ['grok' as const] : [])];
  const picked = order.map(key => byKey[key]).filter(Boolean) as UsageWindow[];
  return (picked.length ? picked : windows).slice(0, 3);
}
export const money = (amount: number, currency = 'USD') => new Intl.NumberFormat('ko-KR', { style: 'currency', currency, maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount);
export const untilReset = (at: number) => {
  const minutes = Math.max(0, Math.round((at - Date.now()) / 60000)), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days ? `${days}일 ${hours}시간` : hours ? `${hours}시간 ${minutes % 60}분` : `${minutes}분`;
};
export const usageHueStyle = (percent: number) => ({ '--usage-hue': usageHue(percent) } as CSSProperties);

// Reads `usage/status` now and then. Hidden projects keep their last reading; showing them again refreshes it, since the agent may have changed accounts.
export function useUsage(provider: Usage['provider'], projectId: string, active: boolean, refresh: number) {
  const [usage, setUsage] = useState<Usage | null>(null), [loading, setLoading] = useState(false);
  const load = useCallback((force = false) => {
    setLoading(force);
    return api<Usage>('usage/status', { provider, force, projectId }).then(value => { setUsage(value); return value; }, () => undefined).finally(() => setLoading(false));
  }, [provider, projectId]);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const tick = () => { if (live) void load(); };
    // The server reuses a reading for 3 minutes whatever the interval, so polling often is cheap; what it buys is that an account switch
    // (`direnv allow`, a new .envrc) shows up within seconds instead of after the whole refresh period.
    tick(); const timer = setInterval(tick, Math.min(refresh, 15) * 1000);
    return () => { live = false; clearInterval(timer); };
  }, [load, active, refresh]);
  return { usage, loading, load };
}

// One bar per limit window: label, reset time, percent.
export function UsageRows({ windows, colors }: { windows: UsageWindow[]; colors: boolean }) {
  if (!windows.length) return <p className="usage-note">표시할 한도 정보가 없습니다.</p>;
  return <>{windows.map(item => <div key={item.key} className="usage-row">
    <div><span>{item.label}</span><b className={colors ? 'graded' : ''} style={colors ? usageHueStyle(item.percent) : undefined}>{item.percent}%</b></div>
    <progress className={colors ? 'graded' : ''} style={colors ? usageHueStyle(item.percent) : undefined} value={item.percent} max={100} aria-label={`${item.label} 사용률`} />
    {item.resetsAt && <small>{untilReset(item.resetsAt)} 후 초기화 · {new Date(item.resetsAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</small>}
  </div>)}</>;
}

export function CreditRow({ credit, colors }: { credit: UsageCredit; colors: boolean }) {
  const { used, limit, percent, currency } = credit;
  if (limit === null || percent === null) return <div className="usage-row"><div><span>추가 사용 크레딧</span><b>{money(used, currency)}</b></div><small>월 한도 없음 · 이번 달 사용액</small></div>;
  return <div className="usage-row">
    <div><span>추가 사용 크레딧</span><b className={colors ? 'graded' : ''} style={colors ? usageHueStyle(percent) : undefined}>{percent}%</b></div>
    <progress className={colors ? 'graded' : ''} style={colors ? usageHueStyle(percent) : undefined} value={percent} max={100} aria-label="추가 사용 크레딧 사용률" />
    <small>{money(used, currency)} / {money(limit, currency)} · 월 한도</small>
  </div>;
}

// Light-dismiss popover in the top layer, so no overflow clipping cuts it off; opened by the element before it, placed above it.
export function placeAbove(event: { newState: string; currentTarget: HTMLElement }, align: 'left' | 'right' = 'left', gap = 14) {
  if (event.newState !== 'open') return;
  const menu = event.currentTarget, anchor = (menu.previousElementSibling as HTMLElement).getBoundingClientRect(), width = menu.offsetWidth;
  const left = align === 'right' ? anchor.right - width : anchor.left;
  menu.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
  menu.style.bottom = `${innerHeight - anchor.top + gap}px`;
}

// Codex credits like Claude's extra usage: a bar with used / limit when a spend limit exists, else the balance.
export function CodexCreditRow({ value, colors }: { value: CodexCredits; colors: boolean }) {
  const { limit } = value;
  if (!limit) return <div className="usage-row"><div><span>남은 크레딧</span><b>{codexCreditsLabel(value)}</b></div></div>;
  return <div className="usage-row">
    <div><span>크레딧</span><b className={colors ? 'graded' : ''} style={colors ? usageHueStyle(limit.percent) : undefined}>{limit.percent}%</b></div>
    <progress className={colors ? 'graded' : ''} style={colors ? usageHueStyle(limit.percent) : undefined} value={limit.percent} max={100} aria-label="크레딧 사용률" />
    <small>{credits(limit.used)} / {credits(limit.limit)} 크레딧 · 남은 {credits(Math.max(0, limit.limit - limit.used))}{limit.resetsAt ? ` · ${untilReset(limit.resetsAt)} 후 초기화` : ''}</small>
  </div>;
}
