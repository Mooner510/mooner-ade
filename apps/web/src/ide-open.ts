import { api } from './api';
import type { IconName } from './Icon';

// "Open in IDE": the editors this computer has (found by the local server), what to open, and the event a clicked file chip raises.
export type IdeInfo = { id: string; label: string; kind: string };
export type IdeList = { ides: IdeInfo[]; fileManager: string };
export const ideIcon = (ide: Pick<IdeInfo, 'id' | 'kind'>): IconName =>
  ide.id === 'cursor' ? 'cursor'
    : ide.id === 'vscode-insiders' ? 'vscode-insiders'
      : ide.id === 'vscodium' ? 'vscodium'
        : ide.id === 'windsurf' ? 'windsurf'
          : ide.id === 'zed' || ide.kind === 'zed' ? 'zed'
            : ide.kind === 'jetbrains' ? 'jetbrains'
              : ide.kind === 'vscode' ? 'vscode' : 'code';
// path is relative to the project (or to the chat's own folder when chatId is given); the server refuses anything outside it.
export type OpenTarget = { path: string; line?: number; column?: number; folder?: boolean; chatId?: string };

let cached: { at: number; value: Promise<IdeList> } | null = null;
// Detection reads the disk, so the answer is reused for half a minute (the server keeps its own copy for the same time).
export function ideList(force = false): Promise<IdeList> {
  if (!force && cached && Date.now() - cached.at < 30_000) return cached.value;
  const value = api<IdeList>('ide/list', { force });
  cached = { at: Date.now(), value };
  value.catch(() => { if (cached?.value === value) cached = null; });
  return value;
}

const LAST = 'ade-last-ide';
export function lastIde() { try { return localStorage.getItem(LAST) ?? ''; } catch { return ''; } }
export function rememberIde(id: string) { try { localStorage.setItem(LAST, id); } catch { /* private mode: the order just is not remembered */ } }
// The editor used last comes first, so a second click is Enter.
export const byLastUsed = (ides: IdeInfo[]) => { const last = lastIde(); return [...ides].sort((a, b) => Number(b.id === last) - Number(a.id === last)); };

export const FILE_EVENT = 'ade:file';
export const requestOpen = (target: OpenTarget) => window.dispatchEvent(new CustomEvent<OpenTarget>(FILE_EVENT, { detail: target }));

// JetBrains products share one glyph; these two letters and brand-like colours tell them apart (by the product name the server detected).
const jetbrainsMarks: [RegExp, string, string][] = [
  [/android studio/i, 'AS', '#3ddc84'], [/datagrip/i, 'DG', '#21d789'], [/webstorm/i, 'WS', '#07c3f2'], [/intellij/i, 'IJ', '#087cfa'], [/pycharm/i, 'PC', '#21d789'],
  [/clion/i, 'CL', '#21d789'], [/goland/i, 'GO', '#079dff'], [/rider/i, 'RD', '#dd1265'], [/phpstorm/i, 'PS', '#b345f1'], [/rubymine/i, 'RM', '#fe2d2d'], [/rustrover/i, 'RR', '#f26522'], [/dataspell/i, 'DS', '#087cfa']
];
const lightMarks = new Set(['#3ddc84', '#21d789', '#07c3f2']); // 밝은 배경에는 어두운 글자, 나머지는 흰 글자
export function ideMark(label: string): { text: string; color: string; ink: string } {
  const known = jetbrainsMarks.find(([pattern]) => pattern.test(label));
  return known ? { text: known[1], color: known[2], ink: lightMarks.has(known[2]) ? '#0b0b0b' : '#fff' } : { text: (label.replace(/[^A-Za-z]/g, '').slice(0, 2) || 'JB').toUpperCase(), color: '#6b7280', ink: '#fff' };
}
