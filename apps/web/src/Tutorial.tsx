import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { findLeaf, isLeaf, leafList, type Leaf, type Pane } from './api';
import { usageHue, type Settings } from './Editor';
import { Icon, IconButton } from './Icon';
import { pickGreeting } from './chat-model';
import { useShells, shellLabel } from './shells';
import { launchersFor } from './launchers';
import { CacheTimer, Splitter, launchers, terminalTheme, xtermOptions } from './Panes';
import { QuickInput, type QuickRequest } from './QuickInput';
import { ReviewPanel } from './Review';
import { SettingsModal } from './Settings';
import { Setup } from './Setup';
import { Logo } from './Splash';
import { playSound } from './sound';
import { AppVersion, type GitState } from './views';
import { matches, showKeys as showDefaultKeys } from './Workspace';
import { appKey, appKeyDefs, showAppKey } from './shortcuts';
import { activeTab, agentPrompt, closable, initialTour, project, reduce, shellPrompt, stepDone, steps, type Action, type Agent, type Tour, type TourProject, type TourTab } from './onboarding-steps';

// First-run tutorial: a full-screen practice copy of the app, drawn with the app's own markup and styles (sidebar, tab bar, panes,
// status bar) and the real command palette, review panel, settings window and xterm. A coach card points at what to do next.
// Nothing here talks to the server; finishing fades it away onto the real screen underneath.

// `setup`: start with the theme and font screen (first run); a replay goes straight to the tour. `onDone` runs as the tour starts to fade.
type Props = { settings: Settings; onSettings(next: Settings): void; setup: boolean; onDone(): void };

const agentOf = (command: string): Agent | '' => command === 'claude' ? 'claude' : command === 'codex' ? 'codex' : command === 'cursor-agent' ? 'cursor' : '';
const before = "import express from 'express';\n\nconst app = express();\nconst port = 3000;\n\napp.get('/health', (_req, res) => res.send('ok'));\n\napp.listen(port, () => console.log(`listening on :${port}`));\n";
const after = before.replace('const port = 3000;', 'const port = Number(process.env.PORT ?? 3000);');
const summary: [string, string][] = [
  ['새 터미널 탭', 'mod+shift+t'], ['다음/이전 탭', 'alt+]'], ['탭 번호로 이동', 'alt+1'], ['탭 위/아래로 이동', 'alt+shift+['], ['좌우 분할', 'ctrl+d'], ['상하 분할', 'ctrl+shift+d'],
  ['Pane 이동', 'alt+shift+→'], ['Pane 최대화', 'mod+shift+enter'], ['변경사항(Diff) 패널', 'mod+shift+g'], ['명령 팔레트', 'mod+shift+p'], ['프로젝트 번호로 이동', 'mod+alt+1'], ['설정', 'mod+,']
];
const features: [Parameters<typeof Icon>[0]['name'], string, string][] = [
  ['folder', '프로젝트별 작업 공간', '프로젝트마다 터미널과 에이전트가 따로, 멈추지 않고 돌아가요'],
  ['bell', '놓치지 않는 알림', '작업을 마치거나 승인을 기다리면 바로 알려 줘요'],
  ['splitH', '자유로운 분할', '한 탭에 터미널과 에이전트를 원하는 만큼'],
  ['diff', '변경사항 한눈에', '에이전트가 고친 코드를 그 자리에서 비교해요']
];
// The palette lists the real command names and keys.
const paletteItems: { id: string; label: string; keys?: string; action?: Action }[] = [
  { id: 'newTab', label: '새 탭', keys: 'mod+shift+t', action: { type: 'newTab' } },
  { id: 'newClaude', label: '새 탭에서 Claude Code 실행', action: { type: 'launch', target: '', agent: 'claude' } },
  { id: 'newCodex', label: '새 탭에서 Codex 실행', action: { type: 'launch', target: '', agent: 'codex' } },
  { id: 'newCursor', label: '새 탭에서 Cursor CLI 실행', action: { type: 'launch', target: '', agent: 'cursor' } },
  { id: 'nextTab', label: '다음 탭', keys: 'alt+]', action: { type: 'cycle', step: 1 } },
  { id: 'prevTab', label: '이전 탭', keys: 'alt+[', action: { type: 'cycle', step: -1 } },
  { id: 'splitRight', label: '오른쪽으로 분할', action: { type: 'split', dir: 'row' } },
  { id: 'splitDown', label: '아래로 분할', action: { type: 'split', dir: 'column' } },
  { id: 'zoom', label: 'Pane 최대화 전환', keys: 'mod+shift+enter', action: { type: 'zoom' } },
  { id: 'focusNext', label: '다음 pane으로 이동', keys: 'alt+shift+arrowright', action: { type: 'focusBy', step: 1 } },
  { id: 'review', label: '변경사항(Diff) 패널 전환', keys: 'mod+shift+g', action: { type: 'diff' } },
  { id: 'settings', label: '설정 열기', keys: 'mod+,', action: { type: 'settings', open: true } },
  { id: 'nextProject', label: '다음 프로젝트', keys: 'mod+alt+]', action: { type: 'projectCycle', step: 1 } },
  { id: 'prevProject', label: '이전 프로젝트', keys: 'mod+alt+[', action: { type: 'projectCycle', step: -1 } },
  { id: 'tutorial', label: '튜토리얼 다시 보기' }
];
// Where a tab dropped on another lands: edges reorder, the middle merges (as in the real sidebar).
function dropMode(event: DragEvent<Element>, sourceId: string, targetId: string) {
  const box = event.currentTarget.getBoundingClientRect(), ratio = (event.clientY - box.top) / box.height;
  if (sourceId === targetId) return ratio < 0.5 ? 'before' : 'after';
  return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'merge';
}

// A real xterm with a tiny local line editor: typed text is echoed, Enter/Tab hand the line to the tutorial, output arrives as `lines`.
function TourTerminal({ lines, prompt, settings, focused, focusKey, onSubmit, onTab }: { lines: string[]; prompt: string; settings: Settings; focused: boolean; focusKey: number; onSubmit(text: string): void; onTab(text: string): boolean }) {
  const host = useRef<HTMLDivElement>(null), term = useRef<Terminal | null>(null);
  const state = useRef({ typed: '', written: lines.length, prompt, lines });
  const calls = useRef({ onSubmit, onTab }); calls.current = { onSubmit, onTab };
  const focusedRef = useRef(focused); focusedRef.current = focused;
  useEffect(() => {
    const terminal = new Terminal({ ...xtermOptions(settings), allowProposedApi: true, theme: terminalTheme(host.current!) }), fit = new FitAddon(), s = state.current;
    const redraw = () => terminal.write(`\r\x1b[2K${s.prompt}${s.typed}`);
    terminal.loadAddon(fit); term.current = terminal;
    terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11'; // Hangul widths, as in the app's terminals
    terminal.write((s.lines.length ? s.lines.join('\r\n') + '\r\n' : '') + s.prompt);
    terminal.onData(data => {
      if (data === '\r') { const text = s.typed; s.typed = ''; redraw(); calls.current.onSubmit(text); }
      else if (data === '\t') { if (calls.current.onTab(s.typed)) { s.typed = ''; redraw(); } }
      else if (data === '\x7f' || data === '\b') { s.typed = Array.from(s.typed).slice(0, -1).join(''); redraw(); }
      else if (data === '\x03') { s.typed = ''; terminal.write('^C\r\n'); redraw(); }
      else if (!data.startsWith('\x1b')) { const text = data.replace(/[\x00-\x1f\x7f]/g, ''); if (text) { s.typed += text; terminal.write(text); } }
    });
    // Opened only once visible: xterm measures its cells on open, and a terminal opened in a hidden tab would stay blank.
    const observer = new ResizeObserver(() => { if (!host.current?.clientWidth) return; if (!terminal.element) { terminal.open(host.current); if (focusedRef.current) terminal.focus(); } fit.fit(); });
    observer.observe(host.current!);
    return () => { observer.disconnect(); terminal.dispose(); term.current = null; };
  }, []);
  useEffect(() => {
    const s = state.current, fresh = lines.slice(s.written); s.lines = lines; s.written = lines.length;
    if (fresh.length) term.current?.write(`\r\x1b[2K${fresh.join('\r\n')}\r\n${s.prompt}${s.typed}`);
  }, [lines]);
  useEffect(() => { const s = state.current; if (s.prompt !== prompt) { s.prompt = prompt; term.current?.write(`\r\x1b[2K${prompt}${s.typed}`); } }, [prompt]);
  // Next frame: the shell switches `data-theme` after child effects run.
  useEffect(() => {
    const frame = requestAnimationFrame(() => { const terminal = term.current; if (!terminal || !host.current) return; terminal.options.theme = terminalTheme(host.current); Object.assign(terminal.options, xtermOptions(settings)); });
    return () => cancelAnimationFrame(frame);
  }, [settings]);
  useEffect(() => { if (focused) term.current?.focus(); }, [focused, focusKey]);
  return <div ref={host} className="xterm-host" />;
}

function LaunchPicker({ title, autoFocus, onLaunch, shell }: { shell: string; title?: string; autoFocus?: boolean; onLaunch(agent: Agent | ''): void }) {
  const shells = useShells(), greeting = useMemo(() => pickGreeting(), []);
  return <div className="empty-tab"><div className="launcher-heading"><span className="launcher-mode"><Icon name="terminal" size={13} />CLI 연습</span><h2>{greeting}</h2></div><div className="launchers">{launchersFor('cli', shellLabel(shells, shell)).map((item, index) =>
    <button key={item.id} autoFocus={autoFocus && index === 0} onClick={() => onLaunch(agentOf(item.command))}><span className="launcher-icon"><Icon name={item.icon} size={24} /></span><span className="launcher-copy"><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span><span className="launcher-arrow" aria-hidden="true"><Icon name="arrowRight" size={16} /></span></button>)}</div></div>;
}

type Ctx = { tour: Tour; settings: Settings; focusKey: number; dispatch(action: Action): void; note(text: string): void; submit(leaf: string, text: string): void; tab(leaf: string, text: string): boolean; prompt(leaf: string): string };
const refuse = ' 둘러보기에 필요해서 지금은 닫을 수 없어요.';
function TourPane({ leaf, ctx }: { leaf: Leaf; ctx: Ctx }) {
  const { tour, settings, dispatch } = ctx, id = leaf.id, focused = tour.focus === id, zoomed = tour.zoom === id;
  const pick = () => { if (!focused) dispatch({ type: 'pick', id }); };
  const close = () => closable(tour, id) ? dispatch({ type: 'closePane', id }) : ctx.note(`이 터미널은${refuse}`);
  if (leaf.kind === 'launcher') return <section className={`terminal-pane launcher-pane ${focused ? 'focused' : ''}`} onMouseDownCapture={pick}>
    <div className="pane-tools" role="toolbar" aria-label="새 창">
      <span className="pane-title"><span className="pane-mark"><Icon name="plus" size={12} /></span><span className="pane-label">새 창</span></span>
      <span className="pane-actions"><IconButton icon="x" label="pane 닫기" onClick={close} /></span></div>
    <LaunchPicker shell={settings.terminalShell} autoFocus={focused} onLaunch={agent => dispatch({ type: 'launch', target: id, agent })} />
  </section>;
  const agent = tour.agents[id], claude = tour.claude?.leaf === id ? tour.claude : null;
  const state = claude ? ({ working: 'working', asking: 'attention', done: 'done', idle: 'idle' } as const)[claude.state] : agent ? 'idle' : undefined;
  return <section className={`terminal-pane ${focused ? 'focused' : ''}`} data-agent={agent} data-agent-state={state} onMouseDownCapture={pick}>
    <div className="pane-tools" role="toolbar" aria-label="터미널 pane">
      {claude && agent === 'claude' && settings.cacheTimer && <CacheTimer cache={{ at: claude.at, ttl: 300, tokens: 18_400, model: 'claude-opus-5-5' }} working={claude.state === 'working'} warn={settings.cacheWarn} />}
      <span className="pane-title"><span className="pane-mark"><Icon name={agent || 'terminal'} size={12} /></span><span className="pane-label">{tour.labels[id]}</span>
        {claude?.state === 'asking' && <span className="question-alert" role="img" aria-label="응답 필요" title="질문 또는 승인을 처리해 주세요"><Icon name="alert" size={15} /></span>}</span>
      <span className="pane-actions">
        <IconButton icon="splitH" label="좌우 분할" keys={showAppKey(settings.appKeys, 'splitRight')} onClick={() => dispatch({ type: 'split', dir: 'row' })} />
        <IconButton icon="splitV" label="상하 분할" keys={showAppKey(settings.appKeys, 'splitDown')} onClick={() => dispatch({ type: 'split', dir: 'column' })} />
        <IconButton icon={zoomed ? 'minimize' : 'maximize'} label={zoomed ? '원래 크기로' : '최대화'} keys={showAppKey(settings.appKeys, 'zoom')} onClick={() => dispatch({ type: 'zoom' })} />
        <IconButton icon="x" label="터미널 종료" onClick={close} /></span></div>
    <TourTerminal lines={tour.lines[id] ?? []} prompt={ctx.prompt(id)} settings={settings} focused={focused} focusKey={ctx.focusKey} onSubmit={text => ctx.submit(id, text)} onTab={text => ctx.tab(id, text)} />
    {claude && claude.queue.length > 0 && <div className="claude-follow-up">
      <div className="follow-up-heading" role="status">Follow-up {claude.queue.length}개 · 현재 작업 완료 후 순서대로 전송</div>
      <ol>{claude.queue.map((text, index) => <li key={index}><span>{text}</span><IconButton icon="x" label={`Follow-up 취소: ${text}`} onClick={() => dispatch({ type: 'unqueue', index })} /></li>)}</ol>
    </div>}
  </section>;
}
function Tree({ pane, ctx, onLayout }: { pane: Pane; ctx: Ctx; onLayout(next: Pane): void }) {
  if (isLeaf(pane)) return <TourPane leaf={pane} ctx={ctx} />;
  return <Splitter equalOnClick direction={pane.direction} sizes={pane.sizes} onSizes={sizes => onLayout({ ...pane, sizes })}>
    {pane.children.map((child, index) => <Tree key={isLeaf(child) ? child.id : index} pane={child} ctx={ctx} onLayout={next => onLayout({ ...pane, children: pane.children.map((old, i) => i === index ? next : old) })} />)}
  </Splitter>;
}

export function Tutorial({ settings, onSettings, setup, onDone }: Props) {
  const configuredKey = (keys: string) => {
    const def = appKeyDefs.find(def => def.keys === keys);
    return def ? appKey(settings.appKeys, def.id)! : keys;
  };
  const showKeys = (keys: string) => showDefaultKeys(configuredKey(keys));
  const list = useMemo(() => steps(showKeys), [settings.appKeys]);
  const [phase, setPhase] = useState<'setup' | 'tour'>(setup ? 'setup' : 'tour');
  const [tour, setTour] = useState<Tour>(initialTour), [at, setAt] = useState(0), [feedback, setFeedback] = useState(''), [focusKey, setFocusKey] = useState(0);
  const [menu, setMenu] = useState(false), [folded, setFolded] = useState<Set<string>>(new Set()), [leaving, setLeaving] = useState(false), [paletteKey, setPaletteKey] = useState(0);
  const [drag, setDrag] = useState(''), [dropAt, setDropAt] = useState<{ id: string; mode: 'before' | 'after' | 'merge' } | null>(null);
  const step = list[at], done = stepDone(step, tour), last = at === list.length - 1;
  const dispatch = useCallback((action: Action) => { setFeedback(''); setTour(current => reduce(current, action, Date.now())); }, []);
  const note = setFeedback;
  const leave = () => { setLeaving(true); onDone(); };
  const p = project(tour), shown = activeTab(tour), claude = tour.claude;

  // ---- keys: the app's bindings, caught before anything else and never passed to the real projects underneath ----
  const onKey = (event: KeyboardEvent) => {
    if (event.isComposing || leaving || phase === 'setup') return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('dialog')) return; // the real settings window opened from here
    const inTerminal = Boolean(target?.closest('.tour .xterm'));
    const split = matches(configuredKey('ctrl+d'), event) ? 'row' : matches(configuredKey('ctrl+shift+d'), event) ? 'column' : null;
    if (split) {
      event.preventDefault(); event.stopPropagation();
      dispatch({ type: 'split', dir: split });
      return;
    }
    // As in the app: plain Ctrl+key inside a terminal belongs to the shell.
    if (inTerminal && !(event.metaKey || (event.ctrlKey && event.shiftKey) || event.altKey) && !appKeyDefs.some(def => settings.appKeys?.[def.id] && matches(settings.appKeys[def.id], event))) return;
    const index = p.tabs.findIndex(item => item.id === p.active), panes = leafList(shown.pane).length;
    const focusBy = (step: number) => () => panes > 1 ? dispatch({ type: 'focusBy', step }) : note('분할된 칸이 하나뿐이라 옮겨 갈 곳이 없습니다.');
    const newTab = () => dispatch({ type: 'newTab' });
    const palette = () => { if (!tour.palette) setPaletteKey(key => key + 1); dispatch({ type: 'palette', open: !tour.palette }); };
    const bindings: [string, () => void][] = [
      ['mod+shift+t', newTab], ['alt+t', newTab],
      ['alt+]', () => dispatch({ type: 'cycle', step: 1 })], ['alt+[', () => dispatch({ type: 'cycle', step: -1 })], ['mod+shift+]', () => dispatch({ type: 'cycle', step: 1 })], ['mod+shift+[', () => dispatch({ type: 'cycle', step: -1 })],
      ...Array.from({ length: 9 }, (_, i): [string, () => void] => [`alt+${i + 1}`, () => dispatch({ type: 'jump', index: i })]),
      ['alt+shift+[', () => dispatch({ type: 'move', id: p.active, to: index - 1 })], ['alt+shift+]', () => dispatch({ type: 'move', id: p.active, to: index + 1 })],
      ['alt+shift+arrowright', focusBy(1)], ['alt+shift+arrowdown', focusBy(1)], ['alt+shift+arrowleft', focusBy(-1)], ['alt+shift+arrowup', focusBy(-1)],
      ['mod+shift+arrowright', focusBy(1)], ['mod+shift+arrowdown', focusBy(1)], ['mod+shift+arrowleft', focusBy(-1)], ['mod+shift+arrowup', focusBy(-1)],
      ['mod+shift+enter', () => dispatch({ type: 'zoom' })], ['mod+shift+g', () => dispatch({ type: 'diff' })],
      ['mod+shift+p', palette], ['f1', palette], ['mod+,', () => dispatch({ type: 'settings', open: true })],
      ...Array.from({ length: 9 }, (_, i): [string, () => void] => [`mod+alt+${i + 1}`, () => dispatch({ type: 'projectJump', index: i })]),
      ['mod+alt+]', () => dispatch({ type: 'projectCycle', step: 1 })], ['mod+alt+[', () => dispatch({ type: 'projectCycle', step: -1 })],
      ['mod+alt+o', () => note('둘러보기를 마치면 내 프로젝트를 열 수 있어요.')]
    ];
    const hit = bindings.find(([keys]) => matches(configuredKey(keys), event));
    if (!hit) return;
    event.preventDefault(); event.stopPropagation(); hit[1]();
  };
  const keyRef = useRef(onKey); keyRef.current = onKey;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => keyRef.current(event);
    addEventListener('keydown', handler, true);
    return () => removeEventListener('keydown', handler, true);
  }, []);

  // ---- the scripted Claude: works until the follow-up lesson has queued something, asks a question once you look away ----
  const holdForQueue = step.id === 'followUp' && !tour.done.includes('queue'), away = tour.done.includes('away');
  useEffect(() => {
    if (claude?.state !== 'working' || holdForQueue) return;
    const timer = setTimeout(() => dispatch({ type: 'workDone' }), 2600); return () => clearTimeout(timer);
  }, [claude?.state, claude?.at, holdForQueue]);
  useEffect(() => {
    if (!away || !claude || claude.asked || claude.state === 'working') return;
    const timer = setTimeout(() => dispatch({ type: 'ask' }), 1500); return () => clearTimeout(timer);
  }, [away, claude?.state, claude?.asked, tour.current, p.active]);
  const heard = useRef(claude?.state);
  useEffect(() => {
    const state = claude?.state;
    if (state !== heard.current && settings.notifySound && (state === 'asking' || state === 'done')) playSound(state === 'asking' ? settings.soundAttention : settings.soundDone, settings.soundVolume);
    heard.current = state;
  }, [claude?.state]);

  // ---- coach: a new step starts in the focused terminal; a finished one hands focus to "다음" ----
  const next = useRef<HTMLButtonElement>(null), coach = useRef<HTMLElement>(null);
  useEffect(() => { setFeedback(''); setMenu(false); if (step.tasks.length && !done) setFocusKey(key => key + 1); else next.current?.focus(); }, [at, phase]);
  useEffect(() => { if (done && step.tasks.length) next.current?.focus(); }, [done]);
  // The settings window is a modal <dialog> in the top layer; lift the card there too, after it, so the tip stays readable on top.
  useEffect(() => { if (tour.settings) coach.current?.showPopover?.(); }, [tour.settings]);
  const target = phase === 'tour' ? step.tasks.find(task => !tour.done.includes(task.flag))?.target ?? step.target : undefined;
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // ponytail: polls the target's box every 200 ms; switch to Resize/MutationObservers if it ever shows up in a profile.
  useEffect(() => {
    const measure = () => {
      const box = target ? document.querySelector(target)?.getBoundingClientRect() : undefined;
      const value = box && box.width && box.height ? { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) } : null;
      setRect(previous => previous?.x === value?.x && previous?.y === value?.y && previous?.w === value?.w && previous?.h === value?.h ? previous : value);
    };
    measure(); const timer = setInterval(measure, 200); return () => clearInterval(timer);
  }, [target]);
  // Beside the target when there is room, otherwise in the bottom-right corner over it.
  useLayoutEffect(() => {
    const card = coach.current; if (!card) return;
    if (!rect) { card.style.left = card.style.top = ''; return; }
    const w = card.offsetWidth, h = card.offsetHeight, m = 16, W = innerWidth, H = innerHeight;
    const y = (value: number) => Math.max(m, Math.min(H - h - m, value)), x = (value: number) => Math.max(m, Math.min(W - w - m, value));
    // Beside the target the card sits low, clear of the terminal output that fills panes from the top.
    const side = y(Math.max(rect.y, H - h - 48));
    const spot = rect.x + rect.w + m + w <= W - m ? [rect.x + rect.w + m, side] : rect.x - m - w >= m ? [rect.x - m - w, side]
      : rect.y + rect.h + m + h <= H - m ? [x(rect.x), rect.y + rect.h + m] : rect.y - m - h >= m ? [x(rect.x), rect.y - m - h] : [W - w - m - 8, H - h - 42];
    card.style.left = `${spot[0]}px`; card.style.top = `${spot[1]}px`;
  });

  // ---- terminals ----
  const submit = (leaf: string, text: string) => {
    dispatch({ type: 'submit', leaf, text });
  };
  const tab = (leaf: string, text: string) => {
    if (claude?.leaf !== leaf) return false; // otherwise Tab belongs to the CLI (completion)
    // Working: queue it (empty sends an example). Otherwise Tab works like Enter, so either key moves the lesson on.
    dispatch(claude.state === 'working' ? { type: 'queue', text } : { type: 'submit', leaf, text }); return true;
  };
  const prompt = (leaf: string) => tour.agents[leaf] ? agentPrompt(tour.agents[leaf]) : p.id === 'my-app' ? shellPrompt : shellPrompt.replace('~/my-app', '~/projects/api-server');
  const ctx: Ctx = { tour, settings, focusKey, dispatch, note, submit, tab, prompt };

  // ---- sidebar (same markup as the app's) ----
  const leafState = (id: string) => claude?.leaf !== id ? undefined : claude.state === 'asking' ? 'attention' : claude.state === 'done' ? 'done' : claude.state === 'working' ? 'working' : undefined;
  const alertOf = (state?: string) => state === 'attention' ? <span className="question-alert" role="img" aria-label="응답 필요"><Icon name="alert" size={15} /></span> : state === 'done' ? <i className="attn-dot" aria-label="확인 필요" /> : null;
  const closeTab = (item: TourTab) => closable(tour, item.id) ? dispatch({ type: 'closeTab', id: item.id }) : note(`‘${item.label}’ 탭은${refuse}`);
  const folder = (item: TourProject, index: number) => {
    const selected = item.id === tour.current, open = !folded.has(item.id), name = item.name;
    const states = item.tabs.flatMap(t => leafList(t.pane).map(leaf => leafState(leaf.id)));
    const choose = () => dispatch({ type: 'project', id: item.id });
    return <section key={item.id} data-project={item.id} className={`folder ${selected ? 'active' : ''}`}>
      <div role="treeitem" aria-expanded={open} aria-selected={selected} tabIndex={0} className="folder-head" title={`${name}\n${item.root}\n${showKeys(`mod+alt+${index + 1}`)}`}
        onClick={choose} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') choose(); }}>
        <button className="folder-chevron" aria-label={open ? `${name} 접기` : `${name} 펼치기`} onClick={event => { event.stopPropagation(); setFolded(previous => { const set = new Set(previous); if (!set.delete(item.id)) set.add(item.id); return set; }); }}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} /></button>
        <span className="folder-icon"><Icon name="folder" size={15} /></span>
        <span className="folder-name">{name}</span>
        {states.includes('attention') ? <span className="question-alert" role="img" aria-label="응답 필요" title="질문 또는 승인을 처리해 주세요"><Icon name="alert" size={15} /></span> : states.includes('done') && <i className="attn-dot" aria-label="확인 필요" />}
        <span className="folder-actions">
          <button aria-label={`${name}에 새 탭`} title={`새 터미널 탭 (${showKeys('mod+shift+t')})`} onClick={event => { event.stopPropagation(); if (!selected) choose(); dispatch({ type: 'newTab' }); }}><Icon name="plus" size={14} /></button>
          <button aria-label={`${name} 프로젝트 닫기`} title={`프로젝트 닫기 (${showKeys('mod+alt+w')})`} onClick={event => { event.stopPropagation(); note('연습용 프로젝트는 닫을 수 없어요. 실제 앱에서는 이 버튼이나 가운데 클릭으로 닫습니다.'); }}><Icon name="x" size={14} /></button>
        </span>
      </div>
      {open && <ul className="folder-tabs" role="group" data-dragging={drag && selected ? '' : undefined}>
        {item.tabs.map((tabItem, tabIndex) => {
          const on = selected && tabItem.id === item.active, leaves = leafList(tabItem.pane), agent = leaves.map(leaf => tour.agents[leaf.id]).find(Boolean);
          const state = (['attention', 'done', 'working'] as const).find(value => leaves.some(leaf => leafState(leaf.id) === value && (value !== 'done' || !on)));
          const select = () => { if (!selected) choose(); dispatch({ type: 'tab', id: tabItem.id }); };
          const mine = claude && leaves.some(leaf => leaf.id === claude.leaf), cache = mine && tour.agents[claude!.leaf] === 'claude' && settings.cacheTimer && !on && <CacheTimer cache={{ at: claude!.at, ttl: 300, tokens: 18_400, model: 'claude-opus-5-5' }} working={claude!.state === 'working'} warn={settings.cacheWarn} />;
          const close = <button className="ptab-close" aria-label={`${tabItem.label} 탭 닫기`} title="탭 닫기" onClick={event => { event.stopPropagation(); closeTab(tabItem); }}><Icon name="x" size={12} /></button>;
          const mode = selected && dropAt?.id === tabItem.id ? dropAt.mode : null;
          const dnd = {
            draggable: selected,
            onDragStart: (event: DragEvent) => { if (event.target instanceof Element && event.target.closest('button')) { event.preventDefault(); return; } event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', tabItem.id); setDrag(tabItem.id); },
            onDragEnd: () => { setDrag(''); setDropAt(null); },
            onDragOver: (event: DragEvent<HTMLLIElement>) => {
              if (!drag || !selected) return;
              if (drag === tabItem.id) { event.dataTransfer.dropEffect = 'none'; setDropAt(null); return; }
              event.preventDefault(); event.dataTransfer.dropEffect = 'move';
              const value = dropMode(event, drag, tabItem.id);
              setDropAt(previous => previous?.id === tabItem.id && previous.mode === value ? previous : { id: tabItem.id, mode: value });
            },
            onDrop: (event: DragEvent) => {
              event.preventDefault(); event.stopPropagation();
              if (drag && drag !== tabItem.id) {
                const value = dropMode(event, drag, tabItem.id), from = item.tabs.findIndex(t => t.id === drag), shift = from < tabIndex ? tabIndex - 1 : tabIndex;
                if (value === 'merge') { if (closable(tour, drag)) dispatch({ type: 'merge', id: drag, into: tabItem.id }); else note('처음부터 있던 탭은 튜토리얼에 필요해서 합칠 수 없어요. 새로 만든 탭으로 해 보세요.'); }
                else dispatch({ type: 'move', id: drag, to: value === 'after' ? shift + 1 : shift });
              }
              setDrag(''); setDropAt(null);
            }
          };
          const dropHint = mode === 'merge' && <span className="drop-hint" aria-hidden="true">분할로 합치기</span>;
          if (leaves.length < 2) return <li key={tabItem.id} data-tab={tabItem.id} role="none" className={`${drag === tabItem.id ? 'dragging' : ''} ${mode ? `drop-${mode}` : ''}`} {...dnd}>
            <div role="treeitem" aria-selected={on} tabIndex={0} className={`folder-tab ${on ? 'active' : ''}`} data-agent={agent} data-agent-state={state}
              title={`${tabItem.label}\n끌어서 순서 변경 · 다른 탭 가운데에 놓으면 분할로 합치기`} onClick={select} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') select(); }}>
              <span className="folder-tab-mark" aria-hidden="true"><Icon name={agent || 'terminal'} size={13} /></span><span className="folder-tab-label">{tabItem.label}</span>
              {cache}{alertOf(state)}{close}
            </div>{dropHint}</li>;
          return <li key={tabItem.id} data-tab={tabItem.id} role="none" className={`folder-group ${on ? 'active' : ''} ${drag === tabItem.id ? 'dragging' : ''} ${mode ? `drop-${mode}` : ''}`} {...dnd}>
            <div role="treeitem" aria-selected={on} aria-expanded tabIndex={0} className="group-head" title={`${tabItem.label} · 분할 ${leaves.length}개`} onClick={select} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') select(); }}>
              <span className="folder-tab-mark" aria-hidden="true"><Icon name="layers" size={13} /></span><span className="folder-tab-label">{tabItem.label}</span><small className="group-count">{leaves.length}</small>{close}
            </div>
            <ul className="group-panes" role="group" aria-label={`분할 ${leaves.length}개`}>
              {leaves.map(leaf => { const focus = () => { select(); dispatch({ type: 'pick', id: leaf.id }); }, paneState = leafState(leaf.id), focusedHere = on && tour.focus === leaf.id;
                return <li key={leaf.id} role="treeitem" aria-selected={focusedHere} tabIndex={0} className={`group-pane ${focusedHere ? 'focused' : ''}`} data-agent={tour.agents[leaf.id]} data-agent-state={paneState}
                  onClick={focus} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') focus(); }}>
                  <span className="folder-tab-mark" aria-hidden="true"><Icon name={leaf.kind === 'launcher' ? 'plus' : tour.agents[leaf.id] || 'terminal'} size={13} /></span><span className="folder-tab-label">{tour.labels[leaf.id]}</span>
                  {alertOf(paneState === 'done' && on ? undefined : paneState)}
                  <button className="ptab-close" aria-label={`${tour.labels[leaf.id]} 닫기`} title="이 터미널 닫기" onClick={event => { event.stopPropagation(); if (closable(tour, leaf.id)) dispatch({ type: 'closePane', id: leaf.id }); else note(`이 터미널은${refuse}`); }}><Icon name="x" size={12} /></button>
                </li>; })}
            </ul>{dropHint}
          </li>;
        })}
      </ul>}
    </section>;
  };

  // ---- one workspace per project, as in the app ----
  const git = useMemo<GitState>(() => tour.changes ? { branch: 'main', changes: [{ path: 'src/server.ts', status: ' M', added: 1, deleted: 1 }], additions: 1, deletions: 1 } : { branch: 'main', changes: [], additions: 0, deletions: 0 }, [tour.changes]);
  const loadDiff = useCallback(async () => ({ original: before, modified: tour.changes ? after : before }), [tour.changes]);
  const request = useMemo<QuickRequest>(() => ({
    kind: 'pick', title: '명령 팔레트', items: paletteItems.map(item => ({ id: item.id, label: item.label, keys: item.keys && showKeys(item.keys) })),
    resolve: id => { const item = paletteItems.find(entry => entry.id === id); if (item?.action) dispatch(item.action); else if (item) note('지금 보고 계신 것이 둘러보기예요.'); if (item) dispatch({ type: 'command' }); }
  }), [paletteKey]);
  const usage = (provider: 'claude' | 'codex', session: number, week: number) => <button className="stat usage" title={`${provider === 'claude' ? 'Claude' : 'Codex'} 사용량 (예시)\n클릭: 새로고침`}>
    <Icon name={provider} size={13} />
    {([['5h', session], ['주', week]] as const).map(([key, percent]) => <span key={key} className={`usage-window ${settings.usageColors ? 'graded' : ''}`} style={settings.usageColors ? { '--usage-hue': usageHue(percent) } as CSSProperties : undefined}><small>{key}</small>{percent}%<i style={{ width: `${percent}%` }} /></span>)}
  </button>;
  const workspace = (item: TourProject) => {
    const on = item.id === tour.current, changes = item.id === 'my-app' ? tour.changes : 0, terminals = item.tabs.reduce((sum, t) => sum + leafList(t.pane).filter(leaf => leaf.kind !== 'launcher').length, 0);
    return <main key={item.id} className={`app ${settings.dimInactivePanes ? 'dim-inactive' : ''}`} hidden={!on}>
      <header className="tabbar">
        <div className="split-button">
          <button className="bar-button new-tab" title={`새 터미널 탭 (${showKeys('mod+shift+t')})`} aria-label="새 터미널 탭" onClick={() => dispatch({ type: 'newTab' })}><Icon name="plus" /><span>새 탭</span></button>
          <button className="bar-button caret" title="Claude Code · Codex · Cursor CLI로 새 탭 열기" aria-label="새 탭 종류 선택" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(value => !value)}><Icon name="chevronDown" size={14} /></button>
          {menu && on && <><button className="context-dismiss" aria-label="메뉴 닫기" onClick={() => setMenu(false)} />
            <div className="menu" role="menu">{launchers.map(entry => <button role="menuitem" key={entry.id} onClick={() => { setMenu(false); dispatch({ type: 'launch', target: '', agent: agentOf(entry.command) }); }}><Icon name={entry.icon} size={16} /><span><strong>{entry.label}</strong>{entry.detail && <small>{entry.detail}</small>}</span></button>)}</div></>}
        </div>
        <span className="drag-space" />
        <button className="palette-button" onClick={() => { setPaletteKey(key => key + 1); dispatch({ type: 'palette', open: true }); }} title={`명령 팔레트 (${showKeys('mod+shift+p')})`}><Icon name="search" /><span>{item.name}</span><kbd>{showKeys('mod+shift+p')}</kbd></button>
        <button className={`bar-button ${tour.diff ? 'on' : ''}`} title={`변경사항 Diff (${showKeys('mod+shift+g')})`} aria-label="변경사항 Diff 패널" aria-pressed={tour.diff} onClick={() => dispatch({ type: 'diff' })}>
          <Icon name="diff" />{changes > 0 && <span className="diffstat"><ins>+1</ins><del>−1</del></span>}</button>
        <IconButton icon="settings" label="설정" keys={showKeys('mod+,')} className="bar-icon" onClick={() => dispatch({ type: 'settings', open: true })} />
      </header>
      <div className="workbench">
        <div className="tab-stack">{item.tabs.map(tabItem => {
          const zoomed = on && tabItem.id === item.active && tour.zoom ? findLeaf(tabItem.pane, tour.zoom) : undefined;
          return <div key={tabItem.id} className="tab-page" hidden={tabItem.id !== item.active}>
            {tabItem.pane ? <Tree pane={zoomed ?? tabItem.pane} ctx={ctx} onLayout={next => { if (!zoomed) dispatch({ type: 'layout', tab: tabItem.id, pane: next }); }} />
              : <LaunchPicker shell={settings.terminalShell} title="새 탭" autoFocus={on && tabItem.id === item.active} onLaunch={agent => dispatch({ type: 'launch', target: tabItem.id, agent })} />}
          </div>;
        })}</div>
        {on && tour.diff && <aside className="right-panel" aria-label="오른쪽 패널" style={{ '--review-w': `${settings.reviewWidth}px` } as CSSProperties}>
          <ReviewPanel git={changes ? git : { ...git, changes: [], additions: 0, deletions: 0 }} gitVersion={tour.changes} settings={settings} controls={null} fail={() => {}} refresh={async () => {}} loadDiff={loadDiff}
            openDiffTab={() => note('실제 앱에서는 큰 화면의 diff 탭으로 열립니다.')} switchBranch={() => {}} hasRepository selectionRequired={false} wide={false} toggleWide={() => {}} />
        </aside>}
      </div>
      <footer className="statusbar">
        <div className="status-left">
          <span className="conn ok" title="연결됨"><Icon name="wifi" size={13} /></span>
          <span className="stat" title={item.root}><Icon name="folder" size={13} />{item.root}</span>
          <button title="브랜치 전환" onClick={() => note('실제 앱에서는 여기서 브랜치를 바꿀 수 있습니다.')}><Icon name="branch" size={13} />main</button>
          <button title="변경사항 열기" onClick={() => { if (!tour.diff) dispatch({ type: 'diff' }); }}><Icon name="diff" size={13} />{changes}개 파일<ins>+{changes}</ins><del>−{changes}</del></button>
        </div>
        <div className="status-right">
          <span className="stat" title="실행 중인 터미널"><Icon name="terminal" size={13} />{terminals}</span>
          {usage('claude', 23, 41)}{usage('codex', 8, 17)}
          <span className="stat" title="현재 시각"><Icon name="clock" size={13} />{new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: settings.clock12h })}</span>
          <button title={`프로젝트 열기 (${showKeys('mod+alt+o')})`} aria-label="프로젝트 열기" onClick={() => note('둘러보기를 마치면 내 프로젝트를 열 수 있어요.')}><Icon name="folderPlus" size={14} /></button>
        </div>
      </footer>
      {on && tour.palette && <QuickInput key={paletteKey} request={request} onClose={() => dispatch({ type: 'palette', open: false })} />}
    </main>;
  };

  const skip = leave; // no confirm: the book button replays it any time
  // Feature steps are numbered; the welcome and finish cards stand apart in the middle of the screen.
  const hero = !step.tasks.length, lessons = list.filter(item => item.tasks.length), lesson = lessons.indexOf(step), now = step.tasks.find(task => !tour.done.includes(task.flag));
  return <div className={`tour ${leaving ? 'leaving' : ''} ${phase === 'setup' ? 'setting-up' : ''}`}>
    <div className="shell" inert={phase === 'setup'} style={{ '--rail-w': `${settings.sidebarWidth}px` } as CSSProperties}>
      <nav className="projects" aria-label="프로젝트와 탭">
        <div className="projects-head"><strong>프로젝트</strong><span className="spacer" />
          <IconButton icon="folderPlus" label="프로젝트 열기" keys={showKeys('mod+alt+o')} onClick={() => note('둘러보기를 마치면 내 프로젝트를 열 수 있어요.')} />
          <IconButton icon="chevronsLeft" label="사이드바 접기" keys={showKeys('mod+alt+b')} onClick={() => note('사이드바를 접으면 프로젝트 머리글자만 보여요.')} /></div>
        <div className="folders" role="tree">{tour.projects.map(folder)}</div>
        <div className="projects-foot">
          <IconButton icon="settings" label="설정" keys={showKeys('mod+,')} onClick={() => dispatch({ type: 'settings', open: true })} />
          <span className="spacer" /><AppVersion /><span className="spacer" />
          <IconButton icon="book" label="둘러보기" onClick={() => note('지금 보고 계신 것이 둘러보기예요.')} />
        </div>
      </nav>
      <div className="ws-stack">{tour.projects.map(workspace)}</div>
    </div>
    {phase === 'setup' && !leaving && <><div className="tour-dim" /><Setup settings={settings} onSettings={onSettings} onNext={() => setPhase('tour')} /></>}
    {phase === 'tour' && hero && !leaving && <div className="tour-dim" />}
    {phase === 'tour' && rect && !leaving && <div className="tour-ring" style={{ left: rect.x - 4, top: rect.y - 4, width: rect.w + 8, height: rect.h + 8 }} />}
    {/* Feature steps share one card that glides to the next target; only its contents re-enter. */}
    {phase === 'tour' && !leaving && <section key={hero ? at : 'steps'} ref={coach} popover={tour.settings ? 'manual' : undefined} className={`tour-coach ${hero ? 'hero' : ''} ${rect && !hero ? '' : 'center'}`} role="dialog" aria-labelledby="tour-title" aria-describedby="tour-body">
      {hero ? <Logo size={56} /> : <div className="tour-progress">
        <small>기능 {lesson + 1} / {lessons.length}</small>
        <span aria-hidden="true">{lessons.map((item, index) => <i key={item.id} className={index < lesson || (index === lesson && done) ? 'done' : index === lesson ? 'now' : ''} />)}</span>
      </div>}
      <Fragment key={at}>
      <h2 id="tour-title">{step.title}</h2>
      <p id="tour-body">{step.body}</p>
      {at === 0 && <ul className="tour-features">{features.map(([icon, title, text]) => <li key={title}><span><Icon name={icon} size={18} /></span><div><strong>{title}</strong><small>{text}</small></div></li>)}</ul>}
      {step.keys && <div className="tour-keys">{step.keys.map(([label, keys]) => <span key={label}><kbd>{showKeys(keys)}</kbd>{label}</span>)}</div>}
      {step.tasks.length > 0 && <ul className="tour-tasks" aria-label="해 볼 것">{step.tasks.map((task, index) => { const ok = tour.done.includes(task.flag);
        return <li key={task.flag} className={ok ? 'ok' : task === now ? 'now' : ''} style={{ '--i': index } as CSSProperties}><span className="tour-check">{ok && <Icon name="check" size={13} />}</span><span><strong>{task.label}</strong>{task.hint && <small>{task.hint}</small>}</span></li>; })}</ul>}
      {last && <div className="shortcut-list tour-summary">{summary.map(([label, keys], index) => <div key={label} style={{ '--i': index } as CSSProperties}><span>{label}</span><kbd>{showKeys(keys)}</kbd></div>)}</div>}
      </Fragment>
      {!hero && <p className="tour-feedback" role="status" aria-live="polite"><span key={done ? 'done' : feedback}>{done ? '좋아요! 다음으로 넘어가 볼까요?' : feedback}</span></p>}
      <footer>
        {!last && <button type="button" className="tour-skip" onClick={skip}>건너뛰기</button>}
        <span className="spacer" />
        {at > 1 && <button type="button" onClick={() => setAt(at - 1)}>이전</button>}
        <button ref={next} type="button" className={`primary ${done && !hero ? 'ready' : ''}`} disabled={!done} title={done ? '' : '해 볼 것을 모두 마치면 넘어갈 수 있어요'} onClick={() => last ? leave() : setAt(at + 1)}>
          {last ? '무너에이드 시작하기' : at === 0 ? '둘러보기 시작' : '다음'}<Icon name="arrowRight" size={16} /></button>
      </footer>
    </section>}
    {tour.settings && <SettingsModal settings={settings} onChange={onSettings} onClose={() => dispatch({ type: 'settings', open: false })} />}
  </div>;
}

