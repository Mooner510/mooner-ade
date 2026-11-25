// Per-chat limits (the status line's 제한 button): when a chat reaches one, its running turn is interrupted and further sends are refused until the limit is raised, cleared or the window resets.
// A limit is { cost?, share?, usage?, compact, base?, stop? }, stored in the chat's meta (every setting is per chat):
//   cost   dollars: stop when this chat's own cost reaches it (checked at every state publish, so mid-turn too).
//   share  { window, percent }: "사용량 할당". This chat may use only that much of the provider's 5-hour or weekly window. The usage API has no per-chat number,
//          so it is estimated as the window's utilization increase since the limit was set (`base`, the reading at that moment; read again after the window resets).
//          It also counts other chats' and tools' usage on the same account: that is the only thing the API reports.
//   usage  { window, percent }: "사용량 한도". Stop when the window's utilization itself reaches the percent.
//   compact  run /compact once after a running turn was stopped by a limit (the compact bypasses the limit, and itself uses a little usage).
//   stop   { rule, running, compacted }: set while the chat is stopped by a limit.
// Window readings come from usage.js; its reading is reused for TTL and a forced read is allowed every FORCE_GAP, so that is how often a working chat asks.
export const POLL_MS = 30_000; // = usage.js FORCE_GAP (tests/chat-limit.test.mjs keeps them equal)
export const WINDOWS = { session: '5시간', weekly: '주간' };
const RESET_SLACK = 10 * 60_000; // a window whose reset time moved by more than this has been reset (the API's own value jitters by seconds)

// What this chat can be limited by: cost where the agent reports dollars (Claude; Cursor once it does), plan windows for Claude and Codex logins (not an API key, which bills dollars).
export const limitOptions = ({ agent, cost, apiKey }) => ({ cost: cost === true, windows: (agent === 'claude' || agent === 'codex') && !apiKey ? Object.keys(WINDOWS) : [] });

const windowRule = (value, options, name) => {
  if (value == null) return undefined;
  const percent = Number(value.percent);
  if (!options.windows.includes(value.window)) throw new Error(`${name}은 이 채팅에서 쓸 수 없습니다.`);
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new Error('퍼센트는 1에서 100 사이의 정수로 입력하세요.');
  return { window: value.window, percent };
};

// The limit the user asked for, checked against what this chat supports. null: no rule left (cleared). `previous` keeps the share's baseline while its window stays the same.
export function normalizeLimit(input, options, previous) {
  if (input == null || typeof input !== 'object') return null;
  const limit = { compact: input.compact === true };
  if (input.cost != null) {
    const cost = Math.round(Number(input.cost) * 100) / 100;
    if (!options.cost) throw new Error('이 채팅은 비용을 보고하지 않아 비용 제한을 쓸 수 없습니다.');
    if (!(cost > 0 && cost <= 1_000_000)) throw new Error('비용은 0보다 큰 금액(달러)으로 입력하세요.');
    limit.cost = cost;
  }
  const share = windowRule(input.share, options, '사용량 할당'), usage = windowRule(input.usage, options, '사용량 한도');
  if (share) { limit.share = share; if (previous?.share?.window === share.window && previous.base) limit.base = previous.base; }
  if (usage) limit.usage = usage;
  return limit.cost || share || usage ? limit : null;
}

// Rules in the words the thread line and the chip use: 비용 $1.00 · 5시간 사용량 80% · 주간 할당 5%.
export const ruleLabel = (kind, rule) => kind === 'cost' ? `비용 $${rule.toFixed(2)}` : `${WINDOWS[rule.window]} ${kind === 'usage' ? '사용량' : '할당'} ${rule.percent}%`;

// One look at the numbers. `windows` is the latest usage reading ([{ key, percent, resetsAt }]) or null when none was read this time (then only the cost is checked).
// Returns the rule that was reached (`hit`), the share's baseline (a new one when it was never taken or the window was reset) and the current values for the chip.
export function evaluateLimit(limit, { cost, windows }) {
  const now = {}, find = key => windows?.find(item => item.key === key);
  let hit = null, base = limit.base;
  if (limit.cost && typeof cost === 'number') { now.cost = cost; if (cost >= limit.cost) hit ??= { kind: 'cost', label: ruleLabel('cost', limit.cost) }; }
  const seen = limit.usage && find(limit.usage.window);
  if (seen) { now.usage = seen.percent; if (seen.percent >= limit.usage.percent) hit ??= { kind: 'usage', label: ruleLabel('usage', limit.usage), resetsAt: seen.resetsAt }; }
  const reading = limit.share && find(limit.share.window);
  if (reading) {
    const window = limit.share.window, reset = base?.window === window && (reading.percent < base.percent || (reading.resetsAt && base.resetsAt && reading.resetsAt - base.resetsAt > RESET_SLACK));
    if (base?.window !== window || reset) base = { window, percent: reading.percent, resetsAt: reading.resetsAt };
    now.share = reading.percent - base.percent;
    if (now.share >= limit.share.percent) hit ??= { kind: 'share', label: ruleLabel('share', limit.share), resetsAt: reading.resetsAt };
  }
  return { hit, base, now };
}

// What the page shows: the rules, whether the chat is stopped by one, and the last numbers.
export const limitView = (limit, now) => ({ ...(limit.cost && { cost: limit.cost }), ...(limit.share && { share: limit.share }), ...(limit.usage && { usage: limit.usage }), compact: limit.compact === true, stop: limit.stop?.rule ?? null, now });
