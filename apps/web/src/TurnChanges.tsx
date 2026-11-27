// Turn snapshots in the chat (CHAT_MODE_FEATURES §15): the "이 턴 동안 바뀐 파일" card under a turn's answer, the line a file Rewind leaves (with its undo),
// and the dialog Rewind and that undo open. The data side is turn-changes.ts; the server side apps/local-server/src/chat-snapshots.js.
import { createContext, useContext, useEffect, useState } from 'react';
import type { AssistantItem, Item } from './chat-model';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';
import { Modal } from './views';
import { fileRewindLine, statusLabel, turnDiffSpec, type FileRewindItem, type TurnChanges, type TurnFile } from './turn-changes';
import './turn-changes.css';

export type TurnFilesCtx = { chatId: string; projectId: string; busy: boolean; call<T = any>(action: string, input?: object): Promise<T>; fail(cause: unknown): void };
export const TurnFilesContext = createContext<TurnFilesCtx | null>(null);
// The workspace opens the editor's diff tab (Workspace.tsx listens): the chat does not hold the editor.
export const OPEN_DIFF_EVENT = 'ade:open-diff';
export const openDiffTab = (projectId: string, spec: string) => window.dispatchEvent(new CustomEvent(OPEN_DIFF_EVENT, { detail: { projectId, spec } }));

const basename = (file: string) => file.slice(file.lastIndexOf('/') + 1);
const dirname = (file: string) => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';

/** The turn's record, on its last answer that has one. */
export const turnChangesIn = (items: Item[]): TurnChanges | undefined => {
  for (let at = items.length - 1; at >= 0; at--) { const item = items[at]; if (item.kind === 'assistant' && item.changes) return item.changes; }
  return undefined;
};

function FileRow({ file, onOpen }: { file: TurnFile; onOpen?(): void }) {
  const dir = dirname(file.path), counts = file.binary ? <small className="tc-bin">바이너리</small> : <span className="tc-counts">{file.add ? <ins>+{file.add}</ins> : null}{file.del ? <del>−{file.del}</del> : null}</span>;
  const body = <>
    <b className={`tc-status s-${file.status}`} aria-label={statusLabel[file.status]}>{file.status}</b>
    <FileIcon name={basename(file.path)} size={14} />
    <span className="tc-name"><span>{basename(file.path)}</span>{dir && <small>{dir}</small>}{file.original && <small className="tc-from">← {file.original}</small>}</span>
    {counts}
  </>;
  return onOpen ? <button type="button" className="tc-file" title={`${statusLabel[file.status]}: ${file.path}\n이 턴의 diff 열기`} onClick={onOpen}>{body}</button>
    : <div className="tc-file" title={`${statusLabel[file.status]}: ${file.path}`}>{body}</div>;
}

// Small turns open with their files listed; a long list starts folded to its header.
export function TurnChangesCard({ changes }: { changes: TurnChanges }) {
  const ctx = useContext(TurnFilesContext);
  const [open, setOpen] = useState(changes.count <= 4);
  if (!changes.count || !ctx) return null;
  const more = changes.count - changes.files.length, diff = Boolean(changes.from && changes.to);
  return <div className="tc-card" data-open={open || undefined}>
    <button type="button" className="tc-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Icon name="diff" size={14} />
      <strong>이 턴 동안 바뀐 파일 {changes.count}개</strong>
      <span className="tc-counts">{changes.add ? <ins>+{changes.add}</ins> : null}{changes.del ? <del>−{changes.del}</del> : null}</span>
      <span className="tc-hint">에이전트 외의 변경도 섞일 수 있어요</span>
      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
    </button>
    {open && <div className="tc-files">
      {changes.files.map(file => <FileRow key={`${file.original ?? ''}>${file.path}`} file={file} onOpen={diff ? () => openDiffTab(ctx.projectId, turnDiffSpec(ctx.chatId, changes, file)) : undefined} />)}
      {more > 0 && <p className="tc-more">외 {more}개 파일</p>}
    </div>}
  </div>;
}

// The thread's line for a file restore; the latest one that was not undone offers to undo it.
export function FileRewindRow({ item, enter }: { item: FileRewindItem; enter?: true }) {
  const ctx = useContext(TurnFilesContext), [asking, setAsking] = useState(false);
  const failed = item.failedCount > 0, canUndo = item.undo === undefined && !item.undone && Boolean(ctx);
  return <div className={`chat-divider note tc-line${failed ? ' error' : ''}`} role="note" data-enter={enter}>
    <span>
      <Icon name={item.undo !== undefined ? 'refresh' : 'undo'} size={13} />{fileRewindLine(item)}
      {canUndo && <button type="button" className="tc-undo" disabled={ctx!.busy} title={ctx!.busy ? '응답이 끝난 뒤 취소할 수 있습니다.' : '되돌리기 직전의 파일 상태로 돌아갑니다.'} onClick={() => setAsking(true)}>파일 되돌리기 취소</button>}
      {item.undone && <small className="tc-undone"> (취소됨)</small>}
      {failed && <details className="tc-failed"><summary>되돌리지 못한 파일 {item.failedCount}개</summary><ul>{item.failed.map(entry => <li key={entry.path}><code>{entry.path}</code> {entry.message}</li>)}</ul></details>}
    </span>
    {asking && ctx && <FilePlanDialog mode={{ kind: 'undo', seq: item.seq }} ctx={ctx} onClose={() => setAsking(false)} />}
  </div>;
}

type Plan = { available: boolean; reason?: string; restore?: string[]; restoreMore?: number; remove?: string[]; removeMore?: number; skipped?: string[] };
type Mode = { kind: 'rewind'; uuid: string; changes?: TurnChanges } | { kind: 'undo'; seq: number };

function PlanList({ title, files, more, tone }: { title: string; files: string[]; more: number; tone: 'restore' | 'remove' }) {
  if (!files.length) return null;
  return <section className={`tc-plan-list ${tone}`}>
    <h3>{title} <small>{files.length + more}개</small></h3>
    <ul>{files.map(file => <li key={file}><FileIcon name={basename(file)} size={13} /><span>{file}</span></li>)}{more > 0 && <li className="tc-more">외 {more}개</li>}</ul>
  </section>;
}

// Rewind's confirmation (conversation, and the files when that point has a snapshot) and the undo of a file restore. Both show the files that would change first.
export function FilePlanDialog({ mode, ctx, onClose }: { mode: Mode; ctx: TurnFilesCtx; onClose(): void }) {
  const rewind = mode.kind === 'rewind';
  const snapshot = rewind ? Boolean(mode.changes?.to && (!mode.changes.chat || mode.changes.chat === ctx.chatId)) : true;
  const [files, setFiles] = useState(!rewind), [plan, setPlan] = useState<Plan | null>(null), [running, setRunning] = useState(false);
  useEffect(() => {
    if (!files || !snapshot) return;
    let live = true; setPlan(null);
    const asked = mode.kind === 'rewind' ? ctx.call<Plan>('chat/rewind-preview', { id: ctx.chatId, uuid: mode.uuid }) : ctx.call<Plan>('chat/rewind-undo', { id: ctx.chatId, seq: mode.seq, preview: true });
    asked.then(value => { if (live) setPlan(value); }, cause => { if (live) setPlan({ available: false, reason: String((cause as Error)?.message ?? cause) }); });
    return () => { live = false; };
  }, [files, snapshot]);
  const nothing = plan?.available && !plan.restore?.length && !plan.remove?.length;
  const blocked = files && (!plan || !plan.available);
  async function run() {
    setRunning(true);
    try {
      if (mode.kind === 'rewind') await ctx.call('chat/rewind', { id: ctx.chatId, uuid: mode.uuid, ...(files && { files: true }) });
      else await ctx.call('chat/rewind-undo', { id: ctx.chatId, seq: mode.seq });
      onClose();
    } catch (cause) { ctx.fail(cause); setRunning(false); }
  }
  const title = rewind ? '여기로 되돌릴까요?' : '파일 되돌리기를 취소할까요?';
  return <Modal className="models-modal tc-dialog" labelledBy="tc-dialog-title" onClose={() => { if (!running) onClose(); }}>
    <header><h2 id="tc-dialog-title">{title}</h2><button type="button" className="models-close" aria-label="닫기" disabled={running} onClick={onClose}><Icon name="x" size={16} /></button></header>
    <div className="tc-dialog-body">
      {rewind && <p>이 메시지 아래 대화가 사라지고, 다음 메시지는 이 지점부터 이어집니다.</p>}
      {rewind && (snapshot
        ? <label className="tc-check"><input type="checkbox" checked={files} disabled={running} onChange={event => setFiles(event.target.checked)} /><span><b>파일도 이 시점으로 되돌리기</b><small>이 턴이 끝났을 때의 파일로 되돌리고, 그 뒤에 생긴 파일은 지웁니다.</small></span></label>
        : <p className="tc-muted">이 지점에는 파일 기록이 없어 대화만 되돌립니다. 에이전트가 이미 바꾼 파일은 그대로입니다.</p>)}
      {!rewind && <p>파일을 되돌리기 직전 상태로 다시 바꿉니다. 대화는 그대로입니다.</p>}
      {files && snapshot && <div className="tc-plan" aria-live="polite">
        {!plan ? <p className="tc-muted"><span className="chat-spin" /> 지금 파일과 비교하는 중…</p>
          : !plan.available ? <p className="tc-error"><Icon name="alert" size={13} /> {plan.reason || '파일을 되돌릴 수 없습니다.'}</p>
          : nothing ? <p className="tc-muted">파일은 이미 그 시점과 같습니다.</p>
          : <>
            <PlanList title="되돌릴 파일" files={plan.restore ?? []} more={plan.restoreMore ?? 0} tone="restore" />
            <PlanList title="지울 파일 (그 뒤에 생긴 파일)" files={plan.remove ?? []} more={plan.removeMore ?? 0} tone="remove" />
          </>}
        {plan?.available && plan.skipped?.length ? <p className="tc-muted">너무 커서 기록하지 않은 파일 {plan.skipped.length}개는 건드리지 않습니다.</p> : null}
        <p className="tc-note">실행 직전의 파일 상태를 따로 저장해 두므로, 대화에 남는 "파일 되돌리기 취소"로 다시 돌아올 수 있습니다. .gitignore로 무시된 파일과 커밋·브랜치·스테이징은 바뀌지 않습니다.</p>
      </div>}
    </div>
    <footer className="tc-dialog-foot">
      <button type="button" disabled={running} onClick={onClose}>취소</button>
      <button type="button" className="primary" disabled={running || blocked} onClick={() => void run()}>{running ? '되돌리는 중…' : rewind ? (files ? '대화와 파일 되돌리기' : '대화 되돌리기') : '되돌리기 취소'}</button>
    </footer>
  </Modal>;
}

/** The answer a Rewind button names, for the dialog: its turn's record. */
export const rewindChanges = (items: Item[], uuid: string) => (items.find(item => item.kind === 'assistant' && item.uuid === uuid) as AssistantItem | undefined)?.changes;
