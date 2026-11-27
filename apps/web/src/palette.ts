// The command palette (mod+Shift+P / F1): one search over commands, open tabs and chats of every project, projects, settings sections and,
// with `@`, the project's files. Prefixes and ranking are in palette-model.ts; this file turns entries into a QuickInput source and
// remembers what was used (localStorage, this window only) so it comes first next time.
import type { IconName } from './Icon';
import type { QuickItem, QuickSource } from './QuickInput';
import { modeKinds, PALETTE_PLACEHOLDER, palettePrefixes, parsePaletteQuery, rankPalette, rememberUse, type PaletteKind } from './palette-model';

export type PaletteEntry = { id: string; kind: PaletteKind; label: string; icon: IconName; detail?: string; keys?: string; search?: string; run(): void | Promise<unknown> };
// What the shell adds to a project's palette: every project's tabs and chats, the projects themselves and the settings sections.
export type PaletteHost = { entries(): PaletteEntry[] };
export type PalettePick = (request: { source: QuickSource; placeholder: string; initial: string }) => Promise<string | null>;

const MRU_KEY = 'ade-palette-mru';
export function readPaletteMru(): string[] {
  try { const value = JSON.parse(localStorage.getItem(MRU_KEY) || '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 50) : []; }
  catch { return []; }
}
export function notePaletteUse(id: string) {
  try { localStorage.setItem(MRU_KEY, JSON.stringify(rememberUse(readPaletteMru(), id))); } catch { /* storage full or off: the order just stays */ }
}

const quickItem = (entry: PaletteEntry): QuickItem => ({ id: entry.id, label: entry.label, icon: entry.icon, ...(entry.detail ? { detail: entry.detail } : {}), ...(entry.keys ? { keys: entry.keys } : {}) });

export async function runPalette({ pick, entries, files, openFile, initial = '' }: {
  pick: PalettePick; entries: PaletteEntry[]; initial?: string;
  // `@`: the project's files, read once per opening and only when asked for.
  files?(): Promise<string[]>; openFile?(path: string): void | Promise<unknown>;
}): Promise<void> {
  const mru = readPaletteMru(), listeners = new Set<() => void>();
  let fileEntries: PaletteEntry[] | null = null, fileState: 'idle' | 'loading' | 'error' = 'idle', fileError = '';
  const loadFiles = () => {
    if (fileState !== 'idle' || fileEntries || !files || !openFile) return;
    fileState = 'loading';
    files().then(list => {
      fileEntries = list.map(path => ({ id: `file:${path}`, kind: 'file' as const, label: path, icon: 'file' as const, run: () => openFile(path) }));
      fileState = 'idle';
    }, cause => { fileState = 'error'; fileError = cause instanceof Error ? cause.message : String(cause); }).finally(() => listeners.forEach(listener => listener()));
  };
  const source: QuickSource = {
    filter(value) {
      const { mode, query } = parsePaletteQuery(value);
      if (mode === 'help') return palettePrefixes.filter(item => item.mode !== 'help').map(item => ({ id: `prefix:${item.prefix}`, label: `${item.prefix}  ${item.label}`, icon: 'keyboard' as const }));
      if (mode === 'file') { loadFiles(); return rankPalette(fileEntries ?? [], query, mru, 120).map(quickItem); }
      const kinds = modeKinds[mode], pool = entries.filter(entry => kinds.includes(entry.kind) && (mode !== 'all' || query || entry.kind !== 'setting'));
      return rankPalette(pool, query, mru).map(quickItem);
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    empty(value) {
      const { mode } = parsePaletteQuery(value);
      if (mode !== 'file') return '일치하는 항목이 없습니다.';
      if (!files || !openFile) return '이 화면에서는 파일을 열 수 없습니다.';
      return fileState === 'loading' || !fileEntries && fileState === 'idle' ? '파일 목록을 읽는 중…' : fileState === 'error' ? fileError : '일치하는 파일이 없습니다.';
    }
  };
  for (;;) {
    const choice = await pick({ source, placeholder: PALETTE_PLACEHOLDER, initial });
    if (!choice) return;
    // A prefix picked from the `?` list opens the palette again with it typed.
    if (choice.startsWith('prefix:')) { initial = choice.slice('prefix:'.length); continue; }
    const entry = entries.find(item => item.id === choice) ?? (fileEntries as PaletteEntry[] | null)?.find(item => item.id === choice); // set by the file load above
    if (!entry) return;
    notePaletteUse(entry.id);
    await entry.run();
    return;
  }
}
