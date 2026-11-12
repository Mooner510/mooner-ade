// What the chat tab knows about one conversation, built from the events the local server streams (apps/local-server/src/chat-claude.js).
// Pure functions only, so tests/chat-model.test.mjs can load this file through Node's type stripping.

export type Tokens = { input: number; output: number; cacheRead: number; cacheCreate: number };
export type ModelConfigOption = { id: string; name: string; description?: string; category?: string; type: 'select'; currentValue: string; options: { value: string; name: string; description?: string }[] };
export type ChatCapabilities = { configOptions?: ModelConfigOption[]; images: boolean; steer: boolean; cancelSteer: boolean; branch: boolean; rewind: boolean; worktree: boolean; addDirs: boolean; terminal: boolean; terminalToChat: boolean; cost: boolean; tokens: boolean; context: boolean; permissionModes: string[]; sandboxes?: string[]; runEverything?: boolean; efforts: string[]; catalog: CatalogModel[]; limitations: Record<string, string> };
export type AutoCompact = { window: number; maxWindow: number; auto: boolean; source?: string };
export type ChatSegmentTitles = { custom?: string; ai?: string; agent?: string };
export type ChatState = {
  agent?: 'claude' | 'codex' | 'cursor'; capabilities?: ChatCapabilities;
  status: 'idle' | 'working' | 'attention' | 'closed'; model: string | null; effort: string | null; worktree: boolean; addDirs: string[]; permissionMode: string; sandbox?: string | null; network?: boolean; runEverything?: boolean; configuring?: boolean; restartPending?: boolean; sessionId: string | null; costUsd: number | null; turns: number; durationMs: number;
  contextTokens: number; contextWindow: number | null; contextUsageSource?: 'acp' | 'store'; autoCompact?: AutoCompact | null; tokens: Tokens; slashCommands: string[]; commandInfo?: { name: string; description: string; hint?: string }[]; tools: string[]; pending: number; error: string | null; recoverable?: boolean; startedAt: number;
  segmentTitles?: ChatSegmentTitles; chatTitle?: string;
  liveTasks?: string[]; // Claude: the Agent calls whose subagent runs in the current child process
  // Claude: the prompt cache clock read from the session's transcript (same shape as the terminal's ClaudeCache); null before the first reply.
  cache?: { at: number; ttl: number; tokens: number; model: string; compactAt?: number; compacted?: { at: number; trigger: 'auto' | 'manual'; before?: number; after?: number } } | null;
};
// `key` keeps a block's React identity from its first streamed character to the stored message (so nothing remounts or replays its entrance);
// `partial` marks a block that is still streaming. `slot` is a streamed tool's content-block index, `partialJson` its input so far.
type BlockBase = { key?: string; partial?: boolean };
export type Block = BlockBase & ({ type: 'text'; text: string } | { type: 'thinking'; text: string } | { type: 'tool_use'; id: string; name: string; input: any; slot?: number; partialJson?: string } | { type: 'other'; original: string });
export type Approval = { requestId: string; tool: string; input: any; toolUseId?: string; suggestions: unknown[]; questions?: ChatQuestion[] };
export type ChatQuestion = { id: string; prompt: string; header?: string; secret?: boolean; allowMultiple?: boolean; allowOther?: boolean; options?: { id: string; label: string; description?: string }[] };
// `fresh`: created by a live event (not a replay), so it plays its entrance animation once.
type ItemBase = { key: string; fresh?: boolean };
/** The part of a system line that names what changed (a model, an Effort, a permission mode) and the colour it is drawn in elsewhere in the UI. */
export type Tone = { value: string; color: string; icon?: string; bars?: number };
/** What the user switched with /model, /effort and /permissions since the last thing said in the thread. */
export type SettingsChange = { model?: Tone; effort?: Tone; mode?: Tone };
const previewsOf = (event: { previews?: unknown }) => Array.isArray(event.previews) ? event.previews.filter((url): url is string => typeof url === 'string' && url.startsWith('data:image/')) : undefined;
export type Item = ItemBase & (
  | { kind: 'user'; text: string; images: number; previews?: string[] }
  | { kind: 'assistant'; id: string; uuid?: string; blocks: Block[]; sub: boolean; parent?: string }
  | { kind: 'divider' }
  | { kind: 'compact'; trigger: 'auto' | 'manual'; preTokens: number | null; postTokens: number | null }
  | { kind: 'error'; message: string; recoverable?: boolean }
  | { kind: 'command'; text: string; isError: boolean } // what a slash command printed (or that it finished with no output)
  | { kind: 'note'; text: string; tones?: Tone[]; change?: SettingsChange; rev?: number; local?: boolean } // client-only system line (settings changes, /help): never stored
  | { kind: 'info'; text: string; local?: boolean }); // a reply shown as a chat message (markdown): /cost /status /usage /context, whether ADE or the CLI answers
export type AssistantItem = Extract<Item, { kind: 'assistant' }>;
export type ChatView = {
  items: Item[]; results: Record<string, { content: string; isError: boolean }>;
  // Streamed output grows inside `items` (the assistant item of its message id), so the stored message lands on the same item.
  // `live`: message ids streaming in this turn and whether they belong to a subagent; `liveId` takes deltas that name no message.
  live: Record<string, { sub: boolean; parent?: string }>; liveId: string | null;
  tasks: Record<string, TaskInfo>; // what the CLI reported about each subagent, by its Agent call's tool_use id
  thinkingTokens: number; compacting: boolean; steers: { uuid: string; text: string; images: number; previews?: string[] }[]; approvals: Approval[]; seq: number; state: ChatState; ready: boolean;
};
export const emptyState = (): ChatState => ({ status: 'idle', model: null, effort: null, worktree: false, addDirs: [], permissionMode: 'default', sessionId: null, costUsd: 0, turns: 0, durationMs: 0, contextTokens: 0, contextWindow: null, autoCompact: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, slashCommands: [], tools: [], pending: 0, error: null, startedAt: Date.now(), segmentTitles: {}, chatTitle: '' });
const PASTE = /<\/?.?pasted_content(?:\s[^>]*)?>/gi;
export const cleanChatTitle = (text: string) => text.replace(PASTE, ' ').replace(/\s+/g, ' ').trim();
const titleUsersFromItems = (items: Item[]) => {
  const since = lastIndexWhere(items, item => item.kind === 'divider');
  return items.slice(since + 1).filter((item): item is Extract<Item, { kind: 'user' }> => item.kind === 'user').map(item => ({ kind: 'user' as const, text: item.text }));
};
export const resolveChatTitle = (titles: ChatSegmentTitles = {}, users: { kind: 'user'; text: string }[] = []): string => {
  for (const source of ['custom', 'ai', 'agent'] as const) {
    const value = cleanChatTitle(titles[source] ?? '');
    if (value) return value.slice(0, 80);
  }
  for (const event of users) {
    const text = cleanChatTitle(event.text);
    if (text && !isChatSlashCommand(text)) return text.slice(0, 80);
  }
  const first = users.map(event => cleanChatTitle(event.text)).find(Boolean);
  return first ? first.slice(0, 80) : '';
};
const refreshViewTitle = (view: ChatView, segmentTitles: ChatSegmentTitles) => ({ ...view, state: { ...view.state, segmentTitles, chatTitle: resolveChatTitle(segmentTitles, titleUsersFromItems(view.items)) } });
export const emptyView = (): ChatView => ({ items: [], results: {}, live: {}, liveId: null, tasks: {}, thinkingTokens: 0, compacting: false, steers: [], approvals: [], seq: 0, state: emptyState(), ready: false });

const MAX_ITEMS = 2000, MAX_TOOL_JSON = 8192;
// Array#findLastIndex without the ES2023 lib.
export function lastIndexWhere<T>(list: readonly T[], test: (value: T) => boolean) { for (let at = list.length - 1; at >= 0; at--) if (test(list[at])) return at; return -1; }
const blockText = (block: Block) => block.type === 'text' || block.type === 'thinking' ? block.text.trim() : '';
export const isPartial = (item: Item) => item.kind === 'assistant' && item.blocks.some(block => block.partial);

// ---- "process" and "result" inside one turn ----
// A turn can run: tools and short remarks, a result with a question, more tools, the final answer. Only the tool/thinking stretches fold under a "과정"
// header; every result stays plain text where it was said. A text is a result (not a remark) when it is the turn's closing text, long, structured
// (heading, table, code, list), spans paragraphs, or asks something.
const STRUCTURED = /^\s*(?:#{1,6}\s|\|.*\||```|(?:[-*]|\d+\.)\s.+\n\s*(?:[-*]|\d+\.)\s)/m;
/** A tool call the Claude Code auto-mode classifier refused: not a tool failure, so it is drawn apart from errors. Returns the classifier's reason (may be empty), or null when the text is anything else. */
export const autoDenial = (text: string): { reason: string } | null => /denied by the Claude Code auto mode classifier/i.test(text) ? { reason: /Reason:\s*\[([^\]]+)\]/.exec(text)?.[1] ?? '' } : null;
export const isResultText = (text: string) => { const value = text.trim(); return value.length > 240 || (value.length > 120 && /\n\s*\n/.test(value)) || STRUCTURED.test(value) || /[?？]$/.test(value); };
export type ProcessGroup = { start: number; end: number; steps: number; tools: number; answered: boolean }; // blocks [start, end) of the turn; `answered`: a result follows
// `blocks` are the turn's visible blocks in order. `plain[i]` is true for the ones drawn as plain text; each group is one unbroken stretch of the rest.
export function processGroups(blocks: { block: Block; sub: boolean }[]): { plain: boolean[]; groups: ProcessGroup[] } {
  let cut = blocks.length;
  while (cut > 0 && blocks[cut - 1].block.type === 'text' && !blocks[cut - 1].sub) cut -= 1; // the closing text
  const isStep = (entry: { block: Block; sub: boolean }) => entry.block.type !== 'text' || entry.sub; // a sub-agent's text is process by nature
  // An Agent call is a card of its own (its subagent is tracked apart), so it never folds away under "과정".
  const plain = blocks.map((entry, at) => at >= cut || (entry.block.type === 'text' && !entry.sub && isResultText(entry.block.text)) || (entry.block.type === 'tool_use' && isAgentTool(entry.block.name)));
  const groups: ProcessGroup[] = [];
  for (let at = 0; at < blocks.length;) {
    if (plain[at]) { at += 1; continue; }
    let end = at; while (end < blocks.length && !plain[end]) end += 1;
    const steps = blocks.slice(at, end).filter(isStep);
    // Remarks with no tool or thought among them are just text: nothing to fold.
    if (!steps.length) for (let i = at; i < end; i++) plain[i] = true;
    else groups.push({ start: at, end, steps: steps.length, tools: steps.filter(entry => entry.block.type === 'tool_use').length, answered: end < blocks.length });
    at = end;
  }
  return { plain, groups };
}
// "Summary" tool display: a run of consecutive tools (thoughts in between belong to it; any text ends it) inside one process group is shown as a single
// bundle once it holds at least `min` tools. Returns blocks [start, end) of the same flat list `processGroups` took.
export type ToolRun = { start: number; end: number; tools: number };
// A thought drawn as plain text (`plainThinking`) has content of its own, so like a text it ends the run instead of hiding inside the bundle.
export function toolRuns(blocks: { block: Block; sub: boolean }[], groups: ProcessGroup[], min = 3, plainThinking = false): ToolRun[] {
  const runs: ToolRun[] = [], breaks = (block: Block) => block.type === 'text' || (plainThinking && block.type === 'thinking');
  for (const group of groups) {
    for (let at = group.start; at < group.end;) {
      if (breaks(blocks[at].block)) { at += 1; continue; }
      let end = at, tools = 0;
      while (end < group.end && !breaks(blocks[end].block)) { if (blocks[end].block.type === 'tool_use') tools += 1; end += 1; }
      // A run that starts or ends on a thought keeps only the tools' span, so a bundle never opens or closes with a lone "생각" row.
      let from = at, to = end;
      while (from < to && blocks[from].block.type !== 'tool_use') from += 1;
      while (to > from && blocks[to - 1].block.type !== 'tool_use') to -= 1;
      if (tools >= min) runs.push({ start: from, end: to, tools });
      at = end;
    }
  }
  return runs;
}
const settle = (block: Block): Block => {
  if (!block.partial) return block;
  const { partial: _partial, ...rest } = block as Block & { partialJson?: string };
  if ('partialJson' in rest) delete (rest as { partialJson?: string }).partialJson;
  return rest as Block;
};
// A turn ended (or the conversation moved on): nothing is streaming any more.
const settleItems = (items: Item[]) => {
  let out = items;
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at];
    if (item.kind !== 'assistant' || !item.blocks.some(block => block.partial)) continue;
    if (out === items) out = [...items];
    out[at] = { ...item, blocks: item.blocks.map(settle) };
  }
  return out;
};
const findAssistant = (items: Item[], id: string) => { for (let at = items.length - 1; at >= 0; at--) { const item = items[at]; if (item.kind === 'assistant' && item.id === id) return at; } return -1; };
const append = (view: ChatView, item: Item): ChatView => ({ ...view, items: [...view.items, item].slice(-MAX_ITEMS) });

// What a tool's input says so far, while its JSON is still arriving (`input_json_delta`): the whole object once it parses, else the string fields the card summary uses.
const PARTIAL_KEYS = /"(command|description|file_path|notebook_path|pattern|url|query|path|prompt|subagent_type)"\s*:\s*"((?:[^"\\]|\\.)*)/g;
export function partialToolInput(json: string): Record<string, any> {
  try { const value = JSON.parse(json); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* still arriving */ }
  const out: Record<string, string> = {};
  for (const match of json.matchAll(PARTIAL_KEYS)) {
    if (match[1] in out) continue;
    const raw = match[2].replace(/\\(u[0-9a-fA-F]{0,3})?$/, '');
    try { out[match[1]] = JSON.parse(`"${raw}"`); } catch { out[match[1]] = raw; }
  }
  return out;
}

// One live delta into the blocks of its message. Blocks are found by key, so a delta never lands on another block's text.
function applyDelta(blocks: Block[], event: any): Block[] {
  const index = Number(event.index) || 0;
  if (event.phase === 'text' || event.phase === 'thinking') {
    const type: 'text' | 'thinking' = event.phase, key = `d${index}:${type}`, chunk = String(event.text ?? '');
    if (!chunk) return blocks;
    const at = blocks.findIndex(block => block.key === key);
    if (at < 0) return [...blocks, { type, text: chunk, key, partial: true }];
    const prev = blocks[at] as Extract<Block, { type: 'text' | 'thinking' }>, next = [...blocks];
    next[at] = { ...prev, text: prev.text + chunk, partial: true };
    return next;
  }
  if (event.phase === 'tool') {
    const id = String(event.id ?? ''), input = event.input && typeof event.input === 'object' ? event.input : undefined;
    const at = blocks.findIndex(block => block.type === 'tool_use' && block.id === id);
    if (at >= 0) { if (!input) return blocks; const next = [...blocks]; next[at] = { ...(blocks[at] as Extract<Block, { type: 'tool_use' }>), input }; return next; }
    return [...blocks, { type: 'tool_use', id, name: String(event.name ?? ''), input: input ?? {}, slot: index, key: `t:${id}`, partial: true }];
  }
  if (event.phase === 'toolInput') {
    const at = lastIndexWhere(blocks, block => block.type === 'tool_use' && Boolean(block.partial) && block.slot === index);
    if (at < 0) return blocks;
    const prev = blocks[at] as Extract<Block, { type: 'tool_use' }>;
    if ((prev.partialJson?.length ?? 0) >= MAX_TOOL_JSON) return blocks;
    const partialJson = ((prev.partialJson ?? '') + String(event.text ?? '')).slice(0, MAX_TOOL_JSON), next = [...blocks];
    next[at] = { ...prev, partialJson, input: partialToolInput(partialJson) };
    return next;
  }
  return blocks;
}

// A stored message into the blocks already there. Claude sends one event per content block under one message id, and the streamed block it
// completes is replaced in place (same key). A later block never erases the text said before it.
function absorb(existing: Block[], incoming: Block[]): Block[] {
  const blocks = [...existing];
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    const { key: _key, partial: _partial, ...block } = raw as Block;
    if (block.type === 'tool_use') {
      const at = blocks.findIndex(item => item.type === 'tool_use' && item.id === block.id);
      if (at >= 0) blocks[at] = { ...block, key: blocks[at].key ?? `t:${block.id}` }; else blocks.push({ ...block, key: `t:${block.id}` });
      continue;
    }
    if (block.type !== 'text' && block.type !== 'thinking') { blocks.push({ ...block, key: `b${blocks.length}` } as Block); continue; }
    const next = blockText(block as Block), streamed = blocks.findIndex(item => item.type === block.type && item.partial);
    if (streamed >= 0) {
      const prev = blockText(blocks[streamed]);
      if (!next) { blocks[streamed] = settle(blocks[streamed]); continue; }
      // Stored thinking is the whole of that message's thinking (Codex joins its parts differently than they streamed): it always replaces.
      if (block.type === 'thinking' || !prev || next.startsWith(prev) || prev.startsWith(next)) { blocks[streamed] = { ...block, key: blocks[streamed].key } as Block; continue; }
      blocks[streamed] = settle(blocks[streamed]); // a different text: the streamed one stays and the stored one follows it
    }
    const last = blocks.at(-1);
    if (last?.type === block.type && !last.partial) {
      const previous = blockText(last);
      if (!next || !previous || next.startsWith(previous) || previous.startsWith(next)) { if (next) blocks[blocks.length - 1] = { ...block, key: last.key } as Block; continue; }
    }
    if (!next || blocks.some(item => item.type === block.type && blockText(item) === next)) continue;
    blocks.push({ ...block, key: `b${blocks.length}` } as Block);
  }
  return blocks;
}

// Commands whose answer is a report to read, so it is shown as a chat message instead of a one-line system note or a monospaced card.
export const CHAT_FORMAT = new Set(['cost', 'context', 'status', 'usage']);
// The name of the slash command the current turn started with ('' when it did not start with one).
function lastSlashName(view: ChatView): string {
  for (let at = view.items.length - 1; at >= 0; at--) {
    const item = view.items[at];
    if (item.kind === 'user') return parseChatSlashCommand(item.text)?.name ?? '';
    if (item.kind === 'divider') return '';
  }
  return '';
}

// A finished turn that showed nothing (a slash command answered only in `result`, or not at all) still gets a line under its command.
function commandFallback(view: ChatView, event: any, key: string): ChatView {
  let user = -1;
  for (let at = view.items.length - 1; at >= 0; at--) { const kind = view.items[at].kind; if (kind === 'user') { user = at; break; } if (kind === 'divider') return view; }
  if (user < 0 || view.items.slice(user + 1).some(item => item.kind === 'assistant' || item.kind === 'command' || item.kind === 'info' || item.kind === 'compact' || item.kind === 'error')) return view;
  const text = typeof event.text === 'string' ? event.text.trim() : '', lead = view.items[user] as Extract<Item, { kind: 'user' }>;
  if (text) return append(view, CHAT_FORMAT.has(parseChatSlashCommand(lead.text)?.name ?? '') ? { kind: 'info', key, text, fresh: view.ready } : { kind: 'command', key, text, isError: false, fresh: view.ready });
  return isChatSlashCommand(lead.text) ? append(view, { kind: 'command', key, text: '', isError: false, fresh: view.ready }) : view;
}

// Applies one server event. Stored events carry `seq` (a replayed or doubly delivered one is ignored); `delta` events are live-only.
export function reduce(view: ChatView, event: any): ChatView {
  if (!event || typeof event !== 'object') return view;
  if (typeof event.seq === 'number') { if (event.seq <= view.seq) return view; view = { ...view, seq: event.seq }; }
  const key = `e${event.seq ?? Math.random()}`, fresh = view.ready;
  switch (event.kind) {
    case 'user': return refreshViewTitle(append(view, { kind: 'user', key, text: String(event.text ?? ''), images: Number(event.images) || 0, previews: previewsOf(event), fresh }), view.state.segmentTitles ?? {});
    case 'title': {
      const source = event.source === 'custom' || event.source === 'ai' ? event.source : 'agent';
      const text = cleanChatTitle(String(event.text ?? ''));
      if (!text) return view;
      const segmentTitles = { ...view.state.segmentTitles, [source]: text };
      return refreshViewTitle(view, segmentTitles);
    }
    case 'message': {
      const messageId = String(event.id ?? key), incoming: Block[] = Array.isArray(event.blocks) ? event.blocks : [];
      const uuid = typeof event.uuid === 'string' ? { uuid: event.uuid } : {}, at = findAssistant(view.items, messageId);
      if (at < 0) {
        // After /compact the CLI re-sends earlier synthetic messages (what /context or /mcp printed) under a fresh id but the same uuid: a repeat, not a new reply.
        if (typeof event.uuid === 'string' && view.items.some(item => item.kind === 'assistant' && item.uuid === event.uuid)) return view;
        return append(view, { kind: 'assistant', key, id: messageId, ...uuid, blocks: absorb([], incoming), sub: Boolean(event.parentToolUseId), ...parentOf(event), fresh });
      }
      const prev = view.items[at] as AssistantItem, items = [...view.items];
      items[at] = { ...prev, ...uuid, sub: prev.sub || Boolean(event.parentToolUseId), ...(prev.parent ? {} : parentOf(event)), blocks: absorb(prev.blocks, incoming) };
      return { ...view, items };
    }
    case 'task': {
      const id = typeof event.toolUseId === 'string' ? event.toolUseId : '';
      if (!id) return view;
      const prev = view.tasks[id] ?? {}, at = Number(event.at) || Date.now(), { kind: _k, phase, toolUseId: _t, seq: _s, at: _a, ...info } = event;
      const next: TaskInfo = { ...prev, ...info, ...(phase === 'start' && { startedAt: at }), ...(phase === 'end' && { endedAt: at, activity: '' }) };
      return { ...view, tasks: { ...view.tasks, [id]: next } };
    }
    case 'tool_result': return { ...view, results: { ...view.results, [event.toolUseId]: { content: String(event.content ?? ''), isError: event.isError === true } } };
    case 'command_output': {
      const text = String(event.text ?? ''), isError = event.isError === true;
      // The CLI confirms a model switch itself; the line ADE writes (with the model's colour) already says so.
      if (!isError && /^Set model to /.test(text)) return view;
      return !isError && text.trim() && CHAT_FORMAT.has(lastSlashName(view)) ? append(view, { kind: 'info', key, text, fresh }) : append(view, { kind: 'command', key, text, isError, fresh });
    }
    case 'delta': {
      if (event.phase === 'start') {
        const messageId = String(event.messageId ?? `live-${view.items.length}`), sub = Boolean(event.parentToolUseId);
        return { ...view, live: { ...view.live, [messageId]: { sub, ...parentOf(event) } }, liveId: messageId, thinkingTokens: sub ? view.thinkingTokens : 0 };
      }
      if (event.phase === 'thinkingTokens') return { ...view, thinkingTokens: Number(event.tokens) || 0 };
      if (event.phase === 'compacting') return { ...view, compacting: event.active === true };
      if (!['text', 'thinking', 'tool', 'toolInput'].includes(event.phase)) return view;
      const messageId = String(event.messageId ?? view.liveId ?? 'live-0'), at = findAssistant(view.items, messageId);
      const base: AssistantItem = at >= 0 ? view.items[at] as AssistantItem
        : { kind: 'assistant', key: `m:${messageId}`, id: messageId, blocks: [], sub: view.live[messageId]?.sub ?? Boolean(event.parentToolUseId), ...(view.live[messageId]?.parent ? { parent: view.live[messageId].parent } : parentOf(event)), fresh };
      const blocks = applyDelta(base.blocks, event);
      if (blocks === base.blocks) return view;
      const item = { ...base, blocks };
      if (at < 0) return { ...append(view, item), liveId: messageId };
      const items = [...view.items]; items[at] = item;
      return { ...view, items, liveId: messageId };
    }
    case 'approval': {
      if (event.phase === 'request') return { ...view, approvals: [...view.approvals.filter(item => item.requestId !== event.requestId), { requestId: event.requestId, tool: event.tool, input: event.input, toolUseId: event.toolUseId, questions: event.questions, suggestions: event.suggestions ?? [] }] };
      return { ...view, approvals: view.approvals.filter(item => item.requestId !== event.requestId) };
    }
    case 'result': {
      let results = view.results;
      if (event.status === 'interrupted' || event.status === 'failed') {
        const text = event.status === 'interrupted' ? '응답을 중단했습니다.' : '응답에 실패했습니다.';
        for (const item of view.items) if (item.kind === 'assistant') for (const block of item.blocks) if (block.type === 'tool_use' && !results[block.id]) { if (results === view.results) results = { ...results }; results[block.id] = { content: text, isError: true }; }
      }
      view = { ...view, items: settleItems(view.items), results, compacting: false, live: {}, liveId: null };
      if (event.status === 'interrupted') return { ...append(view, { kind: 'note', key, text: '응답을 중단했습니다.', fresh }), approvals: [] };
      if (event.status === 'failed') return append(view, { kind: 'error', key, message: event.text || '응답에 실패했습니다.', fresh });
      return commandFallback(view, event, key);
    }
    case 'error': return { ...append(view, { kind: 'error', key, message: String(event.message ?? '오류'), recoverable: event.recoverable === true, fresh }), state: { ...view.state, error: String(event.message ?? '오류'), recoverable: event.recoverable === true || view.state.recoverable } };
    case 'compact': return { ...append(view, { kind: 'compact', key, trigger: event.trigger === 'auto' ? 'auto' : 'manual', preTokens: Number.isFinite(event.preTokens) ? event.preTokens : null, postTokens: Number.isFinite(event.postTokens) ? event.postTokens : null, fresh }), compacting: false };
    case 'divider': return refreshViewTitle({ ...append({ ...view, items: settleItems(view.items) }, { kind: 'divider', key, fresh }), live: {}, liveId: null, approvals: [], steers: [], thinkingTokens: 0 }, {});
    // A steering message waits below the running reply until the turn takes it in; then it is an ordinary user message at that point. Cancelled: it just goes away.
    case 'steer': {
      const rest = view.steers.filter(item => item.uuid !== event.uuid);
      if (event.phase === 'queued') return { ...view, steers: [...rest, { uuid: String(event.uuid), text: String(event.text ?? ''), images: Number(event.images) || 0, previews: previewsOf(event) }] };
      if (event.phase === 'applied') return { ...append(view, { kind: 'user', key, text: String(event.text ?? ''), images: Number(event.images) || 0, previews: previewsOf(event), fresh }), steers: rest };
      return { ...view, steers: rest };
    }
    // Rewind: everything after that assistant message is gone (a replayed transcript lands on the same view).
    case 'rewind': {
      const at = view.items.findIndex(item => item.kind === 'assistant' && item.uuid === event.uuid);
      return at < 0 ? view : { ...view, items: [...settleItems(view.items.slice(0, at + 1)), { kind: 'note', key, text: '여기까지 되돌렸습니다. 이후 대화는 이어지지 않습니다. 에이전트가 이미 바꾼 파일은 그대로입니다.', fresh }], live: {}, liveId: null, approvals: [], thinkingTokens: 0 };
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
  // Not capped: a gauge stuck at 100% hid that the context had already outgrown the window.
  return { percent: Math.round(state.contextTokens * 100 / basis), used: state.contextTokens, basis, max, autoCompact: Boolean(compact), autoEstimated: Boolean(compact?.auto) };
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
const rowNewestFirst = (a: ModelRow, b: ModelRow) => compareVersion(a.version, b.version) || familyRank(a.family) - familyRank(b.family) || Number(a.oneM) - Number(b.oneM) || a.label.localeCompare(b.label);
const codexFamily = (row: ModelRow) => /(?:^|[^a-z])(astra|sol|terra|luna)(?![a-z])/i.exec(`${row.id} ${row.label}`)?.[1].toLowerCase() ?? 'other';
const pickTopPerGroup = (rows: ModelRow[], group: (row: ModelRow) => string, keepAll?: (row: ModelRow) => boolean) => {
  const fixed: ModelRow[] = [], groups = new Map<string, ModelRow[]>();
  for (const row of rows) {
    if (keepAll?.(row)) { fixed.push(row); continue; }
    const key = group(row); groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...fixed, ...[...groups.values()].map(group => group.sort(rowNewestFirst)[0])];
};
// Quick menu: Claude keeps CLI `main` rows; Codex one top model per family; Cursor one top per third-party provider plus every Cursor provider model.
export function modelQuickDefaults(rows: ModelRow[], agent: 'claude' | 'codex' | 'cursor'): ModelRow[] {
  if (agent === 'claude') return rows.filter(row => row.main);
  if (agent === 'codex') return pickTopPerGroup(rows, codexFamily);
  return pickTopPerGroup(rows, row => modelProvider(row.id)?.id ?? 'other', row => modelProvider(row.id)?.id === 'cursor');
}
export function modelQuickRows(rows: ModelRow[], agent: 'claude' | 'codex' | 'cursor', pins: string[] = []): ModelRow[] {
  const byValue = new Map(rows.map(row => [row.value, row])), defaults = modelQuickDefaults(rows, agent), seen = new Set<string>();
  const push = (list: ModelRow[]) => list.filter(row => { if (seen.has(row.value)) return false; seen.add(row.value); return true; });
  const order = new Map(rows.map((row, index) => [row.value, index]));
  return push([...defaults, ...pins.map(value => byValue.get(value)).filter((row): row is ModelRow => Boolean(row))])
    .sort((a, b) => (order.get(a.value) ?? 0) - (order.get(b.value) ?? 0));
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
export const parseContextSetting = (value: string | null | undefined) => contextRank((value ?? '').trim());
// Claude reports from the first turn; Codex/Cursor only after usage_update or a known window from config.
export const contextReported = (state: Pick<ChatState, 'agent' | 'contextTokens' | 'contextWindow'>) =>
  state.agent === 'claude' || state.contextTokens > 0 || (state.contextWindow ?? 0) > 0;
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
export const effortStyle: Record<string, { color: string; icon?: string; bars?: number }> = {
  none: { color: '#8b93a0', icon: 'remove' }, minimal: { color: '#7fb8a4', bars: 1 },
  low: { color: '#5ec9a0', bars: 1 }, medium: { color: '#6fa8f0', bars: 2 },
  high: { color: '#b58cf0', bars: 4 }, xhigh: { color: '#f0a04b', icon: 'bolt' },
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
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}시간 ${Math.floor(seconds % 3600 / 60)}분 ${seconds % 60}초` : seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`;
}
export const permissionLabels: Record<string, string> = { default: '기본', acceptEdits: '편집 허용', plan: '계획', auto: '자동', bypassPermissions: 'Bypass', ask: '질문 전용' };
// Resolved on the chat pane via agent-scoped `--mode-*` vars in style.css (Claude Code theme.ts, Codex TUI, Cursor CLI).
export const permissionModeColor = (mode: string) => `var(--mode-${mode}, var(--muted))`;
export const statusLabelsKo: Record<ChatState['status'], string> = { idle: '대기 중', working: '응답 중', attention: '승인 대기', closed: '종료' };

// "{model} · {ctx}" style templates; unknown tokens stay as typed so a typo is visible.
export const fillFormat = (format: string, values: Record<string, string>) => format.replace(/\{(\w+)\}/g, (whole, name) => name in values ? values[name] : whole);

// The particle "-(으)로" for a word: 로 after a vowel or ㄹ, 으로 after any other final consonant. Digits are read aloud ("5" is 오); for anything else (Latin
// letters, symbols) the pronunciation is unknown, so the neutral "(으)로" is returned.
export function ro(word: string): string {
  const last = word.trim().slice(-1), code = last.charCodeAt(0);
  if (code >= 0xAC00 && code <= 0xD7A3) { const final = (code - 0xAC00) % 28; return final === 0 || final === 8 ? '로' : '으로'; }
  if (/[0-9]/.test(last)) return '036'.includes(last) ? '으로' : '로';
  return '(으)로';
}

// The line that says what was switched. Model and Effort share one kind of line ("이제부터 Sonnet 5.5, 높음으로 작업합니다."), a permission mode has its own
// ("계획 모드로 변경했습니다."). The particle after an Effort follows its last sound.
export function settingsLine(change: SettingsChange): { text: string; tones: Tone[] } {
  const { model, effort, mode } = change;
  if (mode) return { text: `${mode.value}로 변경했습니다.`, tones: [mode] };
  if (model && effort) return { text: `이제부터 ${model.value}, ${effort.value}${ro(effort.value)} 작업합니다.`, tones: [model, effort] };
  if (model) return { text: `이제부터 ${model.value} 모델로 작업합니다.`, tones: [model] };
  if (effort) return { text: `이제부터 ${effort.value} 추론 강도로 작업합니다.`, tones: [effort] };
  return { text: '', tones: [] };
}

// Switching again right after a switch edits that line instead of adding another one, as long as the line just above is the same kind (a model/Effort line for a
// model or Effort, a mode line for a mode). A model and an Effort switched back to back share one line, and a setting that was changed once stays on its line even
// when it is switched back to what it was. Anything in between (a message, an answer, the other kind of line) means the next switch gets a line of its own.
export function withSettingChange(items: Item[], change: SettingsChange, key: string): Item[] {
  const { mode, ...rest } = change;
  const upsert = (list: Item[], next: SettingsChange, id: string): Item[] => {
    const last = list.at(-1);
    if (last?.kind === 'note' && last.local && last.change && Boolean(last.change.mode) === Boolean(next.mode)) {
      const merged = { ...last.change, ...next };
      return [...list.slice(0, -1), { ...last, change: merged, ...settingsLine(merged), rev: (last.rev ?? 0) + 1, fresh: false }];
    }
    return [...list, { kind: 'note', key: id, local: true, change: next, ...settingsLine(next), fresh: true }];
  };
  let result = items;
  if (rest.model || rest.effort) result = upsert(result, rest, key);
  if (mode) result = upsert(result, { mode }, `${key}m`);
  return result;
}

// ---- subagents (Claude's Agent/Task calls) ----
export const isAgentTool = (name: string) => name === 'Agent' || name === 'Task';
export type TaskInfo = { description?: string; agentType?: string; background?: boolean; activity?: string; lastTool?: string; status?: string; report?: string; tokens?: number; toolUses?: number; durationMs?: number; startedAt?: number; endedAt?: number };
export type AgentStatus = 'running' | 'done' | 'error' | 'stopped';
export type SubAgent = { id: string; type: string; description: string; prompt: string; background: boolean; status: AgentStatus; startedAt?: number; endedAt?: number; durationMs?: number;
  tokens?: number; toolCount: number; now: string; report: string; items: AssistantItem[] };
type ToolUse = Extract<Block, { type: 'tool_use' }>;
// Every Agent call in `items`, in order, with what its subagent did (its own messages are the items whose `parent` is the call).
// Status: the CLI's end report wins; a background one without it runs while its child lives (`liveTasks`); a foreground one is over once its result is in.
export function agentsOf(items: Item[], results: ChatView['results'], tasks: ChatView['tasks'], busy: boolean, liveTasks?: string[]): SubAgent[] {
  const children = new Map<string, AssistantItem[]>();
  for (const item of items) if (item.kind === 'assistant' && item.parent) { const list = children.get(item.parent); if (list) list.push(item); else children.set(item.parent, [item]); }
  const agents: SubAgent[] = [];
  for (const item of items) {
    if (item.kind !== 'assistant') continue;
    for (const block of item.blocks) {
      if (block.type !== 'tool_use' || !isAgentTool(block.name)) continue;
      const input = block.input ?? {}, task = tasks[block.id], result = results[block.id], kids = children.get(block.id) ?? [];
      const background = task?.background ?? input.run_in_background === true;
      const tools = kids.flatMap(kid => kid.blocks.filter((child): child is ToolUse => child.type === 'tool_use'));
      const work = tools.filter(tool => tool.name !== 'SubagentHandback'), last = work.at(-1), handback = tools.filter(tool => tool.name === 'SubagentHandback').at(-1);
      let status: AgentStatus;
      if (task?.status) status = task.status === 'completed' ? 'done' : task.status === 'failed' ? 'error' : 'stopped';
      else if (result?.isError) status = 'error';
      else if (background) status = task ? (liveTasks ? (liveTasks.includes(block.id) ? 'running' : 'stopped') : 'running') : busy ? 'running' : 'done';
      else status = result ? 'done' : busy ? 'running' : 'stopped';
      agents.push({
        id: block.id, type: String(task?.agentType || input.subagent_type || 'general-purpose'), description: String(task?.description || input.description || ''), prompt: String(input.prompt ?? ''), background, status,
        startedAt: task?.startedAt, endedAt: task?.endedAt, durationMs: task?.durationMs, tokens: task?.tokens,
        toolCount: Math.max(work.length, task?.toolUses ?? 0),
        now: status !== 'running' ? '' : task?.activity || (last ? `${toolLabel(last.name)} ${toolSummary(last.name, last.input ?? {})}`.trim() : task?.lastTool ?? ''),
        report: task?.report || (!background && result && !result.isError ? result.content : '') || (handback ? String(handback.input?.message ?? '') : ''),
        items: kids
      });
    }
  }
  return agents;
}

// ---- a plan (ExitPlanMode) cut into its `##` sections, so a long one can be skimmed ----
// The leading `# ` line is the plan's title. Text before the first `##` is a section with no title. Fenced code is never split.
export type PlanSection = { title: string; body: string; items: number };
export function planSections(plan: string): { title: string; sections: PlanSection[] } {
  const lines = plan.replace(/\r\n?/g, '\n').split('\n'), first = lines.findIndex(line => line.trim());
  let title = '';
  if (first >= 0 && /^#\s/.test(lines[first])) { title = lines[first].replace(/^#\s+/, '').trim(); lines.splice(first, 1); }
  const sections: PlanSection[] = [];
  let current = { title: '', rows: [] as string[] }, fence = false;
  const flush = () => { const body = current.rows.join('\n').trim(); if (current.title || body) sections.push({ title: current.title, body, items: current.rows.filter(row => /^\s*(?:[-*+]|\d+\.)\s/.test(row)).length }); };
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^##\s/.test(line)) { flush(); current = { title: line.replace(/^##\s+/, '').replace(/\s*#+\s*$/, '').trim(), rows: [] }; } else current.rows.push(line);
  }
  flush();
  return { title, sections };
}

// Which Agent tool call a subagent's message belongs to (its tool_use id), so parallel subagents stay apart.
const parentOf = (event: any): { parent?: string } => typeof event.parentToolUseId === 'string' && event.parentToolUseId ? { parent: event.parentToolUseId } : {};

// A session's cost: under $0.1 five decimals (small turns still show), from $0.1 two.
export const dollars = (value: number) => value < 0.1 ? value.toFixed(5) : value.toFixed(2);

// One name for what a tool is called in the UI (internal ones read as what they do).
export const toolLabel = (name: string) => name === 'SubagentHandback' ? '보고' : mcpTool(name) ? `${mcpTool(name)!.server} · ${mcpTool(name)!.tool}` : name;

// An MCP tool is called `mcp__<server>__<tool>`: shown as the server ("Claude Docs") and the tool ("update"), not the raw id.
export function mcpTool(name: string): { server: string; tool: string } | null {
  const hit = /^mcp__(.+?)__(.+)$/.exec(name);
  return hit ? { server: hit[1].replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ').trim() || hit[1], tool: hit[2] } : null;
}

// What an MCP call is about, from its input: the first readable field (title, name, query, path …) found up to three levels deep, else a few key=value pairs.
// A string list (guide topics) joins; markdown heading marks are dropped, so an inline "## 개요 …" reads as 개요 ….
const MCP_KEYS = ['title', 'name', 'query', 'q', 'url', 'path', 'description', 'text', 'content', 'message', 'command', 'topic', 'items', 'id'];
export function mcpSummary(input: any): string {
  const clean = (value: string) => value.replace(/^[\s#>*-]+/, '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const find = (value: any, key: string, depth: number): string => {
    if (!value || typeof value !== 'object' || depth > 3) return '';
    const own = value[key];
    if (typeof own === 'string' && own.trim()) return clean(own);
    if (Array.isArray(own) && own.length && own.every(item => typeof item === 'string')) return clean(own.join(', '));
    for (const child of Array.isArray(value) ? value : Object.values(value)) { const hit = find(child, key, depth + 1); if (hit) return hit; }
    return '';
  };
  for (const key of MCP_KEYS) { const hit = find(input, key, 0); if (hit) return hit; }
  const pairs = Object.entries(input ?? {}).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 3).map(([key, value]) => `${key}: ${value}`);
  return pairs.length ? clean(pairs.join(' · ')) : '';
}

// A document / page the agent published on claude.ai (the Artifact tool, or the Claude Docs connector): the link comes back in the tool's result.
export type ArtifactRef = { url: string; title: string; toolUseId: string };
const ARTIFACT_URL = /https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+/;
export function artifactsOf(blocks: Block[], results: Record<string, { content: string; isError: boolean }>): ArtifactRef[] {
  const found = new Map<string, ArtifactRef>();
  for (const block of blocks) {
    if (block.type !== 'tool_use' || !(block.name === 'Artifact' || /^mcp__.+__(batch|create|update|publish)$/.test(block.name))) continue; // read / guide results may quote other links
    const result = results[block.id], url = !result || result.isError ? undefined : ARTIFACT_URL.exec(result.content)?.[0];
    if (!url) continue;
    const input = block.input ?? {}, title = String(input.title ?? input.name ?? input.container?.create?.name ?? input.container?.create?.title ?? '').trim();
    const prev = found.get(url);
    if (!prev) found.set(url, { url, title, toolUseId: block.id });
    else if (!prev.title && title) prev.title = title;
  }
  return [...found.values()];
}

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
    case 'AskUserQuestion': { const asked = Array.isArray(input?.questions) ? input.questions : []; return line(text(asked[0]?.question)) + (asked.length > 1 ? ` 외 ${asked.length - 1}개` : ''); }
    case 'ExitPlanMode': return line((text(input?.plan).split(/\r?\n/).filter(row => row.trim()).find(row => !/^\s*#/.test(row)) ?? text(input?.plan).split(/\r?\n/).filter(row => row.trim())[0] ?? '').replace(/^[\s#>*-]+/, ''));
    case 'SubagentHandback': return line(text(input?.message));
    case 'TodoWrite': return `${Array.isArray(input?.todos) ? input.todos.length : 0}개 항목`;
    default: if (mcpTool(name)) return mcpSummary(input);
      return line(text(input?.description) || text(input?.command) || text(input?.path) || text(input?.query) || JSON.stringify(input ?? {}));
  }
}

// ---- answering a question (Claude's AskUserQuestion, Codex's requestUserInput, Cursor's ask_question) ----
// A person's picks for one question: the options chosen, and their own wording ("직접 입력"; null = not used, '' = chosen but still empty).
export type QuestionPick = { options: string[]; other: string | null };
export const emptyPick = (question: ChatQuestion): QuestionPick => ({ options: [], other: question.options?.length ? null : '' }); // a question with no options is only a text box
export function pickOption(question: ChatQuestion, pick: QuestionPick, id: string): QuestionPick {
  if (!question.allowMultiple) return { options: [id], other: null };
  return { ...pick, options: pick.options.includes(id) ? pick.options.filter(item => item !== id) : [...pick.options, id] };
}
export function pickOther(question: ChatQuestion, pick: QuestionPick, other: string | null): QuestionPick {
  return question.allowMultiple || !question.options?.length ? { ...pick, other } : { options: other === null ? pick.options : [], other };
}
// The answers the server takes: per question id, the chosen option ids followed by the typed text.
export function questionAnswers(questions: ChatQuestion[], picks: Record<string, QuestionPick>): Record<string, string[]> {
  return Object.fromEntries(questions.map(question => { const pick = picks[question.id] ?? emptyPick(question), typed = pick.other?.trim(); return [question.id, [...pick.options, ...(typed ? [typed] : [])]]; }));
}
export const questionsAnswered = (questions: ChatQuestion[], answers: Record<string, string[]>) => questions.length > 0 && questions.every(question => (answers[question.id]?.length ?? 0) > 0);

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
