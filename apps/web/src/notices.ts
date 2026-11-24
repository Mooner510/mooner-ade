// Which of the app's own cards, windows and pointers shows right now. Everything the app puts up by itself (the first-run tour, the changelog after an update, the one-time Git card,
// the Chat card, the animation tip, the pointers at buttons) used to appear whenever its own condition held, so after an update several stacked on each other. Each of them now only
// says it wants to show (`want`); the one that comes first in NOTICE_ORDER is the one that shows, and the next takes its place when that one is dismissed. A notice keeps its own
// visibility and history separately; this file only decides who goes first. No DOM or React here, so node tests can load it.
export const NOTICE_ORDER = ['tour', 'changelog', 'git', 'chat-mode', 'bg-anim', 'tour-hint', 'hint'] as const;
export type NoticeGroup = (typeof NOTICE_ORDER)[number];

// "hint:<pane>" is a notice of the group "hint" (several panes may each have a pointer to show; the first one that asked goes first).
export const noticeGroup = (id: string) => id.split(':')[0];
const rank = (id: string) => { const at = (NOTICE_ORDER as readonly string[]).indexOf(noticeGroup(id)); return at < 0 ? NOTICE_ORDER.length : at; };

/** The notice that shows among those that want to, given in the order they asked; null when none does. */
export function currentNotice(wanted: Iterable<string>): string | null {
  let best: string | null = null, bestRank = Infinity;
  for (const id of wanted) { const at = rank(id); if (at < bestRank) { best = id; bestRank = at; } }
  return best;
}

export function createNotices() {
  const wanted = new Set<string>(), listeners = new Set<() => void>();
  let current: string | null = null;
  return {
    want(id: string, on: boolean) {
      if (on === wanted.has(id)) return;
      if (on) wanted.add(id); else wanted.delete(id);
      const next = currentNotice(wanted);
      if (next !== current) { current = next; listeners.forEach(listener => listener()); }
    },
    current: () => current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
}
export const notices = createNotices();
