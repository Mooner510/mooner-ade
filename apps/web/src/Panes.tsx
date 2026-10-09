import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { basename, findLeaf, isDiffTab, isLeaf, type Leaf, type Pane } from './api';
import { DiffView, EditorView, type Reveal, type Settings } from './Editor';

export type TerminalFeed = { data: string; sequence: number; reset?: boolean; exited?: boolean };
export type TerminalBus = { buffers: Map<string, TerminalFeed>; listeners: Map<string, (feed: TerminalFeed) => void> };
export type EditorCtx = {
  docs: { path: string; content: string; saved: string; external?: boolean }[]; settings: Settings; reveal: Record<string, Reveal>; gitVersion: number;
  onChange(path: string, value: string): void; onSave(): void; onCursor(line: number, column: number): void;
  onSelectTab(group: string, path: string): void; onCloseTab(group: string, path: string): void; onPin(group: string, path: string): void;
  onSplitEditor(group: string, direction: 'row' | 'column'): void; onCloseGroup(group: string): void;
  loadDiff(kind: string, path: string): Promise<{ original: string; modified: string }>;
};
type Props = {
  pane: Pane; onLayout(pane: Pane): void; send(message: object): void; bus: TerminalBus; live: Set<string>; cwds: Record<string, string>; focus: string; zoom: string;
  onFocus(id: string): void; onZoom(id: string): void; onSplit(id: string, direction: 'row' | 'column'): void; onClose(id: string): void; editor: EditorCtx;
};

function TerminalPane({ id, send, bus, live, cwds, focused, zoomed, onFocus, onZoom, onSplit, onClose }: Pick<Props, 'send' | 'bus' | 'live' | 'cwds' | 'onFocus' | 'onZoom' | 'onSplit' | 'onClose'> & { id: string; focused: boolean; zoomed: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const callbacks = useRef({ send, onSplit }); callbacks.current = { send, onSplit };
  useEffect(() => {
    const terminal = new Terminal({ fontSize: 12, cursorBlink: true, scrollback: 3000, theme: { background: getComputedStyle(document.documentElement).getPropertyValue('--terminal-bg').trim() || '#1e1e1e' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current!); term.current = terminal;
    let sequence = 0;
    const receive = (feed: TerminalFeed) => {
      if (feed.reset) { terminal.reset(); sequence = 0; }
      if (feed.sequence > sequence || feed.reset) { terminal.write(feed.data); sequence = feed.sequence; }
      if (feed.exited) terminal.write('\r\n[프로세스 종료]\r\n');
    };
    const initial = bus.buffers.get(id); if (initial) receive({ ...initial, reset: true });
    bus.listeners.set(id, receive);
    terminal.onData(data => callbacks.current.send({ type: 'terminal/input', id, data }));
    terminal.attachCustomKeyEventHandler(event => {
      if (event.ctrlKey && event.code === 'KeyD') {
        if (event.type === 'keydown') { event.preventDefault(); callbacks.current.onSplit(id, event.shiftKey ? 'column' : 'row'); }
        return false;
      }
      return true;
    });
    const resize = () => { if (!host.current?.clientWidth || !host.current.clientHeight) return; fit.fit(); callbacks.current.send({ type: 'terminal/resize', id, cols: terminal.cols, rows: terminal.rows }); };
    const observer = new ResizeObserver(resize); observer.observe(host.current!); resize();
    return () => { observer.disconnect(); bus.listeners.delete(id); terminal.dispose(); term.current = null; };
  }, [id, bus]);
  useEffect(() => { if (focused) term.current?.focus(); }, [focused]);
  return <section className={`terminal-pane ${focused ? 'focused' : ''}`} onMouseDownCapture={() => onFocus(id)} onFocus={() => onFocus(id)}>
    <header><span title={cwds[id]}>{cwds[id] ? basename(cwds[id]) : id.slice(0, 6)} · {live.has(id) ? '실행 중' : '종료됨 / 복원 불가'}</span>
      <button onClick={() => onSplit(id, 'row')} aria-label="좌우 분할" title="좌우 분할 (Ctrl+D)">↔</button><button onClick={() => onSplit(id, 'column')} aria-label="상하 분할" title="상하 분할 (Ctrl+Shift+D)">↕</button>
      <button onClick={() => onZoom(id)} aria-label="최대화" title="최대화 전환 (Ctrl+Shift+Enter)">{zoomed ? '▣' : '□'}</button>
      <button disabled={!live.has(id)} onClick={() => send({ type: 'terminal/input', id, data: '\x04' })}>EOF</button><button onClick={() => onClose(id)} aria-label="터미널 종료">×</button></header>
    <div ref={host} className="xterm-host" />
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
        <span>{label(path)}</span><button aria-label={`${path} 닫기`} onClick={event => { event.stopPropagation(); ctx.onCloseTab(leaf.id, path); }}>{dirty ? '●' : '×'}</button></div>;
    })}</div>
      <div className="group-actions"><button aria-label="편집기 좌우 분할" title="편집기 분할 (Ctrl+\)" onClick={() => ctx.onSplitEditor(leaf.id, 'row')}>↔</button><button aria-label="편집기 상하 분할" onClick={() => ctx.onSplitEditor(leaf.id, 'column')}>↕</button>
        <button aria-label="최대화" onClick={() => onZoom(leaf.id)}>{zoomed ? '▣' : '□'}</button><button aria-label="편집기 그룹 닫기" onClick={() => ctx.onCloseGroup(leaf.id)}>×</button></div></header>
    {doc?.external && <div className="notice">디스크에서 파일이 바뀌었습니다. 저장하면 비교 화면이 열립니다.</div>}
    {active && isDiffTab(active) ? <DiffTab key={active} spec={active} ctx={ctx} />
      : doc ? <EditorView group={leaf.id} path={doc.path} value={doc.content} settings={ctx.settings} onChange={ctx.onChange} onSave={ctx.onSave} onCursor={ctx.onCursor} onFocus={() => onFocus(leaf.id)} reveal={ctx.reveal[leaf.id]} />
      : <div className="empty"><h2>파일을 열어 시작하세요</h2><p>Ctrl/⌘+P로 파일을 열거나 탐색기에서 선택하세요.</p></div>}
  </section>;
}

export function Splitter({ direction, sizes, onSizes, children }: { direction: 'row' | 'column'; sizes: number[]; onSizes(sizes: number[]): void; children: ReactNode[] }) {
  const host = useRef<HTMLDivElement>(null);
  function adjust(index: number, delta: number) {
    const sum = sizes[index] + sizes[index + 1], next = [...sizes];
    next[index] = Math.max(sum * .1, Math.min(sum * .9, next[index] + delta)); next[index + 1] = sum - next[index]; onSizes(next);
  }
  return <div className={`split ${direction}`} ref={host}>{children.map((child, index) => <div className="split-slot" key={index} style={{ flex: sizes[index] || 1 }}>
    {child}{index < children.length - 1 && <div className="divider" role="separator" tabIndex={0} aria-label="패널 크기" aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'} aria-valuenow={Math.round(sizes[index] * 100 / sizes.reduce((a, b) => a + b, 0))}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); adjust(index, sizes.reduce((a, b) => a + b, 0) * (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -.03 : .03)); } }}
      onPointerDown={event => {
        event.preventDefault(); const divider = event.currentTarget; divider.setPointerCapture(event.pointerId);
        const start = direction === 'row' ? event.clientX : event.clientY;
        const extent = direction === 'row' ? host.current!.clientWidth : host.current!.clientHeight;
        const move = (e: PointerEvent) => adjust(index, ((direction === 'row' ? e.clientX : e.clientY) - start) / extent * sizes.reduce((a, b) => a + b, 0));
        const up = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', up); divider.removeEventListener('pointercancel', up); };
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
    : <TerminalPane {...props} id={pane.id} focused={props.focus === pane.id} zoomed={props.zoom === pane.id} />;
  return <Splitter direction={pane.direction} sizes={pane.sizes} onSizes={sizes => props.onLayout({ ...pane, sizes })}>
    {pane.children.map((child, index) => <Tree key={isLeaf(child) ? child.id : index} {...props} pane={child} onLayout={next => props.onLayout({ ...pane, children: pane.children.map((old, i) => i === index ? next : old) })} />)}
  </Splitter>;
}
