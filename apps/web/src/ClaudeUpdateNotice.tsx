import { Icon } from './Icon';
import { dismissUpdateRun, snoozed, snooze, updateClaude, useClaudeUpdate } from './claude-update';

// A slim bar under a Claude chat's title: a newer Claude Code CLI exists (or the update just ran). Running chats and terminals keep the
// version they started with; only sessions started afterwards use the new one, so updating never interrupts anything.
export function ClaudeUpdateNotice() {
  const { status, run } = useClaudeUpdate();
  if (run.phase === 'running') return <div className="chat-update" role="status"><Icon name="refresh" size={13} /><span className="chat-update-text">Claude Code를 업데이트하는 중…</span></div>;
  if (run.phase === 'done') return <div className="chat-update done" role="status"><Icon name="check" size={13} />
    <span className="chat-update-text" title={run.changed ? '실행 중인 채팅·터미널은 지금 쓰던 버전으로 계속 동작하고, 새로 시작하는 세션부터 새 버전을 씁니다.' : undefined}>{run.changed ? `Claude Code ${run.before} → ${run.after} 업데이트 완료` : `Claude Code ${run.after ?? ''} 이미 최신입니다`}</span>
    <button type="button" onClick={dismissUpdateRun}>닫기</button></div>;
  if (run.phase === 'failed') return <div className="chat-update failed" role="alert"><Icon name="alert" size={13} />
    <span className="chat-update-text">업데이트하지 못했습니다{run.message && <small>{run.message}</small>}</span>
    <button type="button" onClick={() => void updateClaude()}>다시 시도</button><button type="button" onClick={dismissUpdateRun}>닫기</button></div>;
  if (!status?.outdated || !status.latest || snoozed()) return null;
  return <div className="chat-update" role="status"><Icon name="download" size={13} />
    <span className="chat-update-text" title="실행 중인 채팅은 영향받지 않고 새 세션부터 적용됩니다">Claude Code 새 버전 {status.latest} <span className="chat-update-cur">현재 {status.current ?? '알 수 없음'}</span></span>
    <button type="button" className="primary" onClick={() => void updateClaude()}>업데이트</button>
    <button type="button" onClick={() => snooze()}>나중에</button></div>;
}
