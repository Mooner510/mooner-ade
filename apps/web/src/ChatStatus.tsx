import { Fragment, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from './api';
import { placeAbove } from './Usage';
import { chatStatusLayout, usageHue, type Settings } from './Editor';
import { compact, dollars, contextGauge, contextPercent, contextReported, contextWindow, duration, fillFormat, displayModel, modelAppearance, permissionLabel, permissionModeColor, statusLabelsKo, type ChatState } from './chat-model';

// The chat tab's status line: only items that read the conversation. Branch, changes, usage, clock, CPU, memory and path live in the bottom status bar.
export type ChatStatusContext = { state: ChatState; share?: string | null };
type Def = {
  label: string; hint?: string; icon: string; format: string;
  // A second icon + text group after the main one (tokens: the cache icon with cache writes ↑ and reads ↓). Hidden when `show` says no.
  extra?: { icon: string; format: string; tip: string; show?(context: ChatStatusContext): boolean };
  tip?(context: ChatStatusContext): string;
  // `{token}` values for the template; the item is hidden when this returns null.
  values(context: ChatStatusContext): Record<string, string> | null;
  // 0 (green) to 120 (red) hue, for items that grade like the usage windows.
  hue?(context: ChatStatusContext): number | undefined;
  color?(context: ChatStatusContext): string | undefined;
};

export const chatStatusDefs: Record<string, Def> = {
  status: { label: '진행 상태', icon: 'bolt', format: '{status}', values: ({ state }) => ({ status: state.pending ? `승인 대기 ${state.pending}` : statusLabelsKo[state.status] }),
    hint: '대기 중 · 응답 중 · 승인 대기' },
  model: { label: '모델', icon: 'smart_toy', format: '{model}', values: ({ state }) => ({ model: displayModel(state.model, state.agent), id: state.model ?? '' }), hint: '{model} 짧은 이름 · {id} 전체 모델 ID', color: ({ state }) => modelAppearance(state.model, state.agent).color,
    tip: ({ state }) => state.model ? `모델 ID\n${state.model}` : '모델' },
  mode: { label: '권한 모드', icon: 'shield', format: '{mode}', values: ({ state }) => ({ mode: permissionLabel(state.permissionMode, state.agent), id: state.permissionMode }),
    color: ({ state }) => permissionModeColor(state.permissionMode),
    tip: () => '권한 모드' },
  context: { label: '컨텍스트 사용률', icon: 'data_usage', format: '{percent}% · {used}/{window}',
    values: ({ state }) => {
      const gauge = contextGauge(state);
      return { percent: String(gauge.percent), used: compact(gauge.used), window: compact(gauge.basis) };
    },
    hue: ({ state }) => usageHue(contextPercent(state)),
    color: ({ state }) => contextGauge(state).autoCompact ? 'var(--term-magenta)' : undefined,
    hint: '마지막 응답까지 쌓인 토큰 ÷ 기준 창(Auto Compact 창, 없으면 최대 컨텍스트). {percent} {used} {window}',
    tip: () => '컨텍스트 사용률\n사용 토큰 / 기준 창' },
  tokens: { label: '토큰', icon: 'token', format: '↑{input} ↓{output}', values: ({ state }) => ({ input: compact(state.tokens.input), output: compact(state.tokens.output), cache: compact(state.tokens.cacheRead), cacheWrite: compact(state.tokens.cacheCreate), total: compact(state.tokens.input + state.tokens.output) }),
    extra: { icon: 'database', format: '↑{cacheWrite} ↓{cache}', tip: '누적 캐시 토큰\n↑ 쓰기 · ↓ 읽기', show: ({ state }) => state.tokens.cacheRead + state.tokens.cacheCreate > 0 },
    tip: () => '누적 토큰\n↑ 입력 · ↓ 출력',
    hint: '이 채팅의 누적 토큰. 캐시 아이콘 뒤는 ↑캐시 쓰기 ↓캐시 읽기. {input} {output} {cache}(캐시 읽기) {cacheWrite}(캐시 쓰기) {total}' },
  cost: { label: '비용', icon: 'payments', format: '${cost}', values: ({ state }) => state.costUsd === null ? { cost: '미제공' } : ({ cost: dollars(state.costUsd) }), hint: '이 채팅에서 든 비용(USD) · CLI가 보고한 세션 비용' ,
    tip: () => '이 채팅에서 든 비용 (USD)' },
  // Until a turn has been measured (and always on an API key, or for Codex/Cursor) the item names what this chat is billed against; the measured share replaces it.
  share: { label: '사용량 기여도', icon: 'speed', format: '{share}', values: ({ state, share }) => ({ share: usageBasis(state, share) }),
    hint: 'API 키 채팅은 ‘API Usage’(토큰 과금), CLI 로그인 채팅은 측정 전 ‘Plan Usage’로 표시하고, 측정되면 이 채팅이 플랜 한도에서 차지한 %p(추정)로 바뀝니다. Claude·Codex는 5시간과 주간, Cursor는 이 채팅 모델의 풀과 전체입니다.' },
  turns: { label: '턴 수', icon: 'forum', format: '{turns}턴', values: ({ state }) => ({ turns: String(state.turns) }) },
  duration: { label: '누적 소요 시간', icon: 'timer', format: '{time}', values: ({ state }) => ({ time: duration(state.durationMs) }), tip: () => '누적 응답 시간' },
  session: { label: '세션 ID', icon: 'tag', format: '{short}', values: ({ state }) => state.sessionId ? { short: state.sessionId.slice(0, 8), id: state.sessionId } : null,
    tip: ({ state }) => `세션 ID\n${state.sessionId}` },
};
// What a chat's usage is counted against: an API key's tokens, or the CLI login's plan (its measured share once there is one).
// Until a turn has been measured the item names what the chat is billed against; the measured share of the plan limits replaces it.
export const usageBasis = (state: ChatState, share?: string | null) => state.apiKey ? 'API Usage' : share || 'Plan Usage';
export const chatStatusLabels: Record<string, string> = Object.fromEntries(Object.entries(chatStatusDefs).map(([id, def]) => [id, def.label]));

export const chatItemView = (id: string, context: ChatStatusContext): { text: string; icon: string; color?: string; tip?: string; extra?: { text: string; icon: string; tip: string } } | null => {
  const def = chatStatusDefs[id]; if (!def) return null;
  const values = def.values(context); if (!values) return null;
  const { state } = context;
  if (id === 'cost' && state.costUsd === null || id === 'tokens' && state.capabilities?.tokens === false) return null;
  if (id === 'context' && (state.capabilities?.context === false || !contextReported(state))) return null;
  const hue = def.hue?.(context);
  const extra = def.extra && (def.extra.show?.(context) ?? true) ? { text: fillFormat(def.extra.format, values), icon: def.extra.icon, tip: def.extra.tip } : undefined;
  return { text: fillFormat(def.format, values), icon: def.icon, extra, tip: def.tip?.(context), color: def.color?.(context) ?? (hue !== undefined ? `hsl(${hue} 65% var(--usage-l, 55%))` : undefined) };
};

// One box of the status line. Hover or focus lights it and opens a tooltip in the top layer (the line clips its own overflow) that says what the value means.
function StatBox({ cls, icon, text, tip, color, align }: { cls: string; icon: string; text: string; tip?: string; color?: string; align: 'left' | 'right' }) {
  const pop = useRef<HTMLSpanElement>(null), popId = useId(), [title, ...lines] = tip?.split('\n') ?? [];
  const open = () => { const el = pop.current; if (!el || el.matches(':popover-open')) return; el.showPopover(); placeAbove({ newState: 'open', currentTarget: el }, align, 6); };
  const close = () => { try { pop.current?.hidePopover(); } catch { /* already closed */ } };
  return <>
    <span className={`stat chat-stat ${cls}`} tabIndex={tip ? 0 : undefined} aria-describedby={tip ? popId : undefined} style={color ? { color } as CSSProperties : undefined} onMouseEnter={tip ? open : undefined} onMouseLeave={tip ? close : undefined} onFocus={tip ? open : undefined} onBlur={tip ? close : undefined}>
      <span className="icon material-symbols-outlined" style={{ fontSize: 15 }} aria-hidden="true">{icon}</span>
      {text}
    </span>
    {tip && <span ref={pop} id={popId} popover="manual" role="tooltip" className="chat-stat-tip"><strong>{title}</strong>{lines.map((line, at) => <span key={at}>{line}</span>)}</span>}
  </>;
}

// The usage item is a button and the switch: it names what this chat is billed against (Plan Usage, or API Usage with the money it has cost) and,
// pressed, lets a Claude chat go on with the CLI plan or the API key. Switching is silent; the composer asks before the first message that would
// change the login of a chat that has had a turn (the two logins do not share a prompt cache). The key itself is registered in Settings > AI 툴.
// Claude's prompt-cache lifetime (Settings > AI 툴 too): 자동 leaves it to the CLI, the others force it. It applies to chats started or relaunched afterwards.
export const cacheTtlOptions: { value: CacheTtl; label: string; hint: string }[] = [
  { value: 'auto', label: '자동', hint: 'CLI 기본값 (API 키 5분, 구독 1시간)' },
  { value: '5m', label: '5분', hint: '캐시 쓰기 요금이 가장 낮음' },
  { value: '1h', label: '1시간', hint: '쓰기 요금 2배, 오래 쉬어도 캐시 유지' },
];
export type CacheTtl = 'auto' | '5m' | '1h';

/** The 자동 / 5분 / 1시간 choice and what the selected one costs, as the chat's usage panel shows it. */
export function CacheTtlPicker({ value, onChange }: { value: CacheTtl; onChange(value: CacheTtl): void }) {
  return <div className="usage-ttl-section">
    <div className="usage-ttl-head"><strong className="usage-head">캐시 유지 시간</strong><span className="usage-ttl-tag">다음 응답부터 적용</span></div>
    <span className="usage-ttl" role="radiogroup" aria-label="캐시 유지 시간">
      {cacheTtlOptions.map(option => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} className="usage-ttl-option" onClick={() => onChange(option.value)}>{option.label}</button>)}
    </span>
    <span className="usage-ttl-hint">{cacheTtlOptions.find(option => option.value === value)?.hint}</span>
  </div>;
}

// The usage text fades in when what it names changes while it is shown (Plan Usage → a measured share, Plan ↔ API). A fresh mount does not fade:
// moving the item to the other side of the line (a layout change) mounts it again, and the keyframes run on every insertion.
function SwapText({ name, children }: { name: string; children: ReactNode }) {
  const [shown, setShown] = useState({ name, turn: 0 });
  if (shown.name !== name) setShown({ name, turn: shown.turn + 1 });
  return <span key={shown.turn} className={shown.turn ? 'chat-stat-swap' : undefined}>{children}</span>;
}

function UsageButton({ state, share, align, onSettings, onAuth }: { state: ChatState; share?: string | null; align: 'left' | 'right'; onSettings?(): void; onAuth(auth: 'login' | 'key'): void }) {
  const pop = useRef<HTMLSpanElement>(null), popId = useId(), [open, setOpen] = useState(false), [keyReady, setKeyReady] = useState<boolean | null>(null), [ttl, setTtl] = useState<CacheTtl>('auto');
  const key = state.apiKey === true, locked = state.status !== 'idle', spent = state.apiCostUsd ?? 0;
  const needsKey = !key && keyReady === false;
  const choose = (auth: 'login' | 'key') => { if (!locked && (auth === 'login') === key) { onAuth(auth); pop.current?.hidePopover(); } };
  useEffect(() => { if (open) void api<{ claude?: { key: string }; cacheTtl?: CacheTtl }>('agent-keys/status').then(status => { setKeyReady(Boolean(status.claude?.key)); setTtl(status.cacheTtl ?? 'auto'); }, () => setKeyReady(null)); }, [open]);
  const chooseTtl = (value: CacheTtl) => { const before = ttl; setTtl(value); void api('agent-keys/config', { agent: 'claude', cacheTtl: value }).catch(() => setTtl(before)); };
  const openSettings = () => { pop.current?.hidePopover(); onSettings?.(); };
  return <>
    <button type="button" className={`stat chat-stat chat-stat-share usage-basis ${key ? 'api' : 'plan'}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={popId} popoverTarget={popId}>
      <span className="icon material-symbols-outlined" style={{ fontSize: 15 }} aria-hidden="true">{key ? 'key' : 'speed'}</span>
      <SwapText name={key ? 'API Usage' : share || 'Plan Usage'}>{key ? <>API Usage <b className="usage-money">${dollars(spent)}</b></> : share || 'Plan Usage'}</SwapText>
      <span className="icon material-symbols-outlined usage-caret" style={{ fontSize: 14 }} aria-hidden="true">expand_less</span>
    </button>
    <span ref={pop} id={popId} popover="auto" role="dialog" aria-label="채팅 사용 방식" className="chat-stat-tip usage-panel" onToggle={event => { const toggle = event as unknown as { newState: string; currentTarget: HTMLElement }; setOpen(toggle.newState === 'open'); placeAbove(toggle, align, 8); }}>
      <span className="usage-head-row">
        <strong className="usage-head">채팅 사용 방식</strong>
        {onSettings && <button type="button" className="usage-panel-action usage-settings" aria-label="설정" title="설정" onClick={openSettings}><span className="icon material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">settings</span></button>}
      </span>
      <span role="radiogroup" aria-label="로그인 방식">
        <button type="button" role="radio" aria-checked={!key} className="usage-option plan" disabled={locked && key} onClick={() => choose('login')}>
          <span>구독 플랜<small>5시간·주간 한도</small></span>
          {!key && <span className="icon material-symbols-outlined usage-check" aria-hidden="true">check</span>}
        </button>
        <span className="usage-api-row">
          <button type="button" role="radio" aria-checked={key} className="usage-option api" disabled={(locked && !key) || needsKey} onClick={() => choose('key')}>
            <span>API 키<small>토큰 사용량에 따라 과금</small></span>
            {key && <span className="icon material-symbols-outlined usage-check" aria-hidden="true">check</span>}
          </button>
          {needsKey && (onSettings ? <button type="button" className="usage-panel-action" onClick={openSettings}>키 등록</button> : <span className="usage-note">키 필요</span>)}
        </span>
      </span>
      <CacheTtlPicker value={ttl} onChange={chooseTtl} />
      {locked && <span className="usage-note">로그인 방식은 응답이 끝난 뒤 바꿀 수 있습니다.</span>}
    </span>
  </>;
}

function ChatItem({ id, view, align, state, share, onSettings, onAuth }: { id: string; view: NonNullable<ReturnType<typeof chatItemView>>; align: 'left' | 'right'; state: ChatState; share?: string | null; onSettings?(): void; onAuth?(auth: 'login' | 'key'): void }) {
  const apiUsage = id === 'share' && state.apiKey;
  return <>
    {id === 'share' && state.agent === 'claude' && onAuth ? <UsageButton state={state} share={share} align={align} onSettings={onSettings} onAuth={onAuth} />
      : <StatBox cls={`chat-stat-${id}`} icon={apiUsage ? 'key' : view.icon} text={apiUsage ? `${view.text} $${dollars(state.apiCostUsd ?? 0)}` : view.text} tip={view.tip} color={view.color} align={align} />}
    {view.extra && <StatBox cls={`chat-stat-${id}-extra`} icon={view.extra.icon} text={view.extra.text} tip={view.extra.tip} color={view.color} align={align} />}
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
