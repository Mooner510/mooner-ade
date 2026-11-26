// "채팅으로 보내기" in a terminal: the xterm selection as a labelled fence, and a small right-click menu (복사 · 붙여넣기 · 채팅으로 보내기)
// while "우클릭으로 붙여넣기" is off (with it on, right-click keeps copying/pasting as before and the key or the palette sends).
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import { closeAll, PopupMenu } from './GitMenu';
import { registerSendSource, requestSendToChat, type SendGet } from './send-to-chat';
import { useActionKeys } from './shortcuts';
import { copyText, toastPasted } from './toast';

export function useTerminalSend(host: RefObject<HTMLDivElement | null>, term: RefObject<Terminal | null>, info: { title?: string; cwd?: string; rightClickPaste: boolean }) {
  const latest = useRef(info); latest.current = info;
  const [menu, setMenu] = useState<{ x: number; y: number; selected: boolean } | null>(null);
  const keys = useActionKeys('sendToChat');
  const read: SendGet = () => {
    const terminal = term.current;
    if (!terminal?.hasSelection()) return null;
    const { title, cwd } = latest.current, where = [title, cwd].filter(Boolean).join(' · ');
    return { kind: 'text', text: terminal.getSelection(), label: where ? `터미널 출력 (${where})` : '터미널 출력' };
  };
  useEffect(() => {
    const el = host.current; if (!el) return;
    const off = registerSendSource(el, read, '터미널에서 보낼 부분을 먼저 선택하세요.');
    const open = (event: MouseEvent) => {
      if (latest.current.rightClickPaste || event.defaultPrevented) return;
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, selected: Boolean(term.current?.hasSelection()) });
    };
    el.addEventListener('contextmenu', open);
    return () => { off(); el.removeEventListener('contextmenu', open); };
  }, []);
  const close = () => { setMenu(null); term.current?.focus(); };
  return menu && <PopupMenu x={menu.x} y={menu.y} label="터미널 메뉴" onClose={close} items={closeAll([
    { label: '복사', icon: 'copy', disabled: !menu.selected, run: () => copyText(term.current?.getSelection() ?? '') },
    { label: '붙여넣기', icon: 'paste', run: () => void navigator.clipboard?.readText().then(text => { if (text) { term.current?.paste(text); toastPasted(text); } }, () => {}) },
    'separator',
    { label: '채팅으로 보내기', icon: 'send', keys, disabled: !menu.selected, run: () => requestSendToChat(read) }
  ], close)} />;
}
