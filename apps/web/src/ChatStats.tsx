import { useEffect, useState, type CSSProperties } from 'react';
import { Icon } from './Icon';
import { Modal } from './views';
import { compact, dollars, duration } from './chat-model';

// Statistics of one Claude conversation (server: chat-stats.js, read from the transcript the CLI keeps; nothing is sent anywhere).
export type Stats = {
  sessionId: string; requests: number; subRequests: number; turns: number; compactions: number; compactionAt: number[]; startedAt: number | null; endedAt: number | null; activeMs: number;
  tokens: { input: number; output: number; thinking: number; read: number; write5m: number; write1h: number }; cacheHitRate: number | null; peakContext: number;
  cost: { totalUsd: number; toolMs: number; linesAdded: number; linesRemoved: number } | null;
  models: { model: string; requests: number; input: number; output: number; read: number; write: number; costUsd: number | null }[];
  tools: { name: string; count: number; errors: number }[]; toolCalls: number;
  timeline: { at: number; ctx: number; output: number; costUsd: number | null; turn: number; sub: boolean }[];
  turnSeries: { index: number; at: number | null; requests: number; output: number; ctx: number; costUsd: number | null; ms: number }[];
  blocks: { start: number; end: number; requests: number; tokens: number; costUsd: number | null }[];
};

const money = (value: number | null) => value === null ? '—' : `$${dollars(value)}`;
const clock = (at: number) => new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const shortModel = (model: string) => model.replace(/^claude-/, '');

// Series colours: the first four slots of the validated categorical palette, one per token kind, in a fixed order.
const kinds = [['input', '입력'], ['output', '출력'], ['read', '캐시 읽기'], ['write', '캐시 쓰기']] as const;

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="stats-tile" title={hint}><small>{label}</small><b>{value}</b></div>;
}

// The context size of every request as a line, with each turn drawn on it: a dot where the turn was asked, a shaded band over the requests it took, and under the dot a
// thin bar for its cost. One x position (pct) feeds the line, dots, bars and numbers, so they line up exactly; bars share one width, so only height says "more".
type Turn = Stats['turnSeries'][number];
function TurnChart({ stats, value, unit, short, unitName }: { stats: Stats; value(turn: Turn): number; unit(turn: Turn): string; short(turn: Turn): string; unitName: string }) {
  const [hover, setHover] = useState<number | null>(null), points = stats.timeline, count = points.length;
  if (count < 2 || !stats.turnSeries.length) return <p className="stats-empty">그래프를 그리려면 요청이 2개 이상 필요합니다.</p>;
  const last = count - 1, pct = (index: number) => (index / last) * 100, maxCtx = Math.max(1, ...points.map(point => point.ctx)), y = (ctx: number) => 92 - (ctx / maxCtx) * 78;
  // A turn starts at its first request; the timeline can be thinned, so a turn whose first request was dropped starts at the next kept one, and two turns that land
  // on the same point keep the later one. ponytail: that turn's cost bar is then hidden, rare below ~240 requests.
  const found = stats.turnSeries.map(turn => ({ turn, start: points.findIndex(point => point.turn >= turn.index) })).filter(span => span.start >= 0);
  const spans = found.filter((span, index) => index + 1 === found.length || found[index + 1].start !== span.start).map((span, index, all) => ({ ...span, end: index + 1 < all.length ? all[index + 1].start : last }));
  const maxValue = Math.max(1e-9, ...spans.map(span => value(span.turn))), top = spans.find(span => value(span.turn) === maxValue)!.turn;
  const minGap = Math.min(100, ...spans.slice(1).map((span, index) => pct(span.start) - pct(spans[index].start)));
  let shown = -Infinity; const labelled = new Set(spans.map((span, index) => { if (pct(span.start) - shown < 3.2) return -1; shown = pct(span.start); return index; })); // numbers only where they do not touch
  // Amounts written on the bars: the costliest turns first, each only if no already written one is within 8% of the width (the hovered turn is always written).
  const priced = new Set<number>(); [...spans.keys()].sort((a, b) => value(spans[b].turn) - value(spans[a].turn)).forEach(index => { if (priced.size < 5 && value(spans[index].turn) > 0 && [...priced].every(other => Math.abs(pct(spans[other].start) - pct(spans[index].start)) >= 8)) priced.add(index); });
  const marks = stats.compactionAt.map(at => points.reduce((best, point, index) => Math.abs(point.at - at) < Math.abs(points[best].at - at) ? index : best, 0));
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${pct(index).toFixed(2)} ${y(point.ctx).toFixed(2)}`).join(' ');
  const active = hover === null ? -1 : spans.reduce((found, span, index) => span.start <= hover ? index : found, -1), turn = active >= 0 ? spans[active].turn : null;
  return <div className="stats-chart">
    <div className="tc-legend"><span><i className="d" />컨텍스트 <b>최대 {compact(maxCtx)}</b></span><span><i className="d" style={{ borderRadius: '50%' }} />턴을 요청한 시점</span><span><i className="b" />{unitName} <b>최대 {unit(top)}</b></span></div>
    <div className="stats-readout" aria-live="polite">{hover === null ? '그래프에 마우스를 올리면 그 요청과 턴의 값을 봅니다' : `${turn ? `#${turn.index} · ${unit(turn)} · 요청 ${turn.requests}${turn.ms ? ` · ${duration(turn.ms)}` : ''} · ` : ''}${clock(points[hover].at)} · 컨텍스트 ${compact(points[hover].ctx)}${points[hover].sub ? ' · 서브에이전트' : ''}${marks.includes(hover) ? ' · 컴팩션' : ''}`}</div>
    <div className="turn-chart">
      <div className="tc-plot" role="img" aria-label="요청별 컨텍스트 크기와 턴별 비용" onMouseLeave={() => setHover(null)}
        onMouseMove={event => { const box = event.currentTarget.getBoundingClientRect(); setHover(Math.max(0, Math.min(last, Math.round(((event.clientX - box.left) / box.width) * last)))); }}>
        {spans.map(({ turn: t, start, end }, index) => <div key={t.index} className={`tc-band${index === active ? ' on' : ''}`} style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }} />)}
        <div className="tc-ctx">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d={`${line} L100 100 L0 100 Z`} className="stats-area" /><path d={line} className="stats-line" vectorEffect="non-scaling-stroke" /></svg>
          {marks.map(mark => <u key={mark} className="tc-pack" style={{ left: `${pct(mark)}%` }}><small>컴팩션</small></u>)}
          {hover !== null && <><u className="tc-cross" style={{ left: `${pct(hover)}%` }} /><i className="tc-here" style={{ left: `${pct(hover)}%`, top: `${y(points[hover].ctx)}%` }} /></>}
          {spans.map(({ turn: t, start }, index) => <i key={t.index} className={`tc-dot${index === active ? ' on' : ''}`} style={{ left: `${pct(start)}%`, top: `${y(points[start].ctx)}%` }} />)}
        </div>
        <div className="tc-lane">{spans.map(({ turn: t, start }, index) => (priced.has(index) || index === active) && <b key={t.index} className={`tc-val${index === active ? ' on' : ''}`} style={{ left: `${pct(start)}%`, bottom: Math.max(3, (value(t) / maxValue) * 52) + 3 }}>{short(t)}</b>)}{spans.map(({ turn: t, start }, index) => <i key={t.index} className={`tc-bar${index === active ? ' on' : ''}`} style={{ left: `${pct(start)}%`, height: Math.max(3, (value(t) / maxValue) * 52), width: `clamp(2px, calc(${minGap}% - 1px), 5px)` }} />)}</div>
        <div className="tc-axis">{spans.map(({ turn: t, start }, index) => labelled.has(index) && <em key={t.index} className={index === active ? 'on' : ''} style={{ left: `${pct(start)}%` }}>{t.index}</em>)}</div>
      </div>
    </div>
  </div>;
}

function Body({ stats, costUsd }: { stats: Stats; costUsd: number | null }) {
  const { tokens } = stats, split = { input: tokens.input, output: tokens.output, read: tokens.read, write: tokens.write5m + tokens.write1h };
  const total = Object.values(split).reduce((a, b) => a + b, 0) || 1, hasCost = stats.timeline.some(point => point.costUsd !== null);
  const turnValue = (turn: Stats['turnSeries'][number]) => hasCost ? turn.costUsd ?? 0 : turn.output;
  const toolMax = Math.max(1, ...stats.tools.map(tool => tool.count));
  return <div className="stats-body">
    <div className="stats-tiles">
      <Tile label="총 비용" value={stats.cost ? money(stats.cost.totalUsd) : money(costUsd)} hint={stats.cost ? 'CLI가 기록한 이 세션의 누적 비용' : costUsd !== null ? '기록 파일에 비용이 없어 채팅이 CLI에서 받은 누적 비용을 보여 줍니다' : 'CLI가 이 세션에 비용을 기록하지 않았습니다'} />
      <Tile label="요청" value={`${stats.requests.toLocaleString('ko-KR')}${stats.subRequests ? ` (서브 ${stats.subRequests})` : ''}`} hint="모델 API 호출 수. 같은 호출은 한 번만 셉니다" />
      <Tile label="턴" value={String(stats.turns)} hint="내가 보낸 메시지 수" />
      <Tile label="캐시 적중률" value={percent(stats.cacheHitRate)} hint="입력 중 캐시에서 읽은 비율" />
      <Tile label="최대 컨텍스트" value={compact(stats.peakContext)} />
      <Tile label="활동 시간" value={stats.activeMs ? duration(stats.activeMs) : '—'} hint={stats.startedAt && stats.endedAt ? `${clock(stats.startedAt)} → ${clock(stats.endedAt)}` : undefined} />
    </div>

    <section><h3>토큰 구성</h3>
      <div className="stats-stack" role="img" aria-label="토큰 구성">{kinds.map(([key, name]) => <i key={key} className={`k-${key}`} style={{ flexBasis: `${(split[key] / total) * 100}%` }} title={`${name} ${split[key].toLocaleString('ko-KR')}`} />)}</div>
      <ul className="stats-legend">{kinds.map(([key, name]) => <li key={key}><i className={`k-${key}`} />{name}<b>{compact(split[key])}</b><small>{((split[key] / total) * 100).toFixed(1)}%</small></li>)}</ul>
      {tokens.thinking > 0 && <p className="stats-note">출력 중 생각 토큰 {compact(tokens.thinking)}</p>}
    </section>

    <section><h3>컨텍스트 크기와 턴 <small>전체 {stats.turnSeries.length}턴</small></h3>
      <TurnChart stats={stats} value={turnValue} unitName={hasCost ? '턴 비용' : '턴 출력 토큰'} unit={turn => hasCost ? money(turn.costUsd) : `출력 ${compact(turn.output)}`} short={turn => hasCost ? money(turn.costUsd) : compact(turn.output)} />
      {stats.compactions > 0 && <p className="stats-note">세로 점선은 컴팩션 {stats.compactions}회입니다.</p>}
      {hasCost && <p className="stats-note">턴별 비용은 실제 비용을 요청별 토큰 사용량으로 나눈 추정치입니다.</p>}
    </section>

    <div className="stats-cols">
      <section><h3>모델</h3>
        <table className="stats-table"><thead><tr><th>모델</th><th>요청</th><th>입력</th><th>출력</th><th>비용</th></tr></thead>
          <tbody>{stats.models.map(row => <tr key={row.model}><td>{shortModel(row.model)}</td><td>{row.requests}</td><td>{compact(row.input + row.read + row.write)}</td><td>{compact(row.output)}</td><td>{money(row.costUsd)}</td></tr>)}</tbody></table>
      </section>
      <section><h3>도구 사용 <small>{stats.toolCalls}회</small></h3>
        {stats.tools.length ? <ul className="stats-tools">{stats.tools.map(tool => <li key={tool.name}><span>{tool.name}</span><i style={{ '--w': `${(tool.count / toolMax) * 100}%` } as CSSProperties} /><b>{tool.count}</b><small>{tool.errors > 0 ? `오류 ${tool.errors}` : ''}</small></li>)}</ul> : <p className="stats-empty">도구를 쓰지 않았습니다.</p>}
      </section>
    </div>

    {stats.blocks.length > 0 && <section><h3>5시간 블록 <small>ccusage 방식: 첫 요청 시각의 정시부터 5시간</small></h3>
      <table className="stats-table"><thead><tr><th>시작</th><th>끝</th><th>요청</th><th>토큰</th><th>비용</th></tr></thead>
        <tbody>{stats.blocks.map(block => <tr key={block.start}><td>{clock(block.start)}</td><td>{clock(block.end)}</td><td>{block.requests}</td><td>{compact(block.tokens)}</td><td>{money(block.costUsd)}</td></tr>)}</tbody></table>
    </section>}
    {stats.cost && (stats.cost.linesAdded > 0 || stats.cost.linesRemoved > 0) && <p className="stats-note">코드 변경 +{stats.cost.linesAdded.toLocaleString('ko-KR')} / −{stats.cost.linesRemoved.toLocaleString('ko-KR')}줄 · 도구 실행 {duration(stats.cost.toolMs)}</p>}
  </div>;
}

export function ChatStatsModal({ id, call, costUsd = null, onClose }: { id: string; call<T>(route: string, input: Record<string, unknown>): Promise<T>; costUsd?: number | null; onClose(): void }) {
  const [stats, setStats] = useState<Stats | null>(null), [error, setError] = useState('');
  useEffect(() => { let live = true; call<Stats>('chat/stats', { id }).then(value => { if (live) setStats(value); }, (reason: Error) => { if (live) setError(reason.message); }); return () => { live = false; }; }, [call, id]);
  return <Modal onClose={onClose} className="chat-stats" labelledBy="chat-stats-title">
    <header><h2 id="chat-stats-title">세션 통계</h2>{stats && <small>세션 {stats.sessionId.slice(0, 8)}</small>}<button type="button" className="icon-button" aria-label="닫기" onClick={onClose}><Icon name="x" size={16} /></button></header>
    {error ? <p className="stats-error" role="alert">{error}</p> : stats ? <Body stats={stats} costUsd={costUsd} /> : <p className="stats-empty">기록을 읽는 중…</p>}
  </Modal>;
}
