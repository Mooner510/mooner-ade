import { useEffect, useState, type CSSProperties } from 'react';
import { api } from './api';
import { compact, dollars, type Item, type UsageSnap } from './chat-model';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { untilReset, usageHueStyle, type Usage, type UsageWindow } from './Usage';
import './chat-cards.css';

type BtwItem = Extract<Item, { kind: 'btw' }>;

// Kept across cards: /usage draws the last reading at once (no spinner) and replaces it as soon as the fresh one arrives.
const lastReading = new Map<string, Usage>();
const HOUR = 3_600_000;
// Length of a limit window, for the "how far into the window are we" mark. Unknown windows get no mark.
const windowLength = (key: string) => key === 'session' ? 5 * HOUR : key.startsWith('weekly') ? 168 * HOUR : 0;
const providerName = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' } as const;

function Ring({ percent, colors, size = 76 }: { percent: number; colors: boolean; size?: number }) {
  const stroke = 7, radius = (size - stroke) / 2, length = 2 * Math.PI * radius, center = size / 2;
  return <svg className="uc-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={colors ? usageHueStyle(percent) : undefined} aria-hidden="true">
    <circle cx={center} cy={center} r={radius} className="track" strokeWidth={stroke} />
    {percent > 0 && <circle cx={center} cy={center} r={radius} className={`fill${colors ? ' graded' : ''}`} strokeWidth={stroke} strokeDasharray={`${Math.max(2, length * Math.min(100, percent) / 100)} ${length}`} transform={`rotate(-90 ${center} ${center})`} />}
    <text x={center} y={center} textAnchor="middle" dominantBaseline="central" className={colors ? 'graded' : ''}>{percent}<tspan className="unit">%</tspan></text>
  </svg>;
}

// One plan limit: ring, when it resets, and whether the use so far is ahead of or behind the time that has passed in the window.
function LimitTile({ item, colors, now }: { item: UsageWindow; colors: boolean; now: number }) {
  const length = windowLength(item.key), elapsed = item.resetsAt && length ? Math.max(0, Math.min(1, 1 - (item.resetsAt - now) / length)) : null;
  const pace = elapsed === null ? null : item.percent - elapsed * 100;
  const tone = pace === null ? null : pace > 12 ? 'fast' : pace < -12 ? 'slow' : 'even';
  return <div className="uc-tile">
    <Ring percent={item.percent} colors={colors} />
    <div className="uc-tile-body">
      <b>{item.label}</b>
      {item.resetsAt ? <span>{untilReset(item.resetsAt)} 후 초기화</span> : <span>초기화 시각 없음</span>}
      {item.resetsAt && <small>{new Date(item.resetsAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</small>}
      {tone && <em className={`uc-pace ${tone}`}>{tone === 'fast' ? '빠르게 소모 중' : tone === 'slow' ? '여유 있음' : '페이스 적정'}</em>}
    </div>
    {elapsed !== null && <div className="uc-time"><i style={{ width: `${elapsed * 100}%` }} /></div>}
  </div>;
}

const TOKEN_PARTS = [['input', '입력', 'in'], ['output', '출력', 'out'], ['cacheRead', '캐시 읽기', 'cr'], ['cacheCreate', '캐시 쓰기', 'cw']] as const;

/** /usage: asked locally, drawn at once from the chat's own state; the plan limits fill in from the last reading and refresh behind it. */
export function UsageCard({ snap, projectId, colors, showSession }: { snap: UsageSnap; projectId: string; colors: boolean; showSession: boolean }) {
  const cacheKey = `${snap.agent}|${projectId}`;
  const [usage, setUsage] = useState<Usage | null>(() => lastReading.get(cacheKey) ?? null), [loading, setLoading] = useState(false), [failed, setFailed] = useState(false), [now, setNow] = useState(Date.now());
  const load = (force: boolean) => {
    setLoading(true); setFailed(false);
    return api<Usage>('usage/status', { provider: snap.agent, force, projectId }).then(value => { lastReading.set(cacheKey, value); setUsage(value); setNow(Date.now()); }, () => setFailed(true)).finally(() => setLoading(false));
  };
  useEffect(() => { void load(false); }, [cacheKey]);
  const windows = (usage?.windows ?? []).filter(item => snap.agent === 'cursor' || showSession || item.key !== 'session');
  const tokens = snap.tokens, total = tokens ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate : 0;
  const context = snap.context;
  return <div className="chat-row usage-card" role="region" aria-label="사용량">
    <div className="uc">
      <header className="uc-head">
        <span className="uc-title"><Icon name="chart" size={15} />사용량</span>
        <span className="uc-badges">
          <span className="uc-badge">{providerName[snap.agent]}</span>
          {usage?.plan && <span className="uc-badge plan">{usage.plan}</span>}
          {snap.apiKey && <span className="uc-badge key">API 키</span>}
        </span>
        <button type="button" className="icon-btn" aria-label="사용 한도 새로고침" aria-busy={loading} onClick={() => void load(true)}><Icon name="refresh" size={13} /></button>
      </header>

      <section className="uc-section">
        <h4>플랜 한도</h4>
        {snap.apiKey ? <p className="uc-note">이 채팅은 API 키로 실행 중이라 플랜 한도 대신 API 요금이 청구됩니다.</p>
          : windows.length ? <div className="uc-tiles">{windows.map(item => <LimitTile key={item.key} item={item} colors={colors} now={now} />)}</div>
          : loading || (!usage && !failed) ? <div className="uc-tiles" aria-busy="true"><div className="uc-tile skeleton" /><div className="uc-tile skeleton" /></div>
          : <p className="uc-note">{failed ? '사용 한도를 불러오지 못했습니다.' : usage?.error || '표시할 한도 정보가 없습니다.'}</p>}
        {!snap.apiKey && usage?.error && windows.length > 0 && <p className="uc-note warn">{usage.error}</p>}
        {snap.share && !snap.apiKey && <p className="uc-share"><Icon name="sparkles" size={13} />이 채팅이 쓴 한도 <b>{snap.share}</b></p>}
      </section>

      <section className="uc-section">
        <h4>이 채팅</h4>
        <div className="uc-stats">
          <div><small>모델</small><b>{snap.model || '—'}</b></div>
          <div><small>비용</small><b>{snap.costUsd === null ? '미제공' : `$${dollars(snap.costUsd)}`}</b><em>{snap.turns}턴</em></div>
          <div><small>총 토큰</small><b>{tokens ? compact(total) : '미제공'}</b></div>
        </div>
        {context ? <div className="uc-context">
          <div><span>컨텍스트 {compact(context.used)} / {compact(context.basis)}{context.autoCompact && <span className="uc-badge compact">Auto Compact</span>}</span><b className={colors ? 'graded' : ''} style={colors ? usageHueStyle(context.percent) : undefined}>{context.percent}%</b></div>
          <progress className={colors ? 'graded' : ''} style={colors ? usageHueStyle(context.percent) : undefined} value={Math.min(100, context.percent)} max={100} aria-label="컨텍스트 사용률" />
        </div> : <p className="uc-note">첫 응답 후 컨텍스트 사용량이 표시됩니다.</p>}
        {tokens && total > 0 && <div className="uc-tokens">
          <div className="uc-stack" role="img" aria-label="토큰 구성">{TOKEN_PARTS.map(([key, , cls]) => tokens[key] > 0 && <i key={key} className={cls} style={{ flexGrow: tokens[key] } as CSSProperties} />)}</div>
          <ul>{TOKEN_PARTS.map(([key, label, cls]) => <li key={key}><i className={cls} />{label}<b>{compact(tokens[key])}</b></li>)}</ul>
        </div>}
      </section>
    </div>
  </div>;
}

/** /btw: the question, then the answer (or the wait / the failure). Not part of the conversation: the agent never sees it. */
export function BtwCard({ item, onClose, onRetry }: { item: BtwItem; onClose(): void; onRetry(): void }) {
  return <div className={`chat-row btw-card ${item.status}`} role="region" aria-label="곁다리 질문">
    <div className="bc">
      <header className="bc-head">
        <span className="bc-tag"><Icon name="sparkles" size={13} />BTW</span>
        <span className="bc-question" title={item.question}>{item.question}</span>
        <button type="button" className="icon-btn" aria-label={item.status === 'pending' ? '질문 취소' : '닫기'} onClick={onClose}><Icon name="x" size={13} /></button>
      </header>
      {item.status === 'pending' && <div className="bc-wait" role="status"><i className="chat-spin" /><span>대화를 훑어보고 답하는 중…</span></div>}
      {item.status === 'done' && <div className="bc-answer"><Markdown text={item.answer ?? ''} /></div>}
      {item.status === 'error' && <div className="bc-error" role="alert"><Icon name="alert" size={14} /><span>{item.error}</span><button type="button" className="bc-retry" onClick={onRetry}>다시 시도</button></div>}
      <footer className="bc-foot">대화 기록에 남지 않고 에이전트의 작업에도 영향을 주지 않습니다{item.status === 'done' && item.costUsd != null && ` · $${dollars(item.costUsd)}`}</footer>
    </div>
  </div>;
}
