import { Fragment, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { placeAbove } from './Usage';
import { chatStatusLayout, usageHue, type Settings } from './Editor';
import { compact, dollars, contextGauge, contextPercent, contextReported, contextWindow, duration, fillFormat, displayModel, modelAppearance, permissionLabels, permissionModeColor, statusLabelsKo, type ChatState } from './chat-model';

// The chat tab's status line: only items that read the conversation. Branch, changes, usage, clock, CPU, memory and path live in the bottom status bar.
export type ChatStatusContext = { state: ChatState; share?: string | null };
type Def = {
  label: string; hint?: string; icon: string; format: string;
  // A second icon + text group after the main one (tokens: the cache icon with cache writes ↑ and reads ↓). Hidden when `show` says no.
  extra?: { icon: string; format: string; tip: string; show?(context: ChatStatusContext): boolean };
  // The tooltip: its first line is the title, the rest says what the value means.
  tip(context: ChatStatusContext): string;
  // `{token}` values for the template; the item is hidden when this returns null.
  values(context: ChatStatusContext): Record<string, string> | null;
  // 0 (green) to 120 (red) hue, for items that grade like the usage windows.
  hue?(context: ChatStatusContext): number | undefined;
  color?(context: ChatStatusContext): string | undefined;
};

export const chatStatusDefs: Record<string, Def> = {
  status: { label: '진행 상태', icon: 'bolt', format: '{status}', values: ({ state }) => ({ status: state.pending ? `승인 대기 ${state.pending}` : statusLabelsKo[state.status] }),
    hint: '대기 중 · 응답 중 · 승인 대기',
    tip: ({ state }) => `진행 상태\n에이전트가 지금 하는 일입니다. ${state.pending ? `승인을 기다리는 요청이 ${state.pending}개 있습니다.` : '대기 중 · 응답 중 · 승인 대기 중 하나로 표시됩니다.'}` },
  model: { label: '모델', icon: 'smart_toy', format: '{model}', values: ({ state }) => ({ model: displayModel(state.model, state.agent), id: state.model ?? '' }), hint: '{model} 짧은 이름 · {id} 전체 모델 ID', color: ({ state }) => modelAppearance(state.model, state.agent).color,
    tip: ({ state }) => `모델\n이 채팅이 쓰는 모델입니다.${state.model ? `\n${state.model}` : ''}` },
  mode: { label: '권한 모드', icon: 'shield', format: '{mode}', values: ({ state }) => ({ mode: permissionLabels[state.permissionMode] ?? state.permissionMode, id: state.permissionMode }),
    color: ({ state }) => permissionModeColor(state.permissionMode),
    tip: () => '권한 모드\n도구 실행과 파일 수정을 어디까지 자동으로 허용할지 정합니다.' },
  context: { label: '컨텍스트 사용률', icon: 'data_usage', format: '{percent}% · {used}/{window}',
    values: ({ state }) => {
      const gauge = contextGauge(state);
      return { percent: String(gauge.percent), used: compact(gauge.used), window: compact(gauge.basis) };
    },
    hue: ({ state }) => usageHue(contextPercent(state)),
    color: ({ state }) => contextGauge(state).autoCompact ? 'var(--term-magenta)' : undefined,
    hint: '마지막 응답까지 쌓인 토큰 ÷ 기준 창(Auto Compact 창, 없으면 최대 컨텍스트). {percent} {used} {window}',
    tip: ({ state }) => { const gauge = contextGauge(state); return `컨텍스트 사용률\n마지막 응답까지 대화에 쌓인 ${compact(gauge.used)} 토큰이 기준 창 ${compact(gauge.basis)} 토큰에서 차지하는 비율입니다. 가득 차면 대화가 압축됩니다.`; } },
  tokens: { label: '토큰', icon: 'token', format: '↑{input} ↓{output}', values: ({ state }) => ({ input: compact(state.tokens.input), output: compact(state.tokens.output), cache: compact(state.tokens.cacheRead), cacheWrite: compact(state.tokens.cacheCreate), total: compact(state.tokens.input + state.tokens.output) }),
    extra: { icon: 'database', format: '↑{cacheWrite} ↓{cache}', tip: '프롬프트 캐시 (누적)\n↑ 쓰기: 캐시에 새로 저장한 토큰\n↓ 읽기: 캐시에서 다시 읽은 토큰 (훨씬 저렴)\n이 채팅 전체의 합계입니다.', show: ({ state }) => state.tokens.cacheRead + state.tokens.cacheCreate > 0 },
    tip: () => '토큰 (누적)\n↑ 입력: 모델에 보낸 토큰\n↓ 출력: 모델이 답하며 만든 토큰\n이 채팅 전체의 합계입니다.',
    hint: '이 채팅의 누적 토큰. 캐시 아이콘 뒤는 ↑캐시 쓰기 ↓캐시 읽기. {input} {output} {cache}(캐시 읽기) {cacheWrite}(캐시 쓰기) {total}' },
  cost: { label: '비용', icon: 'payments', format: '${cost}', values: ({ state }) => state.costUsd === null ? { cost: '미제공' } : ({ cost: dollars(state.costUsd) }), hint: 'CLI가 보고한 세션 비용(USD)',
    tip: () => '비용\nCLI가 보고한 이 채팅의 누적 비용(USD)입니다.' },
  // Until a turn has been measured (and always on an API key, or for Codex/Cursor) the item names what this chat is billed against; the measured share replaces it.
  share: { label: '사용량 기여도', icon: 'speed', format: '{share}', values: ({ state, share }) => ({ share: usageBasis(state, share) }),
    tip: ({ state, share }) => state.apiKey ? 'API Usage\n이 채팅은 API 키로 실행돼 토큰만큼 API로 과금됩니다. 플랜 한도는 쓰지 않습니다.'
      : share ? `사용량 기여도\n이 채팅이 플랜 한도(5시간·주간)에서 차지한 비율(%p)의 추정치입니다.` : 'Plan Usage\nCLI 로그인 플랜의 한도를 씁니다. 한 턴이 측정되면 이 채팅이 차지한 비율로 바뀝니다.',
    hint: 'API 키 채팅은 ‘API Usage’(토큰 과금), CLI 로그인 채팅은 측정 전 ‘Plan Usage’로 표시하고, 측정되면 이 채팅이 플랜 한도(5h·주)에서 차지한 %p(추정)로 바뀝니다.' },
  turns: { label: '턴 수', icon: 'forum', format: '{turns}턴', values: ({ state }) => ({ turns: String(state.turns) }), tip: () => '턴 수\n사용자가 보내고 답변이 끝난 횟수입니다.' },
  duration: { label: '누적 소요 시간', icon: 'timer', format: '{time}', values: ({ state }) => ({ time: duration(state.durationMs) }), tip: () => '누적 소요 시간\n답변을 만드는 데 걸린 시간의 합계입니다. 사용자가 입력하는 시간은 빠집니다.' },
  session: { label: '세션 ID', icon: 'tag', format: '{short}', values: ({ state }) => state.sessionId ? { short: state.sessionId.slice(0, 8), id: state.sessionId } : null,
    tip: ({ state }) => `세션 ID\nCLI가 이 대화에 붙인 ID입니다.${state.sessionId ? `\n${state.sessionId}` : ''}` },
};
// What a chat's usage is counted against: an API key's tokens, or the CLI login's plan (its measured share once there is one).
export const usageBasis = (state: ChatState, share?: string | null) => state.apiKey ? 'API Usage' : share || 'Plan Usage';
export const chatStatusLabels: Record<string, string> = Object.fromEntries(Object.entries(chatStatusDefs).map(([id, def]) => [id, def.label]));

export const chatItemView = (id: string, context: ChatStatusContext): { text: string; icon: string; color?: string; tip: string; extra?: { text: string; icon: string; tip: string } } | null => {
  const def = chatStatusDefs[id]; if (!def) return null;
  const values = def.values(context); if (!values) return null;
  const { state } = context;
  if (id === 'cost' && state.costUsd === null || id === 'tokens' && state.capabilities?.tokens === false) return null;
  if (id === 'context' && (state.capabilities?.context === false || !contextReported(state))) return null;
  const hue = def.hue?.(context);
  const extra = def.extra && (def.extra.show?.(context) ?? true) ? { text: fillFormat(def.extra.format, values), icon: def.extra.icon, tip: def.extra.tip } : undefined;
  return { text: fillFormat(def.format, values), icon: def.icon, extra, tip: def.tip(context), color: def.color?.(context) ?? (hue !== undefined ? `hsl(${hue} 65% var(--usage-l, 55%))` : undefined) };
};

// One box of the status line. Hover or focus lights it and opens a tooltip in the top layer (the line clips its own overflow) that says what the value means.
function StatBox({ cls, icon, text, tip, color, align, swap }: { cls: string; icon: string; text: string; tip: string; color?: string; align: 'left' | 'right'; swap?: boolean }) {
  const pop = useRef<HTMLSpanElement>(null), popId = useId(), [title, ...lines] = tip.split('\n');
  const open = () => { const el = pop.current; if (!el || el.matches(':popover-open')) return; el.showPopover(); placeAbove({ newState: 'open', currentTarget: el }, align, 6); };
  const close = () => { try { pop.current?.hidePopover(); } catch { /* already closed */ } };
  return <>
    <span className={`stat chat-stat ${cls}`} tabIndex={0} aria-describedby={popId} style={color ? { color } as CSSProperties : undefined} onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close}>
      <span className="icon material-symbols-outlined" style={{ fontSize: 15 }} aria-hidden="true">{icon}</span>
      {/* The usage item turns from its label into the measured share: a new key fades the new text in. */}
      {swap ? <span key={text} className="chat-stat-swap">{text}</span> : text}
    </span>
    <span ref={pop} id={popId} popover="manual" role="tooltip" className="chat-stat-tip"><strong>{title}</strong>{lines.map((line, at) => <span key={at}>{line}</span>)}</span>
  </>;
}

function ChatItem({ id, view, align }: { id: string; view: NonNullable<ReturnType<typeof chatItemView>>; align: 'left' | 'right' }) {
  return <>
    <StatBox cls={`chat-stat-${id}`} icon={view.icon} text={view.text} tip={view.tip} color={view.color} align={align} swap={id === 'share'} />
    {view.extra && <StatBox cls={`chat-stat-${id}-extra`} icon={view.extra.icon} text={view.extra.text} tip={view.extra.tip} color={view.color} align={align} />}
  </>;
}

// `only`: show just these items (the start screen keeps only the usage item, in its usual place).
export function ChatStatusLine({ settings, context, only }: { settings: Settings; context: ChatStatusContext; only?: string[] }) {
  const layout = chatStatusLayout(settings), shown = new Set(settings.chatStatusItems.filter(id => !only || only.includes(id))), separator = settings.chatStatusSeparator;
  // Each item's view is computed once (it was computed again inside the item).
  const nodes = (ids: string[], align: 'left' | 'right') => ids.filter(id => shown.has(id)).flatMap(id => { const view = chatItemView(id, context); return view ? [{ id, node: <ChatItem id={id} view={view} align={align} /> }] : []; });
  const render = (list: { id: string; node: ReactNode }[]) => list.map((item, index) => <Fragment key={item.id}>{index > 0 && separator && <span className="chat-sep" aria-hidden="true">{separator}</span>}{item.node}</Fragment>);
  return <footer className="statusbar chat-statusbar" aria-label="채팅 상태 표시줄">
    <div className="status-left">{render(nodes(layout.left, 'left'))}</div>
    <div className="status-right">{render(nodes(layout.right, 'right'))}</div>
  </footer>;
}
