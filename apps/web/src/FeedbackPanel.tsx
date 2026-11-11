import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { api } from './api';
import { Icon, IconButton, type IconName } from './Icon';
import { Markdown } from './Markdown';
import { copyText } from './toast';
import type { Ask } from './views';
import { AnnotateImage } from './AnnotateImage';
import { base64Bytes, canSubmit, isEditable, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TITLE, needsReview, sourceLabels, statusLabels, type Feedback, type FeedbackAvailability, type FeedbackSource } from './feedback-model';
import { canCapture, createFeedback, feedbackCall, openFeedback, removeLocal, requestCapture, useFeedback, type CaptureMode } from './feedback-store';

export const feedbackFileUrl = (item: Pick<Feedback, 'id' | 'updatedAt'>, name: string) => `/feedback-file/${encodeURIComponent(item.id)}/${encodeURIComponent(name)}?v=${item.updatedAt}`;
const sourceIcons: Record<FeedbackSource, IconName> = { human: 'person', ai: 'sparkles', agent: 'bot' };

const readDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
});
// The server takes PNG or JPEG only; any other image the browser can decode (webp, gif, bmp…) is redrawn as PNG.
async function imagePayload(file: File): Promise<{ data: string; mime: 'image/png' | 'image/jpeg' }> {
  let blob: Blob = file, mime: 'image/png' | 'image/jpeg' = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
    const bitmap = await createImageBitmap(file), canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d')!.drawImage(bitmap, 0, 0); bitmap.close();
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('이미지를 변환하지 못했습니다.')), 'image/png'));
    mime = 'image/png';
  }
  const url = await readDataUrl(blob), data = url.slice(url.indexOf(',') + 1);
  if (base64Bytes(data) > MAX_IMAGE_BYTES) throw new Error('이미지는 한 장에 8MB까지 넣을 수 있습니다.');
  return { data, mime };
}

type PanelProps = { ask: Ask; fail(cause: unknown): void; wide: boolean; toggleWide(): void; onClose(): void; aiContext(): Promise<string | undefined> };

export function FeedbackPanel(props: PanelProps) {
  const { items, available, loaded, error, currentId } = useFeedback();
  const current = items.find(item => item.id === currentId);
  return <div className="review-panel feedback-panel">
    {current ? <FeedbackDetail key={current.id} item={current} available={available} {...props} />
      : <FeedbackList items={items} available={available} loaded={loaded} error={error} {...props} />}
  </div>;
}

function AvailabilityNote({ available }: { available: FeedbackAvailability | null }) {
  if (!available || available.ok) return null;
  return <p className="feedback-note warn" role="status"><Icon name="info" size={14} />{available.reason || '지금은 피드백을 보낼 수 없습니다.'}</p>;
}

function FeedbackList({ items, available, loaded, error, fail, wide, toggleWide, onClose }: PanelProps & { items: Feedback[]; available: FeedbackAvailability | null; loaded: boolean; error: string }) {
  const [creating, setCreating] = useState(false);
  const create = () => { setCreating(true); void createFeedback().catch(fail).finally(() => setCreating(false)); };
  const when = (at: number) => new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return <>
    <header className="panel-head">
      <Icon name="feedback" /><strong>피드백 창고</strong>
      <span className="spacer" />
      <button type="button" className="primary feedback-new" disabled={creating} onClick={create}><Icon name="plus" size={14} />새 피드백</button>
      <IconButton icon={wide ? 'minimize' : 'maximize'} label={wide ? '패널 크기 줄이기' : '패널 넓게 보기'} onClick={toggleWide} />
      <IconButton icon="x" label="피드백 창고 닫기" onClick={onClose} />
    </header>
    <AvailabilityNote available={available} />
    <div className="review-list feedback-list">
      {error && <p className="feedback-note warn" role="alert">{error}</p>}
      {loaded && !items.length && !error && <div className="review-empty"><Icon name="feedback" size={22} /><strong>피드백이 없습니다</strong><p>화면을 캡쳐하고 불편한 점이나 바라는 점을 적어 보내 주세요.</p></div>}
      {items.map(item => {
        const unseen = needsReview(item), thumb = item.images[0];
        return <button type="button" key={item.id} className={`feedback-row${unseen ? ' unseen' : ''}`} onClick={() => openFeedback(item.id)}>
          <span className="feedback-thumb">{thumb ? <img src={feedbackFileUrl(item, thumb.name)} alt="" loading="lazy" /> : <Icon name="image" size={18} />}</span>
          <span className="feedback-row-main">
            <strong className={item.title.trim() ? '' : 'untitled'}>{item.title.trim() || '(제목 없음)'}</strong>
            <small>
              <span className="feedback-source" title={sourceLabels[item.source]}><Icon name={sourceIcons[item.source]} size={13} /></span>
              <span className={`feedback-status status-${item.status}`}>{statusLabels[item.status]}</span>
              {item.images.length > 0 && <span className="feedback-count" title={`이미지 ${item.images.length}장`}><Icon name="image" size={12} />{item.images.length}</span>}
              <time dateTime={new Date(item.updatedAt).toISOString()}>{when(item.updatedAt)}</time>
            </small>
          </span>
          {unseen && <i className="feedback-dot" aria-label="아직 검토하지 않음" />}
        </button>;
      })}
    </div>
  </>;
}

function FeedbackDetail({ item, available, ask, fail, wide, toggleWide, onClose, aiContext }: PanelProps & { item: Feedback; available: FeedbackAvailability | null }) {
  const editable = isEditable(item);
  const [title, setTitle] = useState(item.title), [body, setBody] = useState(item.body), [tab, setTab] = useState<'edit' | 'preview'>(editable ? 'edit' : 'preview');
  const [busy, setBusy] = useState(''), [noteOpen, setNoteOpen] = useState(false), [note, setNote] = useState(''), [annotating, setAnnotating] = useState('');
  // Edits not yet saved: a server update (AI draft done, another screen) only replaces the fields when nothing local is pending.
  const pending = useRef<{ title: string; body: string } | null>(null), timer = useRef(0), saving = useRef<Promise<unknown> | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const id = item.id;

  useEffect(() => { if (!pending.current) { setTitle(item.title); setBody(item.body); } }, [item.updatedAt]);
  useEffect(() => { if (!isEditable(item) && tab === 'edit') setTab('preview'); }, [item.status]);
  // Opening an AI/agent draft is the human review that unlocks its submit.
  useEffect(() => { if (needsReview(item) && item.status !== 'drafting') void feedbackCall('feedback/update', { id, reviewed: true }).catch(fail); }, [id, item.status]);

  const flush = async () => {
    clearTimeout(timer.current);
    const edit = pending.current;
    if (edit) {
      const run = feedbackCall('feedback/update', { id, title: edit.title, body: edit.body });
      saving.current = run;
      try { await run; } finally { if (pending.current === edit) pending.current = null; }
    } else if (saving.current) await saving.current.catch(() => {});
  };
  useEffect(() => () => { void flush().catch(fail); }, []);
  const edit = (next: { title?: string; body?: string }) => {
    const value = { title: next.title ?? pending.current?.title ?? title, body: next.body ?? pending.current?.body ?? body };
    if (next.title !== undefined) setTitle(next.title); if (next.body !== undefined) setBody(next.body);
    pending.current = value;
    clearTimeout(timer.current); timer.current = window.setTimeout(() => void flush().catch(fail), 700);
  };
  const run = (label: string, work: () => Promise<unknown>) => { setBusy(label); void work().catch(fail).finally(() => setBusy('')); };

  const addFiles = (files: File[]) => {
    const images = files.filter(entry => entry.type.startsWith('image/'));
    if (!images.length) return;
    const room = MAX_IMAGES - item.images.length;
    if (room <= 0) { fail(new Error(`이미지는 ${MAX_IMAGES}장까지 넣을 수 있습니다.`)); return; }
    run('image', async () => { for (const entry of images.slice(0, room)) await feedbackCall('feedback/image/add', { id, ...(await imagePayload(entry)) }); });
  };
  const onPaste = (event: ClipboardEvent) => {
    if (!editable) return;
    const files = [...event.clipboardData.files].filter(entry => entry.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault(); addFiles(files);
  };
  const onDrop = (event: DragEvent) => { if (!editable || !event.dataTransfer.files.length) return; event.preventDefault(); addFiles([...event.dataTransfer.files]); };

  const live = { ...item, title: pending.current?.title ?? title, body: pending.current?.body ?? body };
  const verdict = canSubmit(live, available);
  const drafting = item.status === 'drafting' || busy === 'ai';
  const submit = () => run('submit', async () => {
    await flush();
    if (!(await ask.confirm('피드백을 제출할까요? 스크린샷에 코드나 비밀 정보가 보일 수 있으니 확인하세요. 개발자의 비공개 GitHub 저장소에 이슈로 올라갑니다.'))) return;
    await feedbackCall('feedback/submit', { id });
  });
  const draft = () => run('ai', async () => {
    await flush();
    const context = await aiContext().catch(() => undefined);
    const text = note.trim(); setNoteOpen(false); setNote('');
    await feedbackCall('feedback/ai-draft', { id, ...(text ? { note: text } : {}), ...(context ? { context } : {}) });
  });
  const remove = () => run('delete', async () => {
    if (!(await ask.confirm('이 피드백을 삭제할까요? 이미지와 본문이 모두 지워집니다.'))) return;
    clearTimeout(timer.current); pending.current = null;
    await api('feedback/delete', { id }); removeLocal(id);
  });
  const back = () => { void flush().catch(fail); openFeedback(''); };
  const capture = (mode: CaptureMode) => { void flush().catch(fail); requestCapture(mode); };

  return <>
    <header className="panel-head">
      <IconButton icon="chevronLeft" label="목록으로" onClick={back} />
      <strong className="feedback-head-title">{title.trim() || '(제목 없음)'}</strong>
      <span className={`feedback-status status-${item.status}`}>{drafting ? statusLabels.drafting : statusLabels[item.status]}</span>
      <span className="spacer" />
      <IconButton icon={wide ? 'minimize' : 'maximize'} label={wide ? '패널 크기 줄이기' : '패널 넓게 보기'} onClick={toggleWide} />
      <IconButton icon="x" label="피드백 창고 닫기" onClick={onClose} />
    </header>
    <div className="feedback-detail" onPaste={onPaste} onDragOver={event => { if (editable) event.preventDefault(); }} onDrop={onDrop}>
      {item.status === 'submitted' && <div className="feedback-note ok">
        <Icon name="check" size={14} /><span>제출했습니다{item.issueNumber ? ` · 이슈 #${item.issueNumber}` : ''}</span>
        {item.issueUrl && <button type="button" onClick={() => window.open(item.issueUrl, '_blank', 'noopener')}><Icon name="externalLink" size={13} />이슈 열기</button>}
      </div>}
      {item.status === 'failed' && item.error && <p className="feedback-note warn" role="alert"><Icon name="alert" size={14} />{item.error}</p>}
      {item.source !== 'human' && <p className="feedback-note"><Icon name={sourceIcons[item.source]} size={14} />{sourceLabels[item.source]}입니다. 내용을 확인하고 고친 뒤 제출하세요.</p>}

      <input className="feedback-title" aria-label="피드백 제목" placeholder="제목" maxLength={MAX_TITLE} value={title} readOnly={!editable || drafting} onChange={event => edit({ title: event.target.value })} />

      <div className="feedback-tabs" role="tablist" aria-label="본문 보기">
        <button type="button" role="tab" aria-selected={tab === 'edit'} aria-pressed={tab === 'edit'} disabled={!editable} onClick={() => setTab('edit')}>편집</button>
        <button type="button" role="tab" aria-selected={tab === 'preview'} aria-pressed={tab === 'preview'} onClick={() => setTab('preview')}>미리보기</button>
        <span className="spacer" />
        {editable && <button type="button" className="feedback-ai" disabled={drafting || !!busy} aria-expanded={noteOpen} onClick={() => setNoteOpen(value => !value)}><Icon name="sparkles" size={14} />{drafting ? 'AI 작성 중…' : 'AI 초안'}</button>}
      </div>
      {noteOpen && !drafting && <div className="feedback-ai-note">
        <textarea aria-label="AI에게 남길 메모 (선택)" placeholder="AI에게 남길 메모 (선택) · 예: 버튼이 안 눌리는 문제 위주로" rows={2} value={note} autoFocus onChange={event => setNote(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); draft(); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setNoteOpen(false); } }} />
        <div className="actions"><span className="hint">이미지와 지금 본문을 바탕으로 제목과 본문을 새로 씁니다.</span><span className="spacer" />
          <button type="button" onClick={() => setNoteOpen(false)}>취소</button><button type="button" className="primary" onClick={draft}>초안 쓰기</button></div>
      </div>}
      {tab === 'edit' && editable
        ? <textarea className="feedback-body" aria-label="피드백 본문 (마크다운)" placeholder={'무엇이 불편했는지, 어떻게 되면 좋을지 적어 주세요. 마크다운을 쓸 수 있습니다.\n이미지를 붙여넣거나 끌어다 놓을 수도 있습니다.'} value={body} readOnly={drafting} onChange={event => edit({ body: event.target.value })} />
        : <div className="feedback-preview">{body.trim() ? <Markdown text={body} /> : <p className="hint">본문이 없습니다.</p>}</div>}

      <section className="feedback-images" aria-label={`이미지 ${item.images.length}/${MAX_IMAGES}`}>
        <div className="feedback-images-head">
          <strong>이미지</strong><small>{item.images.length}/{MAX_IMAGES}</small><span className="spacer" />
          {editable && canCapture() && <span className="feedback-capture-buttons">
            <IconButton icon="captureElement" label="요소 캡쳐" onClick={() => capture('element')} disabled={item.images.length >= MAX_IMAGES} />
            <IconButton icon="captureWindow" label="창 전체 캡쳐" onClick={() => capture('window')} disabled={item.images.length >= MAX_IMAGES} />
            <IconButton icon="captureRange" label="범위 캡쳐" onClick={() => capture('range')} disabled={item.images.length >= MAX_IMAGES} />
          </span>}
          {editable && <IconButton icon="plus" label="이미지 파일 추가" onClick={() => file.current?.click()} disabled={item.images.length >= MAX_IMAGES || busy === 'image'} />}
          <input ref={file} type="file" accept="image/*" multiple hidden onChange={event => { addFiles([...(event.target.files ?? [])]); event.target.value = ''; }} />
        </div>
        {!item.images.length ? <p className="hint">{editable ? '캡쳐하거나 이미지를 붙여넣기·끌어다 놓기로 추가하세요.' : '이미지 없음'}</p>
          : <ol className="feedback-strip">{item.images.map((image, index) => <li key={image.name}>
            <button type="button" className="feedback-strip-image" title={editable ? '눌러서 표시하기' : image.name} disabled={!editable} onClick={() => setAnnotating(image.name)}>
              <img src={feedbackFileUrl(item, image.name)} alt={`이미지 ${index + 1}`} loading="lazy" />{image.annotated && <span className="feedback-annotated">표시됨</span>}
            </button>
            {editable && <span className="feedback-strip-tools">
              <IconButton icon="chevronLeft" label="왼쪽으로" size={13} disabled={index === 0} onClick={() => run('move', () => feedbackCall('feedback/image/move', { id, name: image.name, to: index - 1 }))} />
              <IconButton icon="chevronRight" label="오른쪽으로" size={13} disabled={index === item.images.length - 1} onClick={() => run('move', () => feedbackCall('feedback/image/move', { id, name: image.name, to: index + 1 }))} />
              <IconButton icon="draw" label="표시하기" size={13} onClick={() => setAnnotating(image.name)} />
              {image.annotated && <IconButton icon="restore" label="원본으로 되돌리기" size={13} onClick={() => run('restore', () => feedbackCall('feedback/image/restore', { id, name: image.name }))} />}
              <IconButton icon="trash" label="이미지 삭제" size={13} onClick={() => run('remove', () => feedbackCall('feedback/image/remove', { id, name: image.name }))} />
            </span>}
          </li>)}</ol>}
      </section>
    </div>
    <AvailabilityNote available={item.status === 'submitted' ? null : available} />
    <footer className="feedback-actions">
      <button type="button" onClick={() => run('folder', () => api('feedback/open-folder', { id }))}><Icon name="folder" size={14} />폴더 열기</button>
      <button type="button" onClick={() => run('copy', async () => { await flush(); copyText((await api<{ markdown: string }>('feedback/markdown', { id })).markdown); })}><Icon name="copy" size={14} />마크다운 복사</button>
      {item.status !== 'submitting' && <button type="button" className="danger" disabled={drafting} onClick={remove}><Icon name="trash" size={14} />삭제</button>}
      <span className="spacer" />
      {item.status !== 'submitted' && <span title={verdict.ok ? '제출' : verdict.reason}>
        <button type="button" className="primary" disabled={!verdict.ok || !!busy} onClick={submit}><Icon name="send" size={14} />{item.status === 'submitting' || busy === 'submit' ? '제출 중…' : item.status === 'failed' ? '다시 제출' : '제출'}</button>
      </span>}
    </footer>
    {!verdict.ok && item.status !== 'submitted' && <p className="feedback-reason">{verdict.reason}</p>}
    {annotating && <AnnotateImage src={feedbackFileUrl(item, annotating)} name={annotating} onClose={() => setAnnotating('')}
      onSave={async data => { try { await feedbackCall('feedback/image/replace', { id, name: annotating, data }); } catch (cause) { fail(cause); throw cause; } }} />}
  </>;
}
