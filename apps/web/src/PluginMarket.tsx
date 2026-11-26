import { useEffect, type ReactNode } from 'react';
import { Icon, IconButton, type IconName } from './Icon';
import type { HubGrants, HubPlugin, HubState, PluginsBridge, PluginsState } from './PluginSettings';
import './plugin-market.css';

// The market: the plugins MoonerADE Hub serves to the signed-in account (docs/PLUGINS.md "Hub 마켓"). Picking one starts the same install
// dialog a zip does; the page only starts it. Looks like the plugin list (same classes), so it follows whatever the list looks like.
type Run = (key: string, step: () => Promise<PluginsState>) => void;
type Notice = { text: string; error: boolean; step?: string } | null;

const GRANT_LABEL: Record<keyof HubGrants, string> = { terminal: '터미널 명령', mcp: '에이전트 도구', workspace: '프로젝트/터미널 조작', feedback: '피드백 전송', header: '상단 바 버튼' };
const sizeText = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const toneIcon: Record<'error' | 'ok' | 'info', IconName> = { error: 'alert', ok: 'check', info: 'info' };

function Callout({ tone, children, action }: { tone: 'error' | 'ok' | 'info'; children: ReactNode; action?: ReactNode }) {
  return <div className="plugin-callout" data-tone={tone} role={tone === 'error' ? 'alert' : undefined}>
    <Icon name={toneIcon[tone]} size={15} /><div className="plugin-callout-text">{children}</div>{action && <div className="plugin-callout-action">{action}</div>}
  </div>;
}
function Button({ busy, running, className, onClick, icon, children, title }: { busy: boolean; running: boolean; className?: string; onClick(): void; icon?: IconName; children: ReactNode; title?: string }) {
  return <button type="button" className={`plugin-button ${className ?? ''}`} disabled={busy} aria-busy={running || undefined} title={title} onClick={onClick}>
    {running ? <span className="plugin-spinner" aria-hidden="true" /> : icon && <Icon name={icon} />}{children}
  </button>;
}

// What a plugin asks for beyond running as its own process (the install dialog lists all of it once more).
export const grantList = (grants: HubGrants) => (Object.keys(GRANT_LABEL) as (keyof HubGrants)[]).filter(key => grants[key]).map(key => GRANT_LABEL[key]);

function Entry({ plugin, busy, run, bridge }: { plugin: HubPlugin; busy: string; run: Run; bridge: PluginsBridge }) {
  const key = `market:${plugin.id}`, working = Boolean(busy), grants = grantList(plugin.grants);
  const install = () => run(key, () => bridge.hubInstall!(plugin.id, plugin.sha256 ? { version: plugin.version, apiVersion: plugin.apiVersion, sha256: plugin.sha256 } : undefined));
  let action: ReactNode;
  if (plugin.reserved) action = <span className="plugin-pill" data-tone="info" title="기본 플러그인 ID와 충돌"><i aria-hidden="true" />설치할 수 없음</span>;
  else if (plugin.apiStatus === 'unsupported' || plugin.apiStatus === 'removed') action = <span className="plugin-pill" data-tone="warn"><i aria-hidden="true" />{plugin.apiStatus === 'removed' ? '지원 종료' : 'API 미지원'}</span>;
  else if (plugin.installed && plugin.updateAvailable) action = <Button className="primary" busy={working} running={busy === key} icon="download" onClick={install}>업데이트 v{plugin.version}</Button>;
  else if (plugin.installed) action = <span className="plugin-pill" data-tone="ok"><i aria-hidden="true" />설치됨</span>;
  else action = <Button className="primary" busy={working} running={busy === key} icon="download" onClick={install}>설치</Button>;
  return <li className="plugin-market-row" data-installed={plugin.installed ? '' : undefined}>
    <span className="plugin-mark"><Icon name="plugin" size={18} /></span>
    <span className="plugin-row-text">
      <span className="plugin-row-name"><strong>{plugin.name}</strong><span className="plugin-version">v{plugin.version}</span>
        {plugin.apiVersion != null && <span className="plugin-tag">API v{plugin.apiVersion}</span>}
        {plugin.apiStatus === 'deprecated' && <span className="plugin-tag" data-tone="warn">지원 종료 예정</span>}
        {plugin.installed && plugin.updateAvailable && <span className="plugin-tag" data-tone="info">지금 v{plugin.installed.version}</span>}
        <span className="plugin-tag">{sizeText(plugin.size)}</span></span>
      {plugin.description && <span className="plugin-row-desc plugin-market-desc">{plugin.description}</span>}
      {grants.length > 0 && <span className="plugin-market-grants" aria-label="요청하는 권한">{grants.map(label => <span key={label} className="plugin-tag" data-tone="warn">{label}</span>)}</span>}
    </span>
    <span className="plugin-market-action">{action}</span>
  </li>;
}

export function PluginMarket({ hub, busy, run, bridge, notice }: { hub: HubState; busy: string; run: Run; bridge: PluginsBridge; notice: Notice }) {
  const working = Boolean(busy);
  // Shown only while signed in (the sign-in is on the 정보 page). The list is asked for when the market opens and again after signing in.
  useEffect(() => { void bridge.hubCatalog?.().catch(() => {}); }, [hub.signedIn]);

  // The result of the last button, except "sign-in started": the code box says that while it waits, and afterwards it is stale.
  const message = notice && !(notice.step === 'signin' && !notice.error) && <Callout tone={notice.error ? 'error' : 'ok'}>{notice.text}</Callout>;
  const catalog = hub.catalog, plugins = catalog?.plugins ?? [];
  return <div className="plugin-market">
    {message}
    {hub.error && !notice && <Callout tone="error">{hub.error}</Callout>}
    <div className="plugin-market-account">
      <span><Icon name="person" size={14} /><strong>{hub.account}</strong>{hub.host && <small>{hub.host}</small>}</span>
      <span className="plugin-market-account-actions">
        <IconButton icon="refresh" label="목록 새로고침" disabled={working || catalog?.status === 'loading'} onClick={() => run('market:refresh', () => bridge.hubCatalog!({ force: true }))} />
        <Button busy={working} running={busy === 'market:signout'} onClick={() => run('market:signout', () => bridge.signOutHub!())}>로그아웃</Button>
      </span>
    </div>
    {catalog?.status === 'error' && <Callout tone="error" action={<Button busy={working} running={busy === 'market:refresh'} onClick={() => run('market:refresh', () => bridge.hubCatalog!({ force: true }))}>다시 시도</Button>}>{catalog.error ?? '목록을 받지 못했습니다.'}</Callout>}
    {plugins.length > 0
      ? <ul className="plugin-list plugin-market-list">{plugins.map(plugin => <Entry key={plugin.id} plugin={plugin} busy={busy} run={run} bridge={bridge} />)}</ul>
      : catalog?.status !== 'error' && <div className="plugin-empty">
          {!catalog || catalog.status === 'loading' || catalog.status === 'idle' ? <><span className="plugin-spinner" aria-hidden="true" /><p>Hub의 플러그인 목록을 불러오는 중…</p></>
            : <><Icon name="plugin" size={24} /><p>Hub가 제공하는 플러그인이 아직 없습니다.</p></>}
        </div>}
    {plugins.length > 0 && <p className="setting-note plugin-market-note">설치를 누르면 설치 확인 창에 플러그인이 하는 일과 SHA-256이 나옵니다. 확인 창에서 <b>설치</b>를 누르기 전에는 아무것도 실행되지 않습니다.</p>}
  </div>;
}
