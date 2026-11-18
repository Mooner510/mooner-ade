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
