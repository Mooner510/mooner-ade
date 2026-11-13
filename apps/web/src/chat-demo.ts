// The tutorial's Chat showcase: scripted conversations played on the real chat pane, so the tour shows Chat mode at work (streamed replies, tool cards,
// diffs, approvals, questions, Interactive UI) without an agent. The driver types into the pane's composer and clicks its controls with a drawn pointer;
// the pane's RPC goes to `call` here while it runs. Scenarios are drawn at random from a pool, without repeats until the pool runs out.
import { emptyState, type ChatState } from './chat-model';

type Option = [label: string, description: string];
// `$1` in any text is the user's last choice (a form's first value or a picked option).
export type Part = { think: string } | { say: string } | { tool: string; input: Record<string, unknown>; result?: string; error?: boolean }
  | { ask: { question: string; header: string; options: Option[] }[] };
// A turn without `send` answers the Interactive UI form in the previous reply.
export type Turn = { send?: string; reply: Part[] };
export type Scenario = { title: string; turns: Turn[] };

const ui = (spec: unknown) => `\n\n\`\`\`ui\n${JSON.stringify(spec)}\n\`\`\``;
const bash = (command: string, description: string, result: string, extra: Partial<Extract<Part, { tool: string }>> = {}): Part => ({ tool: 'Bash', input: { command, description }, result, ...extra });
const edit = (file_path: string, old_string: string, new_string: string): Part => ({ tool: 'Edit', input: { file_path, old_string, new_string } });
const write = (file_path: string, content: string): Part => ({ tool: 'Write', input: { file_path, content } });
const read = (file_path: string, result: string): Part => ({ tool: 'Read', input: { file_path }, result });
const grep = (pattern: string, path: string, result: string): Part => ({ tool: 'Grep', input: { pattern, path }, result });

export const SCENARIOS: Scenario[] = [
  { title: '로그인 401 오류 수정', turns: [{ send: '로그인하면 가끔 401이 떠. 원인 찾아서 고쳐 줘', reply: [
    { think: '토큰 갱신 직후에 요청이 겹치면 이전 토큰이 실릴 수 있다. 클라이언트에서 토큰을 읽는 곳부터 보자.' },
    grep('refreshToken', 'src', 'src/auth/session.ts:42\nsrc/api/client.ts:18'),
    read('src/api/client.ts', 'export async function request(url: string) {\n  const token = store.token;\n  return fetch(url, auth(token));\n}'),
    { say: '토큰을 갱신하는 동안 보낸 요청이 **이전 토큰**을 그대로 쓰고 있었어요. 갱신이 끝날 때까지 기다리도록 고칠게요.' },
    edit('src/api/client.ts', '  const token = store.token;\n', '  const token = (await store.refreshing) ?? store.token;\n'),
    bash('npm test -- auth', '인증 테스트 실행', 'PASS  src/auth/session.test.ts (12 tests)\nPASS  src/api/client.test.ts (8 tests)\n\nTests: 20 passed, 20 total'),
    { say: `고쳤어요. 요청이 한꺼번에 몰려도 새 토큰을 받은 뒤에 보내요.${ui(['stats', ['테스트', '20/20', 'ok'], ['수정한 파일', '1'], ['401 재현', '0%', 'ok', '이전 3.2%']])}` }] }] },
  { title: '주문 API 속도 개선', turns: [
    { send: '/orders API가 느려졌대. 어디가 느린지 차트로 보여 줘', reply: [
      bash('npm run bench -- /orders', '엔드포인트 벤치마크', 'p50 182ms   p95 940ms   p99 1.8s'),
      { think: '주문마다 상품을 따로 읽는 N+1 쿼리가 의심된다.' },
      grep('findProduct', 'src/orders', 'src/orders/list.ts:27:  for (const order of orders) order.product = await findProduct(order.productId);'),
      { say: `주문마다 상품을 따로 읽는 **N+1 쿼리** 때문에 느려요.${ui(['chart', 'bar', '구간별 소요 시간 (ms)', ['DB 조회', '직렬화', '인증', '기타'], ['현재', 610, 140, 90, 100]])}\n\n한 번에 묶어 읽도록 바꿀까요?` }] },
    { send: '응 바꿔 줘', reply: [
      edit('src/orders/list.ts', '  for (const order of orders) order.product = await findProduct(order.productId);\n', '  const products = await findProducts(orders.map(order => order.productId));\n  for (const order of orders) order.product = products.get(order.productId);\n'),
      bash('npm run bench -- /orders', '다시 측정', 'p50 64ms   p95 120ms   p99 210ms'),
      { say: `p95가 **940ms → 120ms**로 줄었어요.${ui(['chart', 'line', 'p95 응답 시간 (ms)', ['1회', '2회', '3회', '4회', '5회'], ['이전', 880, 910, 940, 925, 940], ['수정 후', 130, 124, 120, 118, 120]])}` }] }] },
  { title: 'stage 배포', turns: [
    { send: 'stage에 배포 준비해 줘', reply: [
      bash('git log --oneline origin/stage..HEAD', '배포할 커밋 확인', 'a1c9e2f feat: 주문 내역 필터\n7b03d18 fix: 결제 실패 메시지\n3e5f0aa chore: 의존성 정리'),
      { say: `커밋 **3개**가 나가요. 배포 옵션을 골라 주세요.${ui(['form', '배포 옵션', '배포 시작', ['radio', 'env', '환경', 'stage', 'stage-2'], ['check', 'migrate', 'DB 마이그레이션 실행', true], ['slider', 'replicas', '인스턴스 수', 1, 6, 2]])}` }] },
    { reply: [
      { say: `**$1** 환경으로 배포를 시작할게요.${ui(['steps', ['빌드', 'done'], ['테스트', 'done'], ['마이그레이션', 'active'], ['배포', 'todo']])}` },
      bash('pnpm deploy --env $1', '배포', '✓ build   ✓ test   ✓ migrate   ✓ rollout\nhttps://$1.my-app.dev'),
      { say: `배포가 끝났어요.${ui(['steps', ['빌드', 'done'], ['테스트', 'done'], ['마이그레이션', 'done'], ['배포', 'done']])}` }] }] },
  { title: '오래된 로그 정리', turns: [{ send: '디스크가 거의 찼어. 오래된 로그 좀 정리해 줘', reply: [
    bash('du -sh logs/* | sort -h | tail -3', '로그 크기 확인', '1.2G\tlogs/2026-09\n2.8G\tlogs/2026-10\n3.1G\tlogs/archive'),
    { say: '30일이 지난 로그가 **7.1GB**예요. 지울게요.' },
    bash("find logs -name '*.log' -mtime +30 -delete", '30일 지난 로그 삭제', ''),
    { say: `**7.1GB**를 비웠어요.${ui(['chart', 'pie', '디스크 사용량 (GB)', ['앱', 'DB', '로그', '여유'], ['GB', 38, 24, 4, 34]])}` }] }] },
  { title: '회원가입 페이지', turns: [{ send: '회원가입 페이지 만들어 줘', reply: [
    { think: '가입 방식에 따라 폼과 API가 달라진다. 먼저 물어보자.' },
    { ask: [{ question: '어떤 방식으로 가입하게 할까요?', header: '가입 방식', options: [['이메일 + 비밀번호', '가장 익숙한 방식'], ['소셜 로그인', 'Google · GitHub 계정으로'], ['매직 링크', '비밀번호 없이 메일 링크로']] }] },
    { say: '**$1** 방식으로 만들게요.' },
    write('src/pages/Signup.tsx', 'export function Signup() {\n  return (\n    <form className="signup" onSubmit={register}>\n      <h1>회원가입</h1>\n      <EmailField />\n      <button className="primary">가입하기</button>\n    </form>\n  );\n}\n'),
    bash('npm run typecheck', '타입 검사', 'Found 0 errors.'),
    { say: '`src/pages/Signup.tsx`를 만들었어요. 라우터에 `/signup`도 연결해 둘까요?' }] }] },
  { title: '테스트 커버리지', turns: [
    { send: '테스트 커버리지 어때?', reply: [
      bash('npm test -- --coverage', '커버리지 측정', 'Statements 78.4% | Branches 64.1% | Functions 81.0% | Lines 79.2%\nTests: 214 passed, 2 skipped'),
      { say: `${ui([['stats', ['구문', '78.4%', 'ok'], ['분기', '64.1%', 'warn', '목표 70%'], ['함수', '81.0%', 'ok'], ['테스트', '214 통과', 'info', '2개 건너뜀']], ['chart', 'bar', '폴더별 라인 커버리지 (%)', ['api', 'auth', 'orders', 'ui', 'utils'], ['커버리지', 86, 91, 62, 71, 95]]])}\n\n**orders** 폴더가 가장 낮아요. 테스트를 더 써 볼까요?` }] },
    { send: '응, orders 테스트 보강해 줘', reply: [
      read('src/orders/list.ts', 'export async function listOrders(userId: string) { … }'),
      write('tests/orders/list.test.ts', "import { listOrders } from '../../src/orders/list';\n\ntest('빈 주문 목록', async () => {\n  expect(await listOrders('u1')).toEqual([]);\n});\n"),
      bash('npm test -- orders', 'orders 테스트', 'Tests: 18 passed, 18 total'),
      { say: 'orders 커버리지가 **62% → 84%**로 올랐어요.' }] }] },
  { title: '날짜 라이브러리 비교', turns: [{ send: '날짜 라이브러리 뭐 쓸지 비교해 줘', reply: [
    { tool: 'WebSearch', input: { query: 'date-fns vs dayjs vs luxon bundle size' }, result: 'Web search results for query: "date-fns vs dayjs vs luxon bundle size"\n\nLinks: [{"title":"date-fns - modern JavaScript date utility library","url":"https://date-fns.org"},{"title":"Day.js · 2kB JavaScript date utility library","url":"https://day.js.org"},{"title":"Luxon - immutable date wrapper","url":"https://moment.github.io/luxon"}]' },
    { say: `| | date-fns | Day.js | Luxon |\n|---|---|---|---|\n| 가져오는 방식 | 함수 단위 | 플러그인 | 통째로 |\n| 타임존 | 별도 패키지 | 플러그인 | 기본 내장 |${ui(['chart', 'bar', '번들 크기 (kB, gzip)', ['date-fns', 'Day.js', 'Luxon'], ['크기', 6.9, 2.9, 23]])}\n\n가볍게 쓰려면 **Day.js**, 타임존을 많이 다루면 **Luxon**을 추천해요.` }] }] },
  { title: '유틸 함수 이름 정리', turns: [{ send: '유틸 함수 이름이 제각각이네. 정리해 줘', reply: [
    { tool: 'Glob', input: { pattern: 'src/utils/*.ts' }, result: 'src/utils/format.ts\nsrc/utils/money.ts\nsrc/utils/time.ts' },
    { think: 'fmt, 2str, to… 접두가 섞여 있다. format으로 맞추고 쓰는 곳도 바꾸자.' },
    { tool: 'MultiEdit', input: { file_path: 'src/utils/format.ts', edits: [{ old_string: 'export function fmtDate(', new_string: 'export function formatDate(' }, { old_string: 'export function money2str(', new_string: 'export function formatMoney(' }] } },
    bash('npm run typecheck', '타입 검사', 'Found 0 errors.'),
    { say: '이름을 `format…`으로 맞췄고, 쓰는 곳 **14군데**도 함께 바꿨어요.' }] }] },
  { title: '빌드 오류 수정', turns: [{ send: '빌드가 깨졌어. 고쳐 줘', reply: [
    bash('npm run build', '빌드', "src/cart/total.ts:12:18 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.", { error: true }),
    { think: '가격이 문자열로 들어온다. 더하기 전에 숫자로 바꿔야 한다.' },
    edit('src/cart/total.ts', '  return sum + item.price;\n', '  return sum + Number(item.price);\n'),
    bash('npm run build', '다시 빌드', '✓ built in 3.2s'),
    { say: '가격이 **문자열**로 들어와 타입 오류가 났어요. 숫자로 바꿔 더하도록 고쳤고 빌드가 통과해요.' }] }] },
  { title: '버튼 색 비교', turns: [{ send: '버튼 색 후보를 바로 눌러 볼 수 있게 보여 줘', reply: [
    { say: 'Interactive UI로 만들었어요. 색을 눌러 보세요.\n\n```ade-ui\n<div class="row" id="s"></div><p class="muted" id="n"></p>\n<style>#s button{width:64px;height:40px;border-radius:8px;border:2px solid transparent;padding:0}#s button.on{border-color:var(--fg)}</style>\n<script>\nconst c=[["#3b82f6","Blue"],["#8b5cf6","Violet"],["#10b981","Green"],["#f59e0b","Amber"]];let i=0;\nconst s=document.getElementById("s"),n=document.getElementById("n");\nconst draw=()=>{[...s.children].forEach((b,k)=>b.classList.toggle("on",k===i));n.textContent=c[i][1]+" · "+c[i][0];};\nc.forEach(([v,l],k)=>{const b=document.createElement("button");b.style.background=v;b.title=l;b.onclick=()=>{i=k;draw();};s.append(b);});\ndraw();setInterval(()=>{i=(i+1)%c.length;draw();},1500);\n</script>\n```' }] }] },
  { title: '닉네임 컬럼 추가', turns: [{ send: 'users 테이블에 닉네임 컬럼 추가해 줘', reply: [
    { say: ui(['steps', ['마이그레이션 작성', 'active'], ['모델 수정', 'todo'], ['테스트', 'todo']]).trim() },
    write('migrations/20261113_add_nickname.sql', 'ALTER TABLE users ADD COLUMN nickname varchar(32);\n'),
    edit('src/models/user.ts', '  email: string;\n', '  email: string;\n  nickname?: string;\n'),
    bash('npm run migrate && npm test -- user', '마이그레이션과 테스트', '✓ 20261113_add_nickname\nTests: 9 passed, 9 total'),
    { say: `**nickname** 컬럼을 추가했어요. 기존 사용자는 비어 있어요.${ui(['steps', ['마이그레이션 작성', 'done'], ['모델 수정', 'done'], ['테스트', 'done']])}` }] }] },
  { title: '패키지 업데이트', turns: [
    { send: '오래된 패키지 업데이트해 줘', reply: [
      bash('npm outdated', '업데이트 확인', 'Package  Current  Wanted  Latest\nreact    19.1.0   19.2.1  19.2.1\nvite     7.0.4    7.1.2   7.1.2\nzod      3.24.1   3.25.0  4.0.5'),
      { say: `올릴 패키지를 골라 주세요. **zod 4**는 메이저 업데이트예요.${ui(['form', '업데이트할 패키지', '업데이트', ['check', 'react', 'react 19.2.1', true], ['check', 'vite', 'vite 7.1.2', true], ['check', 'zod', 'zod 4.0.5 (메이저)', false]])}` }] },
    { reply: [
      bash('npm install react@19.2.1 vite@7.1.2', '패키지 설치', 'changed 12 packages in 4s'),
      bash('npm test', '테스트', 'Tests: 214 passed, 214 total'),
      { say: '골라 주신 패키지를 올렸고 테스트도 모두 통과했어요.' }] }] },
  { title: '접근성 점검', turns: [{ send: '접근성 문제 있는지 봐 줘', reply: [
    grep('<button(?![^>]*aria-label)[^>]*>\\s*<Icon', 'src', 'src/Header.tsx:31\nsrc/Cart.tsx:88\nsrc/Modal.tsx:12'),
    { say: '아이콘만 있는 버튼 **3개**에 이름이 없어서 스크린 리더가 읽지 못해요.' },
    edit('src/Header.tsx', '<button onClick={openMenu}><Icon name="menu" /></button>', '<button aria-label="메뉴 열기" onClick={openMenu}><Icon name="menu" /></button>'),
    { say: `${ui(['stats', ['고친 버튼', '3', 'ok'], ['대비 부족', '1', 'warn', 'Footer 링크'], ['이미지 alt', '모두 있음', 'ok']])}\n\n푸터 링크 색 대비도 손볼까요?` }] }] },
  { title: 'README 한국어판', turns: [{ send: 'README를 한국어로도 만들어 줘', reply: [
    read('README.md', '# my-app\n\nA small web app for orders.\n\n## Getting started\n\nnpm install\nnpm run dev'),
    write('README.ko.md', '# my-app\n\n주문을 관리하는 작은 웹 앱이에요.\n\n## 시작하기\n\n```sh\nnpm install\nnpm run dev\n```\n'),
    { say: '`README.ko.md`를 만들었고, 영어 README 맨 위에 링크를 걸어 뒀어요.' }] }] },
  { title: 'CI 시간 줄이기', turns: [{ send: 'CI가 왜 이렇게 오래 걸려?', reply: [
    read('.github/workflows/ci.yml', 'jobs:\n  test:\n    steps:\n      - run: npm ci\n      - run: npm run e2e'),
    { say: `${ui(['chart', 'bar', 'CI 단계별 시간 (분)', ['install', 'lint', 'test', 'build', 'e2e'], ['시간', 4.2, 0.8, 3.1, 1.6, 7.4]])}\n\n의존성 캐시가 없고 **e2e**가 한 줄로 돌아요. 캐시를 켤게요.` },
    edit('.github/workflows/ci.yml', '      - run: npm ci\n', "      - uses: actions/cache@v4\n        with: { path: ~/.npm, key: npm-${{ hashFiles('package-lock.json') }} }\n      - run: npm ci\n"),
    { say: '예상 시간이 **17분 → 9분**으로 줄어요. e2e를 4개로 나누면 6분까지 줄일 수 있어요.' }] }] },
  { title: '알림 설정 화면', turns: [{ send: '알림 설정 화면 만들 건데, 몇 가지 정해 줘', reply: [
    { ask: [{ question: '알림은 어디로 보낼까요?', header: '채널', options: [['앱 안에서만', '배지와 목록'], ['이메일', '하루 한 번 모아서'], ['푸시', '모바일 알림']] },
      { question: '기본값은 어떻게 할까요?', header: '기본값', options: [['모두 켜기', '나중에 끌 수 있어요'], ['중요한 것만', '결제·보안 알림']] }] },
    { say: '**$1** 기준으로 설정 화면을 만들게요.' },
    write('src/pages/NotificationSettings.tsx', 'export function NotificationSettings() {\n  return <section className="settings">…</section>;\n}\n'),
    { say: `만들었어요.${ui(['stats', ['새 화면', '1'], ['설정 항목', '6'], ['타입 검사', '통과', 'ok']])}` }] }] }
];

// The showcase chat runs as one fixed setup: Opus 5.5 · High in "편집 허용" (acceptEdits) mode, so what asks and what does not is what that mode
// does. File edits and read-only commands go ahead; any other command waits on the approval card (until "항상 허용" adds its rule for the session).
export const demoChatState = (): ChatState => ({ ...emptyState(), model: 'claude-opus-5-5', effort: 'high', permissionMode: 'acceptEdits' });
export const demoModels = { models: { '': 'claude-opus-5-5', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }, catalog: [] };
const READ_ONLY = /^(git (log|status|diff|show)|du|ls|cat|head|tail|wc|npm (outdated|ls))\b/;
// The session rule "항상 허용" adds: the command and its subcommand (`npm run build`, `npm test`).
export const commandRule = (command: string) => { const words = command.trim().split(/\s+/); return words.slice(0, words[1] === 'run' ? 3 : 2).join(' '); };
export const needsApproval = (part: Part, allowed: Set<string>) => 'tool' in part && part.tool === 'Bash' && !READ_ONLY.test(String(part.input.command ?? '')) && !allowed.has(commandRule(String(part.input.command ?? '')));

// The pane's server side while the demo runs: chat/event and chat/state messages, as the websocket delivers them.
type Emit = (message: { type: 'chat/event'; event: unknown } | { type: 'chat/state'; state: ChatState }) => void;
const HALT = Symbol('halt'), SKIP = Symbol('skip');
const pickOne = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

// Plays scenarios until stopped. `pane` finds the chat pane on screen; `cursor` is the drawn pointer (its --x/--y place it, `press` plays a click).
export function chatDemo(emit: Emit, pane: () => HTMLElement | null, cursor: HTMLElement) {
  let on = true, skip = false, status: ChatState['status'] = 'idle', serial = 0, typed = '';
  let waiter: { action: string; resolve(params: any): void } | null = null;
  const allowed = new Set<string>();
  const stats = { costUsd: 0, turns: 0, contextTokens: 9_400, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 } };
  const event = (value: unknown) => { if (on) emit({ type: 'chat/event', event: value }); };
  const state = (next: ChatState['status']) => {
    status = next;
    if (on) emit({ type: 'chat/state', state: { ...demoChatState(), status: next, costUsd: stats.costUsd, turns: stats.turns, contextTokens: stats.contextTokens, contextWindow: 200_000, tokens: { ...stats.tokens },
      cache: stats.turns ? { at: Date.now(), ttl: 300, tokens: stats.contextTokens, model: 'claude-opus-5-5' } : null } });
  };
  // Every pause is where a stop or the pane's stop button takes effect.
  const wait = (ms: number) => new Promise<void>((resolve, reject) => setTimeout(() => !on ? reject(HALT) : skip ? reject(SKIP) : resolve(), ms));
  // The pane's next chat/send or chat/approve (null if none comes, e.g. the click missed).
  const next = (action: string) => {
    const answer = new Promise<any>(resolve => { waiter = { action, resolve }; });
    return () => Promise.race([answer, wait(5000).then(() => null)]);
  };
  const setValue = (input: HTMLTextAreaElement | HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const point = async (target: Element) => {
    const box = target.getBoundingClientRect();
    cursor.style.setProperty('--x', `${Math.round(box.left + box.width * between(.3, .6))}px`);
    cursor.style.setProperty('--y', `${Math.round(box.top + box.height * between(.35, .65))}px`);
    await wait(700);
  };
  const click = async (target: Element | null | undefined) => {
    if (!target?.isConnected) return;
    await point(target);
    cursor.classList.remove('press'); void cursor.offsetWidth; cursor.classList.add('press');
    await wait(150);
    if (target.isConnected) (target as HTMLElement).click();
    await wait(350);
  };
  const find = <T extends Element>(selector: string) => pane()?.querySelector<T>(selector) ?? null;
  const fill = (text: string, choice: string) => text.replaceAll('$1', choice);

  async function type(text: string) {
    const box = find<HTMLTextAreaElement>('textarea[aria-label="메시지 입력"]'); if (!box) throw SKIP;
    await point(box);
    const chars = [...text];
    for (let at = 1; at <= chars.length; at++) {
      if (!box.isConnected) throw SKIP;
      typed = chars.slice(0, at).join(''); setValue(box, typed);
      await wait(chars[at - 1] === ' ' ? between(70, 160) : between(30, 85));
    }
    await wait(350);
  }
  // Picks in the last Interactive UI form as a person would (an option, maybe a checkbox, the slider), then presses its button.
  async function answerForm() {
    const forms = pane()?.querySelectorAll('.ui-form'), form = forms?.[forms.length - 1]; if (!form) throw SKIP;
    for (const group of form.querySelectorAll('.ui-radio')) await click(pickOne([...group.querySelectorAll('label.ui-choice')]));
    for (const check of form.querySelectorAll('label.ui-check')) if (Math.random() < .5) await click(check);
    for (const range of form.querySelectorAll<HTMLInputElement>('input[type=range]')) {
      await point(range); setValue(range, String(Math.round(between(Number(range.min), Number(range.max))))); await wait(400);
    }
    await click(form.querySelector('button[type=submit]'));
  }
  // The question card: an option per question (a pick moves on to the next one), then "답변 보내기".
  async function answerQuestions() {
    for (let round = 0; round < 4; round++) {
      const card = find('.chat-question'); if (!card) return;
      const option = pickOne([...card.querySelectorAll('label.chat-q-option:not(.other):not(.on)')]);
      if (option) { await click(option); await wait(400); }
      const send = [...(find('.chat-question')?.querySelectorAll<HTMLButtonElement>('button.primary') ?? [])].find(button => button.textContent?.includes('보내기') && !button.disabled);
      if (send) { await click(send); return; }
    }
  }

  async function play(part: Part, choice: string): Promise<string> {
    const id = `demo-${++serial}`, toolId = `${id}-tool`;
    if ('think' in part || 'say' in part) {
      const phase = 'think' in part ? 'thinking' : 'text', text = fill('think' in part ? part.think : part.say, choice);
      event({ kind: 'delta', phase: 'start', messageId: id });
      for (let at = 0; at < text.length;) { const size = 2 + Math.floor(Math.random() * 6); event({ kind: 'delta', phase, messageId: id, index: 0, text: text.slice(at, at + size) }); at += size; await wait(between(16, 42)); }
      event({ kind: 'message', id, blocks: [{ type: phase, text }] });
      await wait(between(250, 600));
      return choice;
    }
    if ('ask' in part) {
      const questions = part.ask.map(item => ({ question: item.question, header: item.header, multiSelect: false, options: item.options.map(([label, description]) => ({ label, description })) }));
      event({ kind: 'message', id, blocks: [{ type: 'tool_use', id: toolId, name: 'AskUserQuestion', input: { questions } }] });
      await wait(500);
      const answered = next('chat/approve');
      event({ kind: 'approval', phase: 'request', requestId: id, tool: 'AskUserQuestion', input: { questions }, toolUseId: toolId,
        questions: part.ask.map((item, q) => ({ id: `q${q}`, prompt: item.question, header: item.header, options: item.options.map(([label, description], o) => ({ id: `o${o}`, label, description })) })) });
      await wait(1100);
      await answerQuestions();
      const params = await answered(); if (!params?.allow) { event({ kind: 'tool_result', toolUseId: toolId, content: '사용자가 답하지 않고 넘어갔습니다.', isError: true }); throw SKIP; }
      // Answers are option ids (o0, o1…) or typed text.
      const picked = part.ask.map((item, q) => ((params.answers?.[`q${q}`] ?? []) as string[]).map(o => /^o\d+$/.test(o) ? item.options[Number(o.slice(1))]?.[0] ?? o : o).join(', '));
      event({ kind: 'tool_result', toolUseId: toolId, content: `User has answered your questions: ${part.ask.map((item, q) => `"${item.question}"="${picked[q]}"`).join(', ')}.` });
      await wait(400);
      return picked[0] || choice;
    }
    const input = JSON.parse(fill(JSON.stringify(part.input), JSON.stringify(choice).slice(1, -1)));
    event({ kind: 'message', id, blocks: [{ type: 'tool_use', id: toolId, name: part.tool, input }] });
    if (needsApproval({ ...part, input }, allowed)) {
      await wait(600);
      const answered = next('chat/approve'), rule = commandRule(String(input.command));
      event({ kind: 'approval', phase: 'request', requestId: id, tool: part.tool, input, toolUseId: toolId,
        suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: `${rule}:*` }], behavior: 'allow', destination: 'session' }] });
      await wait(1200);
      // Now and then "항상 허용", so the same command later runs without asking.
      const buttons = [...(find('.chat-approval footer')?.querySelectorAll('button') ?? [])];
      await click(Math.random() < .35 ? buttons.find(button => button.textContent === '항상 허용') : buttons.find(button => button.classList.contains('primary')));
      const params = await answered();
      if (params?.allow === false) { event({ kind: 'tool_result', toolUseId: toolId, content: '사용자가 실행을 거부했습니다.', isError: true }); throw SKIP; }
      if (params?.always) allowed.add(rule);
    }
    await wait(between(500, 1400));
    event({ kind: 'tool_result', toolUseId: toolId, content: fill(part.result ?? '', choice), isError: part.error === true });
    await wait(300);
    return choice;
  }

  const finish = (result: 'success' | 'interrupted') => {
    if (status === 'idle') return;
    const grew = Math.round(between(1800, 6400));
    stats.turns += 1; stats.costUsd += between(.01, .06); stats.contextTokens += grew;
    stats.tokens = { input: stats.tokens.input + grew, output: stats.tokens.output + Math.round(between(300, 1200)), cacheRead: stats.tokens.cacheRead + stats.contextTokens - grew, cacheCreate: stats.tokens.cacheCreate + grew };
    event({ kind: 'result', status: result, text: '', costUsd: null, durationMs: 0 });
    state('idle');
  };
  // A finished turn's steps fold under "과정": open it and the file change in it, so the diff shows.
  async function showChange() {
    const scroller = find<HTMLElement>('.chat-scroll');
    // The thread's own scroll (scrollIntoView would also move the tour's containers).
    const reveal = async (target: Element) => {
      if (!scroller) return;
      const box = target.getBoundingClientRect(), view = scroller.getBoundingClientRect();
      if (box.top < view.top + 40 || box.bottom > view.bottom - 40) { scroller.scrollBy({ top: box.top - view.top - view.height / 3, behavior: 'smooth' }); await wait(600); }
    };
    await wait(600);
    const heads = pane()?.querySelectorAll('.chat-process-head'), head = heads?.[heads.length - 1]; if (!head) return;
    await reveal(head);
    if (head.getAttribute('aria-expanded') === 'false') { await click(head); await wait(500); }
    const cards = [...(pane()?.querySelectorAll('.chat-tool[data-tool="Edit"], .chat-tool[data-tool="MultiEdit"], .chat-tool[data-tool="Write"]') ?? [])].filter(card => !card.closest('[data-folded]'));
    const card = cards[cards.length - 1]?.querySelector('.chat-tool-head'); if (!card) return;
    await reveal(card);
    if (card.getAttribute('aria-expanded') === 'false') await click(card);
    await wait(2800);
  }
  async function scenario(item: Scenario) {
    let choice = '';
    for (const [index, turn] of item.turns.entries()) {
      const sent = next('chat/send');
      if (turn.send) { await type(turn.send); await click(find('button.chat-send:not(.stop)')); } else await answerForm();
      const params = await sent(); if (!params) throw SKIP;
      typed = '';
      if (!turn.send) choice = /^- [^:\n]+: (.+)$/m.exec(String(params.text ?? ''))?.[1] ?? choice;
      if (index === 0) event({ kind: 'title', text: item.title });
      await wait(between(300, 700));
      for (const part of turn.reply) choice = await play(part, choice);
      finish('success');
      if (turn.reply.some(part => 'tool' in part && ['Edit', 'MultiEdit', 'Write'].includes(part.tool)) && Math.random() < .8) await showChange();
      await wait(between(1200, 2000));
    }
  }
  void (async () => {
    let bag: Scenario[] = [], last: Scenario | undefined;
    state('idle');
    cursor.style.setProperty('--x', `${Math.round(innerWidth * .6)}px`); cursor.style.setProperty('--y', `${Math.round(innerHeight * .7)}px`);
    await wait(900).catch(() => {});
    while (on) {
      // A shuffled pass through the pool; a new pass never starts with the scenario that just played.
      if (!bag.length) { bag = [...SCENARIOS].sort(() => Math.random() - .5); if (bag[bag.length - 1] === last) bag.unshift(bag.pop()!); }
      last = bag.pop()!;
      try { await scenario(last); } catch (cause) { if (cause === HALT) return; skip = false; finish('interrupted'); }
      await wait(between(1500, 2500)).catch(() => {});
    }
  })();

  return {
    // The pane's RPC during the demo; undefined: not the demo's (the tutorial's stand-in answers it).
    call(action: string, params: any): object | undefined {
      if (action === 'chat/send') {
        event({ kind: 'user', text: String(params?.text ?? '') }); state('working');
        if (waiter?.action === action) { const { resolve } = waiter; waiter = null; resolve(params); }
        return {};
      }
      if (action === 'chat/approve') {
        event({ kind: 'approval', phase: 'answered', requestId: params?.requestId, allow: params?.allow !== false });
        if (waiter?.action === action) { const { resolve } = waiter; waiter = null; resolve(params); }
        return {};
      }
      if (action === 'chat/interrupt') { skip = true; return {}; }
      return undefined;
    },
    // Leaves the pane idle with the conversation so far, and takes back half-typed text.
    stop() {
      if (status !== 'idle') { event({ kind: 'result', status: 'success', text: '', costUsd: null, durationMs: 0 }); state('idle'); }
      const box = find<HTMLTextAreaElement>('textarea[aria-label="메시지 입력"]');
      if (box && typed && box.value === typed) setValue(box, '');
      on = false;
    }
  };
}
