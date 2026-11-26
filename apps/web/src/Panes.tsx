import { TERMINAL_KEYS, useMobile, withCtrl } from './mobile';
import { can, remoteHaptic } from './transport';
import { filePaths, quoteShellPath } from './upload';
import { showAppKey } from './shortcuts';
import { terminalEditKey } from './terminal-keys';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePaneDrag } from './pane-drag';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { basename, findLeaf, isLeaf, leafList, type Leaf, type Pane } from './api';
import { useHiddenAgents } from './installed-agents';
import { pickGreeting } from './chat-model';
import { DiffView, FileEditor, terminalFontStack, type DiffLayoutChoice, type Settings } from './Editor';
import { FileIcon } from './FileIcon';
import type { FileBuffer } from './file-buffer';
import { Icon, IconButton, SplitButton, type IconName } from './Icon';
import { CacheTimer, type ClaudeCache } from './CacheTimer';
import { ChatPane, type ChatCtx } from './ChatPane';
import { copyText, toastPasted, toastAttached, setToastAnchor } from './toast';
import { playSound } from './sound';
import { hintCandidates } from './tips';
import { useTipNotice } from './use-notice';
import { Hint } from './Hint';
import { useShells, shellLabel } from './shells';
import { LauncherModes } from './LauncherMenu';
import { launchersFor, type AgentMode } from './launchers';
import { ANSI, createBannerDetector, createQuestionTracker, stableTitle } from './terminal-agent';
import type { Agent } from './terminal-agent';
import { claudeComposerText, claudeDraftPaste, createClaudeFollowUp, hasEmptyClaudeComposer, claudeFollowUpVersion } from './claude-follow-up';
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
  fileBuffer(path: string): FileBuffer;
  watchFiles(listener: (paths: string[]) => void): () => void;
  onDiffLayoutChange(layout: DiffLayoutChoice): void;
  onSelectTab(group: string, path: string): void; onCloseTab(group: string, path: string): void; onCloseGroup(group: string): void;
  loadDiff(kind: string, path: string): Promise<{ original: string; modified: string }>;
};
export { CacheTimer, type ClaudeCache };
type Props = {
  followUpInput(id: string, prompt: string, sequence: number, requestId: string): Promise<boolean>;
  // Asks whether to send anyway while the prompt cache is cold or about to be; resolves false unless the user accepts.
  confirmSend(message: string): Promise<boolean>;
  pane: Pane; visible: boolean; onLayout(pane: Pane): void; send(message: object): boolean; bus: TerminalBus; live: Set<string>; cwds: Record<string, string>; titles: Record<string, string>; agentOf(id: string): Agent | undefined; onAgent(id: string, agent: Agent): void; onAgentEvent(id: string, kind: AgentEventKind): void; onAgentResolved(id: string): void; onAgentWorking(id: string, working: boolean): void; ssh: Set<string>; working: Set<string>; attention: Record<string, AgentEventKind>; caches: Record<string, ClaudeCache>; focus: string; zoom: string;
  onFocus(id: string): void; onZoom(id: string): void; onSplit(id: string, direction: 'row' | 'column'): void; onClose(id: string): void; onTitle(id: string, title: string): void; onLaunch(id: string, command: string): void; onToChat(id: string): void; onModeChange(mode: AgentMode): void; editor: EditorCtx; chat: ChatCtx;
};

export { launchers } from './launchers';
export const CHAT_COMMAND = 'ade:chat:claude';
export const chatAgent = (command: string): Agent | undefined => ({ 'ade:chat:claude': 'claude', 'ade:chat:codex': 'codex', 'ade:chat:cursor': 'cursor' } as Record<string, Agent>)[command];
// The centered picker shown by an empty tab and by a fresh split; the shell button takes focus so Enter opens a plain terminal.
export function Launchers({ title, onLaunch, autoFocus, hidden = [], mode, shell, onModeChange, nudge }: { onModeChange(mode: AgentMode): void; shell: string; mode: AgentMode; title?: string; onLaunch(command: string): void; autoFocus?: boolean; hidden?: string[]; nudge?: boolean }) {
  const hide = useHiddenAgents(hidden), shells = useShells(), greeting = useMemo(() => pickGreeting(), []);
  return <div className="empty-tab" data-mode={mode}>
    <div className="launcher-heading"><LauncherModes mode={mode} onChange={onModeChange} nudge={nudge} /><h2>{greeting}</h2></div>
    <div className="launchers">{launchersFor(mode, shellLabel(shells, shell)).filter(item => !hide.includes(item.id)).map((item, index) =>
      <button key={item.id} autoFocus={autoFocus && index === 0} onClick={() => onLaunch(item.command)}>
        <span className="launcher-icon"><Icon name={item.icon} size={24} /></span><span className="launcher-copy"><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>
        <span className="launcher-arrow" aria-hidden="true"><Icon name="arrowRight" size={16} /></span>
      </button>)}</div>
  </div>;
}
function LauncherPane({ id, focused, onFocus, onClose, onLaunch, hidden, mode, shell, onModeChange, nudge }: { onModeChange(mode: AgentMode): void; shell: string; mode: AgentMode; id: string; focused: boolean; hidden: string[]; onFocus(id: string): void; onClose(id: string): void; onLaunch(id: string, command: string): void; nudge: boolean }) {
  return <section className={`terminal-pane launcher-pane ${focused ? 'focused' : ''}`} data-feedback-region="새 창 pane" onMouseDownCapture={() => onFocus(id)} onFocus={() => onFocus(id)}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(id); } }}>
    <div className="pane-tools" role="toolbar" aria-label="새 창">
      <span className="pane-title"><span className="pane-mark"><Icon name="plus" size={12} /></span><span className="pane-label">새 창</span></span>
      <span className="pane-actions"><IconButton icon="x" label="pane 닫기" onClick={() => onClose(id)} /></span></div>
    <Launchers onModeChange={onModeChange} shell={shell} mode={mode} autoFocus hidden={hidden} nudge={nudge} onLaunch={command => onLaunch(id, command)} />
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

function TerminalPane({ id, send, followUpInput, confirmSend, bus, visible, live, cwds, titles, agentOf, onAgent, onAgentEvent, onAgentResolved, onAgentWorking, ssh: sshSet, working: workingSet, attention, caches, focused, zoomed, onFocus, onZoom, onSplit, onClose, onToChat, onTitle, settings, chat }: Pick<Props, 'send' | 'followUpInput' | 'confirmSend' | 'bus' | 'visible' | 'live' | 'cwds' | 'titles' | 'agentOf' | 'onAgent' | 'onAgentEvent' | 'onAgentResolved' | 'onAgentWorking' | 'ssh' | 'working' | 'attention' | 'caches' | 'onFocus' | 'onZoom' | 'onSplit' | 'onClose' | 'onToChat' | 'onTitle' | 'chat'> & { id: string; focused: boolean; zoomed: boolean; settings: Settings }) {
  const host = useRef<HTMLDivElement>(null), isSsh = sshSet.has(id), identity = agentOf(id);
  const followUp = useRef(createClaudeFollowUp());
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null), editingRef = useRef(false);
  editingRef.current = editing !== null;
  const [switchingToChat, setSwitchingToChat] = useState(false);
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
  const callbacks = useRef({ send, followUpInput, confirmSend, onSplit, onTitle, onAgent, agentOf, onAgentEvent, onAgentResolved, onAgentWorking, chat }); callbacks.current = { send, followUpInput, confirmSend, onSplit, onTitle, onAgent, agentOf, onAgentEvent, onAgentResolved, onAgentWorking, chat };
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const mobile = useMobile(), ctrlArmed = useRef(false), [ctrl, setCtrl] = useState(false);
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
    // Files dropped from the OS are typed as shell-quoted absolute paths, like Terminal.app: the file's own path in the desktop shell, or
    // the copy the server keeps when this window cannot name one (another PC's window, whose terminals run on that PC; a browser).
    const dropAllowed = can('files/upload');
    const dragFiles = (event: DragEvent) => {
      if (!dropAllowed || !event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy';
    };
    const dropFiles = (event: DragEvent) => {
      if (!dropAllowed || !event.dataTransfer?.files.length) return;
      event.preventDefault(); event.stopPropagation();
      void filePaths(Array.from(event.dataTransfer.files), callbacks.current.chat.call).then(paths => {
        if (!paths.length) return;
        terminal.paste(paths.map(quoteShellPath).join(' ') + ' '); terminal.focus(); toastAttached(paths.length);
      }, cause => callbacks.current.chat.fail(cause));
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
    let resizeAnchor: { atBottom: boolean; fromBottom: number } | null = null, anchorTimer = 0;
    const layout = () => {
      const box = host.current;
      if (box?.clientWidth && box.clientHeight) {
        const proposed = fit.proposeDimensions();
        if (proposed && Number.isFinite(proposed.cols) && Number.isFinite(proposed.rows)) wanted = { cols: proposed.cols, rows: proposed.rows };
      }
      const target = serverSize ?? wanted;
      if (target && (terminal.cols !== target.cols || terminal.rows !== target.rows)) {
        // A split resizes the pane through every size of its spring: reflow at a tiny width loses the place, so the position
        // from before the burst (at the bottom, or this many lines above it) is put back after each step.
        const buffer = terminal.buffer.active;
        resizeAnchor ??= { atBottom: buffer.viewportY >= buffer.baseY, fromBottom: buffer.baseY - buffer.viewportY };
        terminal.resize(target.cols, target.rows);
        const after = terminal.buffer.active, anchor = resizeAnchor;
        if (anchor.atBottom) terminal.scrollToBottom(); else terminal.scrollToLine(Math.max(0, after.baseY - anchor.fromBottom));
        clearTimeout(anchorTimer); anchorTimer = window.setTimeout(() => { resizeAnchor = null; }, 300);
      }
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
    terminal.onData(typed => {
      // The phone key row's sticky Ctrl applies to the next key, whether it comes from the row or the phone's keyboard.
      const armed = ctrlArmed.current && !REPORT.test(typed), data = armed ? withCtrl(typed) : typed;
      if (armed) { ctrlArmed.current = false; setCtrl(false); }
      if (replays && QUERY_REPLY.test(data)) return;
      // A send confirmation is open: keystrokes must not reach Claude, or land around the held Enter, until it is answered.
      if (sendGate && !REPORT.test(data)) return;
      // Esc/Ctrl+C interrupt the turn; the queue keeps going once the CLI reports it idle (4;0).
      if (data === '\r') {
        const warning = enterWarning();
        if (warning) { askBeforeSend(warning); return; }
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
      const editKey = terminalEditKey(event, /Mac|iPhone|iPad/.test(navigator.platform));
      if (editKey !== undefined) {
        if (event.type === 'keydown') { event.preventDefault(); terminal.input(editKey, true); }
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
      if (event.key === 'ArrowUp' && event.shiftKey && !event.ctrlKey && !event.isComposing && !event.repeat && !sshRef.current
        && !asking && !sendGate && !queueAsking && !sendingFollowUp && !editingRef.current && !replays && !writes
        && callbacks.current.agentOf(id) === 'claude' && terminal.modes.bracketedPasteMode && Date.now() - lastTyped >= 80) {
        const last = followUp.current.items.at(-1);
        if (last) {
          const screen = screenText();
          if ((hasEmptyClaudeComposer(screen) || /^Try "/.test(claudeComposerText(screen) ?? ''))
            && callbacks.current.send({ type: 'terminal/input', id, data: claudeDraftPaste(last.text) })) {
            event.preventDefault();
            lastTyped = Date.now();
            followUp.current.remove(last.id);
            refreshQueue();
            return false;
          }
        }
      }
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
    return () => { tmuxGuide.cancel(); terminal.textarea?.removeEventListener('blur', tmuxGuide.cancel); terminal.textarea?.removeEventListener('focus', anchorToast); terminal.textarea?.removeEventListener('blur', releaseToast); releaseToast(); clearTimeout(retryTimer); clearTimeout(watchTimer); clearTimeout(composedEnter); clearTimeout(anchorTimer); checkAgent.current = () => {}; flushQueue.current = () => {}; scrollAfterReplay.current = () => {}; cancelAnimationFrame(scrollFrame); progress.dispose(); osc52.dispose(); pasteHost.removeEventListener('paste', pasteImage, true); pasteHost.removeEventListener('contextmenu', rightClick); pasteHost.removeEventListener('dragover', dragFiles); pasteHost.removeEventListener('drop', dropFiles); observer.disconnect(); bus.listeners.delete(id); bus.sizeListeners.delete(id); clearTimeout(otherTimer); claimSize.current = () => {}; layoutRef.current = () => {}; webglRef.current = null; terminal.dispose(); term.current = null; };
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
  const agent = exited ? undefined : agentOf(id), agentState = !agent ? undefined : attention[id] ?? (workingSet.has(id) ? 'working' : 'idle'), canChat = !isSsh && (agent === 'codex' || agent === 'cursor' || agent === 'claude' && attention[id] !== 'attention' && !workingSet.has(id));
  // Points at the Chat switch once; held back while the "try Chat" card (chatTipPending) is up so only one thing asks for attention.
  const hint = useTipNotice(`hint:${id}`, hintCandidates(settings, [['tochat', focused && visible && canChat && !settings.chatTipPending]]));
  const hintSeen = () => { if (!settings.hintsSeen.includes('tochat')) chat.onSettingsChange({ ...settings, hintsSeen: [...settings.hintsSeen, 'tochat'] }); };
  return <section className={`terminal-pane ${focused ? 'focused' : ''} ${exited ? 'exited' : ''}`} data-feedback-region="터미널 pane" data-ssh={isSsh ? '' : undefined} data-agent={agent} data-agent-state={agentState} onMouseDownCapture={() => onFocus(id)} onFocus={() => onFocus(id)}>
    <div className="pane-tools" role="toolbar" aria-label="터미널 pane">
      {agent === 'claude' && settings.cacheTimer && caches[id] && <CacheTimer cache={caches[id]} working={workingSet.has(id)} warn={settings.cacheWarn} />}
      {switchingToChat && agentState !== 'attention' ? <span className="pane-tip" role="status" onClick={() => setSwitchingToChat(false)}>Chat으로 전환하는 중…</span> : <span className="pane-title" data-copy={agent ? '' : undefined} title={agent ? `세션 ID 복사\n${cwds[id] ?? ''}` : cwds[id]} onClick={agent ? () => void chat.call<{ sessionId: string | null }>('terminal/session', { id, agent }).then(({ sessionId }) => sessionId ? copyText(sessionId) : chat.fail(new Error('아직 세션 ID를 알 수 없습니다. 대화를 시작한 뒤 다시 눌러 주세요.')), chat.fail) : undefined}><span className="pane-mark"><Icon name={agent || 'terminal'} size={12} /></span><span className="pane-label">{label}</span>{agentState === 'attention' && <span className="question-alert" role="img" aria-label="응답 필요" title="질문, 승인 대기"><Icon name="alert" size={15} /></span>}</span>}
      <span className="pane-actions">
        {canChat && <><IconButton icon="claude-chat" tip="header" label="Chat으로 전환 (같은 대화 이어가기)" className={hint ? 'hint-anchor' : ''} onClick={() => { hintSeen(); setSwitchingToChat(true); onToChat(id); }} /><i className="pane-sep" aria-hidden="true" /></>}
        <SplitButton keys={{ row: showAppKey(settings.appKeys, 'splitRight'), column: showAppKey(settings.appKeys, 'splitDown') }} onSplit={direction => onSplit(id, direction)} />
        <IconButton icon={zoomed ? 'minimize' : 'maximize'} tip="header" label={zoomed ? '원래 크기로' : '최대화'} keys={showAppKey(settings.appKeys, 'zoom')} onClick={() => onZoom(id)} />
        <IconButton icon="x" label="터미널 종료" onClick={() => onClose(id)} /></span></div>
    <div ref={host} className="xterm-host" />
    {mobile && !exited && <div className="term-keys" role="toolbar" aria-label="터미널 보조 키" onPointerDown={event => event.preventDefault() /* keep the keyboard and focus on the terminal */}>
      {TERMINAL_KEYS.map(key => <button key={key.id} type="button" aria-label={key.aria} aria-pressed={key.ctrl ? ctrl : undefined}
        onClick={() => {
          const terminal = term.current; if (!terminal) return;
          remoteHaptic();
          if (key.ctrl) { ctrlArmed.current = !ctrlArmed.current; setCtrl(ctrlArmed.current); terminal.focus(); return; }
          terminal.input(key.data!, true); terminal.focus();
        }}>{key.label}</button>)}
    </div>}
    {hint && <Hint title="언제든 Chat으로 전환할 수 있어요" text="이 버튼을 누르면 지금 대화를 Chat 화면에서 그대로 이어가요. 코드 변경과 도구 실행을 한눈에 볼 수 있어요." onDone={hintSeen} />}
    {tmuxPlace && <TmuxGuide prefix={settings.tmuxPrefix} place={tmuxPlace} />}
    {otherSize && !exited && <div className="pane-size-note" role="status">
      <span>다른 기기 크기로 표시 중, 입력하면 이 창 크기로 돌아옵니다</span>
      <button onClick={() => claimSize.current()}>이 창에 맞추기</button></div>}
    {queued.length > 0 && <div className="claude-follow-up">
      <div className="follow-up-heading" role="status">Follow-up {queued.length}개, 현재 작업 완료 후 순서대로 전송</div>
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
          <IconButton icon="edit" label="Follow-up 수정" onClick={() => setEditing({ id: item.id, text: item.text })} />
          <IconButton icon="x" label="Follow-up 취소" onClick={() => { followUp.current.remove(item.id); if (editing?.id === item.id) setEditing(null); refreshQueue(); }} /></li>)}</ol>
    </div>}
    {exited && <div className="pane-exited">프로세스가 종료되었습니다 <button onClick={() => onClose(id)}>pane 닫기</button></div>}
  </section>;
}

// `diff:<revision>:<path>[\t<old path>]`, opened from the Git tool window: a commit, `a..b` (two commits) or `a..` (against the working tree).
const diffParts = (spec: string) => { const [, kind, ...rest] = spec.split(':'), [path, original] = rest.join(':').split('\t'); return { kind, path, original, full: rest.join(':') }; };
const revisionLabel = (kind: string) => {
  const [from, to] = kind.split('..');
  return !kind.includes('..') ? kind.slice(0, 8) : to ? `${from.slice(0, 7)}..${to.slice(0, 7)}` : `${from.slice(0, 7)} ↔ 작업 트리`;
};
function DiffTab({ spec, ctx }: { spec: string; ctx: EditorCtx }) {
  const { kind, path, full } = diffParts(spec);
  const [value, setValue] = useState<{ original: string; modified: string } | null>(null), [error, setError] = useState('');
  useEffect(() => { ctx.loadDiff(kind, full).then(setValue, cause => setError(String(cause.message || cause))); }, [kind, full, ctx.gitVersion]);
  if (error) return <div className="empty">{error}</div>;
  return value ? <DiffView original={value.original} modified={value.modified} path={path} settings={ctx.settings} onLayoutChange={ctx.onDiffLayoutChange} /> : <div className="empty">불러오는 중…</div>;
}

// A file tab shows a dot where the close button is while its buffer has edits that are not on disk (like VS Code); pointing at it brings the close button back.
function EditorTab({ spec, file, name, active, buffer, onSelect, onClose }: { spec: string; file: string; name: string; active: boolean; buffer?: FileBuffer; onSelect(): void; onClose(): void }) {
  const dirty = useSyncExternalStore(buffer?.subscribe ?? noSubscribe, () => Boolean(buffer?.dirty));
  return <div role="tab" aria-selected={active} className={`tab ${active ? 'active' : ''} ${dirty ? 'dirty' : ''}`} onClick={onSelect} onAuxClick={event => { if (event.button === 1) onClose(); }}>
    {file ? <FileIcon name={name} size={14} /> : <Icon name="diff" size={13} />}<span title={file || spec}>{name}</span>
    <button className={dirty ? 'unsaved' : undefined} aria-label={`${file || spec} 닫기${dirty ? ' (저장하지 않은 변경 사항 있음)' : ''}`} onClick={event => { event.stopPropagation(); onClose(); }}>{dirty && <i aria-hidden="true" />}<Icon name="x" size={13} /></button></div>;
}
const noSubscribe = () => () => {};

function EditorGroup({ leaf, focused, zoomed, visible, ctx, onFocus, onZoom }: { leaf: Leaf; focused: boolean; zoomed: boolean; visible: boolean; ctx: EditorCtx; onFocus(id: string): void; onZoom(id: string): void }) {
  const tabs = leaf.tabs || [], active = leaf.active && tabs.includes(leaf.active) ? leaf.active : tabs[0] || '';
  const label = (spec: string) => { const { kind, path } = diffParts(spec); return `${basename(path)} (${revisionLabel(kind)})`; };
  const path = active.startsWith('file:') ? active.slice(5) : '';
  return <section className={`editor-group ${focused ? 'focused' : ''}`} data-feedback-region="편집기 pane" onMouseDownCapture={() => onFocus(leaf.id)}>
    <header className="tab-strip"><div className="tabs" role="tablist">{tabs.map(spec => {
      const file = spec.startsWith('file:') ? spec.slice(5) : '';
      return <EditorTab key={spec} spec={spec} file={file} name={file ? basename(file) : label(spec)} active={spec === active} buffer={file ? ctx.fileBuffer(file) : undefined}
        onSelect={() => ctx.onSelectTab(leaf.id, spec)} onClose={() => ctx.onCloseTab(leaf.id, spec)} />;
    })}</div>
      <div className="group-actions"><IconButton icon={zoomed ? 'minimize' : 'maximize'} tip="header" label={zoomed ? '원래 크기로' : '최대화'} action="zoom" onClick={() => onZoom(leaf.id)} /><IconButton icon="x" label="편집기 패널 닫기" onClick={() => ctx.onCloseGroup(leaf.id)} /></div></header>
    {path ? <FileEditor key={path} buffer={ctx.fileBuffer(path)} settings={ctx.settings} visible={visible} focused={focused} watch={ctx.watchFiles} />
      : active ? <DiffTab key={active} spec={active} ctx={ctx} />
        : <div className="empty"><h2>열린 파일이 없습니다</h2></div>}
  </section>;
}

// `keys` keeps a child mounted when siblings appear or disappear (terminals must not be recreated).
// The pane a split just created grows in with a spring (style.css .split-slot[data-fresh]); the mark expires so a later remount does not replay it.
let freshLeaf = '';
export function markSplit(id: string) { freshLeaf = id; setTimeout(() => { if (freshLeaf === id) freshLeaf = ''; }, 800); }
export function Splitter({ direction, sizes, onSizes, children, keys, equalOnClick, fresh, ids }: { direction: 'row' | 'column'; sizes: number[]; onSizes(sizes: number[]): void; children: ReactNode[]; keys?: string[]; equalOnClick?: boolean; fresh?: boolean[]; ids?: string[] }) {
  const host = useRef<HTMLDivElement>(null);
  function adjust(index: number, delta: number) {
    const sum = sizes[index] + sizes[index + 1], next = [...sizes];
    next[index] = Math.max(sum * .1, Math.min(sum * .9, next[index] + delta)); next[index + 1] = sum - next[index]; onSizes(next);
  }
  return <div className={`split ${direction}`} ref={host}>{children.map((child, index) => <div className="split-slot" key={keys?.[index] ?? index} data-fresh={fresh?.[index] ? direction : undefined} data-leaf={ids?.[index]} data-dir={direction} data-last={index === children.length - 1 || undefined} style={{ flex: sizes[index] || 1 }}>
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

// A pane that closed leaves a copy of itself in its place in the layout (React drops the node but its children stay intact until the passive cleanups run). The copy is a real flex item, so the
// neighbours shrink and grow around it by themselves as it swells a little and then folds away, the mirror of split-grow. (A WebGL terminal's canvas copies blank.)
type Ghost = { el: Element; slot: DOMRect; row: boolean; last: boolean; host: HTMLElement; hostParent: HTMLElement | null; index: number };
function playGhost({ el, slot, row, last, host, hostParent, index }: Ghost) {
  // The split is still there with one slot fewer (3+ panes), or it collapsed into its only pane and the ghost goes next to that pane in the parent.
  const container = host.isConnected ? host : hostParent?.isConnected ? hostParent : null;
  if (!container) return;
  const copy = el.cloneNode(true) as HTMLElement, ghost = document.createElement('div'), before = container.style.flexDirection, axis = row ? 'row' : 'column';
  copy.removeAttribute('id'); copy.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
  copy.inert = true;
  Object.assign(copy.style, { flex: '1 1 0%', minWidth: '0', minHeight: '0', width: 'auto', height: 'auto', margin: '0' });
  ghost.className = 'pane-ghost';
  Object.assign(ghost.style, { flexDirection: axis, justifyContent: last ? 'flex-end' : 'flex-start' });
  const size = row ? slot.width : slot.height;
  ghost.style.flex = `0 0 ${size}px`;
  ghost.append(copy);
  const survivors = [...container.children] as HTMLElement[], flexes = survivors.map(node => node.style.flex); // React owns a slot's inline flex (its size): put it back, never blank it
  if (getComputedStyle(container).flexDirection !== axis) { container.style.flexDirection = axis; survivors.forEach(node => (node.style.flex = '1 1 0%')); }
  container.insertBefore(ghost, host.isConnected ? container.children[index] ?? null : last ? null : container.firstChild);
  const done = () => { ghost.remove(); container.style.flexDirection = before; survivors.forEach((node, i) => (node.style.flex = flexes[i])); };
  ghost.animate([{ flexBasis: `${size}px`, easing: 'ease-out' }, { flexBasis: `${size * 1.07}px`, offset: .22, easing: 'cubic-bezier(.5, 0, .75, 0)' }, { flexBasis: '0px' }], { duration: 380, fill: 'forwards' }).finished.then(done, done);
}
function useCloseGhost(pane: Pane, visible: boolean, zoom: string) {
  const last = useRef(new Map<string, Ghost>()), lastIds = useRef<string[]>([]), lastZoom = useRef(zoom);
  const capture = () => {
    const now = new Map<string, Ghost>();
    for (const leaf of leafList(pane)) {
      const slot = document.querySelector<HTMLElement>(`[data-leaf="${CSS.escape(leaf.id)}"]`), el = slot?.querySelector('.pane-content')?.firstElementChild, rect = slot?.getBoundingClientRect(), host = slot?.parentElement;
      if (slot && el && host && rect?.width && rect.height) now.set(leaf.id, { el, slot: rect, row: slot.dataset.dir === 'row', last: !!slot.dataset.last, host, hostParent: host.parentElement, index: [...host.children].indexOf(slot) });
    }
    return now;
  };
  // Only a pane count that dropped inside one tab and one zoom state counts as a close (a launcher turning into a terminal, a tab switch and zooming all change ids without closing anything).
  // The ids come from the tree, not the DOM: the last pane left of a split sits in no slot at all.
  // Only when the layout, visibility or zoom changed: this ran after every render (focus moves, titles) and each run measured every pane, forcing a layout. The timer below keeps the stored rects fresh.
  const seen = useRef<{ pane?: Pane; visible?: boolean; zoom?: string }>({});
  useLayoutEffect(() => {
    if (seen.current.pane === pane && seen.current.visible === visible && seen.current.zoom === zoom) return;
    seen.current = { pane, visible, zoom };
    const ids = leafList(pane).map(leaf => leaf.id), before = last.current;
    if (visible && zoom === lastZoom.current && ids.length < lastIds.current.length && ids.some(id => lastIds.current.includes(id)) && !matchMedia('(prefers-reduced-motion: reduce)').matches) for (const [id, ghost] of before) if (!ids.includes(id)) playGhost(ghost);
    last.current = capture(); lastIds.current = ids; lastZoom.current = zoom;
  });
  // Stored rects go stale on a window resize, and a pane that is still growing in (split-grow) is stored tiny or not at all, so measure again once it settles.
  useEffect(() => { const refresh = () => { last.current = capture(); }, timer = setTimeout(refresh, 700); window.addEventListener('resize', refresh); return () => { clearTimeout(timer); window.removeEventListener('resize', refresh); }; });
}

// The layout tree owns sizes and dividers. Portals keep each pane mounted when its split parent changes.
function PaneAnchor({ host }: { host: HTMLDivElement }) {
  return <div className="pane-anchor" ref={node => {
    if (node && host.parentNode !== node) node.append(host);
  }} />;
}

// Measure destination slots without moving the live panes between split parents until drop.
function PreviewSlots({ pane }: { pane: Pane }) {
  if (isLeaf(pane)) return <div className="pane-anchor" data-preview-leaf={pane.id} />;
  return <div className={`split ${pane.direction}`}>{pane.children.map((child, index) =>
    <div className="split-slot" key={isLeaf(child) ? child.id : index} style={{ flex: pane.sizes[index] || 1 }}>
      <PreviewSlots pane={child} />
    </div>
  )}</div>;
}

export function Panes(props: Props) {
  const { pane, zoom } = props;
  const hosts = useRef(new Map<string, HTMLDivElement>()).current;
  const { preview, pageRef } = usePaneDrag(pane, props.onLayout, props.visible, zoom, hosts);
  useLayoutEffect(() => {
    if (preview && hosts.has(freshLeaf)) freshLeaf = '';
  }, [preview, hosts]);
  useCloseGhost(pane, props.visible, zoom);
  const displayed = (zoom && findLeaf(pane, zoom)) || pane;
  const leaves = leafList(displayed);
  const ids = new Set(leaves.map(leaf => leaf.id));
  for (const leaf of leaves) {
    if (hosts.has(leaf.id)) continue;
    const host = document.createElement('div');
    host.className = 'pane-content';
    hosts.set(leaf.id, host);
  }
  useLayoutEffect(() => {
    for (const id of hosts.keys()) if (!ids.has(id)) hosts.delete(id);
  });
  return <>
    <div className="pane-layout" ref={pageRef}>
      {preview && <div className="pane-preview" aria-hidden="true"><PreviewSlots pane={preview} /></div>}
      <Tree pane={displayed} onLayout={props.onLayout} hosts={hosts} previewing={!!preview} />
    </div>
    {leaves.map(leaf => createPortal(
      <PaneContent {...props} leaf={leaf} />, hosts.get(leaf.id)!, leaf.id
    ))}
  </>;
}

function Tree({ pane, onLayout, hosts, previewing }: { pane: Pane; onLayout(next: Pane): void; hosts: Map<string, HTMLDivElement>; previewing: boolean }) {
  if (isLeaf(pane)) return <PaneAnchor host={hosts.get(pane.id)!} />;
  return <Splitter equalOnClick ids={pane.children.map(child => isLeaf(child) ? child.id : '')}
    keys={pane.children.map((child, index) => isLeaf(child) ? child.id : String(index))}
    fresh={pane.children.map(child => !previewing && isLeaf(child) && child.id === freshLeaf)}
    direction={pane.direction} sizes={pane.sizes} onSizes={sizes => { if (!previewing) onLayout({ ...pane, sizes }); }}>
    {pane.children.map((child, index) => <Tree pane={child} hosts={hosts} previewing={previewing}
      onLayout={next => onLayout({ ...pane, children: pane.children.map((old, i) => i === index ? next : old) })} />)}
  </Splitter>;
}

const PaneContent = memo(function PaneContent(props: Props & { leaf: Leaf }) {
  const { leaf, focus, zoom, visible, editor, chat, onFocus, onZoom } = props;
  const focused = focus === leaf.id, zoomed = zoom === leaf.id;
  if (leaf.kind === 'editor') return <EditorGroup leaf={leaf} focused={focused} zoomed={zoomed} visible={visible && (!zoom || zoomed)} ctx={editor} onFocus={onFocus} onZoom={onZoom} />;
  if (leaf.kind === 'chat') return <ChatPane leaf={leaf} focused={focused} zoomed={zoomed} visible={visible} ctx={chat} onFocus={onFocus} onZoom={onZoom} onSplit={props.onSplit} />;
  if (leaf.kind === 'launcher') return <LauncherPane onModeChange={props.onModeChange} shell={editor.settings.terminalShell} mode={editor.settings.defaultMode}
    hidden={editor.settings.agentsOff} nudge={editor.settings.chatTipPending} id={leaf.id} focused={focused} onFocus={onFocus} onClose={props.onClose} onLaunch={props.onLaunch} />;
  return <TerminalPane {...props} id={leaf.id} focused={focused} zoomed={zoomed} settings={editor.settings} />;
});
