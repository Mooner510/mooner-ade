import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api } from './api';
import { usageHue } from './Editor';

// The plan-limit readings of the login a project's agent CLI uses. Shared by the bottom status bar and the chat tab's usage ring.
export type UsageWindow = { key: string; label: string; percent: number; resetsAt: number | null };
export type Usage = { provider: 'claude' | 'codex'; windows: UsageWindow[]; plan: string; source: 'api' | 'log' | null; at: number; error: string | null; note?: string; account: { dir: string; from: 'process' | 'direnv' | 'server' } };
export const accountSources = { process: '실행 중인 에이전트', direnv: '프로젝트 .envrc', server: '앱 환경' };
export const defaultAccountDir = { claude: '~/.claude', codex: '~/.codex' };
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
    return api<Usage>('usage/status', { provider, force, projectId }).then(setUsage, () => {}).finally(() => setLoading(false));
  }, [provider, projectId]);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const tick = () => { if (live) void load(); };
    tick(); const timer = setInterval(tick, refresh * 1000);
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

// Light-dismiss popover in the top layer, so no overflow clipping cuts it off; opened by the element before it, placed above it.
export function placeAbove(event: { newState: string; currentTarget: HTMLElement }, align: 'left' | 'right' = 'left') {
  if (event.newState !== 'open') return;
  const menu = event.currentTarget, anchor = (menu.previousElementSibling as HTMLElement).getBoundingClientRect(), width = menu.offsetWidth;
  const left = align === 'right' ? anchor.right - width : anchor.left;
  menu.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
  menu.style.bottom = `${innerHeight - anchor.top + 14}px`;
}
