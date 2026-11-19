import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Icon, IconButton } from './Icon';
import { Markdown } from './Markdown';
import { copyText } from './toast';
import { Modal } from './views';
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
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);
  const titleId = useId();

  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!bubble) return;
    const sync = () => setClipped(userMessageExceedsClipHeight(measureBubbleHeight(bubble)));
    sync();
    const preview = bubble.querySelector('.chat-bubble-preview');
    const observer = new ResizeObserver(sync);
    if (preview) observer.observe(preview);
    return () => observer.disconnect();
  }, [text, children, markdown]);

  const openFromClick = (event: MouseEvent) => {
    if (!clipped) return;
    if ((event.target as HTMLElement).closest('a, button, .md-file, input, textarea, .chat-bubble-open')) return;
    setOpen(true);
  };

  const content = children ?? (markdown ? <Markdown text={text} /> : <span className="chat-bubble-plain">{text}</span>);

  const openFromKey = (event: KeyboardEvent) => {
    if (!clipped || (event.key !== 'Enter' && event.key !== ' ')) return;
    if ((event.target as HTMLElement).closest('a, button, .md-file, input, textarea, .chat-bubble-open')) return;
    event.preventDefault();
    setOpen(true);
  };

  return <>
    <div ref={bubbleRef} className={`chat-bubble${className ? ` ${className}` : ''}${clipped ? ' clipped' : ''}`} data-long={clipped || undefined}
      style={clipped ? { maxHeight: USER_MESSAGE_CLIP_HEIGHT_PX } : undefined}
      tabIndex={clipped ? 0 : undefined} role={clipped ? 'button' : undefined}
      onClick={clipped ? openFromClick : undefined} onKeyDown={clipped ? openFromKey : undefined} title={clipped ? '크게 보기' : undefined}>
      {clipped && <button type="button" className="chat-bubble-open" aria-label="크게 보기" onClick={() => setOpen(true)}><Icon name="maximize" size={12} />크게 보기</button>}
      <div className="chat-bubble-preview">{content}</div>
    </div>
    {open && <Modal className="user-msg-modal plan-modal" labelledBy={titleId} region="보낸 메시지" onClose={() => setOpen(false)}>
      <header>
        <span className="plan-label"><Icon name="send" size={15} /><strong>내 메시지</strong></span>
        <h2 id={titleId}>보낸 메시지</h2>
        <span className="plan-head-end">
          <IconButton icon="copy" label="메시지 복사" onClick={() => copyText(text)} />
          <IconButton icon="x" label="닫기" onClick={() => setOpen(false)} />
        </span>
      </header>
      <div className="plan-modal-body user-msg-modal-body">{content}</div>
    </Modal>}
  </>;
}