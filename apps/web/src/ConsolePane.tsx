// A plugin's console tab (plugin API v2 `console`): a person types a command, the plugin runs it and streams the output back.
// Only the desktop window has the bridge; the requests go to the plugin through MoonerADE's main process, never through the
// local server, so a remote screen or a phone cannot drive it (they see a note instead).
import { useEffect, useRef, useState } from 'react';
import { IconButton } from './Icon';
import { PluginIcon, pluginsBridge, usePluginsState, type ConsoleEvent } from './PluginSettings';
import type { Leaf } from './api';

const MAX_OUTPUT = 1024 * 1024, MAX_RUNS = 200, MAX_HISTORY = 100;
// Colour and cursor codes: the output is drawn as plain text.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

type Chunk = { fd: 1 | 2; text: string };
type Run = { id: string; command: string; out: Chunk[]; size: number; state: 'running' | 'done'; prompt: boolean; end?: string; failed?: boolean };

// Every console tab listens on one channel; each keeps only the runs it started.
const listeners = new Set<(event: ConsoleEvent) => void>();
let detach: (() => void) | undefined;
function listen(listener: (event: ConsoleEvent) => void) {
  listeners.add(listener);
  detach ??= pluginsBridge()?.consoleEvents?.(event => { for (const item of listeners) item(event); });
  return () => { listeners.delete(listener); if (!listeners.size) { detach?.(); detach = undefined; } };
}

const ended = (event: ConsoleEvent & { op: 'exit' }) => {
  const time = event.durationMs == null ? '' : event.durationMs < 1000 ? ` · ${event.durationMs}ms` : ` · ${(event.durationMs / 1000).toFixed(1)}s`;
  if (event.timedOut) return { end: `시간 초과${time}`, failed: true };
  if (event.signal) return { end: `${event.signal} 신호로 끝남${time}`, failed: true };
  return { end: `종료 코드 ${event.code ?? '?'}${time}`, failed: event.code !== 0 };
};

export function ConsolePane({ leaf, focused, onFocus, onClose }: { leaf: Leaf; focused: boolean; onFocus(id: string): void; onClose(id: string): void }) {
  const state = usePluginsState(), bridge = pluginsBridge();
  const plugin = state?.plugins.find(item => item.id === leaf.plugin);
  const ready = Boolean(bridge?.console && plugin?.console);
  const [runs, setRuns] = useState<Run[]>([]);
  const [text, setText] = useState(''), [password, setPassword] = useState(''), [save, setSave] = useState(false);
  const history = useRef<string[]>([]), cursor = useRef(-1), scroller = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const mine = useRef(new Set<string>());
  const update = (id: string, change: (run: Run) => Run) => setRuns(list => list.map(run => run.id === id ? change(run) : run));

  useEffect(() => listen(event => {
    if (event.plugin !== leaf.plugin || !mine.current.has(event.run)) return;
    if (event.op === 'out') update(event.run, run => {
      if (run.size >= MAX_OUTPUT) return run;
      const piece = event.data.replace(ANSI, '').slice(0, MAX_OUTPUT - run.size), last = run.out.at(-1);
      const out = last?.fd === event.fd ? [...run.out.slice(0, -1), { fd: event.fd, text: last.text + piece }] : [...run.out, { fd: event.fd, text: piece }];
      return { ...run, out, size: run.size + piece.length, prompt: false };
    });
    else if (event.op === 'prompt') update(event.run, run => ({ ...run, prompt: true }));
    else if (event.op === 'exit' || event.op === 'error') {
      mine.current.delete(event.run);
      update(event.run, run => ({ ...run, state: 'done', prompt: false, ...(event.op === 'exit' ? ended(event) : { end: event.message, failed: true }) }));
    }
  }), [leaf.plugin]);
  // The plugin stopped under its running commands: nothing more will come for them.
  useEffect(() => {
    if (plugin?.state === 'running' || !mine.current.size) return;
    mine.current.clear();
    setRuns(list => list.map(run => run.state === 'running' ? { ...run, state: 'done', prompt: false, end: '플러그인이 멈췄습니다.', failed: true } : run));
  }, [plugin?.state]);
  // Closing the tab stops what it started.
  useEffect(() => () => { for (const run of mine.current) void bridge?.console?.(leaf.plugin!, { op: 'signal', run, signal: 'TERM' }).catch(() => {}); }, []);
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [runs]);

  const send = (request: Parameters<NonNullable<typeof bridge>['console'] & {}>[1]) => bridge?.console?.(leaf.plugin!, request);
  function start() {
    const command = text.trim();
    if (!command || !ready) return;
    const id = crypto.randomUUID();
    mine.current.add(id);
    history.current = [command, ...history.current.filter(item => item !== command)].slice(0, MAX_HISTORY); cursor.current = -1;
    setRuns(list => [...list, { id, command, out: [], size: 0, state: 'running' as const, prompt: false }].slice(-MAX_RUNS));
    setText('');
    send({ op: 'run', run: id, command })?.catch((error: Error) => { mine.current.delete(id); update(id, run => ({ ...run, state: 'done', end: error.message, failed: true })); });
  }
  const running = runs.filter(run => run.state === 'running'), asking = running.find(run => run.prompt);
  const stop = (run: Run) => void send({ op: 'signal', run: run.id, signal: 'INT' })?.catch(() => {});
  function answer() {
    if (!asking) return;
    void send({ op: 'password', run: asking.id, ...(password && { value: password, save }) })?.catch(() => {});
    update(asking.id, run => ({ ...run, prompt: false }));
    setPassword(''); input.current?.focus();
  }
  function onKey(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); start(); return; }
    if (event.key === 'c' && event.ctrlKey && !window.getSelection()?.toString() && running.length) { event.preventDefault(); stop(running.at(-1)!); return; }
    const el = event.currentTarget, single = !el.value.includes('\n');
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && single && history.current.length) {
      event.preventDefault();
      cursor.current = Math.max(-1, Math.min(history.current.length - 1, cursor.current + (event.key === 'ArrowUp' ? 1 : -1)));
      setText(cursor.current < 0 ? '' : history.current[cursor.current]);
    }
  }

  const note = !bridge?.console ? '이 화면에서는 쓸 수 없습니다. PC의 MoonerADE에서 여세요.'
    : !plugin ? '플러그인을 찾을 수 없습니다.' : !plugin.console ? '플러그인이 실행 중이 아닙니다.' : null;
  return <section className={`terminal-pane console-pane ${focused ? 'focused' : ''}`} data-feedback-region="콘솔 pane" onMouseDownCapture={() => onFocus(leaf.id)} onFocus={() => onFocus(leaf.id)}>
    <div className="pane-tools" role="toolbar" aria-label="콘솔">
      <span className="pane-title"><span className="pane-mark">{plugin ? <PluginIcon plugin={plugin} size={12} /> : null}</span><span className="pane-label">{plugin?.name ?? '콘솔'}</span></span>
      <span className="pane-actions">{runs.length > 0 && !running.length && <IconButton icon="trash" label="지우기" onClick={() => setRuns([])} />}<IconButton icon="x" label="pane 닫기" onClick={() => onClose(leaf.id)} /></span>
    </div>
    <div className="console-scroll" ref={scroller}>
      {runs.map(run => <div key={run.id} className="console-run" data-state={run.state} data-failed={run.failed || undefined}>
        <div className="console-command"><span aria-hidden="true">$</span><span>{run.command}</span>
          {run.state === 'running' && <button type="button" className="console-stop" onClick={() => stop(run)}>중지</button>}</div>
        {run.out.length > 0 && <pre className="console-out">{run.out.map((chunk, index) => <span key={index} data-fd={chunk.fd}>{chunk.text}</span>)}</pre>}
        {run.size >= MAX_OUTPUT && <div className="console-end">출력이 1MB를 넘어 나머지는 표시하지 않습니다.</div>}
        {run.end && <div className="console-end">{run.end}</div>}
      </div>)}
    </div>
    <div className="console-dock">
      {note && <div className="console-note">{note}</div>}
      {asking && <form className="console-password" onSubmit={event => { event.preventDefault(); answer(); }}>
        <span>sudo 비밀번호</span>
        <input type="password" autoFocus value={password} placeholder="비우면 저장한 비밀번호" aria-label="sudo 비밀번호" onChange={event => setPassword(event.target.value)} />
        <label><input type="checkbox" checked={save} disabled={!password} onChange={event => setSave(event.target.checked)} />저장</label>
        <button type="submit" className="primary">입력</button>
      </form>}
      <div className="chat-composer console-composer">
        <textarea ref={input} rows={1} value={text} disabled={!ready} placeholder={ready ? '명령' : ''} aria-label="명령" spellCheck={false}
          onChange={event => { setText(event.target.value); cursor.current = -1; }} onKeyDown={onKey} />
      </div>
    </div>
  </section>;
}
