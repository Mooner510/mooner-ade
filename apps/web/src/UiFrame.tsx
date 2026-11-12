import { createContext, memo, useEffect, useRef, useState } from 'react';
import { MIN_HEIGHT, parseFrameMessage, sendGate, THEME_VARS } from './ui-frame-protocol';

// Interactive UI blocks (```ade-ui fences) in a chat reply: model-written HTML/JS that runs in a sandboxed iframe, see apps/local-server/src/ui-frame.js.
// The chat pane provides its id (so `ade.send` reaches the right chat) and whether the feature is on; without it a block stays a plain code block.
export const ChatUiContext = createContext<{ chatId: string; enabled: boolean } | null>(null);

const themeNow = () => {
  const root = document.documentElement, css = getComputedStyle(root);
  return { ...Object.fromEntries(THEME_VARS.map(name => [name, css.getPropertyValue(name).trim()])), '--scheme': root.dataset.theme === 'light' ? 'light' : 'dark' };
};

// The app's own type (Inter + Noto Sans KR) for the frame: their @font-face rules, file URLs made absolute. The frame's CSP allows fonts from this
// server only and the files are served with CORS (public assets), so the sandboxed page loads the same unicode-range subsets the app does.
const APP_FONTS = /^(Inter Variable|Noto Sans KR Variable)$/;
let fontCss = '';
const fontsNow = () => fontCss ||= [...document.styleSheets].flatMap(sheet => {
  try {
    return [...sheet.cssRules].filter((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule && APP_FONTS.test(rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim()))
      .map(rule => rule.cssText.replace(/url\((["']?)([^"')]+)\1\)/g, (_, _quote, src: string) => `url("${new URL(src, sheet.href ?? location.href).href}")`));
  } catch { return []; }
}).join('');

export const UiFrame = memo(function UiFrame({ chatId, html }: { chatId: string; html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_HEIGHT * 3), [width, setWidth] = useState<number | undefined>();
  const init = () => frame.current?.contentWindow?.postMessage({ ade: 1, type: 'init', html, theme: themeNow(), fonts: fontsNow() }, '*');
  useEffect(() => {
    const gate = sendGate();
    const onMessage = (event: MessageEvent) => {
      // Only this block's own frame; its payload is untrusted and validated before anything happens.
      if (event.source !== frame.current?.contentWindow) return;
      const message = parseFrameMessage(event.data);
      if (!message) return;
      if (message.type === 'ready') init();
      // A width only comes from content narrower than the frame; a report without one (fluid, or already fitted) keeps the width set before.
      else if (message.type === 'height') { setHeight(message.height); if (message.width) setWidth(message.width); }
      else if (message.type === 'send') { if (gate()) window.dispatchEvent(new CustomEvent('ade:ui-send', { detail: { chatId, text: message.text } })); }
      else window.dispatchEvent(new CustomEvent('ade:ui-prefill', { detail: { chatId, text: message.text } }));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [chatId, html]);
  // sandbox without allow-same-origin: the frame cannot reach the app's cookies, storage or DOM.
  return <iframe ref={frame} className="ade-ui" title="인터랙티브 UI" sandbox="allow-scripts" src="/ade-ui-frame.html" style={{ height: height + 2 /* the 1px border sits inside the border-box */, width: width ? `min(100%, ${width + 2}px)` : undefined }} onLoad={init} />;
});
