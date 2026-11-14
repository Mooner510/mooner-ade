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

// A thin area + line over the request order; hovering reads one request out in the line above, the way a crosshair would.
function Trend({ values, readout, marks, label }: { values: number[]; readout(index: number): string; marks: number[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null), width = 600, height = 120, max = Math.max(1, ...values);
  if (values.length < 2) return <p className="stats-empty">그래프를 그리려면 요청이 2개 이상 필요합니다.</p>;
  const x = (index: number) => (index / (values.length - 1)) * width, y = (value: number) => height - 6 - (value / max) * (height - 14);
  const line = values.map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)} ${y(value).toFixed(1)}`).join(' ');
  return <div className="stats-chart">
    <div className="stats-readout" aria-live="polite">{hover === null ? `최대 ${compact(max)}` : readout(hover)}</div>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}
      onMouseLeave={() => setHover(null)} onMouseMove={event => { const box = event.currentTarget.getBoundingClientRect(); setHover(Math.max(0, Math.min(values.length - 1, Math.round(((event.clientX - box.left) / box.width) * (values.length - 1))))); }}>
      <path d={`${line} L${width} ${height} L0 ${height} Z`} className="stats-area" />
      <path d={line} className="stats-line" vectorEffect="non-scaling-stroke" />
      {marks.map(mark => <line key={mark} x1={x(mark)} x2={x(mark)} y1={0} y2={height} className="stats-mark" vectorEffect="non-scaling-stroke" />)}
      {hover !== null && <g><line x1={x(hover)} x2={x(hover)} y1={0} y2={height} className="stats-cross" vectorEffect="non-scaling-stroke" /><circle cx={x(hover)} cy={y(values[hover])} r={4} className="stats-dot" /></g>}
    </svg>
  </div>;
}

function Bars({ values, readout, label }: { values: number[]; readout(index: number): string; label: string }) {
  const [hover, setHover] = useState<number | null>(null), max = Math.max(1e-9, ...values);
  if (!values.length) return <p className="stats-empty">아직 턴이 없습니다.</p>;
  return <div className="stats-chart">
    <div className="stats-readout" aria-live="polite">{hover === null ? '막대에 마우스를 올리면 턴별 값을 봅니다' : readout(hover)}</div>
    <div className="stats-bars" role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
      {values.map((value, index) => <span key={index} className={hover === index ? 'on' : ''} onMouseEnter={() => setHover(index)}><i style={{ height: `${Math.max(2, (value / max) * 100)}%` }} /></span>)}
    </div>
  </div>;
}

function Body({ stats, costUsd }: { stats: Stats; costUsd: number | null }) {
  const { tokens } = stats, split = { input: tokens.input, output: tokens.output, read: tokens.read, write: tokens.write5m + tokens.write1h };
  const total = Object.values(split).reduce((a, b) => a + b, 0) || 1, hasCost = stats.timeline.some(point => point.costUsd !== null);
  const marks = stats.compactionAt.map(at => { let best = 0; stats.timeline.forEach((point, index) => { if (Math.abs(point.at - at) < Math.abs(stats.timeline[best].at - at)) best = index; }); return best; });
  const perTurn = stats.turnSeries.slice(-40), turnValue = (turn: Stats['turnSeries'][number]) => hasCost ? turn.costUsd ?? 0 : turn.output;
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

    <section><h3>컨텍스트 크기 추이</h3>
      <Trend label="요청별 컨텍스트 크기" values={stats.timeline.map(point => point.ctx)} marks={marks}
        readout={index => { const point = stats.timeline[index]; return `${clock(point.at)} · 컨텍스트 ${compact(point.ctx)} · 출력 ${compact(point.output)}${point.costUsd !== null ? ` · ${money(point.costUsd)}` : ''}${point.sub ? ' · 서브에이전트' : ''}`; }} />
      {stats.compactions > 0 && <p className="stats-note">세로 점선은 컴팩션 {stats.compactions}회입니다.</p>}
    </section>

    <section><h3>{hasCost ? '턴별 비용' : '턴별 출력 토큰'} <small>최근 {perTurn.length}턴</small></h3>
      <Bars label={hasCost ? '턴별 비용' : '턴별 출력 토큰'} values={perTurn.map(turnValue)}
        readout={index => { const turn = perTurn[index]; return `#${turn.index} · ${hasCost ? money(turn.costUsd) : `출력 ${compact(turn.output)}`} · 요청 ${turn.requests}${turn.ms ? ` · ${duration(turn.ms)}` : ''}${turn.at ? ` · ${clock(turn.at)}` : ''}`; }} />
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
