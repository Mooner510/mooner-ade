// How many tabs and panes need you (an agent asks something or finished), shown outside the app: "(2) 무너에이드" as the window title (the
// taskbar and Alt+Tab show it), and through the desktop shell (apps/desktop/src/attention.js) a taskbar flash and dot on Windows or the Dock
// badge on macOS. The flash only comes when the number grows while the window is in the background. Settings › AI 툴 › 알림 turns it off.
import { useEffect, useRef } from 'react';
import { attentionTitle } from './attention-nav';

type Desktop = { attention?(count: number, flash: boolean): void };
const desktop = () => (window as unknown as { adeDesktop?: Desktop }).adeDesktop;

export function useWindowAttention(count: number, enabled: boolean) {
  const base = useRef(''), last = useRef(0);
  useEffect(() => {
    base.current ||= document.title.replace(/^\(\d+\+?\) /, '') || '무너에이드';
    const shown = enabled ? count : 0, grew = shown > last.current;
    last.current = shown;
    document.title = attentionTitle(base.current, shown);
    desktop()?.attention?.(shown, grew && !document.hasFocus());
  }, [count, enabled]);
}
