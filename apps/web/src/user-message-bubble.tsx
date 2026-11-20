import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { USER_MESSAGE_CLIP_HEIGHT_PX, userMessageExceedsClipHeight } from './user-message-limit';

function measureBubbleHeight(bubble: HTMLElement) {
  const preview = bubble.querySelector<HTMLElement>('.chat-bubble-preview');
  if (!preview) return 0;
  const style = getComputedStyle(bubble);
  const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  return preview.scrollHeight + pad + border;
}

export function UserMessageBubble({ text, className = '', markdown = true, children }: { text: string; className?: string; markdown?: boolean; children?: ReactNode }) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!bubble) return;
    const sync = () => setLong(userMessageExceedsClipHeight(measureBubbleHeight(bubble)));
    sync();
    const preview = bubble.querySelector('.chat-bubble-preview');
    const observer = new ResizeObserver(sync);
    if (preview) observer.observe(preview);
    return () => observer.disconnect();
  }, [text, children, markdown]);

  const content = children ?? (markdown ? <Markdown text={text} /> : <span className="chat-bubble-plain">{text}</span>);
  const clipped = long && !expanded;

  return <div ref={bubbleRef} className={`chat-bubble${className ? ` ${className}` : ''}${clipped ? ' clipped' : ''}${long && expanded ? ' expanded' : ''}`} data-long={long || undefined}
    style={clipped ? { maxHeight: USER_MESSAGE_CLIP_HEIGHT_PX } : undefined}>
    <div className="chat-bubble-preview">{content}</div>
    {long && <button type="button" className="chat-bubble-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Icon name="chevronDown" size={12} />{expanded ? '접기' : '펼치기'}</button>}
  </div>;
}
