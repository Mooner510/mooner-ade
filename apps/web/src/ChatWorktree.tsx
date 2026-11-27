// A chat's git worktree on screen: the badge (pane header, under the composer), the start-screen choice "격리된 worktree에서 시작", the
// worktree panel (where it is, go in or out, merge, let it go) and the merge flow ("원본으로 합치기"). The chat pane takes it through one hook
// (useChatWorktree) so its own file only gets a few insertions. The project-wide list of chat worktrees is WorktreeManager, opened from the palette.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Icon, SettingGlyph } from './Icon';
import { Modal } from './views';
import { copyText } from './toast';
import { defaultCommitMessage, worktreeBadge, worktreeOf, type WorktreeInfo, type WorktreeMark } from './chat-worktree.ts';
import './chat-worktree.css';

type Call = <T = any>(action: string, input?: object) => Promise<T>;
type Preview = { status: NonNullable<WorktreeInfo['status']>; commits: { hash: string; short: string; subject: string }[]; changes: { path: string; added: number; deleted: number }[]; conflicts: string[]; fastForward: boolean };
type Blocked = { code: string; message: string; files: string[]; prompt?: string };
type MergeResult = { merged: boolean; reason?: string; fastForward?: boolean; into?: string; commit?: string; commits?: number; blocked?: Blocked; info?: WorktreeInfo | null };
// The workspace asks a chat pane to open its worktree panel (closing a chat whose worktree still has work in it).
export const OPEN_WORKTREE_EVENT = 'ade:chat-worktree-open';
export const openChatWorktree = (id: string, view: 'panel' | 'merge' = 'merge') => window.dispatchEvent(new CustomEvent(OPEN_WORKTREE_EVENT, { detail: { id, view } }));

// The little branch mark: branch, ↑ commits ahead, ● uncommitted files. Its colour says the state; the tooltip has the path and origin.
export function WorktreeBadge({ info, compact = false, onClick }: { info: WorktreeInfo; compact?: boolean; onClick?(): void }) {
  const badge = worktreeBadge(info);
  const body = <><SettingGlyph icon="account_tree" size={compact ? 12 : 13} /><span className="wt-label">{badge.label}</span>{badge.ahead > 0 && <span className="wt-ahead">↑{badge.ahead}</span>}{badge.dirty > 0 && <span className="wt-dirty">●{badge.dirty}</span>}</>;
  return onClick
    ? <button type="button" className="wt-badge" data-tone={badge.tone} data-out={info.inside ? undefined : ''} data-compact={compact || undefined} title={`${badge.title}\n\n눌러서 worktree 열기`} aria-label={`worktree ${badge.label}`} onClick={event => { event.stopPropagation(); onClick(); }}>{body}</button>
    : <span className="wt-badge" data-tone={badge.tone} data-out={info.inside ? undefined : ''} data-compact={compact || undefined} title={badge.title}>{body}</span>;
}

// The sidebar's mark for a tab or pane whose chat holds a worktree (main.tsx).
export function WorktreeRowMark({ mark }: { mark: WorktreeMark }) {
  return <span className="wt-badge" data-tone={mark.tone} data-out={mark.inside ? undefined : ''} title={mark.title} aria-label={`worktree ${mark.label}`}><SettingGlyph icon="account_tree" size={11} />{mark.ahead > 0 && <span className="wt-ahead">↑{mark.ahead}</span>}{mark.dirty > 0 && <span className="wt-dirty">●{mark.dirty}</span>}</span>;
}

type Hook = { id: string; state: unknown; call: Call; busy: boolean; fresh: boolean; title: string; fail(cause: unknown): void; prefill(text: string): void };
// Everything the chat pane shows for its worktree. `fresh`: the chat has said nothing yet (the start screen).
export function useChatWorktree({ id, state, call, busy, fresh, title, fail, prefill }: Hook) {
  const info = worktreeOf(state);
  const [open, setOpen] = useState<null | 'panel' | 'merge' | 'release'>(null), [working, setWorking] = useState(false);
  useEffect(() => {
    const onOpen = (event: Event) => { const detail = (event as CustomEvent<{ id: string; view: 'panel' | 'merge' }>).detail; if (detail?.id === id) setOpen(detail.view); };
    window.addEventListener(OPEN_WORKTREE_EVENT, onOpen); return () => window.removeEventListener(OPEN_WORKTREE_EVENT, onOpen);
  }, [id]);
  const act = useCallback(async (action: string, input: object = {}) => {
    setWorking(true);
    try { return await call(action, { id, ...input }); } catch (cause) { fail(cause); return null; } finally { setWorking(false); }
  }, [call, id, fail]);
  const enter = () => void act('chat/worktree/enter');
  const startChoice = fresh && (!info || (info.inside && info.managed && !info.status?.ahead && !info.status?.dirty))
    ? <button type="button" className="wt-start" aria-pressed={Boolean(info?.inside)} disabled={working || busy} title={info ? `${info.path}\n원본: ${info.origin}` : '이 채팅만의 브랜치와 폴더(git worktree)에서 시작합니다. 원본 작업 트리는 건드리지 않고, 끝나면 원본으로 합칩니다.'}
      onClick={() => void (info?.inside ? act('chat/worktree/remove', { deleteBranch: true }) : act('chat/worktree/enter'))}>
      <SettingGlyph icon={info?.inside ? 'check_box' : 'check_box_outline_blank'} size={16} />{info?.inside ? <>격리된 worktree에서 시작 · <b>{info.branch}</b></> : '격리된 worktree에서 시작'}</button>
    : null;
  const view = open && info ? <WorktreePanel info={info} view={open} title={title} busy={busy || working} call={call} id={id} act={act} onView={setOpen} onClose={() => setOpen(null)} onPrefill={text => { prefill(text); setOpen(null); }} onEnter={enter} /> : null;
  return {
    info,
    head: info ? <WorktreeBadge info={info} compact onClick={() => setOpen('panel')} /> : null,
    foot: info ? <span className="wt-foot"><WorktreeBadge info={info} onClick={() => setOpen('panel')} /></span> : null,
    start: startChoice,
    dialogs: view
  };
}

function Files({ items, max = 12 }: { items: string[]; max?: number }) {
  if (!items.length) return null;
  return <ul className="wt-files">{items.slice(0, max).map(file => <li key={file}><code>{file}</code></li>)}{items.length > max && <li className="wt-more">외 {items.length - max}개</li>}</ul>;
}

function WorktreePanel({ info, view, title, busy, call, id, act, onView, onClose, onPrefill, onEnter }: { info: WorktreeInfo; view: 'panel' | 'merge' | 'release'; title: string; busy: boolean; call: Call; id: string; act(action: string, input?: object): Promise<any>; onView(view: 'panel' | 'merge' | 'release'): void; onClose(): void; onPrefill(text: string): void; onEnter(): void }) {
  const status = info.status, badge = worktreeBadge(info);
  const [preview, setPreview] = useState<Preview | null>(null), [message, setMessage] = useState(''), [result, setResult] = useState<MergeResult | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(true), [discard, setDiscard] = useState(false), [confirm, setConfirm] = useState('');
  useEffect(() => {
    if (view !== 'merge' && view !== 'release') return;
    let live = true;
    void call<{ preview?: Preview }>('chat/worktree/status', { id, detail: true }).then(value => { if (!live) return; setPreview(value.preview ?? null); if (value.preview?.status.files?.length) setMessage(current => current || defaultCommitMessage(title, value.preview!.status.files!)); }, () => {});
    return () => { live = false; };
  }, [view, call, id, title, info.status?.head, info.status?.dirty]);
  const dirty = preview?.status.dirty ?? status?.dirty ?? 0;
  const conflictHelp = (files: string[], prompt?: string) => <div className="wt-callout" data-tone="conflict">
    <p><Icon name="alert" size={14} /> 원본({status?.originBranch || '현재 브랜치'})과 충돌하는 파일이 있어 원본에는 아무것도 하지 않았습니다.</p>
    <Files items={files} />
    <p className="wt-hint">에이전트가 원본 브랜치를 이 worktree에 merge해 충돌을 풀고 커밋하면, 다음 합치기는 fast-forward로 끝납니다.</p>
    <button type="button" className="wt-primary" onClick={() => onPrefill(prompt ?? `원본 브랜치 \`${status?.originBranch}\`를 이 worktree에 merge해서(rebase·squash 금지) 충돌을 해결하고 커밋해 줘.\n${files.map(file => `- ${file}`).join('\n')}`)}><SettingGlyph icon="smart_toy" size={15} />에이전트에게 충돌 해결 맡기기</button>
  </div>;

  const merge = async () => {
    const value = await act('chat/worktree/merge', dirty ? { message } : {}) as MergeResult | null;
    if (value) setResult(value);
  };
  const release = async () => {
    const value = await act('chat/worktree/remove', { deleteBranch: discard ? true : deleteBranch, discard, ...(discard && { confirm }), ...(!discard && dirty && message.trim() && { message }) });
    if (value) onClose();
  };

  const head = <header><h2 id="wt-title"><SettingGlyph icon="account_tree" size={17} /> worktree <span className="wt-branch">{info.branch || '(detached)'}</span></h2><button type="button" className="models-close" aria-label="닫기" onClick={onClose}><Icon name="x" size={16} /></button></header>;
  const facts = <dl className="wt-facts">
    <dt>위치</dt><dd>{info.inside ? <b className="wt-here">이 채팅은 worktree에서 작업 중</b> : <span>이 채팅은 원본에서 작업 중 (worktree는 남아 있음)</span>}{info.kind === 'claude' && <span className="wt-tag">에이전트가 만든 worktree</span>}</dd>
    <dt>경로</dt><dd className="wt-path"><code title={info.path}>{info.path}</code><button type="button" className="wt-icon" aria-label="경로 복사" title="경로 복사" onClick={() => copyText(info.path)}><Icon name="copy" size={13} /></button></dd>
    <dt>원본</dt><dd className="wt-path"><code title={info.origin}>{info.origin}</code>{status?.originBranch && <span className="wt-tag">{status.originBranch}</span>}</dd>
    <dt>상태</dt><dd>{status?.exists === false ? '폴더가 없습니다' : badge.title.split('\n').at(-1)}</dd>
  </dl>;

  if (view === 'merge') return <Modal className="models-modal wt-modal" labelledBy="wt-title" region="worktree 합치기" onClose={onClose}>
    {head}
    <div className="wt-body">
      {!result && <>
        <p className="wt-lead"><b>{info.branch}</b>을(를) 원본 <b>{preview?.status.originBranch ?? status?.originBranch ?? '…'}</b>에 합칩니다. {preview ? preview.fastForward ? 'fast-forward로 합쳐집니다.' : '원본도 그사이 바뀌어 merge 커밋을 만듭니다.' : ''} squash·rebase는 하지 않습니다.</p>
        {!preview && <p className="wt-hint" role="status">변경 내용을 읽는 중…</p>}
        {preview && <>
          {preview.commits.length > 0 && <section><h3>커밋 {preview.status.ahead}개</h3><ul className="wt-commits">{preview.commits.map(commit => <li key={commit.hash}><code>{commit.short}</code> {commit.subject}</li>)}</ul></section>}
          {preview.changes.length > 0 && <section><h3>바뀐 파일 {preview.changes.length}개</h3><ul className="wt-files">{preview.changes.slice(0, 30).map(change => <li key={change.path}><code>{change.path}</code> <span className="wt-add">+{change.added}</span> <span className="wt-del">−{change.deleted}</span></li>)}</ul></section>}
          {dirty > 0 && <section><h3>커밋하지 않은 변경 {dirty}개 — 먼저 이 메시지로 커밋합니다</h3><Files items={(preview.status.files ?? []).map(file => `${file.status} ${file.path}`)} /><textarea className="wt-message" rows={4} value={message} onChange={event => setMessage(event.target.value)} aria-label="커밋 메시지" /></section>}
          {!preview.commits.length && !dirty && <p className="wt-callout">원본에 합칠 새 커밋이 없습니다{preview.status.merged ? ' (이미 모두 합쳐짐)' : ''}.</p>}
          {preview.conflicts.length > 0 && conflictHelp(preview.conflicts)}
          {(preview.status.originDirty ?? 0) > 0 && <div className="wt-callout" data-tone="warn"><p><Icon name="alert" size={14} /> 원본 작업 트리에 커밋하지 않은 변경 {preview.status.originDirty}개가 있어 합칠 수 없습니다. 원본에서 커밋하거나 stash한 뒤 다시 시도하세요.</p><Files items={preview.status.originFiles ?? []} /></div>}
          {preview.status.conflicted && preview.status.conflicted.length > 0 && <div className="wt-callout" data-tone="conflict"><p>worktree에서 merge 충돌을 해결하는 중입니다. 해결해 커밋한 뒤 합치세요.</p><Files items={preview.status.conflicted} /></div>}
        </>}
      </>}
      {result?.merged && <div className="wt-callout" data-tone="ok"><p><Icon name="check" size={14} /> 원본 <b>{result.into}</b>에 합쳤습니다 ({result.fastForward ? 'fast-forward' : 'merge 커밋'}{result.commits ? `, 커밋 ${result.commits}개` : ''}).</p>
        <p className="wt-hint">이제 worktree를 해제하고 채팅을 원본으로 돌려놓을 수 있습니다. 계속 이 worktree에서 일해도 됩니다.</p></div>}
      {result && !result.merged && result.reason === 'nothing' && <p className="wt-callout">합칠 새 커밋이 없습니다.</p>}
      {result?.blocked && (result.blocked.code === 'MERGE_CONFLICT' ? conflictHelp(result.blocked.files, result.blocked.prompt) : <div className="wt-callout" data-tone="warn"><p><Icon name="alert" size={14} /> {result.blocked.message}</p><Files items={result.blocked.files} /></div>)}
    </div>
    <footer className="wt-actions">
      {result?.merged ? <>
        <label className="wt-check"><input type="checkbox" checked={deleteBranch} onChange={event => setDeleteBranch(event.target.checked)} /> 브랜치도 삭제</label>
        <span className="drag-space" />
        <button type="button" onClick={onClose}>계속 worktree에서 작업</button>
        <button type="button" className="wt-primary" disabled={busy} title={busy ? '응답이 끝난 뒤 해제할 수 있습니다' : undefined} onClick={() => void release()}><SettingGlyph icon="logout" size={15} />worktree 해제</button>
      </> : <>
        <span className="drag-space" />
        <button type="button" onClick={() => onView('panel')}>뒤로</button>
        {result?.blocked && <button type="button" onClick={() => { setResult(null); setPreview(null); onView('merge'); }}>다시 확인</button>}
        <button type="button" className="wt-primary" disabled={busy || !preview || (!preview.commits.length && !dirty) || (dirty > 0 && !message.trim())} title={busy ? '응답이 끝난 뒤 합칠 수 있습니다' : undefined} onClick={() => void merge()}><Icon name="merge" size={15} />{dirty ? '커밋하고 합치기' : '합치기'}</button>
      </>}
    </footer>
  </Modal>;

  if (view === 'release') return <Modal className="models-modal wt-modal" labelledBy="wt-title" region="worktree 해제" onClose={onClose}>
    {head}
    <div className="wt-body">
      <p className="wt-lead">worktree 폴더를 지우고 채팅을 원본 폴더로 돌려놓습니다. 대화 기록은 그대로 남습니다.</p>
      {facts}
      <label className="wt-choice"><input type="radio" name="wt-release" checked={!discard} onChange={() => setDiscard(false)} /><span><b>합치지 않고 해제</b> — 브랜치 <code>{info.branch}</code>는 남겨 나중에 합치거나 볼 수 있습니다.</span></label>
      {!discard && dirty > 0 && <section><h3>커밋하지 않은 변경 {dirty}개를 브랜치에 커밋하고 해제합니다</h3><textarea className="wt-message" rows={3} value={message} onChange={event => setMessage(event.target.value)} aria-label="커밋 메시지" /></section>}
      {!discard && <label className="wt-check"><input type="checkbox" checked={deleteBranch} onChange={event => setDeleteBranch(event.target.checked)} /> 원본에 이미 합쳐졌다면 브랜치도 삭제 (합쳐지지 않은 브랜치는 남깁니다)</label>}
      <label className="wt-choice" data-tone="danger"><input type="radio" name="wt-release" checked={discard} onChange={() => setDiscard(true)} /><span><b>버리기</b> — 커밋하지 않은 변경과 합치지 않은 커밋을 모두 지우고 브랜치도 삭제합니다. 되돌릴 수 없습니다.</span></label>
      {discard && <label className="wt-confirm">확인을 위해 브랜치 이름 <code>{info.branch}</code>을(를) 입력하세요<input value={confirm} onChange={event => setConfirm(event.target.value)} aria-label="브랜치 이름 확인" spellCheck={false} /></label>}
    </div>
    <footer className="wt-actions"><span className="drag-space" /><button type="button" onClick={() => onView('panel')}>뒤로</button>
      <button type="button" className={discard ? 'wt-danger' : 'wt-primary'} disabled={busy || (discard ? confirm !== info.branch : dirty > 0 && !message.trim())} title={busy ? '응답이 끝난 뒤 해제할 수 있습니다' : undefined} onClick={() => void release()}>{discard ? <><Icon name="trash" size={15} />버리고 해제</> : <><SettingGlyph icon="logout" size={15} />해제</>}</button></footer>
  </Modal>;

  // The panel: where the chat is, and what can be done from here.
  const conflicted = status?.conflicted ?? [];
  return <Modal className="models-modal wt-modal" labelledBy="wt-title" region="worktree" onClose={onClose}>
    {head}
    <div className="wt-body">
      {facts}
      {(conflicted.length > 0 || status?.midMerge) && <div className="wt-callout" data-tone="conflict"><p>worktree에서 merge가 진행 중입니다{conflicted.length ? ` (충돌 ${conflicted.length}개)` : ''}.</p><Files items={conflicted} />
        <button type="button" className="wt-primary" onClick={() => onPrefill(`이 worktree에서 진행 중인 merge의 충돌을 해결하고 커밋해 줘(rebase·squash 금지).${conflicted.length ? `\n${conflicted.map(file => `- ${file}`).join('\n')}` : ''}`)}><SettingGlyph icon="smart_toy" size={15} />에이전트에게 충돌 해결 맡기기</button></div>}
      {!info.managed && info.inside && <p className="wt-hint">에이전트가 스스로 만든 worktree입니다. 나가기와 정리는 에이전트에게 맡기세요(Claude: ExitWorktree). 원본으로 합치기는 여기서 할 수 있습니다.</p>}
      {busy && <p className="wt-hint" role="status">응답이 끝나면 worktree를 옮기거나 합칠 수 있습니다.</p>}
    </div>
    <footer className="wt-actions">
      {info.managed && (info.inside
        ? <button type="button" disabled={busy} onClick={() => void act('chat/worktree/leave').then(value => { if (value) onClose(); })}><SettingGlyph icon="logout" size={15} />worktree에서 나가기</button>
        : <button type="button" disabled={busy || status?.exists === false} onClick={() => { onEnter(); onClose(); }}><SettingGlyph icon="login" size={15} />다시 들어가기</button>)}
      {!info.managed && info.inside && <button type="button" onClick={() => onPrefill('ExitWorktree 도구로 지금 worktree에서 나와 줘(action: keep, 변경과 브랜치는 남기기).')}><SettingGlyph icon="smart_toy" size={15} />에이전트에게 나오라고 요청</button>}
      {info.managed && <button type="button" disabled={busy} onClick={() => onView('release')}><SettingGlyph icon="link_off" size={15} />해제…</button>}
      <span className="drag-space" />
      <button type="button" className="wt-primary" disabled={busy || status?.exists === false} onClick={() => onView('merge')}><Icon name="merge" size={15} />원본으로 합치기…</button>
    </footer>
  </Modal>;
}

type ListItem = { path: string; branch: string; origin: string; kind: string; chatId: string; title: string; open: boolean; inside: boolean; orphan: boolean; status?: WorktreeInfo['status'] };
// Every chat worktree of the project: which chat holds it (or none: left over after its chat was forgotten), how far it is ahead, and a way to clean up.
export function WorktreeManager({ call, onClose, onOpenChat, fail }: { call: Call; onClose(): void; onOpenChat?(chatId: string): void; fail(cause: unknown): void }) {
  const [items, setItems] = useState<ListItem[] | null>(null), [confirming, setConfirming] = useState<{ item: ListItem; text: string } | null>(null), [working, setWorking] = useState(false);
  const load = useCallback(() => { setItems(null); void call<{ items: ListItem[] }>('chat/worktree/list').then(value => setItems(value.items), cause => { fail(cause); setItems([]); }); }, [call, fail]);
  useEffect(load, [load]);
  const clean = async (item: ListItem, discard: boolean, confirm = '') => {
    setWorking(true);
    try { await call('chat/worktree/cleanup', { path: item.path, deleteBranch: true, discard, ...(discard && { confirm }) }); setConfirming(null); load(); }
    catch (cause) { fail(cause); } finally { setWorking(false); }
  };
  const describe = (item: ListItem): ReactNode => {
    const status = item.status;
    if (!status?.exists) return '폴더 없음';
    return [status.ahead ? `↑${status.ahead} 커밋` : status.merged ? '원본에 합쳐짐' : '변경 없음', status.dirty ? `●${status.dirty} 미커밋` : '', status.originBranch ? `원본 ${status.originBranch}` : ''].filter(Boolean).join(' · ');
  };
  return <Modal className="models-modal wt-modal wt-manager" labelledBy="wt-manager-title" region="채팅 worktree 관리" onClose={onClose}>
    <header><h2 id="wt-manager-title"><SettingGlyph icon="account_tree" size={17} /> 채팅 worktree</h2><button type="button" className="models-close" aria-label="닫기" onClick={onClose}><Icon name="x" size={16} /></button></header>
    <div className="wt-body">
      <p className="wt-hint">채팅이 쓰는 worktree와, 채팅을 잊어 남은 worktree입니다. 열린 채팅의 worktree는 그 채팅의 worktree 표시를 눌러 합치거나 해제하세요.</p>
      {items === null && <p className="wt-hint" role="status">불러오는 중…</p>}
      {items?.length === 0 && <p className="wt-callout">이 프로젝트에 채팅 worktree가 없습니다.</p>}
      <ul className="wt-list">{items?.map(item => <li key={item.path} data-orphan={item.orphan || undefined}>
        <div className="wt-row-head"><SettingGlyph icon="account_tree" size={14} /><b>{item.branch || '(detached)'}</b>
          <span className="wt-tag">{item.orphan ? '남은 worktree' : item.open ? '열린 채팅' : '닫힌 채팅'}</span>{item.kind === 'claude' && <span className="wt-tag">에이전트가 만듦</span>}</div>
        <div className="wt-row-sub">{item.title ? `“${item.title}” · ` : ''}{describe(item)}</div>
        <div className="wt-row-sub"><code title={item.path}>{item.path}</code></div>
        <div className="wt-row-actions">
          <button type="button" className="wt-icon" title="경로 복사" aria-label="경로 복사" onClick={() => copyText(item.path)}><Icon name="copy" size={13} /></button>
          {item.open && onOpenChat && <button type="button" onClick={() => { onOpenChat(item.chatId); onClose(); }}>채팅으로 가기</button>}
          {!item.open && !item.inside && <button type="button" disabled={working || Boolean(item.status?.dirty)} title={item.status?.dirty ? '커밋하지 않은 변경이 있어 버리기만 할 수 있습니다' : '폴더를 지우고, 원본에 합쳐진 브랜치면 브랜치도 지웁니다'} onClick={() => void clean(item, false)}>정리</button>}
          {!item.open && !item.inside && <button type="button" className="wt-danger" disabled={working} onClick={() => setConfirming({ item, text: '' })}>버리기…</button>}
          {!item.open && item.inside && <span className="wt-hint">채팅을 다시 열어 worktree에서 나온 뒤 정리하세요</span>}
        </div>
        {confirming?.item === item && <label className="wt-confirm">변경과 브랜치를 모두 지웁니다. 브랜치 이름 <code>{item.branch}</code>을(를) 입력하세요
          <span className="wt-confirm-row"><input value={confirming.text} onChange={event => setConfirming({ item, text: event.target.value })} aria-label="브랜치 이름 확인" spellCheck={false} /><button type="button" className="wt-danger" disabled={working || confirming.text !== item.branch} onClick={() => void clean(item, true, confirming.text)}>버리기</button></span></label>}
      </li>)}</ul>
    </div>
    <footer><span>{items ? `${items.length}개` : ''}</span><button type="button" className="wt-icon" onClick={load} aria-label="새로고침" title="새로고침"><Icon name="refresh" size={13} /></button></footer>
  </Modal>;
}
