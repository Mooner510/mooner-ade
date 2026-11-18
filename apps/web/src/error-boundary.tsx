import { Component, type ErrorInfo, type ReactNode } from 'react';

// The boundary's own screen is plain markup. A component used here (an icon, a button helper) could throw again and leave the window empty.
function reportRenderError(error: unknown, info: ErrorInfo) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const stack = error instanceof Error ? error.stack ?? '' : '';
  const body = JSON.stringify({
    message: message.slice(0, 500),
    stack: stack.slice(0, 4000),
    componentStack: (info.componentStack ?? '').slice(0, 2000)
  });
  try {
    void fetch('/api/client/error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, credentials: 'same-origin' }).catch(() => {});
  } catch { /* the screen still has to come up when the page is already failing */ }
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { message: string }> {
  state = { message: '' };

  static getDerivedStateFromError(error: unknown) {
    const message = (error instanceof Error ? error.message : String(error ?? '')).trim();
    return { message: message || '알 수 없는 오류' };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error);
    reportRenderError(error, info);
  }

  render() {
    if (!this.state.message) return this.props.children;
    return <div className="shell"><div role="alert" className="boot-error">
      <b>화면을 표시하지 못했습니다</b>
      <p>{this.state.message}</p>
      <button type="button" className="primary" onClick={() => location.reload()}>다시 불러오기</button>
    </div></div>;
  }
}
