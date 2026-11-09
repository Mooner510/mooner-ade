// First-run tutorial: a practice copy of the app (two projects, tabs, split panes, a scripted Claude) that the user drives with the real
// gestures and keys. Each step lists flags that must be earned before "다음" unlocks. Pure state, no DOM or React, so node tests can
// load it; Tutorial.tsx draws it with the app's own markup. Pane layouts use the real tree helpers from api.ts.
import { findLeaf, leafList, mapLeaf, remove, split, type Leaf, type Pane } from './api';

export type Agent = 'claude' | 'codex' | 'cursor';
export type TourTab = { id: string; label: string; pane: Pane | null }; // null: the "새 탭" launcher page
export type TourProject = { id: string; name: string; root: string; tabs: TourTab[]; active: string };
// The scripted agent (`Tour.claude`, whichever CLI was launched first: Claude Code, Codex or Cursor CLI).
// idle → working (after a request) → done; asking = waiting on a yes/no question. `asked` makes the question happen once.
export type Claude = { leaf: string; state: 'idle' | 'working' | 'done' | 'asking'; queue: string[]; asked: boolean; at: number };
export type Tour = {
  projects: TourProject[]; current: string; focus: string; zoom: string; seq: number;
  agents: Record<string, Agent>; labels: Record<string, string>; lines: Record<string, string[]>;
  claude: Claude | null; changes: number; diff: boolean; palette: boolean; settings: boolean; done: string[];
};
export type Action =
  | { type: 'project'; id: string } | { type: 'projectCycle'; step: number } | { type: 'projectJump'; index: number }
  | { type: 'tab'; id: string } | { type: 'cycle'; step: number } | { type: 'jump'; index: number } | { type: 'move'; id: string; to: number } | { type: 'merge'; id: string; into: string }
  | { type: 'closeTab'; id: string } | { type: 'closePane'; id: string }
  // launch target: a "새 탭" page's tab id, a launcher leaf id, or '' for a new tab (▾ menu, command palette)
  | { type: 'newTab' } | { type: 'launch'; target: string; agent: Agent | '' }
  | { type: 'split'; dir: 'row' | 'column' } | { type: 'pick'; id: string } | { type: 'focusBy'; step: number } | { type: 'zoom' } | { type: 'layout'; tab: string; pane: Pane }
  | { type: 'submit'; leaf: string; text: string } | { type: 'queue'; text: string } | { type: 'unqueue'; index: number } | { type: 'workDone' } | { type: 'ask' }
  | { type: 'diff' } | { type: 'palette'; open: boolean } | { type: 'command' } | { type: 'settings'; open: boolean };
export type Task = { flag: string; label: string; hint?: string; target?: string };
export type Step = { id: string; title: string; body: string; tasks: Task[]; target?: string; keys?: [string, string][] };

const c = { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', cyan: '\x1b[36m', orange: '\x1b[38;5;173m', yellow: '\x1b[33m', off: '\x1b[0m' };
export const shellPrompt = `${c.cyan}~/my-app${c.off} ${c.green}$${c.off} `;
export const agentPrompt = (agent: Agent) => `${agent === 'claude' ? c.orange : c.cyan}>${c.off} `;
const banner: Record<Agent, string[]> = {
  claude: [`${c.orange}✻${c.off} ${c.bold}Claude Code${c.off} ${c.dim}· ~/my-app${c.off}`, `${c.dim}  무엇을 도와드릴까요? 요청을 입력하고 Enter를 누르세요.${c.off}`, ''],
  codex: [`${c.cyan}>_${c.off} ${c.bold}Codex${c.off} ${c.dim}· ~/my-app${c.off}`, `${c.dim}  요청을 입력하세요.${c.off}`, ''],
  cursor: [`${c.bold}⬡ Cursor CLI${c.off} ${c.dim}· ~/my-app${c.off}`, `${c.dim}  요청을 입력하세요.${c.off}`, '']
};
export const agentLabels: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor CLI' };
// Only what the tutorial itself created may be closed; the starting tabs and the Claude terminal are needed by later steps.
export const closable = (tour: Tour, id: string) => /^[tl]\d+$/.test(id) && id !== tour.claude?.leaf && !leafList(tour.projects.flatMap(p => p.tabs).find(item => item.id === id)?.pane ?? null).some(leaf => leaf.id === tour.claude?.leaf);

const tab = (id: string, label: string, leaf?: Leaf): TourTab => ({ id, label, pane: leaf ?? null });
export const initialTour = (): Tour => ({
  projects: [
    { id: 'my-app', name: 'my-app', root: '~/projects/my-app', active: 'web', tabs: [tab('web', 'web', { id: 'l-web' }), tab('server', 'server', { id: 'l-server' }), tab('build', 'build', { id: 'l-build' })] },
    { id: 'api-server', name: 'api-server', root: '~/projects/api-server', active: 'api', tabs: [tab('api', 'api-server', { id: 'l-api' })] }
  ],
  current: 'my-app', focus: 'l-web', zoom: '', seq: 0, agents: {},
  labels: { 'l-web': 'web', 'l-server': 'server', 'l-build': 'build', 'l-api': 'api-server' },
  lines: {
    'l-web': [`${shellPrompt}npm run dev`, `${c.green}  VITE ready${c.off} in 312 ms`, `  ➜  Local:   ${c.cyan}http://localhost:5173/${c.off}`, ''],
    'l-server': [`${shellPrompt}npm run server`, '  listening on :3000', ''],
    'l-build': [`${shellPrompt}npm run build -- --watch`, `${c.dim}  watching for changes…${c.off}`, ''],
    'l-api': [`${c.cyan}~/projects/api-server${c.off} ${c.green}$${c.off} git status`, 'On branch main', 'nothing to commit, working tree clean', '']
  },
  claude: null, changes: 0, diff: false, palette: false, settings: false, done: []
});

// `keys` formats a binding for the platform (showKeys); passed in so this file stays free of DOM code.
// Copy introduces the app's features; `keys` on a step are shortcut chips (raw bindings, formatted by the coach), a task's `hint` says how.
export const steps = (keys: (binding: string) => string): Step[] => [
  { id: 'welcome', title: '무너에이드', body: '터미널과 AI 코딩 에이전트를 위한 작업 공간이에요. Claude Code, Codex, Cursor CLI를 프로젝트별로 나란히 띄우고, 누가 일을 끝냈는지, 무엇을 기다리는지 한눈에 보세요.', tasks: [] },
  { id: 'projects', title: '프로젝트를 한 화면에', target: '.tour .folders', keys: [['번호로 이동', 'mod+alt+1'], ['다음 · 이전', 'mod+alt+]']],
    body: '열어 둔 프로젝트가 왼쪽에 모여요. 다른 프로젝트로 옮겨 가도 터미널과 에이전트는 멈추지 않고 계속 일해요.',
    tasks: [{ flag: 'projectVisit', label: 'api-server 프로젝트 열어 보기', hint: '사이드바에서 클릭', target: '.tour [data-project="api-server"] .folder-head' }, { flag: 'projectBack', label: 'my-app 으로 돌아오기', hint: `클릭 또는 ${keys('mod+alt+1')}` }] },
  { id: 'tabs', title: '탭마다 하나의 작업', target: '.tour .folder.active .folder-tabs', keys: [['번호로 이동', 'alt+1'], ['다음 · 이전 탭', 'alt+]']],
    body: '프로젝트 아래 항목이 탭이에요. 개발 서버, 빌드, 에이전트를 탭으로 나눠 두고 오가며 일하세요.',
    tasks: [{ flag: 'tabServer', label: 'server 탭 열기', hint: '클릭', target: '.tour [data-tab="server"]' }, { flag: 'jump', label: '첫 번째 탭으로 가기', hint: `클릭 또는 ${keys('alt+1')}` }, { flag: 'cycle', label: '바로 옆 탭으로 가기', hint: `클릭 또는 ${keys('alt+]')} / ${keys('alt+[')}` }] },
  { id: 'newTab', title: 'AI 에이전트를 탭 하나로', target: '.tour .app:not([hidden]) .split-button', keys: [['새 탭', 'mod+shift+t']],
    body: '새 탭을 열면 터미널, Claude Code, Codex, Cursor CLI 중 무엇을 띄울지 골라요. ‘새 탭’ 옆 ▾ 메뉴로 바로 실행할 수도 있어요.',
    tasks: [{ flag: 'newTab', label: '새 탭 열기', hint: `‘새 탭’ 버튼 또는 ${keys('mod+shift+t')}` }, { flag: 'claude', label: 'AI 에이전트 실행하기', hint: 'Claude Code, Codex, Cursor CLI 중 아무거나', target: '.tour .app:not([hidden]) .tab-page:not([hidden]) .launchers' }] },
  { id: 'followUp', title: '일하는 동안 다음 요청 예약', target: '.tour .app:not([hidden]) .tab-page:not([hidden]) .terminal-pane[data-agent]',
    body: '에이전트가 작업 중일 때 다음 요청을 보내면 Follow-up으로 예약돼요. 지금 작업이 끝나는 즉시 이어서 전달돼요. Claude Code에서는 위쪽 🔥 타이머로 프롬프트 캐시가 살아 있는 시간도 보여요.',
    tasks: [{ flag: 'ask', label: '에이전트에게 요청 보내기', hint: '아무 말이나 입력하고 Enter, 그냥 Enter만 눌러도 돼요' }, { flag: 'queue', label: '작업 중에 다음 요청 예약하기', hint: '아무 말이나 입력하고 Tab 또는 Enter, 비워 둬도 돼요' }] },
  { id: 'alert', title: '부르면 바로 알 수 있어요', target: '.tour .folder.active .folder-tabs',
    body: '다른 일을 하는 사이 에이전트가 승인을 기다리면 사이드바에 ⚠, 작업을 마치면 ● 가 떠요. 소리와 OS 알림도 함께 오고, 알림을 누르면 그 터미널로 바로 이동해요.',
    tasks: [{ flag: 'away', label: '다른 탭으로 가서 기다리기', hint: 'web 탭 클릭', target: '.tour [data-tab="web"]' }, { flag: 'back', label: '⚠ 가 뜬 에이전트 탭으로 돌아가기', target: '.tour .folder-tabs [data-agent-state="attention"]' }, { flag: 'answer', label: '요청 승인하기', hint: 'Enter, 아무거나 입력해도 돼요', target: '.tour .app:not([hidden]) .tab-page:not([hidden]) .terminal-pane[data-agent]' }] },
  { id: 'diff', title: '바뀐 코드를 바로 확인', target: '.tour .app:not([hidden]) .tabbar [aria-label="변경사항 Diff 패널"]', keys: [['Diff 패널', 'mod+shift+g']],
    body: '에이전트가 고친 파일은 상단 Diff 버튼과 상태바에 +/− 줄 수로 표시돼요. 패널을 열면 파일별 변경 내용을 바로 비교할 수 있어요.',
    tasks: [{ flag: 'diffOpen', label: 'Diff 패널 열기', hint: `상단 Diff 버튼 또는 ${keys('mod+shift+g')}` }, { flag: 'diffClose', label: '다시 닫기', target: '.tour .app:not([hidden]) .right-panel' }] },
  { id: 'split', title: '한 탭에 여러 터미널', target: '.tour .app:not([hidden]) .tab-page:not([hidden])', keys: [['좌우 분할', 'ctrl+d'], ['상하 분할', 'ctrl+shift+d']],
    body: '터미널을 좌우·상하로 나눠 서버 로그와 에이전트를 한 화면에 두세요. 새로 생긴 칸에서 무엇을 띄울지 고르면 돼요.',
    tasks: [{ flag: 'splitRow', label: '좌우로 나누기', hint: `터미널 안에서 ${keys('ctrl+d')} 또는 칸 위쪽 버튼` }, { flag: 'fill', label: '새 칸에 터미널 띄우기', target: '.tour .app:not([hidden]) .launcher-pane' }, { flag: 'splitColumn', label: '상하로 나누기', hint: `${keys('ctrl+shift+d')} 또는 칸 위쪽 버튼` }] },
  { id: 'pane', title: '칸 사이를 오가고 크게 보기', target: '.tour .app:not([hidden]) .tab-page:not([hidden])', keys: [['칸 이동', 'alt+shift+→'], ['최대화', 'mod+shift+enter']],
    body: '나눈 칸 사이를 키보드로 오가고, 필요할 땐 한 칸만 화면 가득 키워요. 경계선은 끌어서 크기를 바꾸고, 클릭하면 똑같이 나눠져요.',
    tasks: [{ flag: 'focus', label: '다른 칸으로 이동', hint: '클릭 또는 단축키' }, { flag: 'zoom', label: '한 칸 최대화', hint: '칸 위쪽 버튼 또는 단축키' }] },
  { id: 'reorder', title: '탭을 끌어서 정리', target: '.tour .folder.active .folder-tabs', keys: [['탭 위 · 아래로', 'alt+shift+[']],
    body: '탭은 끌어서 순서를 바꾸고, 다른 탭 가운데에 놓으면 분할로 합쳐져요. 우클릭 메뉴와 단축키로도 할 수 있어요.',
    tasks: [{ flag: 'reorder', label: '탭 하나를 다른 자리로 옮기기', hint: '아무 탭이나 끌어서 놓기 또는 단축키', target: '.tour [data-tab="build"]' }] },
  { id: 'palette', title: '모든 기능은 명령 팔레트에', target: '.tour .app:not([hidden]) .palette-button', keys: [['명령 팔레트', 'mod+shift+p']],
    body: '단축키가 기억나지 않아도 괜찮아요. 명령 팔레트에서 이름으로 찾아 바로 실행하고, 옆에 적힌 단축키도 함께 익혀 보세요.',
    tasks: [{ flag: 'palette', label: '명령 팔레트 열기', hint: '상단 검색 칸 또는 단축키' }, { flag: 'command', label: '아무 명령이나 실행하기', hint: '예: ‘codex’ 검색 후 Enter' }] },
  { id: 'settings', title: '내 방식대로 맞추기', target: '.tour .app:not([hidden]) .statusbar', keys: [['설정', 'mod+,']],
    body: '상태바에는 브랜치, 변경 파일, Claude·Codex 사용량이 보여요. 테마와 글꼴, 알림 소리, 상태바 항목까지 설정에서 원하는 대로 바꿀 수 있어요.',
    tasks: [{ flag: 'settingsOpen', label: '설정 열기', hint: '⚙ 버튼 또는 단축키' }, { flag: 'settingsClose', label: '둘러본 뒤 닫기', hint: 'Esc' }] },
  { id: 'finish', title: '준비가 끝났어요', body: '이제 내 프로젝트를 열고 시작해 보세요. 이 둘러보기는 사이드바 아래 책 버튼이나 명령 팔레트에서 언제든 다시 볼 수 있어요.', tasks: [] }
];

// Typing loosely is fine: a request or follow-up can be left empty (an example is sent), any answer approves, and a command typed with the Korean
// 2-set layout still on (치며ㅇㄷ) reads as the Latin keys pressed (claude).
const sampleRequest = '포트를 환경 변수로 바꿔 줘', sampleFollowUp = '테스트도 추가해 줘';
export const agentCommand = (command: string): Agent | '' => /^claude( code)?$/.test(command) ? 'claude' : command === 'codex' ? 'codex' : /^cursor(-agent)?$/.test(command) ? 'cursor' : '';
const initials = 'rRseEfaqQtTdwWczxvg', medials = 'k o i O j p u P h hk ho hl y n nj np nl b m ml l'.split(' ');
const finals = ' r R rt s sw sg e f fr fa fq ft fx fv fg a q qt t T d w c z x v g'.split(' ');
const jamo = 'r R rt s sw sg e E f fr fa fq ft fx fv fg a q Q qt t T d w W c z x v g'.split(' ').concat(medials); // ㄱ (U+3131) … ㅣ (U+3163)
export const latin = (text: string) => [...text].map(ch => {
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) { const n = code - 0xac00; return initials[Math.floor(n / 588)] + medials[Math.floor(n % 588 / 28)] + finals[n % 28].trim(); }
  return code >= 0x3131 && code <= 0x3163 ? jamo[code - 0x3131] : ch;
}).join('');

export const stepDone = (step: Step, tour: Tour) => step.tasks.every(task => tour.done.includes(task.flag));
export const project = (tour: Tour) => tour.projects.find(item => item.id === tour.current) ?? tour.projects[0];
export const activeTab = (tour: Tour) => { const p = project(tour); return p.tabs.find(item => item.id === p.active) ?? p.tabs[0]; };
export const claudeTab = (tour: Tour) => tour.claude ? tour.projects.flatMap(p => p.tabs).find(item => findLeaf(item.pane, tour.claude!.leaf)) : undefined;

// Goals count however and whenever they were reached (click, key, menu or palette, even before their step), so nobody has to redo
// something they already tried. The task labels name the keys as a hint.
export function reduce(tour: Tour, action: Action, now = 0): Tour {
  const earn = (next: Tour, flag: string, when: unknown = true) => when && !next.done.includes(flag) ? { ...next, done: [...next.done, flag] } : next;
  const p = project(tour), at = p.tabs.findIndex(item => item.id === p.active), current = p.tabs[at];
  const setProject = (next: Tour, change: Partial<TourProject>, id = next.current) => ({ ...next, projects: next.projects.map(item => item.id === id ? { ...item, ...change } : item) });
  const setTabs = (next: Tour, tabs: TourTab[]) => setProject(next, { tabs });
  // Moving between tabs: focus goes to the tab's first pane, and the Claude alert flow notices leaving and coming back.
  const show = (next: Tour): Tour => {
    const shown = activeTab(next), mine = claudeTab(next);
    let result: Tour = { ...next, focus: leafList(shown.pane)[0]?.id ?? '', zoom: '' };
    if (mine && shown.id === mine.id && result.claude?.state === 'done') result = { ...result, claude: { ...result.claude, state: 'idle' } };
    const sameProject = next.current === tour.current, index = project(next).tabs.findIndex(item => item.id === shown.id), count = p.tabs.length;
    result = earn(result, 'projectVisit', next.current === 'api-server' && tour.current !== 'api-server');
    result = earn(result, 'projectBack', next.current === 'my-app' && tour.current !== 'my-app');
    result = earn(result, 'tabServer', shown.id === 'server');
    result = earn(result, 'jump', sameProject && index === 0 && at !== 0);
    result = earn(result, 'cycle', sameProject && count > 1 && (Math.abs(index - at) === 1 || Math.abs(index - at) === count - 1));
    result = earn(result, 'away', mine && shown.id !== mine.id);
    return earn(result, 'back', mine && shown.id === mine.id && tour.claude?.state === 'asking');
  };
  const goTab = (index: number) => show(setProject(tour, { active: p.tabs[index].id }));
  const goProject = (id: string) => show({ ...tour, current: id });
  switch (action.type) {
    case 'project': return tour.projects.some(item => item.id === action.id) ? goProject(action.id) : tour;
    case 'projectJump': { const target = tour.projects[action.index === 8 ? tour.projects.length - 1 : action.index]; return target ? reduce(tour, { type: 'project', id: target.id }, now) : tour; }
    case 'projectCycle': { const index = tour.projects.findIndex(item => item.id === tour.current); return reduce(tour, { type: 'project', id: tour.projects[(index + action.step + tour.projects.length) % tour.projects.length].id }, now); }
    case 'tab': { const index = p.tabs.findIndex(item => item.id === action.id); return index < 0 ? tour : goTab(index); }
    case 'jump': { const index = action.index === 8 ? p.tabs.length - 1 : action.index; return index < p.tabs.length ? goTab(index) : tour; }
    case 'cycle': return p.tabs.length > 1 ? goTab((at + action.step + p.tabs.length) % p.tabs.length) : tour;
    case 'move': {
      const from = p.tabs.findIndex(item => item.id === action.id), to = Math.max(0, Math.min(p.tabs.length - 1, action.to));
      if (from < 0 || from === to) return tour;
      const tabs = [...p.tabs], [moved] = tabs.splice(from, 1); tabs.splice(to, 0, moved);
      return earn(setTabs(tour, tabs), 'reorder');
    }
    // Dropping a tab on the middle of another puts both side by side in the target, as the sidebar does.
    case 'merge': {
      const source = p.tabs.find(item => item.id === action.id), target = p.tabs.find(item => item.id === action.into);
      if (!source?.pane || !target?.pane || source === target || !closable(tour, source.id)) return tour;
      const tabs = p.tabs.filter(item => item !== source).map(item => item === target ? { ...item, pane: { direction: 'row' as const, children: [target.pane!, source.pane!], sizes: [1, 1] } } : item);
      return earn(show(setProject(tour, { tabs, active: target.id })), 'reorder');
    }
    case 'closeTab': {
      if (!closable(tour, action.id)) return tour;
      const index = p.tabs.findIndex(item => item.id === action.id), tabs = p.tabs.filter(item => item.id !== action.id);
      return show(setProject(tour, { tabs, active: p.active === action.id ? tabs[Math.min(index, tabs.length - 1)].id : p.active }));
    }
    case 'closePane': {
      if (!closable(tour, action.id)) return tour;
      const owner = p.tabs.find(item => findLeaf(item.pane, action.id)); if (!owner) return tour;
      const pane = remove(owner.pane!, action.id);
      if (!pane) return reduce(tour, { type: 'closeTab', id: owner.id }, now);
      return { ...setTabs(tour, p.tabs.map(item => item === owner ? { ...item, pane } : item)), focus: tour.focus === action.id ? leafList(pane)[0].id : tour.focus, zoom: '' };
    }
    case 'newTab': { const id = `t${tour.seq + 1}`; return earn({ ...setProject(tour, { tabs: [...p.tabs, tab(id, '새 탭')], active: id }), seq: tour.seq + 1, focus: '', zoom: '' }, 'newTab'); }
    case 'launch': {
      if (!action.target) { const opened = reduce(tour, { type: 'newTab' }, now); return reduce(opened, { type: 'launch', target: activeTab(opened).id, agent: action.agent }, now); }
      const id = `l${tour.seq + 1}`, label = action.agent ? agentLabels[action.agent] : 'my-app';
      const page = p.tabs.find(item => item.id === action.target && !item.pane);
      const owner = page ?? p.tabs.find(item => findLeaf(item.pane, action.target)?.kind === 'launcher');
      if (!owner) return tour;
      const leaf: Leaf = { id, kind: 'terminal', ...(action.agent && { agent: action.agent }) };
      const pane = page ? leaf : mapLeaf(owner.pane!, action.target, () => leaf);
      let next: Tour = { ...setTabs(tour, p.tabs.map(item => item.id === owner.id ? { ...item, pane, label: page ? label : item.label } : item)), seq: tour.seq + 1, focus: id,
        labels: { ...tour.labels, [id]: label }, lines: { ...tour.lines, [id]: action.agent ? banner[action.agent] : [] } };
      if (action.agent) next = { ...next, agents: { ...next.agents, [id]: action.agent } };
      if (action.agent && !tour.claude) next = { ...next, claude: { leaf: id, state: 'idle', queue: [], asked: false, at: now } };
      return earn(earn(next, 'claude', action.agent), 'fill', !page);
    }
    case 'split': {
      if (!current.pane || !findLeaf(current.pane, tour.focus)) return tour;
      const id = `l${tour.seq + 1}`;
      return earn({ ...setTabs(tour, p.tabs.map(item => item.id === current.id ? { ...item, pane: split(item.pane!, tour.focus, { id, kind: 'launcher' }, action.dir) } : item)), seq: tour.seq + 1, focus: id, zoom: '', labels: { ...tour.labels, [id]: '새 창' } },
        action.dir === 'row' ? 'splitRow' : 'splitColumn');
    }
    case 'pick': return findLeaf(current.pane, action.id) ? earn({ ...tour, focus: action.id }, 'focus', action.id !== tour.focus) : tour;
    case 'focusBy': {
      const ids = leafList(current.pane).map(leaf => leaf.id);
      return ids.length > 1 ? earn({ ...tour, focus: ids[(Math.max(0, ids.indexOf(tour.focus)) + action.step + ids.length) % ids.length], zoom: '' }, 'focus') : tour;
    }
    case 'zoom': return tour.focus ? earn({ ...tour, zoom: tour.zoom ? '' : tour.focus }, 'zoom', !tour.zoom) : tour;
    case 'layout': return { ...setTabs(tour, p.tabs.map(item => item.id === action.tab ? { ...item, pane: action.pane } : item)) };
    case 'submit': {
      const text = action.text.trim(), agent = tour.agents[action.leaf], say = (...lines: string[]) => ({ ...tour.lines, [action.leaf]: [...(tour.lines[action.leaf] ?? []), ...lines] });
      if (!agent) {
        // Typing the CLI name turns this shell into that agent's terminal, as the real app detects it.
        const command = latin(text).toLowerCase(), agent = agentCommand(command);
        if (agent) {
          const next: Tour = { ...tour, agents: { ...tour.agents, [action.leaf]: agent }, labels: { ...tour.labels, [action.leaf]: agentLabels[agent] }, lines: say(`${shellPrompt}${command}`, ...banner[agent]),
            claude: !tour.claude ? { leaf: action.leaf, state: 'idle', queue: [], asked: false, at: now } : tour.claude };
          return earn(next, 'claude');
        }
        return { ...tour, lines: say(`${shellPrompt}${action.text}`, ...(text ? [`${c.dim}(둘러보기에서는 명령이 실행되지 않아요)${c.off}`] : [])) };
      }
      const claude = tour.claude;
      if (!claude || claude.leaf !== action.leaf) return { ...tour, lines: say(`${agentPrompt(agent)}${text}`, `${c.dim}  (둘러보기 화면이에요)${c.off}`) };
      if (claude.state === 'asking') {
        return earn({ ...tour, changes: 1, claude: { ...claude, state: 'done' }, lines: say(`${c.orange}❯${c.off} 1. 예`, `${c.orange}⏺${c.off} Update(${c.bold}src/server.ts${c.off})`, `  ⎿  ${c.green}+1${c.off} ${c.yellow}−1${c.off}`, `${c.orange}⏺${c.off} 포트를 환경 변수에서 읽도록 바꿨습니다.`, '') }, 'answer');
      }
      if (claude.state === 'working') return reduce(tour, { type: 'queue', text }, now);
      const request = text || sampleRequest;
      return earn({ ...tour, claude: { ...claude, state: 'working', at: now }, lines: say(`${agentPrompt(agent)}${request}`, `${c.orange}✻${c.off} 작업 중… ${c.dim}(esc 로 중단)${c.off}`) }, 'ask');
    }
    case 'queue': return tour.claude?.state === 'working' ? earn({ ...tour, claude: { ...tour.claude, queue: [...tour.claude.queue, action.text.trim() || sampleFollowUp] } }, 'queue') : tour;
    case 'unqueue': return tour.claude ? { ...tour, claude: { ...tour.claude, queue: tour.claude.queue.filter((_, index) => index !== action.index) } } : tour;
    case 'workDone': {
      const claude = tour.claude; if (claude?.state !== 'working') return tour;
      const lines = [...tour.lines[claude.leaf], `${c.orange}⏺${c.off} 요청을 처리했습니다.`, ''];
      if (claude.queue.length) return { ...tour, claude: { ...claude, queue: claude.queue.slice(1), at: now }, lines: { ...tour.lines, [claude.leaf]: [...lines, `${agentPrompt(tour.agents[claude.leaf] ?? 'claude')}${claude.queue[0]}  ${c.dim}(Follow-up 자동 전송)${c.off}`, `${c.orange}✻${c.off} 작업 중…`] } };
      const watching = activeTab(tour).id === claudeTab(tour)?.id;
      return { ...tour, claude: { ...claude, state: watching ? 'idle' : 'done', at: now }, lines: { ...tour.lines, [claude.leaf]: lines } };
    }
    case 'ask': {
      // Only while the user looks elsewhere: the point is to find the ⚠ in the sidebar.
      const claude = tour.claude; if (!claude || claude.asked || claude.state === 'working' || activeTab(tour).id === claudeTab(tour)?.id) return tour;
      return { ...tour, claude: { ...claude, state: 'asking', asked: true }, lines: { ...tour.lines, [claude.leaf]: [...tour.lines[claude.leaf], `${c.orange}⏺${c.off} src/server.ts 를 수정하려고 합니다.`, `  ${c.red}- const port = 3000;${c.off}`, `  ${c.green}+ const port = Number(process.env.PORT ?? 3000);${c.off}`, `${c.bold}  이 파일을 수정할까요?${c.off}`, `  ${c.orange}❯${c.off} 1. 예   2. 아니요`, ''] } };
    }
    case 'diff': return earn(earn({ ...tour, diff: !tour.diff }, 'diffOpen', !tour.diff), 'diffClose', tour.diff);
    case 'palette': return earn({ ...tour, palette: action.open }, 'palette', action.open);
    case 'command': return earn(tour, 'command');
    case 'settings': return earn(earn({ ...tour, settings: action.open }, 'settingsOpen', action.open), 'settingsClose', !action.open && tour.settings);
  }
}
