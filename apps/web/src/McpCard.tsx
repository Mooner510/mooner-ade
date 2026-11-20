import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';

// /mcp for a Claude chat, inline in the conversation: the CLI's own MCP controls (server: chat.js `mcp`). Nothing restarts.
type Tool = { name: string; description?: string };
type Server = { name: string; status: string; error?: string; config?: { type?: string }; tools?: Tool[] };
export type McpCall = (input: Record<string, unknown>) => Promise<any>;

const STATUS: Record<string, [label: string, tone: string]> = {
  connected: ['연결됨', 'ok'], pending: ['연결 중…', 'warn'], failed: ['연결 실패', 'err'], 'needs-auth': ['로그인 필요', 'warn'], disabled: ['꺼짐', 'off']
};

export function McpCard({ call }: { call: McpCall }) {
  const [servers, setServers] = useState<Server[] | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(''), [open, setOpen] = useState(''), [signing, setSigning] = useState(false);
  const refresh = useCallback(() => call({ action: 'status' }).then(result => setServers(result.servers), (reason: Error) => setError(reason.message)), [call]);
  useEffect(() => { void refresh(); }, [refresh]);
  // A server that is still connecting, or whose browser sign-in is open, settles on its own: look again until it has (a sign-in is given up on after 2 minutes).
  const waiting = signing || servers?.some(server => server.status === 'pending') === true;
  useEffect(() => { if (!waiting) return; const timer = setInterval(() => void refresh(), 1500); return () => clearInterval(timer); }, [waiting, refresh]);
  useEffect(() => { if (!signing) return; const timer = setTimeout(() => setSigning(false), 120000); return () => clearTimeout(timer); }, [signing]);
  useEffect(() => { if (signing && servers && !servers.some(server => server.status === 'needs-auth')) setSigning(false); }, [signing, servers]);

  const run = async (server: string, input: Record<string, unknown>, done?: (result: any) => void) => {
    setBusy(server); setError('');
    try { done?.((await call({ server, ...input })).result); } catch (reason) { setError(`${server}: ${(reason as Error).message}`); }
    setBusy(''); await refresh();
  };
  const signIn = (server: string) => run(server, { action: 'auth' }, result => { if (result?.authUrl) { window.open(result.authUrl, '_blank', 'noopener'); setSigning(true); } });
  const connected = servers?.filter(server => server.status === 'connected').length ?? 0;
  return <div className="chat-row mcp-card" role="region" aria-label="MCP 서버"><div className="mc">
    <header className="mc-head"><b>MCP 서버</b>{servers && <span>{connected}/{servers.length} 연결됨</span>}
      <button type="button" className="icon-btn" aria-label="새로고침" onClick={() => { setError(''); void refresh(); }}><Icon name="refresh" size={13} /></button></header>
    {error && <p className="mc-error" role="alert">{error}</p>}
    {!servers ? !error && <p className="mc-empty">상태를 읽는 중…</p> : !servers.length ? <p className="mc-empty">설정된 MCP 서버가 없습니다.</p> : <ul>{servers.map(server => {
      const [label, tone] = STATUS[server.status] ?? [server.status, 'off'], tools = server.tools ?? [], working = busy === server.name, expanded = open === server.name;
      const main = server.status === 'needs-auth' ? <button type="button" disabled={working} onClick={() => void signIn(server.name)}>로그인</button>
        : server.status === 'failed' ? <button type="button" disabled={working} onClick={() => void run(server.name, { action: 'reconnect' })}>다시 연결</button> : null;
      return <li key={server.name}>
        <div className="mc-row">
          <button type="button" className="mc-name" aria-expanded={tools.length ? expanded : undefined} onClick={() => tools.length && setOpen(expanded ? '' : server.name)}>
            <span className="mc-chev">{tools.length > 0 && <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />}</span><i className={tone} /><b>{server.name}</b>
            <span className="mc-sub">{working ? '처리 중…' : server.status === 'connected' ? `도구 ${tools.length}개` : server.status === 'failed' && server.error ? `${label} · ${server.error}` : label}</span>
          </button>
          {main}
          <button type="button" disabled={working} onClick={() => void run(server.name, { action: 'toggle', enabled: server.status === 'disabled' })}>{server.status === 'disabled' ? '켜기' : '끄기'}</button>
        </div>
        {expanded && <div className="mc-more">
          <p>{tools.map(tool => <code key={tool.name} title={tool.description}>{tool.name}</code>)}</p>
          <span><button type="button" disabled={working} onClick={() => void run(server.name, { action: 'reconnect' })}>다시 연결</button>
            {server.config?.type !== 'stdio' && <button type="button" disabled={working} onClick={() => void run(server.name, { action: 'clearAuth' })}>로그인 해제</button>}</span>
        </div>}
      </li>;
    })}</ul>}
  </div></div>;
}
