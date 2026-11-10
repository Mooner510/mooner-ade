import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { basename, type Leaf } from './api';
import { DiffView, usageHue, type Settings } from './Editor';
import { placeAbove, UsageRows, usageHueStyle, useUsage } from './Usage';
import { Icon, IconButton } from './Icon';
import { ChatStatusLine } from './ChatStatus';
import { CodeBlock, Markdown } from './Markdown';
import { chatKey, pickGreeting, comboOf, showCombo, compact, contextEnds, contextPercent, contextWindow, cursorSettingName, effortLabel, effortLevel, effortStyle, efforts, emptyView, fromReplay, cursorModelGroups, displayModel, isCursorEffort, isCursorMax, isCursorSwitch, maxOffValue, maxOnValue, maxSelected, modelProvider, modelAppearance, modelRows, modelValue, permissionLabels, reduce, shortModel, toolSummary, type Approval, type Block, type CatalogModel, type ChatState, type ChatView, type Item } from './chat-model';
import { copyText, toastAttached } from './toast';
import { Dropdown, Modal, ModelLabel } from './views';

// What the workspace gives a chat pane. `subscribe` delivers this chat's websocket messages (`chat/event`, `chat/state`) and
// `reconnect` after the socket came back, which makes the pane ask the server for what it missed.
export type ChatCtx = {
  call<T = any>(action: string, input?: object): Promise<T>;
  subscribe(id: string, handler: (message: any) => void): () => void;
  settings: Settings; root: string; projectId: string; branch: string; switchBranch(): void;
  onState(id: string, state: ChatState): void; onTitle(id: string, title: string): void; onClose(id: string): void; onOpenSettings(): void;
  pick(title: string, items: { id: string; label: string }[]): Promise<string | null>; fail(cause: unknown): void;
  // Branch: opens a copy of chat `id` up to one assistant message as a new tab.
  branchChat(id: string, uuid: string, cwd?: string): Promise<void>;
  // Continue this conversation in a terminal (`claude --resume`); the server refuses unless the chat is idle.
  toTerminal(id: string): void;
  resumeChat(id: string, agent: 'claude' | 'codex' | 'cursor'): Promise<void>;
  // Continue a conversation made with the plain `claude` CLI as a new chat tab.
  importCliChat(sessionId: string): Promise<void>;
};
type Props = { leaf: Leaf; focused: boolean; zoomed: boolean; visible: boolean; ctx: ChatCtx; onFocus(id: string): void; onZoom(id: string): void; onSplit(id: string, direction: 'row' | 'column'): void };
type Attachment = { mime: string; data: string; url: string };
type CommandInfo = { name: string; description: string };

const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const MODE_ICONS: Record<string, string> = { default: 'shield', acceptEdits: 'edit_note', plan: 'assignment', bypassPermissions: 'bolt', ask: 'help' };
const cycleMode = (modes: string[], mode: string) => { const ring = modes.filter(item => item !== 'bypassPermissions'); return ring[(ring.indexOf(mode) + 1) % ring.length]; };
// Shift+Tab cycles like Claude Code: ask -> accept edits -> plan -> ask. `모두 허용` is never reached by cycling (it is chosen on purpose), but cycling leaves it.
const nextMode = (mode: string) => ({ default: 'acceptEdits', acceptEdits: 'plan' } as Record<string, string>)[mode] ?? 'default';
// What the CLI offers, asked of the local server once per page load (chat/models: alias -> concrete id, plus the CLI's own model list).
// Until it answers (or when the CLI has no list), the three aliases and Fable stand in.
const baseCatalog = (aliases: Record<string, string> = {}): CatalogModel[] => [
  ...['opus', 'sonnet', 'haiku'].map(alias => ({ id: aliases[alias] ?? alias, name: aliases[alias] ? shortModel(aliases[alias]) : alias[0].toUpperCase() + alias.slice(1), family: alias, window: 1_000_000, main: true })),
  { id: 'claude-fable-5-2', name: 'Fable 5.2', family: 'fable', window: 1_000_000, main: true }];
const MORE_MODELS = '__more__';
// The quick menu: the models the CLI marks as main (newest first), the current one if it is not among them, then "more models".
function modelOptions(model: string | null, catalog = baseCatalog(), aliases: Record<string, string> = {}, agent?: string) {
  const all = modelRows(catalog, aliases), quick = all.filter(row => row.main), current = modelValue(model, aliases), known = all.find(row => row.value === current);
  return [...quick.map(row => ({ value: row.value, label: row.label, ...modelAppearance(`${row.family} ${row.id} ${row.label}`, agent) })),
    ...(current && !quick.some(row => row.value === current) ? [{ value: current, label: known?.label ?? shortModel(model), ...modelAppearance(`${known?.family ?? ''} ${model}`, agent) }] : []),
    { value: MORE_MODELS, label: '더 많은 모델…', icon: 'apps', divider: true }];
}

type SavedChat = { id: string; title: string; model: string | null; updatedAt: number };
type CliChat = { sessionId: string; title: string; updatedAt: number; size: number; running: boolean; chatId: string | null };
const when = (time: number) => new Date(time).toLocaleString();
const sizeOf = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
// "이전 대화 불러오기": this project's saved ADE chats, and (Claude only) conversations made with the plain `claude` CLI.
function ResumeModal({ agent, exclude, call, onPick, onClose }: { agent: 'claude' | 'codex' | 'cursor'; exclude: string; call: ChatCtx['call']; onPick(choice: { kind: 'chat'; id: string } | { kind: 'cli'; sessionId: string }): void; onClose(): void }) {
  const hasCli = agent === 'claude', panelId = useId(), search = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'ade' | 'cli'>('ade'), [query, setQuery] = useState('');
  const [saved, setSaved] = useState<SavedChat[] | null>(null), [cli, setCli] = useState<CliChat[] | null>(null), [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { search.current?.focus(); }, []);
  useEffect(() => { void call<SavedChat[]>('chat/sessions', { agent, exclude }).then(setSaved, cause => { setSaved([]); setFailed(String(cause?.message ?? cause)); }); }, [call, agent, exclude]);
  useEffect(() => {
    if (tab !== 'cli' || cli !== null) return;
    void call<CliChat[]>('chat/cli-sessions', {}).then(setCli, cause => { setCli([]); setFailed(String(cause?.message ?? cause)); });
  }, [tab, cli, call]);
  const needle = query.trim().toLowerCase(), match = (title: string) => !needle || title.toLowerCase().includes(needle);
  const rows = tab === 'ade' ? saved?.filter(item => match(item.title)) : cli?.filter(item => match(item.title) && item.chatId !== exclude);
  const loading = tab === 'ade' ? saved === null : cli === null;
  const tabs = [['ade', 'ADE 대화'], ['cli', 'CLI 대화']] as const;
  return <Modal className="models-modal resume-modal" labelledBy="resume-title" onClose={onClose}>
    <header><h2 id="resume-title">이전 대화 불러오기</h2><button type="button" className="models-close" aria-label="닫기" onClick={onClose}><Icon name="x" size={16} /></button></header>
    <div className="models-controls">
      {hasCli && <div className="ai-tabs models-tabs" role="tablist" aria-label="대화 종류">
        {tabs.map(([key, name], index) => <button type="button" key={key} id={`${panelId}-tab-${index}`} role="tab" aria-selected={tab === key} aria-controls={panelId} tabIndex={tab === key ? 0 : -1}
          onClick={() => setTab(key)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); setTab(tabs[1 - index][0]); document.getElementById(`${panelId}-tab-${1 - index}`)?.focus(); } }}>{name}</button>)}
      </div>}
      <label className="models-search"><Icon name="search" size={15} /><input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="대화 제목 검색" aria-label="대화 제목 검색" /></label>
    </div>
    <div className="models-list resume-list" id={panelId} role={hasCli ? 'tabpanel' : 'listbox'} aria-label="대화">
      {tab === 'ade'
        ? (rows as SavedChat[] | undefined)?.map(item => <button type="button" key={item.id} title={item.title} onClick={() => onPick({ kind: 'chat', id: item.id })}>
            <span className="resume-title">{item.title}</span><span className="resume-meta">{item.model ? `${shortModel(item.model)} · ` : ''}{when(item.updatedAt)}</span></button>)
        : (rows as CliChat[] | undefined)?.map(item => <button type="button" key={item.sessionId} title={item.title} disabled={item.running} onClick={() => onPick(item.chatId ? { kind: 'chat', id: item.chatId } : { kind: 'cli', sessionId: item.sessionId })}>
            <span className="resume-title">{item.title}</span>
            <span className="resume-meta">{item.running ? '터미널에서 실행 중' : item.chatId ? '이미 불러온 대화 · ' + when(item.updatedAt) : `${sizeOf(item.size)} · ${when(item.updatedAt)}`}</span></button>)}
      {!rows?.length && <p className="models-empty">{loading ? '대화를 불러오는 중…' : failed ? `목록을 불러오지 못했습니다: ${failed}` : query ? '검색 결과가 없습니다.' : tab === 'ade' ? '이 프로젝트에 저장된 이전 Chat 대화가 없습니다.' : '이 프로젝트에서 CLI로 나눈 대화가 없습니다.'}</p>}
    </div>
    <footer><span>{rows ? `${rows.length}개 대화` : ''}</span><span>{tab === 'cli' ? 'CLI 기록은 읽기만 하고, 같은 세션을 이어서 씁니다.' : '선택하면 새 탭에서 이어집니다.'}</span></footer>
  </Modal>;
}

// "더 많은 모델": every model the CLI lists (read fresh on open), newest version first, the current one checked.
function ModelsModal({ current, call, agent, fallback, aliases, onPick, onClose }: { current: string; agent: string; fallback: CatalogModel[]; aliases: Record<string, string>; call: ChatCtx['call']; onPick(value: string): void; onClose(): void }) {
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [party, setParty] = useState(modelProvider(current)?.party ?? 'First Party');
  const panelId = useId(), list = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  useEffect(() => { search.current?.focus(); }, []);
  useEffect(() => { void call('chat/model-catalog', { agent }).then((result: any) => setCatalog(result?.catalog ?? []), () => setCatalog([])); }, [call]);
  const rows = useMemo(() => modelRows(catalog?.length ? catalog : fallback, aliases), [catalog, fallback, aliases]);
  const groups = agent === 'cursor' ? cursorModelGroups(rows, party, query) : [{ provider: '', models: rows.filter(row => `${row.label} ${row.id}`.toLowerCase().includes(query.trim().toLowerCase())) }];
  const count = groups.reduce((sum, group) => sum + group.models.length, 0);
  useEffect(() => { list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }); }, [catalog, party]);
  return <Modal className="models-modal" labelledBy="models-title" onClose={onClose}>
    <header><h2 id="models-title">모델 선택</h2><button type="button" className="models-close" aria-label="닫기" onClick={onClose}><Icon name="x" size={16} /></button></header>
    <div className="models-controls">
    {agent === 'cursor' && <div className="ai-tabs models-tabs" role="tablist" aria-label="모델 분류">
      {['First Party', 'Third Party'].map((name, index) => <button type="button" key={name} id={`${panelId}-tab-${index}`} role="tab" aria-selected={party === name} aria-controls={panelId} tabIndex={party === name ? 0 : -1}
        onClick={() => setParty(name)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index; setParty(['First Party', 'Third Party'][next]); document.getElementById(`${panelId}-tab-${next}`)?.focus(); } }}>{name}</button>)}
    </div>}
    <label className="models-search"><Icon name="search" size={15} /><input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="모델 또는 Provider 검색" aria-label="모델 또는 Provider 검색" /></label>
    </div>
    <div ref={list} className="models-list" id={panelId} role={agent === 'cursor' ? 'tabpanel' : 'listbox'} aria-label="모델" aria-labelledby={agent === 'cursor' ? `${panelId}-tab-${party === 'First Party' ? 0 : 1}` : undefined}>
      {groups.map(group => <div className="models-section" key={group.provider} role={agent === 'cursor' ? 'listbox' : undefined} aria-label={group.provider || undefined}>
        {group.provider && <h3 className="models-group"><span>{group.provider}</span><small>{group.models.length}</small></h3>}
        {group.models.map(row => <button type="button" role="option" key={row.value} aria-selected={current === row.value} title={row.id} onClick={() => onPick(row.value)}>
          <span className="models-name" style={{ color: modelAppearance(`${row.family} ${row.id} ${row.label}`, agent).color }}><ModelLabel text={row.label} /></span>{current === row.value && <span className="models-selected"><span>선택됨</span><Icon name="check" size={14} /></span>}
          {agent !== 'cursor' && <span className="models-id">{row.id}{row.oneM ? '[1m]' : ''}</span>}
        </button>)}
      </div>)}
      {!count && <p className="models-empty">{query ? '검색 결과가 없습니다.' : catalog === null ? '모델을 불러오는 중…' : '사용할 수 있는 모델이 없습니다.'}</p>}
    </div>
    <footer><span>{count}개 모델</span><span>{catalog === null ? '목록 갱신 중…' : catalog.length ? '선택하면 이 채팅에 적용됩니다.' : '목록을 갱신하지 못했습니다.'}</span></footer>
  </Modal>;
}
// Handled here instead of being sent: they act on ADE's tab or on the child process. Everything else, custom commands and skills
// included, goes to the provider as typed. /resume opens ADE's saved conversations for this project and provider.
const LOCAL: CommandInfo[] = [
  { name: 'resume', description: '이 프로젝트의 이전 Chat 대화를 불러옵니다' },
  { name: 'clear', description: '새 대화를 시작합니다 (처음 화면으로 돌아갑니다)' }, { name: 'model', description: '모델을 바꿉니다' }, { name: 'effort', description: 'Effort(추론 노력 수준)를 바꿉니다' }, { name: 'permissions', description: '권한 모드를 바꿉니다' },
  { name: 'cost', description: '이 채팅의 비용·토큰을 보여 줍니다' }, { name: 'status', description: '세션 상태를 보여 줍니다' }, { name: 'help', description: '사용할 수 있는 명령을 보여 줍니다' },
  { name: 'config', description: 'ADE 설정을 엽니다' }, { name: 'exit', description: '이 채팅을 닫습니다' }
];
const TOOL_ICONS: Record<string, string> = { Bash: 'terminal', Read: 'description', Write: 'edit_document', Edit: 'edit', MultiEdit: 'edit', Glob: 'search', Grep: 'search', WebFetch: 'language', WebSearch: 'travel_explore', Task: 'account_tree', Agent: 'account_tree', TodoWrite: 'checklist' };
const chatWidths = { narrow: '680px', default: '780px', wide: '1000px', full: '100%' };
const clip = (value: string, max = 6000) => value.length > max ? `${value.slice(0, max)}\n… (${value.length - max}자 생략)` : value;

function ToolCard({ block, result, settings, running }: { block: Extract<Block, { type: 'tool_use' }>; result?: { content: string; isError: boolean }; settings: Settings; running: boolean }) {
  const [open, setOpen] = useState(settings.chatToolsOpen), input = block.input ?? {};
  const edit = block.name === 'Edit' ? [{ from: String(input.old_string ?? ''), to: String(input.new_string ?? '') }] : block.name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits.map((item: any) => ({ from: String(item.old_string ?? ''), to: String(item.new_string ?? '') })) : null;
  const write = block.name === 'Write' ? String(input.content ?? '') : null;
  const patches = Array.isArray(input.changes) ? input.changes.map((item: any) => ({ path: item.path, diff: item.diff })) : Array.isArray(input.content) ? input.content.filter((item: any) => item.type === 'diff').map((item: any) => ({ path: item.path, oldText: item.oldText, newText: item.newText })) : [];
  const state = result ? (result.isError ? 'error' : 'done') : running ? 'running' : 'pending';
  return <div className={`chat-tool ${state}`} data-tool={block.name}>
    <button type="button" className="chat-tool-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="icon material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">{TOOL_ICONS[block.name] ?? 'build'}</span>
      <strong>{block.name}</strong><span className="chat-tool-summary">{toolSummary(block.name, input)}</span>
      <span className="chat-tool-state" aria-label={{ running: '실행 중', done: '완료', error: '오류', pending: '대기' }[state]}>{state === 'running' ? <i className="chat-spin" /> : state === 'done' ? <Icon name="check" size={13} /> : state === 'error' ? <Icon name="alert" size={13} /> : null}</span>
      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
    </button>
    {open && <div className="chat-tool-body">
      {edit ? edit.map((item: { from: string; to: string }, index: number) => <div className="chat-diff" key={index}><DiffView original={item.from} modified={item.to} path={String(input.file_path ?? 'edit')} settings={settings} compact /></div>)
        : write !== null ? <CodeBlock code={clip(write)} lang={basename(String(input.file_path ?? ''))} />
        : block.name === 'Bash' ? <CodeBlock code={String(input.command ?? '')} lang="bash" />
        : patches.length ? null : <CodeBlock code={clip(JSON.stringify(input, null, 2))} lang="json" />}
      {patches.map((patch: any, index: number) => <div className="chat-diff" key={index}>{typeof patch.diff === 'string' ? <CodeBlock code={`${patch.path}\n${patch.diff}`} lang="diff" /> : <DiffView original={patch.oldText ?? ''} modified={patch.newText ?? ''} path={patch.path ?? 'edit'} settings={settings} compact />}</div>)}
      {result && <div className={`chat-tool-result ${result.isError ? 'error' : ''}`}><small>{result.isError ? '오류' : '결과'}</small><pre>{clip(result.content) || '(출력 없음)'}</pre></div>}
    </div>}
  </div>;
}

// Streamed text arrives in bursts; while `active` it is revealed a few characters per frame (faster the bigger the backlog) so it flows instead of jumping.
// The reveal tick is ~30fps because every step re-parses the Markdown. Reduced-motion users get the text as it comes.
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
function useReveal(text: string, active: boolean, smooth: boolean) {
  const [shown, setShown] = useState(active && smooth && !calm() ? 0 : text.length), goal = useRef(text.length); goal.current = text.length;
  useEffect(() => {
    if (!active || !smooth || calm()) { setShown(goal.current); return; }
    let frame = 0, last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < 32) return; last = now;
      setShown(n => n >= goal.current ? n : Math.min(goal.current, n + Math.max(1, Math.ceil((goal.current - n) / 8))));
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, smooth]);
  return active ? text.slice(0, Math.min(shown, text.length)) : text;
}
const Revealed = ({ text, live, markdown, smooth }: { text: string; live: boolean; markdown: boolean; smooth: boolean }) => { const part = useReveal(text, live, smooth); return markdown ? <Markdown text={part} /> : <>{part}</>; };

function Blocks({ blocks, results, settings, live, working }: { blocks: Block[]; results: ChatView['results']; settings: Settings; live?: boolean; working: boolean }) {
  return <>{blocks.map((block, index) => {
    if (block.type === 'text') return block.text.trim() ? <Revealed key={index} text={block.text} live={Boolean(live)} markdown smooth={settings.chatSmoothStream} /> : null;
    if (block.type === 'thinking') return block.text.trim() ? <details key={index} className="chat-thinking" open={settings.chatThinkingOpen === 'always' ? true : settings.chatThinkingOpen === 'never' ? false : live}><summary>생각</summary><p><Revealed text={block.text} live={Boolean(live)} markdown={false} smooth={settings.chatSmoothStream} /></p></details> : null;
    if (block.type === 'tool_use') return <ToolCard key={block.id || index} block={block} result={results[block.id]} settings={settings} running={working} />;
    return null;
  })}</>;
}

const Message = memo(function Message({ item, results, settings, working, final, onBranch, onRewind }: { item: Item; results: ChatView['results']; settings: Settings; working: boolean; final?: boolean; onBranch?(uuid: string): void; onRewind?(uuid: string): void }) {
  if (item.kind === 'user') return <div className="chat-msg user"><div className="chat-bubble">{item.text}{item.images > 0 && <small className="chat-images"><Icon name="copy" size={11} />이미지 {item.images}장</small>}</div></div>;
  if (item.kind === 'divider') return <div className="chat-divider" role="separator"><span>새 대화</span></div>;
  if (item.kind === 'error') return <div className="chat-msg error" role="alert"><Icon name="alert" size={14} /><span>{item.message}</span></div>;
  if (item.kind === 'note') return <div className="chat-msg note"><pre>{item.text}</pre></div>;
  const text = item.blocks.filter((block): block is Extract<Block, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n\n');
  return <div className={`chat-msg assistant ${item.sub ? 'sub' : ''}`}><div className="chat-body"><Blocks blocks={item.blocks} results={results} settings={settings} working={working} /></div>
    {final && <div className="chat-msg-actions">{text.trim() && <IconButton icon="copy" label="응답 복사" size={13} onClick={() => copyText(text)} />}
      {(item.uuid || !onBranch) && <IconButton icon="branch" disabled={!onBranch} label={onBranch ? '여기서 분기 (새 탭에서 이 지점부터 이어가기)' : '이 CLI는 과거 지점 분기를 지원하지 않습니다'} size={13} onClick={() => onBranch?.(item.uuid!)} />}
      {(item.uuid || !onRewind) && <IconButton icon="undo" disabled={!onRewind} label={onRewind ? '여기로 되돌리기 (이후 대화 삭제)' : '이 CLI는 과거 지점 복원을 지원하지 않습니다'} size={13} onClick={() => onRewind?.(item.uuid!)} />}</div>}</div>;
});

function ApprovalCard({ approval, onAnswer }: { approval: Approval; onAnswer(allow: boolean, always: boolean, answers?: Record<string, string[]>): void }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const input = approval.input ?? {}, canAlways = approval.suggestions.length > 0;
  return <div className="chat-approval" role="alertdialog" aria-label={`${approval.tool} 실행 승인`}>
    <header><Icon name="alert" size={15} /><strong>{approval.tool}</strong><span>실행하려면 허용이 필요합니다</span></header>
    <div className="chat-approval-body">{approval.tool === 'Bash' ? <CodeBlock code={String(input.command ?? '')} lang="bash" /> : <p className="chat-approval-line">{toolSummary(approval.tool, input)}</p>}
      {(approval.tool === 'Edit' || approval.tool === 'Write') && <p className="chat-approval-line">{String(input.file_path ?? '')}</p>}</div>
    {typeof input.plan === 'string' && <Markdown text={input.plan} />}
    {approval.questions?.map(question => <fieldset key={question.id}><legend>{question.prompt}</legend>
      {question.options?.map(option => <label key={option.id} title={option.description}><input type={question.allowMultiple ? 'checkbox' : 'radio'} name={`${approval.requestId}-${question.id}`} checked={(answers[question.id] ?? []).includes(option.id)} onChange={event => setAnswers(current => ({ ...current, [question.id]: question.allowMultiple ? event.target.checked ? [...(current[question.id] ?? []), option.id] : (current[question.id] ?? []).filter(id => id !== option.id) : [option.id] }))} />{option.label}</label>)}
      {!question.options?.length && <input type={question.secret ? 'password' : 'text'} aria-label={question.prompt} value={answers[question.id]?.[0] ?? ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: [event.target.value] }))} />}
    </fieldset>)}
    <footer>
      <button type="button" className="primary" autoFocus disabled={approval.questions?.some(q => !answers[q.id]?.length)} onClick={() => onAnswer(true, false, answers)}>{approval.questions ? '답변' : '허용'}</button>
      {canAlways && <button type="button" onClick={() => onAnswer(true, true)} title="비슷한 요청을 이 세션에서 계속 허용합니다">항상 허용</button>}
      <button type="button" onClick={() => onAnswer(false, false)}>거부</button>
    </footer>
  </div>;
}

const fileData = (file: File) => new Promise<Attachment>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => { const url = String(reader.result), data = url.slice(url.indexOf(',') + 1); resolve({ mime: file.type, data, url }); };
  reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
});

export function ChatPane({ leaf, focused, zoomed, visible, ctx, onFocus, onZoom, onSplit }: Props) {
  const id = leaf.id, cwd = leaf.cwd || ctx.root, agent = leaf.agent ?? 'claude', agentLabel = agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : 'Cursor Agent';
  const [agentModels, setAgentModels] = useState<{ models: Record<string, string>; catalog: CatalogModel[] }>({ models: {}, catalog: [] });
  const [view, setView] = useState<ChatView>(emptyView), viewRef = useRef(view); viewRef.current = view;
  // The sidebar title, like a terminal's: the first thing asked since the last /clear (one line); empty until then so the tab keeps its default name.
  const title = useMemo(() => { const from = view.items.map(item => item.kind).lastIndexOf('divider'), first = view.items.slice(from + 1).find(item => item.kind === 'user'); return first?.kind === 'user' ? first.text.replace(/\s+/g, ' ').trim().slice(0, 60) : ''; }, [view.items]);
  useEffect(() => { ctxRef.current.onTitle(id, title); }, [id, title]);
  const [text, setText] = useState(''), [stash, setStash] = useState(''), [images, setImages] = useState<Attachment[]>([]), [queue, setQueue] = useState<{ text: string; images: Attachment[] }[]>([]);
  const [queueSending, setQueueSending] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]), [menuAt, setMenuAt] = useState(0), [openError, setOpenError] = useState(''), [user, setUser] = useState(''), [away, setAway] = useState(false);
  const greeting = useMemo(() => pickGreeting(user), [user, id]);
  const scroller = useRef<HTMLDivElement>(null), box = useRef<HTMLTextAreaElement>(null), stick = useRef(true), jump = useRef(false), ctxRef = useRef(ctx); ctxRef.current = ctx;
  const apply = (next: (view: ChatView) => ChatView) => { const value = next(viewRef.current); viewRef.current = value; setView(value); };
  const state = view.state, caps = state.capabilities, modes = caps?.permissionModes ?? (agent === 'cursor' ? ['default', 'plan', 'ask'] : MODES), effortOptions = caps?.efforts ?? (agent === 'claude' ? efforts : []),
    cursorOptions = agent === 'cursor' ? (caps?.configOptions ?? []).filter(option => option.id !== 'model' && option.id !== 'mode' && option.category !== 'model' && option.category !== 'mode') : [],
    maxOption = cursorOptions.find(option => isCursorMax(option) && option.options.length >= 2), contextOption = cursorOptions.find(option => option.id === 'context'), maxContext = !maxOption && contextOption ? contextEnds(contextOption) : null,
    setOption = (configId: string, value: string) => void setChat({ id, configOption: { configId, value } }).catch(ctx.fail),
    aliases = agentModels.models, catalog = caps?.catalog.length ? caps.catalog : agentModels.catalog.length ? agentModels.catalog : agent === 'claude' ? baseCatalog(agentModels.models) : [],
    optionsForModel = (model: string | null) => modelOptions(model, catalog, aliases, agent), busy = state.status === 'working' || state.status === 'attention';

  // Attach to the server's session: subscribe first, then ask for the stored events; whatever arrived in between is applied after the replay (seq makes that safe).
  useEffect(() => {
    let alive = true, opened = false; const early: any[] = [];
    const handle = (message: any) => {
      if (message.type === 'chat/event') {
        apply(view => reduce(view, message.event));
        if (message.event?.kind === 'divider' && message.event.reason === 'clear') setQueue([]);
        // A withdrawn steering message goes back into the input box (unless something is being typed there) so it is not lost.
        if (message.event?.kind === 'steer' && message.event.phase === 'cancelled' && typeof message.event.text === 'string') setText(current => current || message.event.text);
      }
      else if (message.type === 'chat/state') { apply(view => ({ ...view, state: message.state })); ctxRef.current.onState(id, message.state); }
    };
    const open = () => ctxRef.current.call('chat/open', { id, agent, ...(leaf.cwd ? { path: leaf.cwd } : {}), defaults: { permissionMode: ctxRef.current.settings.chatDefaultPermission, ...(ctxRef.current.settings.chatDefaultEffort !== 'auto' ? { effort: ctxRef.current.settings.chatDefaultEffort } : {}) }, since: viewRef.current.ready ? viewRef.current.seq : 0 }).then(replay => {
      if (!alive) return; setOpenError(''); if (typeof replay.user === 'string') setUser(replay.user);
      if (!viewRef.current.ready) apply(() => fromReplay(replay));
      else apply(view => {
        let next = view; for (const event of replay.events ?? []) next = reduce(next, event);
        return { ...next, state: replay.state, approvals: (replay.approvals ?? []).map((item: any) => ({ requestId: item.requestId, tool: item.tool, input: item.input, toolUseId: item.toolUseId, questions: item.questions, suggestions: item.suggestions ?? [] })) };
      });
      ctxRef.current.onState(id, replay.state); opened = true; for (const message of early.splice(0)) handle(message);
    }, cause => { if (alive) setOpenError(cause instanceof Error ? cause.message : String(cause)); });
    const stop = ctx.subscribe(id, message => { if (message.type === 'reconnect') { opened = false; void open(); } else if (opened) handle(message); else early.push(message); });
    void open();
    void ctx.call<CommandInfo[]>('chat/commands', { agent, ...(leaf.cwd ? { path: leaf.cwd } : {}) }).then(list => { if (alive) setCommands(list); }, () => {});
    return () => { alive = false; stop(); };
  }, [id]);

  useEffect(() => { if (focused && visible) box.current?.focus(); }, [focused, visible]);
  const [configuring, setConfiguring] = useState(false), setting = useRef(false);
  async function setChat(input: object) {
    if (agent !== 'cursor') return ctx.call('chat/set', input);
    if (setting.current) throw new Error('모델 설정을 적용 중입니다.');
    setting.current = true; setConfiguring(true);
    try { return await ctx.call('chat/set', input); }
    finally { setting.current = false; setConfiguring(false); }
  }
  const [modelsOpen, setModelsOpen] = useState(false), [resuming, setResuming] = useState(false), [resumeOpen, setResumeOpen] = useState(false);
  const selectedModel = state.model || aliases[''] || null;
  useEffect(() => { let alive = true;
    void ctx.call('chat/models', { agent, id }).then(result => { if (alive) setAgentModels(result); }, ctx.fail);
    return () => { alive = false; };
  }, [agent, id, ctx.call]);
  useEffect(() => { const element = scroller.current; if (!element || !stick.current || !(ctx.settings.chatAutoScroll || jump.current)) return; jump.current = false; element.scrollTop = element.scrollHeight; }, [view.items, view.stream, view.steers.length, view.approvals.length, queue.length, state.status]);
  const onScroll = () => { const element = scroller.current; if (!element) return; const gap = element.scrollHeight - element.scrollTop - element.clientHeight; stick.current = gap < 80; setAway(gap > 240); };
  // Branch / Rewind sit on the last assistant message of each finished turn: that is where the CLI's history is whole (no tool call left unanswered).
  const isFinal = (items: Item[], index: number, working: boolean) => { const item = items[index]; if (item.kind !== 'assistant' || item.sub) return false; const next = items.slice(index + 1).find(other => other.kind !== 'note'); return next ? next.kind === 'divider' || next.kind === 'user' : !working; };
  const branch = useCallback((uuid: string) => void ctxRef.current.branchChat(id, uuid, leaf.cwd).catch(ctxRef.current.fail), [id, leaf.cwd]);
  const rewind = useCallback((uuid: string) => void ctxRef.current.pick('여기로 되돌릴까요? 이후 대화는 사라지고 에이전트가 이미 바꾼 파일은 그대로입니다.', [{ id: 'yes', label: '되돌리기' }]).then(choice => choice === 'yes' ? ctxRef.current.call('chat/rewind', { id, uuid }) : undefined).catch(ctxRef.current.fail), [id]);
  const jumpToEnd = () => { const element = scroller.current; if (!element) return; stick.current = true; element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' }); };

  const note = (message: string) => apply(view => ({ ...view, items: [...view.items, { kind: 'note', key: `n${Date.now()}${Math.random()}`, text: message }] }));
  const transmit = async (message: string, attachments: Attachment[], steer = false) => {
    stick.current = true; jump.current = true;
    try { await ctx.call('chat/send', { id, text: message, steer, images: attachments.map(({ mime, data }) => ({ mime, data })) }); }
    catch (cause) { ctx.fail(cause); }
  };
  // A message typed while Claude answers waits here and goes out when the turn ends.
  useEffect(() => {
    if (state.status !== 'idle' || !queue.length || !view.ready || queueSending || configuring) return;
    const [next, ...rest] = queue; setQueueSending(true); setQueue(rest);
    void transmit(next.text, next.images).finally(() => setQueueSending(false));
  }, [state.status, queue, view.ready, queueSending, configuring]);

  const available = useMemo(() => {
    const names = new Map<string, CommandInfo>(LOCAL.filter(item => item.name !== 'effort' || effortOptions.length > 0).map(item => [item.name, item]));
    for (const item of commands) if (!names.has(item.name)) names.set(item.name, item);
    for (const name of state.slashCommands) if (!names.has(name)) names.set(name, { name, description: '' });
    return [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [commands, state.slashCommands, effortOptions.length]);
  const slash = /^\/([^\s/]*)$/.exec(text), matches = slash ? available.filter(item => item.name.startsWith(slash[1])).slice(0, 8) : [];
  useEffect(() => setMenuAt(0), [slash?.[1]]);

  async function runLocal(name: string, argument: string): Promise<boolean> {
    switch (name) {
      case 'resume': await resume(); return true;
      case 'clear': await ctx.call('chat/reset', { id }); return true;
      case 'exit': ctx.onClose(id); return true;
      case 'config': ctx.onOpenSettings(); return true;
      case 'model': {
        if (agent === 'cursor' && !argument) { setModelsOpen(true); return true; }
        const value = argument || await ctx.pick('모델 선택', modelRows(catalog, aliases).map(row => ({ id: row.value, label: row.label })));
        if (value) await setChat({ id, model: value });
        return true;
      }
      case 'effort': {
        if (!effortOptions.length) { note('이 CLI는 별도의 Effort 선택지를 제공하지 않습니다. 지원되는 모델 변형을 모델 메뉴에서 선택하세요.'); return true; }
        const value = argument || await ctx.pick('Effort 선택', effortOptions.map(item => ({ id: item, label: `${item} · ${effortLabel(item)}` })));
        if (value) { if (!effortOptions.includes(value)) note(`알 수 없는 Effort: ${value} (${effortOptions.join(', ')})`); else await setChat({ id, effort: value }); }
        return true;
      }
      case 'permissions': {
        const value = argument || await ctx.pick('권한 모드', modes.map(mode => ({ id: mode, label: permissionLabels[mode] ?? mode })));
        if (value) { if (!modes.includes(value)) note(`알 수 없는 권한 모드: ${value}`); else await setChat({ id, permissionMode: value }); }
        return true;
      }
      case 'cost': case 'status': {
        const tokens = state.tokens;
        note([`모델 ${displayModel(state.model, agent)} · Effort ${effortLabel(state.effort ?? 'medium')} · 권한 ${permissionLabels[state.permissionMode] ?? state.permissionMode}`, `비용 ${state.costUsd === null ? '미제공' : `$${state.costUsd.toFixed(4)}`} · ${state.turns}턴`,
          caps?.tokens === false ? 'CLI가 토큰 사용량을 제공하지 않습니다' : `토큰 입력 ${tokens.input} · 출력 ${tokens.output} · 캐시 읽기 ${tokens.cacheRead} · 캐시 쓰기 ${tokens.cacheCreate}`, `세션 ${state.sessionId ?? '아직 없음'}`].join('\n'));
        return true;
      }
      case 'help': note(`이 창에서 바로 처리: ${LOCAL.map(item => `/${item.name}`).join(' ')}\n${agentLabel}가 지원하는 명령만 사용할 수 있습니다. 화면형 선택이 필요한 명령은 터미널 탭에서 쓰세요.`); return true;
      default: return false;
    }
  }
  // Enter while Claude works steers the running turn (sent now, folded into it); Tab is the follow-up (held until the turn ends). `/…` lines never steer.
  async function submit(mode: 'steer' | 'queue' = 'steer') {
    const message = text.trim();
    if ((!message && !images.length) || !view.ready || setting.current) return;
    const command = /^\/([\w:-]+)(?:\s+(.*))?$/s.exec(message);
    if (command && LOCAL.some(item => item.name === command[1])) { setText(''); try { await runLocal(command[1], (command[2] ?? '').trim()); } catch (cause) { ctx.fail(cause); } return; }
    const attachments = images; setText(''); setImages([]);
    const body = message || '(이미지)';
    if (busy && mode === 'steer' && caps?.steer !== false && agent !== 'cursor' && !message.startsWith('/')) await transmit(body, attachments, true);
    else if (busy || queue.length || queueSending) setQueue(items => [...items, { text: body, images: attachments }]);
    else await transmit(body, attachments);
  }
  async function attach(files: File[]) {
    if (caps?.images === false) return ctx.fail(new Error('선택한 모델은 이미지 입력을 지원하지 않습니다.'));
    const accepted = files.filter(file => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type));
    if (!accepted.length) return;
    try {
      const next = [...images, ...(await Promise.all(accepted.map(fileData)))].slice(0, 4);
      if (next.reduce((sum, item) => sum + item.data.length, 0) > 2_500_000) return ctx.fail(new Error('이미지가 너무 큽니다 (합계 약 1.8MB 이하).'));
      setImages(next); toastAttached(accepted.length);
    } catch (cause) { ctx.fail(cause); }
  }
  const answer = (approval: Approval, allow: boolean, always: boolean, answers?: Record<string, string[]>) => void ctx.call('chat/approve', { id, requestId: approval.requestId, allow, always, answers }).catch(ctx.fail);
  const interrupt = () => void ctx.call('chat/interrupt', { id }).catch(ctx.fail);
  function resume() {
    if (resuming) return;
    if (busy) { ctx.fail(new Error('응답이 끝난 뒤 이전 대화를 불러올 수 있습니다.')); return; }
    setResumeOpen(true);
  }
  async function pickResume(choice: { kind: 'chat'; id: string } | { kind: 'cli'; sessionId: string }) {
    setResumeOpen(false); setResuming(true);
    try { await (choice.kind === 'chat' ? ctx.resumeChat(choice.id, agent) : ctx.importCliChat(choice.sessionId)); }
    catch (cause) { ctx.fail(cause); }
    finally { setResuming(false); }
  }

  const complete = (name: string) => { setText(`/${name} `); box.current?.focus(); };

  const agentState = view.approvals.length ? 'attention' : state.status === 'working' ? 'working' : 'idle';
  const lastReply = [...view.items].reverse().find(item => item.kind === 'assistant'), toolRunning = lastReply?.kind === 'assistant' && lastReply.blocks.some(block => block.type === 'tool_use' && !view.results[block.id]);
  const seen = (view.stream ? Object.values(view.stream) : []).some(block => block.type === 'text' ? block.text.trim() : block.type === 'tool_use' ? true : false),
    thought = (view.stream ? Object.values(view.stream) : []).flatMap(block => block.type === 'thinking' ? [block.text.trim().split('\n').at(-1) ?? ''] : []).at(-1) ?? '';
  const stream = view.stream ? Object.entries(view.stream).sort(([a], [b]) => Number(a) - Number(b)).map(([, block]) => block) : [];
  // After /clear the earlier history stays in `items` but is hidden: the pane shows the start screen again.
  const shown = useMemo(() => view.items.slice(view.items.map(item => item.kind).lastIndexOf('divider') + 1), [view.items]);
  const empty = view.ready && !shown.length && !stream.length && !busy;
  return <section className={`terminal-pane chat-pane ${focused ? 'focused' : ''}`} data-kind="chat" data-empty={empty || undefined} data-agent={agent} data-agent-state={agentState} style={{ '--chat-font': `${ctx.settings.chatFontSize}px`, '--chat-width': chatWidths[ctx.settings.chatWidth] } as CSSProperties} onMouseDownCapture={() => onFocus(id)} onFocus={() => onFocus(id)}>
    <div className="pane-tools" role="toolbar" aria-label="채팅 pane">
      <span className="pane-title" title={cwd}><span className="pane-mark"><Icon name={agent} size={12} /></span><span className="pane-label">{agentLabel} · {basename(cwd.replace(/\\/g, '/'))}</span>
        {view.approvals.length > 0 && <span className="question-alert" role="img" aria-label="승인 필요" title="도구 실행 승인이 필요합니다"><Icon name="alert" size={12} /></span>}</span>
      <span className="pane-actions">
        <IconButton icon="terminal" label={view.state.status === 'idle' && view.state.sessionId ? '터미널로 전환 (같은 세션을 터미널에서 이어갑니다)' : '터미널로 전환 — 대화가 시작되고 응답이 끝난 뒤에만 가능'} disabled={view.state.status !== 'idle' || !view.state.sessionId} onClick={() => ctx.toTerminal(id)} />
        <i className="pane-sep" aria-hidden="true" />
        <IconButton icon="plus" label="새 대화 (/clear)" onClick={() => void ctx.call('chat/reset', { id }).catch(ctx.fail)} />
        <IconButton icon="splitH" label="좌우 분할" onClick={() => onSplit(id, 'row')} /><IconButton icon="splitV" label="상하 분할" onClick={() => onSplit(id, 'column')} />
        <IconButton icon={zoomed ? 'minimize' : 'maximize'} label={zoomed ? '원래 크기로' : '최대화'} onClick={() => onZoom(id)} />
        <IconButton icon="x" label="채팅 닫기" onClick={() => ctx.onClose(id)} /></span></div>
    <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
      <div className="chat-thread">
        {openError && <div className="chat-msg error" role="alert"><Icon name="alert" size={14} /><span>{openError}</span></div>}
        {shown.map((item, index) => <Message key={item.key} item={item} results={view.results} settings={ctx.settings} working={busy} final={isFinal(shown, index, busy)} onBranch={caps?.branch === false ? undefined : branch} onRewind={caps?.rewind === false ? undefined : rewind} />)}
        {stream.length > 0 && <div className="chat-msg assistant streaming"><div className="chat-body"><Blocks blocks={stream} results={view.results} settings={ctx.settings} live working /></div></div>}
        {busy && !seen && !toolRunning && !view.approvals.length && <ChatWorking effort={state.effort} tokens={view.thinkingTokens} thought={thought} />}
        {view.steers.map(item => <div className="chat-msg user" key={item.uuid}><div className="chat-bubble steer"><small className="chat-steer" title="응답이 이 메시지를 받아들이면 일반 대화로 바뀝니다. Esc로 취소할 수 있습니다.">스티어링 · 대기 중 · Esc로 취소</small>{item.text}{item.images > 0 && <small className="chat-images"><Icon name="copy" size={11} />이미지 {item.images}장</small>}</div></div>)}
        {state.error && state.status === 'idle' && !view.items.some(item => item.kind === 'error') && <div className="chat-msg error" role="alert"><Icon name="alert" size={14} /><span>{state.error}</span></div>}
      </div>
    </div>
    {resumeOpen && <ResumeModal agent={agent} exclude={id} call={ctx.call} onClose={() => setResumeOpen(false)} onPick={choice => void pickResume(choice)} />}
    {modelsOpen && <ModelsModal current={modelValue(selectedModel, aliases)} call={ctx.call} agent={agent} fallback={catalog} aliases={aliases} onClose={() => setModelsOpen(false)} onPick={value => { setModelsOpen(false); void setChat({ id, model: value }).catch(ctx.fail); }} />}
    <div className="chat-start-slot chat-greeting" inert={!empty} aria-hidden={!empty}>
      <div><div className="chat-empty"><h2><span className="chat-empty-mark"><Icon name={agent} size={32} /></span>{greeting}</h2></div></div>
    </div>
    <div className="chat-dock">
      {away && <button type="button" className="chat-jump" title="맨 아래로" aria-label="맨 아래로 이동" onClick={jumpToEnd}><Icon name="arrowDown" size={16} /></button>}
      {view.approvals.map(approval => <ApprovalCard key={approval.requestId} approval={approval} onAnswer={(allow, always, answers) => answer(approval, allow, always, answers)} />)}
      {queue.length > 0 && <div className="chat-queue"><div role="status">Follow-up {queue.length}개 · 현재 응답이 끝나면 순서대로 전송</div>
        <ol>{queue.map((item, index) => <li key={index}><span>{item.text}</span><IconButton icon="x" label={`대기 메시지 취소: ${item.text}`} size={12} onClick={() => setQueue(items => items.filter((_, i) => i !== index))} /></li>)}</ol></div>}
      {ctx.branch && <div className="chat-start-slot" inert={!empty} aria-hidden={!empty}><div className="chat-chips" role="group" aria-label="세션 설정">
        {ctx.branch && <span className="chat-chip joined">
          <button type="button" title="브랜치 전환" onClick={ctx.switchBranch}><Icon name="branch" size={16} />{ctx.branch}</button>
          <label title="새 git worktree에서 이 대화를 시작합니다. 대화를 시작한 뒤에는 바꿀 수 없습니다."><input type="checkbox" checked={state.worktree} disabled={!view.ready || Boolean(state.sessionId)}
            onChange={event => void setChat({ id, worktree: event.target.checked }).catch(ctx.fail)} />워크트리</label></span>}
      </div></div>}
      <div className="chat-status-slot" inert={empty} aria-hidden={empty}><div><ChatStatusLine settings={ctx.settings} context={{ state }} /></div></div>
      <div className="chat-composer" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void attach([...event.dataTransfer.files]); }}>
        {matches.length > 0 && <ul className="chat-commands" role="listbox" aria-label="슬래시 명령">{matches.map((item, index) => <li key={item.name} role="option" aria-selected={index === menuAt}>
          <button type="button" tabIndex={-1} onMouseDown={event => { event.preventDefault(); complete(item.name); }}><b>/{item.name}</b><span>{item.description}</span></button></li>)}</ul>}
        {images.length > 0 && <div className="chat-attachments">{images.map((image, index) => <span key={index}><img src={image.url} alt={`첨부 이미지 ${index + 1}`} /><button type="button" aria-label="첨부 제거" onClick={() => setImages(items => items.filter((_, i) => i !== index))}><Icon name="x" size={11} /></button></span>)}</div>}
        <div className="chat-input-row">
        <textarea ref={box} rows={1} value={text} placeholder={stash ? `보관된 입력이 있습니다 (${showCombo(chatKey(ctx.settings.chatKeys, 'stash'))}로 복원)` : busy ? caps?.steer === false || agent === 'cursor' ? '응답이 끝난 뒤 순서대로 전송합니다' : `${ctx.settings.chatSendKey === 'mod-enter' ? 'Cmd/Ctrl+Enter' : 'Enter'}: 지금 끼워 넣기(스티어링) · Tab: 끝난 뒤 보내기(follow-up)` : '작업을 설명하거나 질문하세요'} aria-label="메시지 입력" disabled={!view.ready && !openError}
          onChange={event => { setText(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(ctx.settings.chatComposerMax, event.target.scrollHeight)}px`; }}
          onPaste={event => { const files = [...event.clipboardData.files]; if (files.some(file => file.type.startsWith('image/'))) { event.preventDefault(); void attach(files); } }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            const modSend = ctx.settings.chatSendKey === 'mod-enter';
            const combo = comboOf(event.nativeEvent), keyOf = (id: Parameters<typeof chatKey>[1]) => combo === chatKey(ctx.settings.chatKeys, id);
            if (keyOf('effortUp') || keyOf('effortDown')) { event.preventDefault(); if (!effortOptions.length) return; const step = keyOf('effortUp') ? 1 : -1, at = effortOptions.indexOf(state.effort ?? 'medium'); const effort = effortOptions[Math.max(0, Math.min(effortOptions.length - 1, at + step))]; if (effort !== state.effort) void setChat({ id, effort }).catch(ctx.fail); return; }
            if (keyOf('modelNext')) { event.preventDefault(); const values = optionsForModel(selectedModel).map(option => option.value).filter(value => value !== MORE_MODELS), current = modelValue(selectedModel, aliases), next = values[(values.indexOf(current) + 1) % values.length]; if (next) void setChat({ id, model: next }).catch(ctx.fail); return; }
            if (keyOf('stash')) { event.preventDefault(); if (text.trim()) { setStash(text); setText(''); event.currentTarget.style.height = 'auto'; } else if (stash) { setText(stash); setStash(''); } return; }
            if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); void setChat({ id, permissionMode: agent === 'claude' ? nextMode(state.permissionMode) : cycleMode(modes, state.permissionMode) }).catch(ctx.fail); return; }
            if (matches.length) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenuAt(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length); return; }
              if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) { event.preventDefault(); complete(matches[menuAt].name); return; }
              if (event.key === 'Escape') { event.preventDefault(); setText(''); return; }
            }
            if (event.key === 'Tab' && !event.shiftKey && busy && ctx.settings.followUpQueue && (text.trim() || images.length)) { event.preventDefault(); void submit('queue'); return; }
            if (event.key === 'Enter' && !event.shiftKey && (!modSend || event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
            else if (event.key === 'Escape' && busy) { event.preventDefault(); if (view.steers.length && caps?.cancelSteer !== false) void ctx.call('chat/cancel-steer', { id }).catch(ctx.fail); else interrupt(); }
          }} />
        </div>
      <div className="chat-foot">
        <label className="chat-attach" title="이미지 첨부 (붙여넣기·끌어놓기도 가능)"><Icon name="plus" size={16} /><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={event => { void attach([...(event.target.files ?? [])]); event.target.value = ''; }} /></label>
        <Dropdown label="권한 모드" className="chat-mode" value={state.permissionMode} options={modes.map(mode => ({ value: mode, label: permissionLabels[mode] ?? mode, icon: MODE_ICONS[mode] ?? 'tune', color: `var(--mode-${mode}, var(--muted))` }))} onChange={mode => void setChat({ id, permissionMode: mode }).catch(ctx.fail)} />
        {!empty && state.addDirs.length > 0 && <span className="chat-foot-note" title={state.addDirs.join('\n')}>폴더 +{state.addDirs.length}</span>}
        <span className="drag-space" />
        {agent === 'cursor' ? <button type="button" className="chat-model cursor-model" aria-haspopup="dialog" aria-label="모델 선택" onClick={() => setModelsOpen(true)}><span className="dd-label" style={{ color: modelAppearance(selectedModel, agent).color }}>{displayModel(selectedModel, agent)}</span><Icon name="chevronDown" size={14} /></button> : <Dropdown label="모델" className="chat-model" placeholder="모델 선택" value={modelValue(selectedModel, aliases)} options={optionsForModel(selectedModel)} onChange={model => { if (model === MORE_MODELS) setModelsOpen(true); else void setChat({ id, model }).catch(ctx.fail); }} />}
        {cursorOptions.filter(isCursorSwitch).map(option => <button type="button" key={option.id} className={`chat-switch${option.id === 'fast' ? ' fast' : ''}`} aria-pressed={option.currentValue === 'true'} title={option.description || (option.id === 'fast' ? 'Fast 모드' : option.name)} onClick={() => setOption(option.id, option.currentValue === 'true' ? 'false' : 'true')}>{option.id === 'fast' ? 'Fast' : option.name}</button>)}
        {effortOptions.length > 0 && <span className="effort-wrap"><Dropdown label="Effort" className={`chat-effort effort-${effortLevel(state.effort) || 'medium'}`} value={state.effort ?? (effortOptions.includes('medium') ? 'medium' : '')} placeholder="Effort" options={effortOptions.map(item => ({ value: item, label: effortLabel(item), ...effortStyle[effortLevel(item)] }))} onChange={effort => void setChat({ id, effort: effort || null }).catch(ctx.fail)} /><EffortSparks level={effortLevel(state.effort) || 'medium'} /></span>}
        {maxOption && <button type="button" className="chat-max" aria-pressed={maxSelected(maxOption)} title={maxOption.description || 'MAX 모드'} onClick={() => setOption(maxOption.id, maxSelected(maxOption) ? maxOffValue(maxOption) : maxOnValue(maxOption))}>MAX</button>}
        {!maxOption && maxContext && <button type="button" className="chat-max" aria-pressed={contextOption?.currentValue === maxContext.on} title="이 모델의 최대 컨텍스트" onClick={() => setOption(contextOption!.id, contextOption?.currentValue === maxContext.on ? maxContext.off : maxContext.on)}>MAX</button>}
        {cursorOptions.filter(option => !isCursorSwitch(option) && !isCursorEffort(option) && !(maxOption && option.id === maxOption.id)).map(option => { const name = cursorSettingName(option); return <span key={option.id} title={option.description}><Dropdown label={name} className="chat-model-config" value={option.currentValue} placeholder={name} options={option.options.map(item => ({ value: item.value, label: `${name}: ${item.name}`, hint: item.description }))} onChange={value => setOption(option.id, value)} /></span>; })}
        <ContextRing state={state} ctx={ctx} active={visible} agent={agent} />
        {busy ? <button type="button" className="chat-send stop" title="중단 (Esc)" aria-label="응답 중단" onClick={interrupt}><Icon name="stop" size={15} /></button>
          : <button type="button" className="chat-send" title="보내기 (Enter)" aria-label="보내기" disabled={!view.ready || configuring || (!text.trim() && !images.length)} onClick={() => void submit()}><Icon name="arrowUp" size={16} /></button>}
      </div>
      </div>
      <div className="chat-start-slot" inert={!empty} aria-hidden={!empty}><div><button type="button" className="chat-resume" disabled={!view.ready || resuming || busy} onClick={() => void resume()}><Icon name="refresh" size={16} />{resuming ? '불러오는 중…' : '이전 대화 불러오기'}</button></div></div>
    </div>
    <div className="chat-bottom-space" aria-hidden="true" />
  </section>;
}

// Rising particles for the two highest Effort levels, kept inside the dropdown and under its label text. xhigh: a few small, faint, slow sparks, no glow or background. max: more, brighter and faster, with a few glowing flares. Every spark gets its own position, size, speed, drift and phase (rolled once per level), so nothing repeats in step.
function EffortSparks({ level }: { level: string }) {
  const sparks = useMemo(() => {
    const max = level === 'max' || level === 'ultra', count = max ? 20 : level === 'xhigh' ? 7 : 0, palette = max ? ['#f2566e', '#ff7a59', '#ffb347', '#ffe08a'] : ['#f0a04b', '#f7c27a', '#ffd9a0'], rand = (low: number, high: number) => low + Math.random() * (high - low);
    return Array.from({ length: count }, () => { const flare = max && Math.random() < .18, duration = rand(max ? .9 : 2.2, max ? 1.6 : 3); return { x: rand(2, 98), size: flare ? rand(4, 5) : rand(2, max ? 3.4 : 2.8), duration, delay: -rand(0, duration * 2), dx: rand(max ? -8 : -4, max ? 8 : 4), dy: -rand(max ? 14 : 10, max ? 24 : 20), peak: max ? 1 : rand(.7, .95), glow: flare, color: palette[Math.floor(Math.random() * palette.length)] }; });
  }, [level]);
  if (!sparks.length) return null;
  return <span className="effort-sparks" aria-hidden="true">{sparks.map((spark, index) => <i key={index} style={{ left: `${spark.x}%`, width: spark.size, height: spark.size, background: spark.color, boxShadow: spark.glow ? `0 0 5px ${spark.color}` : undefined, '--dx': `${spark.dx}px`, '--dy': `${spark.dy}px`, '--peak': spark.peak, animationDuration: `${spark.duration}s`, animationDelay: `${spark.delay}s` } as CSSProperties} />)}</span>;
}

// Shown while nothing else is visible yet (thinking, or waiting for the first token). The CLI sends no thinking text for current models, only a running
// token estimate, so that and the elapsed time are what can be shown; after 8s it says how hard it is thinking (the Effort setting) and drifts to red.
function ChatWorking({ effort, tokens, thought }: { effort: string | null; tokens: number; thought: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => { const start = Date.now(), timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 500); return () => clearInterval(timer); }, []);
  const deep = seconds >= 8, red = Math.min(100, Math.max(0, (seconds - 8) * 2));
  return <div className={`chat-working${deep ? ' deep' : ''}`} role="status" style={deep ? { color: `color-mix(in srgb, var(--error) ${red}%, var(--muted))` } : effort && effortStyle[effortLevel(effort)] ? { color: effortStyle[effortLevel(effort)].color } : undefined}
    title={thought ? undefined : '모델이 추론 내용은 보내지 않아, 경과 시간과 추정 토큰만 표시합니다.'}>
    <i className="chat-spin" />{deep ? `${effort ? `${effortLabel(effort)} Effort로 ` : ''}깊게 생각하는 중…` : '생각하는 중…'}
    <small>{seconds}초{tokens > 0 && ` · 약 ${compact(tokens)} 토큰`}</small>{thought && <em>{thought}</em>}</div>;
}

// The ring beside the model: how full the context window is (green to red like the status line's usage items). Clicking opens the popover with the context
// reading and the plan's usage limits, the same readings as the status bar's Claude usage.
function ContextRing({ state, ctx, active, agent }: { state: ChatState; ctx: ChatCtx; active: boolean; agent: 'claude' | 'codex' | 'cursor' }) {
  const { settings } = ctx, percent = contextPercent(state), radius = 7, length = 2 * Math.PI * radius, panel = `chat-usage-${useId()}`;
  const { usage, loading, load } = useUsage(agent === 'codex' ? 'codex' : 'claude', ctx.projectId, active && agent !== 'cursor', settings.usageRefresh);
  const windows = usage ? (settings.claudeSession ? usage.windows : usage.windows.filter(item => item.key !== 'session')) : [];
  const total = contextWindow(state.model, state.contextWindow);
  return <>
    <button type="button" className="chat-ring" popoverTarget={panel} aria-label={state.capabilities?.context === false ? '컨텍스트 미제공 · 사용 한도 보기' : `컨텍스트 ${percent}% 사용 · 사용 한도 보기`} title={state.capabilities?.context === false ? 'CLI가 컨텍스트 사용량을 제공하지 않습니다' : `컨텍스트 ${percent}% · 클릭하면 사용 한도`} onClick={() => { if (agent !== 'cursor') void load(true); }}>
      <svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r={radius} className="track" />
        {state.contextTokens > 0 && <circle cx="10" cy="10" r={radius} className="fill" style={{ stroke: `hsl(${usageHue(percent)} 65% var(--usage-l, 55%))` }} strokeDasharray={`${Math.max(1.5, length * percent / 100)} ${length}`} transform="rotate(-90 10 10)" />}</svg></button>
    <div id={panel} popover="auto" className="usage-detail chat-usage" role="dialog" aria-label="컨텍스트와 사용 한도" onToggle={event => placeAbove(event, 'right')}>
      <header><strong>컨텍스트</strong></header>
      <div className="usage-row">
        <div><span>{state.capabilities?.context === false ? 'CLI가 컨텍스트 정보를 제공하지 않습니다' : `${compact(state.contextTokens)} / ${compact(total)} 토큰`}</span><b className={settings.usageColors ? 'graded' : ''} style={settings.usageColors ? usageHueStyle(percent) : undefined}>{state.capabilities?.context === false ? '미제공' : `${percent}%`}</b></div>
        {state.capabilities?.context !== false && <progress className={settings.usageColors ? 'graded' : ''} style={settings.usageColors ? usageHueStyle(percent) : undefined} value={percent} max={100} aria-label="컨텍스트 사용률" />}
      </div>
      <header className="chat-usage-title"><strong>사용 한도</strong>{usage?.plan && <span className="plan">{usage.plan}</span>}
        <button type="button" className="icon-btn" title="새로고침" aria-label="사용 한도 새로고침" aria-busy={loading} onClick={() => { if (agent !== 'cursor') void load(true); }}><Icon name="refresh" size={13} /></button></header>
      {agent === 'cursor' ? <p className="usage-note">CLI가 사용 한도를 제공하지 않습니다.</p> : usage ? <UsageRows windows={windows} colors={settings.usageColors} /> : <p className="usage-note">{loading ? '불러오는 중…' : '표시할 한도 정보가 없습니다.'}</p>}
      {usage?.error && <p className="usage-note warn">{usage.error}</p>}
    </div>
  </>;
}
