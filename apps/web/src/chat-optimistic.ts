import type { ChatState } from './chat-model';

// A Cursor setting shown at once while its call is in flight, until the server state shows the same value.
export type Optimistic = { model?: string; effort?: string | null; permissionMode?: string; runEverything?: boolean; sandbox?: string | null; options?: Record<string, string> };
// What a Cursor setting call is about to change, keyed so a later call on the same setting supersedes an earlier one.
export function optimisticPatch(input: any): Optimistic {
  const patch: Optimistic = {};
  if (typeof input.model === 'string') patch.model = input.model;
  if (input.effort !== undefined) patch.effort = input.effort;
  if (typeof input.permissionMode === 'string') patch.permissionMode = input.permissionMode;
  if (typeof input.runEverything === 'boolean') patch.runEverything = input.runEverything;
  if (input.sandbox !== undefined) patch.sandbox = input.sandbox;
  if (input.configOption) patch.options = { [input.configOption.configId]: input.configOption.value };
  return patch;
}
export const mergeOptimistic = (current: Optimistic, patch: Optimistic): Optimistic => ({ ...current, ...patch, ...(patch.options && { options: { ...current.options, ...patch.options } }) });
export const optimisticKeys = (patch: Optimistic) => Object.keys(patch).flatMap(key => key === 'options' ? Object.keys(patch.options!).map(id => `opt:${id}`) : [key]);
export function dropOptimistic(current: Optimistic, keys: string[]): Optimistic {
  // `options` only when present: an own `options: undefined` key makes optimisticKeys throw, and a throw while rendering blanks the whole app.
  const next: any = { ...current, ...(current.options && { options: { ...current.options } }) };
  for (const key of keys) { if (key.startsWith('opt:')) delete next.options[key.slice(4)]; else delete next[key]; }
  if (next.options && !Object.keys(next.options).length) delete next.options;
  return next;
}
export function optimisticSettled(state: ChatState, current: Optimistic, key: string) {
  if (key.startsWith('opt:')) { const id = key.slice(4); return state.capabilities?.configOptions?.find(option => option.id === id)?.currentValue === current.options?.[id]; }
  if (key === 'model') return state.model === current.model;
  if (key === 'effort') return state.effort === current.effort;
  if (key === 'permissionMode') return state.permissionMode === current.permissionMode;
  if (key === 'runEverything') return state.runEverything === current.runEverything;
  if (key === 'sandbox') return (state.sandbox ?? null) === (current.sandbox ?? null);
  return false;
}
export function withOptimistic(state: ChatState, o: Optimistic): ChatState {
  if (!Object.keys(o).length) return state;
  const caps = state.capabilities;
  return { ...state, ...(o.model !== undefined && { model: o.model }), ...(o.effort !== undefined && { effort: o.effort }), ...(o.permissionMode !== undefined && { permissionMode: o.permissionMode }),
    ...(o.runEverything !== undefined && { runEverything: o.runEverything }), ...(o.sandbox !== undefined && { sandbox: o.sandbox }),
    ...(caps && o.options && { capabilities: { ...caps, configOptions: caps.configOptions?.map((option: any) => o.options![option.id] !== undefined ? { ...option, currentValue: o.options![option.id] } : option) } }) };
}
