// What the chat tab knows about one conversation, built from the events the local server streams (apps/local-server/src/chat-claude.js).
// Pure functions only, so tests/chat-model.test.mjs can load this file through Node's type stripping.

export type Tokens = { input: number; output: number; cacheRead: number; cacheCreate: number };
export type ModelConfigOption = { id: string; name: string; description?: string; category?: string; type: 'select'; currentValue: string; options: { value: string; name: string; description?: string }[] };
export type ChatCapabilities = { configOptions?: ModelConfigOption[]; images: boolean; steer: boolean; cancelSteer: boolean; branch: boolean; rewind: boolean; worktree: boolean; addDirs: boolean; terminal: boolean; terminalToChat: boolean; cost: boolean; tokens: boolean; context: boolean; permissionModes: string[]; efforts: string[]; catalog: CatalogModel[]; limitations: Record<string, string> };
export type AutoCompact = { window: number; maxWindow: number; auto: boolean; source?: string };
export type ChatState = {
  agent?: 'claude' | 'codex' | 'cursor'; capabilities?: ChatCapabilities;
  status: 'idle' | 'working' | 'attention' | 'closed'; model: string | null; effort: string | null; worktree: boolean; addDirs: string[]; permissionMode: string; sessionId: string | null; costUsd: number | null; turns: number; durationMs: number;
  contextTokens: number; contextWindow: number | null; autoCompact?: AutoCompact | null; tokens: Tokens; slashCommands: string[]; commandInfo?: { name: string; description: string; hint?: string }[]; tools: string[]; pending: number; error: string | null; recoverable?: boolean; startedAt: number;
};
export type Block = { type: 'text'; text: string } | { type: 'thinking'; text: string } | { type: 'tool_use'; id: string; name: string; input: any } | { type: 'other'; original: string };
export type Approval = { requestId: string; tool: string; input: any; toolUseId?: string; suggestions: unknown[]; questions?: { id: string; prompt: string; secret?: boolean; allowMultiple?: boolean; options?: { id: string; label: string; description?: string }[] }[] };
export type Item =
  | { kind: 'user'; key: string; text: string; images: number }
  | { kind: 'assistant'; key: string; id: string; uuid?: string; blocks: Block[]; sub: boolean }
  | { kind: 'divider'; key: string }
  | { kind: 'compact'; key: string; trigger: 'auto' | 'manual'; preTokens: number | null; postTokens: number | null }
  | { kind: 'error'; key: string; message: string; recoverable?: boolean }
  | { kind: 'note'; key: string; text: string }; // client-only (/cost, /help): never stored
export type ChatView = {
  items: Item[]; results: Record<string, { content: string; isError: boolean }>;
  // Live output keyed by assistant message id, then content-block index. Tool messages from Codex/Cursor only clear their own id.
  stream: Record<string, Record<number, Block>> | null; streamMessageOrder: string[]; streamMessageId: string | null;
  thinkingTokens: number; compacting: boolean; steers: { uuid: string; text: string; images: number }[]; approvals: Approval[]; seq: number; state: ChatState; ready: boolean;
};
export const emptyState = (): ChatState => ({ status: 'idle', model: null, effort: null, worktree: false, addDirs: [], permissionMode: 'default', sessionId: null, costUsd: 0, turns: 0, durationMs: 0, contextTokens: 0, contextWindow: null, autoCompact: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, slashCommands: [], tools: [], pending: 0, error: null, startedAt: Date.now() });
export const emptyView = (): ChatView => ({ items: [], results: {}, stream: null, streamMessageOrder: [], streamMessageId: null, thinkingTokens: 0, compacting: false, steers: [], approvals: [], seq: 0, state: emptyState(), ready: false });

const MAX_ITEMS = 2000;
const slotBlocks = (stream: Record<string, Record<number, Block>>, messageId: string) => {
  const slot = stream[messageId]; if (!slot) return [];
  return Object.keys(slot).map(Number).sort((a, b) => a - b).map(index => slot[index]);
};
const nextIndex = (slot: Record<number, Block>, index: number) => { let at = index; while (slot[at]) at += 1; return at; };
const blockText = (block: Block) => block.type === 'text' || block.type === 'thinking' ? block.text.trim() : '';
// Claude stores one block per event and reuses the message id. A later tool must not erase the text that came before it.
const absorbBlocks = (existing: Block[], incoming: Block[]): Block[] => {
  const blocks = [...existing];
  for (const block of incoming) {
    if (block.type === 'tool_use') {
      const at = blocks.findIndex(item => item.type === 'tool_use' && item.id === block.id);
      if (at >= 0) blocks[at] = block; else blocks.push(block);
      continue;
    }
    if (block.type !== 'text' && block.type !== 'thinking') { blocks.push(block); continue; }
    const last = blocks.at(-1);
    if (last?.type === block.type) {
      const previous = blockText(last), next = blockText(block);
      if (!next || !previous || next.startsWith(previous) || previous.startsWith(next)) {
        if (next) blocks[blocks.length - 1] = block;
        continue;
      }
    }
    if (!blockText(block) || blocks.some(item => item.type === block.type && blockText(item) === blockText(block))) continue;
    blocks.push(block);
  }
  return blocks;
};
const mergeStreamBlocks = (blocks: Block[], streamed: Block[]) => {
  if (!streamed.length) return blocks;
  const extras: Block[] = [];
  for (const live of streamed) {
    if ((live.type === 'thinking' || live.type === 'text') && !blockText(live)) continue;
    if (live.type === 'text') {
      const incoming = live.text.trim();
      const covered = [...blocks, ...extras].some(block => block.type === 'text' && (block.text.trim() === incoming || block.text.includes(incoming)));
      if (!covered) extras.push(live);
    } else if (live.type === 'thinking') {
      if (![...blocks, ...extras].some(block => block.type === 'thinking' && blockText(block))) extras.push(live);
    } else if (live.type === 'tool_use' && ![...blocks, ...extras].some(block => block.type === 'tool_use' && block.id === live.id)) extras.push(live);
  }
  return [...extras, ...blocks];
};
const dropStreamMessage = (view: ChatView, messageId: string): ChatView => {
  if (!view.stream?.[messageId]) return view;
  const stream = { ...view.stream }; delete stream[messageId];
  const streamMessageOrder = view.streamMessageOrder.filter(id => id !== messageId);
  const empty = !Object.keys(stream).length;
  return { ...view, stream: empty ? null : stream, streamMessageOrder, streamMessageId: view.streamMessageId === messageId ? null : view.streamMessageId };
};
const flushOpenStream = (view: ChatView, key: string): ChatView => {
  if (!view.stream) return { ...view, stream: null, streamMessageOrder: [], streamMessageId: null };
  let items = view.items;
  for (const messageId of view.streamMessageOrder.length ? view.streamMessageOrder : Object.keys(view.stream)) {
    if (items.some(item => item.kind === 'assistant' && item.id === messageId)) continue;
    const blocks = slotBlocks(view.stream, messageId);
    if (!blocks.length) continue;
    items = [...items, { kind: 'assistant', key: `${key}-${messageId}`, id: messageId, blocks, sub: false }];
  }
  return { ...view, items: items.slice(-MAX_ITEMS), stream: null, streamMessageOrder: [], streamMessageId: null };
};
// Ordered live blocks for the streaming bubble in ChatPane.
export const streamBlocks = (view: ChatView) => {
  if (!view.stream) return [];
  const order = view.streamMessageOrder.length ? view.streamMessageOrder : Object.keys(view.stream);
  return order.flatMap(messageId => slotBlocks(view.stream!, messageId));
};
// Applies one server event. Stored events carry `seq` (a replayed or doubly delivered one is ignored); `delta` events are live-only.
export function reduce(view: ChatView, event: any): ChatView {
  if (!event || typeof event !== 'object') return view;
  if (typeof event.seq === 'number') { if (event.seq <= view.seq) return view; view = { ...view, seq: event.seq }; }
  const key = `e${event.seq ?? Math.random()}`;
  const push = (item: Item): ChatView => ({ ...view, items: [...view.items, item].slice(-MAX_ITEMS) });
  switch (event.kind) {
    case 'user': return push({ kind: 'user', key, text: String(event.text ?? ''), images: Number(event.images) || 0 });
    case 'message': {
      const messageId = String(event.id ?? key);
      const streamed = view.stream ? slotBlocks(view.stream, messageId) : [];
      const item: Item = { kind: 'assistant', key, id: messageId, ...(typeof event.uuid === 'string' && { uuid: event.uuid }),
        blocks: mergeStreamBlocks(Array.isArray(event.blocks) ? event.blocks : [], streamed), sub: Boolean(event.parentToolUseId) };
      const at = view.items.findIndex(existing => existing.kind === 'assistant' && existing.id === item.id);
      const next = at >= 0 ? { ...view, items: (() => { const items = [...view.items]; const prev = items[at]; items[at] = prev.kind === 'assistant' ? { ...item, key: prev.key, blocks: absorbBlocks(prev.blocks, item.blocks) } : item; return items; })() } : push(item);
      return dropStreamMessage(next, messageId);
    }
    case 'tool_result': return { ...view, results: { ...view.results, [event.toolUseId]: { content: String(event.content ?? ''), isError: event.isError === true } } };
    case 'delta': {
      if (event.phase === 'start') {
        const messageId = String(event.messageId ?? `live-${view.streamMessageOrder.length}`);
        const stream = { ...(view.stream ?? {}) };
        stream[messageId] = stream[messageId] ?? {};
        const streamMessageOrder = view.streamMessageOrder.includes(messageId) ? view.streamMessageOrder : [...view.streamMessageOrder, messageId];
        return { ...view, stream, streamMessageOrder, streamMessageId: messageId, thinkingTokens: event.parentToolUseId ? view.thinkingTokens : 0 };
      }
      if (event.phase === 'thinkingTokens') return { ...view, thinkingTokens: Number(event.tokens) || 0 };
      if (event.phase === 'compacting') return { ...view, compacting: event.active === true };
      if (event.phase === 'reset') return dropStreamMessage(view, String(event.messageId ?? view.streamMessageId ?? ''));
      const messageId = String(event.messageId ?? view.streamMessageId ?? 'live-0');
      const stream = { ...(view.stream ?? {}) }, slot = { ...(stream[messageId] ?? {}) };
      let index = Number(event.index) || 0;
      const current = slot[index];
      if (event.phase === 'text') {
        if (current?.type === 'tool_use') index = nextIndex(slot, index);
        slot[index] = { type: 'text', text: (current?.type === 'text' ? current.text : '') + (event.text ?? '') };
      } else if (event.phase === 'thinking') {
        if (current?.type === 'tool_use') index = nextIndex(slot, index);
        slot[index] = { type: 'thinking', text: (current?.type === 'thinking' ? current.text : '') + (event.text ?? '') };
      } else if (event.phase === 'tool') {
        if (current && (current.type === 'text' || current.type === 'thinking')) index = nextIndex(slot, index);
        slot[index] = { type: 'tool_use', id: String(event.id ?? ''), name: String(event.name ?? ''), input: {} };
      } else return view;
      stream[messageId] = slot;
      const streamMessageOrder = view.streamMessageOrder.includes(messageId) ? view.streamMessageOrder : [...view.streamMessageOrder, messageId];
      return { ...view, stream, streamMessageOrder, streamMessageId: messageId };
    }
    case 'approval': {
      if (event.phase === 'request') return { ...view, approvals: [...view.approvals.filter(item => item.requestId !== event.requestId), { requestId: event.requestId, tool: event.tool, input: event.input, toolUseId: event.toolUseId, questions: event.questions, suggestions: event.suggestions ?? [] }] };
      return { ...view, approvals: view.approvals.filter(item => item.requestId !== event.requestId) };
    }
    case 'result': {
      if (view.compacting) view = { ...view, compacting: false };
      if (event.status === 'interrupted' || event.status === 'failed') {
        const results = { ...view.results };
        for (const item of view.items) if (item.kind === 'assistant') for (const block of item.blocks) if (block.type === 'tool_use' && !results[block.id]) results[block.id] = { content: event.status === 'interrupted' ? '응답을 중단했습니다.' : '응답에 실패했습니다.', isError: true };
        view = { ...view, results };
      }
      if (event.status === 'interrupted') return { ...flushOpenStream(push({ kind: 'note', key, text: '응답을 중단했습니다.' }), key), approvals: [] };
      if (event.status === 'failed') return flushOpenStream(push({ kind: 'error', key, message: event.text || '응답에 실패했습니다.' }), key);
      return flushOpenStream(view, key);
    }
    case 'error': return { ...push({ kind: 'error', key, message: String(event.message ?? '오류'), recoverable: event.recoverable === true }), state: { ...view.state, error: String(event.message ?? '오류'), recoverable: event.recoverable === true || view.state.recoverable } };
    case 'compact': return { ...push({ kind: 'compact', key, trigger: event.trigger === 'auto' ? 'auto' : 'manual', preTokens: Number.isFinite(event.preTokens) ? event.preTokens : null, postTokens: Number.isFinite(event.postTokens) ? event.postTokens : null }), compacting: false };
    case 'divider': return { ...push({ kind: 'divider', key }), stream: null, streamMessageOrder: [], streamMessageId: null, approvals: [], steers: [], thinkingTokens: 0 };
    // A steering message waits below the running reply until the turn takes it in; then it is an ordinary user message at that point. Cancelled: it just goes away.
    case 'steer': {
      const rest = view.steers.filter(item => item.uuid !== event.uuid);
      if (event.phase === 'queued') return { ...view, steers: [...rest, { uuid: String(event.uuid), text: String(event.text ?? ''), images: Number(event.images) || 0 }] };
      if (event.phase === 'applied') return { ...push({ kind: 'user', key, text: String(event.text ?? ''), images: Number(event.images) || 0 }), steers: rest };
      return { ...view, steers: rest };
    }
    // Rewind: everything after that assistant message is gone (a replayed transcript lands on the same view).
    case 'rewind': {
      const at = view.items.findIndex(item => item.kind === 'assistant' && item.uuid === event.uuid);
      return at < 0 ? view : { ...view, items: [...view.items.slice(0, at + 1), { kind: 'note', key, text: '여기까지 되돌렸습니다. 이후 대화는 이어지지 않습니다. 에이전트가 이미 바꾼 파일은 그대로입니다.' }], stream: null, streamMessageOrder: [], streamMessageId: null, approvals: [], thinkingTokens: 0 };
    }
    default: return view;
  }
}

// Rebuilds a view from `chat/open`'s replay: stored events in order, then the server's current state and pending approvals.
export function fromReplay(replay: { events?: any[]; seq?: number; state?: ChatState; approvals?: any[] }): ChatView {
  let view = emptyView();
  for (const event of replay.events ?? []) view = reduce(view, event);
  return { ...view, seq: Math.max(view.seq, replay.seq ?? 0), state: replay.state ?? view.state, ready: true,
    approvals: (replay.approvals ?? []).map(item => ({ requestId: item.requestId, tool: item.tool, input: item.input, toolUseId: item.toolUseId, questions: item.questions, suggestions: item.suggestions ?? [] })) };
}

// ---- numbers shown in the status line ----
// The CLI reports the real window on each result's modelUsage. Until that arrives, the model catalog's max input
// tokens is the window (Sonnet 5.5 is 1M with no [1m] suffix). A [1m] id is 1M when the catalog has no row; anything else is 200k.
export const contextWindow = (model: string | null, reported?: number | null, catalog?: { id: string; window?: number }[]) =>
  reported || (model && /\[1m\]|-1m\b/i.test(model) ? 1_000_000 : catalog?.find(item => item.id === model)?.window) || 200_000;
export type ContextGauge = { percent: number; used: number; basis: number; max: number; autoCompact: boolean; autoEstimated: boolean };
export const contextGauge = (state: Pick<ChatState, 'contextTokens' | 'model' | 'autoCompact'> & { contextWindow?: number | null; capabilities?: { catalog?: { id: string; window?: number }[] } }): ContextGauge => {
  const max = contextWindow(state.model, state.contextWindow, state.capabilities?.catalog);
  const compact = state.autoCompact && state.autoCompact.window > 0 && state.autoCompact.window < max ? state.autoCompact : null;
  const basis = compact?.window ?? max;
  return { percent: Math.min(100, Math.round(state.contextTokens * 100 / basis)), used: state.contextTokens, basis, max, autoCompact: Boolean(compact), autoEstimated: Boolean(compact?.auto) };
};
export const contextPercent = (state: Parameters<typeof contextGauge>[0]) => contextGauge(state).percent;
// Each model family has its own color (CSS variables --model-*, defined per theme in style.css); unknown models stay uncolored.
export const modelFamilies = ['fable', 'opus', 'sonnet', 'haiku', 'astra', 'sol', 'terra', 'luna'];
export const modelColor = (model: string | null | undefined) => {
  const family = model && /(?:^|[^a-z])(fable|opus|sonnet|haiku|astra|sol|terra|luna)(?![a-z])/i.exec(model)?.[1].toLowerCase();
  return family ? `var(--model-${family})` : undefined;
};
// Cursor groups Composer, Auto and Grok as First Party; Grok's provider remains xAI.
export function modelProvider(model: string | null | undefined) {
  if (!model) return undefined;
  const providers = [
    ['cursor', 'Cursor', /(?:^|[^a-z])(?:composer|auto)(?![a-z])/i],
    ['anthropic', 'Anthropic', /(?:^|[^a-z])(?:claude|fable|opus|sonnet|haiku)(?![a-z])/i],
    ['openai', 'OpenAI', /(?:^|[^a-z])(?:openai|gpt|codex|o[134]|astra|sol|terra|luna)(?![a-z])/i],
    ['google', 'Google', /(?:^|[^a-z])(?:google|gemini)(?![a-z])/i],
    ['xai', 'xAI', /(?:^|[^a-z])(?:xai|grok)(?![a-z])/i],
    ['deepseek', 'DeepSeek', /(?:^|[^a-z])deepseek(?![a-z])/i],
    ['moonshot', 'Moonshot', /(?:^|[^a-z])(?:moonshot|kimi)(?![a-z])/i],
    ['alibaba', 'Alibaba', /(?:^|[^a-z])(?:alibaba|qwen)(?![a-z])/i],
    ['zai', 'Z.ai', /(?:^|[^a-z])(?:glm|zai)(?![a-z])/i],
    ['meta', 'Meta', /(?:^|[^a-z])(?:muse|llama)(?![a-z])/i],
    ['mistral', 'Mistral', /(?:^|[^a-z])(?:mistral|codestral|devstral)(?![a-z])/i],
    ['nvidia', 'NVIDIA', /(?:^|[^a-z])(?:nvidia|nemotron)(?![a-z])/i],
    ['minimax', 'MiniMax', /(?:^|[^a-z])minimax(?![a-z])/i],
  ] as const;
  const provider = providers.find(([, , pattern]) => pattern.test(model));
  return provider ? { id: provider[0], name: provider[1], party: ['cursor', 'xai'].includes(provider[0]) ? 'First Party' : 'Third Party' } : undefined;
}
export function modelAppearance(model: string | null | undefined, agent?: string) {
  const provider = modelProvider(model);
  return agent === 'cursor' ? { color: provider ? provider.party === 'First Party' ? 'var(--provider-cursor)' : `var(--provider-${provider.id})` : undefined,
    hint: provider ? `${provider.party} · ${provider.name}` : 'Provider 미확인' }
    : { color: modelColor(model), hint: undefined };
}
// Keep parameterized IDs for requests; names are only for display.
export function modelDisplayName(model: string | null | undefined): string {
  if (!model) return '모델 미정';
  const names: Record<string, string> = { claude: 'Claude', gpt: 'GPT', glm: 'GLM', grok: 'Grok', composer: 'Composer', gemini: 'Gemini',
    muse: 'Muse', deepseek: 'DeepSeek', kimi: 'Kimi', qwen: 'Qwen', minimax: 'MiniMax', auto: 'Auto', smart: 'Smart',
    opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', codex: 'Codex', astra: 'Astra', sol: 'Sol', terra: 'Terra', luna: 'Luna' };
  return model.replace(/\[.*\]$/, '').trim().replace(/(\d{1,2})-(?=\d{1,2}(?:-|$))/g, '$1.')
    .split(/[-\s]+/).map(part => names[part.toLowerCase()] ?? (/^[a-z]/i.test(part) ? part[0].toUpperCase() + part.slice(1) : part)).join(' ');
}
export const displayModel = (model: string | null | undefined, agent?: string) => agent === 'cursor' ? modelDisplayName(model) : shortModel(model ?? null);
export function cursorModelGroups(rows: ModelRow[], party: string, query = '') {
  const groups = new Map<string, ModelRow[]>();
  for (const row of rows) {
    const provider = modelProvider(row.id);
    if ((provider?.party ?? 'Third Party') !== party) continue;
    const name = provider?.name ?? '기타 Provider';
    const label = modelDisplayName(row.label);
    if (!`${name} ${row.id} ${label}`.toLowerCase().includes(query.trim().toLowerCase())) continue;
    groups.set(name, [...(groups.get(name) ?? []), { ...row, label }]);
  }
  const family = (row: ModelRow) => row.label.toLowerCase().split(' ').find(part => FAMILY_ORDER.includes(part)) ?? '';
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([provider, models]) => ({ provider, models: models.sort((a, b) =>
    familyRank(family(a)) - familyRank(family(b)) || a.label.replace(/\d.*$/, '').localeCompare(b.label.replace(/\d.*$/, '')) || compareVersion(modelVersion(a.label), modelVersion(b.label)) || a.label.localeCompare(b.label)) }));
}
// ---- the model list ----
export type CatalogModel = { id: string; name: string; family: string; window: number; main: boolean; efforts?: string[]; images?: boolean };
export type ModelRow = { value: string; label: string; family: string; id: string; oneM: boolean; main: boolean; version: number[] };
const ALIASES = ['opus', 'sonnet', 'haiku'], FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku'];
export const modelVersion = (name: string) => (/(\d+(?:\.\d+)*)/.exec(name)?.[1] ?? '0').split('.').map(Number);
const compareVersion = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const diff = (b[i] ?? 0) - (a[i] ?? 0); if (diff) return diff; } return 0; };
const familyRank = (family: string) => { const at = FAMILY_ORDER.indexOf(family); return at < 0 ? FAMILY_ORDER.length : at; };
const versionAtLeast = (version: number[], min: number[]) => compareVersion(min, version) >= 0;
const versionBelow = (version: number[], max: number[]) => compareVersion(version, max) > 0;
// Opus 4.6 / Sonnet 4.x (before 5) still need `--model …[1m]` for 1M; newer lines default to 1M (Fable 5+, Opus 4.7+, Sonnet 5+, Haiku 5.5). Older families do not support 1M.
export function needsExplicit1mRow(family: string, version: number[]): boolean {
  if (family === 'opus') return versionAtLeast(version, [4, 6]) && versionBelow(version, [4, 7]);
  if (family === 'sonnet') return versionAtLeast(version, [4, 6]) && versionBelow(version, [5, 0]);
  return false;
}
// One row per model, plus a "(1M)" row right behind Opus/Sonnet only when `[1m]` is still required (so Opus sits with Opus). Fable always comes
// first; the rest are newest version first (5.5 before 5.4), then the family, then the plain row before its 1M row. A row's value is what `--model` gets: the alias when it points at this
// very model (so the choice keeps following "latest"), else the full id.
export function modelRows(catalog: CatalogModel[], aliases: Record<string, string>): ModelRow[] {
  const rows = catalog.flatMap(model => {
    const alias = ALIASES.find(name => aliases[name] === model.id), value = alias ?? model.id, label = modelDisplayName(model.name);
    const version = modelVersion(model.name);
    const base: ModelRow = { value, label, family: model.family, id: model.id, oneM: false, main: model.main, version };
    return needsExplicit1mRow(model.family, version) ? [base, { ...base, value: `${value}[1m]`, label: `${label} (1M)`, oneM: true }] : [base];
  });
  return rows.sort((a, b) => Number(b.family === 'fable') - Number(a.family === 'fable') || compareVersion(a.version, b.version) || familyRank(a.family) - familyRank(b.family) || a.family.localeCompare(b.family) || Number(a.oneM) - Number(b.oneM));
}
// The concrete id the CLI reports, shown as the alias row that resolves to it (rows of models without an alias keep their id).
export function modelValue(model: string | null, aliases: Record<string, string>): string {
  if (!model) return '';
  const one = /\[1m\]$/i.test(model), base = model.replace(/\[1m\]$/i, ''), alias = ALIASES.find(name => aliases[name] === base);
  return `${alias ?? base}${one ? '[1m]' : ''}`;
}
export const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
// `extra-high` is the same step as `xhigh`; Thinking is a separate switch and must not be treated as Effort.
export const effortLevel = (value: string | null | undefined) => {
  const level = (value ?? '').toLowerCase().replace(/[\s_]+/g, '-');
  return level === 'extra-high' || level === 'x-high' ? 'xhigh' : level;
};
export const isCursorEffort = (option: { id: string }) => /^(effort|reasoning|reasoning_effort)$/i.test(option.id);
export const isCursorMax = (option: { id: string }) => /^max([_-]?mode)?$/i.test(option.id);
export const isCursorSwitch = (option: { id: string; options: { value: string }[] }) => !isCursorEffort(option) && !isCursorMax(option) && option.options.length === 2 && option.options.every(item => item.value === 'true' || item.value === 'false');
const contextRank = (value: string) => { const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim()); return match ? Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000) : 0; };
// The largest advertised context window is what MAX selects. ACP has no separate max-mode flag (cursor-agent 2026.11).
export function contextEnds(option: { options: { value: string }[] }) {
  const ranked = option.options.map(item => ({ value: item.value, rank: contextRank(item.value) })).filter(item => item.rank > 0).sort((a, b) => a.rank - b.rank);
  return ranked.length < 2 || ranked[0].rank === ranked[ranked.length - 1].rank ? null : { off: ranked[0].value, on: ranked[ranked.length - 1].value };
}
export const cursorSettingName = (option: { id: string; name: string }) => ({ context: '컨텍스트', optimize_for: '최적화' } as Record<string, string>)[option.id] ?? option.name;
export const maxOnValue = (option: { options: { value: string }[] }) => option.options.find(item => /^(true|on|max)$/i.test(item.value))?.value ?? option.options.at(-1)?.value ?? '';
export const maxOffValue = (option: { options: { value: string }[] }) => option.options.find(item => item.value !== maxOnValue(option))?.value ?? option.options[0]?.value ?? '';
export const maxSelected = (option: { currentValue: string; options: { value: string }[] }) => option.currentValue === maxOnValue(option);
// Effort level -> color + glyph, cool and calm at the bottom, hot at the top. The two highest levels get rising particles (EffortSparks in ChatPane.tsx).
export const effortStyle: Record<string, { color: string; icon: string }> = {
  none: { color: '#8b93a0', icon: 'remove' }, minimal: { color: '#7fb8a4', icon: 'signal_cellular_alt_1_bar' },
  low: { color: '#5ec9a0', icon: 'signal_cellular_alt_1_bar' }, medium: { color: '#6fa8f0', icon: 'signal_cellular_alt_2_bar' },
  high: { color: '#b58cf0', icon: 'signal_cellular_alt' }, xhigh: { color: '#f0a04b', icon: 'bolt' },
  max: { color: '#f2566e', icon: 'local_fire_department' }, ultra: { color: '#f2566e', icon: 'local_fire_department' }
};
export const effortLabels: Record<string, string> = { low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대', minimal: '최소', none: '없음', ultra: '최상' };
export const effortLabel = (value: string) => effortLabels[value] ?? effortLabels[effortLevel(value)] ?? value;
// "claude-sonnet-5-5" -> "Sonnet 5.5", "opus[1m]" -> "Opus (1M)"; ids that do not look like that are shown trimmed.
export function shortModel(model: string | null): string {
  if (!model) return '모델 미정';
  const million = /\[1m\]$/i.test(model) ? ' (1M)' : '';
  const gpt = /^gpt-(\d+(?:\.\d+)?)-(astra|sol|terra|luna)(?=$|[\[-])/i.exec(model);
  if (gpt) return `GPT ${gpt[1]} ${gpt[2][0].toUpperCase()}${gpt[2].slice(1).toLowerCase()}${million}`;
  const match = /(?:^|[^a-z])(fable|opus|sonnet|haiku|astra|sol|terra|luna)(?:-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?)?/i.exec(model);
  if (!match) return model.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[1m\]$/i, '') + million;
  return `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}${match[2] ? ` ${match[2]}${match[3] ? `.${match[3]}` : ''}` : ''}${million}`;
}
export function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(value);
}
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}시간 ${Math.floor(seconds % 3600 / 60)}분` : seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`;
}
export const permissionLabels: Record<string, string> = { default: '기본', acceptEdits: '편집 허용', plan: '계획', auto: '자동', bypassPermissions: 'Bypass', ask: '질문 전용' };
// Resolved on the chat pane via agent-scoped `--mode-*` vars in style.css (Claude Code theme.ts, Codex TUI, Cursor CLI).
export const permissionModeColor = (mode: string) => `var(--mode-${mode}, var(--muted))`;
export const statusLabelsKo: Record<ChatState['status'], string> = { idle: '대기 중', working: '응답 중', attention: '승인 대기', closed: '종료' };

// "{model} · {ctx}" style templates; unknown tokens stay as typed so a typo is visible.
export const fillFormat = (format: string, values: Record<string, string>) => format.replace(/\{(\w+)\}/g, (whole, name) => name in values ? values[name] : whole);

// A one-line summary of a tool call for its collapsed card.
export function toolSummary(name: string, input: any): string {
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  const line = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 140);
  switch (name) {
    case 'Bash': return line(text(input?.description) || text(input?.command));
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return line(text(input?.file_path) || text(input?.notebook_path));
    case 'Glob': case 'Grep': return line(text(input?.pattern));
    case 'WebFetch': return line(text(input?.url));
    case 'WebSearch': return line(text(input?.query));
    case 'Task': case 'Agent': return line(text(input?.description) || text(input?.prompt));
    case 'TodoWrite': return `${Array.isArray(input?.todos) ? input.todos.length : 0}개 항목`;
    default: return line(text(input?.description) || text(input?.command) || text(input?.path) || text(input?.query) || JSON.stringify(input ?? {}));
  }
}

// Chat-composer shortcuts. A combo is "ctrl+alt+shift+key" (key from event.code, so Option+P on a Mac is "p", not "π"); the user's overrides live in settings.chatKeys.
export const chatKeyDefs = [
  { id: 'effortUp', label: 'Effort 올리기', keys: 'shift+arrowup' }, { id: 'effortDown', label: 'Effort 내리기', keys: 'shift+arrowdown' },
  { id: 'modelNext', label: '다음 모델로 전환', keys: 'alt+p' }, { id: 'stash', label: '입력 임시 보관 / 복원', keys: 'ctrl+s' }
] as const;
export type ChatKeyId = typeof chatKeyDefs[number]['id'];
export const chatKey = (overrides: Record<string, string> | undefined, id: ChatKeyId) => overrides?.[id] || chatKeyDefs.find(def => def.id === id)!.keys;
export function comboOf(event: { code: string; key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): string {
  const code = event.code, key = code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : (code || event.key).toLowerCase();
  if (/^(meta|control|alt|shift)(left|right)?$/.test(key)) return '';
  return [event.metaKey && 'meta', event.ctrlKey && 'ctrl', event.altKey && 'alt', event.shiftKey && 'shift', key].filter(Boolean).join('+');
}
// Bare keys (and Shift+letter) would swallow typing, so a binding needs Ctrl/Alt/⌘ or Shift with a non-character key.
export const validCombo = (combo: string) => { const parts = combo.split('+'), key = parts.at(-1)!; return parts.length > 1 && (parts.some(part => ['meta', 'ctrl', 'alt'].includes(part)) || key.startsWith('arrow') || ['home', 'end', 'pageup', 'pagedown'].includes(key) || /^f\d{1,2}$/.test(key)); };
export function showCombo(combo: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const names: Record<string, string> = mac ? { meta: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' } : { meta: 'Win', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' };
  const keyNames: Record<string, string> = { backquote: '`', backslash: '\\', comma: ',', period: '.', slash: '/', semicolon: ';', quote: "'", equal: '=', minus: '-', bracketleft: '[', bracketright: ']' };
  return combo.split('+').map(part => names[part] ?? keyNames[part] ?? (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))).join(mac ? '' : '+');
}

const greetings = {
  any: ['다음엔 무엇을 해 볼까요?', '무엇을 도와드릴까요?', '오늘은 어떤 작업을 해 볼까요?', '어디서부터 시작할까요?', '어떤 작업이 필요하세요?', '무엇부터 살펴볼까요?', '이번엔 어떤 걸 만들어 볼까요?', '같이 해결할 일이 있나요?'],
  morning: ['좋은 아침이에요. 오늘은 무엇부터 할까요?', '좋은 아침이에요. 어떤 작업으로 시작할까요?', '오늘 첫 작업은 무엇인가요?', '아침이네요. 가볍게 하나 시작해 볼까요?'],
  noon: ['오후에는 어떤 작업을 해 볼까요?', '점심 이후엔 무엇부터 할까요?', '오늘 작업은 잘 되어 가고 있나요? 이어서 무엇을 할까요?', '오후도 이어서 달려 볼까요? 무엇을 할까요?'],
  evening: ['오늘 마무리하기 전에 할 일이 더 있나요?', '저녁이네요. 남은 작업을 같이 볼까요?', '오늘 작업은 어디까지 진행됐나요?', '하루 끝이 보이네요. 마지막으로 무엇을 할까요?'],
  night: ['늦은 시간이네요. 무엇을 도와드릴까요?', '늦었는데 급한 작업이 있나요?', '오늘은 하나만 끝내 볼까요? 무엇부터 할까요?', '밤늦게까지 고생이 많네요. 무엇을 할까요?'],
};

const SLASH_COMMAND = /^\/[^\s/]*(?:\s|$)/;
const SLASH_PARTS = /^\/([\w:-]*)(?:\s+([\s\S]*))?$/;

/** Slash-command user input in chat (not a Unix path like `/usr/bin/env`). */
export function isChatSlashCommand(text: string): boolean {
  const trimmed = text.trim();
  return Boolean(trimmed) && SLASH_COMMAND.test(trimmed);
}

export function parseChatSlashCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!isChatSlashCommand(trimmed)) return null;
  const match = SLASH_PARTS.exec(trimmed);
  if (!match) return null;
  return { name: match[1], args: (match[2] ?? '').trim() };
}

const inferenceBlock = (block: Block) => block.type === 'tool_use' || (block.type === 'thinking' && Boolean(block.text.trim()));

/** Copy / branch / rewind apply to real agent turns; local slash output is usually text-only (no tools, no thinking). */
export function turnAllowsMessageActions(turn: Item[]): boolean {
  const user = turn.find(item => item.kind === 'user');
  if (!user || !isChatSlashCommand(user.text)) return true;
  const assistants = turn.filter((item): item is Extract<Item, { kind: 'assistant' }> => item.kind === 'assistant' && !item.sub);
  if (!assistants.length) return true;
  return assistants.some(item => item.blocks.some(inferenceBlock));
}

/** 시간대별 문구와 공통 문구를 섞어 무작위로 하나 고른다. */
export function pickGreeting(user = '', now = new Date(), random = Math.random): string {
  const h = now.getHours(), part = h < 5 ? 'night' : h < 11 ? 'morning' : h < 17 ? 'noon' : h < 22 ? 'evening' : 'night';
  const pool = [...greetings.any, ...greetings[part]], text = pool[Math.floor(random() * pool.length)];
  return user ? `${user}님, ${text}` : text;
}
