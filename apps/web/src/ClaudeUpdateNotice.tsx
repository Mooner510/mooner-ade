import { Icon } from './Icon';
import { useCliUpdate, type CliAgent } from './claude-update';

const NAME: Record<CliAgent, string> = { claude: 'Claude Code', codex: 'Codex' };

// A slim bar under a Claude or Codex chat's title: a newer CLI exists (or the update just ran). Running chats and terminals keep the
// version they started with; only sessions started afterwards use the new one, so updating never interrupts anything.
export function CliUpdateNotice({ agent }: { agent: CliAgent }) {
  const { status, run, update, dismiss, snoozed, snooze } = useCliUpdate(agent);
  const name = NAME[agent];
  if (run.phase === 'running') return <div className="chat-update" role="status"><Icon name="refresh" size={13} /><span className="chat-update-text">{name}를 업데이트하는 중…</span></div>;
  if (run.phase === 'done') return <div className="chat-update done" role="status"><Icon name="check" size={13} />
    <span className="chat-update-text">{run.changed ? `${name} ${run.before} → ${run.after} 업데이트 완료` : `${name} ${run.after ?? ''} 이미 최신입니다`}</span>
    <button type="button" onClick={dismiss}>닫기</button></div>;
  if (run.phase === 'failed') return <div className="chat-update failed" role="alert"><Icon name="alert" size={13} />
    <span className="chat-update-text">업데이트하지 못했습니다{run.message && <small>{run.message}</small>}</span>
    <button type="button" onClick={() => void update()}>다시 시도</button><button type="button" onClick={dismiss}>닫기</button></div>;
  if (!status?.outdated || !status.latest || snoozed()) return null;
  return <div className="chat-update" role="status"><Icon name="download" size={13} />
    <span className="chat-update-text"><span className="chat-update-title">{name} 업데이트 가능 (v{status.latest})</span><span className="chat-update-cur">다음 대화부터 적용됩니다</span></span>
    <button type="button" className="primary" onClick={() => void update()}>업데이트</button>
    <button type="button" onClick={() => snooze()}>나중에</button></div>;
}
