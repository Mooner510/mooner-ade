import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon, IconButton } from './Icon';
import { Dropdown, Modal } from './views';
import { StatTile, UsageAssessment, type UsageReport } from './UsageStats';
import { activityBuckets, dayStamp, reviewRange, type ReviewPreset } from './usage-review-model';
import { syncUsageLedger } from './usage-sync';

type Provider = 'claude' | 'codex' | 'cursor';
type SessionRow = { projectId: string; chatId: string; deviceId: string; title: string; provider: Provider; model: string; turns: number; weight: number; costUsd: number | null; lastAt: number; projectLabel: string };
type TokenTotals = { input: number; output: number; cacheRead: number; cacheCreate: number };
type SessionReview = {
  report: UsageReport;
  turns: { accountKey: string }[];
  summary: { turns: number; weight: number; costUsd: number | null; tokens: TokenTotals; cacheHitRate: number | null };
};
type Breakdown = { key: string; label: string; turns: number; weight: number };
type ReviewData = {
  from: number; to: number; timeZone: string; turns: number; sessions: number; weight: number;
  costUsd: number | null; unknownCostTurns: number; cacheHitRate: number | null;
  days: { day: string; turns: number }[]; weeks: { week: string; weight: number }[];
  providers: Breakdown[]; projects: Breakdown[]; report: UsageReport;
  sessionPage: { rows: SessionRow[]; total: number };
  catalog: { projects: { id: string; label: string }[]; accounts: { accountKey: string; label: string }[] };
  devices: { id: string; name: string; local: boolean }[];
};

const presets: { value: ReviewPreset; label: string }[] = [
  { value: '7', label: '최근 7일' }, { value: '30', label: '최근 30일' }, { value: 'this', label: '이번 주' }, { value: 'last', label: '지난 주' }, { value: 'all', label: '전체 기간' }, { value: 'custom', label: '직접 지정' }
];
const providerNames = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
const providers = ['claude', 'codex', 'cursor'] as const;
const num = (value: number) => Math.round(value).toLocaleString('ko-KR');
const axisNum = (value: number) => value >= 10000 ? `${(value / 10000).toFixed(value >= 100000 ? 0 : 1)}만` : num(value);
const money = (value: number | null) => value === null ? '—' : `$${value.toFixed(2)}`;
const percent = (value: number | null) => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
const when = (at: number) => new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const monthDay = (stamp: string) => stamp.slice(5).replace('-', '/');
const PAGE_SIZE = 50;
const rowKey = (row: SessionRow) => JSON.stringify([row.deviceId, row.projectId, row.chatId]);

function Activity({ data }: { data: ReviewData }) {
  const [weekly, setWeekly] = useState(false);
  const [activeDate, setActiveDate] = useState('');
  const rows = activityBuckets(
    weekly ? data.weeks.map(row => ({ date: row.week, value: row.weight })) : data.days.map(row => ({ date: row.day, value: row.turns })),
    data.from, data.to, data.timeZone, weekly
  );
  const max = Math.max(0, ...rows.map(row => row.value));
  const unit = weekly ? '토큰 가중치' : '턴';
  const active = rows.find(row => row.date === activeDate) ?? rows.filter(row => row.value > 0).at(-1);
  return <section className="stats-panel review-activity">
    <div className="stats-section-head">
      <div><h3>사용 추이</h3><small>{weekly ? '주간 토큰 가중치, 최근 최대 8주' : '일간 턴, 최근 최대 14일'}</small></div>
      <div className="chat-providers" role="group" aria-label="추이 단위">
        <button className="chat-provider" type="button" aria-pressed={!weekly} onClick={() => setWeekly(false)}>일간</button>
        <button className="chat-provider" type="button" aria-pressed={weekly} onClick={() => setWeekly(true)}>주간</button>
      </div>
    </div>
    {active && max > 0 ? <>
      <div className="review-chart-value"><strong>{num(active.value)}</strong><span>{unit}, {monthDay(active.date)}{weekly ? ' 주간' : ''}</span></div>
      <div className="review-plot">
        <div className="review-axis" aria-hidden="true"><span>{axisNum(max)}</span><span>0</span></div>
        <ul className="review-cols" aria-label={`날짜별 ${unit}`}>
          {rows.map((row, index) => <li key={row.date}>
            <button type="button" data-active={row.date === active.date || undefined} aria-label={`${row.date}, ${unit} ${num(row.value)}`}
              onFocus={() => setActiveDate(row.date)} onMouseEnter={() => setActiveDate(row.date)} onClick={() => setActiveDate(row.date)}>
              <span><i style={{ height: `${row.value / max * 100}%` }} /></span>
              <small aria-hidden="true">{weekly || rows.length <= 7 || index % 2 === 0 ? monthDay(row.date) : '\u00a0'}</small>
            </button>
          </li>)}
        </ul>
      </div>
    </> : <p className="stats-empty">{weekly ? '표시 기간에 토큰 가중치 기록이 없어요.' : '표시 기간에 기록된 턴이 없어요.'}</p>}
  </section>;
}

function BreakdownBars({ rows, total, metric }: { rows: Breakdown[]; total: number; metric: 'turns' | 'weight' }) {
  return <ul className="review-hbars">
    {rows.map(row => <li key={row.key}>
      <span title={row.label}>{row.label}</span><b>{num(row[metric])}</b>
      <div aria-hidden="true"><i style={{ width: `${total > 0 ? row[metric] / total * 100 : 0}%` }} /></div>
    </li>)}
  </ul>;
}

export function UsageReview({ onClose }: { onClose(): void }) {
  const [preset, setPreset] = useState<ReviewPreset>('30');
  const [provider, setProvider] = useState<Provider | ''>('');
  const [projectId, setProjectId] = useState('');
  const [accountKey, setAccountKey] = useState('');
  const [auth, setAuth] = useState('');
  const [device, setDevice] = useState('local');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<'overview' | 'sessions'>('overview');
  const [selected, setSelected] = useState<SessionRow | null>(null);
  const [session, setSession] = useState<SessionReview | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const sync = useRef<{ revision: number; done: Promise<void> } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const openedFrom = useRef<{ key: string; scrollTop: number } | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    if (sync.current?.revision !== refresh) {
      sync.current = { revision: refresh, done: syncUsageLedger().catch(() => {}) };
    }
    const synced = sync.current.done;
    void (async () => {
      try {
        await synced;
        if (!current) return;
        const end = dayStamp(toDay);
        const range = reviewRange(preset, Date.now(), {
          from: dayStamp(fromDay) ?? undefined,
          to: end === null ? undefined : new Date(end).setHours(23, 59, 59, 999)
        });
        const review = await api<ReviewData>('usage/review', { ...range, providers: provider ? [provider] : [], projectId, accountKey, auth, device, sessionOffset: offset, sessionLimit: PAGE_SIZE });
        if (current) setData(review);
      } catch (cause) {
        if (current) setError(cause instanceof Error ? cause.message : '사용 기록을 불러오지 못했습니다.');
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => { current = false; };
  }, [preset, provider, projectId, accountKey, auth, device, fromDay, toDay, offset, refresh]);

  useEffect(() => {
    if (!selected) return;
    let current = true;
    void api<SessionReview>('usage/review/session', { projectId: selected.projectId, chatId: selected.chatId, deviceId: selected.deviceId }).then(
      detail => { if (current) setSession(detail); },
      cause => { if (current) setSessionError(cause instanceof Error ? cause.message : '세션을 불러오지 못했습니다.'); }
    );
    return () => { current = false; };
  }, [selected]);

  useEffect(() => {
    if (selected) back.current?.focus();
    if (body.current) body.current.scrollTop = 0;
    if (!selected && body.current && openedFrom.current) {
      const { key, scrollTop } = openedFrom.current;
      body.current.scrollTop = scrollTop;
      body.current.querySelector<HTMLButtonElement>(`[data-session-row=${CSS.escape(key)}]`)?.focus({ preventScroll: true });
      openedFrom.current = null;
    }
  }, [page, selected, offset]);

  function filter<T>(set: (value: T) => void, value: T) {
    set(value);
    setOffset(0);
  }

  const devices = data?.devices.filter(item => !item.local) ?? [];
  const accounts = data?.catalog.accounts ?? [];
  const sessionAccounts = session ? [...new Set(session.turns.map(turn => accounts.find(account => account.accountKey === turn.accountKey)?.label || '당시 계정 미기록'))] : [];
  const sessionTotal = data?.sessionPage.total ?? 0;

  return <Modal className="usage-review" labelledBy="usage-review-title" onClose={onClose} region="사용 기록">
    <header>
      <span className="stats-heading-icon"><Icon name="chart" size={20} /></span><h2 id="usage-review-title">사용 기록</h2>
      <span className="spacer" />
      <IconButton icon="refresh" label="새로고침" busy={loading} disabled={!!selected} onClick={() => setRefresh(value => value + 1)} />
      <IconButton icon="x" label="닫기" onClick={onClose} />
    </header>
    {selected ? <div className="review-detail-nav"><button ref={back} type="button" className="stats-text-button" onClick={() => setSelected(null)}><Icon name="arrowLeft" size={16} />세션 목록</button></div> : <>
      <nav className="review-nav" aria-label="사용 기록 보기">
        <div className="plugin-tabs">
          <button type="button" aria-current={page === 'overview' ? 'page' : undefined} onClick={() => setPage('overview')}>개요</button>
          <button type="button" aria-current={page === 'sessions' ? 'page' : undefined} onClick={() => setPage('sessions')}>세션 {data && <small>{num(data.sessions)}</small>}</button>
        </div>
        <Dropdown label="기간" value={preset} options={presets} onChange={value => filter(setPreset, value as ReviewPreset)} />
      </nav>
      <div className="usage-review-bar">
        {preset === 'custom' && <div className="review-dates"><input type="date" aria-label="시작일" value={fromDay} onChange={event => filter(setFromDay, event.target.value)} /><span>–</span><input type="date" aria-label="종료일" value={toDay} onChange={event => filter(setToDay, event.target.value)} /></div>}
        <div className="chat-providers" role="group" aria-label="AI 선택">
          <button type="button" className="chat-provider" aria-pressed={!provider} onClick={() => filter(setProvider, '')}>전체</button>
          {providers.map(id => <button type="button" key={id} className="chat-provider" aria-pressed={provider === id} onClick={() => filter(setProvider, id)}><Icon name={id} size={14} />{providerNames[id]}</button>)}
        </div>
        <div className="review-filters">
          <Dropdown label="프로젝트" value={projectId} options={[{ value: '', label: '모든 프로젝트' }, ...(data?.catalog.projects ?? []).map(item => ({ value: item.id, label: item.label }))]} onChange={value => filter(setProjectId, value)} />
          <Dropdown label="계정" value={accountKey} options={[{ value: '', label: '모든 계정' }, ...accounts.map(item => ({ value: item.accountKey, label: item.label }))]} onChange={value => filter(setAccountKey, value)} />
          <Dropdown label="인증" value={auth} options={[{ value: '', label: '로그인/API 키' }, { value: 'login', label: '로그인' }, { value: 'key', label: 'API 키' }]} onChange={value => filter(setAuth, value)} />
          {devices.length > 0 && <Dropdown label="기기" value={device} options={[{ value: 'local', label: '이 기기' }, { value: 'all', label: '모든 기기' }, ...devices.map(item => ({ value: item.id, label: item.name }))]} onChange={value => { setProjectId(''); filter(setDevice, value); }} />}
        </div>
      </div>
    </>}
    <div ref={body} className="usage-review-body" aria-busy={selected ? !session && !sessionError : loading}>
      {selected ? <>
        <div className="review-detail-title">
          <span className="stats-heading-icon"><Icon name={selected.provider} size={22} /></span>
          <div><h3>{selected.title}</h3><small>{[selected.projectLabel, providerNames[selected.provider] || selected.provider, selected.model, ...sessionAccounts].filter(Boolean).join(', ')}</small></div>
        </div>
        {sessionError && <p className="stats-error" role="alert">{sessionError}</p>}
        {!session && !sessionError && <p className="stats-empty" role="status">세션을 불러오는 중…</p>}
        {session && <>
          <div className="stats-tiles">
            <StatTile label="턴" value={num(session.summary.turns)} />
            <StatTile label="토큰 가중치" value={num(session.summary.weight)} />
            <StatTile label="보고 비용" value={money(session.summary.costUsd)} />
            <StatTile label="캐시 적중률" value={percent(session.summary.cacheHitRate)} />
          </div>
          <UsageAssessment report={session.report} copy />
          <section className="stats-panel">
            <div className="stats-section-head"><h3>토큰 구성</h3></div>
            {Object.values(session.summary.tokens).some(Boolean) ? <dl className="review-token-list">
              {([['input', '입력'], ['output', '출력'], ['cacheRead', '캐시 읽기'], ['cacheCreate', '캐시 쓰기']] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{num(session.summary.tokens[key])}</dd></div>)}
            </dl> : <p className="stats-empty">기록된 토큰이 없어요.</p>}
          </section>
        </>}
      </> : <>
        {error && <p className="stats-error" role="alert">{error}</p>}
        {!data && loading && <p className="stats-empty" role="status">사용 기록을 불러오는 중…</p>}
        {data && !error && (data.turns === 0 ? <div className="review-empty">
          <Icon name="chart" size={28} /><strong>이 조건에 맞는 사용 기록이 없어요.</strong><span>기간이나 필터를 변경해 보세요.</span>
        </div> : page === 'overview' ? <>
          <div className="stats-tiles">
            <StatTile label="사용 턴" value={num(data.turns)} />
            <StatTile label="세션" value={num(data.sessions)} />
            <StatTile label="토큰 가중치" value={num(data.weight)} />
            <StatTile label="보고 비용" value={money(data.costUsd)} hint={data.unknownCostTurns > 0 ? `${num(data.unknownCostTurns)}턴 비용 미제공` : undefined} />
            <StatTile label="캐시 적중률" value={percent(data.cacheHitRate)} />
          </div>
          <UsageAssessment report={data.report} copy />
          <div className="review-charts">
            <Activity data={data} />
            <section className="stats-panel review-breakdown">
              <div className="stats-section-head"><h3>AI</h3><small>턴</small></div>
              <BreakdownBars rows={data.providers} metric="turns" total={data.turns} />
              <div className="stats-section-head"><h3>프로젝트</h3><small>토큰 가중치</small></div>
              <BreakdownBars rows={data.projects.slice(0, 5)} metric="weight" total={data.weight} />
            </section>
          </div>
        </> : <section className="review-sessions" aria-label="세션 목록">
          <table className="stats-table"><thead><tr><th scope="col">대화</th><th scope="col">턴</th><th scope="col">가중치</th><th scope="col">비용</th><th scope="col">마지막 활동</th></tr></thead>
            <tbody>{data.sessionPage.rows.map(row => <tr key={rowKey(row)}>
              <td><button type="button" className="review-session-link" data-session-row={rowKey(row)} title={row.title} disabled={loading} onClick={() => {
                openedFrom.current = { key: rowKey(row), scrollTop: body.current?.scrollTop ?? 0 };
                setSession(null);
                setSessionError('');
                setSelected(row);
              }}><Icon name={row.provider} size={15} /><span><strong>{row.title}</strong><small>{[row.projectLabel, row.model].filter(Boolean).join(', ')}</small></span></button></td>
              <td>{num(row.turns)}</td><td>{num(row.weight)}</td><td>{money(row.costUsd)}</td><td>{when(row.lastAt)}</td>
            </tr>)}</tbody>
          </table>
          {sessionTotal > PAGE_SIZE && <div className="review-pager">
            <button type="button" disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}>이전</button>
            <span>{offset + 1}–{Math.min(sessionTotal, offset + data.sessionPage.rows.length)} / {num(sessionTotal)}</span>
            <button type="button" disabled={loading || offset + PAGE_SIZE >= sessionTotal} onClick={() => setOffset(value => value + PAGE_SIZE)}>다음</button>
          </div>}
        </section>)}
      </>}
    </div>
  </Modal>;
}
