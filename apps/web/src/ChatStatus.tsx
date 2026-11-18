import { Fragment, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from './api';
import { placeAbove } from './Usage';
import { chatStatusLayout, usageHue, type Settings } from './Editor';
import { compact, dollars, contextGauge, contextPercent, contextReported, contextWindow, duration, fillFormat, displayModel, modelAppearance, permissionLabels, permissionModeColor, statusLabelsKo, type ChatState } from './chat-model';

// The chat tab's status line: only items that read the conversation. Branch, changes, usage, clock, CPU, memory and path live in the bottom status bar.
export type ChatStatusContext = { state: ChatState; share?: string | null };
type Def = {
  label: string; hint?: string; icon: string; format: string;
  // A second icon + text group after the main one (tokens: the cache icon with cache writes ↑ and reads ↓). Hidden when `show` says no.
  extra?: { icon: string; format: string; show?(context: ChatStatusContext): boolean };
  // `{token}` values for the template; the item is hidden when this returns null.
  values(context: ChatStatusContext): Record<string, string> | null;
  // 0 (green) to 120 (red) hue, for items that grade like the usage windows.
  hue?(context: ChatStatusContext): number | undefined;
  color?(context: ChatStatusContext): string | undefined;
};

export const chatStatusDefs: Record<string, Def> = {
  status: { label: '진행 상태', icon: 'bolt', format: '{status}', values: ({ state }) => ({ status: state.pending ? `승인 대기 ${state.pending}` : statusLabelsKo[state.status] }),
    hint: '대기 중 · 응답 중 · 승인 대기' },
  model: { label: '모델', icon: 'smart_toy', format: '{model}', values: ({ state }) => ({ model: displayModel(state.model, state.agent), id: state.model ?? '' }), hint: '{model} 짧은 이름 · {id} 전체 모델 ID', color: ({ state }) => modelAppearance(state.model, state.agent).color },
  mode: { label: '권한 모드', icon: 'shield', format: '{mode}', values: ({ state }) => ({ mode: permissionLabels[state.permissionMode] ?? state.permissionMode, id: state.permissionMode }),
    color: ({ state }) => permissionModeColor(state.permissionMode) },
  context: { label: '컨텍스트 사용률', icon: 'data_usage', format: '{percent}% · {used}/{window}',
    values: ({ state }) => {
      const gauge = contextGauge(state);
      return { percent: String(gauge.percent), used: compact(gauge.used), window: compact(gauge.basis) };
    },
    hue: ({ state }) => usageHue(contextPercent(state)),
    color: ({ state }) => contextGauge(state).autoCompact ? 'var(--term-magenta)' : undefined,
    hint: '마지막 응답까지 쌓인 토큰 ÷ 기준 창(Auto Compact 창, 없으면 최대 컨텍스트). {percent} {used} {window}' },
  tokens: { label: '토큰', icon: 'token', format: '↑{input} ↓{output}', values: ({ state }) => ({ input: compact(state.tokens.input), output: compact(state.tokens.output), cache: compact(state.tokens.cacheRead), cacheWrite: compact(state.tokens.cacheCreate), total: compact(state.tokens.input + state.tokens.output) }),
    extra: { icon: 'database', format: '↑{cacheWrite} ↓{cache}', show: ({ state }) => state.tokens.cacheRead + state.tokens.cacheCreate > 0 },
    hint: '이 채팅의 누적 토큰. 캐시 아이콘 뒤는 ↑캐시 쓰기 ↓캐시 읽기. {input} {output} {cache}(캐시 읽기) {cacheWrite}(캐시 쓰기) {total}' },
  cost: { label: '비용', icon: 'payments', format: '${cost}', values: ({ state }) => state.costUsd === null ? { cost: '미제공' } : ({ cost: dollars(state.costUsd) }), hint: '이 채팅에서 든 비용(USD) · CLI가 보고한 세션 비용' },
  // Until a turn has been measured (and always on an API key, or for Codex/Cursor) the item names what this chat is billed against; the measured share replaces it.
  share: { label: '사용량 기여도', icon: 'speed', format: '{share}', values: ({ state, share }) => ({ share: usageBasis(state, share) }),
    hint: 'API 키 채팅은 ‘API Usage’(토큰 과금), CLI 로그인 채팅은 측정 전 ‘Plan Usage’로 표시하고, 측정되면 이 채팅이 플랜 한도(5h·주)에서 차지한 %p(추정)로 바뀝니다.' },
  turns: { label: '턴 수', icon: 'forum', format: '{turns}턴', values: ({ state }) => ({ turns: String(state.turns) }) },
  duration: { label: '누적 소요 시간', icon: 'timer', format: '{time}', values: ({ state }) => ({ time: duration(state.durationMs) }) },
  session: { label: '세션 ID', icon: 'tag', format: '{short}', values: ({ state }) => state.sessionId ? { short: state.sessionId.slice(0, 8), id: state.sessionId } : null },
};
// What a chat's usage is counted against: an API key's tokens, or the CLI login's plan (its measured share once there is one).
// Until a turn has been measured the item names what the chat is billed against; the measured share (of the 5h / weekly limits) replaces it.
export const usageBasis = (state: ChatState, share?: string | null) => state.apiKey ? 'API Usage' : share || 'Plan Usage';
export const chatStatusLabels: Record<string, string> = Object.fromEntries(Object.entries(chatStatusDefs).map(([id, def]) => [id, def.label]));

export const chatItemView = (id: string, context: ChatStatusContext): { text: string; icon: string; color?: string; extra?: { text: string; icon: string } } | null => {
  const def = chatStatusDefs[id]; if (!def) return null;
  const values = def.values(context); if (!values) return null;
  const { state } = context;
  if (id === 'cost' && state.costUsd === null || id === 'tokens' && state.capabilities?.tokens === false) return null;
  if (id === 'context' && (state.capabilities?.context === false || !contextReported(state))) return null;
  const hue = def.hue?.(context);
  const extra = def.extra && (def.extra.show?.(context) ?? true) ? { text: fillFormat(def.extra.format, values), icon: def.extra.icon } : undefined;
  return { text: fillFormat(def.format, values), icon: def.icon, extra, color: def.color?.(context) ?? (hue !== undefined ? `hsl(${hue} 65% var(--usage-l, 55%))` : undefined) };
};

// One box of the status line. Its hover text is the item's fixed name: it never repeats or changes with the value shown beside it.
function StatBox({ cls, icon, text, label, color, swap }: { cls: string; icon: string; text: string; label: string; color?: string; swap?: boolean }) {
  return <span className={`stat chat-stat ${cls}`} title={label} style={color ? { color } as CSSProperties : undefined}>
    <span className="icon material-symbols-outlined" style={{ fontSize: 15 }} aria-hidden="true">{icon}</span>
    {/* The usage item turns from its label into the measured share: a new key fades the new text in. */}
    {swap ? <span key={text} className="chat-stat-swap">{text}</span> : text}
  </span>;
}

// The usage item is a button and the switch: it names what this chat is billed against (Plan Usage, or API Usage with the money it has cost) and,
// pressed, lets a Claude chat go on with the CLI plan or the API key. Switching is silent; the composer asks before the first message that would
// change the login of a chat that has had a turn (the two logins do not share a prompt cache). The key itself is registered in Settings > AI 툴.
function UsageButton({ state, share, align, onSettings, onAuth }: { state: ChatState; share?: string | null; align: 'left' | 'right'; onSettings?(): void; onAuth?(auth: 'login' | 'key'): void }) {
  const pop = useRef<HTMLSpanElement>(null), popId = useId(), [open, setOpen] = useState(false), [keyReady, setKeyReady] = useState<boolean | null>(null);
  const key = state.apiKey === true, claude = state.agent === 'claude', locked = state.status !== 'idle', spent = state.apiCostUsd ?? 0;
  useEffect(() => { if (open && claude) void api<{ claude?: { key: string } }>('agent-keys/status').then(status => setKeyReady(Boolean(status.claude?.key)), () => setKeyReady(null)); }, [open, claude]);
  const choose = (auth: 'login' | 'key') => { if (!locked && onAuth && (auth === 'login') === key) { onAuth(auth); pop.current?.hidePopover(); } };
  return <>
    <button type="button" className={`stat chat-stat chat-stat-share usage-basis ${key ? 'api' : 'plan'}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={popId} popoverTarget={popId}>
      <span className="icon material-symbols-outlined" style={{ fontSize: 15 }} aria-hidden="true">{key ? 'key' : 'speed'}</span>
      {key ? <span className="chat-stat-swap">API Usage <b className="usage-money">${dollars(spent)}</b></span> : <span key={share ?? ''} className="chat-stat-swap">{share || 'Plan Usage'}</span>}
      <span className="icon material-symbols-outlined usage-caret" style={{ fontSize: 14 }} aria-hidden="true">expand_less</span>
    </button>
    <span ref={pop} id={popId} popover="auto" role="dialog" aria-label="사용량 방식" className="chat-stat-tip usage-panel" onToggle={event => { const toggle = event as unknown as { newState: string; currentTarget: HTMLElement }; setOpen(toggle.newState === 'open'); placeAbove(toggle, align, 8); }}>
      <span className="usage-head"><strong>이 채팅은 무엇으로 실행할까요</strong><span className="usage-sub">요금·한도를 어디에 쓸지 고릅니다</span></span>
      {claude ? <>
        <span className="usage-options" role="radiogroup" aria-label="로그인 방식">
          <button type="button" role="radio" aria-checked={!key} className="usage-option plan" disabled={locked && key} onClick={() => choose('login')}>
            <span className="usage-radio" aria-hidden="true" />
            <span className="usage-option-body"><b>Plan Usage</b><small>CLI 로그인 플랜 · 5시간·주간 한도를 씁니다</small></span>
          </button>
          <button type="button" role="radio" aria-checked={key} className="usage-option api" disabled={(locked && !key) || (!key && keyReady === false)} onClick={() => choose('key')}>
            <span className="usage-radio" aria-hidden="true" />
            <span className="usage-option-body"><b>API Usage</b><small>API 키 · 토큰만큼 요금이 청구됩니다</small></span>
            {!key && keyReady === false && <span className="usage-badge">키 미등록</span>}
          </button>
        </span>
        {key && <span className="usage-spent"><span>이 API 키로 모든 채팅에서 쓴 요금</span><b>${dollars(spent)}</b></span>}
        {locked && <span className="usage-note"><span className="icon material-symbols-outlined" aria-hidden="true">lock</span>응답이 끝난 뒤 바꿀 수 있습니다.</span>}
        <span className="usage-note"><span className="icon material-symbols-outlined" aria-hidden="true">info</span>전환하면 기존 캐시를 쓸 수 없어 비용이 더 발생할 수 있습니다.</span>
      </> : <span className="usage-note"><span className="icon material-symbols-outlined" aria-hidden="true">info</span>이 에이전트의 로그인 방식은 채팅을 시작할 때 정해집니다.</span>}
      {onSettings && <button type="button" className={`usage-panel-action${!key && keyReady === false && claude ? ' primary' : ''}`} onClick={() => { pop.current?.hidePopover(); onSettings(); }}>
        <span className="icon material-symbols-outlined" aria-hidden="true">{!key && keyReady === false && claude ? 'key' : 'settings'}</span>{!key && keyReady === false && claude ? 'API 키 등록하기' : '설정 열기'}</button>}
    </span>
  </>;
}

function ChatItem({ id, view, align, state, share, onSettings, onAuth }: { id: string; view: NonNullable<ReturnType<typeof chatItemView>>; align: 'left' | 'right'; state: ChatState; share?: string | null; onSettings?(): void; onAuth?(auth: 'login' | 'key'): void }) {
  return <>
    {id === 'share' ? <UsageButton state={state} share={share} align={align} onSettings={onSettings} onAuth={onAuth} />
      : <StatBox cls={`chat-stat-${id}`} icon={view.icon} text={view.text} label={chatStatusLabels[id]} color={view.color} />}
    {view.extra && <StatBox cls={`chat-stat-${id}-extra`} icon={view.extra.icon} text={view.extra.text} label={chatStatusLabels[id]} color={view.color} />}
  </>;
}

// `only`: show just these items (the start screen keeps only the usage item, in its usual place).
export function ChatStatusLine({ settings, context, only, onSettings, onAuth }: { settings: Settings; context: ChatStatusContext; only?: string[]; onSettings?(): void; onAuth?(auth: 'login' | 'key'): void }) {
  // The usage item cannot be switched off: a chat always shows which login pays for it.
  const layout = chatStatusLayout(settings), shown = new Set([...settings.chatStatusItems, 'share'].filter(id => !only || only.includes(id))), separator = settings.chatStatusSeparator;
  // Each item's view is computed once (it was computed again inside the item).
  const nodes = (ids: string[], align: 'left' | 'right') => ids.filter(id => shown.has(id)).flatMap(id => { const view = chatItemView(id, context); return view ? [{ id, node: <ChatItem id={id} view={view} align={align} state={context.state} share={context.share} onSettings={onSettings} onAuth={onAuth} /> }] : []; });
  const render = (list: { id: string; node: ReactNode }[]) => list.map((item, index) => <Fragment key={item.id}>{index > 0 && separator && <span className="chat-sep" aria-hidden="true">{separator}</span>}{item.node}</Fragment>);
  return <footer className="statusbar chat-statusbar" aria-label="채팅 상태 표시줄">
    <div className="status-left">{render(nodes(layout.left, 'left'))}</div>
    <div className="status-right">{render(nodes(layout.right, 'right'))}</div>
  </footer>;
}
