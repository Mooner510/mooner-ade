import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { basename, findLeaf, isDiffTab, isLeaf, type Leaf, type Pane } from './api';
import { DiffView, EditorView, monoFont, type Reveal, type Settings } from './Editor';
import { Icon, IconButton } from './Icon';
import { FileIcon } from './FileIcon';
import { ANSI, createBannerDetector, createQuestionTracker } from './terminal-agent';
import type { Agent } from './terminal-agent';
import { claudeComposerText, createClaudeFollowUp, hasEmptyClaudeComposer, claudeFollowUpVersion } from './claude-follow-up';
export type { Agent } from './terminal-agent';

// Terminal-generated reports: focus in/out (CSI I / O) and SGR mouse events.
const REPORT = /^(?:\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[Mm])+$/;
export type AgentEventKind = 'done' | 'attention';
export type TerminalFeed = { data: string; sequence: number; reset?: boolean; exited?: boolean; status?: { agent: Agent; state: 'idle' | 'working' | 'blocked' | 'done' | 'error' } | null };
export type TerminalBus = { buffers: Map<string, TerminalFeed>; listeners: Map<string, (feed: TerminalFeed) => void> };
export type EditorCtx = {
  root: string; docs: { path: string; content: string; saved: string; external?: boolean }[]; settings: Settings; reveal: Record<string, Reveal>; gitVersion: number;
  onChange(path: string, value: string): void; onSave(): void; onCursor(line: number, column: number): void;
  onSelectTab(group: string, path: string): void; onCloseTab(group: string, path: string): void; onPin(group: string, path: string): void;
  onSplitEditor(group: string, direction: 'row' | 'column'): void; onCloseGroup(group: string): void;
  loadDiff(kind: string, path: string): Promise<{ original: string; modified: string }>;
};
type Props = {
  followUpInput(id: string, prompt: string, sequence: number, requestId: string): Promise<boolean>;
  pane: Pane; visible: boolean; onLayout(pane: Pane): void; send(message: object): boolean; bus: TerminalBus; live: Set<string>; cwds: Record<string, string>; titles: Record<string, string>; agentOf(id: string): Agent | undefined; onAgent(id: string, agent: Agent): void; onAgentEvent(id: string, kind: AgentEventKind): void; onAgentResolved(id: string): void; onAgentWorking(id: string, working: boolean): void; ssh: Set<string>; working: Set<string>; attention: Record<string, AgentEventKind>; focus: string; zoom: string;
  onFocus(id: string): void; onZoom(id: string): void; onSplit(id: string, direction: 'row' | 'column'): void; onClose(id: string): void; onTitle(id: string, title: string): void; onSize(id: string, cols: number, rows: number): void; editor: EditorCtx;
};

// xterm colors come from the CSS custom properties so the terminal follows the app theme.
function terminalTheme(element: Element = document.documentElement): ITheme {
  const style = getComputedStyle(element), read = (name: string) => style.getPropertyValue(`--term-${name}`).trim() || undefined;
  return {
    background: read('bg'), foreground: read('fg'), cursor: read('cursor'), cursorAccent: read('bg'), selectionBackground: read('selection'),
    black: read('black'), red: read('red'), green: read('green'), yellow: read('yellow'), blue: read('blue'), magenta: read('magenta'), cyan: read('cyan'), white: read('white'),
    brightBlack: read('bright-black'), brightRed: read('bright-red'), brightGreen: read('bright-green'), brightYellow: read('bright-yellow'),
    brightBlue: read('bright-blue'), brightMagenta: read('bright-magenta'), brightCyan: read('bright-cyan'), brightWhite: read('bright-white')
  };
}

const fontStack = (settings: Settings) => settings.terminalFont.trim() ? `${settings.terminalFont.trim()}, ${monoFont}` : monoFont;

function TerminalPane({ id, send, followUpInput, bus, visible, live, cwds, titles, agentOf, onAgent, onAgentEvent, onAgentResolved, onAgentWorking, ssh: sshSet, working: workingSet, attention, focused, zoomed, onFocus, onZoom, onSplit, onClose, onTitle, onSize, settings }: Pick<Props, 'send' | 'followUpInput' | 'bus' | 'visible' | 'live' | 'cwds' | 'titles' | 'agentOf' | 'onAgent' | 'onAgentEvent' | 'onAgentResolved' | 'onAgentWorking' | 'ssh' | 'working' | 'attention' | 'onFocus' | 'onZoom' | 'onSplit' | 'onClose' | 'onTitle' | 'onSize'> & { id: string; focused: boolean; zoomed: boolean; settings: Settings }) {
  const host = useRef<HTMLDivElement>(null), isSsh = sshSet.has(id), identity = agentOf(id);
  const followUp = useRef(createClaudeFollowUp());
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null), editingRef = useRef(false);
  editingRef.current = editing !== null;
  const [queued, setQueued] = useState(followUp.current.items);
  const flushQueue = useRef<() => void>(() => {});
  const refreshQueue = () => setQueued(followUp.current.items);
  const checkAgent = useRef<() => void>(() => {});
  const visibleRef = useRef(visible), sshRef = useRef(isSsh), replayScroll = useRef(false), scrollAfterReplay = useRef<() => void>(() => {});
  visibleRef.current = visible; sshRef.current = isSsh;
  const term = useRef<Terminal | null>(null), fitRef = useRef<FitAddon | null>(null), webglRef = useRef<WebglAddon | null>(null), centerRef = useRef<() => void>(() => {}), notifyResizeRef = useRef<() => void>(() => {});
  const callbacks = useRef({ send, followUpInput, onSplit, onTitle, onSize, onAgent, agentOf, onAgentEvent, onAgentResolved, onAgentWorking }); callbacks.current = { send, followUpInput, onSplit, onTitle, onSize, onAgent, agentOf, onAgentEvent, onAgentResolved, onAgentWorking };
  const settingsRef = useRef(settings); settingsRef.current = settings;
  useEffect(() => {
    const terminal = new Terminal({ fontSize: settings.terminalFontSize, fontFamily: fontStack(settings), lineHeight: settings.lineHeight, cursorBlink: settings.cursorBlink, cursorStyle: settings.cursorStyle, scrollback: settings.scrollback, allowProposedApi: true,
      // The server runs ConPTY (bundled conpty.dll, which reflows on its own). Telling xterm keeps its wrapped-line handling in step with
      // ConPTY's; without it, old output is mangled when the pane resizes or a long answer scrolls past the top.
      ...(/Windows/.test(navigator.userAgent) ? { windowsPty: { backend: 'conpty' as const, buildNumber: 26100 } } : {}), theme: terminalTheme(host.current!) });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current!); term.current = terminal; fitRef.current = fit;
    // Unicode 11 widths match what shells/TUIs assume for Hangul and emoji; the default (v6) table disagrees and leaves stale half-cells.
    terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
    // A clipboard image is saved by the server and its file path is typed instead, which Claude Code and Codex accept as an attachment.
    const pasteImage = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.items ?? []).find(item => item.kind === 'file' && /^image\/(png|jpeg|gif|webp)$/.test(item.type))?.getAsFile();
      if (!file) return;
      event.preventDefault(); event.stopPropagation();
      void file.arrayBuffer().then(buffer => {
        const bytes = new Uint8Array(buffer); let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        callbacks.current.send({ type: 'terminal/paste-image', id, mime: file.type, data: btoa(binary) });
      });
    };
    const pasteHost = host.current!; pasteHost.addEventListener('paste', pasteImage, true);
    terminal.onSelectionChange(() => { if (settingsRef.current.copyOnSelect && terminal.hasSelection()) void navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {}); });
    const detectBanner = createBannerDetector(), question = createQuestionTracker();
    let sequence = 0, replays = 0, pendingResize = false, refreshAfterReplay = false, working = false, asking = false, title = '';
    let status: TerminalFeed['status'], reportedState: string | undefined;
    let bannerTail = '', followUpSupported = false, sendingFollowUp = false, writes = 0;
    const queueId = crypto.randomUUID();
    const screenText = () => {
      const buffer = terminal.buffer.active;
      return Array.from({ length: terminal.rows }, (_, row) => {
        const line = buffer.getLine(buffer.baseY + row);
        return (line?.isWrapped ? '' : '\n') + (line?.translateToString(true) || '');
      }).join('');
    };
    flushQueue.current = () => {
      if (sendingFollowUp) return;
      const screen = screenText();
      const next = followUp.current.next((followUpSupported || status?.agent === 'claude') && !sshRef.current && !replays && !writes && callbacks.current.agentOf(id) === 'claude' && !editingRef.current
        && !question.observe(screen, title) && hasEmptyClaudeComposer(screen));
      if (next) {
        sendingFollowUp = true;
        void callbacks.current.followUpInput(id, next.text, sequence, `${queueId}:${next.id}`).then(accepted => {
          if (accepted) followUp.current.sent(next.id); // otherwise the next flush retries
        }).catch(() => {}).finally(() => { sendingFollowUp = false; refreshQueue(); });
      }
    };
    const progress = terminal.parser.registerOscHandler(9, value => {
      if (followUpSupported && !sshRef.current && !replays && callbacks.current.agentOf(id) === 'claude') { followUp.current.progress(value); refreshQueue(); }
      return false;
    });
    const notifyResize = () => {
      if (replays) { pendingResize = true; return; }
      pendingResize = false;
      if (refreshAfterReplay) {
        refreshAfterReplay = false;
        callbacks.current.send({ type: 'terminal/resize', id, cols: terminal.cols, rows: terminal.rows === 1000 ? 999 : terminal.rows + 1 });
      }
      callbacks.current.send({ type: 'terminal/resize', id, cols: terminal.cols, rows: terminal.rows });
      callbacks.current.onSize(id, terminal.cols, terminal.rows);
    };
    notifyResizeRef.current = notifyResize;
    let scrollFrame = 0;
    scrollAfterReplay.current = () => {
      cancelAnimationFrame(scrollFrame);
      if (!replayScroll.current || replays || writes || !visibleRef.current || !host.current?.clientWidth || !host.current.clientHeight) return;
      terminal.scrollToBottom();
      // xterm builds the scroll area asynchronously; finish only when its viewport has caught up.
      scrollFrame = requestAnimationFrame(() => {
        if (term.current !== terminal || !visibleRef.current || replays || writes) return;
        const viewport = terminal.element?.querySelector<HTMLElement>('.xterm-viewport'), buffer = terminal.buffer.active;
        if (viewport && viewport.clientHeight > 0 && (buffer.baseY === 0 || viewport.scrollHeight > viewport.clientHeight)
          && buffer.viewportY === buffer.baseY && Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 1) replayScroll.current = false;
        else scrollAfterReplay.current();
      });
    };
    // Turn state comes from the CLI's OSC 7501 reports, retained by the server across browser reconnects.
    const watchAgent = (replay = false) => {
      if (!callbacks.current.agentOf(id)) {
        if (working) callbacks.current.onAgentWorking(id, false);
        if (asking) callbacks.current.onAgentResolved(id);
        asking = false; question.reset(); working = false; reportedState = undefined;
        followUp.current.reset(); refreshQueue(); return;
      }
      const screen = screenText();
      const pending = status ? status.state === 'blocked' : question.observe(screen, title);
      if (pending !== asking) {
        asking = pending;
        if (asking) callbacks.current.onAgentEvent(id, 'attention');
        else callbacks.current.onAgentResolved(id);
      }
      if (asking) {
        if (working) callbacks.current.onAgentWorking(id, false);
        working = false; reportedState = status?.state; return;
      }
      const next = status?.state === 'working';
      if (status?.agent === 'claude' && !sshRef.current && callbacks.current.agentOf(id) === 'claude') { followUp.current.turn(next); refreshQueue(); flushQueue.current(); }
      if (next !== working) { working = next; callbacks.current.onAgentWorking(id, working); }
      if (status?.state !== reportedState) {
        reportedState = status?.state;
        if (working) callbacks.current.onAgentResolved(id);
        else if (!replay && (reportedState === 'done' || reportedState === 'error')) callbacks.current.onAgentEvent(id, 'done');
      }
    };
    checkAgent.current = () => { watchAgent(true); if (sshRef.current || callbacks.current.agentOf(id) !== 'claude') { followUp.current.reset(); refreshQueue(); } };
    const receive = (feed: TerminalFeed) => {
      const replay = Boolean(feed.reset);
      if ('status' in feed) status = feed.status;
      if (feed.reset) { if (working) callbacks.current.onAgentWorking(id, false); working = false; reportedState = undefined; followUp.current.reset(); refreshQueue(); terminal.reset(); sequence = 0; refreshAfterReplay = true; replayScroll.current = true; }
      if (feed.sequence > sequence || feed.reset) {
        const raw = (feed.reset ? '' : bannerTail) + feed.data;
        followUpSupported = claudeFollowUpVersion(raw.replace(ANSI, '')) ?? (feed.reset ? false : followUpSupported);
        bannerTail = raw.slice(-256);
        if (replay) replays++;
        sequence = feed.sequence;
        writes++;
        terminal.write(feed.data, () => {
          writes--;
          if (replay && !--replays) {
            if (pendingResize || refreshAfterReplay) notifyResize();
          }
          if (!writes && replayScroll.current) scrollAfterReplay.current();
          watchAgent(replay);
          if (!replay) flushQueue.current();
        });
        const agent = detectBanner(feed.data, replay); if (agent) callbacks.current.onAgent(id, agent);
      } else if ('status' in feed) watchAgent(true);
      if (feed.exited) { followUp.current.reset(); refreshQueue(); terminal.write('\r\n\x1b[2m[프로세스 종료]\x1b[0m\r\n'); }
    };
    bus.listeners.set(id, receive);
    terminal.onData(data => {
      // Esc/Ctrl+C interrupt the turn; the queue keeps going once the CLI reports it idle (4;0).
      if (data === '\r') followUp.current.submitted();
      // Focus-in/out and mouse reports are sent by xterm on its own when a TUI (Claude Code) asks for them, e.g. merely focusing the pane.
      // Typing and reports do not change the agent's turn state.
      if (!REPORT.test(data)) question.input(data);
      callbacks.current.send({ type: 'terminal/input', id, data });
    });
    terminal.onTitleChange(value => {
      title = value; callbacks.current.onTitle(id, title);
    });
    terminal.attachCustomKeyEventHandler(event => {
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'KeyD') {
        if (event.type === 'keydown') { event.preventDefault(); callbacks.current.onSplit(id, event.shiftKey ? 'column' : 'row'); }
        return false;
      }
      if (event.type !== 'keydown' || event.altKey || event.metaKey) return true;
      // Tab in Claude's composer is only for autocomplete (last word starts with / or @) and for queueing a follow-up while a turn runs.
      // Everything else is swallowed: Claude would otherwise toggle thinking or accept a suggestion, which nobody asked for.
      if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.isComposing && !sshRef.current && callbacks.current.agentOf(id) === 'claude' && !asking) {
        const typed = claudeComposerText(screenText()), text = typed && !/^Try "/.test(typed) ? typed : undefined; // an empty composer shows a `Try "…"` hint
        if (text && /(?:^|\s)[/@]\S*$/.test(text)) return true;
        event.preventDefault();
        if (text && followUp.current.working && !/\[(?:Pasted text|Image|\.\.\.Truncated)/.test(text) && followUp.current.enqueue(text)) {
          callbacks.current.send({ type: 'terminal/input', id, data: '\x05' + '\x7f'.repeat(text.length + 8) });
          refreshQueue();
        }
        return false;
      }
      // xterm sends a bare CR for Shift+Enter; ESC+CR is the "newline without submit" sequence TUIs (Claude Code etc.) understand.
      if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey) {
        event.preventDefault(); callbacks.current.send({ type: 'terminal/input', id, data: '\x1b\r' }); return false;
      }
      // Ctrl+C copies only while text is selected (otherwise it stays SIGINT); Ctrl+Shift+C always copies.
      if (event.ctrlKey && event.code === 'KeyC' && (event.shiftKey || terminal.hasSelection())) {
        event.preventDefault();
        if (terminal.hasSelection()) { void navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {}); terminal.clearSelection(); }
        return false;
      }
      // Leave Ctrl+V to the browser's paste event: xterm pastes text from it (bracketed paste, newline normalisation, no ^V to the shell)
      // and the capture listener below intercepts images, which a terminal cannot paste.
      if (event.ctrlKey && event.code === 'KeyV') return false;
      return true;
    });
    // FitAddon rounds the column count down, so up to one cell of width is left over on the right; split it between both sides.
    const center = () => {
      const element = terminal.element, screen = element?.querySelector<HTMLElement>('.xterm-screen'), viewport = element?.querySelector<HTMLElement>('.xterm-viewport'), box = host.current;
      if (!element || !screen || !viewport || !box) return;
      const style = getComputedStyle(box), spare = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - (viewport.offsetWidth - viewport.clientWidth) - screen.offsetWidth;
      // The renderer sizes .xterm-screen asynchronously, so right after a reload/theme/font change it can still be stale and `spare` huge;
      // genuine leftover is always under one cell, anything larger is a stale measurement and must not shift the terminal.
      const cell = terminal.cols > 0 ? screen.offsetWidth / terminal.cols : 0;
      const shift = cell > 0 && spare >= 0 && spare < cell * 1.5 ? Math.floor(spare / 2) : 0;
      element.style.marginLeft = `${shift}px`; element.style.marginRight = `${-shift}px`;
    };
    centerRef.current = center;
    const resize = () => { if (!host.current?.clientWidth || !host.current.clientHeight) return; fit.fit(); center(); requestAnimationFrame(center); notifyResize(); if (replayScroll.current) scrollAfterReplay.current(); };
    const observer = new ResizeObserver(resize); observer.observe(host.current!); resize();
    const initial = bus.buffers.get(id); if (initial) receive({ ...initial, reset: true });
    return () => { checkAgent.current = () => {}; flushQueue.current = () => {}; scrollAfterReplay.current = () => {}; cancelAnimationFrame(scrollFrame); progress.dispose(); pasteHost.removeEventListener('paste', pasteImage, true); observer.disconnect(); bus.listeners.delete(id); webglRef.current = null; terminal.dispose(); term.current = null; fitRef.current = null; };
  }, [id, bus]);
  useEffect(() => { if (visible && replayScroll.current) { fitRef.current?.fit(); scrollAfterReplay.current(); } }, [visible]);
  useEffect(() => {
    // Hidden workspaces still mount terminals, so reserve WebGL contexts for visible panes.
    const terminal = term.current;
    if (!visible || !terminal) return;
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => { if (webglRef.current === gl) webglRef.current = null; gl.dispose(); });
      terminal.loadAddon(gl); webglRef.current = gl;
      return () => { if (webglRef.current === gl) webglRef.current = null; gl.dispose(); };
    } catch { /* no WebGL: keep the DOM renderer */ }
  }, [visible]);
  useEffect(() => { checkAgent.current(); }, [identity, isSsh]);
  useEffect(() => {
    // Next frame: the App effect that switches `data-theme` runs after this child effect.
    const frame = requestAnimationFrame(() => {
      const terminal = term.current; if (!terminal) return;
      terminal.options.theme = terminalTheme(host.current ?? undefined); terminal.options.fontSize = settings.terminalFontSize; terminal.options.fontFamily = fontStack(settings);
      terminal.options.lineHeight = settings.lineHeight; terminal.options.cursorBlink = settings.cursorBlink; terminal.options.cursorStyle = settings.cursorStyle; terminal.options.scrollback = settings.scrollback;
      if (!host.current?.clientWidth) return;
      fitRef.current?.fit(); centerRef.current(); requestAnimationFrame(() => centerRef.current()); notifyResizeRef.current();
    });
    return () => cancelAnimationFrame(frame);
  }, [settings.theme, isSsh, settings.terminalFontSize, settings.terminalFont, settings.lineHeight, settings.cursorBlink, settings.cursorStyle, settings.scrollback]);
  useEffect(() => { if (focused) term.current?.focus(); }, [focused]);
  const label = titles[id] || (cwds[id] ? basename(cwds[id]) : id.slice(0, 6));
  const exited = cwds[id] !== undefined && !live.has(id);
  const agent = exited ? undefined : agentOf(id), agentState = !agent ? undefined : attention[id] ?? (workingSet.has(id) ? 'working' : 'idle');
  return <section className={`terminal-pane ${focused ? 'focused' : ''} ${exited ? 'exited' : ''}`} data-ssh={isSsh ? '' : undefined} data-agent={agent} data-agent-state={agentState} onMouseDownCapture={() => onFocus(id)} onFocus={() => onFocus(id)}>
    <div className="pane-tools" role="toolbar" aria-label="터미널 pane">
      <span className="pane-title" title={cwds[id]}><span className="pane-mark"><Icon name={agent || 'terminal'} size={12} /></span><span className="pane-label">{label}</span>{agentState === 'attention' && <span className="question-alert" role="img" aria-label="응답 필요" title="질문 또는 승인을 처리해 주세요"><Icon name="alert" size={15} /></span>}</span>
      <span className="pane-actions">
        <IconButton icon="splitH" label="좌우 분할" keys="Ctrl+D" onClick={() => onSplit(id, 'row')} /><IconButton icon="splitV" label="상하 분할" keys="Ctrl+Shift+D" onClick={() => onSplit(id, 'column')} />
        <IconButton icon={zoomed ? 'minimize' : 'maximize'} label={zoomed ? '원래 크기로' : '최대화'} keys="Ctrl+Shift+Enter" onClick={() => onZoom(id)} />
        <IconButton icon="x" label="터미널 종료" onClick={() => onClose(id)} /></span></div>
    <div ref={host} className="xterm-host" />
    {queued.length > 0 && <div className="claude-follow-up">
      <div className="follow-up-heading" role="status">Follow-up {queued.length}개 · 현재 작업 완료 후 순서대로 전송</div>
      <ol>{queued.map(item => editing?.id === item.id
        ? <li key={item.id}><textarea autoFocus rows={2} aria-label="Follow-up 수정" value={editing.text} onChange={event => setEditing({ id: item.id, text: event.target.value })}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (followUp.current.edit(item.id, editing.text)) { setEditing(null); refreshQueue(); flushQueue.current(); } }
            else if (event.key === 'Escape') { event.preventDefault(); setEditing(null); flushQueue.current(); }
          }} />
          <IconButton icon="check" label="수정 저장 (Enter)" onClick={() => { if (followUp.current.edit(item.id, editing.text)) { setEditing(null); refreshQueue(); flushQueue.current(); } }} />
          <IconButton icon="x" label="수정 취소 (Esc)" onClick={() => { setEditing(null); flushQueue.current(); }} /></li>
        : <li key={item.id}><span>{item.text}</span>
          <IconButton icon="edit" label={`Follow-up 수정: ${item.text}`} onClick={() => setEditing({ id: item.id, text: item.text })} />
          <IconButton icon="x" label={`Follow-up 취소: ${item.text}`} onClick={() => { followUp.current.remove(item.id); if (editing?.id === item.id) setEditing(null); refreshQueue(); }} /></li>)}</ol>
    </div>}
    {exited && <div className="pane-exited">프로세스가 종료되었습니다 <button onClick={() => onClose(id)}>pane 닫기</button></div>}
  </section>;
}

function DiffTab({ spec, ctx }: { spec: string; ctx: EditorCtx }) {
  const [, kind, ...rest] = spec.split(':'), path = rest.join(':');
  const [value, setValue] = useState<{ original: string; modified: string } | null>(null), [error, setError] = useState('');
  useEffect(() => { ctx.loadDiff(kind, path).then(setValue, cause => setError(String(cause.message || cause))); }, [kind, path, ctx.gitVersion]);
  if (error) return <div className="empty">{error}</div>;
  return value ? <DiffView original={value.original} modified={value.modified} path={path} settings={ctx.settings} /> : <div className="empty">불러오는 중…</div>;
}

function EditorGroup({ leaf, focused, zoomed, ctx, onFocus, onZoom }: { leaf: Leaf; focused: boolean; zoomed: boolean; ctx: EditorCtx; onFocus(id: string): void; onZoom(id: string): void }) {
  const tabs = leaf.tabs || [], active = leaf.active && tabs.includes(leaf.active) ? leaf.active : tabs[0] || '';
  const doc = ctx.docs.find(item => item.path === active);
  const label = (path: string) => isDiffTab(path) ? `${basename(path.split(':').slice(2).join(':'))} (${path.split(':')[1] === 'staged' ? '스테이지됨' : '변경'})` : basename(path);
  return <section className={`editor-group ${focused ? 'focused' : ''}`} onMouseDownCapture={() => onFocus(leaf.id)}>
    <header className="tab-strip"><div className="tabs" role="tablist">{tabs.map(path => {
      const dirty = ctx.docs.some(item => item.path === path && item.content !== item.saved);
      return <div key={path} role="tab" aria-selected={path === active} title={path} className={`tab ${path === active ? 'active' : ''} ${leaf.preview === path ? 'preview' : ''} ${dirty ? 'dirty' : ''}`}
        onClick={() => ctx.onSelectTab(leaf.id, path)} onDoubleClick={() => ctx.onPin(leaf.id, path)} onAuxClick={event => { if (event.button === 1) ctx.onCloseTab(leaf.id, path); }}>
        {isDiffTab(path) ? <Icon name="diff" size={13} /> : <FileIcon name={basename(path)} size={14} />}<span>{label(path)}</span><button aria-label={`${path} 닫기`} title="닫기" onClick={event => { event.stopPropagation(); ctx.onCloseTab(leaf.id, path); }}><Icon name="x" size={13} /></button></div>;
    })}</div>
      <div className="group-actions"><IconButton icon={zoomed ? 'minimize' : 'maximize'} label={zoomed ? '원래 크기로' : '최대화'} onClick={() => onZoom(leaf.id)} /><IconButton icon="x" label="Diff 패널 닫기" onClick={() => ctx.onCloseGroup(leaf.id)} /></div></header>
    {active && isDiffTab(active) ? <DiffTab key={active} spec={active} ctx={ctx} />
      : doc ? <EditorView group={leaf.id} root={ctx.root} path={doc.path} value={doc.content} settings={ctx.settings} onChange={ctx.onChange} onSave={ctx.onSave} onCursor={ctx.onCursor} onFocus={() => onFocus(leaf.id)} reveal={ctx.reveal[leaf.id]} />
      : <div className="empty"><h2>열린 diff가 없습니다</h2><p>오른쪽 변경사항 패널에서 파일을 선택하세요.</p></div>}
  </section>;
}

// `keys` keeps a child mounted when siblings appear or disappear (terminals must not be recreated).
export function Splitter({ direction, sizes, onSizes, children, keys, equalOnClick }: { direction: 'row' | 'column'; sizes: number[]; onSizes(sizes: number[]): void; children: ReactNode[]; keys?: string[]; equalOnClick?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  function adjust(index: number, delta: number) {
    const sum = sizes[index] + sizes[index + 1], next = [...sizes];
    next[index] = Math.max(sum * .1, Math.min(sum * .9, next[index] + delta)); next[index + 1] = sum - next[index]; onSizes(next);
  }
  return <div className={`split ${direction}`} ref={host}>{children.map((child, index) => <div className="split-slot" key={keys?.[index] ?? index} style={{ flex: sizes[index] || 1 }}>
    {child}{index < children.length - 1 && <div className="divider" role="separator" tabIndex={0} aria-label="패널 크기" aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'} aria-valuenow={Math.round(sizes[index] * 100 / sizes.reduce((a, b) => a + b, 0))}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); adjust(index, sizes.reduce((a, b) => a + b, 0) * (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -.03 : .03)); } }}
      onPointerDown={event => {
        event.preventDefault(); const divider = event.currentTarget; divider.setPointerCapture(event.pointerId);
        const start = direction === 'row' ? event.clientX : event.clientY;
        const extent = direction === 'row' ? host.current!.clientWidth : host.current!.clientHeight;
        let moved = false;
        const move = (e: PointerEvent) => {
          const offset = (direction === 'row' ? e.clientX : e.clientY) - start;
          if (!moved && Math.abs(offset) < 3) return;
          moved = true; adjust(index, offset / extent * sizes.reduce((a, b) => a + b, 0));
        };
        // A click without dragging resets every panel of this split to the same size.
        const up = (e: PointerEvent) => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', up); divider.removeEventListener('pointercancel', up); if (equalOnClick && !moved && e.type === 'pointerup') onSizes(sizes.map(() => 1)); };
        divider.addEventListener('pointermove', move); divider.addEventListener('pointerup', up); divider.addEventListener('pointercancel', up);
      }} />}
  </div>)}</div>;
}

export function Panes(props: Props) {
  const { pane, zoom } = props;
  const zoomed = zoom ? findLeaf(pane, zoom) : undefined;
  if (zoomed) return <Tree {...props} pane={zoomed} zoom={zoom} />;
  return <Tree {...props} />;
}
function Tree(props: Props) {
  const { pane } = props;
  if (isLeaf(pane)) return pane.kind === 'editor'
    ? <EditorGroup leaf={pane} focused={props.focus === pane.id} zoomed={props.zoom === pane.id} ctx={props.editor} onFocus={props.onFocus} onZoom={props.onZoom} />
    : <TerminalPane {...props} id={pane.id} focused={props.focus === pane.id} zoomed={props.zoom === pane.id} settings={props.editor.settings} />;
  return <Splitter equalOnClick direction={pane.direction} sizes={pane.sizes} onSizes={sizes => props.onLayout({ ...pane, sizes })}>
    {pane.children.map((child, index) => <Tree key={isLeaf(child) ? child.id : index} {...props} pane={child} onLayout={next => props.onLayout({ ...pane, children: pane.children.map((old, i) => i === index ? next : old) })} />)}
  </Splitter>;
}
