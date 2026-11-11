import { useMemo, type CSSProperties } from 'react';
import { monoFont, type Settings } from './Editor';
import { Icon } from './Icon';
import { Logo } from './Splash';
import { installedTerminalFonts, monoFontDropdownOptions } from './terminal-fonts';
import { Dropdown } from './views';

// First-run setup, before the tour: theme, accent and terminal font, each applied at once to the practice app behind it.
const accents = [['', '#5ec8e5', '기본'], ['#7c9cff', '#7c9cff', '블루'], ['#a78bfa', '#a78bfa', '바이올렛'], ['#f472b6', '#f472b6', '핑크'], ['#fb8b5b', '#fb8b5b', '오렌지'], ['#f5c04a', '#f5c04a', '옐로'], ['#4ade80', '#4ade80', '그린']] as const;
const themes = [
  { id: 'dark', label: '다크', bg: '#0c0d0f', surface: '#141518', line: '#24262b', fg: '#e4e6ea', muted: '#5c616b' },
  { id: 'light', label: '라이트', bg: '#eceef1', surface: '#ffffff', line: '#dfe2e7', fg: '#1d2127', muted: '#9aa1ab' }
] as const;

export function Setup({ settings, onSettings, onNext }: { settings: Settings; onSettings(next: Settings): void; onNext(): void }) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onSettings({ ...settings, [key]: value });
  const fontOptions = useMemo(() => monoFontDropdownOptions(settings.terminalFont, installedTerminalFonts(), '기본'), [settings.terminalFont]);
  const accent = settings.accentColor || (settings.theme === 'light' ? '#0b8db3' : '#5ec8e5');
  const font = settings.terminalFont.trim() ? `${settings.terminalFont.trim()}, ${monoFont}` : monoFont;
  return <section className="setup" role="dialog" aria-labelledby="setup-title">
    <header className="setup-head">
      <Logo size={44} />
      <div><h1 id="setup-title">무너에이드에 오신 걸 환영해요</h1><p>먼저 작업 환경을 취향대로 맞춰 볼까요? 나중에 언제든 바꿀 수 있어요.</p></div>
    </header>

    <h2>테마</h2>
    <div className="setup-themes" role="radiogroup" aria-label="테마">
      {themes.map(theme => <button key={theme.id} role="radio" aria-checked={settings.theme === theme.id} className="setup-theme" onClick={() => set('theme', theme.id)}
        style={{ '--t-bg': theme.bg, '--t-surface': theme.surface, '--t-line': theme.line, '--t-fg': theme.fg, '--t-muted': theme.muted, '--t-accent': settings.accentColor || (theme.id === 'light' ? '#0b8db3' : '#5ec8e5') } as CSSProperties}>
        <span className="mini" aria-hidden="true"><span className="mini-side"><i /><i /><i /></span><span className="mini-main"><i /><i /><i className="short" /><b /></span></span>
        <span className="setup-theme-label">{settings.theme === theme.id && <Icon name="check" size={14} />}{theme.label}</span>
      </button>)}
    </div>

    <h2>강조 색</h2>
    <div className="setup-accent-row">
      <div className="setup-accents" role="radiogroup" aria-label="강조 색">
        {accents.map(([value, swatch, label]) => <button key={label} role="radio" aria-checked={settings.accentColor === value} aria-label={label} title={label} style={{ '--swatch': swatch } as CSSProperties} onClick={() => set('accentColor', value)} />)}
        <label className="setup-custom" title="직접 고르기"><input type="color" value={accent} aria-label="강조 색 직접 고르기" onChange={event => set('accentColor', event.target.value)} /><Icon name="palette" size={16} /></label>
      </div>
      <div className="setup-accent-demo" aria-hidden="true">
        <span className="demo-btn">저장</span>
        <span className="demo-switch"><i /></span>
        <span className="demo-bar"><i /></span>
        <span className="demo-link">링크</span>
      </div>
    </div>

    <h2>터미널 글꼴</h2>
    <div className="setup-fonts">
      <div className="setup-font-row">
        <Dropdown className="setup-font-dropdown" label="터미널 글꼴" value={settings.terminalFont} options={fontOptions} onChange={value => set('terminalFont', value)} />
        <div className="setup-font-sample" aria-hidden="true" style={{ fontFamily: font }}><b>Aa 가나다</b><span>0Oo 1lI {'=> != ==='}</span></div>
      </div>
      <div className="setup-size"><span>크기</span><input type="range" min={10} max={20} aria-label="터미널 글꼴 크기" value={settings.terminalFontSize} onChange={event => set('terminalFontSize', Number(event.target.value))} /><output>{settings.terminalFontSize}px</output></div>
      <pre className="setup-preview" style={{ fontFamily: font, fontSize: settings.terminalFontSize }}>
        <span className="p">~/my-app</span> <span className="g">$</span> claude{'\n'}<span className="o">✻</span> <b>Claude Code</b> <span className="d">· ~/my-app</span>{'\n'}<span className="o">&gt;</span> 포트를 환경 변수로 바꿔 줘{'\n'}<span className="o">⏺</span> Update(<b>src/server.ts</b>) <span className="g">+1</span> <span className="r">−1</span>
      </pre>
    </div>

    <footer>
      <span className="spacer" />
      <button type="button" className="primary" autoFocus onClick={onNext}>다음: 기능 둘러보기<Icon name="arrowRight" size={16} /></button>
    </footer>
  </section>;
}
