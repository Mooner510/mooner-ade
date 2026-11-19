import { memo, useEffect, useMemo, useState } from 'react';
import type { Item } from './chat-model';
import { shellDuration, shellStalled, shellVerdict, stripAnsi, terminalAdvice } from './chat-shell';
import { Collapse } from './Collapse';
import { Icon } from './Icon';
import { CodeBlock } from './Markdown';
import { copyText } from './toast';

type ShellItem = Extract<Item, { kind: 'shell' }>;
// What the card draws at once; "전체 보기" shows the rest. The stored record is never cut: the whole output stays in the chat's events and "복사" copies all of it.
const CLIP = 6000, WHOLE = 400_000;
const SHELL_LANG = (shell?: string) => /pwsh|powershell|cmd|명령/i.test(shell ?? '') ? 'powershell' : 'bash';
const tail = (value: string, max: number) => value.length > max ? `… (앞의 ${(value.length - max).toLocaleString()}자 생략)\n${value.slice(-max)}` : value;

function Stream({ label, text, error }: { label: string; text: string; error?: boolean }) {
  const [full, setFull] = useState(false), clean = useMemo(() => stripAnsi(text).replace(/\n+$/, ''), [text]);
  if (!clean) return null;
  const lines = clean.split('\n').length, long = clean.length > CLIP || lines > 24;
  const shown = full ? (clean.length > WHOLE ? `${clean.slice(0, WHOLE)}\n… (화면에는 앞의 ${WHOLE.toLocaleString()}자만 그립니다. 나머지 ${(clean.length - WHOLE).toLocaleString()}자는 기록에 있고 복사로 가져갈 수 있습니다)` : clean) : tail(clean, CLIP);
  return <div className={`chat-tool-result chat-shell-stream${error ? ' stderr' : ''}`}>
    <div className="chat-tool-result-head"><small>{label}{lines > 1 && ` · ${lines.toLocaleString()}줄`}</small>
      <button type="button" className="chat-tool-copy" aria-label={`${label} 복사`} onClick={() => copyText(stripAnsi(text).replace(/\n+$/, ''))}><Icon name="copy" size={13} />복사</button></div>
    <pre className={full ? 'full' : undefined}>{shown}</pre>
    {long && <button type="button" className="chat-command-more" onClick={() => setFull(value => !value)}>{full ? '접기' : '전체 보기'}</button>}
  </div>;
}

/** A `!command` the user ran from the composer: command, how it ended, and its output. Drawn like a tool card, but it is the user's own run (no approval, not the agent's). */
// `note`: only the newest `!` card carries the "goes to the agent with your next message" line (`pending` = how many waiting cards it covers).
export const ShellCard = memo(function ShellCard({ item, onStop, enter, note }: { item: ShellItem; onStop(id: string): void; enter?: true; note?: { pending: number } }) {
  const [open, setOpen] = useState(true), running = item.status === 'running';
  // Elapsed time and the "waiting for input?" hint need a clock only while the run is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!running) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [running]);
  const verdict = shellVerdict(item), stalled = shellStalled(item, now), advice = terminalAdvice(item, stalled);
  const state = running ? 'running' : item.status === 'done' ? 'done' : item.status === 'stopped' || item.status === 'interrupted' ? 'refused' : 'error';
  const ms = running ? now - item.startedAt : item.ms, empty = !item.stdout.trim() && !item.stderr.trim();
  return <div className={`chat-tool chat-shell ${state}`} data-tool="UserShell" data-shell-status={item.status} data-enter={enter}>
    <button type="button" className="chat-tool-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="icon material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">terminal</span>
      <strong>!</strong><span className="chat-tool-summary" title={item.command}>{item.command.split('\n')[0]}</span>
      <span className={`chat-shell-verdict ${verdict.tone}`}>{verdict.text}{ms != null && ` · ${shellDuration(ms)}`}</span>
      <span className="chat-tool-state" aria-label={verdict.text}>
        {running ? <><span className="stop-task" role="button" tabIndex={0} title="이 명령 중단" aria-label="이 명령 중단" onClick={event => { event.stopPropagation(); onStop(item.id); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onStop(item.id); } }} /><i className="chat-spin" /></>
          : state === 'done' ? <Icon name="check" size={13} /> : state === 'error' ? <Icon name="x" size={13} /> : <Icon name="block" size={13} />}
      </span>
      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
    </button>
    <Collapse open={open}><div className="chat-tool-body">
      <CodeBlock code={item.command} lang={SHELL_LANG(item.shell)} />
      <p className="chat-shell-where"><span title={item.cwd}>{item.cwd}</span>{item.shell && <span> · {item.shell}</span>}</p>
      <Stream label="출력" text={item.stdout} />
      <Stream label="오류 출력" text={item.stderr} error />
      {!running && empty && item.status !== 'error' && <p className="chat-tool-note">(출력 없음)</p>}
      {item.error && <p className="chat-tool-note">{item.error}</p>}
      {advice && <p className="chat-tool-note chat-shell-advice"><Icon name="terminal" size={13} />{advice}</p>}
      {note && !running && item.status !== 'error' && <p className="chat-tool-note chat-shell-sent">{item.sent ? '다음 메시지와 함께 에이전트에게 전달했습니다.' : note.pending > 1 ? `위 실행 결과 ${note.pending}건이 다음에 보내는 메시지와 함께 에이전트에게 전달됩니다.` : '다음에 보내는 메시지와 함께 에이전트에게 전달됩니다.'}</p>}
    </div></Collapse>
  </div>;
});
