import { useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { BgAnimTip } from './BgAnimTip';
import { limitLine, emptyState } from './chat-model';
import { ApprovalCard, AttachmentStrip, BlockedCard, SystemLine } from './ChatPane';
import { CacheTtlPicker, ChatStatusLine, type CacheTtl } from './ChatStatus';
import { CliUpdateBar } from './ClaudeUpdateNotice';
import { defaultSettings } from './Editor';
import { errorText } from './errors';
import { ErrorRow } from './error-ui';
import { ago } from './feedback-model';
import { FeedbackProgressBadge } from './FeedbackPanel';
import { ConflictsBody } from './GitDialogs';
import { GitLog } from './GitLog';
import { demoGit } from './git-demo';
import { IconButton, Icon, SplitButton } from './Icon';
import { IdeIcon } from './IdeIcon';
import { Markdown } from './Markdown';
import { MermaidBlock } from './mermaid-block';
import { lookHover, LookPreview, statusSamples, ThemePicker } from './Settings';
import { showAppKey } from './shortcuts';
import { ShellCard } from './ShellCard';
import { StatusMore } from './StatusFit';
import { UiSpecView } from './UiBlocks';
import { parseUi } from './ui-spec';
import { CreditRow, UsageRows } from './Usage';
import type { Ask } from './views';

// Live, real components instead of screenshots: each `demo` key in changelog.json names one entry below. They draw with the app's own markup and styles, and nothing in them works:
// the wrapper (ChangelogDemo) swallows every click, submit and Enter/Space, so only :hover (and the app's own tooltips) show. `wide` takes a whole row of the page; `frame` picks the
// ancestors the real styles expect (`chat`: the chat's variables and row, `status`: a status bar); `min` is the height held before the demo mounts.
type Demo = { render(): ReactNode; wide?: boolean; frame?: 'chat' | 'status'; min?: number };
const noop = () => {};
const TABLE = `| 구분 | 항목 | 상태 |
| --- | --- | --- |
| 채팅 | 입력창 | 완료 |
|  | 승인 카드 | 완료 |
|  | 표 | 완료 |
| 터미널 | 분할 | 완료 |
|  | 단축키 | 완료 |`;
const GRAPH = `flowchart LR
  A[입력] --> B{승인}
  B -->|허용| C[실행]
  B -->|거절| D[중단]
  C --> E[결과]`;
const FORM = parseUi('[["form","다음 단계","",["radio","dir","방향","둘 다 제거(권장)","메뉴로 이동"]]]') ?? [];
const ask: Ask = { input: async () => null, confirm: async () => false };
// Two pictures for the attachment demo: a wide screenshot-like one and a plain one.
const picture = (body: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="192" height="108" viewBox="0 0 192 108">${body}</svg>`)}`;
const SCREENSHOT = picture('<rect width="192" height="108" fill="#1f2430"/><rect width="192" height="14" fill="#2b3142"/><circle cx="8" cy="7" r="2.5" fill="#f26d6d"/><circle cx="16" cy="7" r="2.5" fill="#f2c46d"/><circle cx="24" cy="7" r="2.5" fill="#6df29a"/><rect x="12" y="26" width="104" height="6" rx="3" fill="#5ec8e5"/><rect x="12" y="40" width="148" height="6" rx="3" fill="#8b9099"/><rect x="12" y="54" width="128" height="6" rx="3" fill="#8b9099"/><rect x="12" y="68" width="96" height="6" rx="3" fill="#8b9099"/><rect x="12" y="82" width="132" height="6" rx="3" fill="#8b9099"/>');
const PHOTO = picture('<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#5ec8e5"/></linearGradient></defs><rect width="192" height="108" fill="url(#g)"/><circle cx="140" cy="34" r="14" fill="#ffffff55"/><path d="M0 108L58 52l38 36 30-24 66 44z" fill="#00000033"/>');
const IDES = [{ id: 'webstorm', kind: 'jetbrains', label: 'WebStorm' }, { id: 'idea', kind: 'jetbrains', label: 'IntelliJ IDEA' }, { id: 'pycharm', kind: 'jetbrains', label: 'PyCharm' }, { id: 'rider', kind: 'jetbrains', label: 'Rider' }];
const hour = 3600_000;

function Shell() {
  const [skipped, setSkipped] = useState(false);
  const item = { kind: 'shell' as const, key: 'demo', id: 'demo', command: 'git status -sb', cwd: '~/project', shell: 'zsh', status: 'done' as const, startedAt: 0, ms: 420, exitCode: 0, stdout: '## feat/tip-spotlight...origin/feat/tip-spotlight\n M apps/web/src/ShellCard.tsx\n M apps/web/src/chat-cards.css', stderr: '', skipped };
  return <ShellCard item={item} onStop={noop} onSkip={(_, on) => setSkipped(on)} note={{ pending: 1 }} />;
}

// The tutorial's sample history in the real Git graph (no server behind it: `demo`).
function GitGraph() {
  const demo = useMemo(() => ({ ...demoGit(), note: noop }), []);
  const [settings, setSettings] = useState(defaultSettings);
  return <div className="git-drawer changelog-git"><GitLog call={async <T,>() => ({}) as T} settings={settings} setSettings={setSettings} visible ask={ask} fail={noop} onClose={noop} onChanged={noop} openDiff={noop} repoKey="changelog" demo={demo} /></div>;
}

function FeedbackStatus() {
  const stamp = Date.now();
  const rows: [string, Parameters<typeof FeedbackProgressBadge>[0]['progress'], number][] = [
    ['채팅 입력창이 가끔 멈춰요', { state: 'pending', news: false }, 4 * 60_000],
    ['표 가운데 칸이 합쳐졌으면 좋겠어요', { state: 'beta', version: '0.6.0-beta2', inApp: true, news: true }, 3 * hour],
    ['Windows 터미널에서 Ctrl+A가 안 돼요', { state: 'released', version: '0.6.0', news: false }, 30 * hour]
  ];
  return <div className="changelog-feedback">{rows.map(([title, progress, age]) => <button key={title} type="button" className="feedback-row" data-status="submitted">
    <span className="feedback-thumb"><Icon name="person" size={18} /></span>
    <span className="feedback-row-main"><strong>{title}</strong><small><FeedbackProgressBadge progress={progress} stamp={stamp} />{progress?.inApp && <span className="feedback-inapp">이 버전에 포함</span>}<time>{ago(stamp - age, stamp)}</time></small></span>
    <Icon name="chevronRight" size={16} />
  </button>)}</div>;
}

const THEME_DEFAULT = defaultSettings.theme;
function Theme() {
  const [hover, setHover] = useState('');
  return <lookHover.Provider value={{ id: 'theme', set: (_id, theme) => setHover(theme ?? '') }}>
    <div className="changelog-theme setting-control"><ThemePicker value={THEME_DEFAULT} onChange={noop} /><LookPreview id="theme" settings={defaultSettings} previewTheme={hover} /></div>
  </lookHover.Provider>;
}

function StatusFold() {
  const nodes = statusSamples(defaultSettings), labels: Record<string, string> = { cpu: 'CPU 사용률', memory: '메모리 사용량', wakatime: 'WakaTime 오늘 기록', clock: '시계' };
  return <footer className="statusbar changelog-statusbar"><div className="status-left">{nodes.path}{nodes.branch}</div>
    <div className="status-right">{nodes.claudeusage}<StatusMore ids={['cpu', 'memory', 'wakatime', 'clock']} labels={labels} nodes={nodes} /></div></footer>;
}

function UsageDemo() {
  const now = Date.now(), windows = [{ key: 'session', label: '5시간', percent: 23, resetsAt: now + 2 * hour }, { key: 'weekly', label: '주간', percent: 41, resetsAt: now + 60 * hour }, { key: 'fable', label: 'Fable 주간', percent: 8, resetsAt: now + 60 * hour }];
  return <div className="changelog-usage"><div className="usage-detail"><UsageRows windows={windows} colors /><CreditRow credit={{ used: 12.5, limit: 50, percent: 25, currency: 'USD' }} colors /></div></div>;
}

function ShortcutKeys() {
  const rows = [['좌우 분할', showAppKey(undefined, 'splitRight')], ['상하 분할', showAppKey(undefined, 'splitDown')]];
  return <div className="changelog-split"><SplitButton keys={{ row: rows[0][1], column: rows[1][1] }} onSplit={noop} />
    <div className="tour-keys">{rows.map(([label, keys]) => <span key={label}><kbd>{keys}</kbd>{label}</span>)}</div></div>;
}

const ERRORS = [new Error("ENOENT: no such file or directory, realpath 'C:\\Users\\me\\project'"), new TypeError('Failed to fetch')];
const CONFLICTS = { op: 'merge' as const, conflicts: ['src/app.ts', 'src/pages/login.tsx'] };

const demos: Record<string, Demo> = {
  'git-graph': { render: () => <GitGraph />, wide: true, min: 360 },
  shell: { render: () => <Shell />, frame: 'chat', min: 150 },
  'feedback-status': { render: () => <FeedbackStatus />, min: 200 },
  'always-allow': { render: () => <ApprovalCard approval={{ requestId: 'demo', tool: 'Bash', input: { command: 'npm test', description: '테스트를 실행합니다' }, suggestions: [{}] }} modes={[]} settings={defaultSettings} claude onAnswer={noop} onInterrupt={noop} />, frame: 'chat', min: 170 },
  'auto-allow': { render: () => <BlockedCard items={[{ toolUseId: 'a', tool: 'Bash', input: { command: 'git push origin main' }, reason: '원격 저장소에 직접 푸시합니다', rule: 'Bash(git push:*)' }, { toolUseId: 'b', tool: 'Bash', input: { command: 'rm -rf dist' }, reason: '폴더를 통째로 지웁니다', rule: 'Bash(rm:*)' }]} onAllow={async () => {}} />, frame: 'chat', min: 230 },
  'cli-update': { render: () => <CliUpdateBar name="Claude Code" latest="2.1.150" onUpdate={noop} onSnooze={noop} />, min: 34 },
  'cache-ttl': { render: () => <div className="usage-panel changelog-popover"><CacheTtlPicker value={'1h' satisfies CacheTtl} onChange={noop} /></div>, min: 130 },
  'image-shrink': { render: () => <AttachmentStrip images={[{ url: SCREENSHOT, reduced: true }, { url: PHOTO }]} onOpen={noop} onRemove={noop} />, min: 90 },
  diagram: { render: () => <MermaidBlock code={GRAPH} />, frame: 'chat', min: 120 },
  'file-open': { render: () => <Markdown text={'수정한 파일은 경로를 눌러 바로 열어요.\n\n[[file:apps/web/src/ChatPane.tsx:1240]] · [[file:docs/TESTING_GUIDE.md]] · [[file:scripts/verify/]]'} />, frame: 'chat', min: 80 },
  'table-merge': { render: () => <Markdown text={TABLE} />, frame: 'chat', min: 190 },
  'quick-send': { render: () => <UiSpecView chatId="changelog-demo" specs={FORM} />, frame: 'chat', min: 130 },
  'changelog-dot': { render: () => <div className="changelog-dot"><IconButton icon="sparkles" label="변경 내역 (읽지 않은 버전 있음)" dot /><IconButton icon="sparkles" label="변경 내역" /></div>, min: 40 },
  'status-fold': { render: () => <StatusFold />, frame: 'status', min: 36 },
  usage: { render: () => <UsageDemo />, min: 220 },
  'usage-limit': { render: () => { const line = limitLine({ limit: 'five_hour', utilization: 0.96, resetsAt: Date.now() / 1000 + 5400, at: Date.now() }); return <SystemLine text={line.text} tones={line.tones} />; }, frame: 'chat', min: 40 },
  theme: { render: () => <Theme />, wide: true, min: 300 },
  'bg-anim': { render: () => <BgAnimTip onOpenSettings={noop} onDone={noop} />, min: 130 },
  'shortcut-tip': { render: () => <div className="changelog-dot"><IconButton icon="graph" label="Git 커밋 그래프" action="gitLog" /><IconButton icon="settings" label="설정" action="settings" /><IconButton icon="search" label="명령 팔레트" action="palette" /></div>, min: 40 },
  'tour-ide': { render: () => <div className="changelog-tour"><IconButton icon="book" label="둘러보기 다시 보기" /><div className="menu changelog-ide">{IDES.map(ide => <button key={ide.id} type="button"><IdeIcon ide={ide} size={16} /><span>{ide.label}</span></button>)}</div></div>, min: 170 },
  'split-shortcut': { render: () => <ShortcutKeys />, min: 90 },
  'api-cost': { render: () => <ChatStatusLine settings={defaultSettings} context={{ state: { ...emptyState(), agent: 'claude', apiKey: true, apiCostUsd: 12.34 }, share: null }} only={['share']} />, frame: 'status', min: 36 },
  'approval-lost': { render: () => <SystemLine text="Bash 실행 승인을 기다리던 중 앱이 종료되어 요청이 사라졌습니다. 에이전트에게 다시 요청해 주세요." />, frame: 'chat', min: 40 },
  'error-sentence': { render: () => <div className="changelog-errors">{ERRORS.map((error, index) => <ErrorRow key={index} message={errorText(error)} at={Date.now() - index * 90_000} onDismiss={noop} />)}</div>, min: 130 },
  'merge-conflict': { render: () => <div className="git-dialog wide changelog-conflict"><ConflictsBody state={CONFLICTS} titleId="changelog-conflict" onResolve={async () => {}} onContinue={noop} onAbort={noop} onClose={noop} /></div>, wide: true, min: 260 }
};
export const demoWide = (name: string) => Boolean(demos[name]?.wide);

const stop = (event: SyntheticEvent) => { event.preventDefault(); event.stopPropagation(); };
export function ChangelogDemo({ name }: { name: string }) {
  const demo = demos[name], box = useRef<HTMLDivElement>(null), [shown, setShown] = useState(false);
  // Mounted when it comes near the screen (Monaco, Mermaid and the Git graph are not cheap): a long page does not build all of them at once.
  useEffect(() => {
    const node = box.current;
    if (!node || shown) return;
    const watch = new IntersectionObserver(items => { if (items.some(item => item.isIntersecting)) { setShown(true); watch.disconnect(); } }, { rootMargin: '320px' });
    watch.observe(node);
    return () => watch.disconnect();
  }, [shown]);
  if (!demo) return null;
  // Capture phase: nothing below sees the click, the submit or the key (a button, a form, a `popovertarget`, a checkbox), yet :hover and the tooltips still work. Tab stays free.
  return <div ref={box} className={`changelog-demo${demo.frame === 'chat' ? ' chat-row' : ''}`} data-frame={demo.frame} style={{ minHeight: shown ? undefined : demo.min }}
    onClickCapture={stop} onSubmitCapture={stop} onMouseDownCapture={event => event.preventDefault()} onKeyDownCapture={event => { if (event.key === 'Enter' || event.key === ' ') stop(event); }}>
    {shown && demo.render()}
  </div>;
}
