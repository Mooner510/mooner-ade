import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { api } from './api';
import { Icon, IconButton, type IconName } from './Icon';
import { Markdown } from './Markdown';
import { toast } from './toast';
import { Dropdown, type Ask } from './views';
import { effortLabel, effortStyle, modelColor } from './chat-model';
import { AnnotateImage } from './AnnotateImage';
import { base64Bytes, canSubmit, displayTitle, feedbackEffort, feedbackModelId, isEditable, isEmptyDraft, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TITLE, needsReview, queueEta, sourceLabels, statusLabels, type Feedback, type FeedbackAvailability, type FeedbackQueue, type FeedbackSource } from './feedback-model';
import { canCapture, createFeedback, ensureDraft, feedbackCall, openFeedback, removeLocal, requestCapture, useFeedback, useQueueClock, type CaptureMode } from './feedback-store';

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

type PanelProps = { ask: Ask; fail(cause: unknown): void; wide: boolean; toggleWide(): void; onClose(): void; aiContext(): Promise<string | undefined>; aiModel?: string; aiEffort?: string; onAiChange(patch: { feedbackAiModel?: AiModel; feedbackAiEffort?: AiEffort }): void };
type AiModel = '' | 'claude-haiku-5-5' | 'claude-sonnet-5-5' | 'claude-opus-5-5' | 'sonnet' | 'opus'; type AiEffort = '' | 'low' | 'medium' | 'high';
// The footer picks from these only: Haiku 5.5 + low is the default, and Effort stops at Medium. A saved Claude Code default ('') or 'high' shows as the default.
export const AI_MODELS = [{ value: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: '빠르고 가벼움 · 기본' }, { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: '균형' }, { value: 'claude-opus-5-5', label: 'Opus 5.5', hint: '가장 정교하지만 느림' }]
  .map(model => ({ ...model, color: modelColor(model.value) }));
export const AI_EFFORTS = [{ value: 'low', hint: '빠르게 · 기본' }, { value: 'medium', hint: '더 꼼꼼하게' }].map(item => ({ ...item, label: effortLabel(item.value), ...effortStyle[item.value] }));

export function FeedbackPanel(props: PanelProps) {
  const { items, available, queue, loaded, error, currentId } = useFeedback();
  const current = items.find(item => item.id === currentId);
  const now = useQueueClock(items.some(item => item.status === 'queued' || item.status === 'submitting'));
  // An image pasted or dropped anywhere in the panel (or pasted outside a text field while it is open) goes into the open draft, or a new one.
  const { fail } = props;
  const addImages = (files: File[]) => {
    const images = files.filter(entry => entry.type.startsWith('image/'));
    if (!images.length) return false;
    void (async () => {
      const item = await ensureDraft(), room = MAX_IMAGES - item.images.length;
      if (room <= 0) throw new Error(`이미지는 ${MAX_IMAGES}장까지 넣을 수 있습니다.`);
      for (const entry of images.slice(0, room)) await feedbackCall('feedback/image/add', { id: item.id, ...(await imagePayload(entry)) });
      openFeedback(item.id);
    })().catch(fail);
    return true;
  };
  useEffect(() => {
    const onPaste = (event: globalThis.ClipboardEvent) => {
      if (event.defaultPrevented || (event.target as Element | null)?.closest?.('input, textarea, [contenteditable="true"]')) return;
      if (addImages([...(event.clipboardData?.files ?? [])])) event.preventDefault();
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [fail]);
  return <div className="review-panel feedback-panel" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDrop={event => { if (!event.defaultPrevented && addImages([...event.dataTransfer.files])) event.preventDefault(); }}>
    {current ? <FeedbackDetail key={current.id} item={current} available={available} queue={queue} now={now} {...props} />
      : <FeedbackList items={items} available={available} queue={queue} now={now} loaded={loaded} error={error} {...props} />}
  </div>;
}

function AvailabilityNote({ available }: { available: FeedbackAvailability | null }) {
  if (!available || available.ok) return null;
  return <p className="feedback-note warn" role="status"><Icon name="info" size={14} />{available.reason || '지금은 피드백을 보낼 수 없습니다.'}</p>;
}

// "전송 대기 n건" next to the panel title while the server still has items to send.
const QueueChip = ({ queue }: { queue: FeedbackQueue }) => queue.size > 0 ? <span className="feedback-queue-chip" title="제출한 피드백이 순서대로 자동 전송됩니다">전송 대기 {queue.size}건</span> : null;

function FeedbackList({ items, available, queue, now, loaded, error, fail, wide, toggleWide, onClose }: PanelProps & { items: Feedback[]; available: FeedbackAvailability | null; queue: FeedbackQueue; now: number; loaded: boolean; error: string }) {
  const [creating, setCreating] = useState(false);
  const create = () => { setCreating(true); void createFeedback().catch(fail).finally(() => setCreating(false)); };
  const when = (at: number) => new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return <>
    <header className="panel-head">
      <Icon name="feedback" /><strong>피드백 요청</strong><QueueChip queue={queue} />
      <span className="spacer" />
      <button type="button" className="primary feedback-new" disabled={creating} onClick={create}><Icon name="plus" size={14} />새 피드백</button>
      <IconButton icon={wide ? 'minimize' : 'maximize'} tip="header" label={wide ? '패널 크기 줄이기' : '패널 넓게 보기'} onClick={toggleWide} />
      <IconButton icon="x" tip="none" label="피드백 요청 닫기" onClick={onClose} />
    </header>
    <AvailabilityNote available={available} />
    <div className="review-list feedback-list">
      {error && <p className="feedback-note warn" role="alert">{error}</p>}
      {loaded && !items.length && !error && <div className="review-empty"><Icon name="feedback" size={22} /><strong>피드백이 없습니다</strong><p>'새 피드백'에 불편한 점이나 바라는 점을 적어 보내 주세요.</p></div>}
      {items.map(item => {
        const unseen = needsReview(item), thumb = item.images[0];
        return <button type="button" key={item.id} className={`feedback-row${unseen ? ' unseen' : ''}`} onClick={() => openFeedback(item.id)}>
          <span className="feedback-thumb">{thumb ? <img src={feedbackFileUrl(item, thumb.name)} alt="" loading="lazy" /> : <Icon name="image" size={18} />}</span>
          <span className="feedback-row-main">
            <strong className={displayTitle(item) ? '' : 'untitled'}>{displayTitle(item) || '(내용 없음)'}</strong>
            <small>
              <span className="feedback-source" title={sourceLabels[item.source]}><Icon name={sourceIcons[item.source]} size={13} /></span>
              <span className={`feedback-status status-${item.status}`}>{statusLabels[item.status]}</span>
              {(item.status === 'queued' || item.status === 'submitting') && <span className="feedback-eta">{queueEta(item, queue, now)}</span>}
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

// The AI run has no partial output to show, so say that it is running, for how long, and what a normal wait looks like.
function DraftProgress({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return <div className="feedback-progress" role="status">
    <span className="feedback-spinner" aria-hidden="true" />
    <div>
      <strong>AI가 정리하는 중…<span aria-hidden="true"> {seconds}초</span></strong>
      <small>{seconds < 45 ? '보통 10~30초 걸립니다. 다른 화면으로 가도 계속 진행됩니다.' : '평소보다 오래 걸리고 있습니다. 2분이 넘으면 자동으로 멈추고 이유를 알려 드립니다.'}</small>
    </div>
    <i className="feedback-progress-bar" aria-hidden="true" />
  </div>;
}

function FeedbackDetail({ item, available, queue, now, ask, fail, wide, toggleWide, onClose, aiContext, aiModel, aiEffort, onAiChange }: PanelProps & { item: Feedback; available: FeedbackAvailability | null; queue: FeedbackQueue; now: number }) {
  const editable = isEditable(item);
  const [title, setTitle] = useState(item.title), [body, setBody] = useState(item.body), [tab, setTab] = useState<'edit' | 'preview'>(editable ? 'edit' : 'preview');
  const [busy, setBusy] = useState(''), [annotating, setAnnotating] = useState('');
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
  // Leaving (back, close, switching away) saves what is pending and removes a draft that is still empty.
  const latest = useRef(item), gone = useRef(false);
  useEffect(() => () => {
    void (async () => {
      await flush();
      if (gone.current || !isEmptyDraft(latest.current)) return;
      gone.current = true; await api('feedback/delete', { id }); removeLocal(id);
    })().catch(fail);
  }, []);
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
  latest.current = live;
  const verdict = canSubmit(live, available);
  const drafting = item.status === 'drafting' || busy === 'ai';
  const submit = () => run('submit', async () => {
    await flush();
    const how = available?.mode === 'anonymous'
      ? '로그인 없이(익명) 보냅니다. 이 기기에서 5분에 1건씩 자동 전송되며 앱을 다시 켜도 이어집니다.'
      : `${available?.account ? `${available.account} 계정으로` : '로그인한 계정으로'} 개발자의 비공개 GitHub 저장소에 이슈로 올립니다.`;
    if (!(await ask.confirm(`피드백을 제출할까요? ${how} 스크린샷에 코드나 비밀 정보가 없는지 확인하세요.`))) return;
    const sent = await feedbackCall('feedback/submit', { id });
    toast('schedule_send', sent.status === 'submitted' ? '제출했습니다' : '전송 대기열에 넣었습니다');
  });
  const effort = feedbackEffort(aiEffort), model = feedbackModelId(aiModel), canDraft = editable && !busy && !drafting && (!!body.trim() || !!item.images.length);
  const started = useRef(0);
  const draft = () => run('ai', async () => {
    started.current = Date.now();
    await flush();
    const context = await aiContext().catch(() => undefined);
    await feedbackCall('feedback/ai-draft', { id, ...(context ? { context } : {}), model, effort });
  });
  const remove = () => run('delete', async () => {
    if (!(await ask.confirm('이 피드백을 삭제할까요? 이미지와 본문이 모두 지워집니다.'))) return;
    clearTimeout(timer.current); pending.current = null; gone.current = true;
    await api('feedback/delete', { id }); removeLocal(id);
  });
  const back = () => { void flush().catch(fail); openFeedback(''); };
  const capture = (mode: CaptureMode) => { void flush().catch(fail); requestCapture(mode); };

  return <>
    <header className="panel-head">
      <IconButton icon="chevronLeft" tip="header" label="목록으로" onClick={back} />
      <strong className="feedback-head-title">{displayTitle(live) || '새 피드백'}</strong>
      <span className={`feedback-status status-${item.status}`}>{drafting ? statusLabels.drafting : statusLabels[item.status]}</span>
      <span className="spacer" />
      {item.status !== 'submitting' && <><IconButton icon="trash" tip="header" className="feedback-head-delete" label="이 피드백 삭제" disabled={drafting || busy === 'delete'} onClick={remove} /><i className="feedback-head-sep" aria-hidden="true" /></>}
      <IconButton icon={wide ? 'minimize' : 'maximize'} tip="header" label={wide ? '패널 크기 줄이기' : '패널 넓게 보기'} onClick={toggleWide} />
      <IconButton icon="x" tip="none" label="피드백 요청 닫기" onClick={onClose} />
    </header>
    <div className="feedback-detail" onPaste={onPaste} onDragOver={event => { if (editable) event.preventDefault(); }} onDrop={onDrop}>
      {(item.status === 'queued' || item.status === 'submitting') && <div className="feedback-note queued" role="status">
        <Icon name={item.status === 'submitting' ? 'send' : 'clock'} size={14} />
        <span>{item.status === 'submitting' ? '전송 중…' : `전송 대기 · ${queueEta(item, queue, now)}`}{item.attempts ? <small> · {item.attempts}번 시도함</small> : null}</span>
        {item.status === 'queued' && <button type="button" disabled={!!busy} onClick={() => run('unqueue', () => feedbackCall('feedback/unqueue', { id }))}><Icon name="x" size={13} />대기 취소</button>}
        {item.status === 'queued' && item.error && <small className="feedback-last-error">마지막 시도: {item.error}</small>}
      </div>}
      {item.status === 'submitted' && <div className="feedback-note ok">
        <Icon name="check" size={14} /><span>{item.via === 'anonymous' ? '로그인 없이 제출됨' : '제출했습니다'}{item.issueNumber ? ` · 이슈 #${item.issueNumber}` : ''}</span>
        {item.issueUrl && <button type="button" onClick={() => window.open(item.issueUrl, '_blank', 'noopener')}><Icon name="externalLink" size={13} />이슈 열기</button>}
      </div>}
      {item.status === 'failed' && item.error && <p className="feedback-note warn" role="alert"><Icon name="alert" size={14} />{item.error}</p>}
      {drafting && <DraftProgress since={item.status === 'drafting' ? item.updatedAt : started.current || Date.now()} />}
      {item.source !== 'human' && <p className="feedback-note"><Icon name={sourceIcons[item.source]} size={14} />{sourceLabels[item.source]}입니다. 내용을 확인하고 고친 뒤 제출하세요.</p>}

      <div className="feedback-tabs" role="tablist" aria-label="본문 보기">
        <button type="button" role="tab" aria-selected={tab === 'edit'} aria-pressed={tab === 'edit'} disabled={!editable} onClick={() => setTab('edit')}>작성</button>
        <button type="button" role="tab" aria-selected={tab === 'preview'} aria-pressed={tab === 'preview'} onClick={() => setTab('preview')}>미리보기</button>
        <span className="spacer" />
      </div>
      {tab === 'edit' && editable
        ? <textarea className="feedback-body" aria-label="피드백 내용 (마크다운)" autoFocus={!body} placeholder={drafting ? 'AI가 초안을 쓰는 중입니다…' : '불편했던 점이나 바라는 동작을 적어 주세요.\n짧게 적고 \'AI로 정리\'(⌘/Ctrl+Enter)를 누르면 문제·기대 동작·제안으로 정리해 줍니다.'} value={body} readOnly={drafting} onChange={event => edit({ body: event.target.value })}
          onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && canDraft) { event.preventDefault(); draft(); } }} />
        : <div className="feedback-preview">{body.trim() ? <Markdown text={body} /> : <p className="hint">내용이 없습니다.</p>}</div>}
      <input className="feedback-title" aria-label="피드백 제목 (선택)" placeholder="제목 (선택 · 비우면 내용 첫 줄로 자동 지정)" maxLength={MAX_TITLE} value={title} readOnly={!editable || drafting} onChange={event => edit({ title: event.target.value })} />

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
        {!item.images.length ? <p className="hint">{editable ? '캡쳐하거나 붙여넣기(⌘/Ctrl+V)·끌어다 놓기로 추가합니다.' : '이미지 없음'}</p>
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
    <AvailabilityNote available={editable ? available : null} />
    {editable && <>
      {!verdict.ok && <p className="feedback-reason" role="status"><Icon name="info" size={13} />{verdict.reason}</p>}
      <footer className="feedback-actions">
        <span className="feedback-pick">
          <Dropdown className="chat-model" label="AI 모델" value={model} options={AI_MODELS} onChange={value => onAiChange({ feedbackAiModel: value as AiModel })} />
          <Dropdown className={`chat-effort effort-${effort}`} label="Effort" value={effort} options={AI_EFFORTS} onChange={value => onAiChange({ feedbackAiEffort: value as AiEffort })} />
        </span>
        <span className="spacer" />
        <button type="button" className="feedback-ai-btn" disabled={!canDraft} aria-label="AI로 정리" title={canDraft ? 'AI로 정리: 내용을 문제·기대 동작·제안으로 정리합니다 (⌘/Ctrl+Enter)' : 'AI로 정리: 내용을 적거나 이미지를 넣어 주세요'} onClick={draft}><Icon name="sparkles" size={14} /><span className="feedback-btn-text">{drafting ? 'AI 작성 중…' : 'AI로 정리'}</span></button>
        <span title={verdict.ok ? (available?.mode === 'anonymous' ? '로그인 없이 제출' : '제출') : verdict.reason}>
          <button type="button" className="primary" disabled={!verdict.ok || !!busy} onClick={submit}><Icon name="send" size={14} />{busy === 'submit' ? '제출 중…' : item.status === 'failed' ? '다시 제출' : '제출'}</button>
        </span>
      </footer>
    </>}
    {annotating && <AnnotateImage src={feedbackFileUrl(item, annotating)} name={annotating} onClose={() => setAnnotating('')}
      onSave={async data => { try { await feedbackCall('feedback/image/replace', { id, name: annotating, data }); } catch (cause) { fail(cause); throw cause; } }} />}
  </>;
}
