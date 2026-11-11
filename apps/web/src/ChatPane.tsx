import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { basename, type Leaf } from './api';
import { DiffView, usageHue, type Settings } from './Editor';
import { placeAbove, UsageRows, usageHueStyle, useUsage } from './Usage';
import { Icon, IconButton } from './Icon';
import { ChatStatusLine } from './ChatStatus';
import { CodeBlock, Markdown } from './Markdown';
import { chatKey, pickGreeting, comboOf, showCombo, compact, contextEnds, contextGauge, contextPercent, contextWindow, cursorSettingName, effortLabel, effortLevel, effortStyle, efforts, emptyView, fromReplay, cursorModelGroups, displayModel, isChatSlashCommand, isCursorEffort, isCursorMax, isCursorSwitch, maxOffValue, maxOnValue, maxSelected, modelProvider, modelAppearance, modelRows, modelValue, parseChatSlashCommand, permissionLabels, permissionModeColor, reduce, shortModel, streamBlocks, toolSummary, turnAllowsMessageActions, type Approval, type Block, type CatalogModel, type ChatState, type ChatView, type Item } from './chat-model';
import { copyText, toastAttached } from './toast';
import { Dropdown, Modal, ModelLabel } from './views';

// What the workspace gives a chat pane. `subscribe` delivers this chat's websocket messages (`chat/event`, `chat/state`) and
// `reconnect` after the socket came back, which makes the pane ask the server for what it missed.
export type ChatCtx = {
  call<T = any>(action: string, input?: object): Promise<T>;
  subscribe(id: string, handler: (message: any) => void): () => void;
  settings: Settings; root: string; projectId: string;
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
type CommandInfo = { name: string; description: string; hint?: string };

const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const MODE_ICONS: Record<string, string> = { default: 'shield', acceptEdits: 'edit_note', plan: 'assignment', auto: 'auto_awesome', bypassPermissions: 'bolt', ask: 'help' };
const cycleMode = (modes: string[], mode: string) => { const ring = modes.filter(item => item !== 'bypassPermissions'); return ring[(ring.indexOf(mode) + 1) % ring.length]; };
// Shift+Tab cycles like Claude Code: default -> accept edits -> plan -> auto. Bypass is dropdown-only.
const nextMode = (mode: string) => ({ default: 'acceptEdits', acceptEdits: 'plan', plan: 'auto', auto: 'default' } as Record<string, string>)[mode] ?? 'default';
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

type SavedChat = { id: string; sessionId?: string; title: string; model: string | null; updatedAt: number };
type CliChat = { sessionId: string; title: string; updatedAt: number; size: number; running: boolean; chatId: string | null };
type ResumeChoice = { kind: 'chat'; id: string } | { kind: 'cli'; sessionId: string };
type ResumeEntry = { key: string; title: string; updatedAt: number; detail?: string; code: string; running?: boolean; choice: ResumeChoice };
const when = (time: number) => new Date(time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const sizeOf = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
// "이전 대화 불러오기": one list, newest first, of everything this project can continue: ADE's saved chats plus (Claude only) conversations made
// with the plain `claude` CLI. Where the source is does not matter to the user; a CLI conversation that already became a chat is listed once.
function ResumeModal({ agent, exclude, call, onPick, onClose }: { agent: 'claude' | 'codex' | 'cursor'; exclude: string; call: ChatCtx['call']; onPick(choice: ResumeChoice): void; onClose(): void }) {
  const search = useRef<HTMLInputElement>(null), [query, setQuery] = useState('');
  const [entries, setEntries] = useState<ResumeEntry[] | null>(null), [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { search.current?.focus(); }, []);
  useEffect(() => {
    let live = true;
    void Promise.allSettled([call<SavedChat[]>('chat/sessions', { agent, exclude }), agent === 'claude' ? call<CliChat[]>('chat/cli-sessions', {}) : Promise.resolve<CliChat[]>([])]).then(([saved, cli]) => {
      if (!live) return;
      if (saved.status === 'rejected' && cli.status === 'rejected') setFailed(String(saved.reason?.message ?? saved.reason));
      const chats = saved.status === 'fulfilled' ? saved.value : [], known = new Set(chats.flatMap(chat => chat.sessionId ? [chat.sessionId] : []));
      setEntries([
        ...chats.map(chat => ({ key: `chat:${chat.id}`, title: chat.title, updatedAt: chat.updatedAt, detail: chat.model ? shortModel(chat.model) : undefined, code: (chat.sessionId ?? chat.id).slice(0, 8), choice: { kind: 'chat', id: chat.id } as ResumeChoice })),
        ...(cli.status === 'fulfilled' ? cli.value : []).filter(item => item.chatId !== exclude && !known.has(item.sessionId) && !(item.chatId && chats.some(chat => chat.id === item.chatId)))
          .map(item => ({ key: `cli:${item.sessionId}`, title: item.title, updatedAt: item.updatedAt, detail: sizeOf(item.size), code: item.sessionId.slice(0, 8), running: item.running,
            choice: (item.chatId ? { kind: 'chat', id: item.chatId } : { kind: 'cli', sessionId: item.sessionId }) as ResumeChoice }))
      ].sort((a, b) => b.updatedAt - a.updatedAt));
    });
    return () => { live = false; };
  }, [call, agent, exclude]);
  const needle = query.trim().toLowerCase(), rows = entries?.filter(item => !needle || item.title.toLowerCase().includes(needle));
  return <Modal className="models-modal resume-modal" labelledBy="resume-title" onClose={onClose}>
    <header><h2 id="resume-title">이전 대화 불러오기</h2><button type="button" className="models-close" aria-label="닫기" onClick={onClose}><Icon name="x" size={16} /></button></header>
    <div className="models-controls">
      <label className="models-search"><Icon name="search" size={15} /><input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="대화 제목 검색" aria-label="대화 제목 검색" /></label>
    </div>
    <div className="models-list resume-list" role="listbox" aria-label="이전 대화">
      {rows?.map(item => <button type="button" role="option" aria-selected={false} key={item.key} className="resume-row" title={item.title} aria-disabled={item.running || undefined} data-blocked={item.running || undefined} onClick={() => { if (!item.running) onPick(item.choice); }}>
        <span className="resume-name">{item.title}</span>
        <span className="resume-info"><span>{when(item.updatedAt)}</span>{item.detail && <span>{item.detail}</span>}{item.running && <span className="resume-badge">터미널에서 실행 중</span>}<span className="resume-code">{item.code}</span></span>
      </button>)}
      {!rows?.length && <p className="models-empty">{entries === null ? '대화를 불러오는 중…' : failed ? `목록을 불러오지 못했습니다: ${failed}` : query ? '검색 결과가 없습니다.' : '이 프로젝트에서 불러올 수 있는 이전 대화가 없습니다.'}</p>}
    </div>
    <footer><span>{rows ? `${rows.length}개 대화` : ''}</span><span>선택하면 새 탭에서 이어집니다.</span></footer>
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
const mergeCommand = (map: Map<string, CommandInfo>, item: CommandInfo) => {
  const prev = map.get(item.name);
  if (!prev) { map.set(item.name, item); return; }
  map.set(item.name, { name: item.name, description: item.description || prev.description, hint: item.hint || prev.hint });
};

const LOCAL: CommandInfo[] = [
  { name: 'resume', description: '이 프로젝트의 이전 Chat 대화를 불러옵니다' },
  { name: 'retry', description: '에이전트 연결이 끊겼을 때 마지막 요청을 같은 세션으로 다시 보냅니다' },
  { name: 'clear', description: '새 대화를 시작합니다 (처음 화면으로 돌아갑니다)' },
  { name: 'model', description: '모델을 바꿉니다', hint: '[모델]' },
  { name: 'effort', description: 'Effort(추론 노력 수준)를 바꿉니다', hint: '[low|medium|high|max]' },
  { name: 'permissions', description: '권한 모드를 바꿉니다', hint: '[default|acceptEdits|plan|auto]' },
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
      <span className="chat-tool-state" aria-label={{ running: '실행 중', done: '완료', error: '오류', pending: '대기' }[state]}>{state === 'running' ? <i className="chat-spin" /> : state === 'done' ? <Icon name="check" size={13} /> : state === 'error' ? <Icon name="x" size={13} /> : null}</span>
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

function Blocks({ blocks, results, settings, live, working, plainThinking }: { blocks: Block[]; results: ChatView['results']; settings: Settings; live?: boolean; working: boolean; plainThinking?: boolean }) {
  return <>{blocks.map((block, index) => {
    if (block.type === 'text' || (plainThinking && block.type === 'thinking')) return block.text.trim() ? <Revealed key={index} text={block.text} live={Boolean(live)} markdown smooth={settings.chatSmoothStream} /> : null;
    if (block.type === 'thinking') return block.text.trim() ? <details key={index} className="chat-thinking" open={settings.chatThinkingOpen === 'always' ? true : settings.chatThinkingOpen === 'never' ? false : live}><summary>생각</summary><p><Revealed text={block.text} live={Boolean(live)} markdown={false} smooth={settings.chatSmoothStream} /></p></details> : null;
    if (block.type === 'tool_use') return <ToolCard key={block.id || index} block={block} result={results[block.id]} settings={settings} running={working} />;
    return null;
  })}</>;
}

const shownBlock = (block: Block) => block.type === 'tool_use' || ((block.type === 'text' || block.type === 'thinking') && Boolean(block.text.trim()));
const turnsOf = (items: Item[]) => {
  const turns: Item[][] = [];
  let current: Item[] = [];
  for (const item of items) {
    if ((item.kind === 'user' || item.kind === 'divider') && current.length) { turns.push(current); current = []; }
    current.push(item);
  }
  if (current.length) turns.push(current);
  return turns;
};
function ProcessFold({ blocks, results, settings, working, plainThinking }: { blocks: Block[]; results: ChatView['results']; settings: Settings; working: boolean; plainThinking?: boolean }) {
  const [open, setOpen] = useState(false);
  const tools = blocks.filter(block => block.type === 'tool_use').length;
  return <div className="chat-process">
    <button type="button" className="chat-process-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="icon material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">account_tree</span>
      <strong>과정</strong>
      <span className="chat-process-summary">{tools ? `도구 ${tools}개` : '생각'}</span>
      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
    </button>
    {open && <div className="chat-process-body"><Blocks blocks={blocks} results={results} settings={settings} working={working} plainThinking={plainThinking} /></div>}
  </div>;
}
function Turn({ items, settled, finals, results, settings, working, plainThinking, onBranch, onRewind, onRecover, recovering }: { items: Item[]; settled: boolean; finals: Set<string>; results: ChatView['results']; settings: Settings; working: boolean; plainThinking?: boolean; onBranch?(uuid: string): void; onRewind?(uuid: string): void; onRecover?(): void; recovering?: boolean }) {
  const lead = items[0]?.kind === 'user' || items[0]?.kind === 'divider' ? items[0] : null;
  const body = lead ? items.slice(1) : items;
  const flat: { item: Extract<Item, { kind: 'assistant' }>; block: Block }[] = [];
  for (const item of body) if (item.kind === 'assistant') for (const block of item.blocks) if (shownBlock(block)) flat.push({ item, block });
  // The answer is the text after the last tool or thought. Everything before it is one process.
  let cut = flat.length;
  while (cut > 0 && flat[cut - 1].block.type === 'text' && !flat[cut - 1].item.sub) cut -= 1;
  const earlier = flat.slice(0, cut);
  // No text after the last tool means no answer to put outside the fold (turn ended on a tool call, was interrupted, or failed): fold nothing, or the turn shows only "과정".
  const fold = settled && cut < flat.length && earlier.some(part => part.block.type !== 'text');
  const allowActions = turnAllowsMessageActions(items);
  const message = (item: Item, final: boolean, key = item.key) => <Message key={key} item={item} results={results} settings={settings} working={working} plainThinking={plainThinking} final={final} allowActions={allowActions} onBranch={onBranch} onRewind={onRewind} onRecover={onRecover} recovering={recovering} />;
  if (!fold) return <>{items.map(item => message(item, item.kind === 'assistant' && finals.has(item.key)))}</>;
  const final = flat.slice(cut);
  const finalItem = (final.at(-1) ?? earlier.at(-1))!.item;
  return <>
    {lead && message(lead, false)}
    <ProcessFold blocks={earlier.map(part => part.block)} results={results} settings={settings} working={working} plainThinking={plainThinking} />
    {body.filter(item => item.kind !== 'assistant').map(item => message(item, false))}
    {message({ ...finalItem, blocks: final.map(part => part.block) }, finals.has(finalItem.key), `${finalItem.key}:final`)}
  </>;
}

function ChatErrorAlert({ message, recoverable, recovering, onRecover }: { message: string; recoverable?: boolean; recovering?: boolean; onRecover?(): void }) {
  return <div className="chat-msg error" role="alert"><Icon name="alert" size={14} /><span>{message}</span>
    {recoverable && onRecover && <button type="button" className="chat-recover" disabled={recovering} onClick={onRecover}>{recovering ? '복구 중…' : '세션 복구'}</button>}</div>;
}

const Message = memo(function Message({ item, results, settings, working, plainThinking, final, allowActions = true, onBranch, onRewind, onRecover, recovering }: { item: Item; results: ChatView['results']; settings: Settings; working: boolean; plainThinking?: boolean; final?: boolean; allowActions?: boolean; onBranch?(uuid: string): void; onRewind?(uuid: string): void; onRecover?(): void; recovering?: boolean }) {
  if (item.kind === 'user') {
    const preview = item.text.replace(/\s+/g, ' ').trim() || (item.images > 0 ? `이미지 ${item.images}장` : '');
    const slash = parseChatSlashCommand(item.text);
    if (slash) return <div className="chat-msg user" data-user-key={item.key} data-user-preview={preview.slice(0, 280)}><div className="chat-bubble command"><span className="chat-command-name">/{slash.name || '…'}</span>{slash.args ? ` ${slash.args}` : ''}{item.images > 0 && <small className="chat-images"><Icon name="copy" size={11} />이미지 {item.images}장</small>}</div></div>;
    return <div className="chat-msg user" data-user-key={item.key} data-user-preview={preview.slice(0, 280)}><div className="chat-bubble"><Markdown text={item.text} />{item.images > 0 && <small className="chat-images"><Icon name="copy" size={11} />이미지 {item.images}장</small>}</div></div>;
  }
  if (item.kind === 'divider') return <div className="chat-divider" role="separator"><span>새 대화</span></div>;
  if (item.kind === 'compact') return <div className="chat-divider compact" role="separator"><span>{item.trigger === 'auto' ? '자동 압축' : '컨텍스트 압축'}{item.preTokens != null && item.postTokens != null ? ` · ${compact(item.preTokens)} → ${compact(item.postTokens)} 토큰 (${Math.max(0, Math.round((item.preTokens - item.postTokens) * 100 / Math.max(1, item.preTokens)))}% 감소)` : ''}</span></div>;
  if (item.kind === 'error') return <ChatErrorAlert message={item.message} recoverable={item.recoverable} recovering={recovering} onRecover={onRecover} />;
  if (item.kind === 'note') return <div className="chat-msg note"><pre>{item.text}</pre></div>;
  const text = item.blocks.filter((block): block is Extract<Block, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n\n');
  return <div className={`chat-msg assistant ${item.sub ? 'sub' : ''}`}><div className="chat-body"><Blocks blocks={item.blocks} results={results} settings={settings} working={working} plainThinking={plainThinking} /></div>
    {final && allowActions && <div className="chat-msg-actions">{text.trim() && <IconButton icon="copy" label="응답 복사" size={13} onClick={() => copyText(text)} />}
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
  const title = useMemo(() => { const from = view.items.map(item => item.kind).lastIndexOf('divider'), first = view.items.slice(from + 1).find(item => item.kind === 'user' && !isChatSlashCommand(item.text)); return first?.kind === 'user' ? first.text.replace(/\s+/g, ' ').trim().slice(0, 60) : ''; }, [view.items]);
  useEffect(() => { ctxRef.current.onTitle(id, title); }, [id, title]);
  const [text, setText] = useState(''), [stash, setStash] = useState(''), [images, setImages] = useState<Attachment[]>([]), [queue, setQueue] = useState<{ text: string; images: Attachment[] }[]>([]);
  const [queueSending, setQueueSending] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]), [menuAt, setMenuAt] = useState(0), [openError, setOpenError] = useState(''), [user, setUser] = useState(''), [away, setAway] = useState(false);
  const greeting = useMemo(() => pickGreeting(user), [user, id]);
  const scroller = useRef<HTMLDivElement>(null), thread = useRef<HTMLDivElement>(null), box = useRef<HTMLTextAreaElement>(null), stick = useRef(true), jump = useRef(false), ctxRef = useRef(ctx); ctxRef.current = ctx;
  const [pin, setPin] = useState<{ key: string; text: string } | null>(null);
  const syncPin = useCallback(() => {
    const root = scroller.current; if (!root) return;
    const edge = root.getBoundingClientRect().top + 4;
    let hit: HTMLElement | null = null;
    for (const node of root.querySelectorAll<HTMLElement>('[data-user-key]')) { if (node.getBoundingClientRect().bottom <= edge) hit = node; else break; }
    const key = hit?.dataset.userKey ?? '', text = hit?.dataset.userPreview ?? '';
    setPin(current => current?.key === key && current.text === text ? current : key && text ? { key, text } : null);
  }, []);
  const scrollToEnd = useCallback(() => { const element = scroller.current; if (!element) return; jump.current = false; element.scrollTop = element.scrollHeight; }, []);
  const apply = (next: (view: ChatView) => ChatView) => { const value = next(viewRef.current); viewRef.current = value; setView(value); };
  const state = view.state, caps = state.capabilities, modes = caps?.permissionModes ?? (agent === 'cursor' ? ['default', 'plan', 'ask'] : MODES), effortOptions = caps?.efforts?.length ? caps.efforts : agent === 'claude' ? efforts : caps?.efforts ?? [],
    cursorOptions = agent === 'cursor' ? (caps?.configOptions ?? []).filter(option => option.id !== 'model' && option.id !== 'mode' && option.category !== 'model' && option.category !== 'mode') : [],
    maxOption = cursorOptions.find(option => isCursorMax(option) && option.options.length >= 2), contextOption = cursorOptions.find(option => option.id === 'context'), maxContext = !maxOption && contextOption ? contextEnds(contextOption) : null,
    setOption = (configId: string, value: string) => void setChat({ id, configOption: { configId, value } }).catch(ctx.fail),
    aliases = agentModels.models, catalog = caps?.catalog.length ? caps.catalog : agentModels.catalog.length ? agentModels.catalog : agent === 'claude' ? baseCatalog(agentModels.models) : [],
    selectedModel = state.model || aliases[''] || null,
    optionsForModel = (model: string | null) => modelOptions(model, catalog, aliases, agent), modelChoices = optionsForModel(selectedModel),
    resolvedModelValue = (() => { const pick = (model: string | null) => { const value = modelValue(model, aliases); return value && modelChoices.some(option => option.value === value) ? value : ''; };
      return pick(selectedModel) || pick(aliases[''] ?? null) || modelChoices.find(option => option.value !== MORE_MODELS)?.value || ''; })(),
    busy = state.status === 'working' || state.status === 'attention';

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
    const loadCommands = (names: string[] = []) => void ctx.call<CommandInfo[]>('chat/commands', { agent, ...(leaf.cwd ? { path: leaf.cwd } : {}), ...(names.length ? { names } : {}) }).then(list => { if (alive) setCommands(list); }, () => {});
    loadCommands();
    return () => { alive = false; stop(); };
  }, [id, agent, leaf.cwd]);

  // Keyed by content, not identity: `ctx` is rebuilt on every Workspace render and `state.slashCommands` is a fresh array on every server state message,
  // so depending on them re-asked the server (and spawned a `claude -p /cost` probe) on every render.
  const slashKey = state.slashCommands.join('\n');
  useEffect(() => {
    if (!slashKey) return;
    void ctxRef.current.call<CommandInfo[]>('chat/commands', { agent, ...(leaf.cwd ? { path: leaf.cwd } : {}), names: slashKey.split('\n') }).then(setCommands, () => {});
  }, [agent, leaf.cwd, slashKey]);

  useEffect(() => { if (focused && visible) box.current?.focus(); }, [focused, visible]);
  const [configuring, setConfiguring] = useState(false), [recovering, setRecovering] = useState(false), setting = useRef(false);
  const recoverSession = useCallback(() => {
    if (recovering || busy) return;
    setRecovering(true);
    void ctxRef.current.call('chat/retry', { id }).catch(ctxRef.current.fail).finally(() => setRecovering(false));
  }, [id, recovering, busy]);
  async function setChat(input: object) {
    if (agent !== 'cursor') return ctx.call('chat/set', input);
    if (setting.current) throw new Error('모델 설정을 적용 중입니다.');
    setting.current = true; setConfiguring(true);
    try { return await ctx.call('chat/set', input); }
    finally { setting.current = false; setConfiguring(false); }
  }
  const [modelsOpen, setModelsOpen] = useState(false), [resuming, setResuming] = useState(false), [resumeOpen, setResumeOpen] = useState(false);
  useEffect(() => { let alive = true;
    // The model list is a file read; the alias answers can take a CLI start. Show the list first so the picker is not stuck on the stand-ins meanwhile.
    if (agent === 'claude') void ctx.call('chat/model-catalog', { agent }).then((result: any) => { if (alive && result?.catalog?.length) setAgentModels(previous => previous.catalog.length ? previous : { ...previous, catalog: result.catalog }); }, () => {});
    void ctx.call('chat/models', { agent, id }).then(result => { if (alive) setAgentModels(result); }, ctx.fail);
    return () => { alive = false; };
  }, [agent, id, ctx.call]);
  useEffect(() => { if (!stick.current) return; if (jump.current || ctx.settings.chatAutoScroll) scrollToEnd(); }, [view.items, view.stream, view.steers.length, view.approvals.length, view.thinkingTokens, view.results, queue.length, state.status, ctx.settings.chatAutoScroll, scrollToEnd]);
  useEffect(() => {
    const element = thread.current, scroll = scroller.current;
    if (!element || !scroll) return;
    const observer = new ResizeObserver(() => { if (stick.current && (ctxRef.current.settings.chatAutoScroll || jump.current)) scrollToEnd(); syncPin(); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollToEnd, syncPin]);
  useEffect(() => {
    const el = box.current; if (!el) return;
    if (!text.trim() && !stash) { el.style.height = ''; return; }
    el.style.height = '0';
    el.style.height = `${Math.min(ctx.settings.chatComposerMax, el.scrollHeight)}px`;
  }, [text, stash, ctx.settings.chatComposerMax]);
  const onScroll = () => { const element = scroller.current; if (!element) return; const gap = element.scrollHeight - element.scrollTop - element.clientHeight; stick.current = gap < 80; setAway(gap > 240); syncPin(); };
  const jumpToUser = (key: string) => {
    const node = scroller.current?.querySelector<HTMLElement>(`[data-user-key="${CSS.escape(key)}"]`);
    if (!node) return;
    stick.current = false;
    node.scrollIntoView({ behavior: calm() ? 'auto' : 'smooth', block: 'start' });
    syncPin();
  };
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
    const names = new Map<string, CommandInfo>();
    for (const item of LOCAL.filter(entry => entry.name !== 'effort' || effortOptions.length > 0)) mergeCommand(names, item.name === 'permissions' ? { ...item, hint: `[${modes.filter(mode => mode !== 'bypassPermissions').join('|')}]` } : item.name === 'effort' ? { ...item, hint: `[${effortOptions.join('|')}]` } : item);
    for (const item of commands) mergeCommand(names, item);
    for (const item of state.commandInfo ?? []) mergeCommand(names, item);
    for (const name of state.slashCommands) {
      const known = commands.find(item => item.name === name)
        ?? commands.find(item => item.name.endsWith(`:${name}`) || (name.includes(':') && item.name === name.split(':').pop()));
      mergeCommand(names, known ?? { name, description: '' });
    }
    return [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [commands, state.slashCommands, state.commandInfo, effortOptions, modes]);
  const slash = /^\/([^\s/]*)$/.exec(text), matches = slash ? available.filter(item => {
    const query = slash[1].toLowerCase();
    if (!query) return true;
    const name = item.name.toLowerCase();
    return name.startsWith(query) || name.split(':').some(part => part.startsWith(query));
  }).slice(0, 16) : [];
  const commandDraft = useMemo(() => {
    if (matches.length > 0) return null;
    const match = /^\/([\w:.-]+)(?:\s.*)?$/.exec(text);
    if (!match) return null;
    const info = available.find(item => item.name === match[1]);
    return info?.hint ? info : null;
  }, [text, available, matches.length]);
  useEffect(() => setMenuAt(0), [slash?.[1]]);

  async function runLocal(name: string, argument: string): Promise<boolean> {
    switch (name) {
      case 'resume': await resume(); return true;
      case 'retry': await ctx.call('chat/retry', { id }); return true;
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
  const liveBlocks = streamBlocks(view);
  const seen = liveBlocks.some(block => block.type === 'text' ? block.text.trim() : block.type === 'tool_use' ? true : false),
    thought = liveBlocks.flatMap(block => block.type === 'thinking' ? [block.text.trim().split('\n').at(-1) ?? ''] : []).at(-1) ?? '';
  const stream = liveBlocks;
  // After /clear the earlier history stays in `items` but is hidden: the pane shows the start screen again.
  const shown = useMemo(() => view.items.slice(view.items.map(item => item.kind).lastIndexOf('divider') + 1), [view.items]);
  const turns = useMemo(() => turnsOf(shown), [shown]);
  const finals = useMemo(() => new Set(shown.flatMap((item, index) => isFinal(shown, index, busy) && item.kind === 'assistant' ? [item.key] : [])), [shown, busy]);
  const empty = view.ready && !shown.length && !stream.length && !busy;
  return <section className={`terminal-pane chat-pane ${focused ? 'focused' : ''}`} data-kind="chat" data-empty={empty || undefined} data-agent={agent} data-agent-state={agentState} style={{ '--chat-font': `${ctx.settings.chatFontSize}px`, '--chat-width': chatWidths[ctx.settings.chatWidth] } as CSSProperties} onMouseDownCapture={() => onFocus(id)} onFocus={() => onFocus(id)}>
    <div className="pane-tools" role="toolbar" aria-label="채팅 pane">
      <span className="pane-title" title={cwd}><span className="pane-mark"><Icon name={agent} size={12} /></span><span className="pane-label">{title || `${agentLabel} · ${basename(cwd.replace(/\\/g, '/'))}`}</span>
        {view.approvals.length > 0 && <span className="question-alert" role="img" aria-label="승인 필요" title="도구 실행 승인이 필요합니다"><Icon name="alert" size={12} /></span>}</span>
      <span className="pane-actions">
        <IconButton icon="terminal" label={view.state.status === 'idle' && view.state.sessionId ? '터미널로 전환 (같은 세션을 터미널에서 이어갑니다)' : '터미널로 전환 — 대화가 시작되고 응답이 끝난 뒤에만 가능'} disabled={view.state.status !== 'idle' || !view.state.sessionId} onClick={() => ctx.toTerminal(id)} />
        <i className="pane-sep" aria-hidden="true" />
        <IconButton icon="plus" label="새 대화 (/clear)" onClick={() => void ctx.call('chat/reset', { id }).catch(ctx.fail)} />
        <IconButton icon="splitH" label="좌우 분할" onClick={() => onSplit(id, 'row')} /><IconButton icon="splitV" label="상하 분할" onClick={() => onSplit(id, 'column')} />
        <IconButton icon={zoomed ? 'minimize' : 'maximize'} label={zoomed ? '원래 크기로' : '최대화'} onClick={() => onZoom(id)} />
        <IconButton icon="x" label="채팅 닫기" onClick={() => ctx.onClose(id)} /></span></div>
    <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
      {pin && <div className="chat-pin-wrap"><button type="button" className="chat-pin" title="요청한 내용으로 이동" onClick={() => jumpToUser(pin.key)}><Icon name="arrowUp" size={14} /><span>{pin.text}</span></button></div>}
      <div className="chat-thread" ref={thread}>
        {openError && <div className="chat-msg error" role="alert"><Icon name="alert" size={14} /><span>{openError}</span></div>}
        {turns.map((items, index) => <Turn key={items[0].key} items={items} settled={index < turns.length - 1 || (!busy && stream.length === 0)} finals={finals} results={view.results} settings={ctx.settings} working={busy} plainThinking={agent === 'claude'} onBranch={caps?.branch === false ? undefined : branch} onRewind={caps?.rewind === false ? undefined : rewind} onRecover={state.recoverable ? recoverSession : undefined} recovering={recovering} />)}
        {stream.length > 0 && <div className="chat-msg assistant streaming"><div className="chat-body"><Blocks blocks={stream} results={view.results} settings={ctx.settings} live working plainThinking={agent === 'claude'} /></div></div>}
        {busy && !seen && !toolRunning && !view.approvals.length && <ChatWorking effort={state.effort} tokens={view.thinkingTokens} thought={thought} compacting={view.compacting} />}
        {view.steers.map(item => <div className="chat-msg user" key={item.uuid}><div className="chat-bubble steer"><small className="chat-steer" title="응답이 이 메시지를 받아들이면 일반 대화로 바뀝니다. Esc로 취소할 수 있습니다.">스티어링 · 대기 중 · Esc로 취소</small>{item.text}{item.images > 0 && <small className="chat-images"><Icon name="copy" size={11} />이미지 {item.images}장</small>}</div></div>)}
        {state.error && state.status === 'idle' && !view.items.some(item => item.kind === 'error') && <ChatErrorAlert message={state.error} recoverable={state.recoverable} recovering={recovering} onRecover={state.recoverable ? recoverSession : undefined} />}
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
      <div className="chat-status-slot" inert={empty} aria-hidden={empty}><div><ChatStatusLine settings={ctx.settings} context={{ state }} /></div></div>
      <div className="chat-composer" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void attach([...event.dataTransfer.files]); }}>
        {matches.length > 0 && <ul className="chat-commands" role="listbox" aria-label="슬래시 명령">{matches.map((item, index) => <li key={item.name} role="option" aria-selected={index === menuAt}>
          <button type="button" tabIndex={-1} onMouseDown={event => { event.preventDefault(); complete(item.name); }}>
            <span className="chat-command-head"><b>/{item.name}</b>{item.hint && <code className="chat-command-hint">{item.hint}</code>}</span>
            {item.description && <span className="chat-command-desc">{item.description}</span>}
          </button></li>)}</ul>}
        {commandDraft && <p className="chat-command-args" role="status"><code>{commandDraft.hint}</code>{commandDraft.description ? <span>{commandDraft.description}</span> : null}</p>}
        {images.length > 0 && <div className="chat-attachments">{images.map((image, index) => <span key={index}><img src={image.url} alt={`첨부 이미지 ${index + 1}`} /><button type="button" aria-label="첨부 제거" onClick={() => setImages(items => items.filter((_, i) => i !== index))}><Icon name="x" size={11} /></button></span>)}</div>}
        <div className="chat-input-row">
        <textarea ref={box} rows={1} value={text} placeholder={stash ? `보관된 입력이 있습니다 (${showCombo(chatKey(ctx.settings.chatKeys, 'stash'))}로 복원)` : busy ? caps?.steer === false || agent === 'cursor' ? '응답이 끝난 뒤 순서대로 전송합니다' : `${ctx.settings.chatSendKey === 'mod-enter' ? 'Cmd/Ctrl+Enter' : 'Enter'}: 지금 끼워 넣기(스티어링) · Tab: 끝난 뒤 보내기(follow-up)` : '작업을 설명하거나 질문하세요'} aria-label="메시지 입력" disabled={!view.ready && !openError}
          onChange={event => setText(event.target.value)}
          onPaste={event => { const files = [...event.clipboardData.files]; if (files.some(file => file.type.startsWith('image/'))) { event.preventDefault(); void attach(files); } }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            const modSend = ctx.settings.chatSendKey === 'mod-enter';
            const combo = comboOf(event.nativeEvent), keyOf = (id: Parameters<typeof chatKey>[1]) => combo === chatKey(ctx.settings.chatKeys, id);
            if (keyOf('effortUp') || keyOf('effortDown')) { event.preventDefault(); if (!effortOptions.length) return; const step = keyOf('effortUp') ? 1 : -1, at = effortOptions.indexOf(state.effort ?? 'medium'); const effort = effortOptions[Math.max(0, Math.min(effortOptions.length - 1, at + step))]; if (effort !== state.effort) void setChat({ id, effort }).catch(ctx.fail); return; }
            if (keyOf('modelNext')) { event.preventDefault(); const values = optionsForModel(selectedModel).map(option => option.value).filter(value => value !== MORE_MODELS), current = modelValue(selectedModel, aliases), next = values[(values.indexOf(current) + 1) % values.length]; if (next) void setChat({ id, model: next }).catch(ctx.fail); return; }
            if (keyOf('stash')) { event.preventDefault(); if (text.trim()) { setStash(text); setText(''); } else if (stash) { setText(stash); setStash(''); } return; }
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
        <Dropdown label="권한 모드" className="chat-mode" value={state.permissionMode} options={modes.map(mode => ({ value: mode, label: permissionLabels[mode] ?? mode, icon: MODE_ICONS[mode] ?? 'tune', color: permissionModeColor(mode) }))} onChange={mode => void setChat({ id, permissionMode: mode }).catch(ctx.fail)} />
        {!empty && state.addDirs.length > 0 && <span className="chat-foot-note" title={state.addDirs.join('\n')}>폴더 +{state.addDirs.length}</span>}
        <span className="drag-space" />
        {agent === 'cursor' ? <button type="button" className="chat-model cursor-model" aria-haspopup="dialog" aria-label="모델 선택" onClick={() => setModelsOpen(true)}><span className="dd-label" style={{ color: modelAppearance(selectedModel, agent).color }}>{displayModel(selectedModel, agent)}</span><Icon name="chevronDown" size={14} /></button> : <Dropdown label="모델" className="chat-model" value={resolvedModelValue} options={modelChoices} onChange={model => { if (model === MORE_MODELS) setModelsOpen(true); else void setChat({ id, model }).catch(ctx.fail); }} />}
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
function ChatWorking({ effort, tokens, thought, compacting }: { effort: string | null; tokens: number; thought: string; compacting?: boolean }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => { const start = Date.now(), timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 500); return () => clearInterval(timer); }, []);
  const deep = !compacting && seconds >= 8, red = Math.min(100, Math.max(0, (seconds - 8) * 2));
  return <div className={`chat-working${deep ? ' deep' : ''}`} role="status" style={deep ? { color: `color-mix(in srgb, var(--error) ${red}%, var(--muted))` } : effort && effortStyle[effortLevel(effort)] ? { color: effortStyle[effortLevel(effort)].color } : undefined}
    title={thought ? undefined : '모델이 추론 내용은 보내지 않아, 경과 시간과 추정 토큰만 표시합니다.'}>
    <i className="chat-spin" />{compacting ? '컨텍스트를 압축하는 중… 대화가 길수록 오래 걸립니다' : deep ? `${effort ? `${effortLabel(effort)} Effort로 ` : ''}깊게 생각하는 중…` : '생각하는 중…'}
    <small>{seconds}초{tokens > 0 && ` · 약 ${compact(tokens)} 토큰`}</small>{thought && <em>{thought}</em>}</div>;
}

// The ring beside the model: how full the context window is (green to red like the status line's usage items). Clicking opens the popover with the context
// reading and the plan's usage limits, the same readings as the status bar's Claude usage.
function ContextRing({ state, ctx, active, agent }: { state: ChatState; ctx: ChatCtx; active: boolean; agent: 'claude' | 'codex' | 'cursor' }) {
  const { settings } = ctx, gauge = contextGauge(state), percent = gauge.percent, radius = 10.25, length = 2 * Math.PI * radius, panel = `chat-usage-${useId()}`;
  const { usage, loading, load } = useUsage(agent === 'codex' ? 'codex' : 'claude', ctx.projectId, active && agent !== 'cursor', settings.usageRefresh);
  const windows = usage ? (settings.claudeSession ? usage.windows : usage.windows.filter(item => item.key !== 'session')) : [];
  const shown = state.capabilities?.context !== false && state.contextTokens > 0;
  const compacting = gauge.autoCompact;
  const ink = compacting ? 'var(--term-magenta)' : `hsl(${usageHue(percent)} 62% var(--usage-l, 52%))`;
  const basisLabel = compacting ? `Auto Compact 창 ${compact(gauge.basis)}` : `컨텍스트 ${percent}%`;
  return <>
    <button type="button" className={`chat-ring${compacting ? ' auto-compact' : ''}`} popoverTarget={panel} aria-label={state.capabilities?.context === false ? '컨텍스트 미제공 · 사용 한도 보기' : `${basisLabel} 사용 · 사용 한도 보기`} title={state.capabilities?.context === false ? 'CLI가 컨텍스트 사용량을 제공하지 않습니다' : `${compacting ? `Auto Compact ${percent}% · 창 ${compact(gauge.basis)}` : `컨텍스트 ${percent}%`} · 클릭하면 상세`} onClick={() => { if (agent !== 'cursor') void load(true); }}>
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <circle cx="14" cy="14" r={radius} className="track" />
        {shown && compacting && <circle cx="14" cy="14" r={radius} className="max-hint" strokeDasharray={`${Math.max(1.5, length * Math.min(100, Math.round(gauge.used * 100 / gauge.max)) / 100)} ${length}`} transform="rotate(-90 14 14)" />}
        {shown && <circle cx="14" cy="14" r={radius} className="fill" style={{ stroke: ink }} strokeDasharray={`${Math.max(1.5, length * percent / 100)} ${length}`} transform="rotate(-90 14 14)" />}
        {shown && <text x="14" y="14" textAnchor="middle" dominantBaseline="central" fill={ink}>{percent}</text>}</svg></button>
    <div id={panel} popover="auto" className="usage-detail chat-usage" role="dialog" aria-label="컨텍스트와 사용 한도" onToggle={event => placeAbove(event, 'right')}>
      <header><strong>컨텍스트</strong>{compacting && <span className="auto-compact-badge">Auto Compact</span>}</header>
      <div className="usage-row">
        <div><span>{state.capabilities?.context === false ? 'CLI가 컨텍스트 정보를 제공하지 않습니다' : `${compact(gauge.used)} / ${compact(gauge.basis)} 토큰`}</span><b className={settings.usageColors ? 'graded' : ''} style={settings.usageColors ? usageHueStyle(percent) : undefined}>{state.capabilities?.context === false ? '미제공' : `${percent}%`}</b></div>
        {state.capabilities?.context !== false && <progress className={settings.usageColors ? 'graded' : ''} style={settings.usageColors ? usageHueStyle(percent) : undefined} value={percent} max={100} aria-label={compacting ? 'Auto Compact 창 사용률' : '컨텍스트 사용률'} />}
      </div>
      {compacting && <p className="usage-note auto-compact-detail">
        {compact(gauge.basis)} 창 기준 · 최대 {compact(gauge.max)}{gauge.autoEstimated ? ' · auto 추정' : ''} · 가득 차면 자동 요약
      </p>}
      <header className="chat-usage-title"><strong>사용 한도</strong>{usage?.plan && <span className="plan">{usage.plan}</span>}
        <button type="button" className="icon-btn" title="새로고침" aria-label="사용 한도 새로고침" aria-busy={loading} onClick={() => { if (agent !== 'cursor') void load(true); }}><Icon name="refresh" size={13} /></button></header>
      {agent === 'cursor' ? <p className="usage-note">CLI가 사용 한도를 제공하지 않습니다.</p> : usage ? <UsageRows windows={windows} colors={settings.usageColors} /> : <p className="usage-note">{loading ? '불러오는 중…' : '표시할 한도 정보가 없습니다.'}</p>}
      {usage?.error && <p className="usage-note warn">{usage.error}</p>}
    </div>
  </>;
}
