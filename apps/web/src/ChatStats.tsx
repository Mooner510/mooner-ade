import { useEffect, useState, type CSSProperties } from 'react';
import { Icon } from './Icon';
import { Modal } from './views';
import { compact, dollars, duration } from './chat-model';
import { StatTile, UsageAssessment, type UsageReport } from './UsageStats';

// Statistics of one Claude conversation (server: chat-stats.js, read from the transcript the CLI keeps; nothing is sent anywhere).
export type Stats = {
  report?: UsageReport; source?: 'ade'; tokensAvailable?: boolean; contextAvailable?: boolean;
  sessionId: string; requests: number; subRequests: number; turns: number; compactions: number; compactionAt: number[]; startedAt: number | null; endedAt: number | null; activeMs: number;
  tokens: { input: number; output: number; thinking: number; read: number; write5m: number; write1h: number }; cacheHitRate: number | null; peakContext: number;
  cost: { totalUsd: number; toolMs: number; linesAdded: number; linesRemoved: number } | null;
  models: { model: string; requests: number; input: number; output: number; read: number; write: number; costUsd: number | null }[];
  tools: { name: string; count: number; errors: number }[]; toolCalls: number;
  timeline: { at: number; ctx: number; output: number; costUsd: number | null; turn: number; sub: boolean }[];
  turnSeries: { index: number; at: number | null; requests: number; output: number; ctx: number; costUsd: number | null; ms: number; subRequests?: number; subPeak?: number; subCostUsd?: number | null }[];
  subagents: { id: string; label: string; type: string; model: string; at: number; endedAt: number; turn: number; requests: number; peak: number; costUsd: number | null; points: { at: number; ctx: number }[] }[];
  blocks: { start: number; end: number; requests: number; tokens: number; costUsd: number | null }[];
};

const money = (value: number | null) => value === null ? '—' : `$${dollars(value)}`;
const clock = (at: number) => new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const shortModel = (model: string) => model.replace(/^claude-/, '');

// Series colours: the first four slots of the validated categorical palette, one per token kind, in a fixed order.
const kinds = [['input', '입력'], ['output', '출력'], ['read', '캐시 읽기'], ['write', '캐시 쓰기']] as const;

// Request points, turn starts and bars share the same horizontal scale. Subagent requests have their own context windows.
type Turn = Stats['turnSeries'][number];
function TurnChart({ stats, value, unit, unitName }: { stats: Stats; value(turn: Turn): number; unit(turn: Turn): string; unitName: string }) {
  const [hover, setHover] = useState<number | null>(null), points = stats.timeline.filter(point => !point.sub), count = points.length;
  if (count < 2 || !stats.turnSeries.length) return <p className="stats-empty">활동 추이를 보려면 요청이 2개 이상 필요해요.</p>;
  const last = count - 1, pct = (index: number) => (index / last) * 100, maxCtx = Math.max(1, ...points.map(point => point.ctx)), y = (ctx: number) => 92 - (ctx / maxCtx) * 78;
  // A turn starts at its first request; the timeline can be thinned, so a turn whose first request was dropped starts at the next kept one, and two turns that land
  // on the same point keep the later one. ponytail: that turn's cost bar is then hidden, rare below ~240 requests.
  const found = stats.turnSeries.map(turn => ({ turn, start: points.findIndex(point => point.turn >= turn.index) })).filter(span => span.start >= 0);
  const spans = found.filter((span, index) => index + 1 === found.length || found[index + 1].start !== span.start);
  if (!spans.length) return <p className="stats-empty">턴에 연결된 요청 기록이 없어요.</p>;
  const top = spans.reduce((best, span) => value(span.turn) > value(best.turn) ? span : best).turn;
  const maxValue = Math.max(1e-9, value(top));
  const hasContext = stats.contextAvailable !== false;
  const minGap = Math.min(100, ...spans.slice(1).map((span, index) => pct(span.start) - pct(spans[index].start)));
  let shown = -Infinity; const labelled = new Set(spans.map((span, index) => { if (pct(span.start) - shown < 3.2) return -1; shown = pct(span.start); return index; })); // numbers only where they do not touch
  // Leave room between labels on the tallest bars.
  const priced = new Set<number>(); [...spans.keys()].sort((a, b) => value(spans[b].turn) - value(spans[a].turn)).forEach(index => { if (priced.size < 5 && value(spans[index].turn) > 0 && [...priced].every(other => Math.abs(pct(spans[other].start) - pct(spans[index].start)) >= 8)) priced.add(index); });
  const marks = [...new Set(stats.compactionAt.map(at => points.reduce((best, point, index) => Math.abs(point.at - at) < Math.abs(points[best].at - at) ? index : best, 0)))];
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${pct(index).toFixed(2)} ${y(point.ctx).toFixed(2)}`).join(' ');
  const active = hover === null ? -1 : spans.reduce((found, span, index) => span.start <= hover ? index : found, -1), turn = active >= 0 ? spans[active].turn : null;
  const point = hover === null ? null : points[hover];
  const turnUnit = turn && unit(turn);
  const details = point && [
    turn && (turn.index > 0 ? `턴 ${turn.index}` : '시작 요청'),
    turnUnit === '—' ? `${unitName} 미제공` : turnUnit && `${unitName} ${turnUnit}`,
    turn && `요청 ${turn.requests}`,
    turn?.ms && unitName !== '턴 활동 시간' ? duration(turn.ms) : '',
    clock(point.at),
    hasContext && `컨텍스트 ${compact(point.ctx)}`,
    hover !== null && marks.includes(hover) && '컨텍스트 압축',
    turn?.subRequests && `서브에이전트 요청 ${turn.subRequests}${turn.subPeak ? `, 최대 ${compact(turn.subPeak)}` : ''}${turn.subCostUsd != null ? `, ${money(turn.subCostUsd)}` : ''}`
  ].filter(Boolean).join(', ');
  const selectAt = (x: number, box: DOMRect) => setHover(Math.max(0, Math.min(last, Math.round(((x - box.left) / box.width) * last))));
  return <div className="stats-chart" data-context={hasContext}>
    <div className="tc-legend">
      {hasContext && <span><i className="d" />컨텍스트 <b>최대 {compact(maxCtx)}</b></span>}
      <span><i className="b" />{unitName} <b>최대 {unit(top)}</b></span>
      {marks.length > 0 && <span><i className="tc-pack-key" />컨텍스트 압축</span>}
      {spans.some(span => span.turn.subRequests) && <span><i className="d sub" />서브에이전트 실행</span>}
    </div>
    <div className="turn-chart">
      <div className="tc-plot" tabIndex={0} role="group" aria-label={hasContext ? `요청별 컨텍스트와 ${unitName}` : unitName}
        onFocus={() => setHover(current => current ?? 0)} onBlur={() => setHover(null)}
        onPointerMove={event => { if (event.pointerType === 'mouse') selectAt(event.clientX, event.currentTarget.getBoundingClientRect()); }}
        onPointerDown={event => selectAt(event.clientX, event.currentTarget.getBoundingClientRect())}
        onPointerLeave={event => { if (event.pointerType === 'mouse') setHover(null); }}
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          setHover(current => Math.max(0, Math.min(last, (current ?? 0) + (event.key === 'ArrowLeft' ? -1 : 1))));
        }}>
        {hover !== null && <i className="tc-cross" style={{ left: `${pct(hover)}%` }} />}
        {hasContext && <div className="tc-ctx">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d={`${line} L100 100 L0 100 Z`} className="stats-area" /><path d={line} className="stats-line" vectorEffect="non-scaling-stroke" /></svg>
          {marks.map(mark => <u key={mark} className="tc-pack" style={{ left: `${pct(mark)}%` }} />)}
          {spans.map(({ turn: t, start }) => <i key={t.index} className={`tc-dot${t.subRequests ? ' sub' : ''}`} style={{ left: `${pct(start)}%`, top: `${y(points[start].ctx)}%` }} />)}
          {hover !== null && point && <i className="tc-here" style={{ left: `${pct(hover)}%`, top: `${y(point.ctx)}%` }} />}
        </div>}
        <div className="tc-lane">
          {spans.map(({ turn: t, start }, index) => priced.has(index) && <b key={t.index} className="tc-val" style={{ left: `${pct(start)}%`, bottom: (value(t) / maxValue) * 52 + 3 }}>{unit(t)}</b>)}
          {spans.map(({ turn: t, start }, index) => <i key={t.index} className={`tc-bar${index === active ? ' on' : ''}`} style={{ left: `${pct(start)}%`, height: (value(t) / maxValue) * 52, width: `clamp(2px, calc(${minGap}% - 1px), 5px)` }} />)}
        </div>
        <div className="tc-axis">{spans.map(({ turn: t, start }, index) => labelled.has(index) && <em key={t.index} className={index === active ? 'on' : ''} style={{ left: `${pct(start)}%` }}>{t.index || '시작'}</em>)}</div>
      </div>
    </div>
    <div className="stats-readout" aria-live="polite">{details ?? '그래프를 선택하거나 방향키로 이동해 세부 수치를 볼 수 있어요.'}</div>
  </div>;
}

type Subagent = Stats['subagents'][number];
function Spark({ points, label, peak }: { points: Subagent['points']; label: string; peak: number }) {
  const max = Math.max(1, ...points.map(point => point.ctx)), last = points.length - 1;
  const low = Math.min(...points.map(point => point.ctx));
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${((index / last) * 100).toFixed(2)} ${(8 + (1 - point.ctx / max) * 84).toFixed(2)}`).join(' ');
  return <svg className="stats-sub-spark" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${label} 컨텍스트 ${compact(low)}에서 ${compact(peak)}`}>
    <path d={`${line} L100 100 L0 100 Z`} className="stats-sub-area" /><path d={line} className="stats-sub-line" vectorEffect="non-scaling-stroke" />
  </svg>;
}

function Subagents({ agents }: { agents: Subagent[] }) {
  const requests = agents.reduce((sum, agent) => sum + agent.requests, 0);
  const peak = Math.max(...agents.map(agent => agent.peak));
  const cost = agents.some(agent => agent.costUsd !== null) ? agents.reduce((sum, agent) => sum + (agent.costUsd ?? 0), 0) : null;
  return <section className="stats-panel">
    <div className="stats-section-head"><div><h3>서브에이전트</h3><small>{agents.length}개, 요청 {requests.toLocaleString('ko-KR')}, 최대 컨텍스트 {compact(peak)}{cost !== null ? `, ${money(cost)}` : ''}</small></div></div>
    <ul className="stats-subs">
      {agents.map(agent => {
        const title = agent.label || agent.type || '서브에이전트';
        const meta = [agent.turn > 0 ? `턴 ${agent.turn}` : '', clock(agent.at), `요청 ${agent.requests}`, `최대 ${compact(agent.peak)}`, agent.costUsd !== null ? money(agent.costUsd) : '', agent.model && agent.model !== 'unknown' ? shortModel(agent.model) : ''].filter(Boolean).join(', ');
        return <li key={agent.id}>
          <div className="stats-sub-head"><b title={title}>{agent.type && agent.label ? <em>{agent.type}</em> : null}{title}</b><small>{meta}</small></div>
          {agent.points.length > 1 && <Spark points={agent.points} label={title} peak={agent.peak} />}
        </li>;
      })}
    </ul>
  </section>;
}

function Body({ stats, costUsd }: { stats: Stats; costUsd: number | null }) {
  const { tokens } = stats, subagents = stats.subagents ?? [], split = { input: tokens.input, output: tokens.output, read: tokens.read, write: tokens.write5m + tokens.write1h };
  const total = Object.values(split).reduce((a, b) => a + b, 0) || 1;
  const hasTurnCost = stats.turnSeries.some(turn => turn.costUsd !== null) || stats.timeline.some(point => !point.sub && point.costUsd !== null);
  const hasSubCost = subagents.some(agent => agent.costUsd !== null);
  const subPeak = subagents.reduce((max, agent) => Math.max(max, agent.peak), 0);
  const hasDuration = stats.turnSeries.some(turn => turn.ms > 0);
  const activityUnit = hasTurnCost ? '턴 비용' : stats.tokensAvailable !== false ? '턴 출력 토큰' : hasDuration ? '턴 활동 시간' : '응답';
  const turnValue = (turn: Turn) => hasTurnCost ? turn.costUsd ?? 0 : stats.tokensAvailable !== false ? turn.output : hasDuration ? turn.ms : turn.requests;
  const turnShort = (turn: Turn) => hasTurnCost ? money(turn.costUsd) : stats.tokensAvailable !== false ? compact(turn.output) : hasDuration ? duration(turn.ms) : String(turn.requests);
  const toolMax = Math.max(1, ...stats.tools.map(tool => tool.count));
  return <div className="stats-body">
    <div className="stats-tiles">
      <StatTile label="턴" value={stats.turns.toLocaleString('ko-KR')} />
      <StatTile label={stats.source === 'ade' ? '종료 응답' : '모델 요청'} value={stats.requests.toLocaleString('ko-KR')} hint={stats.source === 'ade' ? '완료, 중단, 오류로 종료된 응답 수' : stats.subRequests ? `서브에이전트 요청 ${stats.subRequests}회 포함` : undefined} />
      <StatTile label="보고 비용" value={stats.cost ? money(stats.cost.totalUsd) : money(costUsd)} hint={stats.cost || costUsd !== null ? '에이전트가 보고한 세션 비용' : '비용 미제공'} />
      <StatTile label="캐시 적중률" value={percent(stats.cacheHitRate)} hint="입력 중 캐시에서 읽은 비율" />
      <StatTile label="최대 컨텍스트" value={stats.contextAvailable === false ? '—' : compact(stats.peakContext)} hint={subagents.length ? `이 대화의 최대 컨텍스트, 서브에이전트 최대 ${compact(subPeak)}` : undefined} />
      <StatTile label="활동 시간" value={stats.activeMs ? duration(stats.activeMs) : '—'} hint={stats.startedAt && stats.endedAt ? `${clock(stats.startedAt)} → ${clock(stats.endedAt)}` : undefined} />
    </div>
    <UsageAssessment report={stats.report} />

    <section className="stats-panel stats-activity">
      <div className="stats-section-head"><h3>세션 활동</h3><small>{stats.compactions > 0 ? `컨텍스트 압축 ${stats.compactions}회` : ''}</small></div>
      <TurnChart stats={stats} value={turnValue} unitName={activityUnit} unit={turnShort} />
      {stats.source !== 'ade' && (hasTurnCost || hasSubCost) && <p className="stats-note">턴/서브에이전트 비용은 토큰 사용량을 기준으로 배분한 추정치예요.</p>}
    </section>

    <section className="stats-panel"><div className="stats-section-head"><h3>토큰 구성</h3>{tokens.thinking > 0 && <small>출력 중 추론 {compact(tokens.thinking)}</small>}</div>
      {stats.tokensAvailable === false || !Object.values(split).some(Boolean) ? <p className="stats-empty">기록된 토큰이 없어요.</p> : <>
        <div className="stats-stack" aria-hidden="true">{kinds.map(([key]) => split[key] > 0 && <i key={key} className={`k-${key}`} style={{ flexBasis: `${(split[key] / total) * 100}%` }} />)}</div>
        <ul className="stats-legend">{kinds.map(([key, name]) => <li key={key} title={split[key].toLocaleString('ko-KR')}><i className={`k-${key}`} />{name}<b>{compact(split[key])}</b><small>{((split[key] / total) * 100).toFixed(1)}%</small></li>)}</ul>
      </>}
    </section>

    {subagents.length > 0 && <Subagents agents={subagents} />}

    <div className="stats-cols">
      <section className="stats-panel"><div className="stats-section-head"><h3>모델</h3></div>
        {stats.models.length ? <table className="stats-table"><thead><tr><th>모델</th><th>{stats.source === 'ade' ? '종료 응답' : '요청'}</th>{stats.source !== 'ade' && <><th>입력</th><th>출력</th><th>비용</th></>}</tr></thead>
          <tbody>{stats.models.map(row => <tr key={row.model}><td>{row.model === 'unknown' ? '모델 미기록' : shortModel(row.model)}</td><td>{row.requests}</td>{stats.source !== 'ade' && <><td>{compact(row.input + row.read + row.write)}</td><td>{compact(row.output)}</td><td>{money(row.costUsd)}</td></>}</tr>)}</tbody></table> : <p className="stats-empty">기록된 모델이 없어요.</p>}
      </section>
      <section className="stats-panel"><div className="stats-section-head"><h3>도구 사용</h3><small>{stats.toolCalls}회</small></div>
        {stats.tools.length ? <ul className="stats-tools">{stats.tools.map(tool => <li key={tool.name}><span title={tool.name}>{tool.name}</span><i style={{ '--w': `${(tool.count / toolMax) * 100}%` } as CSSProperties} /><b>{tool.count}</b><small>{tool.errors > 0 ? `오류 ${tool.errors}` : ''}</small></li>)}</ul> : <p className="stats-empty">도구를 쓰지 않았습니다.</p>}
      </section>
    </div>

    {stats.blocks.length > 0 && <details className="stats-panel stats-blocks"><summary>5시간 블록 <small>{stats.blocks.length}개</small></summary>
      <div className="stats-table-scroll">
      <table className="stats-table"><thead><tr><th>시작</th><th>끝</th><th>요청</th><th>토큰</th><th>비용</th></tr></thead>
        <tbody>{stats.blocks.map(block => <tr key={block.start}><td>{clock(block.start)}</td><td>{clock(block.end)}</td><td>{block.requests}</td><td>{compact(block.tokens)}</td><td>{money(block.costUsd)}</td></tr>)}</tbody></table>
      </div>
    </details>}
    {stats.cost && (stats.cost.linesAdded > 0 || stats.cost.linesRemoved > 0) && <p className="stats-note">코드 변경 +{stats.cost.linesAdded.toLocaleString('ko-KR')} / −{stats.cost.linesRemoved.toLocaleString('ko-KR')}줄, 도구 실행 {duration(stats.cost.toolMs)}</p>}
    {stats.source === 'ade' && <p className="stats-note">ADE에 보관된 대화 기준이에요. 토큰/비용은 CLI가 보고한 세션 누적값일 수 있어요.</p>}
  </div>;
}

export function ChatStatsModal({ id, title, agent, call, costUsd = null, onClose }: { id: string; title: string; agent: 'claude' | 'codex' | 'cursor'; call<T>(route: string, input: Record<string, unknown>): Promise<T>; costUsd?: number | null; onClose(): void }) {
  const [stats, setStats] = useState<Stats | null>(null), [error, setError] = useState('');
  useEffect(() => { let live = true; call<Stats>('chat/stats', { id }).then(value => { if (live) setStats(value); }, (reason: Error) => { if (live) setError(reason.message); }); return () => { live = false; }; }, [call, id]);
  return <Modal onClose={onClose} className="chat-stats" labelledBy="chat-stats-title" region="세션 통계">
    <header>
      <span className="stats-heading-icon"><Icon name={agent} size={20} /></span>
      <div className="stats-heading-text"><h2 id="chat-stats-title">세션 통계</h2><small title={title}>{title}</small></div>
      {stats?.sessionId && <small className="stats-session-id" title={stats.sessionId}>{stats.sessionId.slice(0, 8)}</small>}
      <button type="button" className="icon-button icon-btn" aria-label="닫기" onClick={onClose}><Icon name="x" size={16} /></button>
    </header>
    {error ? <p className="stats-error" role="alert">{error}</p> : stats ? <Body stats={stats} costUsd={costUsd} /> : <p className="stats-empty" role="status">기록을 읽는 중…</p>}
  </Modal>;
}
