import { useState, type ReactNode } from 'react';
import { defaultSettings, statusItemIds, type Settings } from './Editor';
import { Icon, IconButton, type IconName } from './Icon';
import { Dropdown, Modal } from './views';
import { playSound, soundIds, sounds } from './sound';

type Section = 'appearance' | 'terminal' | 'status' | 'notify' | 'diff' | 'keys';
const sections: { id: Section; label: string; icon: IconName }[] = [
  { id: 'appearance', label: '외관', icon: 'panelLeft' },
  { id: 'terminal', label: '터미널', icon: 'terminal' },
  { id: 'status', label: '상태바', icon: 'info' },
  { id: 'notify', label: '알림', icon: 'bell' },
  { id: 'diff', label: '변경사항', icon: 'diff' },
  { id: 'keys', label: '단축키', icon: 'code' }
];
export const statusLabels: Record<string, string> = { path: '프로젝트 경로', branch: '브랜치', changes: '변경 파일 수', terminals: '터미널 수', size: '터미널 크기', cpu: 'CPU 사용률', memory: '메모리 사용량', clock: '시계' };

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <div className="setting-row"><div><strong>{title}</strong>{hint && <small>{hint}</small>}</div><div className="setting-control">{children}</div></div>;
}

export function SettingsModal({ settings, onChange, onClose, shortcuts }: { settings: Settings; onChange(settings: Settings): void; onClose(): void; shortcuts: { label: string; keys: string }[] }) {
  const [section, setSection] = useState<Section>('appearance');
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value });
  const number = (key: 'fontSize' | 'terminalFontSize' | 'scrollback' | 'sidebarWidth' | 'diffRefresh' | 'lineHeight', min: number, max: number, step = 1) =>
    <input type="number" min={min} max={max} step={step} value={settings[key]} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= min && value <= max && (step < 1 || Number.isInteger(value))) set(key, value as never); }} />;
  const toggle = (key: 'dimInactivePanes' | 'cursorBlink' | 'copyOnSelect' | 'notifyDone' | 'notifyApproval' | 'notifySound') =>
    <input type="checkbox" role="switch" checked={settings[key]} onChange={event => set(key, event.target.checked as never)} />;
  const soundPicker = (title: string, hint: string, key: 'soundDone' | 'soundAttention') =>
    <Row title={title} hint={hint}><Dropdown label={title} value={settings[key]} options={soundIds.map(id => ({ value: id, label: sounds[id].label }))} onChange={value => { set(key, value); playSound(value, settings.soundVolume); }} />
      <IconButton icon="bell" label={`${title} 미리 듣기`} onClick={() => playSound(settings[key], settings.soundVolume)} /></Row>;
  const shown = new Set(settings.statusItems);
  return <Modal className="settings-modal" labelledBy="settings-title" onClose={onClose}>
    <div className="settings">
      <nav className="settings-nav" aria-label="설정 분류">
        <h2 id="settings-title">설정</h2>
        {sections.map(item => <button key={item.id} aria-pressed={section === item.id} onClick={() => setSection(item.id)}><Icon name={item.icon} />{item.label}</button>)}
        <span className="spacer" />
        <button onClick={() => onChange({ ...defaultSettings, theme: settings.theme })}><Icon name="refresh" />기본값으로</button>
      </nav>
      <div className="settings-body">
        <header><h3>{sections.find(item => item.id === section)?.label}</h3><IconButton icon="x" label="설정 닫기" keys="Esc" onClick={onClose} /></header>
        {section === 'appearance' && <>
          <Row title="색 테마"><Dropdown label="색 테마" value={settings.theme} options={[{ value: 'dark', label: '어둡게' }, { value: 'light', label: '밝게' }]} onChange={value => set('theme', value as Settings['theme'])} /></Row>
          <Row title="프로젝트 사이드바 너비" hint="사이드바 경계를 끌어서도 바꿀 수 있습니다. (160–480px)">{number('sidebarWidth', 160, 480)}</Row>
          <Row title="비활성 pane 흐리게" hint="포커스가 없는 터미널을 어둡게 표시합니다.">{toggle('dimInactivePanes')}</Row>
        </>}
        {section === 'terminal' && <>
          <Row title="글꼴 크기">{number('terminalFontSize', 8, 40)}</Row>
          <Row title="글꼴" hint="비우면 기본 모노스페이스 글꼴을 씁니다. 예: Cascadia Mono"><input type="text" value={settings.terminalFont} maxLength={200} placeholder="JetBrains Mono" onChange={event => set('terminalFont', event.target.value)} /></Row>
          <Row title="줄 높이">{number('lineHeight', 1, 2, 0.05)}</Row>
          <Row title="스크롤백 줄 수" hint="500–100,000">{number('scrollback', 500, 100000)}</Row>
          <Row title="커서 모양"><Dropdown label="커서 모양" value={settings.cursorStyle} options={[{ value: 'bar', label: '막대' }, { value: 'block', label: '블록' }, { value: 'underline', label: '밑줄' }]} onChange={value => set('cursorStyle', value as Settings['cursorStyle'])} /></Row>
          <Row title="커서 깜빡임">{toggle('cursorBlink')}</Row>
          <Row title="선택하면 바로 복사">{toggle('copyOnSelect')}</Row>
        </>}
        {section === 'status' && <>
          <p className="setting-note">하단 상태바에 표시할 항목을 고릅니다.</p>
          {statusItemIds.map(id => <Row key={id} title={statusLabels[id]}><input type="checkbox" role="switch" checked={shown.has(id)} onChange={event => set('statusItems', statusItemIds.filter(item => item === id ? event.target.checked : shown.has(item)))} /></Row>)}
        </>}
        {section === 'notify' && <>
          <Row title="에이전트 작업 완료" hint="터미널의 Claude Code·Codex가 5초 넘게 출력을 멈췄을 때(완료 또는 입력 대기) 알립니다. 해당 터미널을 보고 있을 때는 알리지 않습니다.">{toggle('notifyDone')}</Row>
          <Row title="승인·입력 요청" hint="터미널의 Claude Code·Codex가 벨(BEL)로 확인을 요청할 때도 알립니다.">{toggle('notifyApproval')}</Row>
          <Row title="알림 소리" hint="알림과 함께 짧은 효과음을 재생합니다. 알림 권한이 없어도 소리는 납니다.">{toggle('notifySound')}</Row>
          {settings.notifySound && <>
            <Row title="소리 확장" hint="소리 크기를 최대 200%까지 조절합니다."><input type="checkbox" role="switch" aria-label="소리 확장" checked={settings.soundVolumeExtended} onChange={event => onChange({ ...settings, soundVolumeExtended: event.target.checked, soundVolume: event.target.checked ? settings.soundVolume : Math.min(settings.soundVolume, 100) })} /></Row>
            <Row title="소리 크기" hint={settings.soundVolumeExtended ? '0–200%' : '0–100%'}><input type="range" min={0} max={settings.soundVolumeExtended ? 200 : 100} step={5} value={settings.soundVolume} aria-label="소리 크기" onChange={event => set('soundVolume', Number(event.target.value))} /><span className="range-value">{settings.soundVolume}%</span></Row>
            {soundPicker('완료 소리', '작업이 멈췄을 때 재생합니다.', 'soundDone')}
            {soundPicker('입력 요청 소리', '확인이 필요할 때 재생합니다.', 'soundAttention')}
          </>}
        </>}
        {section === 'diff' && <>
          <Row title="변경사항 새로고침 주기" hint="초 단위 (1–60)">{number('diffRefresh', 1, 60)}</Row>
          <Row title="diff 글꼴 크기">{number('fontSize', 8, 40)}</Row>
          <Row title="자동 줄바꿈"><input type="checkbox" role="switch" checked={settings.wordWrap} onChange={event => set('wordWrap', event.target.checked)} /></Row>
        </>}
        {section === 'keys' && <div className="shortcut-list">{shortcuts.map(item => <div key={item.label + item.keys}><span>{item.label}</span><kbd>{item.keys}</kbd></div>)}</div>}
      </div>
    </div>
  </Modal>;
}
