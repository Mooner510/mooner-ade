import { useContext, useId, useState } from 'react';
import type { ChatMediaSpec } from './chat-media';
import { IconButton } from './Icon';
import { isRemote } from './transport';
import { ChatUiContext } from './UiFrame';
import { Modal } from './views';

export function ChatMedia({ media }: { media: ChatMediaSpec }) {
  const chat = useContext(ChatUiContext);
  const [failed, setFailed] = useState(false), [expanded, setExpanded] = useState(false), imageId = useId();
  if (!chat) return null;
  const { type, alt, remote } = media;
  const source = remote ? media.src : `/chat-media?${new URLSearchParams({ projectId: chat.projectId, chatId: chat.chatId, path: media.src })}`;
  const label = alt || (type === 'image' ? '이미지' : '영상');
  const externalLink = remote && <a href={source} rel="noreferrer noopener" onClick={event => {
    event.preventDefault();
    window.dispatchEvent(new CustomEvent('ade:link', { detail: source }));
  }}>원본 열기</a>;
  if (isRemote || failed) return <figure className="md-media"><figcaption role="status">
    {isRemote ? '미디어 미리보기는 로컬 ADE에서 볼 수 있어요.' : `${label} 미리보기를 불러올 수 없어요.`} {externalLink}
  </figcaption></figure>;
  return <figure className="md-media">
    {type === 'image' ? <button type="button" aria-label={`${label} 크게 보기`} onClick={() => setExpanded(true)}>
      <img src={source} alt={label} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    </button> : <video src={source} aria-label={label} controls playsInline preload="metadata" onError={() => setFailed(true)} />}
    {(alt || externalLink) && <figcaption>{alt} {externalLink}</figcaption>}
    {expanded && <Modal className="image-modal" labelledBy={imageId} region="이미지 크게 보기" onClose={() => setExpanded(false)}>
      <span className="image-modal-frame"><img id={imageId} src={source} alt={label} referrerPolicy="no-referrer" onClick={() => setExpanded(false)} />
        <IconButton icon="x" label="닫기" onClick={() => setExpanded(false)} />
      </span>
    </Modal>}
  </figure>;
}
