import { useEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent } from 'react';
import { api } from './api';
import { Icon, IconButton, type IconName } from './Icon';
import { Markdown } from './Markdown';
import { toast } from './toast';
import { Dropdown, type Ask } from './views';
import { effortLabel, effortStyle, modelColor } from './chat-model';
import { AnnotateImage } from './AnnotateImage';
import { ago, base64Bytes, canSubmit, displayTitle, feedbackGroup, feedbackTypes, groupLabels, toggleType, typeTag, feedbackEffort, feedbackModelId, isEditable, isEmptyDraft, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TITLE, needsReview, queueEta, sourceLabels, statusLabels, type Feedback, type FeedbackAvailability, type FeedbackGroup, type FeedbackQueue, type FeedbackSource } from './feedback-model';
import { canCapture, ensureDraft, feedbackCall, openFeedback, removeLocal, requestCapture, startDraft, useFeedback, useQueueClock, type CaptureMode } from './feedback-store';

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
  const [mode, setMode] = useState<'start' | 'ai' | 'write'>('start'), [history, setHistory] = useState(false);
  const view = history ? 'history' : mode, viewNow = useRef(view);
  viewNow.current = view;
  const current = items.find(item => item.id === currentId);
  const now = useQueueClock(items.some(item => item.status === 'queued' || item.status === 'submitting'));
  // The blank draft the write screen starts with is not history.
  const sent = items.filter(item => !isEmptyDraft(item));
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
  // An item opened from anywhere (a history row, the status-bar badge, a pasted image) shows in the editor.
  useEffect(() => { if (currentId) { setMode('write'); setHistory(false); } }, [currentId]);
  // The panel opens straight into an editor: with nothing open, a fresh draft is made (an empty one is dropped again when the editor is left).
  useEffect(() => { if (view === 'write' && loaded && !error && !current) void startDraft().catch(fail); }, [view, loaded, error, !!current]);
  // Both ways in start fresh: "직접 작성" leaves whatever was open (a draft with text stays in 내역) and gets a new blank draft from the effect above.
  const startAi = () => { setMode('ai'); setHistory(false); };
  const startWrite = () => { openFeedback(''); setMode('write'); setHistory(false); };
  // The AI finished: show its draft in the editor, unless the person has gone elsewhere meanwhile.
  const aiDone = (id: string) => { if (viewNow.current === 'ai') openFeedback(id); else toast('auto_awesome', 'AI 작성이 끝났습니다. 내역에서 확인하세요'); };
  return <div className="review-panel feedback-panel" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDrop={event => { if (!event.defaultPrevented && addImages([...event.dataTransfer.files])) event.preventDefault(); }}>
    <header className="panel-head">
      {!history && mode !== 'start' && <IconButton icon="chevronLeft" tip="header" label="처음으로" onClick={() => setMode('start')} />}
      <Icon name="feedback" /><strong className="feedback-panel-title">피드백 요청</strong><QueueChip queue={queue} />
      <span className="spacer" />
      <button type="button" className="feedback-history-btn" aria-pressed={history} title={history ? '돌아가기' : '보낸 피드백 보기'} onClick={() => setHistory(value => !value)}>
        {history ? <><Icon name="arrowLeft" size={13} />돌아가기</> : <><Icon name="clock" size={13} />내역{sent.length > 0 && <b>{sent.length}</b>}</>}
      </button>
      <IconButton icon={props.wide ? 'minimize' : 'maximize'} tip="header" label={props.wide ? '패널 크기 줄이기' : '패널 넓게 보기'} onClick={props.toggleWide} />
      <IconButton icon="x" tip="none" label="피드백 요청 닫기" action="feedback" onClick={props.onClose} />
    </header>
    {error && <p className="feedback-note warn" role="alert">{error}</p>}
    {/* The AI screen stays mounted so a run in progress (and what was typed) survives a look at another screen. */}
    <FeedbackAi hidden={view !== 'ai'} items={items} available={available} onDone={aiDone} {...props} />
    {view === 'start' ? <FeedbackStart onAi={startAi} onWrite={startWrite} />
      : view === 'history' ? <FeedbackList items={sent} available={available} queue={queue} now={now} loaded={loaded} onWrite={() => { setHistory(false); setMode('start'); }} {...props} />
      : view === 'write' ? current ? <FeedbackDetail key={current.id} item={current} available={available} queue={queue} now={now} {...props} />
        : <div className="feedback-detail" aria-busy="true" /> : null}
  </div>;
}

// What the panel opens on: only the choice of how to write. Everything after it is the chosen screen.
function FeedbackStart({ onAi, onWrite }: { onAi(): void; onWrite(): void }) {
  return <div className="feedback-start">
    <h3>어떻게 작성할까요?</h3>
    <button type="button" className="feedback-choice" onClick={onAi}>
      <span className="feedback-choice-mark"><Icon name="sparkles" size={20} /></span>
      <span className="feedback-choice-text"><strong>AI로 작성</strong><small>짧게 적으면 AI가 정리해 줘요</small></span>
      <Icon name="chevronRight" size={16} />
    </button>
    <button type="button" className="feedback-choice" onClick={onWrite}>
      <span className="feedback-choice-mark"><Icon name="edit" size={20} /></span>
      <span className="feedback-choice-text"><strong>직접 작성</strong><small>제목과 내용을 직접 써요</small></span>
      <Icon name="chevronRight" size={16} />
    </button>
  </div>;
}

// "AI로 작성": one text box. What is typed becomes a draft, the AI writes title, text and types from it, and the finished draft opens on the 직접 작성 screen.
function FeedbackAi({ hidden, items, available, onDone, fail, aiContext, aiModel, aiEffort, onAiChange }: PanelProps & { hidden: boolean; items: Feedback[]; available: FeedbackAvailability | null; onDone(id: string): void }) {
  const [text, setText] = useState(''), [id, setId] = useState(''), [since, setSince] = useState(0);
  const model = feedbackModelId(aiModel), effort = feedbackEffort(aiEffort), busy = since > 0;
  const send = () => {
    const body = text.trim();
    if (!body || busy) return;
    setSince(Date.now());
    void (async () => {
      // A draft left by an earlier failed try is reused (its text updated) instead of making a second one.
      const draft = id && items.some(item => item.id === id) ? await feedbackCall('feedback/update', { id, body }) : await feedbackCall('feedback/create', { body });
      setId(draft.id);
      const context = await aiContext().catch(() => undefined);
      await feedbackCall('feedback/ai-draft', { id: draft.id, ...(context ? { context } : {}), model, effort });
      setText(''); setId('');
      onDone(draft.id);
    })().catch(fail).finally(() => setSince(0));
  };
  return <div className="feedback-ai" hidden={hidden}>
    <AvailabilityNote available={available} />
    <div className="feedback-ai-main">
      {busy ? <DraftProgress since={since} label="AI가 작성하는 중…" /> : <div className="feedback-empty">
        <span className="feedback-empty-mark"><Icon name="sparkles" size={26} /></span>
        <h3>대충 적어도 괜찮아요</h3>
        <p>AI가 제목·유형·내용으로 정리해 줘요.</p>
      </div>}
    </div>
    <div className="chat-composer feedback-compose" data-feedback-region="피드백 AI 입력창">
      <div className="chat-input-row">
        <textarea rows={1} value={text} readOnly={busy} autoFocus aria-label="AI로 작성할 내용" placeholder="어떤 점이 불편했나요?"
          onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
      </div>
      <div className="chat-foot">
        <Dropdown className="chat-model" label="AI 모델" value={model} options={AI_MODELS} onChange={value => onAiChange({ feedbackAiModel: value as AiModel })} />
        <Dropdown className={`chat-effort effort-${effort}`} label="Effort" value={effort} options={AI_EFFORTS} onChange={value => onAiChange({ feedbackAiEffort: value as AiEffort })} />
        <span className="drag-space" />
        <button type="button" className="chat-send" title="AI로 작성 (Enter)" aria-label="AI로 작성" disabled={!text.trim() || busy} onClick={send}><Icon name="arrowUp" size={16} /></button>
      </div>
    </div>
  </div>;
}

function AvailabilityNote({ available }: { available: FeedbackAvailability | null }) {
  if (!available || available.ok) return null;
  return <p className="feedback-note warn" role="status"><Icon name="info" size={14} />{available.reason || '지금은 피드백을 보낼 수 없습니다.'}</p>;
}

// "전송 대기 n건" next to the panel title while the server still has items to send.
const QueueChip = ({ queue }: { queue: FeedbackQueue }) => queue.size > 0 ? <span className="feedback-queue-chip" title="제출한 피드백이 순서대로 자동 전송됩니다">전송 대기 {queue.size}건</span> : null;

const groups: FeedbackGroup[] = ['todo', 'sending', 'done'];

// 내역: what was written or sent so far. A row opens in the same editor as everything else (no second screen to go back from).
function FeedbackList({ items, available, queue, now, loaded, ask, fail, onWrite }: PanelProps & { items: Feedback[]; available: FeedbackAvailability | null; queue: FeedbackQueue; now: number; loaded: boolean; onWrite(): void }) {
  const [filter, setFilter] = useState<'all' | FeedbackGroup>('all');
  const remove = (item: Feedback) => void (async () => {
    if (!(await ask.confirm('이 피드백을 삭제할까요? 이미지와 본문이 모두 지워집니다.'))) return;
    await api('feedback/delete', { id: item.id }); removeLocal(item.id);
  })().catch(fail);
  const counts: Record<FeedbackGroup, number> = { todo: 0, sending: 0, done: 0 };
  items.forEach(item => { counts[feedbackGroup(item)]++; });
  const active = filter !== 'all' && counts[filter] ? filter : 'all';
  const shown = active === 'all' ? items : items.filter(item => feedbackGroup(item) === active);
  const stamp = Date.now();
  return <>
    <AvailabilityNote available={available} />
    {items.length > 1 && <div className="feedback-filters" role="group" aria-label="피드백 거르기">
      <button type="button" className="chat-chip" aria-pressed={active === 'all'} onClick={() => setFilter('all')}>전체<b>{items.length}</b></button>
      {groups.filter(group => counts[group]).map(group => <button key={group} type="button" className={`chat-chip group-${group}`} aria-pressed={active === group} onClick={() => setFilter(group)}>{groupLabels[group]}<b>{counts[group]}</b></button>)}
    </div>}
    <div className="review-list feedback-list">
      {loaded && !items.length && <div className="feedback-empty">
        <span className="feedback-empty-mark"><Icon name="feedback" size={26} /></span>
        <h3>아직 보낸 피드백이 없어요</h3>
        <p>불편한 점이나 바라는 점을 알려 주세요.</p>
        <button type="button" className="primary feedback-submit" onClick={onWrite}><Icon name="edit" size={14} />피드백 쓰기</button>
      </div>}
      {shown.map((item, index) => {
        const unseen = needsReview(item), thumb = item.images[0], title = displayTitle(item);
        return <div key={item.id} className="feedback-row-wrap" style={{ '--i': Math.min(index, 8) } as CSSProperties}>
          <button type="button" className={`feedback-row${unseen ? ' unseen' : ''}`} data-status={item.status} onClick={() => openFeedback(item.id)}>
            <span className="feedback-thumb">{thumb ? <img src={feedbackFileUrl(item, thumb.name)} alt="" loading="lazy" /> : <Icon name={sourceIcons[item.source]} size={18} />}</span>
            <span className="feedback-row-main">
              <strong className={title ? '' : 'untitled'}>{title || '(내용 없음)'}</strong>
              <small>
                <span className={`feedback-status status-${item.status}`}>{statusLabels[item.status]}</span>
                {(item.status === 'queued' || item.status === 'submitting') && <span className="feedback-eta">{queueEta(item, queue, now)}</span>}
                {item.types.map(typeId => <span key={typeId} className="feedback-tag">{typeTag(typeId)}</span>)}
                {item.source !== 'human' && <span className="feedback-source" title={sourceLabels[item.source]}><Icon name={sourceIcons[item.source]} size={13} />{sourceLabels[item.source]}</span>}
                {item.images.length > 0 && <span className="feedback-count" title={`이미지 ${item.images.length}장`}><Icon name="image" size={12} />{item.images.length}</span>}
                <time dateTime={new Date(item.updatedAt).toISOString()} title={new Date(item.updatedAt).toLocaleString('ko-KR')}>{ago(item.updatedAt, stamp)}</time>
              </small>
            </span>
            {unseen && <i className="feedback-dot" aria-label="아직 검토하지 않음" />}
            <Icon name="chevronRight" size={16} />
          </button>
          {item.status !== 'submitting' && <IconButton icon="trash" tip="none" className="feedback-row-delete" label="이 피드백 삭제" size={14} disabled={item.status === 'drafting'} onClick={() => remove(item)} />}
        </div>;
      })}
    </div>
  </>;
}

// The AI run has no partial output to show, so say that it is running, for how long, and what a normal wait looks like.
function DraftProgress({ since, label }: { since: number; label: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return <div className="feedback-progress" role="status">
    <span className="feedback-spinner" aria-hidden="true" />
    <div>
      <strong>{label}<span aria-hidden="true"> {seconds}초</span></strong>
      <small>{seconds < 45 ? '보통 10~30초 걸립니다. 다른 화면으로 가도 계속 진행됩니다.' : '평소보다 오래 걸리고 있습니다. 2분이 넘으면 자동으로 멈추고 이유를 알려 드립니다.'}</small>
    </div>
    <i className="feedback-progress-bar" aria-hidden="true" />
  </div>;
}

function FeedbackDetail({ item, available, queue, now, ask, fail, aiContext, aiModel, aiEffort, onAiChange }: PanelProps & { item: Feedback; available: FeedbackAvailability | null; queue: FeedbackQueue; now: number }) {
  const editable = isEditable(item);
  const [title, setTitle] = useState(item.title), [body, setBody] = useState(item.body), [tab, setTab] = useState<'edit' | 'preview'>(editable ? 'edit' : 'preview');
  const [busy, setBusy] = useState(''), [annotating, setAnnotating] = useState(''), [dragging, setDragging] = useState(false);
  // Picked types show at once; a server update only replaces them while none of this screen's saves is in flight.
  const [types, setTypes] = useState(item.types), typeSaves = useRef(0);
  // Edits not yet saved: a server update (AI draft done, another screen) only replaces the fields when nothing local is pending.
  const pending = useRef<{ title: string; body: string } | null>(null), timer = useRef(0), saving = useRef<Promise<unknown> | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const id = item.id;

  useEffect(() => { if (!pending.current) { setTitle(item.title); setBody(item.body); } if (!typeSaves.current) setTypes(item.types); }, [item.updatedAt]);
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
  const onDrop = (event: DragEvent) => { setDragging(false); if (!editable || !event.dataTransfer.files.length) return; event.preventDefault(); addFiles([...event.dataTransfer.files]); };
  const overFiles = (event: DragEvent) => editable && event.dataTransfer.types.includes('Files');

  const live = { ...item, types, title: pending.current?.title ?? title, body: pending.current?.body ?? body };
  latest.current = live;
  const verdict = canSubmit(live, available);
  const drafting = item.status === 'drafting' || busy === 'ai';
  const submit = () => run('submit', async () => {
    await flush();
    const how = available?.mode === 'anonymous' ? '로그인 없이 제출합니다.' : `${available?.account ? `${available.account} 계정으로` : '로그인한 계정으로'} 제출합니다.`;
    if (!(await ask.confirm(`피드백을 제출할까요? ${how}${item.images.length ? ' 스크린샷에 비밀 정보가 없는지 확인하세요.' : ''}`))) return;
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
  const capture = (mode: CaptureMode) => { void flush().catch(fail); requestCapture(mode); };
  // Types can be picked in any number; each pick is saved at once.
  const toggle = (typeId: string) => {
    const next = toggleType(types, typeId);
    setTypes(next); typeSaves.current++;
    void feedbackCall('feedback/update', { id, types: next }).catch(fail).finally(() => { typeSaves.current--; });
  };

  return <>
    <div className="feedback-detail" onPaste={onPaste} onDragEnter={event => { if (overFiles(event)) setDragging(true); }} onDragOver={event => { if (editable) event.preventDefault(); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={onDrop}>
      {dragging && <div className="feedback-drop" aria-hidden="true"><Icon name="image" size={28} /><strong>여기에 놓으면 이미지가 추가됩니다</strong></div>}
      {editable && <div className="feedback-types" role="group" aria-label="피드백 유형 (여러 개 선택 가능)">
        {feedbackTypes.map(type => <button key={type.id} type="button" className="chat-chip" aria-pressed={types.includes(type.id)} disabled={drafting} onClick={() => toggle(type.id)}><Icon name={type.icon as IconName} size={13} />{type.tag}</button>)}
      </div>}
      {(item.status === 'queued' || item.status === 'submitting') && <div className="feedback-note queued" role="status">
        <Icon name={item.status === 'submitting' ? 'send' : 'clock'} size={14} />
        <span>{item.status === 'submitting' ? '전송 중…' : `전송 대기 · ${queueEta(item, queue, now)}`}{item.attempts ? <small> · {item.attempts}번 시도함</small> : null}</span>
        {item.status === 'queued' && <button type="button" disabled={!!busy} onClick={() => run('unqueue', () => feedbackCall('feedback/unqueue', { id }))}><Icon name="x" size={13} />대기 취소</button>}
        {item.status === 'queued' && item.error && <small className="feedback-last-error">마지막 시도: {item.error}</small>}
      </div>}
      {item.status === 'submitted' && <div className="feedback-note ok">
        <span className="feedback-done-mark"><Icon name="check" size={14} /></span><span>{item.via === 'anonymous' ? '로그인 없이 제출됨' : '제출했습니다'}{item.issueNumber ? ` · 이슈 #${item.issueNumber}` : ''}</span>
        {item.issueUrl && <button type="button" onClick={() => window.open(item.issueUrl, '_blank', 'noopener')}><Icon name="externalLink" size={13} />이슈 열기</button>}
      </div>}
      {item.status === 'failed' && item.error && <p className="feedback-note warn" role="alert"><Icon name="alert" size={14} />{item.error}</p>}
      {drafting && <DraftProgress since={item.status === 'drafting' ? item.updatedAt : started.current || Date.now()} label="AI가 다듬는 중…" />}

      <section className={`feedback-card${drafting ? ' drafting' : ''}`} data-feedback-region="피드백 작성 카드">
        <div className="feedback-title-row">
          <input className="feedback-title" aria-label="피드백 제목 (선택)" placeholder="제목 (선택)" maxLength={MAX_TITLE} value={title} readOnly={!editable || drafting} onChange={event => edit({ title: event.target.value })} />
          {editable && types.length > 0 && /\[[^\]]*\]/.test(title) && <span className="feedback-title-warn" title="고른 유형이 제목 앞에 [버그]처럼 자동으로 붙어서, 제목에 직접 쓴 [ ]와 중복될 수 있어요."><Icon name="alert" size={12} />[ ] 중복 주의</span>}
        </div>
        {tab === 'edit' && editable
          ? <textarea className="feedback-body" aria-label="피드백 내용 (마크다운)" autoFocus={!body} placeholder={drafting ? 'AI가 다듬는 중…' : '내용'} value={body} readOnly={drafting} onChange={event => edit({ body: event.target.value })}
            onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && canDraft) { event.preventDefault(); draft(); } }} />
          : <div className="feedback-preview">{body.trim() ? <Markdown text={body} /> : <p className="hint">내용이 없습니다.</p>}</div>}

        {item.images.length > 0 && <ol className="feedback-strip" aria-label={`이미지 ${item.images.length}/${MAX_IMAGES}`}>{item.images.map((image, index) => <li key={image.name} style={{ '--i': index } as CSSProperties}>
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

        <div className="feedback-card-bar">
          {editable && <span className="feedback-capture-buttons">
            {canCapture() && <>
              <IconButton icon="captureElement" label="요소 캡쳐" onClick={() => capture('element')} disabled={item.images.length >= MAX_IMAGES} />
              <IconButton icon="captureWindow" label="창 전체 캡쳐" onClick={() => capture('window')} disabled={item.images.length >= MAX_IMAGES} />
              <IconButton icon="captureRange" label="범위 캡쳐" onClick={() => capture('range')} disabled={item.images.length >= MAX_IMAGES} />
            </>}
            <IconButton icon="image" label="이미지 파일 추가" onClick={() => file.current?.click()} disabled={item.images.length >= MAX_IMAGES || busy === 'image'} />
          </span>}
          <small className="feedback-count-hint">{item.images.length ? `이미지 ${item.images.length}/${MAX_IMAGES}` : editable ? '붙여넣기·끌어다 놓기로 추가' : '이미지 없음'}</small>
          <span className="spacer" />
          {editable && <div className="feedback-tabs" role="tablist" aria-label="본문 보기" data-tab={tab}>
            <button type="button" role="tab" aria-selected={tab === 'edit'} onClick={() => setTab('edit')}>편집</button>
            <button type="button" role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>미리보기</button>
          </div>}
          {item.status !== 'submitting' && !isEmptyDraft(live) && <IconButton icon="trash" tip="none" className="feedback-head-delete" label="이 피드백 삭제" size={14} disabled={drafting || busy === 'delete'} onClick={remove} />}
          <input ref={file} type="file" accept="image/*" multiple hidden onChange={event => { addFiles([...(event.target.files ?? [])]); event.target.value = ''; }} />
        </div>
      </section>
    </div>
    <AvailabilityNote available={editable ? available : null} />
    {editable && <>
      {item.source !== 'human' && <p className="feedback-reason"><Icon name={sourceIcons[item.source]} size={13} />{item.source === 'ai' ? 'AI가 작성한' : '에이전트가 넣은'} 초안이에요. 내용을 확인하고 고친 뒤 제출하세요.</p>}
      {!verdict.ok && <p className="feedback-reason" role="status"><Icon name="info" size={13} />{verdict.reason}</p>}
      <footer className="feedback-actions">
        <span className="feedback-pick">
          <Dropdown className="chat-model" label="AI 모델" value={model} options={AI_MODELS} onChange={value => onAiChange({ feedbackAiModel: value as AiModel })} />
          <Dropdown className={`chat-effort effort-${effort}`} label="Effort" value={effort} options={AI_EFFORTS} onChange={value => onAiChange({ feedbackAiEffort: value as AiEffort })} />
        </span>
        <span className="spacer" />
        <button type="button" className={`feedback-ai-btn${drafting ? ' busy' : ''}`} disabled={!canDraft} aria-label="AI로 다듬기" title={canDraft ? 'AI로 다듬기: 쓴 내용을 문제·기대 동작·제안으로 다듬고 유형도 골라 줍니다 (⌘/Ctrl+Enter)' : 'AI로 다듬기: 내용을 적거나 이미지를 넣어 주세요'} onClick={draft}><Icon name="sparkles" size={14} /><span className="feedback-btn-text">{drafting ? '다듬는 중…' : 'AI로 다듬기'}</span></button>
        <span title={verdict.ok ? (available?.mode === 'anonymous' ? '로그인 없이 제출' : '제출') : verdict.reason}>
          <button type="button" className="primary feedback-submit" disabled={!verdict.ok || !!busy} onClick={submit}><Icon name="send" size={14} />{busy === 'submit' ? '제출 중…' : item.status === 'failed' ? '다시 제출' : '제출'}</button>
        </span>
      </footer>
    </>}
    {annotating && <AnnotateImage src={feedbackFileUrl(item, annotating)} name={annotating} onClose={() => setAnnotating('')}
      onSave={async data => { try { await feedbackCall('feedback/image/replace', { id, name: annotating, data }); } catch (cause) { fail(cause); throw cause; } }} />}
  </>;
}
