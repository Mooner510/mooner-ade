// The command palette's pure parts: the fuzzy score, the prefix modes and the recently-used order. No imports, so Node tests load it as is.

// Subsequence match; consecutive and word-start hits score higher. Returns -1 when the query does not match.
export function fuzzy(query: string, text: string) {
  if (!query) return 0;
  const lower = text.toLowerCase(), needle = query.toLowerCase();
  let score = 0, at = -1, streak = 0;
  for (const char of needle) {
    const next = lower.indexOf(char, at + 1);
    if (next < 0) return -1;
    streak = next === at + 1 ? streak + 1 : 0;
    score += 1 + streak * 2 + (next === 0 || '/._- '.includes(lower[next - 1]) ? 3 : 0);
    at = next;
  }
  return score - lower.length * .01;
}

// What one palette entry is. `all` (no prefix) mixes commands, tabs/chats and projects (settings join once something is typed); files need `@`.
export type PaletteKind = 'command' | 'tab' | 'project' | 'setting' | 'file';
export type PaletteMode = 'all' | 'command' | 'tab' | 'file' | 'setting' | 'help';
// Like VS Code's quick open: `>` commands, `@` files (VS Code uses `@` for symbols, which ADE has none of, and opens files with no prefix),
// `#` tabs, chats and projects, `,` settings sections (as mod+, opens settings), `?` lists the prefixes.
export const palettePrefixes: { prefix: string; mode: Exclude<PaletteMode, 'all'>; label: string }[] = [
  { prefix: '>', mode: 'command', label: '명령' },
  { prefix: '#', mode: 'tab', label: '탭, 채팅, 프로젝트로 이동' },
  { prefix: '@', mode: 'file', label: '파일 열기' },
  { prefix: ',', mode: 'setting', label: '설정 항목 열기' },
  { prefix: '?', mode: 'help', label: '접두사 도움말' },
];
export const PALETTE_PLACEHOLDER = '명령, 탭 검색 · > 명령  # 탭·채팅  @ 파일  , 설정  ? 도움말';
export function parsePaletteQuery(raw: string): { mode: PaletteMode; query: string } {
  const text = raw.trimStart(), found = palettePrefixes.find(item => text.startsWith(item.prefix));
  return found ? { mode: found.mode, query: text.slice(found.prefix.length).trim() } : { mode: 'all', query: text.trim() };
}
export const modeKinds: Record<Exclude<PaletteMode, 'help'>, PaletteKind[]> = {
  all: ['command', 'tab', 'project', 'setting'], command: ['command'], tab: ['tab', 'project'], file: ['file'], setting: ['setting'],
};

// Recently used ids, newest first, capped. A used id moves to the front.
export const MRU_LIMIT = 50;
export function rememberUse(list: readonly string[], id: string, limit = MRU_LIMIT): string[] {
  return [id, ...list.filter(item => item !== id)].slice(0, limit);
}

export type Rankable = { id: string; label: string; kind: PaletteKind; search?: string; order?: number };
// Empty query: recently used first (newest first), then the rest in their given order. A query: fuzzy score on the label (and the extra
// `search` text, e.g. the project name of a tab, at a lower weight) plus a bonus for recent use, so the entry used a moment ago wins a near tie.
export function rankPalette<T extends Rankable>(items: readonly T[], query: string, mru: readonly string[], limit = 200): T[] {
  const recent = new Map(mru.map((id, index) => [id, index]));
  const bonus = (item: T) => { const at = recent.get(item.id); return at === undefined ? 0 : 4 * (1 - at / Math.max(mru.length, 1)) + 1; };
  if (!query) {
    const used = items.filter(item => recent.has(item.id)).sort((a, b) => recent.get(a.id)! - recent.get(b.id)!);
    return [...used, ...items.filter(item => !recent.has(item.id))].slice(0, limit);
  }
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const label = fuzzy(query, item.label), extra = item.search ? fuzzy(query, item.search) : -1;
    const best = Math.max(label, extra >= 0 ? extra * .6 : -1);
    if (best >= 0) scored.push({ item, score: best + bonus(item), index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map(entry => entry.item);
}
