// Where "the next thing that needs you" is: every tab or split pane, in every open project, whose agent asks something (approval, question)
// or finished. Pure, so the order is tested in Node (tests/workspace-keyboard.test.mjs).

export type AttentionPane = { id: string; asking: boolean; attention: boolean };
export type AttentionTab = AttentionPane & { panes: AttentionPane[] };
export type AttentionProject = { root: string; tabs: AttentionTab[] };
export type AttentionTarget = { root: string; tabId: string; paneId?: string; asking: boolean };
export type AttentionPlace = { root: string; tabId: string; paneId?: string };

// Questions and approvals first (they block the agent), then finished answers; inside each, sidebar order (project, tab, pane).
export function attentionTargets(projects: readonly AttentionProject[]): AttentionTarget[] {
  const all: AttentionTarget[] = [];
  for (const project of projects) for (const tab of project.tabs) {
    // A split tab names its panes; a single-pane tab carries the state itself.
    if (tab.panes.length) { for (const pane of tab.panes) if (pane.asking || pane.attention) all.push({ root: project.root, tabId: tab.id, paneId: pane.id, asking: pane.asking }); }
    else if (tab.asking || tab.attention) all.push({ root: project.root, tabId: tab.id, asking: tab.asking });
  }
  return [...all.filter(target => target.asking), ...all.filter(target => !target.asking)];
}

const samePlace = (target: AttentionTarget, place: AttentionPlace) => target.root === place.root && target.tabId === place.tabId && (!target.paneId || target.paneId === place.paneId);
// The target after (step 1) or before (step -1) the place you are at. Not on a target: the first one (or the last, going back).
export function nextAttention(targets: readonly AttentionTarget[], place: AttentionPlace | undefined, step: 1 | -1): AttentionTarget | undefined {
  if (!targets.length) return undefined;
  const at = place ? targets.findIndex(target => samePlace(target, place)) : -1;
  if (at < 0) return step > 0 ? targets[0] : targets[targets.length - 1];
  return targets[(at + step + targets.length) % targets.length];
}

// The window's title while something waits: "(2) 무너에이드". The taskbar and Alt+Tab show it too.
export const attentionTitle = (base: string, count: number) => count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;

// The chat "go back to the chat" lands in: the one used last in this tab, else the one used last anywhere in the project, else the first chat
// in sidebar order. `used` holds when each chat last had the focus (ms); a chat never focused in this window counts as 0.
export function pickChat(tabs: readonly { id: string; chats: readonly string[] }[], activeTab: string, used: ReadonlyMap<string, number>): { tabId: string; chatId: string } | undefined {
  const latest = (list: { tabId: string; chatId: string }[]) => list.reduce<{ tabId: string; chatId: string } | undefined>((best, item) => !best || (used.get(item.chatId) ?? 0) > (used.get(best.chatId) ?? 0) ? item : best, undefined);
  const all = tabs.flatMap(tab => tab.chats.map(chatId => ({ tabId: tab.id, chatId })));
  return latest(all.filter(item => item.tabId === activeTab)) ?? latest(all);
}
