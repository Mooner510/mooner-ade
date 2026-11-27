// The order of the slash menu. With only `/` typed it leads with the handful of ADE commands people miss (each with a short line on what it is for), then the
// commands this user ran most recently, then the rest by name. Once a name is typed it is the plain prefix match it always was. Pure, so node tests load it.

export type SlashCommand = { name: string; description: string; hint?: string };
export type SlashGroup = 'featured' | 'recent' | 'all';
export type SlashEntry = SlashCommand & { group: SlashGroup };

/** The ADE commands shown first, in this order, with the short line the menu shows for them (only those this chat has; `agents` limits one to some CLIs). */
export const FEATURED_SLASH: { name: string; description: string; agents?: string[] }[] = [
  { name: 'btw', description: '곁가지 질문, 대화 기록에 남지 않고 응답 중에도 가능' },
  { name: 'resume', description: '이 프로젝트의 이전 대화 이어가기' },
  { name: 'usage', description: '컨텍스트·비용·사용 한도를 카드로 보기' },
  { name: 'stats', description: '이 세션의 토큰·비용·도구 통계', agents: ['claude'] },
  { name: 'limit', description: '이 채팅의 비용·사용량 제한 정하기' },
  { name: 'idlecompact', description: '캐시가 식기 전에 자동 압축 (기본 꺼짐)', agents: ['claude'] },
  { name: 'retry', description: '마지막 요청을 같은 세션으로 다시 보내기' },
];
export const RECENT_SLASH_SHOWN = 5;
const RECENT_KEPT = 12, MENU_MAX = 16;

/** The menu for `query` (the text after `/`). `hidden`: runnable commands not offered until typed out in full. */
export function slashMenu(available: readonly SlashCommand[], query: string, { agent, recent = [], hidden = new Set<string>(), max = MENU_MAX }: { agent: string; recent?: readonly string[]; hidden?: ReadonlySet<string>; max?: number }): SlashEntry[] {
  const needle = query.toLowerCase();
  const offered = available.filter(item => { const name = item.name.toLowerCase(); return !hidden.has(name) || name === needle; });
  if (needle) return offered.filter(item => { const name = item.name.toLowerCase(); return name.startsWith(needle) || name.split(':').some(part => part.startsWith(needle)); }).slice(0, max).map(item => ({ ...item, group: 'all' }));
  const byName = new Map(offered.map(item => [item.name, item])), used = new Set<string>(), out: SlashEntry[] = [];
  const add = (item: SlashCommand | undefined, group: SlashGroup, description = item?.description) => { if (item && !used.has(item.name)) { used.add(item.name); out.push({ ...item, description: description ?? '', group }); } };
  for (const entry of FEATURED_SLASH) if (!entry.agents || entry.agents.includes(agent)) add(byName.get(entry.name), 'featured', entry.description);
  let shown = 0;
  for (const name of recent) { if (shown >= RECENT_SLASH_SHOWN) break; const item = byName.get(name); if (item && !used.has(name)) { add(item, 'recent'); shown++; } }
  for (const item of offered) add(item, 'all');
  return out.slice(0, max);
}

/** The recent list after running `name`: it moves to the front, the list keeps the last few distinct names. */
export const withRecentSlash = (recent: readonly string[], name: string) => name ? [name, ...recent.filter(item => item !== name)].slice(0, RECENT_KEPT) : [...recent];

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const RECENT_KEY = 'ade:slash-recent';
const store = (): Store | undefined => typeof localStorage === 'undefined' ? undefined : localStorage;
/** The names this user ran most recently, newest first (kept in this window's localStorage, like the other per-device UI memories). */
export function loadRecentSlash(storage = store()): string[] {
  try { const list = JSON.parse(storage?.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string' && /^[\w:.-]{1,80}$/.test(item)).slice(0, RECENT_KEPT) : []; }
  catch { return []; }
}
export function recordSlashUse(name: string, storage = store()): string[] {
  const next = withRecentSlash(loadRecentSlash(storage), name);
  try { storage?.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* full or blocked storage: the menu just keeps its old order */ }
  return next;
}
