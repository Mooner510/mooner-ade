import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { api } from './api';
import { agentNames, defaultSettings, statusLayout, usageHue, type Settings } from './Editor';
import { Icon, IconButton, type IconName } from './Icon';
import { PluginSettings } from './PluginSettings';
import { useMissingAgents } from './installed-agents';
import { Dropdown, Modal } from './views';
import { playSound, soundIds, sounds } from './sound';

type Desktop = { appInfo(): Promise<{ version: string }>; checkUpdate(): Promise<string> };
const desktop = () => (window as unknown as { adeDesktop?: Partial<Desktop> }).adeDesktop;

function AboutSettings() {
  const [version, setVersion] = useState(''), [checking, setChecking] = useState(false);
  useEffect(() => { void desktop()?.appInfo?.().then(info => setVersion(info.version), () => {}); }, []);
  const canCheck = typeof desktop()?.checkUpdate === 'function';
  return <>
    <Row title="현재 버전" hint="새 버전은 실행 5초 뒤와 이후 30분마다 자동으로 확인합니다. 실행 중인 작업이 있으면 끝난 뒤에 설치하도록 고를 수 있습니다."><span>{version || '—'}</span></Row>
    {canCheck && <Row title="업데이트 확인" hint="GitHub 최신 릴리스와 비교합니다. 새 버전이 있으면 설치 여부를 묻습니다.">
      <button type="button" disabled={checking} onClick={() => { setChecking(true); void desktop()!.checkUpdate!().finally(() => setChecking(false)); }}><Icon name="refresh" />{checking ? '확인 중…' : '지금 확인'}</button>
    </Row>}
  </>;
}

export type Section = 'appearance' | 'terminal' | 'ai' | 'status' | 'diff' | 'wakatime' | 'plugins' | 'keys' | 'about';
const sections: { id: Section; label: string; icon: IconName }[] = [
  { id: 'appearance', label: '외관', icon: 'panelLeft' },
  { id: 'terminal', label: '터미널', icon: 'terminal' },
  { id: 'ai', label: 'AI 툴', icon: 'claude' },
  { id: 'status', label: '상태바', icon: 'info' },
  { id: 'diff', label: '변경사항', icon: 'diff' },
  { id: 'wakatime', label: 'WakaTime', icon: 'clock' },
  { id: 'plugins', label: '플러그인', icon: 'plugin' },
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
  claudeusage: 'Claude Code 사용량', codexusage: 'Codex 사용량', clock: '시계', wakatime: 'WakaTime 오늘 기록', readiness: '에이전트 준비 상태', openproject: '프로젝트 열기 버튼'
};
const statusHints: Record<string, string> = {
  claudeusage: '5시간·주간 한도 사용률. Claude Code 로그인 정보로 조회합니다.',
  codexusage: '5시간·주간 한도 사용률. Codex ChatGPT 로그인 또는 최근 세션 기록으로 조회합니다.'
};

// How each item looks in the real status bar, with sample values; shown under the item's name so its meaning is clear at a glance.
function statusSamples(settings: Settings): Record<string, ReactNode> {
  const usage = (provider: 'claude' | 'codex', windows: [string, number][]) => <span className="stat usage"><Icon name={provider} size={13} />
    {windows.map(([key, percent]) => <span key={key} className={`usage-window ${settings.usageColors ? 'graded' : ''}`} style={settings.usageColors ? { '--usage-hue': usageHue(percent) } as CSSProperties : undefined}><small>{key}</small>{percent}%<i style={{ width: `${percent}%` }} /></span>)}
  </span>;
  const time = new Date(2025, 0, 1, 14, 32, 8).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: settings.clockSeconds ? '2-digit' : undefined, hour12: settings.clock12h });
  return {
    connection: <span className="conn ok"><Icon name="wifi" size={13} /></span>,
    path: <span className="stat"><Icon name="folder" size={13} />~/projects/my-app</span>,
    branch: <span className="stat"><Icon name="branch" size={13} />main</span>,
    changes: <span className="stat"><Icon name="diff" size={13} />3개 파일<ins>+42</ins><del>−7</del></span>,
    terminals: <span className="stat"><Icon name="terminal" size={13} />2</span>,
    size: <span className="stat">120×32</span>,
    cpu: <span className="stat">12%</span>,
    memory: <span className="stat">6.4GB</span>,
    claudeusage: usage('claude', settings.claudeSession ? [['5h', 23], ['주', 41]] : [['주', 41]]),
    codexusage: usage('codex', [['5h', 8], ['주', 17]]),
    wakatime: <span className="stat"><Icon name="clock" size={13} />2시간 14분</span>,
    clock: <span className="stat"><Icon name="clock" size={13} />{time}</span>,
    readiness: <span className="stat"><Icon name="info" size={13} /></span>,
    openproject: <span className="stat"><Icon name="folderPlus" size={14} /></span>
  };
}

type Side = 'left' | 'right';
// Two columns mirror the status bar; rows drag within and across them, and Alt+arrows do the same from the keyboard.
function StatusLayoutEditor({ settings, onChange }: { settings: Settings; onChange(settings: Settings): void }) {
  const layout = statusLayout(settings), shown = new Set(settings.statusItems), samples = statusSamples(settings);
  const [dragging, setDragging] = useState(''), [drop, setDrop] = useState<{ side: Side; index: number } | null>(null);
  const place = (id: string, side: Side, index: number) => {
    const next = { left: layout.left.filter(item => item !== id), right: layout.right.filter(item => item !== id) };
    const from = layout[side].indexOf(id);
    next[side].splice(from >= 0 && from < index ? index - 1 : index, 0, id);
    onChange({ ...settings, statusLeft: next.left, statusRight: next.right });
  };
  const toggle = (id: string, on: boolean) => onChange({ ...settings, statusItems: on ? [...settings.statusItems.filter(item => item !== id), id] : settings.statusItems.filter(item => item !== id) });
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
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-status-item="${id}"]`)?.focus());
  };
  const column = (side: Side) => <section className={`status-column ${drop?.side === side ? 'drop-target' : ''}`} aria-label={side === 'left' ? '왼쪽' : '오른쪽'}
    onDragOver={event => over(event, side, layout[side].length)} onDrop={finish}>
    <h4>{side === 'left' ? '왼쪽' : '오른쪽'}</h4>
    <ul>{layout[side].map((id, index) => {
      const marker = drop?.side === side && dragging !== id ? drop.index === index ? 'drop-before' : drop.index === index + 1 && index === layout[side].length - 1 ? 'drop-after' : '' : '';
      const hint = id === 'wakatime' && !settings.wakatime ? 'WakaTime 작업 시간 기록을 켜야 표시됩니다.' : statusHints[id];
      return <li key={id} data-status-item={id} tabIndex={0} draggable className={`${shown.has(id) ? '' : 'off'} ${dragging === id ? 'dragging' : ''} ${marker}`}
        title="끌어서 순서와 위치를 바꿉니다 (Alt+화살표)"
        onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id); setDragging(id); }}
        onDragOver={event => { const box = event.currentTarget.getBoundingClientRect(); over(event, side, event.clientY < box.top + box.height / 2 ? index : index + 1); }}
        onDrop={finish} onDragEnd={() => { setDragging(''); setDrop(null); }} onKeyDown={event => keys(event, id, side, index)}>
        <Icon name="grip" size={14} />
        <span><strong>{statusLabels[id] ?? id}</strong><span className="statusbar status-sample" aria-hidden="true">{samples[id]}</span>{hint && <small>{hint}</small>}</span>
        <span className="setting-control"><input type="checkbox" role="switch" aria-label={`${statusLabels[id] ?? id} 표시`} checked={shown.has(id)} onChange={event => toggle(id, event.target.checked)} /></span>
      </li>;
    })}</ul>
  </section>;
  const isDefault = JSON.stringify([layout, [...settings.statusItems].sort()]) === JSON.stringify([statusLayout(defaultSettings), [...defaultSettings.statusItems].sort()]);
  return <>
    <div className="status-intro">
      <p className="setting-note">항목을 끌어 왼쪽·오른쪽과 순서를 정하고, 스위치로 켜고 끕니다. 키보드로는 항목에서 Alt+화살표를 누릅니다.</p>
      <button disabled={isDefault} title="배치와 표시 항목을 처음 상태로 되돌립니다" onClick={() => onChange({ ...settings, statusLeft: defaultSettings.statusLeft, statusRight: defaultSettings.statusRight, statusItems: defaultSettings.statusItems })}><Icon name="refresh" size={13} />기본값으로</button>
    </div>
    <div className="status-layout">{column('left')}{column('right')}</div>
    <p className="setting-note">Claude Code·Codex 사용량 표시(색상, 5시간 한도, 갱신 주기)는 ‘AI 툴’ 분류에 있습니다.</p>
  </>;
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

type ShellList = { shells: { id: string; label: string; path: string }[]; default: string };
function ShellSetting({ settings, set }: { settings: Settings; set<K extends keyof Settings>(key: K, value: Settings[K]): void }) {
  const [list, setList] = useState<ShellList | null>(null);
  useEffect(() => { void api<ShellList>('shell/list').then(setList, () => {}); }, []);
  const auto = list?.shells.find(item => item.id === list.default);
  const saved = settings.terminalShell && list && !list.shells.some(item => item.id === settings.terminalShell);
  return <Row title="기본 셸" hint={`새 터미널에 쓸 셸입니다. 이미 열린 터미널은 그대로입니다.${saved ? ' 저장된 셸이 이 컴퓨터에 없어 자동 선택을 씁니다.' : ''}${list && !list.shells.some(item => item.id === 'pwsh') && list.shells.some(item => item.id === 'powershell') ? ' PowerShell 7은 winget install Microsoft.PowerShell 로 설치할 수 있습니다.' : ''}`}>
    <Dropdown label="기본 셸" value={saved ? '' : settings.terminalShell}
      options={[{ value: '', label: `자동${auto ? ` (${auto.label})` : ''}` }, ...(list?.shells ?? []).map(item => ({ value: item.id, label: item.label }))]}
      onChange={value => set('terminalShell', value)} />
  </Row>;
}

// Rarely changed settings, folded away so the common ones stay short.
function Advanced({ children }: { children: ReactNode }) {
  return <details className="setting-advanced"><summary><Icon name="chevronDown" size={14} />고급 옵션</summary>{children}</details>;
}

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <div className="setting-row"><div><strong>{title}</strong>{hint && <small>{hint}</small>}</div><div className="setting-control">{children}</div></div>;
}

// Where the user dragged the settings dialog. Module state on purpose: it survives closing and reopening the dialog,
// and an app restart (a fresh page) puts it back in the centre.
let settingsOffset = { x: 0, y: 0 };
// Moves the dialog by (x, y) from its centred spot, clamped so no edge leaves the window.
function placeSettings(dialog: HTMLElement, x: number, y: number) {
  dialog.style.translate = '';
  const rect = dialog.getBoundingClientRect();
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
  settingsOffset = { x: clamp(x, -rect.left, innerWidth - rect.right), y: clamp(y, -rect.top, innerHeight - rect.bottom) };
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

export function SettingsModal({ settings, onChange, onClose, shortcuts, initialSection = 'appearance' }: { settings: Settings; onChange(settings: Settings): void; onClose(): void; shortcuts: { label: string; keys: string }[]; initialSection?: Section }) {
  const [section, setSection] = useState<Section>(initialSection), [aiTab, setAiTab] = useState<AiTab>('common');
  const missing = useMissingAgents();
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value });
  const number = (key: 'fontSize' | 'terminalFontSize' | 'scrollback' | 'sidebarWidth' | 'diffRefresh' | 'lineHeight' | 'cacheWarn' | 'cacheSendWarnMinutes' | 'contextTipK' | 'usageRefresh' | 'letterSpacing' | 'scrollSensitivity' | 'minimumContrast' | 'diffContextLines' | 'systemRefresh' | 'reviewWidth', min: number, max: number, step = 1) =>
    <input type="number" min={min} max={max} step={step} value={settings[key]} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= min && value <= max && (step < 1 || Number.isInteger(value))) set(key, value as never); }} />;
  const toggle = (key: 'dimInactivePanes' | 'cursorBlink' | 'copyOnSelect' | 'notifyDone' | 'notifyApproval' | 'notifySound' | 'notifyLooking' | 'cacheTimer' | 'cacheSendWarn' | 'tips' | 'followUpQueue' | 'usageColors' | 'claudeSession' | 'rightClickPaste' | 'optionAsMeta' | 'confirmClose' | 'boldBright' | 'terminalGpu' | 'diffIgnoreWhitespace' | 'diffFoldUnchanged' | 'clock12h' | 'clockSeconds') =>
    <input type="checkbox" role="switch" checked={settings[key]} onChange={event => set(key, event.target.checked as never)} />;
  // Switch on = the agent is not in the list (shown / alerting).
  const inList = (key: 'agentsOff' | 'agentsMuted', agent: string, label: string) =>
    <input type="checkbox" role="switch" aria-label={label} checked={!settings[key].includes(agent)} onChange={event => set(key, event.target.checked ? settings[key].filter(item => item !== agent) : [...settings[key], agent])} />;
  const statusSwitch = (id: string, label: string) =>
    <input type="checkbox" role="switch" aria-label={label} checked={settings.statusItems.includes(id)} onChange={event => set('statusItems', event.target.checked ? [...settings.statusItems.filter(item => item !== id), id] : settings.statusItems.filter(item => item !== id))} />;
  const argsRow = (agent: 'claude' | 'codex' | 'cursor', key: 'claudeArgs' | 'codexArgs' | 'cursorArgs', example: string) =>
    <Row title={`${agentNames[agent]} 추가 실행 인자`} hint={`실행할 때 명령 뒤에 붙입니다. 예: ${example} · 새로 여는 터미널과 되살리는 터미널에 적용되고, 이미 실행 중인 에이전트는 그대로입니다.`}>
      <input type="text" value={settings[key]} maxLength={512} placeholder={example} aria-label={`${agentNames[agent]} 추가 실행 인자`}
        onChange={event => set(key, event.target.value.replace(/[\x00-\x1f\x7f]/g, ''))} /></Row>;
  const soundPicker = (title: string, hint: string, key: 'soundDone' | 'soundAttention') =>
    <Row title={title} hint={hint}><Dropdown label={title} value={settings[key]} options={soundIds.map(id => ({ value: id, label: sounds[id].label }))} onChange={value => { set(key, value); playSound(value, settings.soundVolume); }} />
      <IconButton icon="bell" label={`${title} 미리 듣기`} onClick={() => playSound(settings[key], settings.soundVolume)} /></Row>;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Reapply the last spot, and keep it inside the window when the window shrinks.
    const dialog = root.current!.closest('dialog')!, fit = () => placeSettings(dialog, settingsOffset.x, settingsOffset.y);
    fit();
    addEventListener('resize', fit);
    return () => removeEventListener('resize', fit);
  }, []);
  return <Modal className="settings-modal" labelledBy="settings-title" onClose={onClose}>
    <div className="settings" ref={root}>
      <nav className="settings-nav" aria-label="설정 분류">
        <h2 id="settings-title" className="settings-drag" onPointerDown={dragSettings}>설정</h2>
        {sections.map(item => <button key={item.id} aria-pressed={section === item.id} onClick={() => setSection(item.id)}><Icon name={item.icon} />{item.label}</button>)}
        <span className="spacer" />
        <button onClick={() => onChange({ ...defaultSettings, theme: settings.theme, onboarded: settings.onboarded })}><Icon name="refresh" />기본값으로</button>
      </nav>
      <div className="settings-body">
        <header className="settings-drag" onPointerDown={dragSettings}><h3>{sections.find(item => item.id === section)?.label}</h3><IconButton icon="x" label="설정 닫기" keys="Esc" onClick={onClose} /></header>
        {section === 'appearance' && <>
          <Row title="색 테마"><Dropdown label="색 테마" value={settings.theme} options={[{ value: 'dark', label: '어둡게' }, { value: 'light', label: '밝게' }]} onChange={value => set('theme', value as Settings['theme'])} /></Row>
          <Row title="강조 색" hint="버튼, 선택, 포커스 표시에 쓰는 색입니다. 기본은 테마 색을 씁니다.">
            <input type="color" value={settings.accentColor || '#5ec8e5'} aria-label="강조 색" onChange={event => set('accentColor', event.target.value)} />
            <button disabled={!settings.accentColor} onClick={() => set('accentColor', '')}>기본</button>
          </Row>
          <Row title="비활성 pane 흐리게" hint="포커스가 없는 터미널을 어둡게 표시합니다.">{toggle('dimInactivePanes')}</Row>
          <Row title="실행 중인 터미널 닫기 확인" hint="실행 중인 터미널이나 그 터미널이 있는 탭을 닫기 전에 한 번 더 묻습니다.">{toggle('confirmClose')}</Row>
          <Advanced>
            <Row title="프로젝트 사이드바 너비" hint="사이드바 경계를 끌어서도 바꿀 수 있습니다. (160–480px)">{number('sidebarWidth', 160, 480)}</Row>
          </Advanced>
        </>}
        {section === 'terminal' && <>
          <ShellSetting settings={settings} set={set} />
          <Row title="글꼴 크기">{number('terminalFontSize', 8, 40)}</Row>
          <Row title="글꼴" hint="비우면 기본 모노스페이스 글꼴을 씁니다. 예: Cascadia Mono"><input type="text" value={settings.terminalFont} maxLength={200} placeholder="JetBrains Mono" onChange={event => set('terminalFont', event.target.value)} /></Row>
          <Row title="글꼴 굵기"><Dropdown label="글꼴 굵기" value={String(settings.terminalFontWeight)} options={[{ value: '300', label: '얇게' }, { value: '400', label: '보통' }, { value: '500', label: '중간' }, { value: '600', label: '굵게' }]} onChange={value => set('terminalFontWeight', Number(value))} /></Row>
          <Row title="커서 모양"><Dropdown label="커서 모양" value={settings.cursorStyle} options={[{ value: 'bar', label: '막대' }, { value: 'block', label: '블록' }, { value: 'underline', label: '밑줄' }]} onChange={value => set('cursorStyle', value as Settings['cursorStyle'])} /></Row>
          <Row title="커서 깜빡임">{toggle('cursorBlink')}</Row>
          <Row title="선택하면 바로 복사">{toggle('copyOnSelect')}</Row>
          <Row title="오른쪽 클릭으로 붙여넣기" hint="오른쪽 클릭하면 클립보드를 붙여넣습니다. 선택한 글자가 있으면 복사하고 선택을 해제합니다.">{toggle('rightClickPaste')}</Row>
          <Row title="Option 키를 Meta로 사용" hint="macOS에서 Option+키를 Esc 접두 입력(Alt/Meta)으로 보냅니다. 끄면 Option으로 특수 문자를 입력합니다.">{toggle('optionAsMeta')}</Row>
          <h4 className="setting-group">tmux 키 가이드</h4>
          <p className="setting-note">tmux 접두 키(기본 Ctrl+B)를 누르면 바로 다음에 누를 키를 안내합니다. 터미널 크기는 바꾸지 않고, 입력 중인 커서에서 먼 쪽에 띄우며 다음 키를 누르면 바로 닫힙니다. SSH와 로컬 tmux에 똑같이 적용됩니다.</p>
          <Row title="가이드 표시" hint="자동은 화면에 tmux 상태줄(예: [0] 0:bash*)이 보일 때만 띄웁니다. 상태줄을 직접 꾸며 인식되지 않으면 ‘항상’을 고르세요. ‘항상’은 tmux가 아닌 곳의 Ctrl+B(vim, readline)에도 뜹니다.">
            <Dropdown label="tmux 가이드 표시" value={settings.tmuxGuide} options={[{ value: 'auto', label: '자동 (tmux 상태줄 감지)' }, { value: 'always', label: '항상' }, { value: 'off', label: '끔' }]} onChange={value => set('tmuxGuide', value as Settings['tmuxGuide'])} /></Row>
          {settings.tmuxGuide !== 'off' && <>
            <Row title="접두 키 (Ctrl+…)" hint=".tmux.conf에서 바꾼 경우 그 글자를 적으세요. 예: Ctrl+A면 a. 영문 소문자 한 글자입니다.">
              <input type="text" value={settings.tmuxPrefix} maxLength={1} aria-label="tmux 접두 키 글자" style={{ width: 48, textAlign: 'center' }}
                onChange={event => { const value = event.target.value.toLowerCase(); if (value === '' || /^[a-z]$/.test(value)) set('tmuxPrefix', value); }}
                onBlur={() => { if (!settings.tmuxPrefix) set('tmuxPrefix', defaultSettings.tmuxPrefix); }} /></Row>
          </>}
        </>}
        {section === 'terminal' && <Advanced>
          <Row title="줄 높이">{number('lineHeight', 1, 2, 0.05)}</Row>
          <Row title="글자 간격" hint="픽셀 단위 (0–5)">{number('letterSpacing', 0, 5)}</Row>
          <Row title="스크롤백 줄 수" hint="500–100,000">{number('scrollback', 500, 100000)}</Row>
          <Row title="스크롤 속도" hint="마우스 휠·트랙패드 배율 (0.5–5)">{number('scrollSensitivity', 0.5, 5, 0.5)}</Row>
          <Row title="최소 대비" hint="글자와 배경의 대비가 이 값보다 낮으면 글자색을 보정합니다. 1이면 끕니다. (1–21)">{number('minimumContrast', 1, 21, 0.5)}</Row>
          <Row title="굵은 글자를 밝은 색으로" hint="굵은 글자에 밝은 색 팔레트를 씁니다.">{toggle('boldBright')}</Row>
          <Row title="GPU 렌더링 (WebGL)" hint="끄면 DOM 렌더러를 씁니다. 글자가 깨지거나 GPU 문제가 있을 때만 끄세요.">{toggle('terminalGpu')}</Row>
          <Row title="더블클릭 단어 구분 문자" hint="더블클릭으로 단어를 선택할 때 경계로 보는 문자입니다.">
            <input type="text" value={settings.wordSeparator} maxLength={64} aria-label="단어 구분 문자" onChange={event => set('wordSeparator', event.target.value)} />
            <button disabled={settings.wordSeparator === defaultSettings.wordSeparator} onClick={() => set('wordSeparator', defaultSettings.wordSeparator)}>기본</button>
          </Row>
        </Advanced>}
        {section === 'status' && <>
          <StatusLayoutEditor settings={settings} onChange={onChange} />
          <h4 className="setting-group">시계·시스템</h4>
          <Row title="12시간제 시계" hint="오전/오후로 표시합니다.">{toggle('clock12h')}</Row>
          <Row title="시계에 초 표시" hint="켜면 1초마다 갱신합니다.">{toggle('clockSeconds')}</Row>
          <Advanced>
            <Row title="CPU·메모리 갱신 주기" hint="초 단위 (2–60). 창이 보일 때만 조회합니다.">{number('systemRefresh', 2, 60)}</Row>
          </Advanced>
        </>}
        {section === 'ai' && <>
          <div className="ai-tabs" role="tablist" aria-label="AI 툴 분류">
            {aiTabs.map(item => <button key={item.id} role="tab" aria-selected={aiTab === item.id} onClick={() => setAiTab(item.id)}>
              <Icon name={item.icon} size={14} />{item.label}{item.id !== 'common' && (missing.includes(item.id) ? <small>미설치</small> : settings.agentsOff.includes(item.id) && <small>숨김</small>)}
            </button>)}
          </div>
          {aiTab === 'common' && <>
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
            <Row title="사용량 % 색상" hint="Claude Code statusline처럼 사용률에 따라 초록 → 노랑 → 빨강으로 색을 바꿉니다. 끄면 80% 이상만 경고색으로 표시합니다.">
              {settings.usageColors && <span className="usage-preview" aria-hidden="true">{[10, 45, 70, 90, 100].map(value => <span key={value} className="usage-window graded" style={{ '--usage-hue': usageHue(value) } as CSSProperties}>{value}%</span>)}</span>}
              {toggle('usageColors')}
            </Row>
            <Advanced>
              <Row title="사용량 갱신 주기" hint="초 단위 (60–600). 한도 조회는 서버에서 3분간 재사용하므로 더 짧게 해도 같은 값이 보일 수 있습니다. 상태바의 사용량을 누르면 상세 정보를 보여 주면서 바로 새로고침합니다.">{number('usageRefresh', 60, 600, 10)}</Row>
            </Advanced>
          </>}
          {aiTab !== 'common' && <>
            <h4 className="setting-group">실행</h4>
            <Row title="런처에 표시" hint="새 탭 메뉴, 새 pane, 명령 팔레트에 보입니다. 끄면 목록에서만 숨기며 실행 중인 에이전트에는 영향이 없습니다.">{inList('agentsOff', aiTab, `${agentNames[aiTab]} 표시`)}</Row>
            {aiTab === 'claude' && argsRow('claude', 'claudeArgs', '--model opus')}
            {aiTab === 'codex' && argsRow('codex', 'codexArgs', '--model gpt-5')}
            {aiTab === 'cursor' && argsRow('cursor', 'cursorArgs', '--model auto')}
            <h4 className="setting-group">알림</h4>
            <Row title="이 에이전트의 알림" hint="끄면 알림과 소리를 모두 끕니다. 사이드바의 표시는 그대로입니다. 알림 종류와 소리는 ‘공용’에서 정합니다.">{inList('agentsMuted', aiTab, `${agentNames[aiTab]} 알림`)}</Row>
            {aiTab !== 'cursor' && <>
              <h4 className="setting-group">사용량 (상태바)</h4>
              {aiTab === 'claude' && <>
                <Row title="사용량 표시" hint="5시간·주간 한도 사용률. Claude Code 로그인 정보로 조회합니다.">{statusSwitch('claudeusage', 'Claude Code 사용량 표시')}</Row>
              <Row title="Claude 5시간 한도 표시" hint="5시간 한도가 없는 플랜(Ultra 등)이면 끄세요. 끄면 주간 한도만 표시합니다.">{toggle('claudeSession')}</Row>
              </>}
              {aiTab === 'codex' && <Row title="사용량 표시" hint="Codex ChatGPT 로그인 또는 최근 세션 기록으로 조회합니다.">{statusSwitch('codexusage', 'Codex 사용량 표시')}</Row>}
              <p className="setting-note">색상과 갱신 주기는 ‘공용’에서 정합니다.</p>
            </>}
            {aiTab === 'claude' && <>
              <h4 className="setting-group">프롬프트 캐시·입력</h4>
              <Row title="프롬프트 캐시 타이머" hint="터미널 헤더와 사이드바에 캐시가 식기까지 남은 시간을 표시합니다.">{toggle('cacheTimer')}</Row>
              {settings.cacheTimer && <Row title="식기 전 경고 시점" hint="남은 시간이 이 비율 이하이면 노란색(곧 식음)으로 바뀝니다. (5–50%)">{number('cacheWarn', 5, 50)}</Row>}
              <Row title="캐시 만료 시 전송 경고" hint="캐시가 식었거나 곧 식을 때 메시지를 보내려 하면 먼저 확인을 받고, 허락하지 않으면 보내지 않습니다. 후속 대기열의 자동 전송에도 적용됩니다. 캐시 타이머 표시와는 별개입니다.">{toggle('cacheSendWarn')}</Row>
              {settings.cacheSendWarn && <Row title="경고 기준 남은 시간(분)" hint="1시간 캐시에서 남은 시간이 이 값 이하이면 경고합니다. (1–60분) 5분 캐시는 이미 식었을 때만 경고합니다.">{number('cacheSendWarnMinutes', 1, 60)}</Row>}
              <Row title="팁 표시" hint="컨텍스트가 길어졌을 때 /clear·/compact 안내, 마우스로 한 동작의 단축키 같은 도움말을 pane 모서리에 잠깐 띄웁니다.">{toggle('tips')}</Row>
              {settings.tips && <Row title="컨텍스트 팁 기준(k 토큰)" hint="Claude 대화 컨텍스트가 이 크기 이상일 때 메시지를 보내면 /clear 팁을 보여 줍니다. 기본 400k는 1M 컨텍스트의 40%입니다. 같은 팁은 10분에 한 번만 나옵니다. (50–1000)">{number('contextTipK', 50, 1000)}</Row>}
              <Row title="Follow-up 대기열 (Tab)" hint="Claude가 작업 중일 때 입력창에서 Tab을 누르면 메시지를 대기열에 넣고 작업이 끝나면 보냅니다. 끄면 Tab은 항상 Claude Code로 전달됩니다.">{toggle('followUpQueue')}</Row>
            </>}
          </>}
        </>}
        {section === 'diff' && <>
          <Row title="diff 글꼴 크기">{number('fontSize', 8, 40)}</Row>
          <Row title="자동 줄바꿈"><input type="checkbox" role="switch" checked={settings.wordWrap} onChange={event => set('wordWrap', event.target.checked)} /></Row>
          <Row title="diff 표시 방식" hint="자동은 패널이 넓을 때만 좌우로 나눠 보여줍니다."><Dropdown label="diff 표시 방식" value={settings.diffLayout} options={[{ value: 'auto', label: '자동' }, { value: 'inline', label: '한 줄로 (통합)' }, { value: 'split', label: '좌우 비교' }]} onChange={value => set('diffLayout', value as Settings['diffLayout'])} /></Row>
          <Row title="공백 변경 무시" hint="줄 앞뒤 공백만 바뀐 줄은 변경으로 표시하지 않습니다.">{toggle('diffIgnoreWhitespace')}</Row>
          <Advanced>
            <Row title="변경 없는 구간 접기" hint="변경사항 목록에서 바뀌지 않은 줄을 접어 둡니다.">{toggle('diffFoldUnchanged')}</Row>
            {settings.diffFoldUnchanged && <Row title="변경 주변 표시 줄 수" hint="접힌 구간 둘레에 남기는 줄 수입니다. (1–20)">{number('diffContextLines', 1, 20)}</Row>}
            <Row title="변경사항 패널 너비" hint="패널 왼쪽 경계를 끌어서도 바꿀 수 있고, 경계를 더블클릭하면 전체 너비로 넓힙니다. (320–1600px)">{number('reviewWidth', 320, 1600, 10)}</Row>
            <Row title="변경사항 새로고침 주기" hint="초 단위 (1–60)">{number('diffRefresh', 1, 60)}</Row>
          </Advanced>
        </>}
        {section === 'wakatime' && <WakaTimeSettings settings={settings} set={set} onChange={onChange} />}
        {section === 'plugins' && <PluginSettings />}
        {section === 'about' && <AboutSettings />}
        {section === 'keys' && <div className="actions"><button onClick={() => { onChange({ ...settings, onboarded: false }); onClose(); }}><Icon name="book" />튜토리얼 다시 보기</button></div>}
        {section === 'keys' && <div className="shortcut-list">{shortcuts.map(item => <div key={item.label + item.keys}><span>{item.label}</span><kbd>{item.keys}</kbd></div>)}</div>}
      </div>
    </div>
  </Modal>;
}
