import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { basename, type Leaf } from './api';
import { DiffView, usageHue, type Settings } from './Editor';
import { placeAbove, UsageRows, usageHueStyle, useUsage } from './Usage';
import { Icon, IconButton, SettingGlyph } from './Icon';
import { ChatStatusLine } from './ChatStatus';
import { CodeBlock, LiveMarkdown, Markdown } from './Markdown';
import { chatKey, ro, withSettingChange, pickGreeting, comboOf, showCombo, compact, contextEnds, contextGauge, contextPercent, contextReported, contextWindow, cursorSettingName, effortLabel, effortLevel, effortStyle, efforts, emptyView, fromReplay, cursorModelGroups, displayModel, isChatSlashCommand, isCursorEffort, isCursorMax, isCursorSwitch, lastIndexWhere, maxOffValue, maxOnValue, maxSelected, modelProvider, modelAppearance, modelQuickDefaults, modelQuickRows, modelRows, modelValue, parseChatSlashCommand, permissionLabels, permissionModeColor, reduce, shortModel, toolSummary, turnAllowsMessageActions, type Approval, type AssistantItem, type Block, type CatalogModel, type ChatState, type ChatView, type Item, type SettingsChange, type Tone } from './chat-model';
import { copyText, toastAttached } from './toast';
import { Dropdown, Modal, ModelLabel } from './views';
import { useHiddenAgents } from './installed-agents';
import { clearChatDevDraft, loadChatDevDraft, saveChatDevDraft } from './chat-dev-draft';

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
  toTerminal(id: string, fresh: boolean): void;
  resumeChat(id: string, agent: 'claude' | 'codex' | 'cursor'): Promise<void>;
  // Continue a conversation made with the plain `claude` CLI as a new chat tab.
  importCliChat(sessionId: string): Promise<void>;
  // Start screen only: replace this pane with an empty chat of another provider (forget = drop the stored empty chat).
  switchAgent(id: string, agent: 'claude' | 'codex' | 'cursor', forget: boolean): void;
  onSettingsChange(settings: Settings): void;
};
type Props = { leaf: Leaf; focused: boolean; zoomed: boolean; visible: boolean; ctx: ChatCtx; onFocus(id: string): void; onZoom(id: string): void; onSplit(id: string, direction: 'row' | 'column'): void };
type Attachment = { mime: string; data: string; url: string };
type CommandInfo = { name: string; description: string; hint?: string };

const PROVIDER_LABELS = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' } as const;
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
// Codex's sandbox is its own setting, apart from the approval mode: null follows the mode. Workspace-write has a network switch, shown as its own entry.
const sandboxOptions = [
  { value: 'follow', label: '샌드박스: 모드에 따름', icon: 'security', hint: '기본·편집 허용·자동은 작업 폴더 쓰기, Bypass는 전체 접근, 계획은 읽기 전용' },
  { value: 'read-only', label: '샌드박스: 읽기 전용', icon: 'visibility', color: 'var(--sandbox-read-only)', hint: '파일을 읽기만 합니다' },
  { value: 'workspace-write', label: '샌드박스: 작업 폴더 쓰기', icon: 'edit_note', color: 'var(--sandbox-workspace)', hint: '작업 폴더와 추가 폴더에만 쓰고 네트워크는 막습니다' },
  { value: 'workspace-write+network', label: '샌드박스: 작업 폴더 쓰기 + 네트워크', icon: 'public', color: 'var(--sandbox-network)', hint: '작업 폴더에만 쓰되 네트워크는 허용합니다' },
  { value: 'danger-full-access', label: '샌드박스: 전체 접근', icon: 'warning', color: 'var(--sandbox-full)', hint: '샌드박스 없이 모든 파일과 네트워크에 접근합니다' }
];
// Cursor's sandbox is its own switch (`--sandbox`): "follow" leaves it to Cursor's own settings. Changing it restarts the idle process.
const cursorSandboxOptions = [
  { value: 'follow', label: '샌드박스: 기본', icon: 'security', hint: 'Cursor 자체 설정(~/.cursor/cli-config.json)을 그대로 따릅니다' },
  { value: 'enabled', label: '샌드박스: 켜짐', icon: 'security', color: 'var(--sandbox-workspace)', hint: '명령을 샌드박스 안에서 실행합니다' },
  { value: 'disabled', label: '샌드박스: 꺼짐', icon: 'warning', color: 'var(--sandbox-full)', hint: '샌드박스 없이 실행합니다' }
];
const sandboxKey = (sandbox?: string | null, network?: boolean) => !sandbox ? 'follow' : sandbox === 'workspace-write' && network ? 'workspace-write+network' : sandbox;
const sandboxFromKey = (key: string): [string | null, boolean] => key === 'follow' ? [null, false] : key === 'workspace-write+network' ? ['workspace-write', true] : [key, false];
const MODE_ICONS: Record<string, string> = { default: 'front_hand', acceptEdits: 'edit_note', plan: 'assignment', auto: 'bolt', bypassPermissions: 'lock_open', ask: 'help' };
const cycleMode = (modes: string[], mode: string) => { const ring = modes.filter(item => item !== 'bypassPermissions'); return ring[(ring.indexOf(mode) + 1) % ring.length]; };
// Shift+Tab cycles like Claude Code: default -> accept edits -> plan -> auto. Bypass is dropdown-only.
const nextMode = (mode: string) => ({ default: 'acceptEdits', acceptEdits: 'plan', plan: 'auto', auto: 'default' } as Record<string, string>)[mode] ?? 'default';
// What the CLI offers, asked of the local server once per page load (chat/models: alias -> concrete id, plus the CLI's own model list).
// Until it answers (or when the CLI has no list), the three aliases and Fable stand in.
const baseCatalog = (aliases: Record<string, string> = {}): CatalogModel[] => [
  ...['opus', 'sonnet', 'haiku'].map(alias => ({ id: aliases[alias] ?? alias, name: aliases[alias] ? shortModel(aliases[alias]) : alias[0].toUpperCase() + alias.slice(1), family: alias, window: 1_000_000, main: true })),
  { id: 'claude-fable-5-2', name: 'Fable 5.2', family: 'fable', window: 1_000_000, main: true }];
const MORE_MODELS = '__more__';
// The quick menu: one top model per provider (all Cursor-provider models stay), user-pinned models, the current one if missing, then "more models".
function modelOptions(model: string | null, catalog = baseCatalog(), aliases: Record<string, string> = {}, agent: 'claude' | 'codex' | 'cursor' = 'claude', pins: string[] = []) {
  const all = modelRows(catalog, aliases), quick = modelQuickRows(all, agent, pins), current = modelValue(model, aliases), known = all.find(row => row.value === current);
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
type Optimistic = { model?: string; effort?: string | null; permissionMode?: string; runEverything?: boolean; sandbox?: string | null; options?: Record<string, string> };
// What a Cursor setting call is about to change, keyed so a later call on the same setting supersedes an earlier one.
function optimisticPatch(input: any): Optimistic {
  const patch: Optimistic = {};
  if (typeof input.model === 'string') patch.model = input.model;
  if (input.effort !== undefined) patch.effort = input.effort;
  if (typeof input.permissionMode === 'string') patch.permissionMode = input.permissionMode;
  if (typeof input.runEverything === 'boolean') patch.runEverything = input.runEverything;
  if (input.sandbox !== undefined) patch.sandbox = input.sandbox;
  if (input.configOption) patch.options = { [input.configOption.configId]: input.configOption.value };
  return patch;
}
const mergeOptimistic = (current: Optimistic, patch: Optimistic): Optimistic => ({ ...current, ...patch, ...(patch.options && { options: { ...current.options, ...patch.options } }) });
const optimisticKeys = (patch: Optimistic) => Object.keys(patch).flatMap(key => key === 'options' ? Object.keys(patch.options!).map(id => `opt:${id}`) : [key]);
function dropOptimistic(current: Optimistic, keys: string[]): Optimistic {
  const next: any = { ...current, options: current.options && { ...current.options } };
  for (const key of keys) { if (key.startsWith('opt:')) delete next.options[key.slice(4)]; else delete next[key]; }
  if (next.options && !Object.keys(next.options).length) delete next.options;
  return next;
}
function withOptimistic(state: ChatState, o: Optimistic): ChatState {
  if (!Object.keys(o).length) return state;
  const caps = state.capabilities;
  return { ...state, ...(o.model !== undefined && { model: o.model }), ...(o.effort !== undefined && { effort: o.effort }), ...(o.permissionMode !== undefined && { permissionMode: o.permissionMode }),
    ...(o.runEverything !== undefined && { runEverything: o.runEverything }), ...(o.sandbox !== undefined && { sandbox: o.sandbox }),
    ...(caps && o.options && { capabilities: { ...caps, configOptions: caps.configOptions?.map((option: any) => o.options![option.id] !== undefined ? { ...option, currentValue: o.options![option.id] } : option) } }) };
}
function ModelsModal({ current, call, agent, fallback, aliases, settings, onSettingsChange, onPick, onClose }: { current: string; agent: 'claude' | 'codex' | 'cursor'; fallback: CatalogModel[]; aliases: Record<string, string>; settings: Settings; onSettingsChange: ChatCtx['onSettingsChange']; call: ChatCtx['call']; onPick(value: string): void; onClose(): void }) {
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [party, setParty] = useState(modelProvider(current)?.party ?? 'First Party');
  const panelId = useId(), list = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  useEffect(() => { search.current?.focus(); }, []);
  useEffect(() => { void call('chat/model-catalog', { agent }).then((result: any) => setCatalog(result?.catalog ?? []), () => setCatalog([])); }, [call, agent]);
  const rows = useMemo(() => modelRows(catalog?.length ? catalog : fallback, aliases), [catalog, fallback, aliases]);
  const defaultQuick = useMemo(() => new Set(modelQuickDefaults(rows, agent).map(row => row.value)), [rows, agent]);
  const pins = settings.chatModelPins[agent] ?? [];
  const pinned = useMemo(() => new Set(pins), [pins]);
  const togglePin = (value: string, on: boolean) => {
    const list = settings.chatModelPins[agent] ?? [];
    const next = on ? [...list, value] : list.filter(item => item !== value);
    onSettingsChange({ ...settings, chatModelPins: { ...settings.chatModelPins, [agent]: [...new Set(next)] } });
  };
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
        {group.models.map(row => {
          const inQuick = defaultQuick.has(row.value) || pinned.has(row.value);
          return <button type="button" role="option" key={row.value} className="models-row" aria-selected={current === row.value} title={row.id} onClick={() => onPick(row.value)}>
            <span className="models-name" style={{ color: modelAppearance(`${row.family} ${row.id} ${row.label}`, agent).color }}><ModelLabel text={row.label} /></span>
            {!defaultQuick.has(row.value) && <label className="models-pin" title="빠른 메뉴에 표시" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
              <input type="checkbox" role="switch" aria-label={`${row.label} 빠른 메뉴에 표시`} checked={inQuick} onChange={event => togglePin(row.value, event.target.checked)} />
            </label>}
            {current === row.value && <span className="models-selected"><span>선택됨</span><Icon name="check" size={14} /></span>}
            {agent !== 'cursor' && <span className="models-id">{row.id}{row.oneM ? '[1m]' : ''}</span>}
          </button>;
        })}
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

const ToolCard = memo(function ToolCard({ block, result, settings, running }: { block: Extract<Block, { type: 'tool_use' }>; result?: { content: string; isError: boolean }; settings: Settings; running: boolean }) {
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
});

// Streamed text arrives in bursts; it is revealed a few characters per frame (faster the bigger the backlog) so it flows instead of jumping.
// When the block stops streaming the reveal does not snap to the end: it catches up quickly. Text that was never live is shown whole.
// Reduced-motion users (and the "smooth streaming" setting off) get the text as it comes.
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
function useReveal(text: string, live: boolean, smooth: boolean) {
  const animate = smooth && !calm();
  const [shown, setShown] = useState(() => live && animate ? 0 : text.length);
  const goal = useRef(text.length), streaming = useRef(live); goal.current = text.length; streaming.current = live;
  const behind = animate && shown < text.length;
  useEffect(() => {
    if (!behind) return;
    let frame = requestAnimationFrame(function tick() {
      setShown(count => {
        const target = goal.current; if (count >= target) return count;
        return Math.min(target, count + Math.max(streaming.current ? 1 : 3, Math.ceil((target - count) / (streaming.current ? 10 : 4))));
      });
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [behind]);
  return animate ? Math.min(shown, text.length) : text.length;
}
const RevealText = memo(function RevealText({ text, live, markdown, smooth }: { text: string; live: boolean; markdown: boolean; smooth: boolean }) {
  const shown = useReveal(text, live, smooth), [streamed] = useState(live), part = shown < text.length ? text.slice(0, shown) : text, flowing = live || shown < text.length;
  if (!markdown) return <>{part}</>;
  // A block that streamed keeps the live renderer for good, so finishing never swaps its DOM.
  return streamed ? <LiveMarkdown text={part} live={flowing} /> : <Markdown text={part} />;
});

function BlockView({ block, result, settings, running, plainThinking, enter }: { block: Block; result?: { content: string; isError: boolean }; settings: Settings; running: boolean; plainThinking?: boolean; enter?: boolean }) {
  const live = Boolean(block.partial);
  if (block.type === 'text' || (plainThinking && block.type === 'thinking')) return <RevealText text={block.text} live={live && Boolean(enter)} markdown smooth={settings.chatSmoothStream} />;
  if (block.type === 'thinking') return <details className="chat-thinking" open={settings.chatThinkingOpen === 'always' ? true : settings.chatThinkingOpen === 'never' ? false : live}><summary>생각</summary><p><RevealText text={block.text} live={live && Boolean(enter)} markdown={false} smooth={settings.chatSmoothStream} /></p></details>;
  if (block.type === 'tool_use') return <ToolCard block={block} result={result} settings={settings} running={running} />;
  return null;
}

const shownBlock = (block: Block) => block.type === 'tool_use' || ((block.type === 'text' || block.type === 'thinking') && Boolean(block.text.trim()));
const turnsOf = (items: Item[]) => {
  const turns: Item[][] = [];
  let current: Item[] = [];
  for (const item of items) {
    // What ADE itself says (a changed setting, /cost) is its own group, so the copy / branch / rewind icons stay with the answer they belong to.
    const isLocal = (entry?: Item) => (entry?.kind === 'note' || entry?.kind === 'info') && entry.local === true;
    if (current.length && (item.kind === 'user' || item.kind === 'divider' || (isLocal(item) && !isLocal(current.at(-1))))) { turns.push(current); current = []; }
    current.push(item);
  }
  if (current.length) turns.push(current);
  return turns;
};

type TurnProps = { items: Item[]; settled: boolean; working: boolean; results: ChatView['results']; settings: Settings; plainThinking?: boolean; onBranch?(uuid: string): void; onRewind?(uuid: string): void; onRecover?(): void; recovering?: boolean };
type Part = { kind: 'block'; key: string; item: AssistantItem; block: Block } | { kind: 'item'; key: string; item: Item };
const toolIds = (items: Item[]) => items.flatMap(item => item.kind === 'assistant' ? item.blocks.flatMap(block => block.type === 'tool_use' ? [block.id] : []) : []);
// A turn re-renders only when one of its own items, its own tools' results or its phase changes: a delta in the last turn leaves the others alone.
const sameTurn = (a: TurnProps, b: TurnProps) => a.items.length === b.items.length && a.items.every((item, index) => item === b.items[index]) && a.settled === b.settled && a.working === b.working
  && a.settings === b.settings && a.plainThinking === b.plainThinking && a.onBranch === b.onBranch && a.onRewind === b.onRewind && a.onRecover === b.onRecover && a.recovering === b.recovering
  && (a.results === b.results || toolIds(a.items).every(id => a.results[id] === b.results[id]));

// One request and everything that answered it, as one flat list of rows with stable keys. The answer is the text after the last tool or thought;
// the rows before it are the process. Which rows are process is only a class, so nothing moves to another parent (and remounts) as the turn goes on:
// the process folds away with a height transition when the turn ends, and can be opened again.
const Turn = memo(function Turn({ items, settled, working, results, settings, plainThinking, onBranch, onRewind, onRecover, recovering }: TurnProps) {
  const lead = items[0]?.kind === 'user' || items[0]?.kind === 'divider' ? items[0] : null;
  const body = lead ? items.slice(1) : items;
  const parts: Part[] = [];
  for (const item of body) {
    if (item.kind !== 'assistant') { parts.push({ kind: 'item', key: item.key, item }); continue; }
    item.blocks.forEach((block, index) => { if (shownBlock(block)) parts.push({ kind: 'block', key: `${item.key}|${block.key ?? index}`, item, block }); });
  }
  const flat = parts.filter((part): part is Extract<Part, { kind: 'block' }> => part.kind === 'block');
  let cut = flat.length;
  while (cut > 0 && flat[cut - 1].block.type === 'text' && !flat[cut - 1].item.sub) cut -= 1;
  const process = new Set(flat.slice(0, cut).map(part => part.key)), steps = flat.slice(0, cut).filter(part => part.block.type !== 'text');
  const tools = steps.filter(part => part.block.type === 'tool_use').length, answered = cut < flat.length;
  const [override, setOverride] = useState<boolean | null>(null);
  const folded = steps.length > 0 && settled && (override ?? answered);
  const finalAt = settled ? lastIndexWhere(body, item => item.kind === 'assistant' && !item.sub) : -1, finalItem = finalAt >= 0 ? body[finalAt] as AssistantItem : undefined;
  const answer = flat.slice(cut).map(part => part.block).filter((block): block is Extract<Block, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n\n')
    || (finalItem?.blocks.filter((block): block is Extract<Block, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n\n') ?? '');
  // While the turn runs its steps are plain rows in the thread; once it is over they are boxed under the "과정" header, so an opened process is clearly one unit.
  const boxed = steps.length > 0 && settled, lastStep = cut > 0 ? flat[cut - 1].key : '';
  const head = boxed && <button key="process" type="button" className="chat-process-head" aria-expanded={!folded} onClick={() => setOverride(!folded)}>
    <span className="icon material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">account_tree</span>
    <strong>과정</strong>
    <span className="chat-process-summary">{tools ? `도구 ${tools}개` : '생각'}</span>
    <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={14} />
  </button>;
  const rows: ReactNode[] = [];
  for (const part of parts) {
    if (part.kind === 'item') { rows.push(<Message key={part.key} item={part.item} onRecover={onRecover} recovering={recovering} />); continue; }
    if (part.key === flat[0]?.key && head) rows.push(head);
    const inProcess = process.has(part.key);
    rows.push(<div key={part.key} className={`chat-row${inProcess ? ' in-process' : ''}${inProcess && part.key === lastStep ? ' process-last' : ''}${part.item.sub ? ' sub' : ''}`} data-enter={part.item.fresh || undefined} inert={inProcess && folded ? true : undefined}>
      <div><BlockView block={part.block} result={part.block.type === 'tool_use' ? results[part.block.id] : undefined} settings={settings} running={working && !settled} plainThinking={plainThinking} enter={part.item.fresh} /></div>
    </div>);
  }
  const allowActions = finalItem && turnAllowsMessageActions(items);
  return <div className="chat-turn" data-folded={folded || undefined} data-boxed={boxed || undefined}>
    {lead && <Message item={lead} />}
    {rows}
    {allowActions && <div className="chat-msg-actions">{answer.trim() && <IconButton icon="copy" label="응답 복사" size={13} onClick={() => copyText(answer)} />}
      {(finalItem.uuid || !onBranch) && <IconButton icon="branch" disabled={!onBranch} label={onBranch ? '여기서 분기 (새 탭에서 이 지점부터 이어가기)' : '이 CLI는 과거 지점 분기를 지원하지 않습니다'} size={13} onClick={() => onBranch?.(finalItem.uuid!)} />}
      {(finalItem.uuid || !onRewind) && <IconButton icon="undo" disabled={!onRewind} label={onRewind ? '여기로 되돌리기 (이후 대화 삭제)' : '이 CLI는 과거 지점 복원을 지원하지 않습니다'} size={13} onClick={() => onRewind?.(finalItem.uuid!)} />}</div>}
  </div>;
}, sameTurn);

function ChatErrorAlert({ message, recoverable, recovering, onRecover, enter }: { message: string; recoverable?: boolean; recovering?: boolean; onRecover?(): void; enter?: boolean }) {
  return <div className="chat-msg error" role="alert" data-enter={enter || undefined}><Icon name="alert" size={14} /><span>{message}</span>
    {recoverable && onRecover && <button type="button" className="chat-recover" disabled={recovering} onClick={onRecover}>{recovering ? '복구 중…' : '세션 복구'}</button>}</div>;
}

// What a slash command printed, right under the command. Long output starts clipped.
function CommandOutput({ text, isError, enter }: { text: string; isError: boolean; enter?: boolean }) {
  const [open, setOpen] = useState(false), long = text.length > 1500 || text.split('\n').length > 16;
  // A short one-line result ("Compacted", "완료 · 출력 없음") is a system line like the other notes; only real output gets the monospaced card.
  if (!text || (!long && !text.includes('\n') && text.length <= 80)) return <SystemLine text={text || '완료 · 출력 없음'} error={isError} enter={enter} />;
  return <div className={`chat-msg command-output${isError ? ' error-output' : ''}`} data-enter={enter || undefined}>
    <pre className={long && !open ? 'clipped' : undefined}>{text}</pre>
    {long && <button type="button" className="chat-command-more" onClick={() => setOpen(value => !value)}>{open ? '접기' : '전체 보기'}</button>}
  </div>;
}

// A system message (a changed setting, an interrupted answer, a short command result) as a rule with the text in the middle, like the compact divider.
function SystemLine({ text, error, enter, tones, rev }: { text: string; error?: boolean; enter?: boolean; tones?: Tone[]; rev?: number }) {
  // Each changed value (a model, an Effort, a permission mode) is drawn in the colour it has in the footer; the rules stay the default colour.
  const nodes: ReactNode[] = []; let cursor = 0;
  for (const tone of tones ?? []) {
    const at = text.indexOf(tone.value, cursor); if (at < 0) continue;
    nodes.push(text.slice(cursor, at), <b key={at} style={{ color: tone.color }}>{(tone.bars != null || tone.icon) && <SettingGlyph icon={tone.icon} bars={tone.bars} size={14} />}{tone.value}</b>);
    cursor = at + tone.value.length;
  }
  nodes.push(text.slice(cursor));
  return <div className={`chat-divider note${error ? ' error' : ''}${text.includes('\n') ? ' multi' : ''}`} role="note" data-enter={enter || undefined}>
    <span key={rev ?? 0} data-rev={rev || undefined}>{nodes}</span>
  </div>;
}

// Everything in the thread that is not an assistant reply. Assistant blocks are rows of their Turn.
const Message = memo(function Message({ item, onRecover, recovering }: { item: Item; onRecover?(): void; recovering?: boolean }) {
  const enter = item.fresh || undefined;
  if (item.kind === 'user') {
    const preview = item.text.replace(/\s+/g, ' ').trim() || (item.images > 0 ? `이미지 ${item.images}장` : '');
    const slash = parseChatSlashCommand(item.text);
    if (slash) return <div className="chat-msg user" data-enter={enter} data-user-key={item.key} data-user-preview={preview.slice(0, 280)}><div className="chat-bubble command"><span className="chat-command-name">/{slash.name || '…'}</span>{slash.args ? ` ${slash.args}` : ''}{item.images > 0 && <small className="chat-images"><Icon name="copy" size={11} />이미지 {item.images}장</small>}</div></div>;
    return <div className="chat-msg user" data-enter={enter} data-user-key={item.key} data-user-preview={preview.slice(0, 280)}><div className="chat-bubble"><Markdown text={item.text} />{item.images > 0 && <small className="chat-images"><Icon name="copy" size={11} />이미지 {item.images}장</small>}</div></div>;
  }
  if (item.kind === 'divider') return <div className="chat-divider" role="separator" data-enter={enter}><span>새 대화</span></div>;
  if (item.kind === 'compact') return <div className="chat-divider compact" role="separator" data-enter={enter}><span>{item.trigger === 'auto' ? '자동 압축' : '컨텍스트 압축'}{item.preTokens != null && item.postTokens != null ? ` · ${compact(item.preTokens)} → ${compact(item.postTokens)} 토큰 (${Math.max(0, Math.round((item.preTokens - item.postTokens) * 100 / Math.max(1, item.preTokens)))}% 감소)` : ' 완료'}</span></div>;
  if (item.kind === 'error') return <ChatErrorAlert message={item.message} recoverable={item.recoverable} recovering={recovering} onRecover={onRecover} enter={enter} />;
  if (item.kind === 'command') return <CommandOutput text={item.text} isError={item.isError} enter={enter} />;
  if (item.kind === 'note') return <SystemLine text={item.text} tones={item.tones} rev={item.rev} enter={enter} />;
  if (item.kind === 'info') return <div className="chat-row info" data-enter={enter || undefined}><div><Markdown text={item.text} /></div></div>;
  return null;
});

function ApprovalCard({ approval, onAnswer }: { approval: Approval; onAnswer(allow: boolean, always: boolean, answers?: Record<string, string[]>): void }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const input = approval.input ?? {}, canAlways = approval.suggestions.length > 0, summary = toolSummary(approval.tool, input), filePath = String(input.file_path ?? '');
  return <div className="chat-approval" role="alertdialog" aria-label={`${approval.tool} 실행 승인`}>
    <header><Icon name="alert" size={15} /><strong>{approval.tool}</strong><span>실행하려면 허용이 필요합니다</span></header>
    <div className="chat-approval-body">{approval.tool === 'Bash' ? <CodeBlock code={String(input.command ?? '')} lang="bash" /> : <p className="chat-approval-line">{summary}</p>}
      {(approval.tool === 'Edit' || approval.tool === 'Write') && filePath && filePath !== summary && <p className="chat-approval-line">{filePath}</p>}</div>
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
  // Sidebar and header: rename → AI/agent title → first non-slash prompt since the last /clear.
  const title = (view.state.chatTitle ?? '').slice(0, 60);
  useEffect(() => { ctxRef.current.onTitle(id, title); }, [id, title]);
  const [text, setText] = useState(''), [stash, setStash] = useState(''), [images, setImages] = useState<Attachment[]>([]), [queue, setQueue] = useState<{ text: string; images: Attachment[] }[]>([]);
  useEffect(() => {
    const saved = loadChatDevDraft(ctx.projectId, id);
    if (saved) setText(current => current || saved);
  }, [ctx.projectId, id]);
  useEffect(() => {
    const timer = setTimeout(() => saveChatDevDraft(ctx.projectId, id, text), 200);
    return () => clearTimeout(timer);
  }, [ctx.projectId, id, text]);
  const [queueSending, setQueueSending] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]), [menuAt, setMenuAt] = useState(0), [openError, setOpenError] = useState(''), [user, setUser] = useState(''), [away, setAway] = useState(false);
  const greeting = useMemo(() => pickGreeting(user), [user, id]);
  const [foot, setFoot] = useState<HTMLDivElement | null>(null), fitSig = useRef(''), tunePanel = `chat-tune-${useId()}`, scroller = useRef<HTMLDivElement>(null), thread = useRef<HTMLDivElement>(null), box = useRef<HTMLTextAreaElement>(null), stick = useRef(true), jump = useRef(false), ctxRef = useRef(ctx); ctxRef.current = ctx;
  const [pin, setPin] = useState<{ key: string; text: string } | null>(null);
  const syncPin = useCallback(() => {
    const root = scroller.current; if (!root) return;
    const edge = root.getBoundingClientRect().top + 4;
    let hit: HTMLElement | null = null;
    for (const node of root.querySelectorAll<HTMLElement>('[data-user-key]')) { if (node.getBoundingClientRect().bottom <= edge) hit = node; else break; }
    const key = hit?.dataset.userKey ?? '', text = hit?.dataset.userPreview ?? '';
    setPin(current => current?.key === key && current.text === text ? current : key && text ? { key, text } : null);
  }, []);
  // Following the bottom: content growth glides the view down a fraction of the gap per frame instead of snapping a line at a time. Only the user's own
  // scrolling (wheel, touch, keys, scrollbar) lets go, so a fold collapsing or a block growing never unpins it; reaching the bottom pins it again.
  const follow = useRef(0), pinFrame = useRef(0);
  const followBottom = useCallback(() => {
    if (!stick.current || !(ctxRef.current.settings.chatAutoScroll || jump.current) || follow.current) return;
    const step = () => {
      follow.current = 0;
      const element = scroller.current; if (!element || !stick.current) return;
      const gap = element.scrollHeight - element.clientHeight - element.scrollTop;
      if (gap <= 1) { jump.current = false; return; }
      // A whole history at once (opening, switching back) is not animated.
      element.scrollTop += calm() || gap > element.clientHeight * 1.5 ? gap : Math.max(1, Math.ceil(gap * 0.2));
      follow.current = requestAnimationFrame(step);
    };
    follow.current = requestAnimationFrame(step);
  }, []);
  const release = () => { stick.current = false; cancelAnimationFrame(follow.current); follow.current = 0; };
  // Server messages arrive per token. They are queued and applied together once per frame (a timer stands in when frames are paused in a hidden
  // window), so a burst costs one render instead of one per message.
  const inbox = useRef<any[]>([]), drainAt = useRef<{ frame: number; timer: ReturnType<typeof setTimeout> | null }>({ frame: 0, timer: null });
  const drain = useCallback(() => {
    const at = drainAt.current; cancelAnimationFrame(at.frame); if (at.timer) clearTimeout(at.timer); at.frame = 0; at.timer = null;
    const batch = inbox.current; if (!batch.length) return; inbox.current = [];
    let next = viewRef.current;
    for (const message of batch) next = message.type === 'chat/event' ? reduce(next, message.event) : { ...next, state: message.state };
    viewRef.current = next; setView(next);
  }, []);
  const enqueue = (message: any) => {
    inbox.current.push(message);
    const at = drainAt.current; if (!at.frame) at.frame = requestAnimationFrame(drain); if (!at.timer) at.timer = setTimeout(drain, 100);
  };
  useEffect(() => () => { const at = drainAt.current; cancelAnimationFrame(at.frame); if (at.timer) clearTimeout(at.timer); cancelAnimationFrame(follow.current); cancelAnimationFrame(pinFrame.current); }, []);
  const apply = (next: (view: ChatView) => ChatView) => { drain(); const value = next(viewRef.current); viewRef.current = value; setView(value); };
  const [optimistic, setOptimistic] = useState<Optimistic>({}), latest = useRef<Record<string, number>>({}), seq = useRef(0);
  const state = agent === 'cursor' ? withOptimistic(view.state, optimistic) : view.state, caps = state.capabilities, modes = caps?.permissionModes ?? (agent === 'cursor' ? ['default', 'plan', 'ask'] : MODES), effortOptions = caps?.efforts?.length ? caps.efforts : agent === 'claude' ? efforts : caps?.efforts ?? [],
    cursorOptions = agent === 'cursor' ? (caps?.configOptions ?? []).filter(option => option.id !== 'model' && option.id !== 'mode' && option.category !== 'model' && option.category !== 'mode') : [],
    maxOption = cursorOptions.find(option => isCursorMax(option) && option.options.length >= 2), contextOption = cursorOptions.find(option => option.id === 'context'), maxContext = !maxOption && contextOption ? contextEnds(contextOption) : null,
    setOption = (configId: string, value: string) => void setChat({ id, configOption: { configId, value } }).catch(ctx.fail),
    aliases = agentModels.models, catalog = caps?.catalog.length ? caps.catalog : agentModels.catalog.length ? agentModels.catalog : agent === 'claude' ? baseCatalog(agentModels.models) : [],
    selectedModel = state.model || aliases[''] || null,
    modelPins = ctx.settings.chatModelPins[agent] ?? [],
    optionsForModel = (model: string | null) => modelOptions(model, catalog, aliases, agent, modelPins), modelChoices = optionsForModel(selectedModel),
    resolvedModelValue = (() => { const pick = (model: string | null) => { const value = modelValue(model, aliases); return value && modelChoices.some(option => option.value === value) ? value : ''; };
      return pick(selectedModel) || pick(aliases[''] ?? null) || modelChoices.find(option => option.value !== MORE_MODELS)?.value || ''; })(),
    busy = state.status === 'working' || state.status === 'attention';

  const [providerSwap, setProviderSwap] = useState(false);
  useEffect(() => {
    if (!providerSwap) return;
    if (view.ready || openError) setProviderSwap(false);
  }, [providerSwap, view.ready, openError]);

  // Attach to the server's session: subscribe first, then ask for the stored events; whatever arrived in between is applied after the replay (seq makes that safe).
  useEffect(() => {
    viewRef.current = emptyView();
    setView(emptyView());
    inbox.current = [];
    let alive = true, opened = false; const early: any[] = [];
    const handle = (message: any) => {
      if (message.type === 'chat/event') {
        enqueue(message);
        if (message.event?.kind === 'divider' && message.event.reason === 'clear') setQueue([]);
        // A withdrawn steering message goes back into the input box (unless something is being typed there) so it is not lost.
        if (message.event?.kind === 'steer' && message.event.phase === 'cancelled' && typeof message.event.text === 'string') setText(current => current || message.event.text);
      }
      else if (message.type === 'chat/state') { enqueue(message); ctxRef.current.onState(id, message.state); }
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
    return () => { alive = false; stop(); };
  }, [id, agent, leaf.cwd]);

  // One ask per command list, after the replay: a stored chat already knows its CLI's commands, and asking before that (with no names) made the server
  // start a `claude -p` probe and then raced the second, named answer. Keyed by content: `state.slashCommands` is a fresh array on every state message.
  const slashKey = state.slashCommands.join('\n');
  useEffect(() => {
    if (!view.ready) return;
    let alive = true;
    void ctxRef.current.call<CommandInfo[]>('chat/commands', { agent, ...(leaf.cwd ? { path: leaf.cwd } : {}), ...(slashKey ? { names: slashKey.split('\n') } : {}) }).then(list => { if (alive) setCommands(list); }, () => {});
    return () => { alive = false; };
  }, [agent, leaf.cwd, slashKey, view.ready]);

  useEffect(() => { if (focused && visible) box.current?.focus(); }, [focused, visible]);
  // Cursor's process starts in about six seconds; starting it while the tab is in use means the first setting change or message does not wait for it.
  useEffect(() => { if (agent === 'cursor' && view.ready && focused && visible) void ctxRef.current.call('chat/warm', { id }).catch(() => {}); }, [agent, id, view.ready, focused, visible]);
  const [recovering, setRecovering] = useState(false);
  // Cursor changes are applied through its ACP session while it answers too, so nothing is locked: the choice shows at once (`optimistic`) and is taken
  // back if the server refuses it.
  const locked = '';
  // Stable, so the turns' memo is not broken each time `busy` flips.
  const busyRef = useRef(busy), recoveringRef = useRef(false); busyRef.current = busy;
  const recoverSession = useCallback(() => {
    if (recoveringRef.current || busyRef.current) return;
    recoveringRef.current = true; setRecovering(true);
    void ctxRef.current.call('chat/retry', { id }).catch(ctxRef.current.fail).finally(() => { recoveringRef.current = false; setRecovering(false); });
  }, [id]);
  async function setChat(input: any) {
    if (agent !== 'cursor') return ctx.call('chat/set', input);
    const patch = optimisticPatch(input), token = ++seq.current;
    const keys = optimisticKeys(patch);
    for (const key of keys) latest.current[key] = token;
    setOptimistic(current => mergeOptimistic(current, patch));
    try { return await ctx.call('chat/set', input); }
    finally {
      const done = keys.filter(key => latest.current[key] === token);
      for (const key of done) delete latest.current[key];
      if (done.length) setOptimistic(current => dropOptimistic(current, done));
    }
  }
  const [modelsOpen, setModelsOpen] = useState(false), [resuming, setResuming] = useState(false), [resumeOpen, setResumeOpen] = useState(false);
  useEffect(() => { let alive = true;
    // The model list is a file read; the alias answers can take a CLI start. Show the list first so the picker is not stuck on the stand-ins meanwhile.
    if (agent === 'claude') void ctx.call('chat/model-catalog', { agent }).then((result: any) => { if (alive && result?.catalog?.length) setAgentModels(previous => previous.catalog.length ? previous : { ...previous, catalog: result.catalog }); }, () => {});
    void ctx.call('chat/models', { agent, id }).then(result => { if (alive) setAgentModels(result); }, ctx.fail);
    return () => { alive = false; };
  }, [agent, id, ctx.call]);
  // Any size change of the thread (new text, a fold, a card opening) or of the viewport (dock growing) re-follows the bottom; nothing else needs to.
  // The bottom row never wraps. When its content would overflow it steps through fit levels (CSS keyed on data-fit): 1 = permission mode, sandbox and Effort lose their labels,
  // 2 = the extra switches move into the settings button, 3 = notes fold away and the model name may shorten, 4 = permission mode and sandbox move into the settings button. It measures the real overflow, so there is no fixed pixel threshold.
  const fit = useCallback(() => {
    const el = foot; if (!el) return;
    const sig = `${el.textContent}|${el.clientWidth}|${el.childElementCount}`;
    if (sig === fitSig.current) return;
    for (let level = 0; level <= 4; level++) { el.dataset.fit = String(level); if (el.scrollWidth <= el.clientWidth + 1) break; }
    fitSig.current = sig;
  }, [foot]);
  useLayoutEffect(fit);
  useEffect(() => {
    const el = foot; if (!el) return;
    const observer = new ResizeObserver(() => { fitSig.current = ''; fit(); });
    observer.observe(el); void document.fonts?.ready.then(() => { fitSig.current = ''; fit(); });
    return () => observer.disconnect();
  }, [fit]);
  useEffect(() => {
    const element = thread.current, scroll = scroller.current;
    if (!element || !scroll) return;
    const observer = new ResizeObserver(followBottom);
    observer.observe(element); observer.observe(scroll);
    return () => observer.disconnect();
  }, [followBottom]);
  useEffect(() => {
    const el = box.current; if (!el) return;
    if (!text.trim() && !stash) { el.style.height = ''; return; }
    el.style.transition = 'none';
    el.style.height = 'auto';
    const height = `${Math.min(ctx.settings.chatComposerMax, el.scrollHeight)}px`;
    el.style.height = height;
    requestAnimationFrame(() => { el.style.transition = ''; });
  }, [text, stash, ctx.settings.chatComposerMax]);
  const onScroll = () => {
    const element = scroller.current; if (!element) return;
    const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (gap < 4) stick.current = true;
    setAway(!stick.current && gap > 240);
    if (!pinFrame.current) pinFrame.current = requestAnimationFrame(() => { pinFrame.current = 0; syncPin(); });
  };
  const jumpToUser = (key: string) => {
    const node = scroller.current?.querySelector<HTMLElement>(`[data-user-key="${CSS.escape(key)}"]`);
    if (!node) return;
    release();
    node.scrollIntoView({ behavior: calm() ? 'auto' : 'smooth', block: 'start' });
    syncPin();
  };
  const branch = useCallback((uuid: string) => void ctxRef.current.branchChat(id, uuid, leaf.cwd).catch(ctxRef.current.fail), [id, leaf.cwd]);
  const rewind = useCallback((uuid: string) => void ctxRef.current.pick('여기로 되돌릴까요? 이후 대화는 사라지고 에이전트가 이미 바꾼 파일은 그대로입니다.', [{ id: 'yes', label: '되돌리기' }]).then(choice => choice === 'yes' ? ctxRef.current.call('chat/rewind', { id, uuid }) : undefined).catch(ctxRef.current.fail), [id]);
  const jumpToEnd = () => { const element = scroller.current; if (!element) return; stick.current = true; setAway(false); element.scrollTo({ top: element.scrollHeight, behavior: calm() ? 'auto' : 'smooth' }); };

  const note = (message: string) => apply(view => ({ ...view, items: [...view.items, { kind: 'note', key: `n${Date.now()}${Math.random()}`, text: message, local: true, fresh: true }] }));
  // A switched setting: the line just above is edited when it is also a switch, so repeating /model or /effort does not pile up lines.
  const changed = (change: SettingsChange) => apply(view => ({ ...view, items: withSettingChange(view.items, change, `n${Date.now()}${Math.random()}`) }));
  // A reply that reads like a chat message (markdown), for the report commands.
  const info = (message: string) => apply(view => ({ ...view, items: [...view.items, { kind: 'info', key: `i${Date.now()}${Math.random()}`, text: message, local: true, fresh: true }] }));
  const transmit = async (message: string, attachments: Attachment[], steer = false) => {
    stick.current = true; jump.current = true;
    try { await ctx.call('chat/send', { id, text: message, steer, images: attachments.map(({ mime, data }) => ({ mime, data })) }); }
    catch (cause) { ctx.fail(cause); }
  };
  // A message typed while Claude answers waits here and goes out when the turn ends.
  useEffect(() => {
    if (state.status !== 'idle' || !queue.length || !view.ready || queueSending) return;
    const [next, ...rest] = queue; setQueueSending(true); setQueue(rest);
    void transmit(next.text, next.images).finally(() => setQueueSending(false));
  }, [state.status, queue, view.ready, queueSending]);

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
    if (locked && ['model', 'effort', 'permissions'].includes(name)) { note(`지금은 설정을 바꿀 수 없습니다. ${locked}`); return true; }
    switch (name) {
      case 'resume': await resume(); return true;
      case 'retry': await ctx.call('chat/retry', { id }); note('마지막 요청을 같은 세션으로 다시 보냈습니다.'); return true;
      case 'clear': await ctx.call('chat/reset', { id }); return true;
      case 'exit': ctx.onClose(id); return true;
      case 'config': ctx.onOpenSettings(); return true;
      case 'model': {
        if (agent === 'cursor' && !argument) { setModelsOpen(true); return true; }
        const value = argument || await ctx.pick('모델 선택', modelRows(catalog, aliases).map(row => ({ id: row.value, label: row.label })));
        if (value) { await setChat({ id, model: value }); { const row = modelRows(catalog, aliases).find(item => item.value === value), label = row?.label ?? displayModel(value, agent); changed({ model: { value: label, color: modelAppearance(row ? `${row.family} ${row.id} ${row.label}` : value, agent).color ?? 'currentColor' } }); } }
        return true;
      }
      case 'effort': {
        if (!effortOptions.length) { note('이 CLI는 별도의 Effort 선택지를 제공하지 않습니다. 지원되는 모델 변형을 모델 메뉴에서 선택하세요.'); return true; }
        const value = argument || await ctx.pick('Effort 선택', effortOptions.map(item => ({ id: item, label: `${item} · ${effortLabel(item)}` })));
        if (value) { if (!effortOptions.includes(value)) note(`알 수 없는 Effort: ${value} (${effortOptions.join(', ')})`); else { await setChat({ id, effort: value }); const style = effortStyle[effortLevel(value)] ?? effortStyle.medium; changed({ effort: { value: effortLabel(value), color: style.color, icon: style.icon, bars: style.bars } }); } }
        return true;
      }
      case 'permissions': {
        const value = argument || await ctx.pick('권한 모드', modes.map(mode => ({ id: mode, label: permissionLabels[mode] ?? mode })));
        if (value) { if (!modes.includes(value)) note(`알 수 없는 권한 모드: ${value}`); else { await setChat({ id, permissionMode: value }); changed({ mode: { value: `${permissionLabels[value] ?? value} 모드`, color: permissionModeColor(value), icon: MODE_ICONS[value] ?? 'tune' } }); } }
        return true;
      }
      case 'cost': case 'status': {
        const tokens = state.tokens, n = (value: number) => value.toLocaleString('ko-KR'), cost = state.costUsd === null ? '미제공' : `$${state.costUsd.toFixed(4)}`, model = modelChoices.find(option => option.value === modelValue(selectedModel, aliases))?.label ?? displayModel(state.model, agent);
        const gauge = contextGauge(state);
        const contextRow: [string, string] | null = name === 'status' && contextReported(state)
          ? ['컨텍스트', `${compact(gauge.used)} / ${compact(gauge.basis)} (${gauge.percent}%)`]
          : name === 'status' && state.capabilities?.context !== false
            ? ['컨텍스트', '첫 응답 후 CLI가 보고하면 표시됩니다']
            : null;
        const rows: [string, string][] = name === 'cost'
          ? [['모델', model], ['비용', `${cost} · ${state.turns}턴`],
            ...(caps?.tokens === false ? [['토큰', 'CLI가 토큰 사용량을 제공하지 않습니다'] as [string, string]] : [['입력 토큰', n(tokens.input)], ['출력 토큰', n(tokens.output)], ['캐시 읽기', n(tokens.cacheRead)], ['캐시 쓰기', n(tokens.cacheCreate)]] as [string, string][])]
          : [['모델', model], ['Effort', effortLabel(state.effort ?? 'medium')], ['권한 모드', permissionLabels[state.permissionMode] ?? state.permissionMode],
            ['비용', `${cost} · ${state.turns}턴`], ...(contextRow ? [contextRow] : []), ['세션', state.sessionId ? `\`${state.sessionId}\`` : '아직 없음']];
        info(`### ${name === 'cost' ? '비용' : '상태'}\n\n| 항목 | 값 |\n|---|---|\n${rows.map(([label, value]) => `| ${label} | ${value} |`).join('\n')}`);
        return true;
      }
      case 'help': note(`이 창에서 바로 처리: ${LOCAL.map(item => `/${item.name}`).join(' ')}\n${agentLabel}가 지원하는 명령만 사용할 수 있습니다. 화면형 선택이 필요한 명령은 터미널 탭에서 쓰세요.`); return true;
      default: return false;
    }
  }
  // Enter while Claude works steers the running turn (sent now, folded into it); Tab is the follow-up (held until the turn ends). `/…` lines never steer.
  async function submit(mode: 'steer' | 'queue' = 'steer') {
    const message = text.trim();
    if ((!message && !images.length) || !view.ready) return;
    const command = /^\/([\w:-]+)(?:\s+(.*))?$/s.exec(message);
    if (command && LOCAL.some(item => item.name === command[1])) { setText(''); clearChatDevDraft(ctx.projectId, id); try { await runLocal(command[1], (command[2] ?? '').trim()); } catch (cause) { ctx.fail(cause); } return; }
    const attachments = images; setText(''); setImages([]); clearChatDevDraft(ctx.projectId, id);
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
  // After /clear the earlier history stays in `items` but is hidden: the pane shows the start screen again.
  const shown = useMemo(() => { const from = lastIndexWhere(view.items, item => item.kind === 'divider'); return from < 0 ? view.items : view.items.slice(from + 1); }, [view.items]);
  const turns = useMemo(() => turnsOf(shown), [shown]), lastTurn = turns.at(-1);
  // What the running turn is doing right now, for the status row under it ('' = thinking).
  const activity = useMemo(() => {
    if (!busy || !lastTurn) return { label: '', thought: '' };
    if (view.approvals.length) return { label: '승인을 기다리는 중', thought: '' };
    for (let at = lastTurn.length - 1; at >= 0; at--) {
      const item = lastTurn[at];
      if (item.kind === 'assistant') {
        const block = item.blocks[lastIndexWhere(item.blocks, shownBlock)];
        if (!block) continue;
        if (block.type === 'tool_use') return { label: view.results[block.id] ? '' : `${block.name} ${block.partial ? '준비 중' : '실행 중'}…`, thought: '' };
        if (block.type === 'thinking') return { label: '', thought: block.partial ? (block.text.trim().split('\n').at(-1) ?? '').slice(-200) : '' };
        return { label: block.partial ? '응답을 작성하는 중…' : '', thought: '' };
      }
      if (item.kind === 'user') { const slash = parseChatSlashCommand(item.text); return { label: slash?.name ? `/${slash.name} 실행 중…` : '', thought: '' }; }
    }
    return { label: '', thought: '' };
  }, [busy, lastTurn, view.approvals.length, view.results]);
  const hiddenAgents = useHiddenAgents(ctx.settings.agentsOff);
  // The switcher lists the current provider plus every visible one; with nobody to switch to, it is not shown at all.
  const providers = (['claude', 'codex', 'cursor'] as const).filter(item => item === agent || !hiddenAgents.includes(item));
  const empty = view.ready && !shown.length && !busy;
  const startScreen = empty || providerSwap;
  const turnError = lastTurn?.some(item => item.kind === 'error');
  const otherCursorOptions = agent === 'cursor' ? cursorOptions.filter(option => !isCursorEffort(option)) : [];
  // Cursor models can come with many options: from two on (besides model and Effort) they all live behind one settings button.
  const forcePanel = otherCursorOptions.length >= 2;
  const modeDd = <Dropdown locked={locked} label="권한 모드" className="chat-mode" value={state.permissionMode} options={modes.map(mode => ({ value: mode, label: permissionLabels[mode] ?? mode, icon: MODE_ICONS[mode] ?? 'tune', color: permissionModeColor(mode) }))} onChange={mode => { void setChat({ id, permissionMode: mode }).catch(ctx.fail); if (agent === 'codex' && mode === 'auto' && busy) note('자동 승인은 진행 중인 응답이 끝난 뒤 다음 응답부터 적용됩니다. (Bypass는 바로 적용됩니다)'); }} />;
  const sandboxDd = <>{agent === 'codex' && caps?.sandboxes?.length ? <Dropdown locked={locked} label="샌드박스" className="chat-mode chat-sandbox" value={sandboxKey(state.sandbox, state.network)} options={sandboxOptions} onChange={key => { const [sandbox, network] = sandboxFromKey(key); void setChat({ id, sandbox, network }).catch(ctx.fail); }} /> : null}{agent === 'cursor' && caps?.sandboxes?.length ? <Dropdown locked={locked} label="샌드박스" className="chat-mode chat-sandbox" value={state.sandbox ?? 'follow'} options={cursorSandboxOptions} onChange={key => { void setChat({ id, sandbox: key === 'follow' ? null : key }).catch(ctx.fail); }} /> : null}</>;
  const bypassBtn = agent === 'cursor' && caps?.runEverything ? <button type="button" className="chat-switch run-everything" aria-pressed={state.runEverything === true} aria-label="Run Everything" disabled={Boolean(locked)} title={locked || 'Bypass (Cursor의 Run Everything): 허용 목록에 없는 명령도 묻지 않고 실행합니다'} onClick={() => { void setChat({ id, runEverything: !state.runEverything }).catch(ctx.fail); }}>Bypass</button> : null;
  const noteItems = <>{agent === 'cursor' && state.restartPending && <span className="chat-foot-note locked" role="status" title="샌드박스는 Cursor를 다시 시작해야 적용됩니다. 진행 중인 응답이 끝나면 적용됩니다.">샌드박스: 다음 응답부터 적용</span>}{!empty && state.addDirs.length > 0 && <span className="chat-foot-note" title={state.addDirs.join('\n')}>폴더 +{state.addDirs.length}</span>}</>;
  const effortCtl = <>{effortOptions.length > 0 && <span className="effort-wrap"><Dropdown locked={locked} label="Effort" className={`chat-effort effort-${effortLevel(state.effort) || 'medium'}`} value={state.effort ?? (effortOptions.includes('medium') ? 'medium' : '')} placeholder="Effort" options={effortOptions.map(item => ({ value: item, label: effortLabel(item), ...effortStyle[effortLevel(item)] }))} onChange={effort => void setChat({ id, effort: effort || null }).catch(ctx.fail)} /><EffortSparks level={effortLevel(state.effort) || 'medium'} /></span>}</>;
  const optionItems = <>{cursorOptions.filter(isCursorSwitch).map(option => <button type="button" key={option.id} className={`chat-switch${option.id === 'fast' ? ' fast' : ''}`} aria-pressed={option.currentValue === 'true'} disabled={Boolean(locked)} title={locked || option.description || (option.id === 'fast' ? 'Fast 모드' : option.name)} onClick={() => setOption(option.id, option.currentValue === 'true' ? 'false' : 'true')}>{option.id === 'fast' ? 'Fast' : option.name}</button>)}{maxOption && <button type="button" className="chat-max" aria-pressed={maxSelected(maxOption)} disabled={Boolean(locked)} title={locked || maxOption.description || 'MAX 모드'} onClick={() => setOption(maxOption.id, maxSelected(maxOption) ? maxOffValue(maxOption) : maxOnValue(maxOption))}>MAX</button>}{!maxOption && maxContext && <button type="button" className="chat-max" aria-pressed={contextOption?.currentValue === maxContext.on} disabled={Boolean(locked)} title={locked || '이 모델의 최대 컨텍스트'} onClick={() => setOption(contextOption!.id, contextOption?.currentValue === maxContext.on ? maxContext.off : maxContext.on)}>MAX</button>}{cursorOptions.filter(option => !isCursorSwitch(option) && !isCursorEffort(option) && !(maxOption && option.id === maxOption.id)).map(option => { const name = cursorSettingName(option); return <span key={option.id} title={option.description}><Dropdown locked={locked} label={name} className="chat-model-config" value={option.currentValue} placeholder={name} options={option.options.map(item => ({ value: item.value, label: `${name}: ${item.name}`, hint: item.description }))} onChange={value => setOption(option.id, value)} /></span>; })}</>;
  const hasMore = forcePanel || Boolean(bypassBtn) || (!empty && state.addDirs.length > 0) || (agent === 'cursor' && state.restartPending) || cursorOptions.some(option => isCursorSwitch(option) || (!isCursorEffort(option) && !(maxOption && option.id === maxOption.id))) || Boolean(maxOption || maxContext);
  const panelItems = <><span className="panel-mode">{modeDd}{sandboxDd}</span>{bypassBtn}{optionItems}{noteItems}</>;
  const tuneButton = <span className={`tune-wrap${forcePanel ? ' forced' : ''}${hasMore ? ' more' : ''}`}>
    <button type="button" className="chat-tune" popoverTarget={tunePanel} aria-label="더보기" title="더보기 (샌드박스, 토글, MAX 등)">
      <span className="tune-ico tune-mode" style={{ color: permissionModeColor(state.permissionMode) }}><SettingGlyph icon={MODE_ICONS[state.permissionMode] ?? 'tune'} size={15} /></span>
      <span className="tune-ico"><SettingGlyph icon="tune" size={15} /></span>
      {agent === 'cursor' && state.runEverything && <span className="tune-ico" style={{ color: 'var(--sandbox-full)' }}><SettingGlyph icon="lock_open" size={15} /></span>}
      {cursorOptions.filter(isCursorSwitch).filter(option => option.currentValue === 'true').map(option => <span className="tune-ico" key={option.id}><SettingGlyph icon={option.id === 'fast' ? 'bolt' : 'toggle_on'} size={15} /></span>)}
      {((maxOption && maxSelected(maxOption)) || (!maxOption && maxContext && contextOption?.currentValue === maxContext.on)) && <span className="tune-ico" style={{ color: '#f2566e' }}><SettingGlyph icon="local_fire_department" size={15} /></span>}</button>
    <div id={tunePanel} popover="auto" className="chat-tune-panel" role="dialog" aria-label="채팅 옵션" onToggle={event => placeAbove(event, 'right')}>{panelItems}</div>
  </span>;
  return <section className={`terminal-pane chat-pane ${focused ? 'focused' : ''}`} data-feedback-region="채팅 pane" data-kind="chat" data-empty={startScreen || undefined} data-swap={providerSwap || undefined} data-agent={agent} data-agent-state={agentState} style={{ '--chat-font': `${ctx.settings.chatFontSize}px`, '--chat-width': chatWidths[ctx.settings.chatWidth] } as CSSProperties} onMouseDownCapture={() => onFocus(id)} onFocus={() => onFocus(id)}>
    <div className="pane-tools" role="toolbar" aria-label="채팅 pane">
      <span className="pane-title" title={cwd}><span className="pane-mark"><Icon name={agent} size={12} /></span><span className="pane-label">{title || `${agentLabel} · ${basename(cwd.replace(/\\/g, '/'))}`}</span>
        {view.approvals.length > 0 && <span className="question-alert" role="img" aria-label="승인 필요" title="도구 실행 승인이 필요합니다"><Icon name="alert" size={12} /></span>}</span>
      <span className="pane-actions">
        <IconButton icon="terminal" label={view.state.status !== 'idle' ? '터미널로 전환 — 응답이 끝난 뒤 가능' : view.state.sessionId ? '터미널로 전환 (같은 세션을 터미널에서 이어갑니다)' : '터미널로 전환 (빈 대화이므로 새 터미널을 엽니다)'} className={view.state.status !== 'idle' ? 'soft-disabled' : ''} onClick={() => {
          if (view.state.status !== 'idle') { ctx.fail(new Error(view.approvals.length ? '승인 요청에 먼저 답한 뒤 터미널로 전환할 수 있습니다.' : '응답이 끝난 뒤 터미널로 전환할 수 있습니다.')); return; }
          ctx.toTerminal(id, !view.state.sessionId);
        }} />
        <i className="pane-sep" aria-hidden="true" />
        <IconButton icon="plus" label="새 대화 (/clear)" onClick={() => void ctx.call('chat/reset', { id }).catch(ctx.fail)} />
        <IconButton icon="splitH" label="좌우 분할" onClick={() => onSplit(id, 'row')} /><IconButton icon="splitV" label="상하 분할" onClick={() => onSplit(id, 'column')} />
        <IconButton icon={zoomed ? 'minimize' : 'maximize'} label={zoomed ? '원래 크기로' : '최대화'} onClick={() => onZoom(id)} />
        <IconButton icon="x" label="채팅 닫기" onClick={() => ctx.onClose(id)} /></span></div>
    <div className="chat-scroll" ref={scroller} onScroll={onScroll} onWheel={event => { if (event.deltaY < 0) release(); }} onTouchMove={release}
      onKeyDown={event => { if (['PageUp', 'ArrowUp', 'Home'].includes(event.key)) release(); }} onPointerDown={event => { if (event.target === event.currentTarget) release(); }}>
      {pin && <div className="chat-pin-wrap"><button type="button" className="chat-pin" title="요청한 내용으로 이동" onClick={() => jumpToUser(pin.key)}><Icon name="arrowUp" size={14} /><span>{pin.text}</span></button></div>}
      <div className="chat-thread" ref={thread}>
        {openError && <div className="chat-msg error" role="alert"><Icon name="alert" size={14} /><span>{openError}</span></div>}
        {turns.map((items, index) => { const current = index === turns.length - 1; return <Turn key={items[0].key} items={items} settled={!current || !busy} working={current && busy} results={view.results} settings={ctx.settings} plainThinking={agent === 'claude'} onBranch={caps?.branch === false ? undefined : branch} onRewind={caps?.rewind === false ? undefined : rewind} onRecover={state.recoverable ? recoverSession : undefined} recovering={recovering} />; })}
        {!empty && <ChatStatusRow active={busy} effort={state.effort} tokens={view.thinkingTokens} label={view.compacting ? '컨텍스트를 압축하는 중… 대화가 길수록 오래 걸립니다' : activity.label} thought={activity.thought} />}
        {view.steers.map(item => <div className="chat-msg user" key={item.uuid}><div className="chat-bubble steer"><small className="chat-steer" title="응답이 이 메시지를 받아들이면 일반 대화로 바뀝니다. Esc로 취소할 수 있습니다.">스티어링 · 대기 중 · Esc로 취소</small>{item.text}{item.images > 0 && <small className="chat-images"><Icon name="copy" size={11} />이미지 {item.images}장</small>}</div></div>)}
        {state.error && state.status === 'idle' && !turnError && <ChatErrorAlert message={state.error} recoverable={state.recoverable} recovering={recovering} onRecover={state.recoverable ? recoverSession : undefined} />}
      </div>
    </div>
    {resumeOpen && <ResumeModal agent={agent} exclude={id} call={ctx.call} onClose={() => setResumeOpen(false)} onPick={choice => void pickResume(choice)} />}
    {modelsOpen && <ModelsModal current={modelValue(selectedModel, aliases)} call={ctx.call} agent={agent} fallback={catalog} aliases={aliases} settings={ctx.settings} onSettingsChange={ctx.onSettingsChange} onClose={() => setModelsOpen(false)} onPick={value => { setModelsOpen(false); void setChat({ id, model: value }).catch(ctx.fail); }} />}
    <div className="chat-start-slot chat-greeting" inert={!startScreen} aria-hidden={!startScreen}>
      <div><div className="chat-empty"><h2><span className="chat-empty-mark"><Icon name={agent} size={32} /></span>{greeting}</h2></div></div>
    </div>
    <div className="chat-dock">
      {away && <button type="button" className="chat-jump" title="맨 아래로" aria-label="맨 아래로 이동" onClick={jumpToEnd}><Icon name="arrowDown" size={16} /></button>}
      {view.approvals.map(approval => <ApprovalCard key={approval.requestId} approval={approval} onAnswer={(allow, always, answers) => answer(approval, allow, always, answers)} />)}
      {queue.length > 0 && <div className="chat-queue"><div role="status">Follow-up {queue.length}개 · 현재 응답이 끝나면 순서대로 전송</div>
        <ol>{queue.map((item, index) => <li key={index}><span>{item.text}</span><IconButton icon="x" label={`대기 메시지 취소: ${item.text}`} size={12} onClick={() => setQueue(items => items.filter((_, i) => i !== index))} /></li>)}</ol></div>}
      <div className="chat-status-slot" inert={empty} aria-hidden={empty}><div><ChatStatusLine settings={ctx.settings} context={{ state }} /></div></div>
      <div className="chat-composer" data-feedback-region="채팅 입력창" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void attach([...event.dataTransfer.files]); }}>
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
      <div className="chat-foot" ref={setFoot} data-fit="0">
        <label className="chat-attach" title="이미지 첨부 (붙여넣기·끌어놓기도 가능)"><Icon name="plus" size={16} /><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={event => { void attach([...(event.target.files ?? [])]); event.target.value = ''; }} /></label>
        <span className="fit-mode">{modeDd}{sandboxDd}</span>{bypassBtn && !forcePanel && <span className="fit-inline">{bypassBtn}</span>}<span className="fit-note">{noteItems}</span>
        <span className="drag-space" />
        {agent === 'cursor' ? <button type="button" className="chat-model cursor-model" disabled={Boolean(locked)} title={locked || undefined} aria-haspopup="dialog" aria-label="모델 선택" onClick={() => setModelsOpen(true)}><span className="dd-label" style={{ color: modelAppearance(selectedModel, agent).color }}>{displayModel(selectedModel, agent)}</span><Icon name="chevronDown" size={14} /></button> : <Dropdown label="모델" className="chat-model" value={resolvedModelValue} options={modelChoices} onChange={model => { if (model === MORE_MODELS) setModelsOpen(true); else void setChat({ id, model }).catch(ctx.fail); }} />}
        {effortCtl}{!forcePanel && <span className="fit-inline">{optionItems}</span>}{tuneButton}
        <ContextRing state={state} ctx={ctx} active={visible} agent={agent} />
        {busy ? <button type="button" className="chat-send stop" title="중단 (Esc)" aria-label="응답 중단" onClick={interrupt}><Icon name="stop" size={15} /></button>
          : <button type="button" className="chat-send" title="보내기 (Enter)" aria-label="보내기" disabled={!view.ready || (!text.trim() && !images.length)} onClick={() => void submit()}><Icon name="arrowUp" size={16} /></button>}
      </div>
      </div>
      <div className="chat-start-slot" inert={!startScreen} aria-hidden={!startScreen}><div>
        <button type="button" className="chat-resume" disabled={!view.ready || resuming || busy} onClick={() => void resume()}><Icon name="refresh" size={16} />{resuming ? '불러오는 중…' : '이전 대화 불러오기'}</button></div></div>
    </div>
    <div className="chat-bottom-space" aria-hidden="true" />
    {providers.length > 1 && <div className="chat-start-slot chat-provider-slot" inert={!startScreen} aria-hidden={!startScreen}><div>
      <div className="chat-providers" role="group" aria-label="Provider 전환">{providers.map(item => <button type="button" key={item} className="chat-provider" aria-pressed={item === agent} disabled={!view.ready || busy} title={item === agent ? undefined : `${PROVIDER_LABELS[item]}로 전환`} onClick={() => { if (item !== agent) ctx.switchAgent(id, item, !view.items.length); }}><Icon name={item} size={14} />{PROVIDER_LABELS[item]}</button>)}</div>
    </div></div>}
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

// The status row under the running turn. It stays mounted for the whole turn (and collapses smoothly when it ends) and only its words change, so the
// thread does not jump each time a tool starts or the first token arrives. The CLI sends no thinking text for current models, only a running token
// estimate, so that and the elapsed time are what can be shown; after 8s of uninterrupted thinking it says how hard it is thinking (the Effort setting) and drifts to red.
function ChatStatusRow({ active, effort, tokens, label, thought }: { active: boolean; effort: string | null; tokens: number; label: string; thought: string }) {
  // `seconds` is the whole turn (what the small counter shows); `thinking` is how long the current bare "thinking" stretch has lasted. It restarts every time the
  // words change, so a long tool run does not make the model look as if it had been thinking hard all along. The restart happens while rendering, not in an effect,
  // so the first frame after a tool ends cannot flash the old, deep value.
  const [now, setNow] = useState(() => Date.now()), [turnAt, setTurnAt] = useState(now), [phase, setPhase] = useState({ label, at: now });
  if (phase.label !== label) setPhase({ label, at: Date.now() });
  useEffect(() => {
    if (!active) return;
    const start = Date.now(); setTurnAt(start); setNow(start); setPhase(current => ({ ...current, at: start }));
    const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer);
  }, [active]);
  const seconds = Math.max(0, Math.floor((now - turnAt) / 1000)), thinking = Math.max(0, Math.floor((now - phase.at) / 1000));
  const deep = active && !label && thinking >= 8, red = Math.min(100, Math.max(0, (thinking - 8) * 2));
  return <div className="chat-status-row" data-active={active || undefined} aria-hidden={!active}>
    <div><div className={`chat-working${deep ? ' deep' : ''}`} role="status" style={deep ? { color: `color-mix(in srgb, var(--error) ${red}%, var(--muted))` } : !label && effort && effortStyle[effortLevel(effort)] ? { color: effortStyle[effortLevel(effort)].color } : undefined}
      title={thought ? undefined : '모델이 추론 내용은 보내지 않아, 경과 시간과 추정 토큰만 표시합니다.'}>
      <i className="chat-spin" /><span className="chat-working-label">{label || (deep ? `${effort ? `${effortLabel(effort)} Effort로 ` : ''}깊게 생각하는 중…` : '생각하는 중…')}</span>
      <small>{seconds}초{tokens > 0 && ` · 약 ${compact(tokens)} 토큰`}</small>{thought && <em>{thought}</em>}</div></div>
  </div>;
}

// The ring beside the model: how full the context window is (green to red like the status line's usage items). Clicking opens the popover with the context
// reading and the plan's usage limits, the same readings as the status bar's Claude usage.
function ContextRing({ state, ctx, active, agent }: { state: ChatState; ctx: ChatCtx; active: boolean; agent: 'claude' | 'codex' | 'cursor' }) {
  const { settings } = ctx, gauge = contextGauge(state), percent = gauge.percent, radius = 10.25, length = 2 * Math.PI * radius, panel = `chat-usage-${useId()}`;
  const usageProvider = agent === 'codex' ? 'codex' : agent === 'cursor' ? 'cursor' : 'claude';
  const { usage, loading, load } = useUsage(usageProvider, ctx.projectId, active, settings.usageRefresh);
  const windows = usage ? (agent === 'cursor' ? usage.windows : (settings.claudeSession ? usage.windows : usage.windows.filter(item => item.key !== 'session'))) : [];
  const supported = state.capabilities?.context !== false;
  const shown = supported && contextReported(state);
  const waiting = supported && !contextReported(state);
  const compacting = gauge.autoCompact;
  const ink = compacting ? 'var(--term-magenta)' : `hsl(${usageHue(percent)} 62% var(--usage-l, 52%))`;
  const basisLabel = compacting ? `Auto Compact 창 ${compact(gauge.basis)}` : `컨텍스트 ${percent}%`;
  const ringTitle = !supported ? 'CLI가 컨텍스트 사용량을 제공하지 않습니다'
    : waiting ? '첫 응답 후 컨텍스트 사용량이 표시됩니다'
    : `${compacting ? `Auto Compact ${percent}% · 창 ${compact(gauge.basis)}` : `컨텍스트 ${percent}%`} · 클릭하면 상세`;
  return <>
    <button type="button" className={`chat-ring${compacting ? ' auto-compact' : ''}${waiting ? ' pending' : ''}`} popoverTarget={panel} aria-label={waiting ? '컨텍스트 대기 · 상세 보기' : `${basisLabel} · 상세 보기`} title={ringTitle} onClick={() => void load(true)}>
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <circle cx="14" cy="14" r={radius} className="track" />
        {shown && compacting && <circle cx="14" cy="14" r={radius} className="max-hint" strokeDasharray={`${Math.max(1.5, length * Math.min(100, Math.round(gauge.used * 100 / gauge.max)) / 100)} ${length}`} transform="rotate(-90 14 14)" />}
        {shown && <circle cx="14" cy="14" r={radius} className="fill" style={{ stroke: ink }} strokeDasharray={`${Math.max(1.5, length * percent / 100)} ${length}`} transform="rotate(-90 14 14)" />}
        {shown && <text x="14" y="14" textAnchor="middle" dominantBaseline="central" fill={ink}>{percent}</text>}</svg></button>
    <div id={panel} popover="auto" className="usage-detail chat-usage" role="dialog" aria-label="컨텍스트와 사용 한도" onToggle={event => placeAbove(event, 'right')}>
      <header><strong>컨텍스트</strong>{compacting && <span className="auto-compact-badge">Auto Compact</span>}</header>
      <div className="usage-row">
        <div><span>{waiting ? '아직 보고된 사용량이 없습니다' : `${compact(gauge.used)} / ${compact(gauge.basis)} 토큰`}</span><b className={settings.usageColors ? 'graded' : ''} style={settings.usageColors ? usageHueStyle(percent) : undefined}>{waiting ? '—' : `${percent}%`}</b></div>
        {shown && <progress className={settings.usageColors ? 'graded' : ''} style={settings.usageColors ? usageHueStyle(percent) : undefined} value={percent} max={100} aria-label={compacting ? 'Auto Compact 창 사용률' : '컨텍스트 사용률'} />}
      </div>
      {compacting && <p className="usage-note auto-compact-detail">
        {compact(gauge.basis)} 창 기준 · 최대 {compact(gauge.max)}{gauge.autoEstimated ? ' · auto 추정' : ''} · 가득 차면 자동 요약
      </p>}
      <header className="chat-usage-title"><strong>사용 한도</strong>{usage?.plan && <span className="plan">{usage.plan}</span>}
        <button type="button" className="icon-btn" title="새로고침" aria-label="사용 한도 새로고침" aria-busy={loading} onClick={() => void load(true)}><Icon name="refresh" size={13} /></button></header>
      {usage ? <UsageRows windows={windows} colors={settings.usageColors} /> : <p className="usage-note">{loading ? '불러오는 중…' : '표시할 한도 정보가 없습니다.'}</p>}
      {usage?.error && <p className="usage-note warn">{usage.error}</p>}
    </div>
  </>;
}
