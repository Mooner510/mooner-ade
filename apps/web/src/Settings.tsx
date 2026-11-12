import { appKey, appKeyDefs, combosOverlap, showAppKey } from './shortcuts';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { api } from './api';
import { agentNames, chatStatusLayout, defaultSettings, statusLayout, terminalFontStack, usageHue, type Settings } from './Editor';
import { chatItemView, chatStatusDefs, chatStatusLabels } from './ChatStatus';
import { chatKey, chatKeyDefs, comboOf, emptyState, showCombo, validCombo } from './chat-model';
import { Icon, IconButton, type IconName } from './Icon';
import { PluginSettings } from './PluginSettings';
import { useShells } from './shells';
import { useMissingAgents } from './installed-agents';
import { Dropdown, Modal } from './views';
import { playSound, soundIds, sounds } from './sound';
import { resetTips } from './toast';
import { installedTerminalFonts, monoFontDropdownOptions } from './terminal-fonts';
import { useFeedback } from './feedback-store';
import { feedbackEffort, feedbackModelId, submitModeNote, submitModeText } from './feedback-model';
import { AI_EFFORTS, AI_MODELS } from './FeedbackPanel';

type Desktop = { setZoom(percent: number): void; appInfo(): Promise<{ version: string; dev?: boolean }>; checkUpdate(): Promise<string>; getBetaUpdates(): Promise<boolean>; setBetaUpdates(beta: boolean): Promise<boolean> };
const desktop = () => (window as unknown as { adeDesktop?: Partial<Desktop> }).adeDesktop;

// Whether feedback can be sent right now: the remote-access plugin reports the login it would submit with.
function FeedbackAvailabilityRow() {
  const { available, loaded, error } = useFeedback();
  const kind = !loaded ? 'checking' : error || !available?.ok ? 'off' : available.mode === 'anonymous' ? 'anonymous' : 'account', note = loaded && !error ? submitModeNote(available) : '';
  return <Row title="제출 방식" hint="원격 접속에 로그인했으면 그 계정으로, 아니면 로그인 없이 개발자의 비공개 GitHub 저장소에 이슈로 올라갑니다. 제출한 피드백은 순서대로 자동 전송됩니다.">
    <span className="feedback-mode-wrap">
      <span className={`feedback-mode ${kind}`}><Icon name={kind === 'account' ? 'person' : kind === 'off' ? 'alert' : 'info'} size={14} />{!loaded ? '확인 중…' : error || submitModeText(available)}</span>
      {note && <small>{note}</small>}
    </span>
  </Row>;
}

function AboutSettings() {
  const [version, setVersion] = useState(''), [checking, setChecking] = useState(false), [beta, setBeta] = useState<boolean | null>(null);
  useEffect(() => { void desktop()?.appInfo?.().then(info => setVersion(info.dev ? `${info.version} (dev)` : info.version), () => {}); void desktop()?.getBetaUpdates?.().then(setBeta, () => {}); }, []);
  const canCheck = typeof desktop()?.checkUpdate === 'function';
  return <>
    <Row title="현재 버전" hint="새 버전은 실행 5초 뒤와 이후 10분마다 자동으로 확인합니다. 종료할 때 설치하거나, 진행 중인 작업을 중단하고 바로 설치할 수 있습니다."><span>{version || '—'}</span></Row>
    {beta !== null && <Row title="베타 업데이트 받기" hint="0.4.1-beta1 같은 시험 버전도 받습니다. 정식 버전보다 불안정할 수 있습니다. 끄면 다음 정식 버전이 나올 때까지 지금 버전을 유지합니다.">
      <input type="checkbox" role="switch" aria-label="베타 업데이트 받기" checked={beta} onChange={event => { const next = event.target.checked; setBeta(next); void desktop()!.setBetaUpdates!(next).then(setBeta, () => setBeta(!next)); }} />
    </Row>}
    {canCheck && <Row title="업데이트 확인" hint="GitHub 최신 릴리스(베타를 켰다면 베타 포함)와 비교합니다. 새 버전이 있으면 설치 여부를 묻습니다.">
      <button type="button" disabled={checking} onClick={() => { setChecking(true); void desktop()!.checkUpdate!().finally(() => setChecking(false)); }}><Icon name="refresh" />{checking ? '확인 중…' : '지금 확인'}</button>
    </Row>}
  </>;
}

export type Section = 'appearance' | 'terminal' | 'ai' | 'chat' | 'status' | 'diff' | 'wakatime' | 'plugins' | 'feedback' | 'keys' | 'about';
const sections: { id: Section; label: string; icon: IconName }[] = [
  { id: 'appearance', label: '외관', icon: 'panelLeft' },
  { id: 'terminal', label: '터미널', icon: 'terminal' },
  { id: 'ai', label: 'AI 툴', icon: 'claude' },
  { id: 'chat', label: '채팅', icon: 'chat' },
  { id: 'status', label: '상태바', icon: 'statusBar' },
  { id: 'diff', label: '변경사항', icon: 'diff' },
  { id: 'wakatime', label: 'WakaTime', icon: 'clock' },
  { id: 'plugins', label: '플러그인', icon: 'plugin' },
  { id: 'feedback', label: '피드백', icon: 'feedback' },
  { id: 'keys', label: '단축키', icon: 'code' },
  { id: 'about', label: '정보', icon: 'info' }
];
type AiTab = 'common' | 'claude' | 'codex' | 'cursor';
const aiTabs: { id: AiTab; label: string; icon: IconName }[] = [
  { id: 'common', label: '공용', icon: 'settings' },
  { id: 'claude', label: agentNames.claude, icon: 'claude' },
  { id: 'codex', label: agentNames.codex, icon: 'codex' },
  { id: 'cursor', label: agentNames.cursor, icon: 'cursor' }
];
export const statusLabels: Record<string, string> = {
  connection: '연결 상태', path: '프로젝트 경로', branch: '브랜치', changes: '변경 파일 수', terminals: '터미널 수', size: '터미널 크기', cpu: 'CPU 사용률', memory: '메모리 사용량',
  claudeusage: 'Claude Code 사용량', codexusage: 'Codex 사용량', cursorusage: 'Cursor 사용량', clock: '시계', wakatime: 'WakaTime 오늘 기록', readiness: '에이전트 준비 상태', openproject: '프로젝트 열기 버튼'
};
const statusHints: Record<string, string> = {
  claudeusage: '5시간·주간 한도 사용률. Claude Code 로그인 정보로 조회합니다.',
  codexusage: '5시간·주간 한도 사용률. Codex ChatGPT 로그인 또는 최근 세션 기록으로 조회합니다.',
  cursorusage: '청구 주기·모델 풀·Grok Bot 한도. cursor-agent 또는 Cursor 앱 로그인 정보로 조회합니다.'
};

// How each item looks in the real status bar, with sample values; shown under the item's name so its meaning is clear at a glance.
function statusSamples(settings: Settings): Record<string, ReactNode> {
  const usage = (provider: 'claude' | 'codex' | 'cursor', windows: [string, number][]) => <span className="stat usage"><Icon name={provider} size={13} />
    {windows.map(([key, percent]) => <span key={key} className={`usage-window ${settings.usageColors ? 'graded' : ''}`} style={settings.usageColors ? { '--usage-hue': usageHue(percent) } as CSSProperties : undefined}><small>{key}</small>{percent}%<i style={{ width: `${percent}%` }} /></span>)}
  </span>;
  const time = new Date(2025, 0, 1, 14, 32, 8).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: settings.clockSeconds ? '2-digit' : undefined, hour12: settings.clock12h });
  return {
    connection: <span className="conn"><Icon name="wifi" size={13} />연결 끊김</span>,
    path: <span className="stat"><Icon name="folder" size={13} />~/projects/my-app</span>,
    branch: <span className="stat"><Icon name="branch" size={13} />main</span>,
    changes: <span className="stat"><Icon name="diff" size={13} />3개 파일<ins>+42</ins><del>−7</del></span>,
    terminals: <span className="stat"><Icon name="terminal" size={13} />2</span>,
    size: <span className="stat">120×32</span>,
    cpu: <span className="stat">12%</span>,
    memory: <span className="stat">6.4GB</span>,
    claudeusage: usage('claude', settings.claudeSession ? [['5h', 23], ['주', 41]] : [['주', 41]]),
    codexusage: usage('codex', [['5h', 8], ['주', 17]]),
    cursorusage: usage('cursor', [['Cursor', 20], ['기타', 40], ['전체', 25]]),
    wakatime: <span className="stat"><Icon name="clock" size={13} />2시간 14분</span>,
    clock: <span className="stat"><Icon name="clock" size={13} />{time}</span>,
    readiness: <span className="stat"><Icon name="info" size={13} /></span>,
    openproject: <span className="stat"><Icon name="folderPlus" size={14} /></span>
  };
}

type Side = 'left' | 'right';
// Two columns mirror the status bar; rows drag within and across them, and Alt+arrows do the same from the keyboard.
// `chat` edits the chat tab's status line instead: same drag layout, plus a color / icon / format override per item.
const sampleChat = { ...emptyState(), model: 'claude-sonnet-4-5', sessionId: '0f3a9c21-0000', contextTokens: 52_000, costUsd: 0.42, turns: 6, durationMs: 185_000, tokens: { input: 48_000, output: 6_200, cacheRead: 120_000, cacheCreate: 3_000 } };
function StatusLayoutEditor({ settings, onChange, chat = false }: { settings: Settings; onChange(settings: Settings): void; chat?: boolean }) {
  const query = useContext(settingsQuery);
  const layout = chat ? chatStatusLayout(settings) : statusLayout(settings), items = chat ? settings.chatStatusItems : settings.statusItems, shown = new Set(items);
  const keys_ = chat ? { items: 'chatStatusItems', left: 'chatStatusLeft', right: 'chatStatusRight' } as const : { items: 'statusItems', left: 'statusLeft', right: 'statusRight' } as const;
  const labels = chat ? chatStatusLabels : statusLabels, base = statusSamples(settings);
  const sample = (id: string) => { const view = chat ? chatItemView(id, { state: sampleChat }) : null; return chat ? <span className="stat" style={{ color: view?.color }}>{view?.text}{view?.extra && ` ${view.extra.text}`}</span> : base[id]; };
  const [dragging, setDragging] = useState(''), [drop, setDrop] = useState<{ side: Side; index: number } | null>(null);
  const place = (id: string, side: Side, index: number) => {
    const next = { left: layout.left.filter(item => item !== id), right: layout.right.filter(item => item !== id) };
    const from = layout[side].indexOf(id);
    next[side].splice(from >= 0 && from < index ? index - 1 : index, 0, id);
    onChange({ ...settings, [keys_.left]: next.left, [keys_.right]: next.right });
  };
  const toggle = (id: string, on: boolean) => onChange({ ...settings, [keys_.items]: on ? [...items.filter(item => item !== id), id] : items.filter(item => item !== id) });
  const over = (event: DragEvent, side: Side, index: number) => {
    if (!dragging) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
    if (drop?.side !== side || drop.index !== index) setDrop({ side, index });
  };
  const finish = (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); if (dragging && drop) place(dragging, drop.side, drop.index); setDragging(''); setDrop(null); };
  const keys = (event: KeyboardEvent, id: string, side: Side, index: number) => {
    if (!event.altKey) return;
    const other: Side = side === 'left' ? 'right' : 'left';
    const target = ({ ArrowUp: [side, Math.max(0, index - 1)], ArrowDown: [side, Math.min(layout[side].length, index + 2)], ArrowLeft: side === 'right' ? [other, layout.left.length] : null, ArrowRight: side === 'left' ? [other, 0] : null } as Record<string, [Side, number] | null>)[event.key];
    if (!target) return;
    event.preventDefault(); place(id, ...target);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-status-item="${chat ? "chat:" : ""}${id}"]`)?.focus());
  };
  const column = (side: Side) => <section className={`status-column ${drop?.side === side ? 'drop-target' : ''}`} aria-label={side === 'left' ? '왼쪽' : '오른쪽'}
    onDragOver={event => over(event, side, layout[side].length)} onDrop={finish}>
    <h4>{side === 'left' ? '왼쪽' : '오른쪽'}</h4>
    <ul>{layout[side].map((id, index) => {
      const marker = drop?.side === side && dragging !== id ? drop.index === index ? 'drop-before' : drop.index === index + 1 && index === layout[side].length - 1 ? 'drop-after' : '' : '';
      const hint = id === 'wakatime' && !settings.wakatime ? 'WakaTime 작업 시간 기록을 켜야 표시됩니다.' : chat ? chatStatusDefs[id]?.hint ?? statusHints[id] : statusHints[id];
      if (!queryHit(query, `${labels[id] ?? id} ${hint ?? ''}`)) return null;
      return <li key={id} data-status-item={`${chat ? 'chat:' : ''}${id}`} tabIndex={0} draggable className={`setting-hit ${shown.has(id) ? '' : 'off'} ${dragging === id ? 'dragging' : ''} ${marker}`}
        title="끌어서 순서와 위치를 바꿉니다 (Alt+화살표)"
        onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id); setDragging(id); }}
        onDragOver={event => { const box = event.currentTarget.getBoundingClientRect(); over(event, side, event.clientY < box.top + box.height / 2 ? index : index + 1); }}
        onDrop={finish} onDragEnd={() => { setDragging(''); setDrop(null); }} onKeyDown={event => keys(event, id, side, index)}>
        <Icon name="grip" size={14} />
        <span><strong>{labels[id] ?? id}</strong><span className="statusbar status-sample" aria-hidden="true">{sample(id)}</span>{hint && <small>{hint}</small>}</span>
        <span className="setting-control"><input type="checkbox" role="switch" aria-label={`${labels[id] ?? id} 표시`} checked={shown.has(id)} onChange={event => toggle(id, event.target.checked)} /></span>
      </li>;
    })}</ul>
  </section>;
  const defaults = chat ? chatStatusLayout(defaultSettings) : statusLayout(defaultSettings);
  const isDefault = JSON.stringify([layout, [...items].sort()]) === JSON.stringify([defaults, [...defaultSettings[keys_.items]].sort()]) && (!chat || !settings.chatStatusSeparator);
  return <div className="setting-block">
    <div className="status-intro">
      <p className="setting-note">항목을 끌어 왼쪽·오른쪽과 순서를 정하고, 스위치로 켜고 끕니다. 키보드로는 항목에서 Alt+화살표를 누릅니다.</p>
      <button disabled={isDefault} title="배치와 표시 항목을 처음 상태로 되돌립니다" onClick={() => onChange({ ...settings, [keys_.left]: defaultSettings[keys_.left], [keys_.right]: defaultSettings[keys_.right], [keys_.items]: defaultSettings[keys_.items], ...(chat && { chatStatusSeparator: '' }) })}><Icon name="refresh" size={13} />기본값으로</button>
    </div>
    {chat && <Row title="항목 구분자" hint="항목 사이에 넣을 문자입니다 (최대 8자, 비우면 간격만).">
      <input type="text" maxLength={8} value={settings.chatStatusSeparator} aria-label="항목 구분자" onChange={event => onChange({ ...settings, chatStatusSeparator: event.target.value })} /></Row>}
    <div className="status-layout">{column('left')}{column('right')}</div>
    {chat ? <p className="setting-note">모델은 계열(Fable·Opus·Sonnet·Haiku·Astra·Sol·Terra·Luna)마다 색이 다릅니다. Cursor는 Provider별 색상과 First Party(흰색)·Third Party 구분을 표시합니다. 컨텍스트는 사용률에 따라 색이 변합니다. 브랜치·사용량·시계 등은 하단 상태바에 있어 채팅 상태 표시줄에는 넣지 않습니다.</p> :
    <p className="setting-note">사용량 색은 ‘외관’에 있고, 5시간 한도·갱신 주기는 ‘AI 툴’에 있습니다.</p>}
  </div>;
}

type WakaTimeStatus = { enabled: boolean; cli: string | null; lastSent: number; lastError: string | null; apiKey: string; apiUrl: string; today: string };
function WakaTimeSettings({ settings, set, onChange }: { settings: Settings; set<K extends keyof Settings>(key: K, value: Settings[K]): void; onChange(settings: Settings): void }) {
  const [status, setStatus] = useState<WakaTimeStatus | null>(null);
  const [apiKey, setApiKey] = useState(''), [apiUrl, setApiUrl] = useState<string | null>(null), [message, setMessage] = useState('');
  const load = () => api<WakaTimeStatus>('wakatime/status').then(setStatus, () => {});
  useEffect(() => {
    void load(); const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [settings.wakatime]);
  const save = (input: { apiKey?: string; apiUrl?: string }) => api('wakatime/config', input).then(() => { setMessage('저장했습니다.'); setApiKey(''); setApiUrl(null); void load(); }, (error: Error) => setMessage(error.message));
  const toggle = (key: 'wakatime' | 'wakatimeBackground', label: string) =>
    <input type="checkbox" role="switch" aria-label={label} checked={settings[key]} onChange={event => set(key, event.target.checked)} />;
  return <>
    <p className="setting-note">API 키와 주소는 ~/.wakatime.cfg에 저장되어 이 컴퓨터의 다른 WakaTime 플러그인과 함께 씁니다. 대시보드에는 에디터 이름이 MoonerADE로 표시됩니다.</p>
    <Row title="작업 시간 기록" hint="앱 창이 열려 있는 동안 보고 있는 프로젝트를 2분마다 기록합니다. 그 프로젝트의 에이전트가 작업 중이면 ai coding으로 기록합니다.">
      {/* Turning recording on also puts today's total in the status bar; it can be hidden again below. */}
      <input type="checkbox" role="switch" aria-label="작업 시간 기록" checked={settings.wakatime} onChange={event => onChange({ ...settings, wakatime: event.target.checked, statusItems: event.target.checked && !settings.statusItems.includes('wakatime') ? [...settings.statusItems, 'wakatime'] : settings.statusItems })} />
    </Row>
    {settings.wakatime && <>
      <Row title="상태바에 오늘 기록 표시" hint="하단 상태바에 오늘 WakaTime에 기록된 시간을 표시합니다."><input type="checkbox" role="switch" aria-label="상태바에 오늘 기록 표시" checked={settings.statusItems.includes('wakatime')} onChange={event => set('statusItems', event.target.checked ? [...settings.statusItems, 'wakatime'] : settings.statusItems.filter(item => item !== 'wakatime'))} /></Row>
      <Row title="백그라운드 에이전트 작업도 기록" hint="다른 프로젝트에서 에이전트가 작업 중이면 그 프로젝트도 ai coding으로 기록합니다. WakaTime은 시간을 겹쳐 세지 않으므로 같은 시간을 프로젝트끼리 나눠 가집니다.">{toggle('wakatimeBackground', '백그라운드 에이전트 작업도 기록')}</Row>
    </>}
    {status && <>
      <Row title="wakatime-cli" hint={status.cli ?? 'WakaTime 플러그인을 하나 설치하거나 wakatime-cli를 PATH에 두세요.'}><span>{status.cli ? '찾음' : '없음'}</span></Row>
      {status.cli && <>
        <Row title="API 키" hint={status.apiKey ? `현재 ${status.apiKey}` : 'wakatime.com/settings/api-key 에서 발급받으세요.'}>
          <input type="password" value={apiKey} placeholder="waka_…" autoComplete="off" aria-label="API 키" onChange={event => setApiKey(event.target.value)} />
          <button disabled={!apiKey.trim()} onClick={() => void save({ apiKey })}>저장</button>
        </Row>
        <Row title="API 주소" hint="Wakapi 등 자체 서버를 쓸 때만 입력합니다. 비우면 wakatime.com을 씁니다.">
          <input type="text" value={apiUrl ?? status.apiUrl} placeholder="https://api.wakatime.com/api/v1" maxLength={512} aria-label="API 주소" onChange={event => setApiUrl(event.target.value)} />
          <button disabled={apiUrl === null || apiUrl === status.apiUrl} onClick={() => void save({ apiUrl: apiUrl!.trim() })}>저장</button>
        </Row>
        {message && <p className="setting-note">{message}</p>}
      </>}
      {settings.wakatime && <>
        <Row title="오늘 기록된 시간" hint="이 컴퓨터의 모든 에디터를 합친 시간입니다."><span>{status.today || '—'}</span></Row>
        <Row title="마지막 전송" hint={status.lastError ?? undefined}><span>{status.lastSent ? new Date(status.lastSent).toLocaleTimeString() : '아직 없음'}</span></Row>
      </>}
    </>}
  </>;
}

// API key the chat mode runs this agent with instead of the CLI's login. The key stays on the local server; only its last four characters come back.
type KeyAgent = 'claude' | 'codex' | 'cursor';
type AgentKeyStatus = Record<KeyAgent, { use: boolean; key: string }>;
const keySources: Record<KeyAgent, { placeholder: string; where: string; billing: string }> = {
  claude: { placeholder: 'sk-ant-…', where: 'console.anthropic.com의 API Keys', billing: 'Anthropic API 사용량' },
  codex: { placeholder: 'sk-…', where: 'platform.openai.com의 API keys', billing: 'OpenAI API 사용량' },
  cursor: { placeholder: 'key_…', where: 'cursor.com 대시보드의 Integrations > User API Keys', billing: 'Cursor 계정의 API 키 사용량' },
};
function ChatAuthSettings({ agent }: { agent: KeyAgent }) {
  const [status, setStatus] = useState<AgentKeyStatus | null>(null), [key, setKey] = useState(''), [message, setMessage] = useState('');
  useEffect(() => { void api<AgentKeyStatus>('agent-keys/status').then(setStatus, () => {}); }, []);
  const save = (input: { key?: string; use?: boolean }, done: string) => api<AgentKeyStatus>('agent-keys/config', { agent, ...input }).then(next => { setStatus(next); setKey(''); setMessage(done); }, (error: Error) => setMessage(error.message));
  const entry = status?.[agent], source = keySources[agent];
  return <>
    <h4 className="setting-group">채팅 인증</h4>
    <Row title="채팅 인증 방식" hint={`채팅 모드에서 ${agentNames[agent]}를 실행할 계정입니다. API 키를 고르면 ${source.billing}으로 과금되고, 터미널(CLI)로 연 에이전트와 상태바 사용량은 계속 CLI 로그인 기준입니다. 다음에 시작하는 채팅부터 적용됩니다.`}>
      {status && <Dropdown label={`${agentNames[agent]} 채팅 인증 방식`} value={entry?.use ? 'key' : 'login'}
        options={[{ value: 'login', label: 'CLI 로그인' }, { value: 'key', label: 'API 키', ...(!entry?.key && { hint: '먼저 키를 저장하세요' }) }]}
        onChange={value => void save({ use: value === 'key' }, value === 'key' ? 'API 키로 실행합니다.' : 'CLI 로그인으로 실행합니다.')} />}
    </Row>
    <Row title={`${agentNames[agent]} API 키`} hint={entry?.key ? `현재 ${entry.key}${entry.use ? ' · 사용 중' : ' · 저장만 됨'} · 이 컴퓨터에만 저장되며 화면에는 끝 4자리만 보입니다.` : `${source.where}에서 발급받으세요. 저장하면 바로 이 키를 씁니다.`}>
      <input type="password" value={key} placeholder={source.placeholder} autoComplete="off" spellCheck={false} aria-label={`${agentNames[agent]} API 키`}
        onChange={event => setKey(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && key.trim()) void save({ key }, '저장했습니다. 다음에 시작하는 채팅부터 이 키를 씁니다.'); }} />
      <button disabled={!key.trim()} onClick={() => void save({ key }, '저장했습니다. 다음에 시작하는 채팅부터 이 키를 씁니다.')}>저장</button>
      {entry?.key && <button onClick={() => void save({ key: '' }, '삭제했습니다. CLI 로그인으로 실행합니다.')}>삭제</button>}
    </Row>
    {message && <p className="setting-note" role="status">{message}</p>}
  </>;
}

function ShellSetting({ settings, set }: { settings: Settings; set<K extends keyof Settings>(key: K, value: Settings[K]): void }) {
  const list = useShells();
  const auto = list?.shells.find(item => item.id === list.default);
  const saved = settings.terminalShell && list && !list.shells.some(item => item.id === settings.terminalShell);
  return <Row title="기본 셸" hint={`새 터미널에 쓸 셸입니다. 이미 열린 터미널은 그대로입니다.${saved ? ' 저장된 셸이 이 컴퓨터에 없어 자동 선택을 씁니다.' : ''}${list && !list.shells.some(item => item.id === 'pwsh') && list.shells.some(item => item.id === 'powershell') ? ' PowerShell 7은 winget install Microsoft.PowerShell 로 설치할 수 있습니다.' : ''}`}>
    <Dropdown label="기본 셸" value={saved ? '' : settings.terminalShell}
      options={[{ value: '', label: `자동${auto ? ` (${auto.label})` : ''}` }, ...(list?.shells ?? []).map(item => ({ value: item.id, label: item.label }))]}
      onChange={value => set('terminalShell', value)} />
  </Row>;
}

const settingsQuery = createContext('');
function queryHit(query: string, text: string) {
  const q = query.trim().toLowerCase();
  return !q || text.toLowerCase().includes(q);
}

// Rarely changed settings, folded away so the common ones stay short. Search opens them so those rows can match.
function Advanced({ children }: { children: ReactNode }) {
  const searching = useContext(settingsQuery).trim() !== '';
  return <details className="setting-advanced" key={searching ? 'open' : 'shut'} open={searching || undefined}><summary><Icon name="chevronDown" size={14} />고급 옵션</summary>{children}</details>;
}

// `preview` names the appearance sample. `false` keeps the side column and says there is nothing to show.
const lookHover = createContext<{ id: string; set(id: string): void }>({ id: '', set() {} });
function Row({ title, hint, preview, children }: { title: string; hint?: string; preview?: string | false; children: ReactNode }) {
  const look = useContext(lookHover);
  if (!queryHit(useContext(settingsQuery), `${title} ${hint ?? ''}`)) return null;
  const show = preview === undefined ? undefined : () => look.set(preview || 'none');
  return <div className={`setting-row${preview && look.id === preview ? ' hot' : ''}`} onMouseEnter={show} onFocusCapture={show}><div><strong>{title}</strong>{hint && <small>{hint}</small>}</div><div className="setting-control">{children}</div></div>;
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return <div className="setting-block">{title && <h4 className="setting-group">{title}</h4>}{children}</div>;
}

function SectionFrame({ label, searching, children }: { label: string; searching: boolean; children: ReactNode }) {
  if (!searching) return children;
  return <div className="setting-block"><h3 className="settings-search-title">{label}</h3>{children}</div>;
}

// Where the user dragged the settings dialog. Module state on purpose: it survives closing and reopening the dialog,
// and an app restart (a fresh page) puts it back in the centre.
let settingsOffset = { x: 0, y: 0 };
// Moves the dialog by (x, y) from its centred spot, clamped so no edge leaves the window.
function placeSettings(dialog: HTMLElement, x: number, y: number) {
  dialog.style.translate = '';
  const rect = dialog.getBoundingClientRect();
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
  // Leave the bottom status bar clear while that section is showing it live.
  const bottom = dialog.classList.contains('bar-live') ? 36 : 0;
  settingsOffset = { x: clamp(x, -rect.left, innerWidth - rect.right), y: clamp(y, -rect.top, innerHeight - bottom - rect.bottom) };
  dialog.style.translate = `${settingsOffset.x}px ${settingsOffset.y}px`;
}
function dragSettings(event: PointerEvent<HTMLElement>) {
  if (event.button !== 0 || (event.target as Element).closest('button, input, select, textarea, a')) return;
  const handle = event.currentTarget, dialog = handle.closest('dialog')!;
  const start = { x: event.clientX - settingsOffset.x, y: event.clientY - settingsOffset.y };
  handle.setPointerCapture(event.pointerId);
  const move = (next: globalThis.PointerEvent) => placeSettings(dialog, next.clientX - start.x, next.clientY - start.y);
  const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('lostpointercapture', end); };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('lostpointercapture', end);
}

const lookThemes = {
  dark: { bg: '#0c0d0f', surface: '#141518', line: '#24262b', fg: '#e4e6ea', muted: '#8b9099', accent: '#5ec8e5' },
  light: { bg: '#eceef1', surface: '#ffffff', line: '#dfe2e7', fg: '#1d2127', muted: '#626a75', accent: '#0b8db3' }
};
const lookNames: Record<string, string> = {
  theme: '색 테마', accent: '강조 색', dim: '비활성 pane', zoom: '화면 배율', sidebar: '사이드바 접기', sidebarWidth: '사이드바 너비',
  termSize: '글꼴 크기', termFont: '글꼴', termWeight: '글꼴 굵기', termCursor: '커서 모양', termBlink: '커서 깜빡임',
  termName: '글꼴 이름', termLine: '줄 높이', termSpace: '글자 간격', termContrast: '최소 대비', termBold: '굵은 글자',
  chatSize: '채팅 글꼴', chatWidth: '대화 너비', chatComposer: '입력창 높이', chatTools: '도구 호출', chatToolMode: '도구 호출 표시', chatThink: '생각 과정', chatStream: '부드러운 스트리밍',
  diffSize: 'diff 글꼴 크기', diffFont: 'diff 글꼴', diffName: 'diff 글꼴 이름', diffWrap: '자동 줄바꿈', diffLayout: 'diff 표시', diffFold: '구간 접기', diffContext: '주변 줄', diffWidth: '패널 너비',
  usage: '사용량 색', clock12: '12시간제', clockSec: '초 표시'
};
const TOOL_PREVIEW = ['Read src/app.ts', 'Grep PORT', 'Edit src/server.ts', 'Bash npm test'];
function LookPreview({ id, settings }: { id: string; settings: Settings }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if ((id !== 'clock12' && id !== 'clockSec') || !settings.clockSeconds) return;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [id, settings.clockSeconds]);
  if (!id || id === 'none') return <aside className="look-preview" aria-label="설정 미리보기"><p className="look-empty">미리보기가 없습니다</p></aside>;
  const paint = lookThemes[settings.theme];
  const accent = settings.accentColor || paint.accent;
  const mono = terminalFontStack;
  const family = id.startsWith('term') ? 'term' : id.startsWith('chat') ? 'chat' : id.startsWith('diff') ? 'diff' : id;
  const shell = family === 'theme' || family === 'accent' || family === 'dim' || family === 'zoom' || family === 'sidebar' || family === 'sidebarWidth';
  return <aside className="look-preview" aria-label="설정 미리보기">
    <h4>{lookNames[id] ?? '미리보기'}</h4>
    {shell && <div className="look-zoom">
      <div className="look-app" style={{ '--l-bg': paint.bg, '--l-surface': paint.surface, '--l-line': paint.line, '--l-fg': paint.fg, '--l-muted': paint.muted, '--l-accent': accent, ...(id === 'zoom' ? { transform: `scale(${settings.uiZoom / 100})`, transformOrigin: 'top left' } : {}) } as CSSProperties}>
        <div className={`look-side${settings.sidebarCompact && id !== 'sidebarWidth' ? ' compact' : ''}`} style={!settings.sidebarCompact || id === 'sidebarWidth' ? { width: 22 + (settings.sidebarWidth - 160) / 8 } : undefined}>
          <i className="on" /><i /><i />
        </div>
        <div className="look-panes">
          <div className="look-pane on"><b /><b className="short" /></div>
          <div className={`look-pane${settings.dimInactivePanes ? ' dim' : ''}`}><b /><b className="short" /></div>
        </div>
      </div>
    </div>}
    {family === 'term' && <pre className="look-term" style={{ fontFamily: mono(settings.terminalFont), fontSize: settings.terminalFontSize, fontWeight: settings.terminalFontWeight, lineHeight: settings.lineHeight, letterSpacing: settings.letterSpacing }}>
      <span className="dim">~/my-app $ </span>claude{'\n'}
      <span className={settings.boldBright ? 'bright' : ''} style={{ fontWeight: 700 }}>Claude</span> 포트를 환경 변수로 바꿉니다.{'\n'}
      <span style={{ color: settings.minimumContrast > 1 ? 'var(--fg)' : 'var(--faint)' }}>주석 · 낮은 대비</span>
      <span className={`look-caret ${settings.cursorStyle}${settings.cursorBlink ? ' blink' : ''}`} />
    </pre>}
    {family === 'chat' && <div className="look-chat" style={{ fontSize: settings.chatFontSize, width: ({ narrow: '78%', default: '88%', wide: '96%', full: '100%' } as const)[settings.chatWidth] }}>
      {settings.chatThinkingOpen !== 'never' && <p className="look-think">{settings.chatThinkingOpen === 'live' ? '생각 중…' : '포트를 상수에서 찾았습니다.'}</p>}
      <p className={settings.chatSmoothStream ? 'look-stream' : ''}>알겠어, 환경 변수로 바꿀게.</p>
      {id === 'chatToolMode' && <div className="look-tools">{settings.chatToolDisplay === 'summary'
        ? <div className="look-bundle"><div className="look-bundle-head"><i />도구 4개 · 실행 중</div><div className="look-bundle-rows">{TOOL_PREVIEW.map(row => <div key={row}>{row}</div>)}</div></div>
        : TOOL_PREVIEW.map(row => <div key={row} className="look-tool">{row}</div>)}</div>}
      <div className={`look-tool${settings.chatToolsOpen ? ' open' : ''}`}><b>Edit</b> src/server.ts{settings.chatToolsOpen && <small>PORT = process.env.PORT</small>}</div>
      <div className="look-compose" style={{ maxHeight: Math.round(settings.chatComposerMax / 4) }}>긴 글을 쓰면 이 높이에서 멈춥니다.</div>
    </div>}
    {family === 'diff' && <div className={`look-diff${settings.diffLayout === 'inline' ? '' : ' split'}${settings.wordWrap ? ' wrap' : ''}`} style={{ fontFamily: mono(settings.diffFont || settings.terminalFont), fontSize: settings.fontSize }}>
      {settings.diffLayout !== 'inline' && <div><div> const port = 3000;</div><div className="add"> const port = env.PORT;</div></div>}
      {settings.diffLayout === 'inline'
        ? <div><div className="del">- const port = 3000;</div><div className="add">+ const port = env.PORT;</div></div>
        : <div><div className="del"> const port = 3000;</div><div className="add"> const port = env.PORT;</div></div>}
      {settings.diffFoldUnchanged && <div className="fold">⋯ 바뀌지 않은 {settings.diffContextLines}줄 주변만</div>}
      {id === 'diffWidth' && <i style={{ width: `${Math.round((settings.reviewWidth - 320) / 1280 * 100)}%` }} />}
    </div>}
    {id === 'usage' && <p className="look-usage">{[10, 45, 70, 90].map(value => <span key={value} className={`usage-window${settings.usageColors ? ' graded' : ''}`} style={settings.usageColors ? { '--usage-hue': usageHue(value) } as CSSProperties : undefined}>{value}%</span>)}</p>}
    {id === 'clock12' || id === 'clockSec' ? <p className="look-clock">{now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: settings.clockSeconds ? '2-digit' : undefined, hour12: settings.clock12h })}</p> : null}
  </aside>;
}

export function SettingsModal({ settings, onChange, onClose, initialSection = 'appearance' }: { settings: Settings; onChange(settings: Settings): void; onClose(): void; initialSection?: Section }) {
  const [section, setSection] = useState<Section>(initialSection), [aiTab, setAiTab] = useState<AiTab>('common'), [statusTab, setStatusTab] = useState<'bar' | 'chat'>('bar'), [query, setQuery] = useState(''), [look, setLook] = useState('');
  const searching = query.trim() !== '';
  const missing = useMissingAgents();
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value });
  const number = (key: 'fontSize' | 'terminalFontSize' | 'scrollback' | 'sidebarWidth' | 'diffRefresh' | 'lineHeight' | 'cacheWarn' | 'cacheSendWarnMinutes' | 'contextTipK' | 'usageRefresh' | 'letterSpacing' | 'scrollSensitivity' | 'minimumContrast' | 'diffContextLines' | 'systemRefresh' | 'reviewWidth' | 'chatFontSize' | 'chatComposerMax' | 'uiZoom' | 'diffComputeMs', min: number, max: number, step = 1) =>
    <input type="number" min={min} max={max} step={step} value={settings[key]} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= min && value <= max && (step < 1 || Number.isInteger(value))) set(key, value as never); }} />;
  const toggle = (key: 'dimInactivePanes' | 'cursorBlink' | 'copyOnSelect' | 'notifyDone' | 'notifyApproval' | 'notifySound' | 'notifyLooking' | 'cacheTimer' | 'cacheSendWarn' | 'tips' | 'followUpQueue' | 'interactiveUi' | 'artifactAlways' | 'usageColors' | 'claudeSession' | 'rightClickPaste' | 'optionAsMeta' | 'confirmClose' | 'boldBright' | 'terminalGpu' | 'diffIgnoreWhitespace' | 'diffFoldUnchanged' | 'clock12h' | 'clockSeconds' | 'chatToolsOpen' | 'chatAutoScroll' | 'chatSmoothStream' | 'sidebarCompact' | 'confirmCloseChat' | 'confirmCloseProject' | 'feedbackAgentTool' | 'feedbackAiContext') =>
    <input type="checkbox" role="switch" checked={settings[key]} onChange={event => set(key, event.target.checked as never)} />;
  // Switch on = the agent is not in the list (shown / alerting).
  const inList = (key: 'agentsOff' | 'agentsMuted', agent: string, label: string) =>
    <input type="checkbox" role="switch" aria-label={label} checked={!settings[key].includes(agent)} onChange={event => set(key, event.target.checked ? settings[key].filter(item => item !== agent) : [...settings[key], agent])} />;
  const statusSwitch = (id: string, label: string) =>
    <input type="checkbox" role="switch" aria-label={label} checked={settings.statusItems.includes(id)} onChange={event => set('statusItems', event.target.checked ? [...settings.statusItems.filter(item => item !== id), id] : settings.statusItems.filter(item => item !== id))} />;
  const installedFonts = useMemo(() => installedTerminalFonts(), []);
  const terminalFontOptions = useMemo(() => monoFontDropdownOptions(settings.terminalFont, installedFonts, '시스템 기본'), [installedFonts, settings.terminalFont]);
  const diffFontOptions = useMemo(() => monoFontDropdownOptions(settings.diffFont, installedFonts, '터미널과 같음'), [installedFonts, settings.diffFont]);
  const argsRow = (agent: 'claude' | 'codex' | 'cursor', key: 'claudeArgs' | 'codexArgs' | 'cursorArgs', example: string) =>
    <Row title={`${agentNames[agent]} 추가 실행 인자`} hint={`실행할 때 명령 뒤에 붙입니다. 예: ${example} · 새로 여는 터미널과 되살리는 터미널에 적용되고, 이미 실행 중인 에이전트는 그대로입니다.`}>
      <input type="text" value={settings[key]} maxLength={512} placeholder={example} aria-label={`${agentNames[agent]} 추가 실행 인자`}
        onChange={event => set(key, event.target.value.replace(/[\x00-\x1f\x7f]/g, ''))} /></Row>;
  const soundPicker = (title: string, hint: string, key: 'soundDone' | 'soundAttention') =>
    <Row title={title} hint={hint}><Dropdown label={title} value={settings[key]} options={soundIds.map(id => ({ value: id, label: sounds[id].label }))} onChange={value => { set(key, value); playSound(value, settings.soundVolume); }} />
      <IconButton icon="bell" label={`${title} 미리 듣기`} onClick={() => playSound(settings[key], settings.soundVolume)} /></Row>;
  const root = useRef<HTMLDivElement>(null);
  const wide = !searching && section === 'appearance';
  const barLive = !searching && section === 'status' && statusTab === 'bar';
  const lookApi = useMemo(() => ({ id: look, set: setLook }), [look]);
  useEffect(() => {
    // Reapply the last spot, and keep it inside the window when the window shrinks or the preview opens.
    const dialog = root.current!.closest('dialog')!, fit = () => placeSettings(dialog, settingsOffset.x, settingsOffset.y);
    fit();
    const done = (event: TransitionEvent) => { if (event.target === dialog && (event.propertyName === 'width' || event.propertyName === 'height')) fit(); };
    dialog.addEventListener('transitionend', done);
    addEventListener('resize', fit);
    return () => { dialog.removeEventListener('transitionend', done); removeEventListener('resize', fit); };
  }, [wide, barLive]);
  const agentBody = (tab: 'claude' | 'codex' | 'cursor') => <>
    <h4 className="setting-group">실행</h4>
    <Row title="런처에 표시" hint="새 탭 메뉴, 새 pane, 명령 팔레트에 보입니다. 끄면 목록에서만 숨기며 실행 중인 에이전트에는 영향이 없습니다.">{inList('agentsOff', tab, `${agentNames[tab]} 표시`)}</Row>
    {tab === 'claude' && argsRow('claude', 'claudeArgs', '--model opus')}
    {tab === 'codex' && argsRow('codex', 'codexArgs', '--model gpt-5')}
    {tab === 'cursor' && argsRow('cursor', 'cursorArgs', '--model auto')}
    <ChatAuthSettings agent={tab} />
    <h4 className="setting-group">알림</h4>
    <Row title="이 에이전트의 알림" hint="끄면 알림과 소리를 모두 끕니다. 사이드바의 표시는 그대로입니다. 알림 종류와 소리는 ‘공용’에서 정합니다.">{inList('agentsMuted', tab, `${agentNames[tab]} 알림`)}</Row>
    {tab !== 'cursor' && <>
      <h4 className="setting-group">사용량 (상태바)</h4>
      {tab === 'claude' && <>
        <Row title="사용량 표시" hint="5시간·주간 한도 사용률. Claude Code 로그인 정보로 조회합니다.">{statusSwitch('claudeusage', 'Claude Code 사용량 표시')}</Row>
        <Row title="Claude 5시간 한도 표시" hint="5시간 한도가 없는 플랜(Ultra 등)이면 끄세요. 끄면 주간 한도만 표시합니다.">{toggle('claudeSession')}</Row>
      </>}
      {tab === 'codex' && <Row title="사용량 표시" hint="Codex ChatGPT 로그인 또는 최근 세션 기록으로 조회합니다.">{statusSwitch('codexusage', 'Codex 사용량 표시')}</Row>}
      <p className="setting-note">색은 ‘외관’에서, 갱신 주기는 ‘공용’에서 정합니다.</p>
    </>}
    {tab === 'cursor' && <>
      <h4 className="setting-group">사용량 (상태바)</h4>
      <Row title="사용량 표시" hint="청구 주기·모델 풀·Grok Bot 한도. cursor-agent login을 권장합니다(Keychain 비밀번호 창 없음). Cursor 앱만 로그인한 경우는 환경 변수 CURSOR_IDE_AUTH=1이 필요할 수 있습니다.">{statusSwitch('cursorusage', 'Cursor 사용량 표시')}</Row>
      <p className="setting-note">색은 ‘외관’에서, 갱신 주기는 ‘공용’에서 정합니다.</p>
    </>}
    {tab === 'claude' && <>
      <h4 className="setting-group">프롬프트 캐시·입력</h4>
      <Row title="프롬프트 캐시 타이머" hint="터미널·채팅 헤더와 사이드바에 캐시가 식기까지 남은 시간을 표시합니다.">{toggle('cacheTimer')}</Row>
      {settings.cacheTimer && <Row title="식기 전 경고 시점" hint="남은 시간이 이 비율 이하이면 노란색(곧 식음)으로 바뀝니다. (5–50%)">{number('cacheWarn', 5, 50)}</Row>}
      <Row title="캐시 만료 시 전송 경고" hint="캐시가 식었거나 곧 식을 때 메시지를 보내려 하면 먼저 확인을 받고, 허락하지 않으면 보내지 않습니다. 후속 대기열의 자동 전송에도 적용됩니다. 캐시 타이머 표시와는 별개입니다.">{toggle('cacheSendWarn')}</Row>
      {settings.cacheSendWarn && <Row title="경고 기준 남은 시간(분)" hint="1시간 캐시에서 남은 시간이 이 값 이하이면 경고합니다. (1–60분) 5분 캐시는 이미 식었을 때만 경고합니다.">{number('cacheSendWarnMinutes', 1, 60)}</Row>}
      <Row title="팁 표시" hint="컨텍스트가 길어졌을 때 /clear·/compact 안내, 마우스로 한 동작의 단축키 같은 도움말을 pane 모서리에 잠깐 띄웁니다.">{toggle('tips')}<button type="button" onClick={() => { resetTips(); }}>팁 기록 초기화</button></Row>
      {settings.tips && <Row title="컨텍스트 팁 기준(k 토큰)" hint="Claude 대화 컨텍스트가 이 크기 이상일 때 메시지를 보내면 /clear 팁을 보여 줍니다. 기본 400k는 1M 컨텍스트의 40%입니다. 같은 팁은 10분에 한 번만 나옵니다. (50–1000)">{number('contextTipK', 50, 1000)}</Row>}
      <Row title="Follow-up 대기열 (Tab)" hint="Claude가 작업 중일 때 입력창에서 Tab을 누르면 메시지를 대기열에 넣고 작업이 끝나면 보냅니다. 끄면 Tab은 항상 Claude Code로 전달됩니다.">{toggle('followUpQueue')}</Row>
      <Row title="인터랙티브 UI" hint="에이전트가 계산기·폼·미리보기처럼 UI가 더 나은 답변에 한해 채팅 안에 직접 조작하는 UI를 보여줍니다. UI는 격리된 샌드박스에서 실행되며, 끄면 일반 코드 블록으로 표시됩니다. 켜고 끄면 새 채팅부터 에이전트 지침에 반영됩니다.">{toggle('interactiveUi')}</Row>
      <Row title="Artifact 항상 켜기" hint="Chat에서 Artifact 도구는 기본으로 꺼져 있다가 메시지에 ‘artifact’ 또는 ‘아티팩트’가 들어가면 그 채팅에서 자동으로 켜집니다. 켜면 모든 채팅이 처음부터 Artifact를 갖지만, 요청마다 컨텍스트가 약 1.3만 토큰 늘어납니다. 한번 켜진 채팅은 닫기 전까지 꺼지지 않습니다.">{toggle('artifactAlways')}</Row>
    </>}
  </>;
  return <Modal className={`settings-modal${wide ? ' wide' : ''}${barLive ? ' bar-live' : ''}`} labelledBy="settings-title" region="설정" onClose={onClose}>
    <settingsQuery.Provider value={query}>
    <lookHover.Provider value={lookApi}>
    <div className={`settings${searching ? ' settings-searching' : ''}`} ref={root}>
      <nav className="settings-nav" aria-label="설정 분류">
        <h2 id="settings-title" className="settings-drag" onPointerDown={dragSettings}>설정</h2>
        {sections.map(item => <button key={item.id} aria-pressed={!searching && section === item.id} onClick={() => { setQuery(''); setSection(item.id); }}><Icon name={item.icon} />{item.label}</button>)}
        <span className="spacer" />
        <button onClick={() => onChange({ ...defaultSettings, theme: settings.theme, onboarded: settings.onboarded, chatTipPending: settings.chatTipPending })}><Icon name="refresh" />기본값으로</button>
      </nav>
      <div className="settings-main">
      <header className="settings-drag" onPointerDown={dragSettings}>
        <h3>{searching ? '검색' : sections.find(item => item.id === section)?.label}</h3>
        <input type="search" className="settings-search" placeholder="설정 검색" aria-label="설정 검색" value={query} onChange={event => setQuery(event.target.value)} />
        <IconButton icon="x" label="설정 닫기" keys="Esc" onClick={onClose} />
      </header>
      <div className="settings-content">
      <div className="settings-body">
        {searching && <p className="search-empty">일치하는 설정이 없습니다.</p>}
        {(searching || section === 'appearance') && <SectionFrame label="외관" searching={searching}>
          <Group title="전체">
            <Row title="색 테마" preview="theme"><Dropdown label="색 테마" value={settings.theme} options={[{ value: 'dark', label: '어둡게' }, { value: 'light', label: '밝게' }]} onChange={value => set('theme', value as Settings['theme'])} /></Row>
            <Row title="강조 색" hint="버튼, 선택, 포커스 표시에 쓰는 색입니다. 기본은 테마 색을 씁니다." preview="accent">
              <input type="color" value={settings.accentColor || '#5ec8e5'} aria-label="강조 색" onChange={event => set('accentColor', event.target.value)} />
              <button disabled={!settings.accentColor} onClick={() => set('accentColor', '')}>기본</button>
            </Row>
            <Row title="비활성 pane 흐리게" hint="포커스가 없는 터미널을 어둡게 표시합니다." preview="dim">{toggle('dimInactivePanes')}</Row>
            {typeof desktop()?.setZoom === 'function' && <Row title="화면 배율" hint="앱 전체 크기를 바꿉니다. (80–150%) 터미널 글꼴 크기는 아래 터미널에서 정합니다." preview="zoom">{number('uiZoom', 80, 150, 5)}</Row>}
            <Row title="사이드바 접기" hint="프로젝트 사이드바를 아이콘만 보이는 좁은 막대로 줄입니다. 단축키로도 바꿀 수 있습니다." preview="sidebar">{toggle('sidebarCompact')}</Row>
            <Advanced>
              <Row title="프로젝트 사이드바 너비" hint="사이드바 경계를 끌어서도 바꿀 수 있습니다. (160–480px)" preview="sidebarWidth">{number('sidebarWidth', 160, 480)}</Row>
            </Advanced>
          </Group>
          <Group title="터미널">
            <Row title="글꼴 크기" preview="termSize">{number('terminalFontSize', 8, 40)}</Row>
            <Row title="글꼴" hint="이 컴퓨터에 설치된 글꼴만 목록에 나옵니다." preview="termFont">
              <Dropdown label="터미널 글꼴" value={settings.terminalFont} options={terminalFontOptions} onChange={value => set('terminalFont', value)} /></Row>
            <Row title="글꼴 굵기" preview="termWeight"><Dropdown label="글꼴 굵기" value={String(settings.terminalFontWeight)} options={[{ value: '300', label: '얇게' }, { value: '400', label: '보통' }, { value: '500', label: '중간' }, { value: '600', label: '굵게' }]} onChange={value => set('terminalFontWeight', Number(value))} /></Row>
            <Row title="커서 모양" preview="termCursor"><Dropdown label="커서 모양" value={settings.cursorStyle} options={[{ value: 'bar', label: '막대' }, { value: 'block', label: '블록' }, { value: 'underline', label: '밑줄' }]} onChange={value => set('cursorStyle', value as Settings['cursorStyle'])} /></Row>
            <Row title="커서 깜빡임" preview="termBlink">{toggle('cursorBlink')}</Row>
            <Advanced>
              <Row title="글꼴 이름 직접 입력" hint="목록에 없는 글꼴 이름을 입력할 때 씁니다." preview="termName">
                <input type="text" value={settings.terminalFont} maxLength={200} placeholder="JetBrains Mono" aria-label="터미널 글꼴 직접 입력" onChange={event => set('terminalFont', event.target.value)} /></Row>
              <Row title="줄 높이" preview="termLine">{number('lineHeight', 1, 2, 0.05)}</Row>
              <Row title="글자 간격" hint="픽셀 단위 (0–5)" preview="termSpace">{number('letterSpacing', 0, 5)}</Row>
              <Row title="최소 대비" hint="글자와 배경의 대비가 이 값보다 낮으면 글자색을 보정합니다. 1이면 끕니다. (1–21)" preview="termContrast">{number('minimumContrast', 1, 21, 0.5)}</Row>
              <Row title="굵은 글자를 밝은 색으로" hint="굵은 글자에 밝은 색 팔레트를 씁니다." preview="termBold">{toggle('boldBright')}</Row>
              <Row title="GPU 렌더링 (WebGL)" hint="끄면 DOM 렌더러를 씁니다. 글자가 깨지거나 GPU 문제가 있을 때만 끄세요." preview={false}>{toggle('terminalGpu')}</Row>
            </Advanced>
          </Group>
          <Group title="채팅">
            <Row title="글꼴 크기" hint="대화 본문 크기입니다. (11–20px)" preview="chatSize">{number('chatFontSize', 11, 20)}</Row>
            <Row title="대화 너비" hint="대화와 입력창의 최대 너비입니다." preview="chatWidth">
              <Dropdown label="대화 너비" value={settings.chatWidth} options={[{ value: 'narrow', label: '좁게' }, { value: 'default', label: '기본' }, { value: 'wide', label: '넓게' }, { value: 'full', label: '가득' }]} onChange={value => set('chatWidth', value as Settings['chatWidth'])} /></Row>
            <Row title="생각 과정 표시" hint="‘응답 중에만’은 생각이 스트리밍되는 동안만 펼치고 끝나면 접습니다." preview="chatThink">
              <Dropdown label="생각 과정 표시" value={settings.chatThinkingOpen} options={[{ value: 'live', label: '응답 중에만 펼침' }, { value: 'always', label: '항상 펼침' }, { value: 'never', label: '항상 접음' }]} onChange={value => set('chatThinkingOpen', value as Settings['chatThinkingOpen'])} /></Row>
            <Row title="도구 호출 표시" hint="요약은 도구를 3개 이상 연달아 부르면 낮은 상자 하나에 묶어 스크롤로 보여 줍니다. 상세는 도구마다 한 줄씩 나열합니다." preview="chatToolMode">
              <Dropdown label="도구 호출 표시" value={settings.chatToolDisplay} options={[{ value: 'summary', label: '요약 (묶어서 스크롤)' }, { value: 'detail', label: '상세 (하나씩 나열)' }]} onChange={value => set('chatToolDisplay', value as Settings['chatToolDisplay'])} /></Row>
            <Advanced>
              <Row title="입력창 최대 높이" hint="긴 글을 쓸 때 입력창이 늘어나는 한계입니다. (120–600px)" preview="chatComposer">{number('chatComposerMax', 120, 600, 10)}</Row>
              <Row title="도구 호출 펼쳐 보기" hint="Bash·Edit 같은 도구 카드를 처음부터 펼쳐 둡니다. 끄면 눌러서 엽니다." preview="chatTools">{toggle('chatToolsOpen')}</Row>
              <Row title="부드러운 스트리밍" hint="응답이 글자 단위로 이어서 나오는 효과입니다. 끄면 받는 대로 바로 표시해 더 가볍습니다. 시스템의 ‘동작 줄이기’가 켜져 있으면 항상 꺼집니다." preview="chatStream">{toggle('chatSmoothStream')}</Row>
            </Advanced>
          </Group>
          <Group title="변경사항">
            <Row title="diff 글꼴 크기" preview="diffSize">{number('fontSize', 8, 40)}</Row>
            <Row title="diff 글꼴" hint="이 컴퓨터에 설치된 글꼴만 목록에 나옵니다. 비우면 터미널 글꼴을 따릅니다." preview="diffFont">
              <Dropdown label="diff 글꼴" value={settings.diffFont} options={diffFontOptions} onChange={value => set('diffFont', value)} /></Row>
            <Row title="자동 줄바꿈" preview="diffWrap"><input type="checkbox" role="switch" checked={settings.wordWrap} onChange={event => set('wordWrap', event.target.checked)} /></Row>
            <Row title="diff 표시 방식" hint="자동은 패널이 넓을 때만 좌우로 나눠 보여줍니다." preview="diffLayout"><Dropdown label="diff 표시 방식" value={settings.diffLayout} options={[{ value: 'auto', label: '자동' }, { value: 'inline', label: '한 줄로 (통합)' }, { value: 'split', label: '좌우 비교' }]} onChange={value => set('diffLayout', value as Settings['diffLayout'])} /></Row>
            <Advanced>
              <Row title="diff 글꼴 이름 직접 입력" hint="목록에 없는 글꼴 이름을 입력할 때 씁니다." preview="diffName">
                <input type="text" value={settings.diffFont} maxLength={200} placeholder={settings.terminalFont || 'JetBrains Mono'} aria-label="diff 글꼴 직접 입력" onChange={event => set('diffFont', event.target.value)} /></Row>
              <Row title="변경 없는 구간 접기" hint="변경사항 목록에서 바뀌지 않은 줄을 접어 둡니다." preview="diffFold">{toggle('diffFoldUnchanged')}</Row>
              {settings.diffFoldUnchanged && <Row title="변경 주변 표시 줄 수" hint="접힌 구간 둘레에 남기는 줄 수입니다. (1–20)" preview="diffContext">{number('diffContextLines', 1, 20)}</Row>}
              <Row title="변경사항 패널 너비" hint="패널 왼쪽 경계를 끌어서도 바꿀 수 있고, 경계를 더블클릭하면 전체 너비로 넓힙니다. (320–1600px)" preview="diffWidth">{number('reviewWidth', 320, 1600, 10)}</Row>
            </Advanced>
          </Group>
          <Group title="상태 표시">
            <Row title="사용량 % 색상" hint="Claude Code statusline처럼 사용률에 따라 초록 → 노랑 → 빨강으로 색을 바꿉니다. 끄면 80% 이상만 경고색으로 표시합니다." preview="usage">
              {toggle('usageColors')}
            </Row>
            <Row title="12시간제 시계" hint="오전/오후로 표시합니다." preview="clock12">{toggle('clock12h')}</Row>
            <Row title="시계에 초 표시" hint="켜면 1초마다 갱신합니다." preview="clockSec">{toggle('clockSeconds')}</Row>
          </Group>
          <Group title="동작">
            <Row title="새 탭 기본 모드" hint="새 탭 메뉴와 런처에서 Claude Code·Codex·Cursor를 채팅으로 열지, 터미널(CLI)로 열지 정합니다. 메뉴에서 그때그때 바꿀 수도 있습니다." preview={false}>
              <Dropdown label="새 탭 기본 모드" value={settings.defaultMode} options={[{ value: 'chat', label: '채팅' }, { value: 'cli', label: '터미널 (CLI)' }]} onChange={value => set('defaultMode', value as Settings['defaultMode'])} /></Row>
            <Row title="실행 중인 터미널 닫기 확인" hint="실행 중인 터미널이나 그 터미널이 있는 탭을 닫기 전에 한 번 더 묻습니다." preview={false}>{toggle('confirmClose')}</Row>
            <Row title="채팅 닫기 확인" hint="응답 중인 채팅이나 그 채팅이 있는 탭을 닫기 전에 한 번 더 묻습니다." preview={false}>{toggle('confirmCloseChat')}</Row>
            <Row title="프로젝트 닫기 확인" hint="실행 중인 터미널·채팅이 있는 프로젝트를 닫기 전에 한 번 더 묻습니다." preview={false}>{toggle('confirmCloseProject')}</Row>
          </Group>
        </SectionFrame>}
        {(searching || section === 'terminal') && <SectionFrame label="터미널" searching={searching}>
          <ShellSetting settings={settings} set={set} />
          <p className="setting-note">글꼴, 커서, 줄 간격은 외관에서 바꿉니다.</p>
          <Row title="터미널 벨" hint="프로그램이 벨(BEL)을 울릴 때의 동작입니다. 에이전트 승인 요청 알림은 이 설정과 별개로 ‘AI 툴’의 알림 설정을 따릅니다.">
            <Dropdown label="터미널 벨" value={settings.terminalBell} options={[{ value: 'off', label: '끔' }, { value: 'visual', label: '화면 깜빡임' }, { value: 'sound', label: '소리' }]} onChange={value => set('terminalBell', value as Settings['terminalBell'])} /></Row>
          <Row title="선택하면 바로 복사">{toggle('copyOnSelect')}</Row>
          <Row title="오른쪽 클릭으로 붙여넣기" hint="오른쪽 클릭하면 클립보드를 붙여넣습니다. 선택한 글자가 있으면 복사하고 선택을 해제합니다.">{toggle('rightClickPaste')}</Row>
          <Row title="Option 키를 Meta로 사용" hint="macOS에서 Option+키를 Esc 접두 입력(Alt/Meta)으로 보냅니다. 끄면 Option으로 특수 문자를 입력합니다.">{toggle('optionAsMeta')}</Row>
          <Group title="tmux 키 가이드">
            <p className="setting-note">접두 키(기본 Ctrl+B) 다음에 누를 키를 안내합니다. 다음 키를 누르면 닫히며, 로컬·SSH tmux 모두 같습니다.</p>
            <Row title="가이드 표시" hint="자동: 상태줄이 보일 때만. 항상: 상태줄 인식이 안 되거나 vim 등의 Ctrl+B에도 표시.">
              <Dropdown label="tmux 가이드 표시" value={settings.tmuxGuide} options={[{ value: 'auto', label: '자동' }, { value: 'always', label: '항상' }, { value: 'off', label: '끔' }]} onChange={value => set('tmuxGuide', value as Settings['tmuxGuide'])} /></Row>
            {settings.tmuxGuide !== 'off' && <Row title="접두 키 (Ctrl+…)" hint=".tmux.conf에서 바꿨다면 해당 영문 소문자 한 글자(예: a).">
              <input type="text" value={settings.tmuxPrefix} maxLength={1} aria-label="tmux 접두 키 글자" style={{ width: 48, textAlign: 'center' }}
                onChange={event => { const value = event.target.value.toLowerCase(); if (value === '' || /^[a-z]$/.test(value)) set('tmuxPrefix', value); }}
                onBlur={() => { if (!settings.tmuxPrefix) set('tmuxPrefix', defaultSettings.tmuxPrefix); }} /></Row>}
          </Group>
          <Advanced>
            <Row title="스크롤백 줄 수" hint="500–100,000">{number('scrollback', 500, 100000)}</Row>
            <Row title="스크롤 속도" hint="마우스 휠·트랙패드 배율 (0.5–5)">{number('scrollSensitivity', 0.5, 5, 0.5)}</Row>
            <Row title="더블클릭 단어 구분 문자" hint="더블클릭으로 단어를 선택할 때 경계로 보는 문자입니다.">
              <input type="text" value={settings.wordSeparator} maxLength={64} aria-label="단어 구분 문자" onChange={event => set('wordSeparator', event.target.value)} />
              <button disabled={settings.wordSeparator === defaultSettings.wordSeparator} onClick={() => set('wordSeparator', defaultSettings.wordSeparator)}>기본</button>
            </Row>
          </Advanced>
        </SectionFrame>}
        {(searching || section === 'status') && <SectionFrame label="상태바" searching={searching}>
          {!searching && <div className="ai-tabs" role="tablist" aria-label="상태 표시줄 종류">
            {([['bar', '하단 상태바', 'info'], ['chat', '채팅 상태 표시줄', 'chat']] as const).map(([id, label, icon]) => <button key={id} role="tab" aria-selected={statusTab === id} onClick={() => setStatusTab(id)}><Icon name={icon} size={14} />{label}</button>)}
          </div>}
          {(searching || statusTab === 'bar') && <Group title={searching ? '하단 상태바' : undefined}>
            <StatusLayoutEditor key="bar" settings={settings} onChange={onChange} />
            <Advanced>
              <Row title="CPU·메모리 갱신 주기" hint="초 단위 (2–60). 창이 보일 때만 조회합니다.">{number('systemRefresh', 2, 60)}</Row>
            </Advanced>
          </Group>}
          {(searching || statusTab === 'chat') && <Group title={searching ? '채팅 상태 표시줄' : undefined}>
            <StatusLayoutEditor key="chat" settings={settings} onChange={onChange} chat />
          </Group>}
        </SectionFrame>}
        {(searching || section === 'ai') && <SectionFrame label="AI 툴" searching={searching}>
          {!searching && <div className="ai-tabs" role="tablist" aria-label="AI 툴 분류">
            {aiTabs.map(item => <button key={item.id} role="tab" aria-selected={aiTab === item.id} onClick={() => setAiTab(item.id)}>
              <Icon name={item.icon} size={14} />{item.label}{item.id !== 'common' && (missing.includes(item.id) ? <small>미설치</small> : settings.agentsOff.includes(item.id) && <small>숨김</small>)}
            </button>)}
          </div>}
          {(searching || aiTab === 'common') && <Group title={searching ? '공용' : undefined}>
            <h4 className="setting-group">알림</h4>
            <p className="setting-note">모든 에이전트에 공통입니다. 에이전트마다 끄려면 해당 탭의 ‘알림’을 사용하세요.</p>
            <Row title="에이전트 작업 완료" hint="터미널의 Claude Code·Codex·Cursor CLI가 5초 넘게 출력을 멈췄을 때(완료 또는 입력 대기) 알립니다. 해당 터미널을 보고 있을 때는 알리지 않습니다.">{toggle('notifyDone')}</Row>
            <Row title="승인·입력 요청" hint="터미널의 Claude Code·Codex·Cursor CLI가 벨(BEL)로 확인을 요청할 때도 알립니다.">{toggle('notifyApproval')}</Row>
            <Row title="보고 있는 터미널도 알림" hint="끄면 지금 보고 있는 터미널의 에이전트는 알리지 않습니다. 켜면 포커스가 있어도 알립니다.">{toggle('notifyLooking')}</Row>
            <Row title="알림 소리" hint="알림과 함께 짧은 효과음을 재생합니다. 알림 권한이 없어도 소리는 납니다.">{toggle('notifySound')}</Row>
            {settings.notifySound && <>
              <Row title="소리 확장" hint="소리 크기를 최대 200%까지 조절합니다."><input type="checkbox" role="switch" aria-label="소리 확장" checked={settings.soundVolumeExtended} onChange={event => onChange({ ...settings, soundVolumeExtended: event.target.checked, soundVolume: event.target.checked ? settings.soundVolume : Math.min(settings.soundVolume, 100) })} /></Row>
              <Row title="소리 크기" hint={settings.soundVolumeExtended ? '0–200%' : '0–100%'}><input type="range" min={0} max={settings.soundVolumeExtended ? 200 : 100} step={5} value={settings.soundVolume} aria-label="소리 크기" onChange={event => set('soundVolume', Number(event.target.value))} /><span className="range-value">{settings.soundVolume}%</span></Row>
              {soundPicker('완료 소리', '작업이 멈췄을 때 재생합니다.', 'soundDone')}
              {soundPicker('입력 요청 소리', '확인이 필요할 때 재생합니다.', 'soundAttention')}
            </>}
            <h4 className="setting-group">사용량 표시</h4>
            <p className="setting-note">사용량 색은 외관에서 바꿉니다.</p>
            <Advanced>
              <Row title="사용량 갱신 주기" hint="초 단위 (60–600). 한도 조회는 서버에서 3분간 재사용하므로 더 짧게 해도 같은 값이 보일 수 있습니다. 상태바의 사용량을 누르면 상세 정보를 보여 주면서 바로 새로고침합니다.">{number('usageRefresh', 60, 600, 10)}</Row>
            </Advanced>
          </Group>}
          {(searching ? (['claude', 'codex', 'cursor'] as const) : aiTab === 'common' ? [] : [aiTab]).map(tab => <Group key={tab} title={searching ? agentNames[tab] : undefined}>{agentBody(tab)}</Group>)}
        </SectionFrame>}
        {(searching || section === 'chat') && <SectionFrame label="채팅" searching={searching}>
          <Group title="입력">
            <Row title="메시지 전송 키" hint="‘Cmd/Ctrl+Enter’를 고르면 Enter는 줄바꿈이 됩니다. Shift+Enter는 항상 줄바꿈입니다.">
              <Dropdown label="메시지 전송 키" value={settings.chatSendKey} options={[{ value: 'enter', label: 'Enter' }, { value: 'mod-enter', label: 'Cmd/Ctrl+Enter' }]} onChange={value => set('chatSendKey', value as Settings['chatSendKey'])} /></Row>
          </Group>
          <Group title="새 채팅 기본값">
            <p className="setting-note">새로 만드는 채팅에 적용됩니다. 그 에이전트가 지원하는 권한 모드와 Effort만 반영되고, 이미 있는 채팅은 그대로입니다. 채팅마다 입력창 아래에서 바꿀 수 있습니다.</p>
            <Row title="권한 모드" hint="모든 권한 건너뛰기(bypassPermissions)는 위험해서 기본값으로 고를 수 없습니다. 채팅마다 직접 고르세요.">
              <Dropdown label="새 채팅 권한 모드" value={settings.chatDefaultPermission} options={[{ value: 'cli', label: 'CLI 설정 따름' }, { value: 'default', label: '기본 (매번 확인)' }, { value: 'acceptEdits', label: '편집 자동 승인' }, { value: 'plan', label: '계획 모드' }, { value: 'auto', label: '자동' }]} onChange={value => set('chatDefaultPermission', value as Settings['chatDefaultPermission'])} /></Row>
            <Row title="Effort" hint="자동은 에이전트의 기본값을 따릅니다. 높을수록 오래 생각하고 비용이 늘어납니다.">
              <Dropdown label="새 채팅 Effort" value={settings.chatDefaultEffort} options={[{ value: 'auto', label: 'CLI 설정 따름' }, { value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }, { value: 'xhigh', label: 'xhigh' }, { value: 'max', label: 'max' }]} onChange={value => set('chatDefaultEffort', value as Settings['chatDefaultEffort'])} /></Row>
          </Group>
          <Group title="대화">
            <p className="setting-note">글꼴, 너비, 입력창 높이, 도구·생각 표시, 부드러운 스트리밍은 외관에서 바꿉니다.</p>
            <Row title="새 출력 따라가기" hint="끝에 있을 때 새 출력이 나오면 자동으로 따라 내려갑니다. 끄면 직접 내려야 하고, 메시지를 보낼 때는 항상 맨 아래로 갑니다.">{toggle('chatAutoScroll')}</Row>
          </Group>
        </SectionFrame>}
        {(searching || section === 'diff') && <SectionFrame label="변경사항" searching={searching}>
          <p className="setting-note">글꼴, 줄바꿈, 표시 방식, 구간 접기, 패널 너비는 외관에서 바꿉니다.</p>
          <Row title="공백 변경 무시" hint="줄 앞뒤 공백만 바뀐 줄은 변경으로 표시하지 않습니다.">{toggle('diffIgnoreWhitespace')}</Row>
          <Advanced>
            <Row title="변경사항 새로고침 주기" hint="초 단위 (1–60)">{number('diffRefresh', 1, 60)}</Row>
            <Row title="diff 계산 제한 시간" hint="큰 파일의 diff 계산을 이 시간까지만 기다립니다. 넘으면 단순 비교로 대체합니다. (1000–20000ms)">{number('diffComputeMs', 1000, 20000, 500)}</Row>
          </Advanced>
        </SectionFrame>}
        {(searching || section === 'wakatime') && <SectionFrame label="WakaTime" searching={searching}><WakaTimeSettings settings={settings} set={set} onChange={onChange} /></SectionFrame>}
        {(searching || section === 'plugins') && <SectionFrame label="플러그인" searching={searching}><PluginSettings query={query} /></SectionFrame>}
        {(searching || section === 'feedback') && <SectionFrame label="피드백" searching={searching}>
          <FeedbackAvailabilityRow />
          <Row title="에이전트 피드백 초안" hint="채팅 에이전트가 피드백 초안을 넣을 수 있게 합니다. 넣은 초안은 직접 열어 검토해야 제출할 수 있습니다.">{toggle('feedbackAgentTool')}</Row>
          <Row title="AI 정리에 화면 정보 포함" hint="'AI로 정리'를 누를 때 앱 버전, 열린 pane 종류, 프로젝트 이름, 최근 오류 몇 개를 함께 보냅니다.">{toggle('feedbackAiContext')}</Row>
          <Row title="AI 정리 모델" hint="'AI로 정리'에 쓸 Claude 모델입니다. 피드백 작성 화면 하단에서도 바꿀 수 있고, 기본은 Haiku 5.5입니다."><Dropdown label="AI 정리 모델" className="chat-model" value={feedbackModelId(settings.feedbackAiModel)} options={AI_MODELS} onChange={value => set('feedbackAiModel', value as Settings['feedbackAiModel'])} /></Row>
          <Row title="AI 정리 Effort" hint="높을수록 정교하지만 느립니다. 피드백에서는 보통(Medium)까지만 고를 수 있고, 기본은 낮음(Low)입니다."><Dropdown label="AI 정리 Effort" className={`chat-effort effort-${feedbackEffort(settings.feedbackAiEffort)}`} value={feedbackEffort(settings.feedbackAiEffort)} options={AI_EFFORTS} onChange={value => set('feedbackAiEffort', value as Settings['feedbackAiEffort'])} /></Row>
        </SectionFrame>}
        {(searching || section === 'about') && <SectionFrame label="정보" searching={searching}><AboutSettings /></SectionFrame>}
        {(searching || section === 'keys') && <SectionFrame label="단축키" searching={searching}>
          <ShortcutKeys settings={settings} onChange={onChange} />
          <Row title="튜토리얼" hint="처음 실행할 때 보여준 둘러보기를 다시 시작합니다."><button onClick={() => { onChange({ ...settings, onboarded: false }); onClose(); }}><Icon name="book" />다시 보기</button></Row>
        </SectionFrame>}
      </div>
      {wide && <LookPreview id={look} settings={settings} />}
      </div>
      </div>
    </div>
    </lookHover.Provider>
    </settingsQuery.Provider>
  </Modal>;
}

function ShortcutKeys({ settings, onChange }: { settings: Settings; onChange(settings: Settings): void }) {
  const query = useContext(settingsQuery);
  const [editing, setEditing] = useState(''), [note, setNote] = useState('');
  const definitions = [...appKeyDefs.map(def => ({ ...def, scope: 'appKeys' as const })), ...chatKeyDefs.map(def => ({ ...def, group: '채팅 모드 (입력창에서)', scope: 'chatKeys' as const }))];
  const current = (def: typeof definitions[number]) => def.scope === 'appKeys' ? appKey(settings.appKeys, def.id)! : chatKey(settings.chatKeys, def.id as typeof chatKeyDefs[number]['id']);
  const changed = definitions.some(def => !combosOverlap(current(def), def.keys));
  const bind = (def: typeof definitions[number], combo: string) => {
    if (settings.chatSendKey === 'mod-enter' && combosOverlap(combo, 'mod+enter')) { setNote('메시지 전송에서 이미 쓰는 단축키입니다.'); return; }
    const clash = definitions.find(other => (other.scope !== def.scope || other.id !== def.id) && combosOverlap(current(other), combo));
    if (clash) { setNote(`"${clash.label}"에서 이미 쓰는 단축키입니다.`); return; }
    const { [def.id]: _drop, ...rest } = settings[def.scope] ?? {};
    onChange({ ...settings, [def.scope]: combosOverlap(combo, def.keys) ? rest : { ...rest, [def.id]: combo } });
    setEditing(''); setNote('');
  };
  const capture = (event: KeyboardEvent<HTMLButtonElement>, def: typeof definitions[number]) => {
    if (event.nativeEvent.isComposing) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { setEditing(''); setNote(''); return; }
    const combo = comboOf(event.nativeEvent); if (!combo) return;
    if (!validCombo(combo) && !(def.scope === 'appKeys' && /^f(?:[1-9]|1[0-9]|2[0-4])$/.test(combo))) { setNote('Ctrl·Alt·⌘ 중 하나와 함께 누르세요 (Shift는 방향키 같은 키와 함께).'); return; }
    bind(def, combo);
  };
  return <>
    <Row title="단축키 초기화" hint="앱과 채팅의 단축키를 모두 기본값으로 되돌립니다."><button type="button" disabled={!changed} onClick={() => { onChange({ ...settings, appKeys: {}, chatKeys: {} }); setEditing(''); setNote(''); }}><Icon name="refresh" size={13} />단축키 초기화</button></Row>
    <p className="setting-note">단축키를 클릭한 뒤 새 조합을 누르세요. Esc 또는 다른 곳을 클릭하면 취소합니다.</p>
    {note && <p className="hint" role="alert">{note}</p>}
    {[...new Set(definitions.map(def => def.group))].map(group => {
      const items = definitions.filter(def => def.group === group && queryHit(query, def.label));
      if (!items.length) return null;
      return <div className="shortcut-list setting-block" key={group}>
      <h3>{group}</h3>
      {items.map(def => {
        const id = `${def.scope}:${def.id}`, custom = !combosOverlap(current(def), def.keys);
        return <div key={id} className="setting-hit"><span>{def.label}</span><span className="key-edit">
          <button type="button" className="kbd-edit" aria-label={`${def.label} 단축키 변경`} aria-pressed={editing === id} onClick={() => { setEditing(id); setNote(''); }} onKeyDown={event => editing === id && capture(event, def)} onBlur={() => setEditing('')}>
            {editing === id ? '키를 누르세요…' : <kbd>{def.scope === 'appKeys' ? showAppKey(settings.appKeys, def.id) : showCombo(current(def))}</kbd>}
          </button>
          <button type="button" disabled={!custom} title="기본값으로" aria-label={`${def.label} 단축키 되돌리기`} onClick={() => bind(def, def.keys)}><Icon name="refresh" size={13} /></button>
        </span></div>;
      })}
    </div>;
    })}
  </>;
}
