import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { chatStatusLayout, usageHue, type Settings } from './Editor';
import { compact, contextGauge, contextPercent, contextWindow, duration, fillFormat, displayModel, modelAppearance, permissionLabels, permissionModeColor, statusLabelsKo, type ChatState } from './chat-model';

// The chat tab's status line: only items that read the conversation. Branch, changes, usage, clock, CPU, memory and path live in the bottom status bar.
export type ChatStatusContext = { state: ChatState };
type Def = {
  label: string; hint?: string; icon: string; format: string;
  // `{token}` values for the template; the item is hidden when this returns null.
  values(context: ChatStatusContext): Record<string, string> | null;
  // 0 (green) to 120 (red) hue, for items that grade like the usage windows.
  hue?(context: ChatStatusContext): number | undefined;
  color?(context: ChatStatusContext): string | undefined;
};

export const chatStatusDefs: Record<string, Def> = {
  status: { label: '진행 상태', icon: 'bolt', format: '{status}', values: ({ state }) => ({ status: state.pending ? `승인 대기 ${state.pending}` : statusLabelsKo[state.status] }),
    hint: '대기 중 · 응답 중 · 승인 대기' },
  model: { label: '모델', icon: 'smart_toy', format: '{model}', values: ({ state }) => ({ model: displayModel(state.model, state.agent), id: state.model ?? '' }), hint: '{model} 짧은 이름 · {id} 전체 모델 ID. 모델 계열마다 색이 다릅니다.', color: ({ state }) => modelAppearance(state.model, state.agent).color },
  mode: { label: '권한 모드', icon: 'shield', format: '{mode}', values: ({ state }) => ({ mode: permissionLabels[state.permissionMode] ?? state.permissionMode, id: state.permissionMode }),
    color: ({ state }) => permissionModeColor(state.permissionMode) },
  context: { label: '컨텍스트 사용률', icon: 'data_usage', format: '{percent}% · {used}/{window}',
    values: ({ state }) => {
      const gauge = contextGauge(state);
      return { percent: String(gauge.percent), used: compact(gauge.used), window: compact(gauge.basis) };
    },
    hue: ({ state }) => usageHue(contextPercent(state)),
    color: ({ state }) => contextGauge(state).autoCompact ? 'var(--term-magenta)' : undefined,
    hint: '마지막 응답까지 쌓인 토큰 ÷ 기준 창. Auto Compact가 켜져 있으면 %는 Auto Compact 창 기준(게이지·상세와 동일), 아니면 최대 컨텍스트(CLI 보고값, 첫 응답 전에는 추정). {percent} {used} {window}' },
  tokens: { label: '토큰', icon: 'token', format: '↑{input} ↓{output}', values: ({ state }) => ({ input: compact(state.tokens.input), output: compact(state.tokens.output), cache: compact(state.tokens.cacheRead), total: compact(state.tokens.input + state.tokens.output) }),
    hint: '이 채팅의 누적. {input} {output} {cache}(캐시 읽기) {total}' },
  cost: { label: '비용', icon: 'payments', format: '${cost}', values: ({ state }) => state.costUsd === null ? { cost: '미제공' } : ({ cost: state.costUsd?.toFixed(2) ?? '미제공' }), hint: 'CLI가 보고한 세션 비용(USD)' },
  turns: { label: '턴 수', icon: 'forum', format: '{turns}턴', values: ({ state }) => ({ turns: String(state.turns) }) },
  duration: { label: '누적 소요 시간', icon: 'timer', format: '{time}', values: ({ state }) => ({ time: duration(state.durationMs) }) },
  session: { label: '세션 ID', icon: 'tag', format: '{short}', values: ({ state }) => state.sessionId ? { short: state.sessionId.slice(0, 8), id: state.sessionId } : null },
};
export const chatStatusLabels: Record<string, string> = Object.fromEntries(Object.entries(chatStatusDefs).map(([id, def]) => [id, def.label]));

export const chatItemView = (id: string, context: ChatStatusContext): { text: string; icon: string; color?: string } | null => {
  const def = chatStatusDefs[id]; if (!def) return null;
  const values = def.values(context); if (!values) return null;
  const { state } = context; if (id === 'cost' && state.costUsd === null || id === 'tokens' && state.capabilities?.tokens === false || id === 'context' && state.capabilities?.context === false) return null;
  const hue = def.hue?.(context);
  return { text: fillFormat(def.format, values), icon: def.icon, color: def.color?.(context) ?? (hue !== undefined ? `hsl(${hue} 65% var(--usage-l, 55%))` : undefined) };
};

function ChatItem({ id, context }: { id: string; context: ChatStatusContext }) {
  const view = chatItemView(id, context); if (!view) return null;
  return <span className={`stat chat-stat chat-stat-${id}`} title={chatStatusLabels[id]} style={view.color ? { color: view.color } as CSSProperties : undefined}>
    <span className="icon material-symbols-outlined" style={{ fontSize: 15 }} aria-hidden="true">{view.icon}</span>{view.text}</span>;
}

export function ChatStatusLine({ settings, context }: { settings: Settings; context: ChatStatusContext }) {
  const layout = chatStatusLayout(settings), shown = new Set(settings.chatStatusItems), separator = settings.chatStatusSeparator;
  const nodes = (ids: string[]) => ids.filter(id => shown.has(id)).flatMap(id => {
    const node = chatItemView(id, context) ? <ChatItem id={id} context={context} /> : null;
    return node ? [{ id, node }] : [];
  });
  const render = (list: { id: string; node: ReactNode }[]) => list.map((item, index) => <Fragment key={item.id}>{index > 0 && separator && <span className="chat-sep" aria-hidden="true">{separator}</span>}{item.node}</Fragment>);
  return <footer className="statusbar chat-statusbar" aria-label="채팅 상태 표시줄">
    <div className="status-left">{render(nodes(layout.left))}</div>
    <div className="status-right">{render(nodes(layout.right))}</div>
  </footer>;
}
