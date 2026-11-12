import { showAppKey } from './shortcuts';
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { basename, findLeaf, isLeaf, type Leaf, type Pane } from './api';
import { useHiddenAgents } from './installed-agents';
import { pickGreeting } from './chat-model';
import { DiffView, terminalFontStack, type Settings } from './Editor';
import { Icon, IconButton, type IconName } from './Icon';
import { CacheTimer, type ClaudeCache } from './CacheTimer';
import { ChatPane, type ChatCtx } from './ChatPane';
import { copyText, toastPasted, toastAttached, setToastAnchor, claimTip } from './toast';
import { playSound } from './sound';
import { contextTip, queueTip, splitTip } from './tips';
import { useShells, shellLabel } from './shells';
import { LauncherModes } from './LauncherMenu';
import { launchersFor, type AgentMode } from './launchers';
import { ANSI, createBannerDetector, createQuestionTracker, stableTitle } from './terminal-agent';
import type { Agent } from './terminal-agent';
import { claudeComposerText, createClaudeFollowUp, hasEmptyClaudeComposer, claudeFollowUpVersion } from './claude-follow-up';
import { cacheSendWarning, cacheSendWarningText, isClaudeMessageText, type CacheSendWarning } from './claude-cache-warning';
import { createPrefixGuide, guideActive, guideGroups, isModifierOnly, isPrefixKey, looksLikeTmux, normalizePrefix, type ScreenRow } from './tmux-guide';
export type { Agent } from './terminal-agent';

// The tmux key table, shown over the pane from the prefix key until the next key. It never takes pointer input and sits on the half of the
// pane away from the cursor, so what is being typed stays visible; the terminal itself is not resized.
function TmuxGuide({ prefix, place }: { prefix: string; place: 'top' | 'bottom' }) {
  const key = `Ctrl+${normalizePrefix(prefix).toUpperCase()}`;
  return <aside className={`tmux-guide ${place}`} role="note" aria-label="tmux 단축키 안내">
    <header><strong>tmux</strong><span><kbd>{key}</kbd> 다음에 누를 키</span><small>아무 키나 누르면 닫힙니다</small></header>
    <div className="tmux-guide-groups">{guideGroups.map(group => <section key={group.title}>
      <h4>{group.title}</h4>
      <dl>{group.items.map(item => <div key={item.keys}><dt><kbd>{item.keys}</kbd></dt><dd>{item.label}</dd></div>)}</dl>
    </section>)}</div>
  </aside>;
}

// First and last screen row as the tmux detector wants them. "Filled" = nearly every cell has one and the same non-default background.
function screenRows(terminal: Terminal): ScreenRow[] {
  const buffer = terminal.buffer.active, cell = buffer.getNullCell();
  return [buffer.baseY + terminal.rows - 1, buffer.baseY].flatMap(y => {
    const line = buffer.getLine(y); if (!line) return [];
    const seen = new Map<number, number>();
    for (let x = 0; x < terminal.cols; x++) {
      const current = line.getCell(x, cell); if (!current || current.isBgDefault()) continue;
      const color = current.getBgColorMode() * 0x1000000 + current.getBgColor();
      seen.set(color, (seen.get(color) ?? 0) + 1);
    }
    return [{ text: line.translateToString(true), filled: Math.max(0, ...seen.values()) >= terminal.cols * 0.9 }];
  });
}

// Terminal-generated reports: focus in/out (CSI I / O) and SGR mouse events.
const REPORT = /^(?:\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[Mm])+$/;
// xterm's answers to terminal queries (device attributes, cursor position, status, modes, OSC/DCS reports). Replayed
// output still holds the queries the shell made long ago, so answers produced while replaying would land as typed text.
const QUERY_REPLY = /^(?:\x1b\[[?>=]?[\d;]*(?:c|R|n|\$y|t)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;
// Chromium drops the oldest WebGL context past ~16 per page, and every busy agent pane redrawing through its own context loads the
// GPU process until it crashes and blanks every pane. So only a few visible panes render through WebGL (the rest use the DOM
// renderer), a freed slot goes to a waiting pane, and after repeated context losses WebGL stays off for the session.
const WEBGL_LIMIT = 6, WEBGL_LOSSES = 3, WEBGL_LOSS_WINDOW = 60_000;
const webgl = { active: 0, losses: [] as number[], disabled: false, waiting: new Set<() => void>(), idle: new Set<(handOff?: boolean) => void>() };
function webglLost() {
  const now = Date.now();
  webgl.losses = [...webgl.losses.filter(time => now - time < WEBGL_LOSS_WINDOW), now];
  if (webgl.losses.length >= WEBGL_LOSSES) { webgl.disabled = true; webgl.waiting.clear(); }
}
export type AgentEventKind = 'done' | 'attention';
export type TerminalFeed = { data: string; sequence: number; reset?: boolean; exited?: boolean; status?: { agent: Agent; state: 'idle' | 'working' | 'blocked' | 'done' | 'error'; source?: 'progress' | 'session' } | null };
// A status from OSC 7501 itself, rather than the OSC 9;4 progress fallback. Only 7501 reports questions (`blocked`); with progress they still
// come from the screen, and progress alone does not vouch for the follow-up queue's Claude version check.
const fromProgramStatus = (status: TerminalFeed['status']) => Boolean(status) && !status!.source;
// The PTY's real size from the server (`terminal/size`). One PTY can be shown on several devices; its size follows the one that typed
// last, and every device draws at that size instead of its own so nothing wraps wrongly.
export type TerminalSize = { cols: number; rows: number };
export type TerminalBus = { buffers: Map<string, TerminalFeed>; listeners: Map<string, (feed: TerminalFeed) => void>; sizes: Map<string, TerminalSize>; sizeListeners: Map<string, (size: TerminalSize) => void> };
export type EditorCtx = {
  settings: Settings; gitVersion: number;
  onSelectTab(group: string, path: string): void; onCloseTab(group: string, path: string): void; onCloseGroup(group: string): void;
  loadDiff(kind: string, path: string): Promise<{ original: string; modified: string }>;
};
export { CacheTimer, type ClaudeCache };
type Props = {
  followUpInput(id: string, prompt: string, sequence: number, requestId: string): Promise<boolean>;
  // Asks whether to send anyway while the prompt cache is cold or about to be; resolves false unless the user accepts.
  confirmSend(message: string): Promise<boolean>;
  pane: Pane; visible: boolean; onLayout(pane: Pane): void; send(message: object): boolean; bus: TerminalBus; live: Set<string>; cwds: Record<string, string>; titles: Record<string, string>; agentOf(id: string): Agent | undefined; onAgent(id: string, agent: Agent): void; onAgentEvent(id: string, kind: AgentEventKind): void; onAgentResolved(id: string): void; onAgentWorking(id: string, working: boolean): void; ssh: Set<string>; working: Set<string>; attention: Record<string, AgentEventKind>; caches: Record<string, ClaudeCache>; focus: string; zoom: string;
  onFocus(id: string): void; onZoom(id: string): void; onSplit(id: string, direction: 'row' | 'column'): void; onClose(id: string): void; onTitle(id: string, title: string): void; onSize(id: string, cols: number, rows: number): void; onLaunch(id: string, command: string): void; onToChat(id: string): void; onModeChange(mode: AgentMode): void; editor: EditorCtx; chat: ChatCtx;
};

export { launchers } from './launchers';
export const CHAT_COMMAND = 'ade:chat:claude';
export const chatAgent = (command: string): Agent | undefined => ({ 'ade:chat:claude': 'claude', 'ade:chat:codex': 'codex', 'ade:chat:cursor': 'cursor' } as Record<string, Agent>)[command];
// The centered picker shown by an empty tab and by a fresh split; the shell button takes focus so Enter opens a plain terminal.
export function Launchers({ title, onLaunch, autoFocus, hidden = [], mode, shell, onModeChange }: { onModeChange(mode: AgentMode): void; shell: string; mode: AgentMode; title?: string; onLaunch(command: string): void; autoFocus?: boolean; hidden?: string[] }) {
  const hide = useHiddenAgents(hidden), shells = useShells(), greeting = useMemo(() => pickGreeting(), []);
  return <div className="empty-tab" data-mode={mode}>
    <div className="launcher-heading"><LauncherModes mode={mode} onChange={onModeChange} /><h2>{greeting}</h2></div>
    <div className="launchers">{launchersFor(mode, shellLabel(shells, shell)).filter(item => !hide.includes(item.id)).map((item, index) =>
      <button key={item.id} autoFocus={autoFocus && index === 0} onClick={() => onLaunch(item.command)}>
        <span className="launcher-icon"><Icon name={item.icon} size={24} /></span><span className="launcher-copy"><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>
        <span className="launcher-arrow" aria-hidden="true"><Icon name="arrowRight" size={16} /></span>
      </button>)}</div>
  </div>;
}
function LauncherPane({ id, focused, onFocus, onClose, onLaunch, hidden, mode, shell, onModeChange }: { onModeChange(mode: AgentMode): void; shell: string; mode: AgentMode; id: string; focused: boolean; hidden: string[]; onFocus(id: string): void; onClose(id: string): void; onLaunch(id: string, command: string): void }) {
  return <section className={`terminal-pane launcher-pane ${focused ? 'focused' : ''}`} onMouseDownCapture={() => onFocus(id)} onFocus={() => onFocus(id)}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(id); } }}>
    <div className="pane-tools" role="toolbar" aria-label="새 창">
      <span className="pane-title"><span className="pane-mark"><Icon name="plus" size={12} /></span><span className="pane-label">새 창</span></span>
      <span className="pane-actions"><IconButton icon="x" label="pane 닫기" onClick={() => onClose(id)} /></span></div>
    <Launchers onModeChange={onModeChange} shell={shell} mode={mode} autoFocus hidden={hidden} onLaunch={command => onLaunch(id, command)} />
  </section>;
}

// xterm colors come from the CSS custom properties so the terminal follows the app theme.
export function terminalTheme(element: Element = document.documentElement): ITheme {
  const style = getComputedStyle(element), read = (name: string) => style.getPropertyValue(`--term-${name}`).trim() || undefined;
  return {
    background: read('bg'), foreground: read('fg'), cursor: read('cursor'), cursorAccent: read('bg'), selectionBackground: read('selection'),
    black: read('black'), red: read('red'), green: read('green'), yellow: read('yellow'), blue: read('blue'), magenta: read('magenta'), cyan: read('cyan'), white: read('white'),
    brightBlack: read('bright-black'), brightRed: read('bright-red'), brightGreen: read('bright-green'), brightYellow: read('bright-yellow'),
    brightBlue: read('bright-blue'), brightMagenta: read('bright-magenta'), brightCyan: read('bright-cyan'), brightWhite: read('bright-white')
  };
}

// Options that xterm reads live; applied at creation and again whenever a setting changes.
export const xtermOptions = (settings: Settings) => ({
  fontSize: settings.terminalFontSize, fontFamily: fontStack(settings), fontWeight: settings.terminalFontWeight, lineHeight: settings.lineHeight, letterSpacing: settings.letterSpacing,
  cursorBlink: settings.cursorBlink, cursorStyle: settings.cursorStyle, scrollback: settings.scrollback, scrollSensitivity: settings.scrollSensitivity,
  minimumContrastRatio: settings.minimumContrast, wordSeparator: settings.wordSeparator, drawBoldTextInBrightColors: settings.boldBright, macOptionIsMeta: settings.optionAsMeta
});
const fontStack = (settings: Settings) => terminalFontStack(settings.terminalFont);

function TerminalPane({ id, send, followUpInput, confirmSend, bus, visible, live, cwds, titles, agentOf, onAgent, onAgentEvent, onAgentResolved, onAgentWorking, ssh: sshSet, working: workingSet, attention, caches, focused, zoomed, onFocus, onZoom, onSplit, onClose, onToChat, onTitle, onSize, settings }: Pick<Props, 'send' | 'followUpInput' | 'confirmSend' | 'bus' | 'visible' | 'live' | 'cwds' | 'titles' | 'agentOf' | 'onAgent' | 'onAgentEvent' | 'onAgentResolved' | 'onAgentWorking' | 'ssh' | 'working' | 'attention' | 'caches' | 'onFocus' | 'onZoom' | 'onSplit' | 'onClose' | 'onToChat' | 'onTitle' | 'onSize'> & { id: string; focused: boolean; zoomed: boolean; settings: Settings }) {
  const host = useRef<HTMLDivElement>(null), isSsh = sshSet.has(id), identity = agentOf(id);
  const followUp = useRef(createClaudeFollowUp());
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null), editingRef = useRef(false);
  editingRef.current = editing !== null;
  // A tip takes the header's title slot for 10 s (not while the agent waits on a question, whose alert sits in that slot).
  const [tip, setTip] = useState(''), tipTimer = useRef(0);
  const showTip = useRef((id: string, text: string, options?: { gap?: number; max?: number }) => {
    if (!claimTip(id, options)) return;
    setTip(text); clearTimeout(tipTimer.current); tipTimer.current = window.setTimeout(() => setTip(''), 10_000);
  }).current;
  useEffect(() => () => clearTimeout(tipTimer.current), []);
  const [tmuxPlace, setTmuxPlace] = useState<'top' | 'bottom' | null>(null);
  // Another device's size is shown (the PTY is not this pane's size); typing here or the button brings it back.
  const [otherSize, setOtherSize] = useState(false), claimSize = useRef<() => void>(() => {});
  const [queued, setQueued] = useState(followUp.current.items);
  const flushQueue = useRef<() => void>(() => {});
  // Called after every output chunk of a Claude pane; an unchanged queue must not re-render it.
  const refreshQueue = () => setQueued(previous => {
    const next = followUp.current.items;
    return next.length === previous.length && next.every((item, index) => item.id === previous[index].id && item.text === previous[index].text) ? previous : next;
  });
  const checkAgent = useRef<() => void>(() => {});
  const visibleRef = useRef(visible), sshRef = useRef(isSsh), replayScroll = useRef(false), scrollAfterReplay = useRef<() => void>(() => {});
  visibleRef.current = visible; sshRef.current = isSsh;
  const term = useRef<Terminal | null>(null), webglRef = useRef<WebglAddon | null>(null), centerRef = useRef<() => void>(() => {}), notifyResizeRef = useRef<() => void>(() => {}), layoutRef = useRef<() => void>(() => {});
  const callbacks = useRef({ send, followUpInput, confirmSend, onSplit, onTitle, onSize, onAgent, agentOf, onAgentEvent, onAgentResolved, onAgentWorking }); callbacks.current = { send, followUpInput, confirmSend, onSplit, onTitle, onSize, onAgent, agentOf, onAgentEvent, onAgentResolved, onAgentWorking };
  const settingsRef = useRef(settings); settingsRef.current = settings;
  // The effect below only depends on [id, bus], so the send warning reads the latest cache through a ref.
  const cachesRef = useRef(caches); cachesRef.current = caches;
  useEffect(() => {
    const terminal = new Terminal({ ...xtermOptions(settings), allowProposedApi: true,
      // xterm's default OSC 8 link handler asks via confirm() and then opens a blank window it navigates afterwards, which the desktop
      // shell denies. Ask through the workspace's own dialog instead (open in the system browser, copy, or cancel).
      linkHandler: { allowNonHttpProtocols: false, activate: (_event, uri) => { if (/^https?:\/\//i.test(uri)) window.dispatchEvent(new CustomEvent('ade:link', { detail: uri })); } },
      // The server runs ConPTY (bundled conpty.dll, which reflows on its own). Telling xterm keeps its wrapped-line handling in step with
      // ConPTY's; without it, old output is mangled when the pane resizes or a long answer scrolls past the top.
      ...(/Windows/.test(navigator.userAgent) ? { windowsPty: { backend: 'conpty' as const, buildNumber: 26100 } } : {}), theme: terminalTheme(host.current!) });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current!); term.current = terminal;
    // BEL from a plain terminal program. An agent's own BEL is the approval request, which has its alert (and sound) in the AI settings, so it is left to that.
    terminal.onBell(() => {
      const { terminalBell, soundAttention, soundVolume } = settingsRef.current;
      if (terminalBell === 'off' || callbacks.current.agentOf(id)) return;
      if (terminalBell === 'sound') playSound(soundAttention, soundVolume);
      else if (host.current) { host.current.classList.remove('bell'); void host.current.offsetWidth; host.current.classList.add('bell'); }
    });
    // Unicode 11 widths match what shells/TUIs assume for Hangul and emoji; the default (v6) table disagrees and leaves stale half-cells.
    terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
    // After a copy the selection lights up in the accent color for a moment, then clears, so it is clear what was copied.
    const copySelection = () => {
      copyText(terminal.getSelection());
      terminal.options.theme = { ...terminal.options.theme, selectionBackground: getComputedStyle(host.current ?? document.documentElement).getPropertyValue('--accent').trim() || undefined };
      setTimeout(() => { terminal.clearSelection(); terminal.options.theme = terminalTheme(host.current ?? undefined); }, 220);
    };
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
    // Files dropped from the OS are typed as shell-quoted absolute paths, like Terminal.app; only the desktop shell can resolve them.
    const pathForFile = (window as unknown as { adeDesktop?: { pathForFile?(file: File): string } }).adeDesktop?.pathForFile;
    const quotePath = (path: string) => /Windows/.test(navigator.userAgent) ? (/[\s&()^%!,;=]/.test(path) ? `"${path}"` : path) : path.replace(/[\s'"\\$`!&|;()<>*?[\]{}#~^]/g, '\\$&');
    const dragFiles = (event: DragEvent) => {
      if (!pathForFile || !event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy';
    };
    const dropFiles = (event: DragEvent) => {
      if (!pathForFile || !event.dataTransfer?.files.length) return;
      event.preventDefault(); event.stopPropagation();
      const paths = Array.from(event.dataTransfer.files, file => pathForFile(file)).filter(Boolean);
      if (!paths.length) return;
      terminal.paste(paths.map(quotePath).join(' ') + ' '); terminal.focus(); toastAttached(paths.length);
    };
    // Right-click pastes the clipboard instead of opening the browser menu (the desktop shell has none of its own for the terminal).
    const rightClick = (event: MouseEvent) => {
      if (!settingsRef.current.rightClickPaste) return;
      event.preventDefault();
      if (terminal.hasSelection()) copySelection();
      else void navigator.clipboard?.readText().then(text => { if (text) { terminal.paste(text); toastPasted(text); } }, () => {});
    };
    pasteHost.addEventListener('contextmenu', rightClick);
    pasteHost.addEventListener('dragover', dragFiles); pasteHost.addEventListener('drop', dropFiles);
    terminal.onSelectionChange(() => {
      const text = settingsRef.current.copyOnSelect && terminal.hasSelection() ? terminal.getSelection() : '';
      if (text) copyText(text, { count: false });
    });
    const detectBanner = createBannerDetector(), question = createQuestionTracker();
    let sequence = 0, replays = 0, pendingResize = false, refreshAfterReplay = false, working = false, asking = false, title = '';
    let status: TerminalFeed['status'], reportedState: string | undefined;
    let bannerTail = '', followUpSupported = false, sendingFollowUp = false, writes = 0, retryTimer = 0, composedEnter = 0;
    const queueId = crypto.randomUUID();
    const screenText = () => {
      const buffer = terminal.buffer.active;
      return Array.from({ length: terminal.rows }, (_, row) => {
        const line = buffer.getLine(buffer.baseY + row);
        return (line?.isWrapped ? '' : '\n') + (line?.translateToString(true) || '');
      }).join('');
    };
    // Send warning: a message about to reach a Claude whose prompt cache is cold (or nearly) needs the user's OK first, and
    // without it nothing is sent. Enter is held in onData; the follow-up queue skips onData, so flushQueue asks on its own.
    let sendGate = false, queueAsking = false, queueHold = '', queueAllowed = '', lastTyped = 0;
    const sendWarning = () => cacheSendWarning(cachesRef.current[id], Date.now(), { enabled: settingsRef.current.cacheSendWarn, minutes: settingsRef.current.cacheSendWarnMinutes, working });
    const enterWarning = () => {
      if (sshRef.current || asking || replays || callbacks.current.agentOf(id) !== 'claude') return;
      const warning = sendWarning(); if (!warning) return;
      const typed = claudeComposerText(screenText());
      // The last typed characters may not be echoed yet, which makes the composer look empty; err towards asking.
      return isClaudeMessageText(typed) || (!typed && Date.now() - lastTyped < 80) ? warning : undefined;
    };
    // Tips ride on a message about to be sent (Enter on real message text): a long context suggests /clear, and Enter while Claude is working suggests Tab.
    const tipOnSend = () => {
      const config = settingsRef.current, cache = cachesRef.current[id];
      if (!config.tips || sshRef.current || replays || callbacks.current.agentOf(id) !== 'claude') return;
      const context = !cache?.compacted && contextTip(cache?.tokens, config.contextTipK), queue = working && followUpSupported && config.followUpQueue;
      if ((context || queue) && isClaudeMessageText(claudeComposerText(screenText())))
        { if (context) showTip('context', context, { gap: 10 * 60_000, max: Infinity }); else showTip('queue', queueTip); }
    };
    const askBeforeSend = (warning: CacheSendWarning) => {
      sendGate = true;
      void callbacks.current.confirmSend(cacheSendWarningText(warning)).catch(() => false).then(accepted => {
        sendGate = false;
        if (term.current !== terminal) return;
        if (accepted) { followUp.current.submitted(); question.input('\r'); callbacks.current.send({ type: 'terminal/input', id, data: '\r' }); }
        terminal.focus();
      });
    };
    flushQueue.current = () => {
      // Reading the screen is the costly part; with nothing queued there is nothing to send.
      if (sendingFollowUp || !followUp.current.items.length) return;
      const screen = screenText();
      const next = followUp.current.next((followUpSupported || status?.agent === 'claude' && fromProgramStatus(status)) && !sshRef.current && !replays && !writes && callbacks.current.agentOf(id) === 'claude' && !editingRef.current
        && !question.observe(screen, title) && hasEmptyClaudeComposer(screen));
      if (next) {
        const warning = sendWarning(), key = String(cachesRef.current[id]?.at);
        if (warning && queueAllowed !== key) {
          // Asked once per cache: a declined item stays queued until a new request starts the cache over, instead of asking after every output chunk.
          if (!queueAsking && !sendGate && queueHold !== key) {
            queueAsking = true;
            void callbacks.current.confirmSend(`후속 대기열의 메시지를 자동으로 보내려 합니다.\n${cacheSendWarningText(warning)}`).catch(() => false).then(accepted => {
              queueAsking = false;
              if (term.current !== terminal) return;
              if (accepted) { queueAllowed = key; queueHold = ''; flushQueue.current(); } else queueHold = key;
            });
          }
          return;
        }
        sendingFollowUp = true; clearTimeout(retryTimer);
        let accepted = false;
        void callbacks.current.followUpInput(id, next.text, sequence, `${queueId}:${next.id}`).then(result => {
          accepted = result; if (accepted) followUp.current.sent(next.id);
        }).catch(() => {}).finally(() => {
          sendingFollowUp = false; refreshQueue();
          // The server rejects when output arrived during its slow process check, flushes are skipped while in flight,
          // and an idle CLI may not write again for minutes, so retry on a timer instead of waiting for the next output.
          if (!accepted) retryTimer = window.setTimeout(() => flushQueue.current(), 1000);
        });
      }
    };
    const progress = terminal.parser.registerOscHandler(9, value => {
      if (followUpSupported && !sshRef.current && !replays && callbacks.current.agentOf(id) === 'claude') { followUp.current.progress(value); refreshQueue(); }
      return false;
    });
    // OSC 52: a TUI (Claude Code over ssh, tmux, vim) copies by sending base64 text, since it cannot reach this machine's clipboard.
    // Replayed output still holds old copies, and a query ("?") is never answered so remote programs cannot read the clipboard.
    const osc52 = terminal.parser.registerOscHandler(52, value => {
      const data = value.slice(value.indexOf(';') + 1);
      if (replays || value.indexOf(';') < 0 || data === '?') return true;
      try {
        const text = new TextDecoder().decode(Uint8Array.from(atob(data), char => char.charCodeAt(0)));
        if (text) copyText(text);
      } catch { /* malformed base64 */ }
      return true;
    });
    // `wanted` is what fits this pane; the server applies it when this window owns the size (or nobody does) and otherwise keeps it
    // for when this window types again. xterm itself is always drawn at `serverSize`, the PTY's real size, once the server has told it.
    let wanted: TerminalSize | null = null, serverSize: TerminalSize | null = bus.sizes.get(id) ?? null, otherTimer = 0;
    const notifyResize = () => {
      if (replays) { pendingResize = true; return; }
      if (!wanted) return; // never measured (a hidden pane): there is no size of its own to report yet
      pendingResize = false;
      // A size change makes the program redraw, which repairs a replayed screen. It is only a wish like any other, so it never
      // takes the size from another device; the step goes down so the pane never has to show a row more than fits.
      if (refreshAfterReplay) {
        refreshAfterReplay = false;
        callbacks.current.send({ type: 'terminal/resize', id, cols: wanted.cols, rows: wanted.rows > 1 ? wanted.rows - 1 : wanted.rows + 1 });
      }
      callbacks.current.send({ type: 'terminal/resize', id, cols: wanted.cols, rows: wanted.rows });
    };
    notifyResizeRef.current = notifyResize;
    // Draws xterm at the PTY size. Smaller than the pane: top left on the terminal background. Larger (another device's size): the
    // pane scrolls instead of overflowing, following the cursor. A mismatch that lasts is another device's size; a short one is
    // this window's own report still on its way.
    const followCursor = () => {
      const box = host.current, element = terminal.element;
      if (!box || box.dataset.oversized === undefined || !element || !terminal.rows || !terminal.cols) return;
      const cellHeight = element.offsetHeight / terminal.rows, cellWidth = element.offsetWidth / terminal.cols, buffer = terminal.buffer.active;
      const bottom = (buffer.cursorY + 2) * cellHeight, right = (buffer.cursorX + 2) * cellWidth;
      if (bottom > box.scrollTop + box.clientHeight || bottom - cellHeight * 2 < box.scrollTop) box.scrollTop = Math.max(0, bottom - box.clientHeight);
      if (right > box.scrollLeft + box.clientWidth || right - cellWidth * 2 < box.scrollLeft) box.scrollLeft = Math.max(0, right - box.clientWidth);
    };
    const layout = () => {
      const box = host.current;
      if (box?.clientWidth && box.clientHeight) {
        const proposed = fit.proposeDimensions();
        if (proposed && Number.isFinite(proposed.cols) && Number.isFinite(proposed.rows)) wanted = { cols: proposed.cols, rows: proposed.rows };
      }
      const target = serverSize ?? wanted;
      if (target && (terminal.cols !== target.cols || terminal.rows !== target.rows)) terminal.resize(target.cols, target.rows);
      callbacks.current.onSize(id, terminal.cols, terminal.rows);
      const differs = Boolean(serverSize && wanted && (serverSize.cols !== wanted.cols || serverSize.rows !== wanted.rows));
      const show = () => {
        otherTimer = 0;
        const larger = Boolean(differs && serverSize && wanted && (serverSize.cols > wanted.cols || serverSize.rows > wanted.rows));
        if (box) { if (larger) { box.dataset.oversized = ''; followCursor(); } else delete box.dataset.oversized; }
        setOtherSize(differs);
      };
      clearTimeout(otherTimer); otherTimer = 0;
      if (differs) otherTimer = window.setTimeout(() => { if (term.current === terminal) show(); }, 400); else show();
    };
    layoutRef.current = layout;
    claimSize.current = () => {
      if (wanted) callbacks.current.send({ type: 'terminal/resize', id, cols: wanted.cols, rows: wanted.rows, claim: true });
      terminal.focus();
    };
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
      // A 7501 report says outright whether the CLI asks something; only without one is the screen read (the costly part).
      const pending = fromProgramStatus(status) ? status!.state === 'blocked' : question.observe(screenText(), title);
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
      // The follow-up queue already reads OSC 9;4 itself; turns derived from the same progress must not drive it a second time.
      if (status?.agent === 'claude' && !status.source && !sshRef.current && callbacks.current.agentOf(id) === 'claude') { followUp.current.turn(next); refreshQueue(); flushQueue.current(); }
      if (next !== working) { working = next; callbacks.current.onAgentWorking(id, working); }
      if (status?.state !== reportedState) {
        reportedState = status?.state;
        if (working) callbacks.current.onAgentResolved(id);
        else if (!replay && (reportedState === 'done' || reportedState === 'error')) callbacks.current.onAgentEvent(id, 'done');
      }
    };
    // Live output re-checks the agent at most every 50 ms: a busy TUI sends a batch every 5 ms, and each check could read the whole screen.
    // A timer rather than an animation frame, so a window in the background still notices a finished or asking agent.
    // A pane nobody sees (another tab or project) only drives sidebar badges, so it checks less often.
    let watchTimer = 0;
    const watchLater = () => { watchTimer ||= window.setTimeout(() => { watchTimer = 0; if (term.current !== terminal) return; watchAgent(); flushQueue.current(); }, visibleRef.current ? 50 : 400); };
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
          if (!writes) followCursor();
          if (replay) watchAgent(true); else watchLater();
        });
        const agent = detectBanner(feed.data, replay); if (agent) callbacks.current.onAgent(id, agent);
      } else if ('status' in feed) watchAgent(true);
      if (feed.exited) { followUp.current.reset(); refreshQueue(); terminal.write('\r\n\x1b[2m[프로세스 종료]\x1b[0m\r\n'); }
    };
    bus.listeners.set(id, receive);
    terminal.onData(data => {
      if (replays && QUERY_REPLY.test(data)) return;
      // A send confirmation is open: keystrokes must not reach Claude, or land around the held Enter, until it is answered.
      if (sendGate && !REPORT.test(data)) return;
      // Esc/Ctrl+C interrupt the turn; the queue keeps going once the CLI reports it idle (4;0).
      if (data === '\r') {
        const warning = enterWarning();
        if (warning) { askBeforeSend(warning); return; }
        tipOnSend();
        followUp.current.submitted();
      } else if (data.charCodeAt(0) >= 32) lastTyped = Date.now();
      // Focus-in/out and mouse reports are sent by xterm on its own when a TUI (Claude Code) asks for them, e.g. merely focusing the pane.
      // Typing and reports do not change the agent's turn state.
      if (!REPORT.test(data)) question.input(data);
      // The server rejects input messages over 16384 chars, so a long paste goes out in ordered chunks.
      // A chunk never ends on a high surrogate, which would turn into U+FFFD once split from its pair.
      for (let start = 0; start < data.length;) {
        let end = Math.min(start + 8192, data.length);
        if (end < data.length && /[\ud800-\udbff]/.test(data[end - 1])) end--;
        callbacks.current.send({ type: 'terminal/input', id, data: data.slice(start, end) });
        start = end;
      }
    });
    let shownTitle: string | undefined;
    terminal.onTitleChange(value => {
      title = value;
      const shown = stableTitle(value);
      if (shown !== shownTitle) { shownTitle = shown; callbacks.current.onTitle(id, shown); }
    });
    // tmux key guide (which-key style): the prefix pressed in a pane that shows a tmux status line opens the guide until the next key.
    // Keys always pass through to the terminal; the guide only listens. It sits on the side of the pane away from the cursor.
    const tmuxGuide = createPrefixGuide({
      timeout: 10_000,
      show: () => setTmuxPlace(terminal.buffer.active.cursorY >= terminal.rows / 2 ? 'top' : 'bottom'),
      hide: () => setTmuxPlace(null)
    });
    const tmuxOnScreen = () => guideActive(settingsRef.current.tmuxGuide, () => looksLikeTmux(screenRows(terminal)));
    terminal.textarea?.addEventListener('blur', tmuxGuide.cancel);
    // Copy/paste toasts rise from this terminal's selection end (else its text cursor) while it has focus; cell size = rendered screen / grid.
    const cursorAnchor = () => {
      const rect = terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect(), buffer = terminal.buffer.active, selection = terminal.getSelectionPosition();
      if (!rect) return;
      const col = selection ? Math.max(0, selection.end.x - .5) : buffer.cursorX + .5, row = selection ? Math.min(terminal.rows - 1, Math.max(0, selection.end.y - buffer.viewportY)) + .5 : buffer.cursorY + .5;
      return { x: rect.left + col * rect.width / terminal.cols, y: rect.top + row * rect.height / terminal.rows, selected: !!selection };
    };
    const anchorToast = () => setToastAnchor(cursorAnchor), releaseToast = () => setToastAnchor(cursorAnchor, false);
    terminal.textarea?.addEventListener('focus', anchorToast); terminal.textarea?.addEventListener('blur', releaseToast);
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown') {
        if (isPrefixKey(event, settingsRef.current.tmuxPrefix)) { if (!event.repeat && (tmuxGuide.state !== 'idle' || !replays && tmuxOnScreen())) tmuxGuide.prefix(); }
        else if (!isModifierOnly(event.key)) tmuxGuide.key();
      }
      // Cmd+←/→ (no Shift) jumps to line start/end like macOS terminals do (^A / ^E); xterm itself sends nothing for Cmd+arrows.
      if (event.metaKey && !event.shiftKey && !event.ctrlKey && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        if (event.type === 'keydown') { event.preventDefault(); callbacks.current.send({ type: 'terminal/input', id, data: event.key === 'ArrowLeft' ? '\x01' : '\x05' }); }
        return false;
      }
      if (event.type !== 'keydown' || event.altKey || event.metaKey) return true;
      // macOS IMEs (Korean etc.) report an Enter that ends a composition as a composing keydown followed by a plain Enter keydown,
      // and xterm sends CR for both. The composing one only commits the text; the fallback covers an IME that skips the second keydown.
      if (event.key === 'Enter' && event.isComposing) {
        const data = event.shiftKey ? '\x1b\r' : '\r';
        clearTimeout(composedEnter); composedEnter = window.setTimeout(() => event.shiftKey ? callbacks.current.send({ type: 'terminal/input', id, data }) : terminal.input(data), 100);
        return false;
      }
      if (event.key === 'Enter') clearTimeout(composedEnter);
      // Tab in Claude's composer queues a follow-up while a turn runs; every other Tab (autocomplete, thinking/ultra toggle) goes to the CLI.
      if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.isComposing && !sshRef.current && callbacks.current.agentOf(id) === 'claude' && !asking) {
        const typed = claudeComposerText(screenText()), text = typed && !/^Try "/.test(typed) ? typed : undefined; // an empty composer shows a `Try "…"` hint
        if (text && /(?:^|\s)[/@]\S*$/.test(text)) return true;
        if (text && settingsRef.current.followUpQueue && followUp.current.working && !/\[(?:Pasted text|Image|\.\.\.Truncated)/.test(text) && followUp.current.enqueue(text)) {
          event.preventDefault();
          callbacks.current.send({ type: 'terminal/input', id, data: '\x05' + '\x7f'.repeat(text.length + 8) });
          refreshQueue();
          return false;
        }
      }
      // xterm sends a bare CR for Shift+Enter; ESC+CR is the "newline without submit" sequence TUIs (Claude Code etc.) understand.
      // Sent on the next tick: xterm flushes a just-ended IME composition from a setTimeout(0), and the newline must come after that text.
      if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey) {
        event.preventDefault(); setTimeout(() => callbacks.current.send({ type: 'terminal/input', id, data: '\x1b\r' })); return false;
      }
      // Ctrl+C copies only while text is selected (otherwise it stays SIGINT); Ctrl+Shift+C always copies.
      if (event.ctrlKey && event.code === 'KeyC' && (event.shiftKey || terminal.hasSelection())) {
        event.preventDefault();
        const text = terminal.hasSelection() ? terminal.getSelection() : '';
        if (text) copySelection();
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
    const resize = () => { if (!host.current?.clientWidth || !host.current.clientHeight) return; layout(); center(); requestAnimationFrame(center); notifyResize(); if (replayScroll.current) scrollAfterReplay.current(); };
    const observer = new ResizeObserver(resize); observer.observe(host.current!); resize();
    bus.sizeListeners.set(id, size => {
      serverSize = size; layout(); center(); requestAnimationFrame(center);
      if (replayScroll.current) scrollAfterReplay.current();
    });
    // A size that arrived before this pane mounted (a hidden pane is never measured, so `resize` above did not draw it).
    if (serverSize) layout();
    const initial = bus.buffers.get(id); if (initial) receive({ ...initial, data: initial.data.slice(-262144), reset: true });
    return () => { tmuxGuide.cancel(); terminal.textarea?.removeEventListener('blur', tmuxGuide.cancel); terminal.textarea?.removeEventListener('focus', anchorToast); terminal.textarea?.removeEventListener('blur', releaseToast); releaseToast(); clearTimeout(retryTimer); clearTimeout(watchTimer); clearTimeout(composedEnter); checkAgent.current = () => {}; flushQueue.current = () => {}; scrollAfterReplay.current = () => {}; cancelAnimationFrame(scrollFrame); progress.dispose(); osc52.dispose(); pasteHost.removeEventListener('paste', pasteImage, true); pasteHost.removeEventListener('contextmenu', rightClick); pasteHost.removeEventListener('dragover', dragFiles); pasteHost.removeEventListener('drop', dropFiles); observer.disconnect(); bus.listeners.delete(id); bus.sizeListeners.delete(id); clearTimeout(otherTimer); claimSize.current = () => {}; layoutRef.current = () => {}; webglRef.current = null; terminal.dispose(); term.current = null; };
  }, [id, bus]);
  useEffect(() => { if (visible && replayScroll.current) { layoutRef.current(); scrollAfterReplay.current(); } }, [visible]);
  // WebGL contexts are reserved for visible panes, but a pane that is hidden keeps its context until a visible pane needs the slot:
  // disposing it on every tab switch and rebuilding it on return swapped renderers mid-transition and blanked the terminal for a frame.
  const gpu = useRef({ addon: null as WebglAddon | null, acquire: () => {}, release: (_handOff?: boolean) => {} });
  useEffect(() => {
    const state = gpu.current;
    state.release = (handOff = true) => {
      const addon = state.addon; if (!addon) return;
      state.addon = null; webgl.active--; webgl.idle.delete(state.release);
      if (webglRef.current === addon) webglRef.current = null;
      addon.dispose();
      const next = handOff && webgl.waiting.values().next().value;
      if (next) { webgl.waiting.delete(next); next(); }
    };
    state.acquire = () => {
      const terminal = term.current;
      if (state.addon || webgl.disabled || !terminal || !settingsRef.current.terminalGpu) return;
      if (webgl.active >= WEBGL_LIMIT) {
        const idle = webgl.idle.values().next().value;
        if (!idle) { webgl.waiting.add(state.acquire); return; }
        idle(false);
      }
      try {
        const addon = new WebglAddon();
        // A lost context falls back to the DOM renderer; it is not recreated while the pane stays visible.
        addon.onContextLoss(() => { webglLost(); state.release(); });
        terminal.loadAddon(addon); state.addon = addon; webgl.active++; webglRef.current = addon;
      } catch { /* no WebGL: keep the DOM renderer */ }
    };
    return () => { webgl.waiting.delete(state.acquire); state.release(); };
  }, []);
  useEffect(() => {
    const state = gpu.current;
    if (!settings.terminalGpu) { webgl.waiting.delete(state.acquire); state.release(); return; }
    if (visible) { webgl.idle.delete(state.release); state.acquire(); }
    else { webgl.waiting.delete(state.acquire); if (state.addon) webgl.idle.add(state.release); }
  }, [visible, settings.terminalGpu]);
  useEffect(() => { checkAgent.current(); }, [identity, isSsh]);
  useEffect(() => {
    // Next frame: the App effect that switches `data-theme` runs after this child effect.
    const frame = requestAnimationFrame(() => {
      const terminal = term.current; if (!terminal) return;
      terminal.options.theme = terminalTheme(host.current ?? undefined);
      Object.assign(terminal.options, xtermOptions(settings));
      if (!host.current?.clientWidth) return;
      layoutRef.current(); centerRef.current(); requestAnimationFrame(() => centerRef.current()); notifyResizeRef.current();
    });
    return () => cancelAnimationFrame(frame);
  }, [settings.theme, settings.terminalFontSize, settings.terminalFont, settings.terminalFontWeight, settings.lineHeight, settings.letterSpacing, settings.cursorBlink, settings.cursorStyle, settings.scrollback,
    settings.scrollSensitivity, settings.minimumContrast, settings.wordSeparator, settings.boldBright, settings.optionAsMeta]);
  useEffect(() => { if (focused) term.current?.focus(); }, [focused]);
  const label = titles[id] || (cwds[id] ? basename(cwds[id]) : id.slice(0, 6));
  const exited = cwds[id] !== undefined && !live.has(id);
  const agent = exited ? undefined : agentOf(id), agentState = !agent ? undefined : attention[id] ?? (workingSet.has(id) ? 'working' : 'idle'), switchable = attention[id] !== 'attention' && !workingSet.has(id);
  return <section className={`terminal-pane ${focused ? 'focused' : ''} ${exited ? 'exited' : ''}`} data-ssh={isSsh ? '' : undefined} data-agent={agent} data-agent-state={agentState} onMouseDownCapture={() => onFocus(id)} onFocus={() => onFocus(id)}>
    <div className="pane-tools" role="toolbar" aria-label="터미널 pane">
      {agent === 'claude' && settings.cacheTimer && caches[id] && <CacheTimer cache={caches[id]} working={workingSet.has(id)} warn={settings.cacheWarn} />}
      {tip && agentState !== 'attention' ? <span className="pane-tip" role="status" title={tip} onClick={() => setTip('')}>{tip}</span> : <span className="pane-title" title={cwds[id]}><span className="pane-mark"><Icon name={agent || 'terminal'} size={12} /></span><span className="pane-label">{label}</span>{agentState === 'attention' && <span className="question-alert" role="img" aria-label="응답 필요" title="질문 또는 승인을 처리해 주세요"><Icon name="alert" size={15} /></span>}</span>}
      <span className="pane-actions">
        {agent && !isSsh && <IconButton icon="claude-chat" label={agent !== 'claude' ? 'Chat으로 전환 — 이 CLI는 세션과 대기 상태를 확인할 수 없어 전환할 수 없습니다' : switchable ? 'Chat으로 전환 (Claude를 종료하고 같은 대화를 이어갑니다)' : 'Chat으로 전환 — 응답이 끝나고 대기 중일 때만 가능'} className={agent !== 'claude' || !switchable ? 'soft-disabled' : ''} onClick={() => {
          // Never a dead button: when the switch cannot happen, say why in the header instead of ignoring the click.
          const why = agent !== 'claude' ? '이 CLI는 세션과 대기 상태를 확인할 수 없어 Chat으로 전환할 수 없습니다.' : attention[id] === 'attention' ? '승인 또는 질문에 먼저 답한 뒤 Chat으로 전환할 수 있습니다.' : workingSet.has(id) ? '응답이 끝난 뒤 Chat으로 전환할 수 있습니다.' : '';
          if (why) { setTip(why); clearTimeout(tipTimer.current); tipTimer.current = window.setTimeout(() => setTip(''), 6000); return; }
          setTip('Chat으로 전환하는 중…'); clearTimeout(tipTimer.current); onToChat(id);
        }} />}
        {agent === 'claude' && !isSsh && <i className="pane-sep" aria-hidden="true" />}
        <IconButton icon="splitH" label="좌우 분할" keys={showAppKey(settings.appKeys, 'splitRight')} onClick={event => { onSplit(id, 'row'); if (event.detail && settings.tips) showTip('split', splitTip(keys => showAppKey(settings.appKeys, keys === 'ctrl+d' ? 'splitRight' : 'splitDown'))); }} /><IconButton icon="splitV" label="상하 분할" keys={showAppKey(settings.appKeys, 'splitDown')} onClick={event => { onSplit(id, 'column'); if (event.detail && settings.tips) showTip('split', splitTip(keys => showAppKey(settings.appKeys, keys === 'ctrl+d' ? 'splitRight' : 'splitDown'))); }} />
        <IconButton icon={zoomed ? 'minimize' : 'maximize'} label={zoomed ? '원래 크기로' : '최대화'} keys={showAppKey(settings.appKeys, 'zoom')} onClick={() => onZoom(id)} />
        <IconButton icon="x" label="터미널 종료" onClick={() => onClose(id)} /></span></div>
    <div ref={host} className="xterm-host" />
    {tmuxPlace && <TmuxGuide prefix={settings.tmuxPrefix} place={tmuxPlace} />}
    {otherSize && !exited && <div className="pane-size-note" role="status">
      <span>다른 기기 크기로 표시 중 · 입력하면 이 창 크기로 돌아옵니다</span>
      <button onClick={() => claimSize.current()}>이 창에 맞추기</button></div>}
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

// An editor pane holds diff tabs opened from the review panel (`diff:<kind>:<path>`).
function EditorGroup({ leaf, focused, zoomed, ctx, onFocus, onZoom }: { leaf: Leaf; focused: boolean; zoomed: boolean; ctx: EditorCtx; onFocus(id: string): void; onZoom(id: string): void }) {
  const tabs = leaf.tabs || [], active = leaf.active && tabs.includes(leaf.active) ? leaf.active : tabs[0] || '';
  const label = (path: string) => `${basename(path.split(':').slice(2).join(':'))} (${path.split(':')[1] === 'staged' ? '스테이지됨' : '변경'})`;
  return <section className={`editor-group ${focused ? 'focused' : ''}`} onMouseDownCapture={() => onFocus(leaf.id)}>
    <header className="tab-strip"><div className="tabs" role="tablist">{tabs.map(path =>
      <div key={path} role="tab" aria-selected={path === active} title={path} className={`tab ${path === active ? 'active' : ''}`}
        onClick={() => ctx.onSelectTab(leaf.id, path)} onAuxClick={event => { if (event.button === 1) ctx.onCloseTab(leaf.id, path); }}>
        <Icon name="diff" size={13} /><span>{label(path)}</span><button aria-label={`${path} 닫기`} title="닫기" onClick={event => { event.stopPropagation(); ctx.onCloseTab(leaf.id, path); }}><Icon name="x" size={13} /></button></div>)}</div>
      <div className="group-actions"><IconButton icon={zoomed ? 'minimize' : 'maximize'} label={zoomed ? '원래 크기로' : '최대화'} onClick={() => onZoom(leaf.id)} /><IconButton icon="x" label="Diff 패널 닫기" onClick={() => ctx.onCloseGroup(leaf.id)} /></div></header>
    {active ? <DiffTab key={active} spec={active} ctx={ctx} />
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
    : pane.kind === 'chat' ? <ChatPane leaf={pane} focused={props.focus === pane.id} zoomed={props.zoom === pane.id} visible={props.visible} ctx={props.chat} onFocus={props.onFocus} onZoom={props.onZoom} onSplit={props.onSplit} />
    : pane.kind === 'launcher' ? <LauncherPane onModeChange={props.onModeChange} shell={props.editor.settings.terminalShell} mode={props.editor.settings.defaultMode} hidden={props.editor.settings.agentsOff} id={pane.id} focused={props.focus === pane.id} onFocus={props.onFocus} onClose={props.onClose} onLaunch={props.onLaunch} />
    : <TerminalPane {...props} id={pane.id} focused={props.focus === pane.id} zoomed={props.zoom === pane.id} settings={props.editor.settings} />;
  return <Splitter equalOnClick direction={pane.direction} sizes={pane.sizes} onSizes={sizes => props.onLayout({ ...pane, sizes })}>
    {pane.children.map((child, index) => <Tree key={isLeaf(child) ? child.id : index} {...props} pane={child} onLayout={next => props.onLayout({ ...pane, children: pane.children.map((old, i) => i === index ? next : old) })} />)}
  </Splitter>;
}
