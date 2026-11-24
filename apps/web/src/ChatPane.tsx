import { createPortal } from 'react-dom';
import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { basename, type Leaf } from './api';
import { DiffView, usageHue, type DiffLayoutChoice, type McpTrust, type Settings } from './Editor';
import { addTrust } from './mcp-trust';
import { chatDarkVars, themeById } from './themes';
import { placeAbove, UsageRows, usageHueStyle, useUsage } from './Usage';
import { Icon, type IconName, IconButton, SettingGlyph, SplitButton } from './Icon';
import { QuestionCard, QuestionList, usePlayedEntrance } from './QuestionCard';
import { ChatStatusLine } from './ChatStatus';
import { tokenWeight, useUsageShare } from './use-usage-share';
import { ChatStatsModal } from './ChatStats';
import { McpCard } from './McpCard';
import { LimitCard } from './LimitCard';
import { BtwCard, UsageCard } from './ChatCards';
import { CacheTimer } from './CacheTimer';
import { CliUpdateNotice } from './ClaudeUpdateNotice';
import { cacheSendWarning, cacheSendWarningText } from './claude-cache-warning';
import { authSendWarning, authSendWarningText, authWords } from './claude-auth-warning';
import { Hint } from './Hint';
import { hintCandidates } from './tips';
import { useTipNotice } from './use-notice';
import { CodeBlock, inline, LiveMarkdown, Markdown } from './Markdown';
import { ChatUiContext } from './UiFrame';
import { beginUiSend, releaseUiSends, syncUiSends, UI_SEND_GRACE_MS } from './ui-sent';
import { Collapse, useHeightMorph } from './Collapse';
import { ShellCard } from './ShellCard';
import { isShellDraft, parseShellInput, shellBang, shownDraft } from './chat-shell';
import { FileIcon } from './FileIcon';
import { modeIcons as MODE_ICONS, type BlockedAction, agentsOf, keepAgents, isAgentTool, planSections, type AgentStatus, type SubAgent, autoDenial, chatKey, processGroups, toolRuns, type ProcessGroup, type ToolRun, ro, withSettingChange, pickGreeting, comboOf, showCombo, compact, contextEnds, contextGauge, contextPercent, contextReported, contextWindow, cursorSettingName, effortLabel, effortLevel, effortStyle, efforts, emptyView, enqueueSendNow, fromReplay, cursorModelGroups, displayModel, isChatSlashCommand, isCursorEffort, isCursorMax, isCursorSwitch, lastIndexWhere, maxOffValue, maxOnValue, maxSelected, modelProvider, modelAppearance, modelQuickDefaults, modelQuickRows, modelRows, modelValue, parseChatSlashCommand, permissionLabel, permissionModeColor, reduce, shortModel, dollars, duration, briefDuration,toolLabel, toolSummary, toolInputFields, awaitingTools, webSearchResult, lineChanges, relativePath, mcpTool, artifactsOf, turnAllowsMessageActions, turnDoneParts, turnTokenRows, type TurnDone, type Tokens, type Approval, type AssistantItem, type Block, type CatalogModel, type ChatState, type ChatView, type Item, type SettingsChange, type Tone, type UsageSnap, planFile, planVerdict, approvalAgents } from './chat-model';
import { dropOptimistic, mergeOptimistic, optimisticKeys, optimisticPatch, optimisticSettled, withOptimistic, type Optimistic } from './chat-optimistic';
import { copyText, toastAttached } from './toast';
import { prepareChatImage } from './image-fit';
import { UserMessageBubble } from './user-message-bubble';
import { Dropdown, Modal, ModelLabel } from './views';
import { useHiddenAgents } from './installed-agents';
import { clearChatDevDraft, loadChatDevDraft, saveChatDevDraft } from './chat-dev-draft';
import type { QuickItem } from './QuickInput';
import { busAgentName, parseBusMessages } from './bus-message';
import { pendingAsyncQuestions, compactLabel, idleCompactNote, type IdleCompactInfo } from './chat-model';

// What the workspace gives a chat pane. `subscribe` delivers this chat's websocket messages (`chat/event`, `chat/state`) and
// `reconnect` after the socket came back, which makes the pane ask the server for what it missed.
export type ChatCtx = {
  call<T = any>(action: string, input?: object): Promise<T>;
  subscribe(id: string, handler: (message: any) => void): () => void;
  settings: Settings; root: string; projectId: string;
  onState(id: string, state: ChatState): void; onTitle(id: string, title: string): void; onClose(id: string): void; onOpenSettings(agent?: 'claude' | 'codex' | 'cursor'): void;
  pick(title: string, items: QuickItem[]): Promise<string | null>; fail(cause: unknown): void;
  // Branch: opens a copy of chat `id` up to one assistant message as a new tab.
  branchChat(id: string, uuid: string, cwd?: string): Promise<void>;
  // Continue this conversation in a terminal (`claude --resume`); the server refuses unless the chat is idle.
  toTerminal(id: string, fresh: boolean): void;
  resumeChat(id: string, agent: 'claude' | 'codex' | 'cursor', from?: string): Promise<void>;
  // Continue a conversation made with the plain `claude` CLI as a new chat tab.
  importCliChat(sessionId: string, from?: string): Promise<void>;
  // Start screen only: replace this pane with an empty chat of another provider (forget = drop the stored empty chat).
  switchAgent(id: string, agent: 'claude' | 'codex' | 'cursor', forget: boolean): Promise<boolean>;
  onSettingsChange(settings: Settings): void;
};
type Props = { leaf: Leaf; focused: boolean; zoomed: boolean; visible: boolean; ctx: ChatCtx; onFocus(id: string): void; onZoom(id: string): void; onSplit(id: string, direction: 'row' | 'column'): void };
type Attachment = { mime: string; data: string; url: string; reduced?: boolean };

/** The composer's picture thumbnails: open one large, or remove it. "줄임" marks a picture that was over 5MB and was shrunk before sending. */
export function AttachmentStrip({ images, onOpen, onRemove }: { images: Pick<Attachment, 'url' | 'reduced'>[]; onOpen(url: string): void; onRemove(index: number): void }) {
  return <div className="chat-attachments">{images.map((image, index) => <span key={index}><button type="button" className="chat-attachment-open" title={image.reduced ? '5MB를 넘겨 조금 줄였습니다. 크게 보기' : '크게 보기'} aria-label={image.reduced ? `첨부 이미지 ${index + 1} (5MB 아래로 줄임) 크게 보기` : `첨부 이미지 ${index + 1} 크게 보기`} onClick={() => onOpen(image.url)}><img src={image.url} alt={`첨부 이미지 ${index + 1}`} />{image.reduced && <small className="chat-reduced" aria-hidden="true">줄임</small>}</button><button type="button" className="chat-attachment-remove" aria-label="첨부 제거" onClick={() => onRemove(index)}><Icon name="x" size={11} /></button></span>)}</div>;
}
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
  const [saved, setSaved] = useState<SavedChat[] | null>(null), [cli, setCli] = useState<CliChat[] | null>(null), [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { search.current?.focus(); }, []);
  useEffect(() => {
    let live = true;
    setSaved(null); setCli(null); setFailed(null);
    void call<SavedChat[]>('chat/sessions', { agent, exclude }).then(value => { if (live) setSaved(value); }, error => { if (live) { setSaved([]); setFailed(String(error?.message ?? error)); } });
    void (agent === 'claude' ? call<CliChat[]>('chat/cli-sessions', {}) : Promise.resolve<CliChat[]>([])).then(value => { if (live) setCli(value); }, error => { if (live) { setCli([]); setFailed(String(error?.message ?? error)); } });
    return () => { live = false; };
  }, [call, agent, exclude]);
  const chats = saved ?? [], known = new Set(chats.flatMap(chat => chat.sessionId ? [chat.sessionId] : [])), loading = saved === null || cli === null;
  const entries: ResumeEntry[] = [
    ...chats.map(chat => ({ key: `chat:${chat.id}`, title: chat.title, updatedAt: chat.updatedAt, detail: chat.model ? shortModel(chat.model) : undefined, code: (chat.sessionId ?? chat.id).slice(0, 8), choice: { kind: 'chat', id: chat.id } as ResumeChoice })),
    ...(cli ?? []).filter(item => item.chatId !== exclude && !known.has(item.sessionId) && !(item.chatId && chats.some(chat => chat.id === item.chatId)))
      .map(item => ({ key: `cli:${item.sessionId}`, title: item.title, updatedAt: item.updatedAt, detail: sizeOf(item.size), code: item.sessionId.slice(0, 8), running: item.running,
        choice: (item.chatId ? { kind: 'chat', id: item.chatId } : { kind: 'cli', sessionId: item.sessionId }) as ResumeChoice }))
  ].sort((a, b) => b.updatedAt - a.updatedAt);
  const needle = query.trim().toLowerCase(), rows = entries?.filter(item => !needle || item.title.toLowerCase().includes(needle));
  return <Modal className="models-modal resume-modal" labelledBy="resume-title" onClose={onClose}>
    <header><h2 id="resume-title">이전 대화 불러오기</h2><button type="button" className="models-close" aria-label="닫기" onClick={onClose}><Icon name="x" size={16} /></button></header>
    <div className="models-controls">
      <label className="models-search"><Icon name="search" size={15} /><input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="대화 제목 검색" aria-label="대화 제목 검색" /></label>
    </div>
    <div className="models-list resume-list" role="listbox" aria-label="이전 대화">
      {rows?.map(item => <button type="button" role="option" aria-selected={false} key={item.key} className="resume-row" aria-disabled={item.running || undefined} data-blocked={item.running || undefined} onClick={() => { if (!item.running) onPick(item.choice); }}>
        <span className="resume-name" data-tip-overflow="">{item.title}</span>
        <span className="resume-info"><span>{when(item.updatedAt)}</span>{item.detail && <span>{item.detail}</span>}{item.running && <span className="resume-badge">터미널에서 실행 중</span>}<span className="resume-code">{item.code}</span></span>
      </button>)}
      {loading && <p className="models-empty" role="status">대화를 불러오는 중…</p>}
      {!loading && !rows?.length && <p className="models-empty">{failed ? `목록을 불러오지 못했습니다: ${failed}` : query ? '검색 결과가 없습니다.' : '이 프로젝트에서 불러올 수 있는 이전 대화가 없습니다.'}</p>}
    </div>
    <footer><span>{rows ? `${rows.length}개 대화` : ''}</span><span>선택하면 새 탭에서 이어집니다.</span></footer>
  </Modal>;
}

// "더 많은 모델": every model the CLI lists (read fresh on open), newest version first, the current one checked.
function ModelsModal({ current, call, agent, fallback, aliases, settings, onSettingsChange, onPick, onClose, id }: { current: string; agent: 'claude' | 'codex' | 'cursor'; fallback: CatalogModel[]; aliases: Record<string, string>; settings: Settings; onSettingsChange: ChatCtx['onSettingsChange']; call: ChatCtx['call']; onPick(value: string): void; onClose(): void; id?: string }) {
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [party, setParty] = useState(modelProvider(current)?.party ?? 'First Party');
  const panelId = useId(), list = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  useEffect(() => { search.current?.focus(); }, []);
  useEffect(() => { void call('chat/model-catalog', { agent, ...(id ? { id } : {}) }).then((result: any) => setCatalog(result?.catalog ?? []), () => setCatalog([])); }, [call, agent, id]);
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
            <span className="models-check" aria-hidden="true">{current === row.value && <Icon name="check" size={14} />}</span>
            <span className="models-name" style={{ color: modelAppearance(`${row.family} ${row.id} ${row.label}`, agent).color }}><ModelLabel text={row.label} /></span>
            {agent !== 'cursor' && <span className="models-id">{row.id}{row.oneM ? '[1m]' : ''}</span>}
            <label className="models-pin" title={defaultQuick.has(row.value) ? '기본으로 고정된 모델' : '빠른 메뉴에 표시'} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
              <input type="checkbox" role="switch" aria-label={`${row.label} 빠른 메뉴에 표시`} checked={inQuick} disabled={defaultQuick.has(row.value)} onChange={event => togglePin(row.value, event.target.checked)} />
            </label>
          </button>;
        })}
      </div>)}
      {!count && <p className="models-empty">{query ? '검색 결과가 없습니다.' : catalog === null ? '모델을 불러오는 중…' : '사용할 수 있는 모델이 없습니다.'}</p>}
    </div>
    <footer><span>{count}개 모델</span><span>{catalog === null ? '목록 갱신 중…' : catalog.length ? '선택하면 이 채팅에 적용됩니다.' : '전체 모델 목록을 받지 못해 기본 모델만 표시합니다.'}</span></footer>
  </Modal>;
}
// Handled here instead of being sent: they act on ADE's tab or on the child process. Everything else, custom commands and skills
// included, goes to the provider as typed. /resume opens ADE's saved conversations for this project and provider.
const mergeCommand = (map: Map<string, CommandInfo>, item: CommandInfo) => {
  const prev = map.get(item.name);
  if (!prev) { map.set(item.name, item); return; }
  map.set(item.name, { name: item.name, description: item.description || prev.description, hint: item.hint || prev.hint });
};

const MENU_HIDDEN = new Set(['claude-api']);
const LOCAL: CommandInfo[] = [
  { name: 'resume', description: '이 프로젝트의 이전 Chat 대화를 불러옵니다' },
  { name: 'retry', description: '에이전트 연결이 끊겼을 때 마지막 요청을 같은 세션으로 다시 보냅니다' },
  { name: 'clear', description: '새 대화를 시작합니다 (처음 화면으로 돌아갑니다)' },
  { name: 'model', description: '모델을 바꿉니다', hint: '[모델]' },
  { name: 'effort', description: 'Effort(추론 노력 수준)를 바꿉니다', hint: '[low|medium|high|max]' },
  { name: 'permissions', description: '권한 모드를 바꿉니다', hint: '[default|acceptEdits|plan|auto]' },
  { name: 'autocompact', description: 'Auto Compact 창 크기를 바꿉니다 (응답 중에도 바로 적용)', hint: '[auto|토큰 수]' }, { name: 'idlecompact', description: '캐시가 식기 전에 자동으로 Compact할지 이 채팅만 정합니다 (1시간 캐시)', hint: '[on|off|auto]' }, { name: 'usage', description: '컨텍스트·비용·플랜 사용 한도를 카드로 바로 보여 줍니다 (응답 중에도 가능)' }, { name: 'btw', description: '대화에 남기지 않는 곁다리 질문을 합니다 (응답 중에도 가능)', hint: '<질문>' },
  { name: 'rename', description: '이 채팅의 이름을 바꿉니다', hint: '<이름>' }, { name: 'mcp', description: 'MCP 서버를 보고 다시 연결하거나 켜고 끕니다' }, { name: 'limit', description: '이 채팅의 비용·사용량 제한을 정합니다 (도달하면 중지)' }, { name: 'tasks', description: '이 채팅의 서브에이전트 작업을 보여 줍니다' },
  { name: 'cost', description: '이 채팅의 비용·토큰을 보여 줍니다' }, { name: 'stats', description: '이 세션의 상세 통계(토큰·비용·도구·컨텍스트 추이)를 봅니다' }, { name: 'status', description: '세션 상태를 보여 줍니다' }, { name: 'help', description: '사용할 수 있는 명령을 보여 줍니다' },
  { name: 'config', description: 'ADE 설정을 엽니다' }, { name: 'exit', description: '이 채팅을 닫습니다' }
];
// Shell tools show their command as code (coloured in the shell's language), with the model's one-line description above it on approval cards.
const SHELLS: Record<string, string> = { Bash: 'bash', PowerShell: 'powershell', Monitor: 'shell' };
const TOOL_ICONS: Record<string, string> = { Monitor: 'monitor_heart', CronCreate: 'schedule', CronList: 'schedule', CronDelete: 'schedule', ListAgents: 'groups', NotebookEdit: 'edit_note', TaskStop: 'stop_circle', SendMessage: 'send', Skill: 'bolt', EnterPlanMode: 'assignment', ExitPlanMode: 'assignment', ToolSearch: 'manage_search', EnterWorktree: 'account_tree', ExitWorktree: 'account_tree', AskUserQuestion: 'help', Bash: 'terminal', PowerShell: 'terminal', Read: 'description', Write: 'edit_document', Edit: 'edit', MultiEdit: 'edit', Glob: 'search', Grep: 'search', WebFetch: 'language', WebSearch: 'travel_explore', webSearch: 'travel_explore', Task: 'account_tree', Agent: 'account_tree', TodoWrite: 'checklist', SubagentHandback: 'flag' };
const chatWidths = { narrow: '680px', default: '780px', wide: '1000px', full: '100%' };
// An MCP tool answers with JSON text on one line: shown indented. Anything else is left as it came.
const prettyResult = (value: string) => { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : value; } catch { return value; } };
const clip = (value: string, max = 6000) => value.length > max ? `${value.slice(0, max)}\n… (${value.length - max}자 생략)` : value;

const SetDiffLayoutContext = createContext<(layout: DiffLayoutChoice) => void>(() => {});
function ChatDiff({ from, to, path, settings, named = false }: { from: string; to: string; path: string; settings: Settings; named?: boolean }) {
  const setLayout = useContext(SetDiffLayoutContext), cwd = useContext(CwdContext);
  const { added, removed } = useMemo(() => lineChanges(from, to), [from, to]);
  return <DiffView original={from} modified={to} path={path} settings={settings} onLayoutChange={setLayout} compact minHeight={0}
    header={<span className="chat-diff-title">{named && <span className="chat-diff-path" title={path}>{relativePath(path, cwd)}</span>}
      <span className="chat-diff-count"><span className="add">+{added}</span><span className="del">−{removed}</span></span></span>} />;
}
// A tool's input as labelled fields (relative paths, readable values); the raw JSON is folded under them for copying or checking.
function ToolInput({ input, cwd }: { input: Record<string, unknown>; cwd: string }) {
  const fields = toolInputFields(input, cwd);
  const raw = <CodeBlock code={clip(JSON.stringify(input, null, 2))} lang="json" />;
  if (!fields.length) return Object.keys(input).length ? raw : null;
  return <div className="chat-tool-input">
    <dl>{fields.map(field => <div key={field.key} data-long={field.long || undefined}><dt>{field.label}</dt><dd className={field.mono ? 'mono' : undefined}>{field.long ? clip(field.value, 1200) : field.value}</dd></div>)}</dl>
    <details className="chat-tool-raw"><summary>입력 원본</summary>{raw}</details>
  </div>;
}
// A tool's output: how many lines it has and a copy button next to its label; a long one starts in a 280px box and "전체 보기" grows it
// (smoothly) to its whole length, "접기" brings it back. Copy takes the full text, even past the 6,000 characters shown.
// prose: text the model wrote (a web search's notes), shown as Markdown in the normal font instead of monospaced output.
function ToolResult({ label, text, isError, prose = false }: { label: string; text: string; isError: boolean; prose?: boolean }) {
  const [full, setFull] = useState(false), [tall, setTall] = useState(false), [pre, capture] = useHeightMorph<HTMLDivElement & HTMLPreElement>();
  const body = text.replace(/\n+$/, ''), lines = body ? body.split('\n').length : 0;
  useLayoutEffect(() => { const el = pre.current; if (el && !full) setTall(el.scrollHeight > el.clientHeight + 2); }, [text, full]);
  const toggle = () => { capture(); setFull(value => !value); };
  return <div className={`chat-tool-result ${isError ? 'error' : ''}`}>
    <div className="chat-tool-result-head"><small>{label}{lines > 1 && ` · ${lines.toLocaleString()}줄`}</small>
      {body && <button type="button" className="chat-tool-copy" aria-label="결과 복사" onClick={() => copyText(body)}><Icon name="copy" size={13} />복사</button>}</div>
    {prose ? <div ref={pre} className={`chat-tool-prose${full ? ' full' : ''}`}><Markdown text={clip(body)} /></div>
      : <pre ref={pre} className={full ? 'full' : undefined}>{clip(body) || '(출력 없음)'}</pre>}
    {(tall || full) && <button type="button" className="chat-command-more" onClick={toggle}>{full ? '접기' : '전체 보기'}</button>}
  </div>;
}
// ToolSearch answers "[tool_reference]" once per tool it loaded; say which ones (from the "select:" list) instead.
const loaded = (block: Extract<Block, { type: 'tool_use' }>, content: string) => {
  if (block.name !== 'ToolSearch' || !/^(\s*\[tool_reference\]\s*)+$/.test(content)) return null;
  const query = String(block.input?.query ?? ''), count = content.split('[tool_reference]').length - 1;
  return query.startsWith('select:') ? query.slice(7).split(',').map(name => name.trim()).filter(Boolean).join(', ') : `도구 ${count}개`;
};
// A web search's links as a list (title, then the site), each opening through the app's "open external link?" dialog; the model's notes
// on the results follow, and the raw text stays folded at the end.
const WEB_LINKS_SHOWN = 6;
function WebResults({ raw }: { raw: string }) {
  const parsed = useMemo(() => webSearchResult(raw), [raw]), [all, setAll] = useState(false), [list, capture] = useHeightMorph<HTMLUListElement>();
  if (!parsed) return null;
  const extra = parsed.links.length - WEB_LINKS_SHOWN, shown = all || extra <= 0 ? parsed.links : parsed.links.slice(0, WEB_LINKS_SHOWN);
  return <div className="chat-tool-result chat-web">
    <div className="chat-tool-result-head"><small>링크 {parsed.links.length}개</small></div>
    <ul ref={list} className="chat-web-links">{shown.map(item => <li key={item.url}>
      <a href={item.url} rel="noreferrer noopener" title={item.url} onClick={event => { event.preventDefault(); window.dispatchEvent(new CustomEvent('ade:link', { detail: item.url })); }}>
        <span className="chat-web-title">{item.title}</span><span className="chat-web-host">{item.host}</span></a></li>)}</ul>
    {extra > 0 && <button type="button" className="chat-command-more" onClick={() => { capture(); setAll(value => !value); }}>{all ? '접기' : `링크 ${extra}개 더 보기`}</button>}
    {parsed.notes && <ToolResult label="요약" isError={false} text={parsed.notes} prose />}
    <details className="chat-tool-raw"><summary>결과 원본</summary><pre>{clip(raw)}</pre></details>
  </div>;
}
// ExitPlanMode once decided: the plan formatted as the review card showed it, where it was saved, and the decision in one line instead of
// the CLI's "User has approved your plan…" that repeats the whole plan. A revision request shows the user's words.
function PlanRecord({ input, result }: { input: Record<string, unknown>; result?: { content: string; isError: boolean } }) {
  const path = typeof input.planFilePath === 'string' ? input.planFilePath : '', verdict = result && planVerdict(result.content, result.isError);
  return <>
    <ToolResult label="계획" isError={false} text={String(input.plan)} prose />
    {path && <p className="chat-tool-note">계획 파일 <code title={path}>{planFile(path)}</code></p>}
    {verdict && (verdict.approved ? <p className="chat-tool-note ok"><Icon name="check" size={13} />승인됨</p>
      : verdict.feedback ? <ToolResult label="수정 요청" isError={false} text={verdict.feedback} prose />
      : <ToolResult label="거부됨" isError text={result!.content} />)}
  </>;
}
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// NotebookEdit's cell: its source as code, headed "code 셀 · 추가" (markdown cells colour as Markdown, code cells as Python).
const notebookCell = (input: Record<string, unknown>) => typeof input.new_source !== 'string' || input.edit_mode === 'delete' ? null
  : { code: input.new_source, label: `${input.cell_type === 'markdown' ? 'markdown' : 'code'} 셀 · ${input.edit_mode === 'insert' ? '추가' : '바꾸기'}`, syntax: input.cell_type === 'markdown' ? 'markdown' : 'python' };
const ToolCard = memo(function ToolCard({ block, result, settings, running }: { block: Extract<Block, { type: 'tool_use' }>; result?: { content: string; isError: boolean }; settings: Settings; running: boolean }) {
  const [open, setOpen] = useState(settings.chatToolsOpen), input = block.input ?? {}, cwd = useContext(CwdContext);
  const edit = block.name === 'Edit' ? [{ from: String(input.old_string ?? ''), to: String(input.new_string ?? '') }] : block.name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits.map((item: any) => ({ from: String(item.old_string ?? ''), to: String(item.new_string ?? '') })) : null;
  const write = block.name === 'Write' ? String(input.content ?? '') : null;
  const patches = Array.isArray(input.changes) ? input.changes.map((item: any) => ({ path: item.path, diff: item.diff })) : Array.isArray(input.content) ? input.content.filter((item: any) => item.type === 'diff').map((item: any) => ({ path: item.path, oldText: item.oldText, newText: item.newText })) : [];
  const denial = result?.isError ? autoDenial(result.content) : null, awaiting = useContext(AwaitingContext).has(block.id), deniedCalls = useContext(DeniedContext), refused = result?.isError === true && deniedCalls[block.id] === true;
  // A file write that worked says so with its ✓ and the content/diff above; the CLI's "File created successfully at: C:\… (file state is current…)" adds nothing. Failures still show.
  const quietSuccess = FILE_TOOLS.has(block.name) || patches.length > 0, plan = block.name === 'ExitPlanMode' && typeof input.plan === 'string';
  // A Monitor or background shell answers at once ("started"); its row keeps spinning until the job itself ends, and a click on the tag opens it.
  const agents = useContext(AgentsContext), job = agents.agents.get(block.id), jobRunning = job?.job && job.status === 'running';
  const state = result && !jobRunning ? (denial ? 'blocked' : refused ? 'refused' : result.isError ? 'error' : 'done') : awaiting ? 'approval' : running || jobRunning ? 'running' : 'pending';
  return <div className={`chat-tool ${state}`} data-tool={block.name}>
    <button type="button" className="chat-tool-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="icon material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">{TOOL_ICONS[block.name] ?? (mcpTool(block.name) ? 'extension' : 'build')}</span>
      <strong>{toolLabel(block.name)}</strong><span className="chat-tool-summary">{toolSummary(block.name, input, cwd)}</span>
      {job?.job && <span className="chat-tool-job" role="link" tabIndex={-1} onClick={event => { event.stopPropagation(); agents.open(block.id); }}>{jobRunning ? '백그라운드 실행 중' : '백그라운드'}</span>}
      <span className="chat-tool-state" aria-label={{ running: '실행 중', done: '완료', error: '오류', blocked: '자동 모드가 차단함', refused: '거부됨', pending: '대기', approval: '승인 대기' }[state]}>{state === 'approval' ? <><Icon name="alert" size={12} />승인 대기</> : state === 'refused' ? <><Icon name="block" size={12} />거부됨</> : state === 'running' ? <>{jobRunning && <StopTask id={block.id} />}<i className="chat-spin" /></> : state === 'done' ? <Icon name="check" size={13} /> : state === 'blocked' ? <Icon name="block" size={13} /> : state === 'error' ? <Icon name="x" size={13} /> : null}</span>
      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
    </button>
    <Collapse open={open}><div className="chat-tool-body">
      {edit ? edit.map((item: { from: string; to: string }, index: number) => <ChatDiff key={index} from={item.from} to={item.to} path={String(input.file_path ?? 'edit')} settings={settings} />)
        : write !== null ? <CodeBlock code={clip(write)} lang={basename(String(input.file_path ?? ''))} />
        : notebookCell(input) ? <CodeBlock code={clip(notebookCell(input)!.code)} lang={notebookCell(input)!.label} syntax={notebookCell(input)!.syntax} />
        : block.name === 'AskUserQuestion' && Array.isArray(input.questions) ? <QuestionList questions={input.questions} />
        : SHELLS[block.name] ? <CodeBlock code={String(input.command ?? '')} lang={SHELLS[block.name]} />
        : plan ? <PlanRecord input={input} result={result} />
        : patches.length ? null : <ToolInput input={input} cwd={cwd} />}
      {patches.map((patch: any, index: number) => typeof patch.diff === 'string' ? <div className="chat-diff" key={index}><CodeBlock code={`${patch.path}\n${patch.diff}`} lang="diff" /></div> : <ChatDiff key={index} named from={patch.oldText ?? ''} to={patch.newText ?? ''} path={patch.path ?? 'edit'} settings={settings} />)}
      {plan ? null : refused && result ? (result.content.trim() === DENIED_DEFAULT ? null : <ToolResult label="거부하며 보낸 지시" isError={false} text={/the user said:\n([\s\S]*)$/.exec(result.content)?.[1].trim() ?? result.content} prose />)
      : denial && result ? <div className="chat-tool-result blocked"><small>자동 모드가 차단함{denial.reason && ` · ${denial.reason}`}</small><p>분류기가 이 작업을 위험하다고 판단해 실행하지 않았습니다. 허용하려면 입력창 위의 승인 카드를 쓰거나 직접 다시 요청하세요.</p><details><summary>원문</summary><pre>{clip(result.content)}</pre></details></div>
      : result && !result.isError && block.name === 'WebSearch' && webSearchResult(result.content) ? <WebResults raw={result.content} />
      : result && !result.isError && loaded(block, result.content) ? <ToolResult label="불러옴" isError={false} text={loaded(block, result.content)!} />
      : result && !(quietSuccess && !result.isError) && <ToolResult label={result.isError ? block.name === 'AskUserQuestion' ? '건너뜀' : '오류' : block.name === 'AskUserQuestion' ? '답변' : '결과'} isError={result.isError} text={mcpTool(block.name) ? prettyResult(result.content) : result.content} />}
    </div></Collapse>
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
    // At most ~60 steps a second: on a 120/144 Hz display every frame re-rendered the reply, and it revealed two or more times as fast.
    let last = 0, frame = requestAnimationFrame(function tick(now) {
      frame = requestAnimationFrame(tick);
      if (now - last < 15) return;
      last = now;
      setShown(count => {
        const target = goal.current; if (count >= target) return count;
        return Math.min(target, count + Math.max(streaming.current ? 1 : 3, Math.ceil((target - count) / (streaming.current ? 10 : 4))));
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [behind]);
  return animate ? Math.min(shown, text.length) : text.length;
}
const RevealText = memo(function RevealText({ text, live, markdown, smooth, media }: { text: string; live: boolean; markdown: boolean; smooth: boolean; media?: boolean }) {
  const shown = useReveal(text, live, smooth), [streamed] = useState(live), part = shown < text.length ? text.slice(0, shown) : text, flowing = live || shown < text.length;
  if (!markdown) return <>{part}</>;
  // A block that streamed keeps the live renderer for good, so finishing never swaps its DOM.
  return streamed ? <LiveMarkdown text={part} live={flowing} media={media} /> : <Markdown text={part} media={media} />;
});

function BlockView({ block, result, settings, running, plainThinking, enter }: { block: Block; result?: { content: string; isError: boolean }; settings: Settings; running: boolean; plainThinking?: boolean; enter?: boolean }) {
  const live = Boolean(block.partial);
  if (block.type === 'text' && block.questions?.length) return <details className="chat-thinking"><summary>질문</summary>
    <QuestionList questions={block.questions.map(({ title, options }) => ({ question: title, options: options?.map(label => ({ label })) }))} />
  </details>;
  if (block.type === 'text' || (plainThinking && block.type === 'thinking')) return <RevealText text={block.text} live={live && Boolean(enter)} markdown smooth={settings.chatSmoothStream} media={block.type === 'text'} />;
  if (block.type === 'thinking') return <details className="chat-thinking" open={settings.chatThinkingOpen === 'always' ? true : settings.chatThinkingOpen === 'never' ? false : live}><summary>생각</summary><p><RevealText text={block.text} live={live && Boolean(enter)} markdown={false} smooth={settings.chatSmoothStream} /></p></details>;
  if (block.type === 'tool_use') { const card = <ToolCard block={block} result={result} settings={settings} running={running} />; return isAgentTool(block.name) ? <AgentCard id={block.id} fallback={card} /> : card; }
  return null;
}

// ---- subagents: one card per Agent call in the thread, a tracker above the composer, and a drawer with one subagent's whole run ----
// waiting: subagents stopped at an approval prompt, shown as "승인 대기" instead of a spinner.
type AgentsValue = { agents: Map<string, SubAgent>; colors: Map<string, string>; opened: string | null; waiting: ReadonlySet<string>; open(id: string): void; stop(id: string): void };
// The chat's folder, so tool rows and approvals show paths under it as relative paths.
const CwdContext = createContext('');
// What the /usage and /btw cards in the thread need from the pane: where to read the plan limits, how to colour them, and what closing or retrying a question does.
type LocalCards = { projectId: string; colors: boolean; showSession: boolean; closeBtw(key: string): void; retryBtw(key: string): void; mcpCall(input: Record<string, unknown>): Promise<any>; limitCall(input: Record<string, unknown>): Promise<any>; stopShell(runId: string): void; skipShell(runId: string, on: boolean): void; shellNote: { lastId: string; pending: number } };
const LocalCardsContext = createContext<LocalCards>({ projectId: '', colors: true, showSession: true, closeBtw() {}, retryBtw() {}, mcpCall: async () => ({}), limitCall: async () => ({}), stopShell() {}, skipShell() {}, shellNote: { lastId: '', pending: 0 } });
// Tool calls waiting at an approval prompt (awaitingTools): their rows show "승인 대기", not a spinner.
const AwaitingContext = createContext<ReadonlySet<string>>(new Set());
// Tool calls the user refused: shown as "거부됨" (muted), not as a red error; an instruction sent with the refusal (다르게 하기) is shown as such.
const DeniedContext = createContext<Readonly<Record<string, true>>>({});
const DENIED_DEFAULT = '사용자가 거부했습니다.', NO_DENIED: Readonly<Record<string, true>> = {};
const AgentsContext = createContext<AgentsValue>({ agents: new Map(), colors: new Map(), opened: null, waiting: new Set(), open() {}, stop() {} });
const AGENT_HUES = [212, 152, 36, 282, 350, 188, 96, 320];
const agentColor = (index: number) => `hsl(${AGENT_HUES[index % AGENT_HUES.length]} 62% 62%)`;
const AGENT_STATUS: Record<AgentStatus, string> = { running: '실행 중', done: '완료', error: '오류', stopped: '중단됨' };
function useTick(on: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!on) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [on]);
  return now;
}
const agentElapsed = (agent: SubAgent, now: number) => agent.status === 'running' ? (agent.startedAt ? Math.max(0, now - agent.startedAt) : agent.durationMs)
  : agent.durationMs ?? (agent.startedAt && agent.endedAt ? agent.endedAt - agent.startedAt : undefined);
const agentMeta = (agent: SubAgent, now: number) => { const ms = agentElapsed(agent, now); return [[agent.model && shortModel(agent.model), agent.effort && effortLabel(agent.effort)].filter(Boolean).join(' '), agent.toolCount ? `도구 ${agent.toolCount}개` : '', ms != null ? briefDuration(ms) : '', agent.tokens ? `${compact(agent.tokens)} 토큰` : ''].filter(Boolean).join(' · '); };
// ■ beside a running background job's spinner: ends just that task. A span, since it sits inside the row's own button.
function StopTask({ id }: { id: string }) {
  const { stop } = useContext(AgentsContext);
  return <span className="stop-task" role="button" tabIndex={0} title="이 작업 중단" aria-label="이 작업 중단" onClick={event => { event.stopPropagation(); stop(id); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); stop(id); } }} />;
}
function AgentState({ status, waiting, id }: { status: AgentStatus; waiting?: boolean; id?: string }) {
  const stoppable = useContext(AgentsContext).agents.get(id ?? '')?.background === true;
  if (waiting && status === 'running') return <span className="chat-agent-state" data-status="approval"><Icon name="alert" size={12} />승인 대기</span>;
  return <span className="chat-agent-state" data-status={status} role={id && stoppable && status === 'running' ? undefined : 'img'} aria-label={AGENT_STATUS[status]} title={AGENT_STATUS[status]}>{status === 'running' ? <>{id && stoppable && <StopTask id={id} />}<i className="chat-spin" /></> : <Icon name={status === 'done' ? 'check' : status === 'error' ? 'x' : 'stop'} size={13} />}</span>;
}
const dotStyle = (color?: string) => (color ? { '--agent-color': color } : undefined) as CSSProperties | undefined;

function AgentCard({ id, fallback }: { id: string; fallback: ReactNode }) {
  const { agents, colors, opened, waiting, open } = useContext(AgentsContext), agent = agents.get(id), now = useTick(agent?.status === 'running');
  if (!agent) return <>{fallback}</>;
  return <button type="button" className="chat-agent-card" data-status={agent.status} aria-pressed={opened === id} style={dotStyle(colors.get(id))} onClick={() => open(id)}>
    <span className="chat-agent-line"><i className="chat-agent-dot" /><span className="chat-agent-type">{agent.type}</span><strong>{agent.description || '서브에이전트'}</strong>
      {agent.background && <span className="chat-agent-tag">백그라운드</span>}{!agent.now && <small className="chat-agent-meta">{agentMeta(agent, now)}</small>}<AgentState id={id} status={agent.status} waiting={waiting.has(id)} /><Icon name="chevronRight" size={14} /></span>
    {agent.now && <span className="chat-agent-sub"><span className="chat-agent-now">{agent.now}</span><small>{agentMeta(agent, now)}</small></span>}
  </button>;
}

// Where a background subagent/job ended in the thread: the messages around it (its report, other agents' updates) are told apart by this line.
function AgentEnd({ id, enter }: { id: string; enter?: boolean }) {
  const { agents, colors, open } = useContext(AgentsContext), agent = agents.get(id);
  if (!agent) return null;
  const meta = agentMeta(agent, 0);
  return <div className="chat-divider agent-end" role="separator" data-status={agent.status} data-enter={enter || undefined} style={dotStyle(colors.get(id))}>
    <button type="button" onClick={() => open(id)}><i className="chat-agent-dot" /><span className="chat-agent-type">{agent.type}</span><strong>{agent.description || '서브에이전트'}</strong>
      <span>{AGENT_STATUS[agent.status]}</span>{meta && <small>{meta}</small>}<AgentState status={agent.status} /></button>
  </div>;
}

// Above the composer while subagents run (and, once they are all over, until the next message): how many, and what each is doing now.
// A finished entry nobody has opened for this long fades out of the tracker.
const TRACKER_IDLE_MS = 60_000, TRACKER_FADE_MS = 500;
const agentKindIcon = (agent: SubAgent): IconName => agent.type === 'Monitor' ? 'chart' : agent.job ? 'terminal' : 'bot';
function AgentTracker({ list: all, colors, opened, waiting, onOpen, onHide }: { list: SubAgent[]; colors: Map<string, string>; opened: string | null; waiting: ReadonlySet<string>; onOpen(id: string): void; onHide(): void }) {
  const [expanded, setExpanded] = useState(true), [fading, setFading] = useState<ReadonlySet<string>>(new Set()), [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const idleSince = useRef(new Map<string, number>()), list = all.filter(agent => !gone.has(agent.id));
  const count = (status: AgentStatus) => list.filter(agent => agent.status === status).length, running = count('running');
  const asking = list.filter(agent => agent.status === 'running' && waiting.has(agent.id)).length;
  const now = useTick(list.length > 0);
  useEffect(() => {
    const at = Date.now();
    for (const agent of all) {
      if (agent.status === 'running' || agent.id === opened) { idleSince.current.delete(agent.id); continue; }
      const since = idleSince.current.get(agent.id) ?? (idleSince.current.set(agent.id, at), at);
      if (at - since < TRACKER_IDLE_MS || fading.has(agent.id) || gone.has(agent.id)) continue;
      if (calm()) { setGone(prev => new Set(prev).add(agent.id)); continue; }
      setFading(prev => new Set(prev).add(agent.id));
      setTimeout(() => setGone(prev => new Set(prev).add(agent.id)), TRACKER_FADE_MS);
    }
  }, [now, all, opened, fading, gone]);
  if (!list.length) return null;
  const done = count('done'), tally = running || done !== list.length
    ? [asking && `승인 대기 ${asking}`, running - asking && `실행 중 ${running - asking}`, done && `완료 ${done}`, count('error') && `오류 ${count('error')}`, count('stopped') && `중단 ${count('stopped')}`].filter(Boolean).join(' · ')
    : '모두 완료';
  // One row: [state] 서브에이전트 N개 · tally ... [dots when folded] [fold] [close]. Fold and close are separate, same-size buttons on the right edge.
  return <div className="chat-agents" data-running={running > 0 || undefined} data-fading={list.every(agent => fading.has(agent.id)) || undefined} role="region" aria-label="서브에이전트">
    <div className="chat-agents-head">
      <button type="button" className="chat-agents-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        {running && asking === running ? <span className="chat-agents-done" data-outcome="approval"><Icon name="alert" size={13} /></span> : running ? <i className="chat-spin" /> : <span className="chat-agents-done" data-outcome={count('error') ? 'error' : done !== list.length ? 'stopped' : undefined}><Icon name={count('error') ? 'x' : done !== list.length ? 'stop' : 'check'} size={13} /></span>}
        <strong>{list.every(agent => agent.job) ? '백그라운드 작업' : list.some(agent => agent.job) ? '백그라운드' : '서브에이전트'} {list.length}개</strong><span className="chat-agents-tally">{tally}</span>
        {!expanded && <span className="chat-agents-dots" aria-hidden="true">{list.map(agent => <i key={agent.id} className="chat-agent-dot" data-status={agent.status} style={dotStyle(colors.get(agent.id))} />)}</span>}
        <span className="chat-agents-fold"><Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} /></span>
      </button>
      {!running && <IconButton icon="x" label="서브에이전트 목록 닫기" size={13} onClick={onHide} />}
    </div>
    <Collapse open={expanded}><ul>{list.map(agent => <li key={agent.id} data-fading={fading.has(agent.id) || undefined}><button type="button" data-status={agent.status} aria-pressed={opened === agent.id} style={dotStyle(colors.get(agent.id))} onClick={() => onOpen(agent.id)}>
      <i className="chat-agent-dot" /><span className="chat-agent-kind" title={agent.type} role="img" aria-label={agent.type}><Icon name={agentKindIcon(agent)} size={14} /></span><strong>{agent.description || '서브에이전트'}</strong>
      <span className="chat-agent-now">{agent.now}</span><small>{agentMeta(agent, now)}</small><AgentState id={agent.id} status={agent.status} waiting={waiting.has(agent.id)} /></button></li>)}</ul></Collapse>
  </div>;
}

// One subagent's whole run: its prompt, every step it took (the ordinary cards), and its report. It follows the end while it runs, until you scroll up.
function AgentDrawer({ agent, closing, list, colors, results, settings, docked, onPick, onStop, onClose }: { agent: SubAgent; closing?: boolean; list: SubAgent[]; colors: Map<string, string>; results: ChatView['results']; settings: Settings; docked: boolean; onPick(id: string): void; onStop(id: string): void; onClose(): void }) {
  const now = useTick(agent.status === 'running'), body = useRef<HTMLDivElement>(null), follow = useRef(true), at = list.findIndex(item => item.id === agent.id);
  // The steps are drawn by the same `Turn` as the thread (process boxes, tool bundles, plain answers); only what the "결과" section or the card already says is dropped.
  const { items, count } = useMemo(() => {
    const dropHandback = Boolean(agent.report);
    const visible = (block: Block) => shownBlock(block) && !(dropHandback && block.type === 'tool_use' && block.name === 'SubagentHandback');
    const out: Item[] = [];
    for (const item of agent.items) {
      if (item.kind !== 'assistant') continue;
      const blocks = item.blocks.filter(visible);
      if (blocks.length) out.push(blocks.length === item.blocks.length ? item : { ...item, blocks });
    }
    // The subagent's last words usually are its report; the "결과" section below already shows them, so the same text is not repeated above it.
    const last = out.at(-1);
    if (agent.report && last?.kind === 'assistant') {
      const lastBlock = last.blocks.at(-1);
      if (lastBlock?.type === 'text' && lastBlock.text.trim() === agent.report.trim()) {
        const blocks = last.blocks.slice(0, -1);
        if (blocks.length) out[out.length - 1] = { ...last, blocks }; else out.pop();
      }
    }
    return { items: out, count: out.reduce((sum, item) => sum + (item.kind === 'assistant' ? item.blocks.length : 0), 0) };
  }, [agent.items, agent.report]);
  const running = agent.status === 'running';
  useEffect(() => { follow.current = true; body.current?.focus({ preventScroll: true }); }, [agent.id]);
  useLayoutEffect(() => { const el = body.current; if (el && follow.current) el.scrollTop = el.scrollHeight; }, [agent.id, count, agent.status, agent.report]);
  const meta = agentMeta(agent, now);
  return <aside className="chat-agent-drawer" data-docked={docked || undefined} data-closing={closing || undefined} inert={closing || undefined} style={dotStyle(colors.get(agent.id))} aria-label={`서브에이전트 ${agent.description}`} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <header>
      <i className="chat-agent-dot" data-status={agent.status} />
      <div><strong>{agent.description || '서브에이전트'}</strong><small>{agent.type}{agent.background ? ' · 백그라운드' : ''} · {AGENT_STATUS[agent.status]}{meta && ` · ${meta}`}</small></div>
      {agent.background && agent.status === 'running' && <IconButton icon="stop" label="이 작업 중단" className="stop-task" size={14} onClick={() => onStop(agent.id)} />}
      <IconButton icon="chevronLeft" label="이전 에이전트" size={14} disabled={at <= 0} onClick={() => onPick(list[at - 1].id)} />
      <small className="chat-agent-pos">{at + 1}/{list.length}</small>
      <IconButton icon="chevronRight" label="다음 에이전트" size={14} disabled={at < 0 || at >= list.length - 1} onClick={() => onPick(list[at + 1].id)} />
      <IconButton icon="x" label="닫기 (Esc)" size={14} onClick={onClose} />
    </header>
    <div className="chat-agent-drawer-body" ref={body} tabIndex={-1} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16; }}>
      {agent.prompt && <details className="chat-agent-prompt" open={agent.job}><summary>{agent.job ? '명령' : '프롬프트'}</summary><div><Markdown text={agent.prompt} /></div></details>}
      {items.length > 0 && <Turn key={agent.id} items={items} agentIds={NO_AGENTS} settled={!running} working={running} results={results} settings={settings} plainThinking bare />}
      {!count && !agent.report && <p className="chat-agent-empty">{running ? '아직 받은 단계가 없습니다…' : '기록된 단계가 없습니다.'}</p>}
      {agent.status === 'running' && agent.now && <p className="chat-agent-live"><i className="chat-spin" />{agent.now}</p>}
      {agent.report && <section className="chat-agent-report"><h4>결과</h4><Markdown text={agent.report} /></section>}
    </div>
  </aside>;
}

// Several tools in a row as one low box: the newest ones stay in view (it follows the end while the turn runs, until you scroll up), the header names
// what is running now, and a click opens the whole list. The cards inside are the ordinary ones, so each can still be opened for its input and result.
type BundlePart = { key: string; item: AssistantItem; block: Block };
// flat: a finished turn's short run inside its "과정" box. Opening the process already shows its rows, so the run is just its list, no own fold.
function ToolBundle({ parts, results, settings, running, plainThinking, flat }: { parts: BundlePart[]; results: ChatView['results']; settings: Settings; running: boolean; plainThinking?: boolean; flat?: boolean }) {
  const [expanded, setExpanded] = useState(false), [edge, setEdge] = useState({ top: false, bottom: false, above: 0, below: 0, over: false });
  const list = useRef<HTMLDivElement>(null), follow = useRef(true), cwd = useContext(CwdContext), [root, capture] = useHeightMorph<HTMLDivElement>();
  const anchor = useRef<{ head: HTMLElement; top: number } | null>(null);
  const tools = parts.flatMap(part => part.block.type === 'tool_use' ? [part.block] : []);
  const finished = tools.filter(tool => results[tool.id]).length, errored = tools.filter(tool => results[tool.id]?.isError).length;
  // An auto-mode denial is an error result too, but the card shows it as "blocked" (warning colour), so the summary counts it apart from real failures.
  const blocked = tools.filter(tool => { const result = results[tool.id]; return result?.isError && autoDenial(result.content); }).length, failed = errored - blocked;
  const held = useContext(AwaitingContext), waiting = running ? tools.find(tool => held.has(tool.id)) : undefined;
  const active = running ? waiting ?? tools.find(tool => !results[tool.id]) : undefined;
  // Outcome of the whole bundle: all ok = check, some failed = warning, all failed = X.
  const outcome = errored === 0 ? 'ok' : errored === tools.length ? 'failed' : 'partial';
  // Once the turn is over the bundle is one line ("도구 n개 호출 완료"); a click opens the list. While it runs the list stays, so nothing jumps between two tools.
  const folded = !running && !expanded && !flat;
  // Which rows are not fully in view above / below (counted for the "위/아래 n개 더" chips), and whether the list overflows at all: a run that fits
  // has nothing more to show, so "전체 보기" is hidden for it. The rows are watched too, so a card opened inside the list re-measures.
  const measure = () => {
    const el = list.current;
    if (!el) return;
    const top = el.scrollTop, bottom = top + el.clientHeight;
    let above = 0, below = 0;
    for (const row of el.children as HTMLCollectionOf<HTMLElement>) { if (row.offsetTop < top - 2) above++; if (row.offsetTop + row.offsetHeight > bottom + 2) below++; }
    const next = { top: top > 2, bottom: el.scrollHeight - bottom > 2, above, below, over: el.scrollHeight - el.clientHeight > 2 };
    setEdge(current => (Object.keys(next) as (keyof typeof next)[]).every(key => current[key] === next[key]) ? current : next);
  };
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const saved = anchor.current; anchor.current = null;
    if (saved) {
      const scroll = el.closest<HTMLElement>('.chat-scroll, .chat-agent-drawer-body');
      if (scroll) scroll.scrollTop += saved.head.getBoundingClientRect().top - saved.top;
    }
    if (follow.current && !expanded) el.scrollTop = el.scrollHeight;
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    for (const row of el.children) watch.observe(row);
    return () => watch.disconnect();
  }, [parts.length, finished, expanded, folded]);
  // While it runs and everything fits, there is nothing to open: no toggle, no chevron, the head does nothing.
  const inert = !expanded && !folded && !edge.over && !flat;
  return <div ref={root} className={`chat-bundle${expanded || flat ? ' expanded' : ''}${folded ? ' folded' : ''}${flat ? ' flat' : ''}`} data-running={Boolean(active) || undefined} data-awaiting={Boolean(waiting) || undefined} data-outcome={active ? undefined : failed ? 'error' : blocked ? 'blocked' : undefined}>
    {!flat && <button type="button" className="chat-bundle-head" aria-expanded={expanded} data-inert={inert || undefined} onClick={() => { if (inert) return; capture(); setExpanded(value => !value); }}>
      <span className="chat-bundle-icon" data-outcome={waiting || active ? undefined : outcome}>{waiting ? <Icon name="alert" size={13} /> : active ? <i className="chat-spin" /> : <Icon name={outcome === 'ok' ? 'check' : outcome === 'partial' ? 'alert' : 'x'} size={13} />}</span>
      {waiting
        ? <><strong>승인 대기</strong><span className="chat-bundle-now">{toolLabel(waiting.name)} · {toolSummary(waiting.name, waiting.input ?? {}, cwd)}</span><span className="chat-bundle-count">{finished}/{tools.length}</span></>
        : active
        ? <><strong>{toolLabel(active.name)}</strong><span className="chat-bundle-now">{toolSummary(active.name, active.input ?? {}, cwd)}</span><span className="chat-bundle-count">{finished}/{tools.length}</span></>
        : <><strong>도구 {tools.length}개 호출 완료</strong><span className="chat-bundle-now">{[failed && `${failed}개 오류`, blocked && `${blocked}개 차단`].filter(Boolean).join(' · ')}</span></>}
      {!inert && <><span className="chat-bundle-toggle">{expanded ? '접기' : folded ? '펼치기' : '전체 보기'}</span>
      <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} /></>}
    </button>}
    <Collapse open={!folded}><div className="chat-bundle-scroll">
      <div ref={list} className="chat-bundle-list" data-edge-top={edge.top || undefined} data-edge-bottom={edge.bottom || undefined}
        onClick={event => {
          const head = (event.target as HTMLElement).closest<HTMLElement>('.chat-tool-head[aria-expanded="false"]');
          if (!head || expanded || flat) return;
          // Reading a tool leaves the compact preview; keep its heading in place as the hidden rows above reappear.
          anchor.current = { head, top: head.getBoundingClientRect().top };
          follow.current = false; setExpanded(true);
        }}
        onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12; measure(); }}>
        {parts.map(part => <div key={part.key} className={`chat-bundle-item${part.item.sub ? ' sub' : ''}`}>
          <BlockView block={part.block} result={part.block.type === 'tool_use' ? results[part.block.id] : undefined} settings={settings} running={running} plainThinking={plainThinking} enter={part.item.fresh} />
        </div>)}
      </div>
      {!flat && !expanded && edge.above > 0 && <button type="button" className="chat-bundle-more" data-side="top" onClick={() => list.current?.scrollBy({ top: -list.current.clientHeight * .75 })}><Icon name="arrowUp" size={11} />위 {edge.above}개 더</button>}
      {!flat && !expanded && edge.below > 0 && <button type="button" className="chat-bundle-more" data-side="bottom" onClick={() => list.current?.scrollBy({ top: list.current.clientHeight * .75 })}><Icon name="arrowDown" size={11} />아래 {edge.below}개 더</button>}
    </div></Collapse>
  </div>;
}

// Up to this many tools, a finished run is listed straight inside its "과정" box; a longer one folds to one "도구 n개 호출 완료" line.
const FLAT_RUN_MAX = 6;
const shownBlock = (block: Block) => block.type === 'tool_use' || ((block.type === 'text' || block.type === 'thinking') && Boolean(block.text.trim()));
const turnsOf = (items: Item[], busy: boolean) => {
  const turns: Item[][] = [];
  let current: Item[] = [];
  const isLocal = (entry?: Item) => entry?.kind === 'shell' || (entry?.kind === 'note' || entry?.kind === 'info' || entry?.kind === 'usage' || entry?.kind === 'btw' || entry?.kind === 'mcp' || entry?.kind === 'limit') && entry.local === true;
  // An ADE line typed while the answer is still going (a setting, /cost) stays inside that answer: it ends the turn only when the next thing is a new request
  // (a user message, which is also how an applied steer arrives, or a divider) or nothing follows and no turn runs.
  const insideRunning = (at: number) => { let next = at + 1; while (isLocal(items[next])) next++; const after = items[next]; return after ? after.kind !== 'user' && after.kind !== 'divider' : busy; };
  items.forEach((item, at) => {
    // What ADE itself says (a changed setting, /cost) is its own group, so the copy / branch / rewind icons stay with the answer they belong to.
    if (current.length && (item.kind === 'user' || item.kind === 'divider' || (isLocal(item) && !isLocal(current.at(-1)) && !(current.some(entry => entry.kind === 'user' || entry.kind === 'assistant') && insideRunning(at))))) { turns.push(current); current = []; }
    current.push(item);
  });
  if (current.length) turns.push(current);
  return turns;
};

const NO_AGENTS: ReadonlySet<string> = new Set();
// bare: a subagent's run inside its drawer: no copy / branch / rewind icons and no artifact links under it.
type TurnProps = { items: Item[]; agentIds: ReadonlySet<string>; settled: boolean; working: boolean; results: ChatView['results']; settings: Settings; plainThinking?: boolean; bare?: boolean; onBranch?(uuid: string): void; onRewind?(uuid: string): void; onRecover?(): void; recovering?: boolean };
type Part = { kind: 'block'; key: string; item: AssistantItem; block: Block } | { kind: 'item'; key: string; item: Item };
const toolIds = (items: Item[]) => items.flatMap(item => item.kind === 'assistant' ? item.blocks.flatMap(block => block.type === 'tool_use' ? [block.id] : []) : []);
// A turn re-renders only when one of its own items, its own tools' results or its phase changes: a delta in the last turn leaves the others alone.
const sameTurn = (a: TurnProps, b: TurnProps) => a.items.length === b.items.length && a.items.every((item, index) => item === b.items[index]) && a.agentIds === b.agentIds && a.settled === b.settled && a.working === b.working
  && a.settings === b.settings && a.plainThinking === b.plainThinking && a.onBranch === b.onBranch && a.onRewind === b.onRewind && a.onRecover === b.onRecover && a.recovering === b.recovering
  && (a.results === b.results || toolIds(a.items).every(id => a.results[id] === b.results[id]));

// One request and everything that answered it, as one flat list of rows with stable keys. The answer is the text after the last tool or thought;
// the rows before it are the process. Which rows are process is only a class, so nothing moves to another parent (and remounts) as the turn goes on:
// the process folds away with a height transition when the turn ends, and can be opened again.
// The info icon after the copy / branch / rewind icons: hover or focus opens this turn's tokens like the status line has them, one group per kind,
// `token` ↑ in ↓ out | `database` ↑ cache written ↓ cache read, the groups divided by a thin rule.
const GlyphIcon = ({ name, size = 14 }: { name: string; size?: number }) => <span className="icon material-symbols-outlined" style={{ fontSize: size }} aria-hidden="true">{name}</span>;
function TurnTokens({ done }: { done: TurnDone }) {
  const rows = turnTokenRows(done);
  return <span className="chat-done-tip">
    <IconButton icon="info" tip="none" label={[...rows.map(row => `${row.label} ${row.up.label} ${row.up.value} ${row.down.label} ${row.down.value}`), ...(done.costUsd ? [`비용 ${dollars(done.costUsd)}달러`] : [])].join(', ')} size={13} />
    <span className="chat-done-pop" role="tooltip">{rows.map(row => <span key={row.icon} className="chat-done-row">
      <GlyphIcon name={row.icon} size={15} /><b>{row.label}</b>
      <span><GlyphIcon name="arrow_upward" size={13} />{row.up.value}</span><span><GlyphIcon name="arrow_downward" size={13} />{row.down.value}</span>
    </span>)}{done.costUsd != null && <span className="chat-done-row"><GlyphIcon name="payments" size={15} /><b>비용</b><span>{'$' + dollars(done.costUsd)}</span></span>}</span>
  </span>;
}

// A published artifact in the thread. A durable claude.ai page still offers 열기, through the app's external-link dialog.
// A temporary, invalid, or expired address is only a note: nothing navigates.
function ArtifactCard({ artifact }: { artifact: ReturnType<typeof artifactsOf>[number] }) {
  const broken = artifact.problem != null;
  const body = <>
    <span className="icon material-symbols-outlined" aria-hidden="true">article</span>
    <span className="chat-artifact-text">
      <small>Artifact 생성됨</small>
      <strong>{artifact.title || (broken ? '아티팩트' : artifact.url)}</strong>
      {artifact.preview ? <em>{artifact.preview}</em> : !broken && <em>{artifact.url.replace('https://', '')}</em>}
      {broken && <p className="usage-note">이 아티팩트 링크는 만료되었거나 잘못된 주소입니다.</p>}
    </span>
    {!broken && <span className="chat-artifact-open">열기<Icon name="externalLink" size={13} /></span>}
  </>;
  if (broken) return <div className="chat-artifact">{body}</div>;
  return <a className="chat-artifact" href={artifact.url} rel="noreferrer noopener" onClick={event => { event.preventDefault(); window.dispatchEvent(new CustomEvent('ade:link', { detail: artifact.url })); }}>{body}</a>;
}

const Turn = memo(function Turn({ items, agentIds, settled, working, results, settings, plainThinking, bare, onBranch, onRewind, onRecover, recovering }: TurnProps) {
  const lead = items[0]?.kind === 'user' || items[0]?.kind === 'divider' ? items[0] : null;
  const body = lead ? items.slice(1) : items;
  const parts: Part[] = [];
  for (const item of body) {
    if (item.kind !== 'assistant') { parts.push({ kind: 'item', key: item.key, item }); continue; }
    if (item.parent && agentIds.has(item.parent)) continue; // a tracked subagent's steps live in its card's drawer, not in the thread
    item.blocks.forEach((block, index) => { if (shownBlock(block)) parts.push({ kind: 'block', key: `${item.key}|${block.key ?? index}`, item, block }); });
  }
  const flat = parts.filter((part): part is Extract<Part, { kind: 'block' }> => part.kind === 'block');
  const entries = flat.map(part => ({ block: part.block, sub: part.item.sub }));
  const { plain, groups } = processGroups(entries);
  const cut = plain.lastIndexOf(false) + 1; // the answer is the plain text after the last process; earlier results stay where they were said
  const groupAt = new Map<string, number>();
  groups.forEach((group, at) => { for (let i = group.start; i < group.end; i++) groupAt.set(flat[i].key, at); });
  // "Summary" display: a run of 3+ consecutive tools is one bundle row (its first tool's slot); the other members draw nothing of their own.
  const runStart = new Map<string, ToolRun>(), inRun = new Set<string>();
  if (settings.chatToolDisplay === 'summary') for (const run of toolRuns(entries, groups, 3, plainThinking)) {
    // A finished process that is nothing but this one run (no words between its tools) already reads as one unit under its "과정" header,
    // so its tools are listed straight under it instead of under a second "도구 N개 호출 완료" header.
    const own = groups[groupAt.get(flat[run.start].key) ?? -1];
    if (settled && own && own.start === run.start && own.end === run.end) continue;
    runStart.set(flat[run.start].key, run); for (let i = run.start; i < run.end; i++) inRun.add(flat[i].key);
  }
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const idOf = (group: ProcessGroup) => flat[group.start].key, foldedOf = (group: ProcessGroup) => settled && (overrides[idOf(group)] ?? group.answered);
  const finalAt = settled ? lastIndexWhere(body, item => item.kind === 'assistant' && !item.sub) : -1, finalItem = finalAt >= 0 ? body[finalAt] as AssistantItem : undefined;
  const answer = flat.slice(cut).map(part => part.block).filter((block): block is Extract<Block, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n\n')
    || (finalItem?.blocks.filter((block): block is Extract<Block, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n\n') ?? '');
  // While the turn runs its steps are plain rows in the thread; once it is over each stretch of them is boxed under its own "과정" header, so an opened process is clearly one unit.
  const rows: ReactNode[] = [];
  for (const part of parts) {
    if (part.kind === 'item') { rows.push(<Message key={part.key} item={part.item} onRecover={onRecover} recovering={recovering} />); continue; }
    const group = groups[groupAt.get(part.key) ?? -1] as ProcessGroup | undefined, folded = group ? foldedOf(group) : false;
    if (group && settled && part.key === flat[group.start].key) rows.push(<button key={`process:${part.key}`} type="button" className="chat-process-head" aria-expanded={!folded} onClick={() => setOverrides(current => ({ ...current, [idOf(group)]: !folded }))}>
      <span className="icon material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">account_tree</span>
      <strong>과정</strong>
      <span className="chat-process-summary">{group.tools ? `도구 ${group.tools}개` : '생각'}</span>
      <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={14} />
    </button>);
    const run = runStart.get(part.key);
    if (inRun.has(part.key) && !run) continue;
    if (run) {
      const members = flat.slice(run.start, run.end), lastOfGroup = group && flat[run.end - 1].key === flat[group.end - 1].key;
      rows.push(<div key={`bundle:${part.key}`} className={`chat-row${group ? ' in-process' : ''}${lastOfGroup ? ' process-last' : ''}`} data-enter={part.item.fresh || undefined} data-boxed={group && settled || undefined} data-folded={folded || undefined} inert={folded || undefined}>
        <div><ToolBundle parts={members} results={results} settings={settings} running={working && !settled} plainThinking={plainThinking} flat={settled && run.tools < FLAT_RUN_MAX} /></div>
      </div>);
      continue;
    }
    rows.push(<div key={part.key} className={`chat-row${group ? ' in-process' : ''}${group && part.key === flat[group.end - 1].key ? ' process-last' : ''}${part.item.sub ? ' sub' : ''}`} data-tool={(part.block.type === 'tool_use' && !(isAgentTool(part.block.name) && agentIds.has(part.block.id))) || undefined} data-enter={part.item.fresh || undefined} data-boxed={group && settled || undefined} data-folded={folded || undefined} inert={folded || undefined}>
      <div><BlockView block={part.block} result={part.block.type === 'tool_use' ? results[part.block.id] : undefined} settings={settings} running={working && !settled} plainThinking={plainThinking} enter={part.item.fresh} /></div>
    </div>);
  }
  const allowActions = !bare && finalItem && turnAllowsMessageActions(items);
  const artifacts = bare ? [] : artifactsOf(items.flatMap(item => item.kind === 'assistant' ? item.blocks : []), results);
  return <div className="chat-turn">
    {lead && <Message item={lead} />}
    {rows}
    {artifacts.map(artifact => <ArtifactCard key={`${artifact.toolUseId}:${artifact.problem ?? artifact.url}`} artifact={artifact} />)}
    {allowActions && <div className="chat-msg-actions">{answer.trim() && <IconButton icon="copy" label="응답 복사" size={13} onClick={() => copyText(answer)} />}
      {(finalItem.uuid || !onBranch) && <IconButton icon="branch" disabled={!onBranch} label={onBranch ? '여기서 분기 (새 탭에서 이 지점부터 이어가기)' : '이 CLI는 과거 지점 분기를 지원하지 않습니다'} size={13} onClick={() => onBranch?.(finalItem.uuid!)} />}
      {(finalItem.uuid || !onRewind) && <IconButton icon="undo" disabled={!onRewind} label={onRewind ? '여기로 되돌리기 (이후 대화 삭제)' : '이 CLI는 과거 지점 복원을 지원하지 않습니다'} size={13} onClick={() => onRewind?.(finalItem.uuid!)} />}
      {(finalItem.done?.tokens || finalItem.done?.costUsd) && <TurnTokens done={finalItem.done} />}
      {finalItem.done && <span className="chat-done-time">{turnDoneParts(finalItem.done).map(part => <span key={part}>{part}</span>)}</span>}</div>}
  </div>;
}, sameTurn);

function ChatErrorAlert({ message, recoverable, recovering, onRecover, enter }: { message: string; recoverable?: boolean; recovering?: boolean; onRecover?(): void; enter?: boolean }) {
  return <div className="chat-msg error" role="alert" data-enter={enter || undefined}><Icon name="alert" size={14} /><span>{message}</span>
    {recoverable && onRecover && <button type="button" className="chat-recover" disabled={recovering} onClick={onRecover}>{recovering ? '복구 중…' : '세션 복구'}</button>}</div>;
}

// What a slash command printed, right under the command. Long output starts clipped.
function CommandOutput({ text, isError, enter }: { text: string; isError: boolean; enter?: boolean }) {
  const [open, setOpen] = useState(false), long = text.length > 1500 || text.split('\n').length > 16, [pre, capture] = useHeightMorph<HTMLPreElement>();
  // A short one-line result ("Compacted", "/mcp 명령을 실행했습니다.") is a system line like the other notes; only real output gets the monospaced card.
  if (!text || (!long && !text.includes('\n') && text.length <= 80)) return <SystemLine text={text || '명령을 실행했습니다.'} error={isError} enter={enter} />;
  return <div className={`chat-msg command-output${isError ? ' error-output' : ''}`} data-enter={enter || undefined}>
    <pre ref={pre} className={long && !open ? 'clipped' : undefined}>{text}</pre>
    {long && <button type="button" className="chat-command-more" onClick={() => { capture(); setOpen(value => !value); }}>{open ? '접기' : '전체 보기'}</button>}
  </div>;
}

// A system message (a changed setting, an interrupted answer, a short command result) as a rule with the text in the middle, like the compact divider.
export function SystemLine({ text, error, enter, tones, rev }: { text: string; error?: boolean; enter?: boolean; tones?: Tone[]; rev?: number }) {
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
    if (slash) return <div className="chat-msg user" data-enter={enter} data-user-key={item.key} data-user-preview={preview.slice(0, 280)}><UserImages previews={item.previews} count={item.images} /><UserMessageBubble text={item.text} className="command" markdown={false}><span className="chat-command-name">/{slash.name || '…'}</span>{slash.args ? ` ${slash.args}` : ''}</UserMessageBubble></div>;
    const bus = parseBusMessages(item.text);
    if (bus) return <div className="chat-msg user" data-enter={enter} data-user-key={item.key} data-user-preview={preview.slice(0, 280)}><UserMessageBubble text={item.text} className="bus">{bus.map((message, index) => <div className="chat-bus" key={index}>
      <div className="chat-bus-head"><Icon name="bot" size={12} /><span>다른 에이전트의 메시지 · {busAgentName(message.agent)}{message.title ? ` “${message.title}”` : ''}</span>{message.hop > 0 && <small>답장 {message.hop}/{message.maxHops}</small>}</div>
      <Markdown text={message.text} />
    </div>)}</UserMessageBubble></div>;
    return <div className="chat-msg user" data-enter={enter} data-user-key={item.key} data-user-preview={preview.slice(0, 280)}>{item.shells ? <small className="chat-shell-included"><Icon name="terminal" size={12} />콘솔 실행 결과 {item.shells}건을 이 메시지와 함께 에이전트에게 보냈어요</small> : null}<UserImages previews={item.previews} count={item.images} />{!(item.images > 0 && item.text === '(이미지)') && <UserMessageBubble text={item.text} />}</div>;
  }
  if (item.kind === 'divider') return <div className="chat-divider" role="separator" data-enter={enter}><span>새 대화</span></div>;
  if (item.kind === 'compact') return <div className="chat-divider compact" role="separator" data-enter={enter}><span>{compactLabel(item.trigger)}{item.preTokens != null && item.postTokens != null ? ` · ${compact(item.preTokens)} → ${compact(item.postTokens)} 토큰 (${Math.max(0, Math.round((item.preTokens - item.postTokens) * 100 / Math.max(1, item.preTokens)))}% 감소)` : ' 완료'}</span></div>;
  if (item.kind === 'error') return <ChatErrorAlert message={item.message} recoverable={item.recoverable} recovering={recovering} onRecover={onRecover} enter={enter} />;
  if (item.kind === 'command') return <CommandOutput text={item.text} isError={item.isError} enter={enter} />;
  if (item.kind === 'note') return <SystemLine text={item.text} tones={item.tones} rev={item.rev} enter={enter} />;
  if (item.kind === 'agent_end') return <AgentEnd id={item.toolUseId} enter={enter} />;
  if (item.kind === 'info') return <div className="chat-row info" data-enter={enter || undefined}><div><Markdown text={item.text} /></div></div>;
  if (item.kind === 'mcp') return <McpCardRow enter={enter} />;
  if (item.kind === 'limit') return <LimitCardRow enter={enter} />;
  if (item.kind === 'usage') return <UsageCardRow item={item} enter={enter} />;
  if (item.kind === 'btw') return <BtwCardRow item={item} enter={enter} />;
  if (item.kind === 'shell') return <ShellCardRow item={item} enter={enter} />;
  return null;
});
function LimitCardRow({ enter }: { enter?: true }) {
  const { limitCall } = useContext(LocalCardsContext);
  return <div data-enter={enter}><LimitCard call={limitCall} /></div>;
}
function McpCardRow({ enter }: { enter?: true }) {
  const { mcpCall } = useContext(LocalCardsContext);
  return <div data-enter={enter}><McpCard call={mcpCall} /></div>;
}
function UsageCardRow({ item, enter }: { item: Extract<Item, { kind: 'usage' }>; enter?: true }) {
  const { projectId, colors, showSession } = useContext(LocalCardsContext);
  return <div data-enter={enter}><UsageCard snap={item.snap} projectId={projectId} colors={colors} showSession={showSession} /></div>;
}
function ShellCardRow({ item, enter }: { item: Extract<Item, { kind: 'shell' }>; enter?: true }) {
  const { stopShell, skipShell, shellNote } = useContext(LocalCardsContext);
  return <ShellCard item={item} enter={enter} onStop={stopShell} onSkip={skipShell} note={item.id === shellNote.lastId ? { pending: shellNote.pending } : undefined} />;
}
function BtwCardRow({ item, enter }: { item: Extract<Item, { kind: 'btw' }>; enter?: true }) {
  const { closeBtw, retryBtw } = useContext(LocalCardsContext);
  return <div data-enter={enter}><BtwCard item={item} onClose={() => closeBtw(item.key)} onRetry={() => retryBtw(item.key)} /></div>;
}

// ExitPlanMode: the plan is the thing being decided, so it gets room to read (tall body, larger type) and a full-size dialog
// that carries the same decision buttons. The footer stays outside the scroll area, so the answer is never scrolled away.
type PlanAnswer = { mode?: string; message?: string; allowTool?: boolean; permanent?: boolean };
function PlanActions({ modes, choices = true, onAnswer, onBack }: { modes: string[]; choices?: boolean; onAnswer(allow: boolean, answer?: PlanAnswer): void; onBack?(): void }) {
  const [revising, setRevising] = useState(false), [note, setNote] = useState(''), feedback = note.trim();
  if (revising) return <footer className="plan-revise">
    <label htmlFor="plan-feedback">어떻게 고치면 좋을지 알려 주세요</label>
    <textarea id="plan-feedback" autoFocus rows={3} maxLength={4000} value={note} placeholder="예: 2단계는 기존 API를 유지하는 쪽으로 다시 설계해 주세요. 테스트 계획도 추가해 주세요."
      onChange={event => setNote(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && feedback) { event.preventDefault(); onAnswer(false, { message: feedback }); } }} />
    <div className="plan-actions">
      <button type="button" className="plan-back" onClick={() => setRevising(false)}>취소</button>
      <button type="button" onClick={() => onAnswer(false)}>의견 없이 반려</button>
      <button type="button" className="primary" disabled={!feedback} onClick={() => onAnswer(false, { message: feedback })}>의견 보내고 다시 계획</button>
    </div>
  </footer>;
  // Like Claude Code: two ways to approve, differing only in the permission mode the run continues in. Auto (the CLI decides) is the default
  // choice; "edits allowed" lets file edits through and still asks for commands. Without auto mode the edit choice becomes the primary one.
  const auto = modes.includes('auto');
  // Cursor's plan has no permission mode to pick and no revision message: just approve or turn it down.
  if (!choices) return <footer className="plan-actions">
    {onBack && <button type="button" className="plan-back" onClick={onBack}>돌아가기</button>}
    <button type="button" className="secondary" onClick={() => onAnswer(false)}>거부</button>
    <button type="button" className="primary" onClick={() => onAnswer(true)}>승인</button>
  </footer>;
  return <footer className="plan-actions">
    {onBack && <button type="button" className="plan-back" onClick={onBack}>돌아가기</button>}
    <button type="button" className="secondary plan-back" onClick={() => setRevising(true)}>수정 요청…</button>
    <button type="button" className={auto ? undefined : 'primary'} onClick={() => onAnswer(true, { mode: 'acceptEdits' })} title="파일 편집 자동 허용 · 명령 실행 확인">편집 허용으로 승인</button>
    {auto && <button type="button" className="primary" onClick={() => onAnswer(true, { mode: 'auto' })} title="CLI 자동 승인 판단">자동 모드로 승인</button>}
  </footer>;
}
// The dialog of a long plan lists its `##` sections down the side (the one in view is lit) so it can be jumped through; the card itself is just the plan.
function usePlanSpy(count: number) {
  const body = useRef<HTMLDivElement>(null), [active, setActive] = useState(0);
  const sectionsOf = () => [...(body.current?.querySelectorAll<HTMLElement>(':scope > [data-plan-section]') ?? [])];
  const onScroll = () => {
    const el = body.current; if (!el) return;
    let at = 0; sectionsOf().forEach((node, index) => { if (node.offsetTop <= el.scrollTop + 12) at = index; });
    if (el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 4) at = count - 1;
    setActive(at);
  };
  const go = (index: number) => { const el = body.current, node = sectionsOf()[index]; if (el && node) el.scrollTo({ top: node.offsetTop - 4, behavior: calm() ? 'auto' : 'smooth' }); setActive(index); };
  return { body, active, onScroll, go };
}
// The plan reads top to bottom as written (no folding, no section chips); the title sits in the header and the decision stays under the body.
function PlanCard({ plan, modes, choices, onAnswer }: { plan: string; modes: string[]; choices?: boolean; onAnswer(allow: boolean, always: boolean, answers?: undefined, extra?: PlanAnswer): void }) {
  const played = usePlayedEntrance();
  const [open, setOpen] = useState(false), lines = plan.split('\n').length;
  const { title, sections } = useMemo(() => planSections(plan), [plan]);
  const body = useMemo(() => sections.map(section => section.title ? `## ${section.title}\n\n${section.body}` : section.body).join('\n\n'), [sections]);
  const titledAt = sections.flatMap((section, index) => section.title ? [index] : []), outline = titledAt.length > 2 && lines > 40;
  const dialog = usePlanSpy(sections.length);
  const decide = (allow: boolean, extra?: PlanAnswer) => onAnswer(allow, false, undefined, extra);
  return <div className="chat-approval chat-plan" {...played} role="alertdialog" aria-label="계획 검토">
    <header><span className="plan-label"><Icon name="plan" size={15} /><strong>계획 검토</strong></span><span className="plan-title" data-tip-overflow="">{title ? inline(title) : '이 계획대로 진행할까요?'}</span>
      <span className="plan-head-end"><IconButton icon="copy" label="계획 복사" onClick={() => copyText(plan)} /><IconButton icon="maximize" label="크게 보기" onClick={() => setOpen(true)} /></span></header>
    <div className="chat-plan-body"><Markdown text={body} /></div>
    <PlanActions modes={modes} choices={choices} onAnswer={decide} />
    {open && <Modal className="plan-modal" labelledBy="plan-title" onClose={() => setOpen(false)}>
      <header><span className="plan-label"><Icon name="plan" size={15} /><strong>계획 검토</strong></span><h2 id="plan-title">{title ? inline(title) : '이 계획대로 진행할까요?'}</h2>
        <span className="plan-head-end"><IconButton icon="copy" label="계획 복사" onClick={() => copyText(plan)} /><IconButton icon="x" label="닫기" onClick={() => setOpen(false)} /></span></header>
      <div className="plan-modal-main">
        {outline && <nav className="plan-modal-toc" aria-label="계획 목차">{titledAt.map(index => <button key={index} type="button" aria-current={dialog.active === index || undefined} onClick={() => dialog.go(index)}>{sections[index].title}</button>)}</nav>}
        <div className="plan-modal-body" ref={dialog.body} onScroll={dialog.onScroll}>
          {sections.map((section, index) => <section key={index} data-plan-section>{section.title && <h2>{section.title}</h2>}<Markdown text={section.body} /></section>)}
        </div>
      </div>
      <PlanActions modes={modes} choices={choices} onAnswer={decide} onBack={() => setOpen(false)} />
    </Modal>}
  </div>;
}

// explain: the agent reads a reason with a refusal (Claude), so "다르게 하기…" can turn the request down and say what to do instead, like the
// terminal's "No, and tell Claude what to do differently". Codex and Cursor take only allow/decline.
// A Write preview's header names the file once (relative to the chat folder), whether it is new or replaces one, and its length.
const writeLabel = (file: string, content: string, exists?: boolean) => {
  const lines = content ? content.replace(/\n+$/, '').split('\n').length : 0;
  return [file, exists === true ? '덮어쓰기' : exists === false ? '새 파일' : '', `${lines.toLocaleString()}줄`].filter(Boolean).join(' · ');
};
// What auto mode refused since the user's last message, with the choice the CLI's /permissions "Recently blocked" tab gives: allow for this chat (Enter), or allow and
// have the agent run it again (r). Rows are picked by checkbox (all by default); the server applies what it recorded for each refusal, the page only names them.
export function BlockedCard({ items, onAllow }: { items: BlockedAction[]; onAllow(ids: string[], retry: boolean): Promise<unknown> }) {
  const played = usePlayedEntrance();
  const cwd = useContext(CwdContext), [hidden, setHidden] = useState<ReadonlySet<string>>(new Set()), [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set()), [busy, setBusy] = useState(false);
  const shown = items.filter(item => !hidden.has(item.toolUseId)), chosen = shown.filter(item => !skipped.has(item.toolUseId));
  if (!shown.length) return null;
  const toggle = (id: string) => setSkipped(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const run = async (retry: boolean) => { setBusy(true); try { await onAllow(chosen.map(item => item.toolUseId), retry); } finally { setBusy(false); } };
  const canRule = chosen.length > 0 && chosen.every(item => item.rule) && chosen.some(item => !item.allowed);
  return <div className="chat-approval chat-blocked" {...played} role="region" aria-label="자동 모드가 차단한 작업">
    <header><Icon name="block" size={15} /><strong>자동 모드가 작업 {shown.length}개를 차단했습니다</strong><span>분류기가 위험하다고 판단해 실행하지 않았습니다</span></header>
    <div className="chat-approval-body">
      <ul className="chat-blocked-list">{shown.map(item => <li key={item.toolUseId}>
        <label><input type="checkbox" checked={!skipped.has(item.toolUseId)} disabled={busy} onChange={() => toggle(item.toolUseId)} />
          <span className="chat-blocked-main"><b>{toolLabel(item.tool)}</b><code title={toolSummary(item.tool, item.input, cwd)}>{toolSummary(item.tool, item.input, cwd)}</code></span></label>
        <small>{item.reason ? `사유 · ${item.reason}` : '분류기가 사유를 알려 주지 않았습니다'}{item.allowed ? ' · 허용됨, 아직 다시 시도하지 않음' : item.rule ? ` · 허용 규칙 ${item.rule}` : ' · 규칙으로 만들 수 없어 메시지로만 승인합니다'}</small>
      </li>)}</ul>
      <p className="chat-blocked-note">승인은 이 채팅에서만 적용되고 설정 파일에는 저장되지 않습니다.</p>
    </div>
    <footer>
      <button type="button" className="secondary approval-explain" disabled={busy} onClick={() => setHidden(current => new Set([...current, ...shown.map(item => item.toolUseId)]))} title="카드 닫기 · 차단 유지">무시</button>
      <button type="button" disabled={busy || !canRule} onClick={() => void run(false)} title={canRule ? '이 채팅에서만 허용 · 자동 재시도 없음' : '규칙 등록 불가 · 승인 후 재시도 필요'}>승인만</button>
      <button type="button" className="primary" disabled={busy || !chosen.length} onClick={() => void run(true)}>승인하고 다시 시도</button>
    </footer>
  </div>;
}
export function ApprovalCard({ approval, modes, settings, claude, asker, askerColor, onAnswer, onInterrupt, trust }: { approval: Approval; modes: string[]; settings: Settings; claude?: boolean; asker?: SubAgent; askerColor?: string; onAnswer(allow: boolean, always: boolean, answers?: Record<string, string[]>, extra?: PlanAnswer): void; onInterrupt(): void; trust?(entry: McpTrust): void }) {
  const played = usePlayedEntrance();
  const [menu, setMenu] = useState<{ right: number; bottom: number } | null>(null), caret = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null), menuOpen = menu !== null;
  useEffect(() => { if (menuOpen) list.current?.querySelector('button')?.focus(); }, [menuOpen]);
  // The card clips what overflows it (and is a size container, which moves `fixed` boxes with it), so the menu goes to the body, placed on screen above the caret.
  const toggleMenu = () => setMenu(open => { const box = caret.current?.getBoundingClientRect(); return open || !box ? null : { right: window.innerWidth - box.right, bottom: window.innerHeight - box.top + 6 }; });
  // The menu next to 허용 (which allows this request only): this chat keeps allowing the tool (Claude; the other agents' own session allow), or an MCP tool / server is trusted for good in the settings.
  const trustAnd = (entry: McpTrust) => { setMenu(null); trust?.(entry); onAnswer(true, false); };
  if (approval.questions?.length) return <QuestionCard questions={approval.questions} title={approval.tool === 'AskUserQuestion' ? '질문' : approval.tool} onAnswer={onAnswer} onInterrupt={onInterrupt} />;
  // Claude's ExitPlanMode and Cursor's create_plan ('계획 승인') read the same; only Claude picks the mode it continues in.
  if ((approval.tool === 'ExitPlanMode' || approval.tool === '계획 승인') && typeof approval.input?.plan === 'string') return <PlanCard plan={approval.input.plan} modes={modes} choices={approval.tool === 'ExitPlanMode'} onAnswer={onAnswer} />;
  const cwd = useContext(CwdContext), input = approval.input ?? {}, canAlways = approval.suggestions.length > 0, hasMenu = claude || canAlways || (!!approval.mcp && !!trust), summary = toolSummary(approval.tool, input, cwd), filePath = String(input.file_path ?? '');
  const written = approval.tool === 'Write' && typeof input.content === 'string' ? input.content : null;
  // The same diff view as the Edit tool card (only what changes, coloured), not the whole old text as removed and the new as added.
  const changed = approval.tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string' ? { from: input.old_string as string, to: input.new_string as string } : null;
  return <div className="chat-approval" {...played} role="alertdialog" aria-label={`${approval.tool} 실행 승인`}>
    <header><Icon name="alert" size={15} /><strong>{approval.tool}</strong><span>실행하려면 허용이 필요합니다</span>
      {asker && <span className="chat-approval-agent" style={dotStyle(askerColor)}><i className="chat-agent-dot" /><span className="chat-agent-type">{asker.type}</span><span className="chat-approval-agent-name"><b>{asker.description || '서브에이전트'}</b>의 요청</span></span>}</header>
    <div className="chat-approval-body">{SHELLS[approval.tool] ? <>{typeof input.description === 'string' && input.description && <p className="chat-approval-desc">{input.description}</p>}<CodeBlock code={String(input.command ?? '')} lang={SHELLS[approval.tool]} /></> : written === null && changed === null && <p className="chat-approval-line">{summary}</p>}
      {approval.tool === 'NotebookEdit' && notebookCell(input) && <div className="chat-approval-preview"><CodeBlock code={clip(notebookCell(input)!.code)} lang={notebookCell(input)!.label} syntax={notebookCell(input)!.syntax} /></div>}
      {written !== null && <div className="chat-approval-preview"><CodeBlock code={clip(written)} lang={writeLabel(summary, written, approval.exists)} syntax={filePath} /></div>}
      {changed !== null && <div className="chat-approval-diff"><ChatDiff named from={changed.from} to={changed.to} path={filePath || 'edit'} settings={settings} /></div>}</div>
    <footer>
      <button type="button" onClick={() => { onAnswer(false, false); onInterrupt(); }} title="거부하고 응답을 중단합니다">거부</button>
      <div className="approve-split">
        <button type="button" className="primary" onClick={() => onAnswer(true, false)}>허용</button>
        {hasMenu && <button type="button" ref={caret} className="primary approve-caret" aria-label="허용 방식 선택" aria-haspopup="menu" aria-expanded={menuOpen} onClick={toggleMenu}><Icon name="chevronDown" size={14} /></button>}
        {menu && createPortal(<><button type="button" className="context-dismiss" aria-label="메뉴 닫기" tabIndex={-1} onClick={() => setMenu(null)} />
          <div ref={list} className="menu approve-menu" role="menu" style={menu} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(null); } }}>
            {(claude || canAlways) && <button type="button" role="menuitem" onClick={() => { setMenu(null); claude ? onAnswer(true, false, undefined, { allowTool: true }) : onAnswer(true, true); }}>이 세션에서 허용</button>}
            {approval.mcp && trust && <>
              <button type="button" role="menuitem" onClick={() => trustAnd({ server: approval.mcp!.server, tool: approval.mcp!.tool })}>이 도구 신뢰</button>
              <button type="button" role="menuitem" onClick={() => trustAnd({ server: approval.mcp!.server })}>이 MCP 신뢰</button>
            </>}
          </div></>, document.body)}
      </div>
    </footer>
  </div>;
}

const fileData = (file: File) => new Promise<Attachment>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => { const url = String(reader.result), data = url.slice(url.indexOf(',') + 1); resolve({ mime: file.type, data, url }); };
  reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
});

// The thread shows these instead of the full images (which only go to the agent): small JPEGs that fit the event log. Failure just means no preview.
const thumbnail = (url: string) => new Promise<string | null>(resolve => {
  const image = new Image();
  image.onload = () => {
    const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight)), canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const draw = canvas.getContext('2d'); if (!draw) return resolve(null);
    draw.fillStyle = '#fff'; draw.fillRect(0, 0, canvas.width, canvas.height); draw.drawImage(image, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL('image/jpeg', 0.6); resolve(out.length <= 150_000 ? out : null);
  };
  image.onerror = () => resolve(null); image.src = url;
});

// Images of a sent message: thumbnails that open large, or just the count when the thread came from somewhere that kept no pictures.
function UserImages({ previews, count }: { previews?: string[]; count: number }) {
  const [big, setBig] = useState<string | null>(null), modalId = useId();
  if (!previews?.length) return count > 0 ? <small className="chat-images"><Icon name="copy" size={11} />이미지 {count}장</small> : null;
  return <>
    <div className="chat-user-images">{previews.map((url, index) => <button type="button" key={index} title="크게 보기" aria-label={`첨부 이미지 ${index + 1} 크게 보기`} onClick={() => setBig(url)}><img src={url} alt={`첨부 이미지 ${index + 1}`} /></button>)}</div>
    {big && <Modal className="image-modal" labelledBy={`image-modal-${modalId}`} region="이미지 크게 보기" onClose={() => setBig(null)}><span className="image-modal-frame"><img id={`image-modal-${modalId}`} src={big} alt="첨부 이미지 크게 보기" onClick={() => setBig(null)} /><IconButton icon="x" label="닫기" onClick={() => setBig(null)} /></span></Modal>}
  </>;
}

// How long the input may sit unfocused before the composer folds to one line.
const COMPACT_DELAY = 4000;
let flipSeq = 0;
// The composer's controls that slide between the one-line and full layouts (menus inside popovers or the settings panel stay put).
const FLIP_ITEMS = '.chat-attach, .chat-input-row, .chat-mode, .chat-model, .effort-wrap, .chat-ring, .chat-send, .chat-tune, .chat-switch, .chat-max, .chat-foot-note, .chat-model-config';
type FlipSnapshot = { root: DOMRect; items: Map<Element, DOMRect> };
const flipTargets = (root: HTMLElement) => [...root.querySelectorAll(FLIP_ITEMS)].filter(el => !el.closest('.chat-tune-panel, [popover]') && el.getClientRects().length > 0);
function flipSnapshot(root: HTMLElement | null): FlipSnapshot | null {
  if (!root || root.hidden) return null;
  return { root: root.getBoundingClientRect(), items: new Map(flipTargets(root).map(el => [el, el.getBoundingClientRect()])) };
}
// FLIP between the two composer layouts. The box animates its height; every control starts where it was and glides to its new place. Positions are taken from the box's
// bottom-left corner, because both layouts keep their rows on the bottom edge (justify/align flex-end), so they stay put relative to it while the height moves.
// A control that changed size (label ↔ icon) also fades up; one that only exists in the new layout fades and scales in.
function playFlip(root: HTMLElement, from: FlipSnapshot): Promise<unknown> {
  const flips = (el: Element) => el.getAnimations().filter(animation => animation.id === 'composer-flip');
  for (const el of [root, ...flipTargets(root)]) flips(el).forEach(animation => animation.cancel());
  const to = root.getBoundingClientRect(), duration = 360, easing = 'cubic-bezier(.22, 1, .36, 1)';
  const running: Animation[] = [];
  if (Math.abs(from.root.height - to.height) > .5) running.push(root.animate([{ height: `${from.root.height}px` }, { height: `${to.height}px` }], { id: 'composer-flip', duration, easing }));
  for (const el of flipTargets(root)) {
    const now = el.getBoundingClientRect(), was = from.items.get(el);
    if (!was) { running.push(el.animate([{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'none' }], { id: 'composer-flip', duration: 240, delay: 100, easing, fill: 'backwards' })); continue; }
    const dx = (was.left - from.root.left) - (now.left - to.left), dy = (was.bottom - from.root.bottom) - (now.bottom - to.bottom), resized = Math.abs(was.width - now.width) > 2;
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5 && !resized) continue;
    running.push(el.animate([{ transform: `translate(${dx}px, ${dy}px)`, opacity: resized ? .4 : 1 }, { transform: 'none', opacity: 1 }], { id: 'composer-flip', duration, easing }));
  }
  return Promise.allSettled(running.map(animation => animation.finished));
}

function sendQueueLabel(queue: { now?: boolean }[]) {
  const now = queue.reduce((count, item) => count + (item.now ? 1 : 0), 0), later = queue.length - now;
  if (now && later) return `응답을 끊고 보낼 메시지 ${now}개 · 그 뒤 Follow-up ${later}개`;
  if (now) return now > 1 ? `응답을 끊고 보낼 메시지 ${now}개` : '응답을 끊고 바로 보냅니다';
  return `Follow-up ${later}개 · 현재 응답이 끝나면 순서대로 전송`;
}

export function ChatPane({ leaf, focused, zoomed, visible, ctx, onFocus, onZoom, onSplit }: Props) {
  const id = leaf.id, cwd = leaf.cwd || ctx.root, agent = leaf.agent ?? 'claude', agentLabel = agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : 'Cursor Agent';
  const [agentModels, setAgentModels] = useState<{ models: Record<string, string>; catalog: CatalogModel[] }>({ models: {}, catalog: [] });
  const [view, setView] = useState<ChatView>(emptyView), viewRef = useRef(view); viewRef.current = view;
  // `fresh` plays an entrance once. A hidden tab is display:none, which cancels that animation, so returning would fade
  // the whole thread in again. Clear the flag before paint on a later visit; the first time this chat is shown it still plays.
  const chatShown = useRef(false);
  useLayoutEffect(() => {
    if (!visible) return;
    if (!chatShown.current) { chatShown.current = true; return; }
    const current = viewRef.current;
    if (!current.items.some(item => item.fresh)) return;
    const next = { ...current, items: current.items.map(item => item.fresh ? { ...item, fresh: false } : item) };
    viewRef.current = next; setView(next);
  }, [visible]);
  // Sidebar and header: rename → AI/agent title → first non-slash prompt since the last /clear.
  const title = (view.state.chatTitle ?? '').slice(0, 60);
  useEffect(() => { ctxRef.current.onTitle(id, title); }, [id, title]);
  const imageInput = useRef<HTMLInputElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(''), [stash, setStash] = useState(''), [recall, setRecall] = useState<{ at: number; draft: string } | null>(null), [images, setImages] = useState<Attachment[]>([]), [shrinking, setShrinking] = useState(0), [queue, setQueue] = useState<{ text: string; images: Attachment[]; draft?: string; now?: boolean }[]>([]);
  useEffect(() => {
    const saved = loadChatDevDraft(ctx.projectId, id);
    if (saved) setText(current => current || saved);
  }, [ctx.projectId, id]);
  useEffect(() => {
    const timer = setTimeout(() => saveChatDevDraft(ctx.projectId, id, text), 200);
    return () => clearTimeout(timer);
  }, [ctx.projectId, id, text]);
  const [queueSending, setQueueSending] = useState(false);
  const [dismissedQuestions, setDismissedQuestions] = useState<ReadonlySet<string>>(new Set());
  const [sendingQuestion, setSendingQuestion] = useState(false), sendingQuestionRef = useRef(false);
  const asyncQuestions = useMemo(() => agent === 'codex' ? pendingAsyncQuestions(view.items, dismissedQuestions) : [], [agent, view.items, dismissedQuestions]);
  // Pictures of a steering message: the server keeps them only while the turn has not taken the message in, so the composer remembers them by uuid to restore them on withdraw (↑).
  const pendingSteers = useRef(new Map<string, { text: string; images: Attachment[] }>()), queuedSteers = useRef(new Map<string, { text: string; images: Attachment[] }>());
  const [commands, setCommands] = useState<CommandInfo[]>([]), [menuAt, setMenuAt] = useState(0), [openError, setOpenError] = useState(''), [user, setUser] = useState(''), [away, setAway] = useState(false);
  const greeting = useMemo(() => pickGreeting(user), [user, id]);
  const [foot, setFoot] = useState<HTMLDivElement | null>(null), fitSig = useRef(''), flipping = useRef(0), tunePanel = `chat-tune-${useId()}`, scroller = useRef<HTMLDivElement>(null), thread = useRef<HTMLDivElement>(null), box = useRef<HTMLTextAreaElement>(null), stick = useRef(true), jump = useRef(false), ctxRef = useRef(ctx); ctxRef.current = ctx;
  const [bigImage, setBigImage] = useState<string | null>(null);
  // Files dragged over the pane. enter/leave also fire for every child on the way, so they are counted; a drop or drag that ends anywhere resets it.
  const [dropping, setDropping] = useState(false), dragDepth = useRef(0);
  const isFileDrag = (event: { dataTransfer: DataTransfer }) => event.dataTransfer.types.includes('Files');
  useEffect(() => {
    const stop = () => { dragDepth.current = 0; setDropping(false); };
    window.addEventListener('drop', stop, true); window.addEventListener('dragend', stop, true);
    return () => { window.removeEventListener('drop', stop, true); window.removeEventListener('dragend', stop, true); };
  }, []);
  const [pin, setPin] = useState<{ key: string; text: string } | null>(null);
  const syncPin = useCallback(() => {
    const root = scroller.current; if (!root) return;
    const edge = root.getBoundingClientRect().top + 4;
    let hit: HTMLElement | null = null;
    // From the newest up: the first one above the edge is the pin. Walking down from the top measured every older request, which also forced turns that are
    // out of view (content-visibility) to lay out on every scroll.
    const nodes = root.querySelectorAll<HTMLElement>('[data-user-key]');
    for (let at = nodes.length - 1; at >= 0; at--) if (nodes[at].getBoundingClientRect().bottom <= edge) { hit = nodes[at]; break; }
    const key = hit?.dataset.userKey ?? '', text = hit?.dataset.userPreview ?? '';
    setPin(current => current?.key === key && current.text === text ? current : key && text ? { key, text } : null);
  }, []);
  // Following the bottom: content growth glides the view down a fraction of the gap per frame instead of snapping a line at a time. Only the user's own
  // scrolling (wheel, touch, keys, scrollbar) lets go, so a fold collapsing or a block growing never unpins it; reaching the bottom pins it again.
  const follow = useRef(0), pinFrame = useRef(0), readingTool = useRef(false);
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
  const share = useUsageShare({ id, agent, enabled: visible && !view.state.apiKey, ready: view.ready, call: ctx.call, projectId: ctx.projectId, refresh: ctx.settings.usageRefresh, status: view.state.status, model: view.state.model, meter: agent === 'claude' ? view.state.costUsd ?? 0 : tokenWeight(view.state.tokens) });
  const setDiffLayout = useCallback((diffLayout: DiffLayoutChoice) => {
    const { settings, onSettingsChange } = ctxRef.current;
    if (settings.diffLayout !== diffLayout) onSettingsChange({ ...settings, diffLayout });
  }, []);
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
    busy = state.status === 'working' || state.status === 'attention',
    // Cursor ACP has no in-turn steer: a second session/prompt cancels the running turn. Enter does that and sends at once; Tab still waits.
    foldIn = caps?.steer !== false && agent !== 'cursor' && !(agent === 'codex' && view.compacting);

  // Set while a provider switch is under way (close, re-render, the new agent's open); the buttons stay locked so quick clicks cannot interleave sessions.
  const [providerSwap, setProviderSwap] = useState(false);

  // Attach to the server's session: subscribe first, then ask for the stored events; whatever arrived in between is applied after the replay (seq makes that safe).
  useEffect(() => {
    viewRef.current = emptyView();
    setView(emptyView());
    inbox.current = [];
    let alive = true, opened = false; const early: any[] = [];
    const handle = (message: any) => {
      if (message.type === 'chat/event') {
        enqueue(message);
        if (message.event?.kind === 'divider' && message.event.reason === 'clear') { setQueue([]); releaseUiSends(id); }
        const steer = message.event;
        if (steer?.kind === 'steer' && steer.phase === 'queued') {
          const draft = pendingSteers.current.get(steer.clientMessageId);
          if (draft) { queuedSteers.current.set(steer.uuid, draft); pendingSteers.current.delete(steer.clientMessageId); }
        }
        if (steer?.kind === 'steer' && steer.phase === 'applied') queuedSteers.current.delete(steer.uuid);
        if (steer?.kind === 'steer' && steer.phase === 'cancelled') {
          const draft = queuedSteers.current.get(steer.uuid);
          queuedSteers.current.delete(steer.uuid);
          if (!steer.resent && draft) restoreDraft(draft.text, draft.images);
          else if (!steer.resent && typeof steer.text === 'string') setText(current => current || steer.text);
        }
      }
      else if (message.type === 'chat/state') { enqueue(message); ctxRef.current.onState(id, message.state); }
    };
    const open = () => ctxRef.current.call('chat/open', { id, agent, ...(leaf.cwd ? { path: leaf.cwd } : {}), defaults: { ...(ctxRef.current.settings.chatDefaultPermission !== 'cli' ? { permissionMode: ctxRef.current.settings.chatDefaultPermission } : {}), ...(ctxRef.current.settings.chatDefaultEffort !== 'auto' ? { effort: ctxRef.current.settings.chatDefaultEffort } : {}) }, since: viewRef.current.ready ? viewRef.current.seq : 0 }).then(replay => {
      if (!alive) return; setProviderSwap(false); setOpenError(''); if (typeof replay.user === 'string') setUser(replay.user);
      if (!viewRef.current.ready) apply(() => fromReplay(replay));
      else apply(view => {
        let next = view; for (const event of replay.events ?? []) next = reduce(next, event);
        return { ...next, state: replay.state, approvals: (replay.approvals ?? []).map((item: any) => ({ requestId: item.requestId, tool: item.tool, input: item.input, toolUseId: item.toolUseId, questions: item.questions, suggestions: item.suggestions ?? [], ...(typeof item.exists === 'boolean' && { exists: item.exists }) })) };
      });
      ctxRef.current.onState(id, replay.state); opened = true; for (const message of early.splice(0)) handle(message);
    }, cause => { if (alive) { setProviderSwap(false); setOpenError(cause instanceof Error ? cause.message : String(cause)); } });
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

  // The pane handing focus to the input is not the user choosing it: the composer stays folded until they click, type or tab into it.
  const autoFocus = useRef(false);
  useEffect(() => { if (focused && visible) { autoFocus.current = true; box.current?.focus(); autoFocus.current = false; } }, [focused, visible]);
  // Cursor's process takes several seconds to start. Warm it as soon as the pane is on screen, not only once it has focus.
  useEffect(() => { if (agent === 'cursor' && view.ready && visible) void ctxRef.current.call('chat/warm', { id }).catch(() => {}); }, [agent, id, view.ready, visible]);
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
  // Prompt caches are per model: switching mid-conversation re-reads the whole context uncached on the next turn.
  // Asked only when there is something to re-read (user/assistant messages or a compact summary since the last /clear; notes and command output are not context). Resolves false when the user cancels
  // or picks "compact first": then /compact runs on the current model and the effect below switches once it finished.
  const compactThenSwitch = useRef<{ model: string; compacts: number; started: boolean } | null>(null);
  const compactCount = view.items.filter(item => item.kind === 'compact').length;
  async function setChat(input: any, confirmed = false) {
    if (!confirmed && input.model && input.model !== resolvedModelValue && input.model !== selectedModel && shown.some(item => item.kind === 'user' || item.kind === 'assistant' || item.kind === 'compact')) {
      const canCompact = available.some(item => item.name === 'compact');
      const choice = await ctx.pick('모델을 바꾸면 프롬프트 캐시가 만료돼요\n다음 메시지에서 대화 전체를 다시 읽어 사용량이 늘 수 있어요.',
        [{ id: 'yes', label: '모델 변경', icon: 'bot' }, ...(canCompact ? [{ id: 'compact', label: '압축하고 전환', icon: 'compress' as const, detail: '요약본만 다시 읽음' }] : []), { id: 'clear', label: '새 대화로 전환', icon: 'chat', detail: '이전 대화 비움' }, { id: 'no', label: '취소' }]);
      if (choice === 'clear') {
        if (busy || queue.length || queueSending) { note('응답이 끝난 뒤 다시 시도하세요.'); return false; }
        if (!await resetChat()) return false;
        await setChat(input, true);
        note(`대화를 비우고 모델을 ${displayModel(input.model, agent)}(으)로 바꿨습니다.`);
        return false;
      }
      if (choice === 'compact') {
        if (busy || queue.length || queueSending) { note('응답이 끝난 뒤 다시 시도하세요.'); return false; }
        compactThenSwitch.current = { model: input.model, compacts: compactCount, started: false };
        await transmit('/compact', []);
        return false;
      }
      if (choice !== 'yes') return false;
    }
    if (agent !== 'cursor') return ctx.call('chat/set', input);
    const patch = optimisticPatch(input), token = ++seq.current;
    const keys = optimisticKeys(patch);
    for (const key of keys) latest.current[key] = token;
    setOptimistic(current => mergeOptimistic(current, patch));
    try { return await ctx.call('chat/set', input); }
    catch (error) {
      const done = keys.filter(key => latest.current[key] === token);
      for (const key of done) delete latest.current[key];
      if (done.length) setOptimistic(current => dropOptimistic(current, done));
      throw error;
    }
  }
  // Drop the optimistic label only once the server state shows the same value, so a late reply cannot flash the previous model.
  useEffect(() => {
    setOptimistic(current => {
      const keys = optimisticKeys(current).filter(key => latest.current[key] !== undefined && optimisticSettled(view.state, current, key));
      if (!keys.length) return current;
      for (const key of keys) delete latest.current[key];
      return dropOptimistic(current, keys);
    });
  }, [view.state]);
  const [statsOpen, setStatsOpen] = useState(false), [modelsOpen, setModelsOpen] = useState(false), [resuming, setResuming] = useState(false), [resumeOpen, setResumeOpen] = useState(false);
  // Opening any chat counts as having tried Chat: the "try Chat" card in CLI terminals stops.
  useEffect(() => { if (ctxRef.current.settings.chatTipPending) ctxRef.current.onSettingsChange({ ...ctxRef.current.settings, chatTipPending: false }); }, []);
  // One-time pointers at the header buttons: the CLI switch whenever the chat is idle, the stats once a request was answered here.
  // Before those, the composer's keys, each right after the user did by mouse what the key does (`picked`, set once the change went through):
  // gone again when a message is sent, and never shown once the key itself was used.
  const [answered, setAnswered] = useState(false), [picked, setPicked] = useState('');
  useEffect(() => { if (busy) setAnswered(true); }, [busy]);
  // One pointer at a time in the whole app, after the cards (notices.ts).
  const hint = useTipNotice(`hint:${leaf.id}`, focused && visible && view.ready ? hintCandidates(ctx.settings, [
    ['keymodel', picked === 'keymodel'], ['keyeffort', picked === 'keyeffort'], ['keymode', picked === 'keymode'], ['keystash', picked === 'keystash'],
    ['tocli', view.state.status === 'idle'], ['stats', answered && agent === 'claude' && view.state.sessionId && view.state.status === 'idle'],
  ]) : []);
  const pickedBy = (name: string) => (done: unknown) => { if (done !== false) setPicked(name); };
  const hintSeen = (name: string) => { if (!ctx.settings.hintsSeen.includes(name)) ctx.onSettingsChange({ ...ctx.settings, hintsSeen: [...ctx.settings.hintsSeen, name] }); };
  const canLoadModels = agent !== 'codex' || (view.ready && view.state.agent === agent);
  useEffect(() => {
    // The Codex catalog response also sets the chat's supported Effort levels on the server.
    if (!canLoadModels) return;
    let alive = true;
    // The model list is a file read; the alias answers can take a CLI start. Show the list first so the picker is not stuck on the stand-ins meanwhile.
    if (agent === 'claude') void ctx.call('chat/model-catalog', { agent }).then((result: any) => { if (alive && result?.catalog?.length) setAgentModels(previous => previous.catalog.length ? previous : { ...previous, catalog: result.catalog }); }, () => {});
    void ctx.call('chat/models', { agent, id }).then(result => { if (alive) setAgentModels(result); }, ctx.fail);
    return () => { alive = false; };
  }, [agent, id, ctx.call, canLoadModels]);
  // Any size change of the thread (new text, a fold, a card opening) or of the viewport (dock growing) re-follows the bottom; nothing else needs to.
  // The bottom row never wraps. When its content would overflow it steps through fit levels (CSS keyed on data-fit): 1 = permission mode, sandbox and Effort lose their labels,
  // 2 = the extra switches move into the settings button, 3 = notes fold away and the model name may shorten, 4 = "+" moves from the left to the right, next to the settings button (permission mode stays on the left). It measures the real overflow, so there is no fixed pixel threshold.
  const fit = useCallback(() => {
    // Not while the composer slides between layouts: moving controls count as overflow. It measures again when the slide ends.
    const el = foot; if (!el || flipping.current) return;
    const sig = `${el.textContent}|${el.clientWidth}|${el.childElementCount}`;
    if (sig === fitSig.current) return;
    for (let level = 0; level <= 4; level++) { el.dataset.fit = String(level); if (el.scrollWidth <= el.clientWidth + 1) break; }
    fitSig.current = sig;
  }, [foot]);
  // The composer rests as one line (+ · mode · input … model · Effort · context · send, icons only except the model) and opens to the full two rows while you write.
  // One line: a few seconds after the input loses focus (not while the pointer is on it or a menu in it is open), or right after sending (focus stays).
  // Full: focusing or clicking the input, or any text or image in it. Changes slide every control from where it was (see playFlip).
  const composer = useRef<HTMLDivElement>(null), [oneLine, setCompactState] = useState(true), compactNow = useRef(true), flipFrom = useRef<FlipSnapshot | null>(null), compactTimer = useRef(0), mountedAt = useRef(performance.now()), draft = useRef({ text, images: images.length }); draft.current = { text, images: images.length };
  const setCompact = useCallback((next: boolean) => {
    window.clearTimeout(compactTimer.current);
    if (compactNow.current === next) return;
    // No slide while the pane is still settling (first focus, restored draft).
    flipFrom.current = performance.now() - mountedAt.current > 400 ? flipSnapshot(composer.current) : null;
    compactNow.current = next; setCompactState(next);
  }, []);
  const compactLater = useCallback(() => {
    window.clearTimeout(compactTimer.current);
    compactTimer.current = window.setTimeout(function tick() {
      const root = composer.current;
      if (!root || document.activeElement === box.current || draft.current.text || draft.current.images) return;
      if (root.matches(':hover') || root.querySelector('details[open]')) { compactTimer.current = window.setTimeout(tick, 1500); return; }
      setCompact(true);
    }, COMPACT_DELAY);
  }, [setCompact]);
  useEffect(() => { if (text || images.length) setCompact(false); }, [text, images.length, setCompact]);
  useEffect(() => () => window.clearTimeout(compactTimer.current), []);
  useLayoutEffect(() => {
    const from = flipFrom.current; flipFrom.current = null;
    if (!from || !composer.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // A newer slide (typed, then sent at once) takes over; only the last one to end re-fits.
    const token = flipping.current = ++flipSeq;
    void playFlip(composer.current, from).then(() => { if (flipping.current !== token) return; flipping.current = 0; fitSig.current = ''; fit(); });
  }, [oneLine]);
  useEffect(() => {
    const el = foot; if (!el) return;
    const observer = new ResizeObserver(() => { fitSig.current = ''; fit(); });
    // Its words or controls changed (a label, a new switch): measured then, not after every render of the pane (that read forced a layout per streamed token).
    const edits = new MutationObserver(fit);
    observer.observe(el); edits.observe(el, { childList: true, subtree: true, characterData: true }); void document.fonts?.ready.then(() => { fitSig.current = ''; fit(); });
    return () => { observer.disconnect(); edits.disconnect(); };
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
    // Opening a tool can emit a bottom scroll before its animation grows; that must not resume following while it is being read.
    if (gap < 4 && !readingTool.current) stick.current = true;
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
  const rewind = useCallback((uuid: string) => void ctxRef.current.pick('여기로 되돌릴까요? 이후 대화는 사라지고 에이전트가 이미 바꾼 파일은 그대로입니다.', [{ id: 'yes', label: '되돌리기', icon: 'undo' }]).then(choice => choice === 'yes' ? ctxRef.current.call('chat/rewind', { id, uuid }) : undefined).catch(ctxRef.current.fail), [id]);
  const jumpToEnd = () => { const element = scroller.current; if (!element) return; readingTool.current = false; stick.current = true; setAway(false); element.scrollTo({ top: element.scrollHeight, behavior: calm() ? 'auto' : 'smooth' }); };

  const note = (message: string) => apply(view => ({ ...view, items: [...view.items, { kind: 'note', key: `n${Date.now()}${Math.random()}`, text: message, local: true, fresh: true }] }));
  // A switched setting: the line just above is edited when it is also a switch, so repeating /model or /effort does not pile up lines.
  const changed = (change: SettingsChange) => apply(view => ({ ...view, items: withSettingChange(view.items, change, `n${Date.now()}${Math.random()}`) }));
  // A reply that reads like a chat message (markdown), for the report commands.
  const info = (message: string) => apply(view => ({ ...view, items: [...view.items, { kind: 'info', key: `i${Date.now()}${Math.random()}`, text: message, local: true, fresh: true }] }));
  useEffect(() => {
    const pending = compactThenSwitch.current; if (!pending) return;
    if (compactCount > pending.compacts) {
      compactThenSwitch.current = null;
      void setChat({ id, model: pending.model }, true).then(() => note(`압축을 마치고 모델을 ${displayModel(pending.model, agent)}(으)로 바꿨습니다.`), ctx.fail);
    } else if (busy) pending.started = true;
    else if (pending.started) { compactThenSwitch.current = null; note('압축이 완료되지 않아 모델을 바꾸지 않았습니다.'); }
  }, [compactCount, busy]);
  function restoreDraft(message: string, attachments: Attachment[]) {
    if (message) setText(current => !current ? message : current === message ? current : `${message}\n\n${current}`);
    if (attachments.length) setImages(current => current.length ? current : attachments);
  }
  const transmit = async (message: string, attachments: Attachment[], steer = false, clientMessageId?: string) => {
    readingTool.current = false; stick.current = true; jump.current = true;
    try {
      const previews = (await Promise.all(attachments.map(item => thumbnail(item.url)))).filter((url): url is string => url !== null);
      const sent = await ctx.call<{ steered?: boolean }>('chat/send', { id, text: message, steer, clientMessageId, interactiveUi: ctx.settings.interactiveUi, artifact: ctx.settings.artifactAlways, images: attachments.map(({ mime, data }) => ({ mime, data })), previews: previews.length === attachments.length ? previews : [] });
      if (clientMessageId && !sent?.steered) pendingSteers.current.delete(clientMessageId);
      return true;
    }
    catch (cause) { ctx.fail(cause); return false; }
  };
  // A message typed while Claude answers waits here and goes out when the turn ends.
  useEffect(() => {
    if (state.status !== 'idle' || !queue.length || !view.ready || queueSending) return;
    const [next, ...rest] = queue; setQueueSending(true); setQueue(rest);
    void transmit(next.text, next.images).then(sent => { if (!sent) restoreDraft(next.draft ?? next.text, next.images); }).finally(() => setQueueSending(false));
  }, [state.status, queue, view.ready, queueSending]);
  // Interactive UIs in a reply (ade-ui blocks) reach this chat through window events carrying the chat id. `ade.send` goes out like a typed message
  // (queued as a follow-up only while this agent is in a turn, so it never steers a running turn; a subagent running on its own does not count).
  // `ade.prefill` only fills the composer. The ref keeps the listener on fresh state.
  const fromUi = useRef<(kind: 'send' | 'prefill', message: string, replace?: boolean, form?: string) => void>(() => {});
  fromUi.current = (kind, message, replace, form) => {
    // replace: a form writes the whole next message, so it overwrites the box instead of appending under what was already typed.
    if (kind === 'prefill') { setText(current => replace || !current.trim() ? message : `${current}\n${message}`); box.current?.focus(); return; }
    if (!view.ready) return;
    const queued = busy || queue.length > 0 || queueSending;
    // A form's answer goes out once while it is on its way (ui-sent.ts): a second click or submit of the same choice is dropped here too.
    if (form && !beginUiSend(id, form, message, queued)) return;
    if (queued) setQueue(items => [...items, { text: message, images: [] }]);
    else void transmit(message, []);
  };
  // The state of the answers sent from forms follows the chat: queued -> working -> done, or freed when the user cancels the queued message.
  useEffect(() => {
    const follow = () => syncUiSends(id, { busy, queued: queue.map(item => item.text), sending: queueSending });
    follow();
    const timer = window.setTimeout(follow, UI_SEND_GRACE_MS + 200);
    return () => window.clearTimeout(timer);
  }, [id, busy, queue, queueSending]);
  useEffect(() => {
    const on = (kind: 'send' | 'prefill') => (event: Event) => { const { chatId, text: message, replace, form } = (event as CustomEvent<{ chatId: string; text: string; replace?: boolean; form?: string }>).detail; if (chatId === id) fromUi.current(kind, message, replace, form); };
    const send = on('send'), prefill = on('prefill');
    window.addEventListener('ade:ui-send', send); window.addEventListener('ade:ui-prefill', prefill);
    return () => { window.removeEventListener('ade:ui-send', send); window.removeEventListener('ade:ui-prefill', prefill); };
  }, [id]);
  const uiBlocks = useMemo(() => ({ projectId: ctx.projectId, chatId: id, enabled: ctx.settings.interactiveUi, fileChipLabel: ctx.settings.chatFileChipLabel }), [ctx.projectId, id, ctx.settings.interactiveUi, ctx.settings.chatFileChipLabel]);

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
  // A complete command name at the start of the composer (`/btw …`, only a name this chat knows) is drawn in the provider's colour, by a mirror behind the textarea.
  const commandHead = (() => { const head = /^\/[\w:-]+(?=\s|$)/.exec(text)?.[0] ?? ''; return head && available.some(item => item.name === head.slice(1)) ? head : ''; })(), inputMirror = useRef<HTMLDivElement>(null);
  const slashQuery = /^\/([^\s/]*)$/.exec(text), [slashOff, setSlashOff] = useState(false);
  // Escape dismisses the slash menu without deleting the draft; typing away from `/…` opens it again.
  useEffect(() => { if (!slashQuery) setSlashOff(false); }, [slashQuery === null]);
  const slash = slashOff ? null : slashQuery, matches = slash ? available.filter(item => {
    const query = slash[1].toLowerCase();
    const name = item.name.toLowerCase();
    // Loaded and runnable, but not offered as a completion unless typed out in full (it shadowed `/clear`).
    if (MENU_HIDDEN.has(name) && name !== query) return false;
    if (!query) return true;
    return name.startsWith(query) || name.split(':').some(part => part.startsWith(query));
  }).slice(0, 16) : [];
  const commandDraft = useMemo(() => {
    if (matches.length > 0) return null;
    const match = /^\/([\w:.-]+)(?:\s.*)?$/.exec(text);
    if (!match) return null;
    const info = available.find(item => item.name === match[1]);
    return info?.hint ? info : null;
  }, [text, available, matches.length]);
  // @-mention: the `@word` right before the caret picks a project file and becomes `@path`.
  const [files, setFiles] = useState<string[] | null>(null), [caret, setCaret] = useState(0), [mentionOff, setMentionOff] = useState(-1);
  const mention = slash ? null : /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret)), mentionAt = mention ? caret - mention[1].length - 1 : -1;
  const mentionOpen = mention !== null && mentionAt !== mentionOff;
  // Escape only dismisses that one @: once the caret leaves it (sent, deleted), the same position must open the menu again.
  useEffect(() => { if (!mention) setMentionOff(-1); }, [mention === null]);
  useEffect(() => {
    if (!mentionOpen) return;
    let alive = true;
    void ctxRef.current.call<{ files: string[] }>('files/list', leaf.cwd ? { path: leaf.cwd } : {}).then(result => { if (alive) setFiles(result.files); }, () => {});
    return () => { alive = false; };
  }, [mentionOpen, leaf.cwd]);
  const mentions = useMemo(() => {
    if (!mentionOpen || !files) return [];
    const query = mention![1].toLowerCase(), base = (file: string) => file.replace(/\/$/, '').split('/').pop()!.toLowerCase();
    const hits = query ? files.filter(file => file.toLowerCase().includes(query)) : files.filter(file => !file.slice(0, -1).includes('/'));
    return hits.map(file => ({ file, rank: base(file).startsWith(query) ? 0 : base(file).includes(query) ? 1 : 2 })).sort((a, b) => a.rank - b.rank || a.file.length - b.file.length).slice(0, 16).map(item => item.file);
  }, [mentionOpen, files, mention?.[1]]);
  const pickMention = (file: string) => {
    const before = text.slice(0, mentionAt) + `@${file}` + (file.endsWith('/') ? '' : ' '), next = before + text.slice(caret);
    setText(next); setCaret(before.length);
    requestAnimationFrame(() => { box.current?.focus(); const at = shownDraft(before).length; box.current?.setSelectionRange(at, at); });
  };
  useEffect(() => setMenuAt(0), [slash?.[1], mention?.[1]]);

  // /clear ends the child: a background subagent still running in it is asked about first, and the server is told it was agreed to.
  // false when cancelled at the background-task question.
  async function resetChat() {
    const force = Boolean(state.liveTasks?.length);
    if (force && await ctx.pick('백그라운드 작업이 실행 중입니다. 새 대화를 시작하면 작업이 종료됩니다.', [{ id: 'yes', label: '새 대화 시작', icon: 'chat' }, { id: 'no', label: '취소' }]) !== 'yes') return false;
    await ctx.call('chat/reset', { id, ...(force && { force }) });
    return true;
  }
  // /btw runs beside whatever the chat is doing: a separate server-side run, so it never waits for or disturbs a turn. The card lives only in this pane.
  const patchLocal = (key: string, patch: Partial<Extract<Item, { kind: 'btw' }>>) => apply(view => ({ ...view, items: view.items.map(item => item.key === key && item.kind === 'btw' ? { ...item, ...patch, fresh: false } : item) }));
  const closedBtw = useRef(new Set<string>());
  function askBtw(key: string, question: string) {
    closedBtw.current.delete(key); patchLocal(key, { status: 'pending', error: undefined });
    void ctx.call<{ answer: string; costUsd: number | null; tokens?: Tokens }>('chat/btw', { id, question, btwId: key }).then(
      result => { if (!closedBtw.current.has(key)) patchLocal(key, { status: 'done', answer: result.answer, costUsd: result.costUsd, tokens: result.tokens }); },
      cause => { if (!closedBtw.current.has(key)) patchLocal(key, { status: 'error', error: cause instanceof Error ? cause.message : String(cause) }); });
  }
  const closeBtw = (key: string) => {
    const item = viewRef.current.items.find(entry => entry.key === key);
    if (item?.kind === 'btw' && item.status === 'pending') { closedBtw.current.add(key); void ctx.call('chat/btw-cancel', { id, btwId: key }).catch(() => {}); }
    apply(view => ({ ...view, items: view.items.filter(entry => entry.key !== key) }));
  };
  const retryBtw = (key: string) => { const item = viewRef.current.items.find(entry => entry.key === key); if (item?.kind === 'btw') askBtw(key, item.question); };
  // The cards sit in memoised rows, so they reach these through a ref that always holds this render's functions.
  const btwApi = useRef({ closeBtw, retryBtw }); btwApi.current = { closeBtw, retryBtw };
  // The "will be sent with your next message" note is drawn once, under the newest `!` card (several waiting cards share it), not under every card.
  const shellNote = useMemo(() => { const shells = view.items.filter((item): item is Extract<Item, { kind: 'shell' }> => item.kind === 'shell'); return { lastId: shells[shells.length - 1]?.id ?? '', pending: shells.filter(item => !item.sent && !item.skipped && item.status !== 'running' && item.status !== 'error').length }; }, [view.items]);
  const localCards = useMemo<LocalCards>(() => ({ projectId: ctx.projectId, colors: ctx.settings.usageColors, showSession: ctx.settings.claudeSession, closeBtw: key => btwApi.current.closeBtw(key), retryBtw: key => btwApi.current.retryBtw(key), shellNote, mcpCall: input => ctxRef.current.call('chat/mcp', { id, ...input }), limitCall: input => ctxRef.current.call('chat/limit', { id, ...input }), stopShell: runId => { void ctxRef.current.call('chat/shell-stop', { id, runId }).catch(() => {}); }, skipShell: (runId, on) => { void ctxRef.current.call('chat/shell-skip', { id, runId, on }).catch(() => {}); } }), [ctx.projectId, ctx.settings.usageColors, ctx.settings.claudeSession, shellNote]);
  // The model and Effort pickers (menus, models window) and the /model, /effort commands all end here, so each leaves the same 변경 line in the chat.
  async function chooseModel(value: string) {
    if (await setChat({ id, model: value }) === false) return false;
    const row = modelRows(catalog, aliases).find(item => item.value === value), label = row?.label ?? displayModel(value, agent);
    changed({ model: { value: label, color: modelAppearance(row ? `${row.family} ${row.id} ${row.label}` : value, agent).color ?? 'currentColor' } });
    return true;
  }
  async function chooseEffort(value: string) {
    if (await setChat({ id, effort: value || null }) === false) return false;
    if (value) { const style = effortStyle[effortLevel(value)] ?? effortStyle.medium; changed({ effort: { value: effortLabel(value), color: style.color, icon: style.icon, bars: style.bars } }); }
    return true;
  }
  async function runLocal(name: string, argument: string): Promise<boolean> {
    if (locked && ['model', 'effort', 'permissions'].includes(name)) { note(`지금은 설정을 바꿀 수 없습니다. ${locked}`); return true; }
    switch (name) {
      case 'resume': await resume(); return true;
      case 'stats':
        if (!state.sessionId) note('아직 시작하지 않은 대화입니다. 메시지를 한 번 보낸 뒤 열어 보세요.');
        else setStatsOpen(true);
        return true;
      case 'retry': await ctx.call('chat/retry', { id }); note('마지막 요청을 같은 세션으로 다시 보냈습니다.'); return true;
      case 'clear': await resetChat(); return true;
      case 'exit': ctx.onClose(id); return true;
      case 'config': ctx.onOpenSettings(); return true;
      case 'model': {
        if (agent === 'cursor' && !argument) { setModelsOpen(true); return true; }
        const value = argument || await ctx.pick('모델 선택', modelRows(catalog, aliases).map(row => ({ id: row.value, label: row.label, icon: agent })));
        if (value) await chooseModel(value);
        return true;
      }
      case 'effort': {
        if (!effortOptions.length) { note('이 CLI는 별도의 Effort 선택지를 제공하지 않습니다. 지원되는 모델 변형을 모델 메뉴에서 선택하세요.'); return true; }
        const value = argument || await ctx.pick('Effort 선택', effortOptions.map(item => ({ id: item, label: `${item} · ${effortLabel(item)}`, icon: 'chart' })));
        if (value) { if (!effortOptions.includes(value)) note(`알 수 없는 Effort: ${value} (${effortOptions.join(', ')})`); else await chooseEffort(value); }
        return true;
      }
      case 'permissions': {
        const value = argument || await ctx.pick('권한 모드', modes.map(mode => ({ id: mode, label: permissionLabel(mode, agent), icon: 'shield' })));
        if (value) { if (!modes.includes(value)) note(`알 수 없는 권한 모드: ${value}`); else { await setChat({ id, permissionMode: value }); changed({ mode: { value: `${permissionLabel(value, agent)} 모드`, color: permissionModeColor(value), icon: MODE_ICONS[value] ?? 'tune' } }); } }
        return true;
      }
      case 'autocompact': {
        if (agent !== 'claude') { note('Auto Compact 창은 Claude 채팅에서만 바꿀 수 있습니다.'); return true; }
        if (!argument) { const gauge = contextGauge(state); note(gauge.autoCompact ? `Auto Compact 창: ${compact(gauge.basis)} 토큰 (최대 ${compact(gauge.max)}). 변경: /autocompact auto 또는 350k` : '별도 Auto Compact 창을 정하지 않았습니다(auto는 Claude Code가 알아서 정합니다). 줄이려면 /autocompact 350k'); return true; }
        const result = await ctx.call<{ autoCompact: { window: number; auto: boolean } | null }>('chat/autocompact', { id, value: argument });
        if (result?.autoCompact) changed({ compact: { value: `${compact(result.autoCompact.window)} 토큰${result.autoCompact.auto ? ' (auto)' : ''}`, color: 'var(--term-magenta)', icon: 'compress' } });
        else note(/^auto$/i.test(argument.trim()) ? 'auto로 저장했습니다. 창 크기는 Claude Code가 모델에 맞게 정하며, 게이지는 모델의 전체 컨텍스트 기준으로 표시합니다.' : '저장했습니다. 최대 컨텍스트와 같아 별도 창은 쓰지 않습니다.');
        return true;
      }
      case 'idlecompact': {
        if (agent !== 'claude') { note('캐시 만료 전 압축은 Claude 채팅에서만 쓸 수 있습니다.'); return true; }
        const value = ({ on: true, off: false, auto: null } as Record<string, boolean | null>)[argument.trim().toLowerCase()];
        if (argument && value === undefined) { note('on, off 또는 auto(앱 설정을 따름)로 입력하세요.'); return true; }
        const result = argument ? await ctx.call<IdleCompactInfo>('chat/idlecompact', { id, value }) : state.idleCompact;
        note(idleCompactNote(result, ctx.settings.idleCompactMinK));
        return true;
      }
      case 'rename': {
        if (!argument) { note(title ? `현재 채팅 이름: ${title}` : '아직 채팅 이름이 없습니다. /rename 새 이름 으로 정할 수 있습니다.'); return true; }
        const result = await ctx.call<{ title: string }>('chat/rename', { id, title: argument });
        changed({ title: { value: result?.title || argument, color: 'var(--accent)', icon: 'edit' } });
        return true;
      }
      case 'mcp': {
        if (agent === 'claude') { apply(view => ({ ...view, items: [...view.items, { kind: 'mcp', key: `m${Date.now()}${Math.random()}`, local: true, fresh: true }] })); return true; }
        const servers = new Map<string, number>();
        for (const tool of state.tools) { const match = /^mcp__(.+?)__/.exec(tool); if (match) servers.set(match[1], (servers.get(match[1]) ?? 0) + 1); }
        if (!servers.size) note(state.tools.length ? '이 채팅에 연결된 MCP 서버가 없습니다.' : '첫 응답 후 연결된 MCP 서버가 표시됩니다.');
        else info(`### MCP 서버\n\n| 서버 | 도구 |\n|---|---|\n${[...servers].map(([server, count]) => `| ${server} | ${count}개 |`).join('\n')}`);
        return true;
      }
      case 'limit': apply(view => ({ ...view, items: [...view.items, { kind: 'limit', key: `l${Date.now()}${Math.random()}`, local: true, fresh: true }] })); return true;
      case 'tasks': {
        const labels: Record<string, string> = { running: '실행 중', done: '완료', error: '오류', stopped: '중단' };
        if (!agentList.length) note('이 채팅에서 실행한 서브에이전트가 없습니다.');
        else info(`### 서브에이전트\n\n| 상태 | 작업 |\n|---|---|\n${agentList.map(item => `| ${labels[item.status] ?? item.status} | ${(item.description || item.type).replace(/\|/g, '/')} |`).join('\n')}`);
        return true;
      }
      case 'cost': case 'status': {
        const tokens = state.tokens, n = (value: number) => value.toLocaleString('ko-KR'), cost = state.costUsd === null ? '미제공' : `$${dollars(state.costUsd)}`, model = modelChoices.find(option => option.value === modelValue(selectedModel, aliases))?.label ?? displayModel(state.model, agent);
        const gauge = contextGauge(state);
        const contextRow: [string, string] | null = name === 'status' && contextReported(state)
          ? ['컨텍스트', `${compact(gauge.used)} / ${compact(gauge.basis)} (${gauge.percent}%)`]
          : name === 'status' && state.capabilities?.context !== false
            ? ['컨텍스트', '첫 응답 후 CLI가 보고하면 표시됩니다']
            : null;
        const rows: [string, string][] = name === 'cost'
          ? [['모델', model], ['비용', `${cost} · ${state.turns}턴`],
            ...(caps?.tokens === false ? [['토큰', 'CLI가 토큰 사용량을 제공하지 않습니다'] as [string, string]] : [['입력 토큰', n(tokens.input)], ['출력 토큰', n(tokens.output)], ['캐시 읽기', n(tokens.cacheRead)], ['캐시 쓰기', n(tokens.cacheCreate)]] as [string, string][])]
          : [['모델', model], ['Effort', effortLabel(state.effort ?? 'medium')], ['권한 모드', permissionLabel(state.permissionMode, agent)],
            ['비용', `${cost} · ${state.turns}턴`], ...(contextRow ? [contextRow] : []), ['세션', state.sessionId ? `\`${state.sessionId}\`` : '아직 없음']];
        info(`### ${name === 'cost' ? '비용' : '상태'}\n\n| 항목 | 값 |\n|---|---|\n${rows.map(([label, value]) => `| ${label} | ${value} |`).join('\n')}`);
        return true;
      }
      case 'usage': {
        // Drawn from the chat's own state at once (no request, so it also works mid-turn); the plan limits fill in inside the card.
        const gauge = contextGauge(state), shownContext = state.capabilities?.context !== false && contextReported(state);
        const snap: UsageSnap = {
          at: Date.now(), agent, apiKey: state.apiKey === true, model: modelChoices.find(option => option.value === modelValue(selectedModel, aliases))?.label ?? displayModel(state.model, agent),
          context: shownContext ? { used: gauge.used, basis: gauge.basis, max: gauge.max, percent: gauge.percent, autoCompact: gauge.autoCompact } : null,
          costUsd: state.costUsd, turns: state.turns, tokens: caps?.tokens === false ? null : state.tokens, share
        };
        apply(view => ({ ...view, items: [...view.items, { kind: 'usage', key: `u${Date.now()}${Math.random()}`, snap, local: true, fresh: true }] }));
        return true;
      }
      case 'btw': {
        if (!argument) { note('사용법: /btw <질문> — 지금 대화를 아는 가벼운 모델이 짧게 답하고, 대화 기록과 진행 중인 작업에는 영향을 주지 않습니다.'); return true; }
        const key = `b${Date.now()}${Math.random()}`;
        apply(view => ({ ...view, items: [...view.items, { kind: 'btw', key, question: argument, status: 'pending', local: true, fresh: true }] }));
        askBtw(key, argument);
        return true;
      }
      case 'help': note(`이 창에서 바로 처리: ${LOCAL.map(item => `/${item.name}`).join(' ')}\n${agentLabel}가 지원하는 명령만 사용할 수 있습니다. 화면형 선택이 필요한 명령은 터미널 탭에서 쓰세요.`); return true;
      default: return false;
    }
  }
  // Enter while Claude or Codex works steers the running turn (sent now, folded into it); Tab is the follow-up (held until the turn ends). `/…` lines never steer.
  // Cursor cannot fold a line into the running turn, so Enter stops that turn and sends the line as the next one. Tab still waits.
  async function submit(mode: 'steer' | 'queue' = 'steer') {
    const typed = text.trim();
    if ((!typed && !images.length) || !view.ready) return;
    // `!command` runs a shell command (runs beside a working turn too); `!…` sends a message that starts with `!`.
    const shellInput = parseShellInput(typed);
    let runCommand = shellInput?.kind === 'run' ? shellInput.command : '';
    if (shellInput?.kind === 'empty') { note('사용법: !명령 — 이 폴더에서 셸 명령을 직접 실행합니다. 예: !git status (!로 시작하는 메시지는 \\!로 시작해 보내세요)'); setText(''); return; }
    if (shellInput?.kind === 'ambiguous') {
      const choice = await ctx.pick(`“${shellInput.command.length > 60 ? `${shellInput.command.slice(0, 60)}…` : shellInput.command}”을(를) 셸 명령으로 실행할까요, 메시지로 보낼까요?`, [{ id: 'run', label: '셸 명령으로 실행', icon: 'terminal' }, { id: 'send', label: '메시지로 보내기', icon: 'send' }, { id: 'no', label: '취소' }]);
      if (choice === 'run') runCommand = shellInput.command; else if (choice !== 'send') return;
    }
    if (runCommand) {
      try { await ctx.call('chat/shell', { id, command: runCommand }); setText(''); setRecall(null); setCompact(true); clearChatDevDraft(ctx.projectId, id); } catch (cause) { note(cause instanceof Error ? cause.message : String(cause)); }
      return;
    }
    const message = shellInput?.kind === 'escaped' ? shellInput.text.trim() : typed;
    if (!message && !images.length) return;
    const command = /^\/([\w:-]+)(?:\s+(.*))?$/s.exec(message);
    if (command && LOCAL.some(item => item.name === command[1])) { setText(''); setCompact(true); clearChatDevDraft(ctx.projectId, id); try { await runLocal(command[1], (command[2] ?? '').trim()); } catch (cause) { ctx.fail(cause); } return; }
    // Cold (or nearly) prompt cache on a filled, not-cleared context: confirm before the whole context is re-read; cancel keeps the draft.
    const cache = view.state.cache, warning = agent === 'claude' && !busy && !queue.length && !queueSending && !message.startsWith('/') && shown.length && cache ? cacheSendWarning(cache, Date.now(), { enabled: ctx.settings.cacheSendWarn, minutes: ctx.settings.cacheSendWarnMinutes, working: false }) : undefined;
    if (warning?.tokens && await ctx.pick(cacheSendWarningText(warning), [{ id: 'no', label: '취소' }, { id: 'yes', label: '그래도 보내기', icon: 'send' }]) !== 'yes') return;
    // The login was switched (silently) after the chat's last turn: the first message on the other one asks, like a model change does.
    const authWarning = message.startsWith('/') ? undefined : authSendWarning(view.state, { working: busy || queue.length > 0 || queueSending });
    if (authWarning) {
      const choice = await ctx.pick(authSendWarningText(authWarning), [{ id: 'yes', label: `${authWords[authWarning.to]} 보내기`, icon: 'send' }, { id: 'back', label: `${authWords[authWarning.from]} 되돌려 보내기`, icon: 'undo' }, { id: 'no', label: '취소' }]);
      if (choice === 'back') { try { await setChat({ id, auth: authWarning.from }); } catch (cause) { ctx.fail(cause); return; } } else if (choice !== 'yes') return;
    }
    const attachments = images; setText(''); setRecall(null); setImages([]); setCompact(true); setPicked(''); clearChatDevDraft(ctx.projectId, id);
    // Match the server's file threshold so a pasted log keeps its outer whitespace too.
    const body = message && !shellInput && !command && new Blob([text]).size > 64 * 1024 ? text : message || '(이미지)';
    if (busy && mode === 'steer' && foldIn && !message.startsWith('/')) {
      const clientMessageId = crypto.randomUUID();
      pendingSteers.current.set(clientMessageId, { text, images: attachments });
      if (!await transmit(body, attachments, true, clientMessageId) && pendingSteers.current.delete(clientMessageId)) restoreDraft(text, attachments);
    }
    else if (busy && mode === 'steer' && agent === 'cursor' && !message.startsWith('/')) { setQueue(items => enqueueSendNow(items, { text: body, images: attachments, draft: text, now: true })); interrupt(false); }
    else if (busy || queue.length || queueSending) setQueue(items => [...items, { text: body, images: attachments, draft: text }]);
    else if (!await transmit(body, attachments)) restoreDraft(text, attachments);
  }
  // Files that are not images go into the message as `@path` (the agent reads them itself). The desktop shell knows a dropped file's path; a browser
  // sends the file to the server (up to 8MB) and mentions that copy.
  async function mentionFiles(files: File[]) {
    const pathForFile = (window as unknown as { adeDesktop?: { pathForFile?(file: File): string } }).adeDesktop?.pathForFile;
    try {
      const paths = pathForFile ? files.map(file => pathForFile(file)).filter(Boolean)
        : await Promise.all(files.map(async file => (await ctx.call<{ path: string }>('files/upload', { name: file.name, data: (await fileData(file)).data })).path));
      if (!paths.length) return;
      setText(current => `${current}${current && !/\s$/.test(current) ? ' ' : ''}${paths.map(path => /\s/.test(path) ? `@"${path}"` : `@${path}`).join(' ')} `);
      toastAttached(paths.length); box.current?.focus();
    } catch (cause) { ctx.fail(cause); }
  }
  async function attach(files: File[]) {
    const isImage = (file: File) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type);
    const others = files.filter(file => !isImage(file));
    if (others.length) void mentionFiles(others);
    if (caps?.images === false && others.length < files.length) return ctx.fail(new Error('선택한 모델은 이미지 입력을 지원하지 않습니다.'));
    const accepted = files.filter(isImage);
    if (!accepted.length) return;
    // 5MB가 넘는 그림은 줄이는 데 몇 초 걸릴 수 있어, 그동안 "줄이는 중"을 보여 준다(조용히 멈춘 것처럼 보이지 않게).
    const large = accepted.filter(file => file.size > 4_500_000).length; if (large) setShrinking(count => count + large);
    try {
      const next = [...images, ...(await Promise.all(accepted.map(prepareChatImage)))].slice(0, 4);
      setImages(next); toastAttached(next.length - images.length || accepted.length);
    } catch (cause) { ctx.fail(cause); } finally { if (large) setShrinking(count => Math.max(0, count - large)); }
  }
  const answer = (approval: Approval, allow: boolean, always: boolean, answers?: Record<string, string[]>, extra?: PlanAnswer) => void ctx.call('chat/approve', { id, requestId: approval.requestId, allow, always, answers, ...extra }).catch(ctx.fail);
  async function answerAsyncQuestion(allow: boolean, _always: boolean, answers?: Record<string, string[]>) {
    if (sendingQuestionRef.current) return;
    if (allow && answers) {
      const message = asyncQuestions.map(question => `질문: ${question.prompt}\n답변: ${answers[question.id].join(', ')}`).join('\n\n');
      sendingQuestionRef.current = true;
      setSendingQuestion(true);
      const sent = await transmit(message, [], busy && foldIn);
      sendingQuestionRef.current = false;
      setSendingQuestion(false);
      if (!sent) return;
    }
    setDismissedQuestions(current => new Set([...current, ...asyncQuestions.map(question => question.id)]));
  }
  const interrupt = (sendSteers = false) => { releaseUiSends(id); void ctx.call('chat/interrupt', { id, sendSteers }).catch(ctx.fail); };
  const allowBlocked = (toolUseIds: string[], retry: boolean) => ctx.call('chat/allow-blocked', { id, toolUseIds, retry }).catch(ctx.fail);
  const stopTask = (toolUseId: string) => void ctx.call('chat/stop-task', { id, toolUseId }).catch(ctx.fail);
  function resume() {
    if (resuming) return;
    if (busy) { ctx.fail(new Error('응답이 끝난 뒤 이전 대화를 불러올 수 있습니다.')); return; }
    setResumeOpen(true);
  }
  async function pickResume(choice: { kind: 'chat'; id: string } | { kind: 'cli'; sessionId: string }) {
    setResumeOpen(false); setResuming(true);
    try { await (choice.kind === 'chat' ? ctx.resumeChat(choice.id, agent, id) : ctx.importCliChat(choice.sessionId, id)); }
    catch (cause) { ctx.fail(cause); }
    finally { setResuming(false); }
  }

  const complete = (name: string) => { setText(`/${name} `); box.current?.focus(); };

  const agentState = view.approvals.length ? 'attention' : state.status === 'working' ? 'working' : 'idle';
  // After /clear the earlier history stays in `items` but is hidden: the pane shows the start screen again.
  const awaiting = useMemo(() => awaitingTools(view.items, view.approvals, view.results), [view.items, view.approvals, view.results]);
  const askingAgents = useMemo(() => approvalAgents(view.items, view.approvals), [view.items, view.approvals]);
  const waitingAgents = useMemo(() => new Set(askingAgents.values()), [askingAgents]);
  const shown = useMemo(() => { const from = lastIndexWhere(view.items, item => item.kind === 'divider'); return from < 0 ? view.items : view.items.slice(from + 1); }, [view.items]);
  const turns = useMemo(() => turnsOf(shown, busy), [shown, busy]), lastTurn = turns.at(-1);
  // Subagents (Claude's Agent calls). Their steps leave the thread for their own card, tracker row and drawer.
  const agentsSeen = useRef<SubAgent[]>([]);
  // Subagents: Claude's Agent calls, and Cursor's Task calls (only drawn once the protocol reports them).
  const agentList = useMemo(() => agentsSeen.current = keepAgents(agentsSeen.current, agent === 'claude' || agent === 'cursor' ? agentsOf(shown, view.results, view.tasks, busy, state.liveTasks, state.effort) : []), [agent, shown, view.results, view.tasks, busy, state.liveTasks, state.effort]);
  const agentKey = agentList.map(item => item.id).join(' ');
  const agentIds = useMemo(() => new Set(agentKey ? agentKey.split(' ') : []), [agentKey]);
  const agentColors = useMemo(() => new Map(agentKey ? agentKey.split(' ').map((key, index) => [key, agentColor(index)] as const) : []), [agentKey]);
  const runningAgents = agentList.filter(item => item.status === 'running').length, runningJobs = agentList.filter(item => item.job && item.status === 'running').length;
  // "에이전트 2개 · 백그라운드 작업 1개 실행 중…": subagents and jobs counted apart.
  const runningLabel = `${[runningAgents - runningJobs && `에이전트 ${runningAgents - runningJobs}개`, runningJobs && `백그라운드 작업 ${runningJobs}개`].filter(Boolean).join(' · ')} 실행 중…`;
  const [agentOpen, setAgentOpen] = useState<string | null>(null), [trackerHidden, setTrackerHidden] = useState('');
  const openedAgent = agentList.find(item => item.id === agentOpen) ?? null;
  // A closed drawer stays mounted for its exit slide (showing the agent it last showed) while the thread widens back under it.
  const [leaving, setLeaving] = useState<SubAgent | null>(null), shownAgentRef = useRef<SubAgent | null>(null);
  useEffect(() => {
    if (openedAgent) { shownAgentRef.current = openedAgent; setLeaving(null); return; }
    const last = shownAgentRef.current; shownAgentRef.current = null;
    if (!last || calm()) return;
    setLeaving(last); const timer = setTimeout(() => setLeaving(null), 300); return () => clearTimeout(timer);
  }, [openedAgent]);
  const drawerAgent = openedAgent ?? leaving;
  const agentsValue = useMemo<AgentsValue>(() => ({ agents: new Map(agentList.map(item => [item.id, item])), colors: agentColors, opened: openedAgent?.id ?? null, waiting: waitingAgents, open: (key: string) => setAgentOpen(current => current === key ? null : key), stop: stopTask }), [agentList, agentColors, openedAgent?.id, waitingAgents]);
  // The tracker lists this request's subagents plus any still running from before; dismissed, it stays away until the next request (or a new one starts).
  const lastTurnKey = lastTurn?.[0]?.key ?? '';
  const tracked = useMemo(() => { const own = new Set(toolIds(lastTurn ?? [])); return agentList.filter(item => item.status === 'running' || own.has(item.id)); }, [agentList, lastTurn]);
  const showTracker = tracked.length > 0 && (runningAgents > 0 || trackerHidden !== lastTurnKey);
  const [paneWidth, setPaneWidth] = useState(0), paneRef = useRef<HTMLElement>(null);
  useEffect(() => { const el = paneRef.current; if (!el || typeof ResizeObserver !== 'function') return; const observer = new ResizeObserver(([entry]) => setPaneWidth(Math.round(entry.borderBoxSize[0].inlineSize))); observer.observe(el); return () => observer.disconnect(); }, []);
  // Border box, not contentRect: the docked drawer's padding-right shrinks the content box, which would flip it back to "over" and loop.
  // Wide enough: the drawer sits beside the thread; narrower, it covers the thread's right side.
  const drawerDocked = paneWidth >= 760, drawerWidth = drawerDocked ? Math.round(Math.min(460, paneWidth * 0.42)) : Math.min(440, Math.max(0, paneWidth - 24));
  // What the running turn is doing right now, for the status row under it ('' = thinking).
  const activityLabel = useMemo(() => {
    if (!busy || !lastTurn) return '';
    if (view.approvals.length) return view.approvals.every(item => item.questions?.length) ? '답변을 기다리는 중' : view.approvals.some(item => item.tool === 'ExitPlanMode' || item.tool === '계획 승인') ? '계획 검토를 기다리는 중' : '승인을 기다리는 중';
    for (let at = lastTurn.length - 1; at >= 0; at--) {
      const item = lastTurn[at];
      if (item.kind === 'assistant') {
        if (item.sub) continue;
        const block = item.blocks[lastIndexWhere(item.blocks, shownBlock)];
        if (!block) continue;
        if (block.type === 'tool_use' && isAgentTool(block.name) && runningAgents) return runningLabel;
        if (block.type === 'tool_use') return view.results[block.id] ? (runningAgents ? runningLabel : '') : `${block.name} ${block.partial ? '준비 중' : '실행 중'}…`;
        if (block.type === 'text' && !block.partial && runningAgents) return runningLabel;
        if (block.type === 'thinking') return '';
        return block.partial ? '응답을 작성하는 중…' : '';
      }
      if (item.kind === 'user') { const slash = parseChatSlashCommand(item.text); return slash?.name ? `/${slash.name} 실행 중…` : ''; }
    }
    return '';
  }, [busy, lastTurn, view.approvals.length, view.results, runningAgents, runningLabel]);
  const hiddenAgents = useHiddenAgents(ctx.settings.agentsOff);
  // The switcher lists the current provider plus every visible one; with nobody to switch to, it is not shown at all.
  const providers = (['claude', 'codex', 'cursor'] as const).filter(item => item === agent || !hiddenAgents.includes(item));
  const empty = view.ready && !shown.length && !busy;
  const startScreen = empty || providerSwap;
  const turnError = lastTurn?.some(item => item.kind === 'error');
  const otherCursorOptions = agent === 'cursor' ? cursorOptions.filter(option => !isCursorEffort(option)) : [];
  // Cursor models can come with many options: from two on (besides model and Effort) they all live behind one settings button.
  const forcePanel = otherCursorOptions.length >= 2;
  const modeDd = <Dropdown labelOnlyTip locked={locked} label="권한 모드" className={`chat-mode${hint === 'keymode' ? ' hint-anchor' : ''}`} value={state.permissionMode} options={modes.map(mode => ({ value: mode, label: permissionLabel(mode, agent), icon: MODE_ICONS[mode] ?? 'tune', color: permissionModeColor(mode) }))} onChange={mode => { void setChat({ id, permissionMode: mode }).then(pickedBy('keymode'), ctx.fail); if (agent === 'codex' && mode === 'auto' && busy) note('자동 승인은 진행 중인 응답이 끝난 뒤 다음 응답부터 적용됩니다. (Bypass는 바로 적용됩니다)'); }} />;
  const sandboxDd = <>{agent === 'codex' && caps?.sandboxes?.length ? <Dropdown labelOnlyTip locked={locked} label="샌드박스" className="chat-mode chat-sandbox" value={sandboxKey(state.sandbox, state.network)} options={sandboxOptions} onChange={key => { const [sandbox, network] = sandboxFromKey(key); void setChat({ id, sandbox, network }).catch(ctx.fail); }} /> : null}{agent === 'cursor' && caps?.sandboxes?.length ? <Dropdown labelOnlyTip locked={locked} label="샌드박스" className="chat-mode chat-sandbox" value={state.sandbox ?? 'follow'} options={cursorSandboxOptions} onChange={key => { void setChat({ id, sandbox: key === 'follow' ? null : key }).catch(ctx.fail); }} /> : null}</>;
  const bypassBtn = agent === 'cursor' && caps?.runEverything ? <button type="button" className="chat-switch run-everything" aria-pressed={state.runEverything === true} aria-label="Run Everything" disabled={Boolean(locked)} title={locked || '명령 실행 확인 생략'} onClick={() => { void setChat({ id, runEverything: !state.runEverything }).catch(ctx.fail); }}>Bypass</button> : null;
  const noteItems = <>{agent === 'cursor' && state.restartPending && <span className="chat-foot-note locked" role="status">샌드박스: 다음 응답부터 적용</span>}{!empty && state.addDirs.length > 0 && <span className="chat-foot-note" title={state.addDirs.join('\n')}>폴더 +{state.addDirs.length}</span>}</>;
  const effortCtl = <>{effortOptions.length > 0 && <span className="effort-wrap"><Dropdown labelOnlyTip locked={locked} label="Effort" className={`chat-effort effort-${effortLevel(state.effort) || 'medium'}${hint === 'keyeffort' ? ' hint-anchor' : ''}`} value={state.effort ?? (effortOptions.includes('medium') ? 'medium' : '')} placeholder="Effort" options={effortOptions.map(item => ({ value: item, label: effortLabel(item), ...effortStyle[effortLevel(item)] }))} onChange={effort => void chooseEffort(effort).then(pickedBy('keyeffort'), ctx.fail)} /><EffortSparks level={effortLevel(state.effort) || 'medium'} /></span>}</>;
  const optionItems = <>{cursorOptions.filter(isCursorSwitch).map(option => <button type="button" key={option.id} className={`chat-switch${option.id === 'fast' ? ' fast' : ''}`} aria-pressed={option.currentValue === 'true'} disabled={Boolean(locked)} title={locked || undefined} onClick={() => setOption(option.id, option.currentValue === 'true' ? 'false' : 'true')}>{option.id === 'fast' ? 'Fast' : option.name}</button>)}{maxOption && <button type="button" className="chat-max" aria-pressed={maxSelected(maxOption)} disabled={Boolean(locked)} title={locked || '최대 컨텍스트'} onClick={() => setOption(maxOption.id, maxSelected(maxOption) ? maxOffValue(maxOption) : maxOnValue(maxOption))}>MAX</button>}{!maxOption && maxContext && <button type="button" className="chat-max" aria-pressed={contextOption?.currentValue === maxContext.on} disabled={Boolean(locked)} title={locked || '이 모델의 최대 컨텍스트'} onClick={() => setOption(contextOption!.id, contextOption?.currentValue === maxContext.on ? maxContext.off : maxContext.on)}>MAX</button>}{cursorOptions.filter(option => !isCursorSwitch(option) && !isCursorEffort(option) && !(maxOption && option.id === maxOption.id)).map(option => { const name = cursorSettingName(option); return <span key={option.id}><Dropdown locked={locked} label={name} className="chat-model-config" value={option.currentValue} placeholder={name} options={option.options.map(item => ({ value: item.value, label: `${name}: ${item.name}`, hint: item.description }))} onChange={value => setOption(option.id, value)} /></span>; })}</>;
  const hasMore = forcePanel || Boolean(bypassBtn) || (!empty && state.addDirs.length > 0) || (agent === 'cursor' && state.restartPending) || cursorOptions.some(option => isCursorSwitch(option) || (!isCursorEffort(option) && !(maxOption && option.id === maxOption.id))) || Boolean(maxOption || maxContext);
  const panelItems = <>{bypassBtn}{optionItems}{noteItems}</>;
  const tuneButton = <span className={`tune-wrap${forcePanel ? ' forced' : ''}${hasMore ? ' more' : ''}`}>
    <button type="button" className="chat-tune" popoverTarget={tunePanel} aria-label="채팅 옵션" title="채팅 옵션">
      <span className="tune-ico"><SettingGlyph icon="tune" size={15} /></span>
      {agent === 'cursor' && state.runEverything && <span className="tune-ico" style={{ color: 'var(--sandbox-full)' }}><SettingGlyph icon="lock_open" size={15} /></span>}
      {cursorOptions.filter(isCursorSwitch).filter(option => option.currentValue === 'true').map(option => <span className="tune-ico" key={option.id}><SettingGlyph icon={option.id === 'fast' ? 'bolt' : 'toggle_on'} size={15} /></span>)}
      {((maxOption && maxSelected(maxOption)) || (!maxOption && maxContext && contextOption?.currentValue === maxContext.on)) && <span className="tune-ico" style={{ color: '#f2566e' }}><SettingGlyph icon="local_fire_department" size={15} /></span>}</button>
    <div id={tunePanel} popover="auto" className="chat-tune-panel" role="dialog" aria-label="채팅 옵션" onToggle={event => placeAbove(event, 'right')}>{panelItems}</div>
  </span>;
  const chatTheme = themeById(ctx.settings.theme);
  const chatDark = ctx.settings.chatDarker && chatTheme.scheme === 'dark' && chatTheme.id !== 'dark' ? chatDarkVars(chatTheme.vars) : undefined;
  return <ChatUiContext.Provider value={uiBlocks}><SetDiffLayoutContext.Provider value={setDiffLayout}><CwdContext.Provider value={state.cwd ?? ''}><AwaitingContext.Provider value={awaiting}><DeniedContext.Provider value={view.denied ?? NO_DENIED}><AgentsContext.Provider value={agentsValue}><LocalCardsContext.Provider value={localCards}><section ref={paneRef} className={`terminal-pane chat-pane ${focused ? 'focused' : ''}`} data-chat-dark={chatDark ? '' : undefined} data-drawer={openedAgent ? (drawerDocked ? 'dock' : 'over') : undefined} data-feedback-region="채팅 pane" data-kind="chat" data-empty={startScreen || undefined} data-swap={providerSwap || undefined} data-agent={agent} data-agent-state={agentState} style={{ '--chat-font': `${ctx.settings.chatFontSize}px`, '--chat-width': chatWidths[ctx.settings.chatWidth], '--drawer-w': `${drawerWidth}px`, ...chatDark } as CSSProperties} onMouseDownCapture={() => onFocus(id)} onFocus={() => onFocus(id)}
    onDragEnter={event => { if (isFileDrag(event)) { event.preventDefault(); dragDepth.current++; setDropping(true); } }}
    onDragOver={event => { if (isFileDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropping(true); } }}
    onDragLeave={event => { if (isFileDrag(event) && --dragDepth.current <= 0) { dragDepth.current = 0; setDropping(false); } }}
    onDrop={event => { dragDepth.current = 0; setDropping(false); if (!event.dataTransfer.files.length) return; event.preventDefault(); void attach([...event.dataTransfer.files]); }}>
    <div className="chat-drop" data-on={dropping || undefined} aria-hidden="true"><div className="chat-drop-card"><span className="chat-drop-icon"><Icon name="plus" size={26} /></span><b>여기에 놓아 첨부</b><span>이미지는 그림으로, 그 밖의 파일은 경로(@)로 입력창에 붙여넣습니다</span></div></div>
    <div className="pane-tools" role="toolbar" aria-label="채팅 pane">
      {agent === 'claude' && ctx.settings.cacheTimer && view.state.cache && <CacheTimer cache={view.state.cache} working={view.state.status === 'working'} warn={ctx.settings.cacheWarn} />}
      <span className="pane-title" data-copy={view.state.sessionId ? '' : undefined} title={view.state.sessionId ? '세션 ID 복사' : undefined} onClick={() => view.state.sessionId && copyText(view.state.sessionId)}><span className="pane-mark"><Icon name={agent} size={12} /></span><span className="pane-label">{title || `${agentLabel} · ${basename(cwd.replace(/\\/g, '/'))}`}</span>
        {view.approvals.length > 0 && <span className="question-alert" role="img" aria-label="승인 필요" title="도구 실행 승인 대기"><Icon name="alert" size={12} /></span>}</span>
      <span className="pane-actions">
        {/* Buttons that cannot work right now are hidden, not dimmed. */}
        {view.state.sessionId && <IconButton icon="chart" tip="header" label="세션 통계 (/stats)" className={hint === 'stats' ? 'hint-anchor' : ''} onClick={() => { hintSeen('stats'); setStatsOpen(true); }} />}
        {view.state.status === 'idle' && <IconButton icon="terminal" tip="header" label={view.state.sessionId ? '터미널로 전환 (같은 세션 이어가기)' : '터미널로 전환 (새 터미널 열기)'} className={hint === 'tocli' ? 'hint-anchor' : ''} onClick={() => { hintSeen('tocli'); ctx.toTerminal(id, !view.state.sessionId); }} />}
        {(view.state.status === 'idle' || (agent === 'claude' && view.state.sessionId)) && <i className="pane-sep" aria-hidden="true" />}
        <IconButton icon="plus" tip="header" label="새 대화 (/clear)" onClick={() => void resetChat().catch(ctx.fail)} />
        <SplitButton onSplit={direction => onSplit(id, direction)} />
        <IconButton icon={zoomed ? 'minimize' : 'maximize'} tip="header" label={zoomed ? '원래 크기로' : '최대화'} action="zoom" onClick={() => onZoom(id)} />
        <IconButton icon="x" label="채팅 닫기" onClick={() => ctx.onClose(id)} /></span></div>
    {/* 둘러보기(projectId 'tour')는 연습 화면이라 실제 CLI 업데이트 안내·실행 버튼을 띄우지 않는다. */}
    {(agent === 'claude' || agent === 'codex') && ctx.projectId !== 'tour' && <CliUpdateNotice agent={agent} />}
    <div className="chat-scroll" ref={scroller} onScroll={onScroll} onWheel={event => { readingTool.current = false; if (event.deltaY < 0) release(); }} onTouchMove={() => { readingTool.current = false; release(); }}
      onClick={event => { if ((event.target as HTMLElement).closest('.chat-tool-head[aria-expanded="false"], .chat-bundle-head[aria-expanded="false"]')) { readingTool.current = true; release(); } }}
      onKeyDown={event => { if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) readingTool.current = false; if (['PageUp', 'ArrowUp', 'Home'].includes(event.key)) release(); }} onPointerDown={event => { if (event.target === event.currentTarget) { readingTool.current = false; release(); } }}>
      {pin && <div className="chat-pin-wrap"><button type="button" className="chat-pin" aria-label="요청한 내용으로 이동" onClick={() => jumpToUser(pin.key)}><Icon name="arrowUp" size={14} /><span>{pin.text}</span></button></div>}
      <div className="chat-thread" ref={thread}>
        {openError && <div className="chat-msg error" role="alert"><Icon name="alert" size={14} /><span>{openError}</span></div>}
        {turns.map((items, index) => { const current = index === turns.length - 1; return <Turn key={items[0].key} items={items} agentIds={agentIds} settled={!current || !busy} working={current && busy} results={view.results} settings={ctx.settings} plainThinking={agent === 'claude'} onBranch={caps?.branch === false ? undefined : branch} onRewind={caps?.rewind === false ? undefined : rewind} onRecover={state.recoverable ? recoverSession : undefined} recovering={recovering} />; })}
        {!empty && <ChatStatusRow active={busy} effort={state.effort} tokens={view.thinkingTokens} label={view.reconnecting ? 'Cursor 연결이 잠깐 끊겨 이어서 재시도하는 중…' : view.compacting ? '컨텍스트를 압축하는 중… 대화가 길수록 오래 걸립니다' : activityLabel || (state.configuring ? '설정을 적용하는 중' : '')} />}
        {view.steers.map(item => <div className="chat-msg user" key={item.uuid}><UserImages previews={item.previews} count={item.images} /><UserMessageBubble text={item.text} className="steer" markdown={false}><small className="chat-steer">{caps?.cancelSteer === false ? '스티어링 · 반영 대기 중' : '스티어링 · ↑ 수정 · Esc 바로 보내기'}</small><span className="chat-bubble-plain">{item.text}</span></UserMessageBubble></div>)}
        {state.error && state.status === 'idle' && !turnError && <ChatErrorAlert message={state.error} recoverable={state.recoverable} recovering={recovering} onRecover={state.recoverable ? recoverSession : undefined} />}
      </div>
    </div>
    {hint === 'keymodel' && <Hint title="모델은 단축키로도 바꿀 수 있어요" text={<>입력창에서 <kbd>{showCombo(chatKey(ctx.settings.chatKeys, 'modelNext'))}</kbd>·<kbd>{showCombo(chatKey(ctx.settings.chatKeys, 'modelPrev'))}</kbd>로 다음·이전 모델로 넘어가요.</>} onDone={() => hintSeen('keymodel')} />}
    {hint === 'keyeffort' && <Hint title="Effort도 단축키로 바꿀 수 있어요" text={<>입력창에서 <kbd>{showCombo(chatKey(ctx.settings.chatKeys, 'effortUp'))}</kbd>로 올리고 <kbd>{showCombo(chatKey(ctx.settings.chatKeys, 'effortDown'))}</kbd>로 내려요.</>} onDone={() => hintSeen('keyeffort')} />}
    {hint === 'keymode' && <Hint title="권한 모드도 단축키로 바꿀 수 있어요" text={<>입력창에서 <kbd>{showCombo('shift+tab')}</kbd>을 누를 때마다 다음 모드로 넘어가요.</>} onDone={() => hintSeen('keymode')} />}
    {hint === 'keystash' && <Hint wide title="쓰던 입력은 보관해 둘 수 있어요" text={<>지우는 대신 <kbd>{showCombo(chatKey(ctx.settings.chatKeys, 'stash'))}</kbd>로 보관하고, 다른 요청을 보낸 뒤 <kbd>{showCombo(chatKey(ctx.settings.chatKeys, 'stash'))}</kbd>로 다시 꺼내요.</>} onDone={() => hintSeen('keystash')} />}
    {hint === 'tocli' && <Hint title="언제든 CLI로 전환할 수 있어요" text="이 버튼을 누르면 지금 대화를 터미널(CLI)에서 그대로 이어가요. 익숙한 CLI 화면이 필요할 때 써 보세요." onDone={() => hintSeen('tocli')} />}
    {hint === 'stats' && <Hint title="이번 세션의 통계를 볼 수 있어요" text="토큰·비용·도구 사용과 컨텍스트가 어떻게 늘었는지 이 버튼에서 한눈에 확인해요." onDone={() => hintSeen('stats')} />}
    {statsOpen && <ChatStatsModal id={id} call={ctx.call} costUsd={state.costUsd} onClose={() => setStatsOpen(false)} />}
    {resumeOpen && <ResumeModal agent={agent} exclude={id} call={ctx.call} onClose={() => setResumeOpen(false)} onPick={choice => void pickResume(choice)} />}
    {modelsOpen && <ModelsModal current={modelValue(selectedModel, aliases)} call={ctx.call} agent={agent} id={id} fallback={catalog} aliases={aliases} settings={ctx.settings} onSettingsChange={ctx.onSettingsChange} onClose={() => setModelsOpen(false)} onPick={value => { setModelsOpen(false); void chooseModel(value).catch(ctx.fail); }} />}
    <div className="chat-start-slot chat-greeting" inert={!startScreen} aria-hidden={!startScreen}>
      <div><div className="chat-empty"><h2><span className="chat-empty-mark"><Icon name={agent} size={32} /></span><span className="chat-empty-text">{greeting.split(/(?<=[.?!])\s+/).map(line => <span key={line}>{line}</span>)}</span></h2></div></div>
    </div>
    <div className="chat-dock">
      {away && <button type="button" className="chat-jump" aria-label="맨 아래로 이동" onClick={jumpToEnd}><Icon name="arrowDown" size={16} /></button>}
      {showTracker && <AgentTracker list={tracked} colors={agentColors} opened={openedAgent?.id ?? null} waiting={waitingAgents} onOpen={key => setAgentOpen(current => current === key ? null : key)} onHide={() => setTrackerHidden(lastTurnKey)} />}
      {view.approvals.map(approval => <ApprovalCard key={approval.requestId} approval={approval} modes={modes} settings={ctx.settings} claude={agent === 'claude'} trust={agent === 'codex' ? undefined : entry => ctx.onSettingsChange({ ...ctx.settings, mcpTrust: { ...ctx.settings.mcpTrust, [agent]: addTrust(ctx.settings.mcpTrust[agent], entry) } })} asker={agentsValue.agents.get(askingAgents.get(approval.requestId) ?? '')} askerColor={agentColors.get(askingAgents.get(approval.requestId) ?? '')} onAnswer={(allow, always, answers, extra) => answer(approval, allow, always, answers, extra)} onInterrupt={() => interrupt()} />)}
      {!view.approvals.length && asyncQuestions.length > 0 && <QuestionCard key={asyncQuestions[0].id} questions={asyncQuestions} submitting={sendingQuestion} onAnswer={answerAsyncQuestion} />}
      {agent === 'claude' && view.approvals.length === 0 && view.blocked && <BlockedCard items={Object.values(view.blocked)} onAllow={allowBlocked} />}
      {queue.length > 0 && <div className="chat-queue"><div role="status">{sendQueueLabel(queue)}</div>
        <ol>{queue.map((item, index) => <li key={index}><span>{item.text}</span><UserImages previews={item.images.map(image => image.url)} count={item.images.length} /><IconButton icon="x" label={`대기 메시지 취소: ${item.text}`} size={12} onClick={() => setQueue(items => items.filter((_, i) => i !== index))} /></li>)}</ol></div>}
      {/* On the start screen only the usage item stays (API Usage / Plan Usage), where the meter sits once the chat has turns. */}
      <div className="chat-status-slot"><div><ChatStatusLine settings={ctx.settings} context={{ state, share }} only={empty ? ['share'] : undefined} onSettings={() => ctx.onOpenSettings(agent)} onAuth={auth => void setChat({ id, auth }).catch(ctx.fail)} /></div></div>
      {/* While a card waits for an answer (plan, permission, question) the card is the input: the composer steps aside and comes back as it was. */}
      <div ref={composer} className={`chat-composer${hint === 'keystash' ? ' hint-anchor' : ''}`} hidden={view.approvals.length > 0} data-compact={oneLine || undefined} data-shell={isShellDraft(text) || undefined} data-feedback-region="채팅 입력창">
        {matches.length > 0 && <ul className="chat-commands" role="listbox" aria-label="슬래시 명령">{matches.map((item, index) => <li key={item.name} role="option" aria-selected={index === menuAt}>
          <button type="button" tabIndex={-1} onMouseDown={event => { event.preventDefault(); complete(item.name); }}>
            <span className="chat-command-head"><b>/{item.name}</b>{item.hint && <code className="chat-command-hint">{item.hint}</code>}</span>
            {item.description && <span className="chat-command-desc">{item.description}</span>}
          </button></li>)}</ul>}
        {mentions.length > 0 && <ul className="chat-commands" role="listbox" aria-label="파일 언급">{mentions.map((file, index) => <li key={file} role="option" aria-selected={index === menuAt}>
          <button type="button" tabIndex={-1} onMouseDown={event => { event.preventDefault(); pickMention(file); }}>
            <FileIcon name={file.replace(/\/$/, '').split('/').pop()!} folder={file.endsWith('/')} size={16} />
            <span className="chat-command-head"><b>{file.replace(/\/$/, '').split('/').pop()}{file.endsWith('/') ? '/' : ''}</b></span>
            <span className="chat-command-desc">{file.replace(/[^/]*\/?$/, '')}</span>
          </button></li>)}</ul>}
        {isShellDraft(text) && <p className="chat-command-args chat-shell-mode" role="status"><code>!</code><span>셸 모드: {ctx.settings.chatSendKey === 'mod-enter' ? 'Cmd/Ctrl+Enter' : 'Enter'}로 터미널 명령어 실행</span></p>}
        {commandDraft && <p className="chat-command-args stacked" role="status"><code>{commandDraft.hint}</code>{commandDraft.description ? <span>{commandDraft.description}</span> : null}</p>}
        {shrinking > 0 && <div className="chat-attachments"><span className="chat-shrinking" role="status"><i className="chat-spin" aria-hidden="true" />이미지를 5MB 아래로 줄이는 중…</span></div>}
        {images.length > 0 && <AttachmentStrip images={images} onOpen={setBigImage} onRemove={index => setImages(items => items.filter((_, i) => i !== index))} />}
        {bigImage && <Modal className="image-modal" labelledBy={`image-modal-${id}`} region="이미지 크게 보기" onClose={() => setBigImage(null)}><span className="image-modal-frame"><img id={`image-modal-${id}`} src={bigImage} alt="첨부 이미지 크게 보기" onClick={() => setBigImage(null)} /><IconButton icon="x" label="닫기" onClick={() => setBigImage(null)} /></span></Modal>}
        <div className="chat-input-row">
        <div className={`chat-input-field${commandHead ? ' has-command' : ''}`}>
        {commandHead && <div className="chat-input-mirror" aria-hidden ref={inputMirror}><span className="chat-input-command">{commandHead}</span>{`${text.slice(commandHead.length)} `}</div>}
        <textarea ref={box} rows={1} value={shownDraft(text)} onScroll={event => { if (inputMirror.current) inputMirror.current.scrollTop = event.currentTarget.scrollTop; }} placeholder={oneLine && busy && !stash ? (foldIn ? '응답 중 · 입력해 끼워 넣기' : agent === 'cursor' ? '응답을 끊고 바로 보내기' : '응답이 끝나면 순서대로 보냅니다') : stash ?`보관된 입력이 있습니다 (${showCombo(chatKey(ctx.settings.chatKeys, 'stash'))}로 복원)` : busy ? foldIn ? `${ctx.settings.chatSendKey === 'mod-enter' ? 'Cmd/Ctrl+Enter' : 'Enter'}: 지금 끼워 넣기 · Tab: 끝난 뒤 보내기` : agent === 'cursor' ? 'Enter: 응답을 끊고 바로 보내기 · Tab: 끝난 뒤 보내기' : '응답이 끝난 뒤 순서대로 전송합니다' : '작업을 설명하거나 질문하세요 · !명령으로 셸 실행'} aria-label="메시지 입력" disabled={!view.ready && !openError}
          onFocus={() => { if (!autoFocus.current) setCompact(false); }} onBlur={compactLater} onPointerDown={() => setCompact(false)}
          onChange={event => { const next = shellBang(text) + event.target.value; if (!stash && text.trim().length >= 20 && !event.target.value.trim()) setPicked('keystash'); setText(next); setCaret(event.target.selectionStart + shellBang(next).length); }} onSelect={event => setCaret(event.currentTarget.selectionStart + shellBang(text).length)}
          onPaste={event => { const files = [...event.clipboardData.files]; if (files.some(file => file.type.startsWith('image/'))) { event.preventDefault(); void attach(files); } }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            const modSend = ctx.settings.chatSendKey === 'mod-enter';
            const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
            const combo = comboOf(event.nativeEvent), keyOf = (id: Parameters<typeof chatKey>[1]) => combo === chatKey(ctx.settings.chatKeys, id);
            // Shell mode with nothing after the `!`: one more `!` or one Backspace takes the `!` back and leaves shell mode.
            if (shellBang(text) && !shownDraft(text) && (event.key === 'Backspace' || (event.key === '!' && !event.ctrlKey && !event.metaKey && !event.altKey))) { event.preventDefault(); setText(''); return; }
            if (keyOf('effortUp') || keyOf('effortDown')) { event.preventDefault(); if (!effortOptions.length) return; hintSeen('keyeffort'); const step = keyOf('effortUp') ? 1 : -1, at = effortOptions.indexOf(state.effort ?? 'medium'); const effort = effortOptions[Math.max(0, Math.min(effortOptions.length - 1, at + step))]; if (effort !== state.effort) void setChat({ id, effort }).catch(ctx.fail); return; }
            if (keyOf('modelNext') || keyOf('modelPrev')) { event.preventDefault(); hintSeen('keymodel'); const values = optionsForModel(selectedModel).map(option => option.value).filter(value => value !== MORE_MODELS), current = modelValue(selectedModel, aliases), next = values[(values.indexOf(current) + (keyOf('modelNext') ? 1 : values.length - 1)) % values.length]; if (next) void setChat({ id, model: next }).catch(ctx.fail); return; }
            if (keyOf('stash')) { event.preventDefault(); hintSeen('keystash'); if (text.trim()) { setStash(text); setText(''); } else if (stash) { setText(stash); setStash(''); } return; }
            // One Esc does every composer role at once: close slash and @ menus, stop a running turn, then leave the field.
            if (event.key === 'Escape' && plain) {
              event.preventDefault();
              if (slashQuery) setSlashOff(true);
              if (mentionAt >= 0) setMentionOff(mentionAt);
              event.currentTarget.closest('.chat-composer')?.querySelectorAll('details[open]').forEach(node => { (node as HTMLDetailsElement).open = false; });
              if (busy) interrupt(view.steers.length > 0 && caps?.cancelSteer !== false);
              event.currentTarget.blur();
              return;
            }
            if (event.key === 'Tab' && event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) { event.preventDefault(); hintSeen('keymode'); void setChat({ id, permissionMode: agent === 'claude' ? nextMode(state.permissionMode) : cycleMode(modes, state.permissionMode) }).catch(ctx.fail); return; }
            if (matches.length) {
              if (plain && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setMenuAt(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length); return; }
              // Enter on a command typed out in full that takes no argument (/usage, /cost…) runs it at once instead of only completing it.
              const exact = event.key === 'Enter' && !event.shiftKey && !event.altKey && (!modSend || event.metaKey || event.ctrlKey) && matches[menuAt].name === slash?.[1] && !matches[menuAt].hint;
              if (!exact && plain && (event.key === 'Tab' || event.key === 'Enter')) { event.preventDefault(); complete(matches[menuAt].name); return; }
            }
            if (mentions.length) {
              if (plain && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setMenuAt(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + mentions.length) % mentions.length); return; }
              if (plain && (event.key === 'Tab' || event.key === 'Enter')) { event.preventDefault(); pickMention(mentions[Math.min(menuAt, mentions.length - 1)]); return; }
            }
            if (event.key === 'Tab' && plain && busy && ctx.settings.followUpQueue && (text.trim() || images.length)) { event.preventDefault(); void submit('queue'); return; }
            if (event.key === 'ArrowUp' && event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && !event.repeat && !text && !images.length && !shrinking) {
              const last = queue.at(-1);
              if (last && !last.now) {
                event.preventDefault();
                setQueue(items => items.filter(item => item !== last));
                setRecall(null);
                setText(last.draft ?? (isShellDraft(last.text) ? `\\${last.text}` : last.text));
                setImages(last.images);
                return;
              }
            }
            // A line led by a command this chat knows (`commandHead`; `/file/name` is a path, not a command) is one line: typed line breaks and Tab's focus move are blocked (pasted newlines still go in).
            if (event.key === 'Tab' && plain && commandHead) { event.preventDefault(); return; }
            if (event.key === 'Enter' && !event.shiftKey && !event.altKey && (!modSend || event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
            else if (event.key === 'Enter' && commandHead) event.preventDefault();
            // ↑ with nothing typed takes the last steering message back; otherwise ↑/↓ walk the sent messages (the draft is kept aside and ↓ past the newest brings it back).
            else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && plain) {
              const field = event.currentTarget, up = event.key === 'ArrowUp';
              if (up && !text && view.steers.length && caps?.cancelSteer !== false) { event.preventDefault(); void ctx.call('chat/cancel-steer', { id }).catch(ctx.fail); return; }
              const sent = shown.flatMap(item => item.kind === 'user' ? [item.text] : []);
              if (field.selectionStart !== field.selectionEnd || !(up ? !field.value.slice(0, field.selectionStart).includes('\n') : recall && !field.value.slice(field.selectionEnd).includes('\n'))) return;
              const at = up ? (recall ? recall.at - 1 : sent.length - 1) : recall ? recall.at + 1 : -1;
              if (!sent.length || at < 0 || (!up && !recall)) return;
              event.preventDefault();
              const draft = recall?.draft ?? text, next = at >= sent.length ? draft : sent[at];
              setRecall(at >= sent.length ? null : { at, draft }); setText(next);
              requestAnimationFrame(() => { const end = shownDraft(next).length; field.setSelectionRange(end, end); });
            }
          }} />
        </div>
        </div>
      <div className="chat-foot" ref={setFoot} data-fit="0">
        <button type="button" className="chat-attach" title="이미지 · 파일 첨부" aria-label="첨부" onClick={() => void ctx.pick('무엇을 첨부할까요?', [{ id: 'image', label: '이미지', icon: 'image', detail: 'PNG·JPEG·GIF·WebP. 5MB를 넘으면 조금 줄여 보냅니다' }, { id: 'file', label: '파일', icon: 'file', detail: '경로(@)를 넣어 에이전트가 직접 읽게 합니다' }]).then(choice => { if (choice === 'image') imageInput.current?.click(); else if (choice === 'file') fileInput.current?.click(); })}><Icon name="plus" size={16} /></button>
        <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={event => { void attach([...(event.target.files ?? [])]); event.target.value = ''; }} />
        <input ref={fileInput} type="file" multiple hidden onChange={event => { void attach([...(event.target.files ?? [])]); event.target.value = ''; }} />
        <span className="fit-mode">{modeDd}{sandboxDd}</span>{bypassBtn && !forcePanel && <span className="fit-inline">{bypassBtn}</span>}<span className="fit-note">{noteItems}</span>
        <span className="drag-space" />
        {agent === 'cursor' ? <button type="button" className="chat-model cursor-model" disabled={Boolean(locked)} title={locked || '모델'} aria-haspopup="dialog" aria-label="모델 선택" onClick={() => setModelsOpen(true)}><span className="dd-label" style={{ color: modelAppearance(selectedModel, agent).color }}>{displayModel(selectedModel, agent)}</span><Icon name="chevronDown" size={14} /></button> : <Dropdown labelOnlyTip label="모델" className={`chat-model${hint === 'keymodel' ? ' hint-anchor' : ''}`} value={resolvedModelValue} options={modelChoices} onChange={model => { if (model === MORE_MODELS) setModelsOpen(true); else void chooseModel(model).then(pickedBy('keymodel'), ctx.fail); }} />}
        {effortCtl}{!forcePanel && <span className="fit-inline">{optionItems}</span>}{tuneButton}
        <ContextRing state={state} ctx={ctx} active={visible} agent={agent} chatId={id} />
        {busy ? <button type="button" className="chat-send stop" title="중단 (Esc)" aria-label="응답 중단" onClick={() => interrupt()}><Icon name="stop" size={16} /></button>
          : <button type="button" className="chat-send" title="보내기 (Enter)" aria-label="보내기" disabled={!view.ready || (!text.trim() && !images.length)} onClick={() => void submit()}><Icon name="arrowUp" size={16} /></button>}
      </div>
      </div>
      <div className="chat-start-slot" inert={!startScreen} aria-hidden={!startScreen}><div>
        <button type="button" className="chat-resume" disabled={!view.ready || resuming || busy} onClick={() => void resume()}><Icon name="refresh" size={16} />{resuming ? '불러오는 중…' : '이전 대화 불러오기'}</button></div></div>
    </div>
    <div className="chat-bottom-space" aria-hidden="true" />
    {providers.length > 1 && <div className="chat-start-slot chat-provider-slot" inert={!startScreen} aria-hidden={!startScreen}><div>
      <div className="chat-providers" role="group" aria-label="Provider 전환">{providers.map(item => <button type="button" key={item} className="chat-provider" aria-pressed={item === agent} disabled={!view.ready || busy || providerSwap} onClick={() => { if (item === agent || providerSwap) return; setProviderSwap(true); void ctx.switchAgent(id, item, !view.items.length).then(done => { if (!done) setProviderSwap(false); }); }}><Icon name={item} size={14} />{PROVIDER_LABELS[item]}</button>)}</div>
    </div></div>}
    {drawerAgent && <AgentDrawer agent={drawerAgent} closing={!openedAgent} list={agentList} colors={agentColors} results={view.results} settings={ctx.settings} docked={drawerDocked} onPick={setAgentOpen} onStop={stopTask} onClose={() => setAgentOpen(null)} />}
  </section></LocalCardsContext.Provider></AgentsContext.Provider></DeniedContext.Provider></AwaitingContext.Provider></CwdContext.Provider></SetDiffLayoutContext.Provider></ChatUiContext.Provider>;
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
function ChatStatusRow({ active, effort, tokens, label }: { active: boolean; effort: string | null; tokens: number; label: string }) {
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
  // The red rises in 10% steps every 5 s, not 2% every second: each change restarts the label's .6s colour transition, which repainted the row nearly nonstop.
  const deep = active && !label && thinking >= 8, red = Math.min(100, Math.max(0, Math.floor((thinking - 8) / 5) * 10));
  return <div className="chat-status-row" data-active={active || undefined} aria-hidden={!active}>
    <div><div className={`chat-working${deep ? ' deep' : ''}`} role="status" style={deep ? { color: `color-mix(in srgb, var(--error) ${red}%, var(--muted))` } : !label && effort && effortStyle[effortLevel(effort)] ? { color: effortStyle[effortLevel(effort)].color } : undefined}>
      <i className="chat-spin" /><span className="chat-working-label">{label || (deep ? `${effort ? `${effortLabel(effort)} Effort로 ` : ''}깊게 생각하는 중…` : '생각하는 중…')}</span>
      <small>{duration(seconds * 1000)}{tokens > 0 && ` · 약 ${compact(tokens)} 토큰`}</small></div></div>
  </div>;
}

// The ring beside the model: how full the context window is (green to red like the status line's usage items). Clicking opens the popover with the context
// reading and the plan's usage limits, the same readings as the status bar's Claude usage.
function ContextRing({ state, ctx, active, agent, chatId }: { state: ChatState; ctx: ChatCtx; active: boolean; agent: 'claude' | 'codex' | 'cursor'; chatId: string }) {
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
  const ringTitle = !supported ? '컨텍스트 사용량 미제공'
    : waiting ? '컨텍스트 집계 대기'
    : `${compacting ? `Auto Compact ${percent}% · 창 ${compact(gauge.basis)}` : `컨텍스트 ${percent}%`}`;
  return <>
    <button type="button" className={`chat-ring${compacting ? ' auto-compact' : ''}${waiting ? ' pending' : ''}`} popoverTarget={panel} aria-label={waiting ? '컨텍스트 대기 · 상세 보기' : `${basisLabel} · 상세 보기`} onClick={() => void load(true)}>
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <circle cx="14" cy="14" r={radius} className="track" />
        {shown && compacting && gauge.used > 0 && <circle cx="14" cy="14" r={radius} className="max-hint" strokeDasharray={`${Math.max(1.5, length * Math.min(100, Math.round(gauge.used * 100 / gauge.max)) / 100)} ${length}`} transform="rotate(-90 14 14)" />}
        {shown && percent > 0 && <circle cx="14" cy="14" r={radius} className="fill" style={{ stroke: ink }} strokeDasharray={`${Math.max(1.5, length * Math.min(100, percent) / 100)} ${length}`} transform="rotate(-90 14 14)" />}
        {shown && <text x="14" y="14" textAnchor="middle" dominantBaseline="central" fill={ink}>{percent}</text>}</svg></button>
    <div id={panel} popover="auto" className="usage-detail chat-usage" role="dialog" aria-label="컨텍스트와 사용 한도" onToggle={event => placeAbove(event, 'right')}>
      <header><strong>컨텍스트</strong>{compacting && <span className="auto-compact-badge">Auto Compact</span>}</header>
      <div className="usage-row">
        <div><span>{waiting ? '아직 보고된 사용량이 없습니다' : `${compact(gauge.used)} / ${compact(gauge.basis)} 토큰`}</span><b className={settings.usageColors ? 'graded' : ''} style={settings.usageColors ? usageHueStyle(percent) : undefined}>{waiting ? '—' : `${percent}%`}</b></div>
        {shown && <progress className={settings.usageColors ? 'graded' : ''} style={settings.usageColors ? usageHueStyle(percent) : undefined} value={Math.min(100, percent)} max={100} aria-label={compacting ? 'Auto Compact 창 사용률' : '컨텍스트 사용률'} />}
      </div>
      {compacting && <p className="usage-note auto-compact-detail">
        {percent > 100 ? '창을 넘었습니다. ' : ''}창 {compact(gauge.basis)}, 최대 {compact(gauge.max)}. 가득 차기 전에 자동으로 요약합니다.
      </p>}
      <header className="chat-usage-title"><strong>사용 한도</strong>{usage?.plan && <span className="plan">{usage.plan}</span>}
        <button type="button" className="icon-btn" aria-label="사용 한도 새로고침" aria-busy={loading} onClick={() => void load(true)}><Icon name="refresh" size={13} /></button></header>
      {usage ? <UsageRows windows={windows} colors={settings.usageColors} /> : <p className="usage-note">{loading ? '불러오는 중…' : '표시할 한도 정보가 없습니다.'}</p>}
      {usage?.error && <p className="usage-note warn">{usage.error}</p>}
    </div>
  </>;
}
