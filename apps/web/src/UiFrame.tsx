import { createContext, memo, useEffect, useRef, useState } from 'react';
import { MIN_HEIGHT, parseFrameMessage, sendGate, THEME_VARS } from './ui-frame-protocol';

// Interactive UI blocks (```ade-ui fences) in a chat reply: model-written HTML/JS that runs in a sandboxed iframe, see apps/local-server/src/ui-frame.js.
// The chat pane provides its id (so `ade.send` reaches the right chat) and whether the feature is on; without it a block stays a plain code block.
export const ChatUiContext = createContext<{ chatId: string; enabled: boolean } | null>(null);

const themeNow = () => {
  const root = document.documentElement, css = getComputedStyle(root);
  return { ...Object.fromEntries(THEME_VARS.map(name => [name, css.getPropertyValue(name).trim()])), '--scheme': root.dataset.theme === 'light' ? 'light' : 'dark' };
};

export const UiFrame = memo(function UiFrame({ chatId, html }: { chatId: string; html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_HEIGHT * 3);
  const init = () => frame.current?.contentWindow?.postMessage({ ade: 1, type: 'init', html, theme: themeNow() }, '*');
  useEffect(() => {
    const gate = sendGate();
    const onMessage = (event: MessageEvent) => {
      // Only this block's own frame; its payload is untrusted and validated before anything happens.
      if (event.source !== frame.current?.contentWindow) return;
      const message = parseFrameMessage(event.data);
      if (!message) return;
      if (message.type === 'ready') init();
      else if (message.type === 'height') setHeight(message.height);
      else if (message.type === 'send') { if (gate()) window.dispatchEvent(new CustomEvent('ade:ui-send', { detail: { chatId, text: message.text } })); }
      else window.dispatchEvent(new CustomEvent('ade:ui-prefill', { detail: { chatId, text: message.text } }));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [chatId, html]);
  // sandbox without allow-same-origin: the frame cannot reach the app's cookies, storage or DOM.
  return <iframe ref={frame} className="ade-ui" title="인터랙티브 UI" sandbox="allow-scripts" src="/ade-ui-frame.html" style={{ height }} onLoad={init} />;
});
