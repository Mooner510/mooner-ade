import { useId, useRef, useState, type CSSProperties } from 'react';
import { placeAbove } from './Usage';
import { limitChip, type ChatLimit, type ChatState, type LimitWindow } from './chat-model';

// This chat's own limit, in the chat status line (server: chat.js `setLimit`, rules in chat-limit.js). Without a limit the button is a quiet icon; with one it says how far the
// chat is from every rule ("$0.50/$1.00 · 5시간 61/80%") and draws the closest rule as a bar under it. Pressed, it opens the panel that sets, changes or clears the limit.
export type LimitSetter = (limit: Record<string, unknown> | null) => Promise<unknown>;
const NAMES: Record<LimitWindow, string> = { session: '5시간', weekly: '주간' };
type Options = NonNullable<ChatState['limitOptions']>;
type Draft = { cost: string; usage: boolean; usageWindow: LimitWindow; usagePercent: string; share: boolean; shareWindow: LimitWindow; sharePercent: string; compact: boolean };
const draftOf = (limit: ChatLimit | null | undefined, options: Options): Draft => ({
  cost: limit?.cost !== undefined ? String(limit.cost) : '', usage: Boolean(limit?.usage), usageWindow: limit?.usage?.window ?? options.windows[0] ?? 'session', usagePercent: String(limit?.usage?.percent ?? 80),
  share: Boolean(limit?.share), shareWindow: limit?.share?.window ?? options.windows[0] ?? 'session', sharePercent: String(limit?.share?.percent ?? 5), compact: limit?.compact === true
});

// The selected window is a filled segment (a plain tint did not read as "chosen"); a row that is off keeps its controls but dims them.
function Windows({ value, options, label, onChange }: { value: LimitWindow; options: LimitWindow[]; label: string; onChange(value: LimitWindow): void }) {
  return <span className="lp-seg" role="radiogroup" aria-label={label}>{options.map(item => <button key={item} type="button" role="radio" aria-checked={value === item} onClick={() => onChange(item)}>{NAMES[item]}</button>)}</span>;
}

function LimitForm({ state, setLimit, close }: { state: ChatState; setLimit: LimitSetter; close(): void }) {
  const options = state.limitOptions ?? { cost: false, windows: [] }, chip = limitChip(state.limit);
  const [draft, setDraft] = useState(() => draftOf(state.limit, options)), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const patch = (next: Partial<Draft>) => setDraft(value => ({ ...value, ...next }));
  const submit = async (clear = false) => {
    setBusy(true); setError('');
    const payload = clear ? null : {
      ...(options.cost && draft.cost.trim() !== '' && { cost: Number(draft.cost) }), ...(draft.usage && options.windows.length > 0 && { usage: { window: draft.usageWindow, percent: Number(draft.usagePercent) } }),
      ...(draft.share && options.windows.length > 0 && { share: { window: draft.shareWindow, percent: Number(draft.sharePercent) } }), compact: draft.compact
    };
    try { await setLimit(payload); close(); } catch (reason) { setError((reason as Error).message); }
    setBusy(false);
  };
  return <form className="lp" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="lp-head"><strong>제한</strong></div>
    {chip && <ul className="lp-now" aria-label="현재 사용 현황">{chip.rules.map(rule => <li key={rule.name}>
      <span>{rule.name}</span><b>{rule.now ?? '—'} <small>/ {rule.max}</small></b>
      <i style={{ '--ratio': rule.ratio } as CSSProperties} data-hot={rule.ratio >= 0.9 || undefined} />
    </li>)}</ul>}
    {options.cost && <label className="lp-row"><span className="lp-name">비용</span>
      <span className="lp-field">$<input type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="사용 안 함" aria-label="비용 제한(달러)" value={draft.cost} onChange={event => patch({ cost: event.target.value })} /></span>
      <small>이 채팅의 비용이 이 금액에 닿으면 중지</small></label>}
    {options.windows.length > 0 && <>
      <div className="lp-row" data-off={!draft.share || undefined}><label className="lp-name"><input type="checkbox" checked={draft.share} onChange={event => patch({ share: event.target.checked })} />사용량 할당</label>
        <Windows value={draft.shareWindow} options={options.windows} label="사용량 할당 기간" onChange={shareWindow => patch({ shareWindow, share: true })} />
        <span className="lp-field"><input type="number" min="1" max="100" step="1" aria-label="사용량 할당(%)" value={draft.sharePercent} onChange={event => patch({ sharePercent: event.target.value, share: true })} />%</span>
        <small>지금부터 이 기간 사용량이 이만큼 늘면 중지, 같은 계정의 다른 채팅 사용분도 함께 셈 (추정)</small></div>
      <div className="lp-row" data-off={!draft.usage || undefined}><label className="lp-name"><input type="checkbox" checked={draft.usage} onChange={event => patch({ usage: event.target.checked })} />사용량 한도</label>
        <Windows value={draft.usageWindow} options={options.windows} label="사용량 한도 기간" onChange={usageWindow => patch({ usageWindow, usage: true })} />
        <span className="lp-field"><input type="number" min="1" max="100" step="1" aria-label="사용량 한도(%)" value={draft.usagePercent} onChange={event => patch({ usagePercent: event.target.value, usage: true })} />%</span>
        <small>이 기간의 전체 사용량이 이 값에 닿으면 중지, 응답 중 30초마다 확인</small></div>
    </>}
    <label className="lp-row"><span className="lp-name"><input type="checkbox" checked={draft.compact} onChange={event => patch({ compact: event.target.checked })} />중지되면 자동 압축</span><small>압축에도 사용량이 조금 듭니다</small></label>
    {error && <p className="lp-error" role="alert">{error}</p>}
    <div className="lp-foot"><em className={chip?.stopped ? 'stopped' : chip ? 'on' : undefined}>{chip?.stopped ? `${chip.stop} 도달` : chip ? '적용 중' : '설정 없음'}</em>
      {chip && <button type="button" disabled={busy} onClick={() => void submit(true)}>해제</button>}<button type="submit" className="primary" disabled={busy}>적용</button></div>
  </form>;
}

export function LimitButton({ state, setLimit, align, costShown }: { state: ChatState; setLimit: LimitSetter; align: 'left' | 'right'; costShown: boolean }) {
  const pop = useRef<HTMLSpanElement>(null), popId = useId(), [open, setOpen] = useState(false);
  const chip = limitChip(state.limit, costShown), options = state.limitOptions;
  if (!chip && !(options && (options.cost || options.windows.length > 0))) return null; // nothing this chat could be limited by
  return <>
    <button type="button" className={`stat chat-stat chat-stat-limit${chip ? ' set' : ' idle'}${chip?.stopped ? ' stopped' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={popId} popoverTarget={popId} aria-label={chip?.text ?? '제한 설정'} title={chip ? undefined : '제한 설정'}>
      <span className="icon material-symbols-outlined" style={{ fontSize: 15 }} aria-hidden="true">{chip?.stopped ? 'block' : 'rule'}</span>
      {chip && <span className="stat-text">{chip.text}</span>}
      {chip && <i className="limit-bar" style={{ '--ratio': chip.ratio } as CSSProperties} aria-hidden="true" />}
    </button>
    <span ref={pop} id={popId} popover="auto" role="dialog" aria-label="제한" className="chat-stat-tip usage-panel limit-panel" onToggle={event => { const toggle = event as unknown as { newState: string; currentTarget: HTMLElement }; setOpen(toggle.newState === 'open'); placeAbove(toggle, align, 8); }}>
      {open && <LimitForm state={state} setLimit={setLimit} close={() => pop.current?.hidePopover()} />}
    </span>
  </>;
}
