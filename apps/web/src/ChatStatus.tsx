import { Fragment, type CSSProperties, type ReactNode } from 'react';
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
  cost: { label: '비용', icon: 'payments', format: '${cost}', values: ({ state }) => state.costUsd === null ? { cost: '미제공' } : ({ cost: dollars(state.costUsd) }), hint: 'CLI가 보고한 세션 비용(USD)' },
  // Until a turn has been measured (and always on an API key, or for Codex/Cursor) the item names what this chat is billed against; the measured share replaces it.
  share: { label: '사용량 기여도', icon: 'speed', format: '{share}', values: ({ state, share }) => ({ share: usageBasis(state, share) }),
    hint: 'API 키 채팅은 ‘API Usage’(토큰 과금), CLI 로그인 채팅은 측정 전 ‘Plan Usage’로 표시하고, 측정되면 이 채팅이 플랜 한도(5h·주)에서 차지한 %p(추정)로 바뀝니다.' },
  turns: { label: '턴 수', icon: 'forum', format: '{turns}턴', values: ({ state }) => ({ turns: String(state.turns) }) },
  duration: { label: '누적 소요 시간', icon: 'timer', format: '{time}', values: ({ state }) => ({ time: duration(state.durationMs) }) },
  session: { label: '세션 ID', icon: 'tag', format: '{short}', values: ({ state }) => state.sessionId ? { short: state.sessionId.slice(0, 8), id: state.sessionId } : null },
};
// What a chat's usage is counted against: an API key's tokens, or the CLI login's plan (its measured share once there is one).
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

function ChatItem({ id, view }: { id: string; view: NonNullable<ReturnType<typeof chatItemView>> }) {
  return <span className={`stat chat-stat chat-stat-${id}`} title={chatStatusLabels[id]} style={view.color ? { color: view.color } as CSSProperties : undefined}>
    <span className="icon material-symbols-outlined" style={{ fontSize: 15 }} aria-hidden="true">{view.icon}</span>
    {/* The usage item turns from its label into the measured share: a new key fades the new text in. */}
    {id === 'share' ? <span key={view.text} className="chat-stat-swap">{view.text}</span> : view.text}
    {view.extra && <><span className="icon material-symbols-outlined" style={{ fontSize: 15, marginLeft: 6 }} aria-hidden="true">{view.extra.icon}</span>{view.extra.text}</>}</span>;
}

// `only`: show just these items (the start screen keeps only the usage item, in its usual place).
export function ChatStatusLine({ settings, context, only }: { settings: Settings; context: ChatStatusContext; only?: string[] }) {
  const layout = chatStatusLayout(settings), shown = new Set(settings.chatStatusItems.filter(id => !only || only.includes(id))), separator = settings.chatStatusSeparator;
  // Each item's view is computed once (it was computed again inside the item).
  const nodes = (ids: string[]) => ids.filter(id => shown.has(id)).flatMap(id => { const view = chatItemView(id, context); return view ? [{ id, node: <ChatItem id={id} view={view} /> }] : []; });
  const render = (list: { id: string; node: ReactNode }[]) => list.map((item, index) => <Fragment key={item.id}>{index > 0 && separator && <span className="chat-sep" aria-hidden="true">{separator}</span>}{item.node}</Fragment>);
  return <footer className="statusbar chat-statusbar" aria-label="채팅 상태 표시줄">
    <div className="status-left">{render(nodes(layout.left))}</div>
    <div className="status-right">{render(nodes(layout.right))}</div>
  </footer>;
}
