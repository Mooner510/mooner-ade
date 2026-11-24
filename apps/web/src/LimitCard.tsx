import { useEffect, useRef, useState } from 'react';
import type { ChatLimit, LimitWindow } from './chat-model';

// /limit, inline in the conversation: this chat's own limit (server: chat.js `setLimit`, rules in chat-limit.js). Only what the chat can be limited by is offered.
type Options = { cost: boolean; windows: LimitWindow[] };
type Reply = { limit: ChatLimit | null; options: Options };
export type LimitCall = (input: Record<string, unknown>) => Promise<Reply>;
const NAMES: Record<LimitWindow, string> = { session: '5시간', weekly: '주간' };
type Draft = { cost: string; usage: boolean; usageWindow: LimitWindow; usagePercent: string; share: boolean; shareWindow: LimitWindow; sharePercent: string; compact: boolean };
const draftOf = (limit: ChatLimit | null, options: Options): Draft => ({
  cost: limit?.cost !== undefined ? String(limit.cost) : '', usage: Boolean(limit?.usage), usageWindow: limit?.usage?.window ?? options.windows[0] ?? 'session', usagePercent: String(limit?.usage?.percent ?? 80),
  share: Boolean(limit?.share), shareWindow: limit?.share?.window ?? options.windows[0] ?? 'session', sharePercent: String(limit?.share?.percent ?? 5), compact: limit?.compact === true
});

function Windows({ value, options, onChange }: { value: LimitWindow; options: LimitWindow[]; onChange(value: LimitWindow): void }) {
  return <span className="lc-seg" role="radiogroup">{options.map(item => <button key={item} type="button" role="radio" aria-checked={value === item} onClick={() => onChange(item)}>{NAMES[item]}</button>)}</span>;
}

export function LimitCard({ call }: { call: LimitCall }) {
  const latest = useRef(call); latest.current = call; // the card is read once; a new `call` identity must not throw away what is being typed
  const [reply, setReply] = useState<Reply | null>(null), [draft, setDraft] = useState<Draft | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = (next: Reply) => { setReply(next); setDraft(draftOf(next.limit, next.options)); };
  useEffect(() => { void latest.current({}).then(load, (reason: Error) => setError(reason.message)); }, []);
  const options = reply?.options, limit = reply?.limit ?? null, available = options && (options.cost || options.windows.length > 0);
  const patch = (next: Partial<Draft>) => setDraft(value => value && ({ ...value, ...next }));
  const apply = async (clear = false) => {
    if (!draft || !options) return;
    setBusy(true); setError('');
    const costOn = options.cost && draft.cost.trim() !== '';
    const payload = clear ? null : {
      ...(costOn && { cost: Number(draft.cost) }), ...(draft.usage && options.windows.length && { usage: { window: draft.usageWindow, percent: Number(draft.usagePercent) } }),
      ...(draft.share && options.windows.length && { share: { window: draft.shareWindow, percent: Number(draft.sharePercent) } }), compact: draft.compact
    };
    try { load(await latest.current({ limit: payload })); } catch (reason) { setError((reason as Error).message); }
    setBusy(false);
  };
  return <div className="chat-row mcp-card limit-card" role="region" aria-label="제한"><div className="mc lc">
    <header className="mc-head"><b>제한</b><span>{limit?.stop ? `${limit.stop} 도달` : limit ? '적용 중' : '설정 없음'}</span>
      {limit && <button type="button" disabled={busy} onClick={() => void apply(true)}>해제</button>}</header>
    {error && <p className="mc-error" role="alert">{error}</p>}
    {!draft || !options ? !error && <p className="mc-empty">상태를 읽는 중…</p> : !available ? <p className="mc-empty">이 채팅에는 걸 수 있는 제한이 없습니다.</p> : <>
      {options.cost && <label className="lc-row"><span className="lc-name">비용</span>
        <span className="lc-field">$<input type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="사용 안 함" aria-label="비용 제한(달러)" value={draft.cost} onChange={event => patch({ cost: event.target.value })} /></span>
        <small>이 채팅의 비용이 이 금액에 닿으면 중지</small></label>}
      {options.windows.length > 0 && <>
        <div className="lc-row"><label className="lc-name"><input type="checkbox" checked={draft.share} onChange={event => patch({ share: event.target.checked })} />사용량 할당</label>
          <Windows value={draft.shareWindow} options={options.windows} onChange={shareWindow => patch({ shareWindow })} />
          <span className="lc-field"><input type="number" min="1" max="100" step="1" aria-label="사용량 할당(%)" disabled={!draft.share} value={draft.sharePercent} onChange={event => patch({ sharePercent: event.target.value })} />%</span>
          <small>설정한 뒤 이 창 사용량이 늘어난 만큼 · 같은 계정의 다른 채팅 사용분도 함께 셈 (추정)</small></div>
        <div className="lc-row"><label className="lc-name"><input type="checkbox" checked={draft.usage} onChange={event => patch({ usage: event.target.checked })} />사용량 한도</label>
          <Windows value={draft.usageWindow} options={options.windows} onChange={usageWindow => patch({ usageWindow })} />
          <span className="lc-field"><input type="number" min="1" max="100" step="1" aria-label="사용량 한도(%)" disabled={!draft.usage} value={draft.usagePercent} onChange={event => patch({ usagePercent: event.target.value })} />%</span>
          <small>이 창의 전체 사용량이 이 값에 닿으면 중지 · 응답 중 30초마다 확인</small></div>
      </>}
      <label className="lc-row lc-compact"><span className="lc-name"><input type="checkbox" checked={draft.compact} onChange={event => patch({ compact: event.target.checked })} />중지되면 자동 압축</span><small>압축에도 사용량이 조금 듭니다</small></label>
      <footer className="lc-foot"><button type="button" disabled={busy} onClick={() => void apply()}>적용</button></footer>
    </>}
  </div></div>;
}
