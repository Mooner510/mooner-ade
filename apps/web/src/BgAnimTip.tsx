// The one-time card about animations pausing while another app is in front (main.tsx puts it on screen; the patch notes draw the same card for show).
export function BgAnimTip({ onOpenSettings, onDone, closing }: { onOpenSettings(): void; onDone(): void; closing?: boolean }) {
  return <aside className="chat-mode-tip bg-anim-tip notice-card" role="status" aria-label="백그라운드 애니메이션" data-closing={closing || undefined}>
    <div className="bg-tip-art" aria-hidden="true">
      <i /><i /><span className="chat-spin" /><b><u /><u /></b>
    </div>
    <div className="chat-mode-tip-body">
      <strong>다른 앱을 보는 동안 애니메이션이 멈춥니다</strong>
      <p>설정 › 외관의 ‘백그라운드에서도 애니메이션 유지’를 켜면 다른 앱을 보는 동안에도 로딩 표시가 계속 움직입니다. 켜 두면 CPU·GPU를 더 씁니다.</p>
      <div className="chat-mode-tip-actions">
        <button type="button" className="primary" onClick={onOpenSettings}>설정 열기</button>
        <button type="button" onClick={onDone}>확인</button>
      </div>
    </div>
  </aside>;
}
