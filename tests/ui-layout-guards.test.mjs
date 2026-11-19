import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// UI/UX 점검(0.6.0)에서 고친 레이아웃·접근성 결함이 되돌아오지 않게 지키는 스타일시트·마크업 규칙 검사. 브라우저 없이 소스를 읽는다.
const read = name => readFile(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const rule = (css, selector) => { const start = css.indexOf(`${selector} {`); assert.ok(start >= 0, `${selector} 규칙이 없습니다`); return css.slice(start, css.indexOf('}', start) + 1); };

test('첫 실행 화면은 낮은 창에서도 테마 목록이 최소 높이를 지키고 다음·건너뛰기 줄이 아래에 붙어 있다', async () => {
  const css = await read('style.css');
  assert.match(rule(css, '.setup-themes'), /min-height: 1[5-9]\dpx/);
  assert.match(rule(css, '.setup footer'), /position: sticky; bottom: -24px/);
});

test('둘러보기의 한 칸짜리 터미널은 탭 영역을 채운다', async () => {
  const css = await read('style.css');
  assert.match(css, /\.tour \.tab-page > \.terminal-pane \{ flex: 1; \}/);
});

test('둘러보기 연습 채팅은 실제 CLI 업데이트 안내를 띄우지 않고, 마지막 카드에는 건너뛰기 안내가 없다', async () => {
  const chat = await read('ChatPane.tsx'), tour = await read('Tutorial.tsx');
  assert.match(chat, /ctx\.projectId !== 'tour' && <CliUpdateNotice/);
  assert.match(tour, /\{hero && !last && <p className="tour-skip-note">/);
  // 승인 질문 단계의 카드는 아래쪽에 놓아 터미널 출력(위에서부터 채워짐)을 가리지 않는다.
  assert.match(tour, /target\?\.includes\('\.terminal-pane'\) \? y\(H - h - 48\)/);
});

test('세션 ID 복사가 붙은 pane 제목은 padding 만큼 max-width를 늘려 짧은 제목이 잘리지 않는다', async () => {
  const css = await read('style.css');
  assert.match(rule(css, '.pane-title[data-copy]'), /margin: -1px -6px; max-width: calc\(100% \+ 12px\)/);
});

test('Git 그래프 drawer는 커밋 목록이 최소 폭을 지키고 옆 패널이 줄거나 좁은 창에서 접힌다', async () => {
  const css = await read('style.css');
  assert.match(rule(css, '.git-log'), /flex: 1 1 0; min-width: 420px/);
  assert.match(rule(css, '.git-branches'), /flex: 0 1 var\(--git-branches-w, 230px\)/);
  assert.match(rule(css, '.git-side'), /flex: 0 1 var\(--git-details-w, 400px\)/);
  assert.match(css, /@media \(max-width: 1040px\) \{ \.git-branches, \.git-branches \+ \.git-split \{ display: none; \} \}/);
  assert.match(css, /@media \(max-width: 900px\) \{ \.git-side, \.git-log \+ \.git-split \{ display: none; \} \.git-log \{ min-width: 0; \} \}/);
});

test('실행 중인 ! 셸 명령과 백그라운드 작업의 중단 버튼은 키보드로 닿고 Enter·Space로 눌린다', async () => {
  for (const [file, label] of [['ShellCard.tsx', '이 명령 중단'], ['ChatPane.tsx', '이 작업 중단']]) {
    const source = await read(file);
    const line = source.split('\n').find(text => text.includes('className="stop-task" role="button"') && text.includes(`aria-label="${label}"`));
    assert.ok(line, `${file}: ${label} 버튼`);
    assert.match(line, /tabIndex=\{0\}/);
    assert.match(line, /onKeyDown=\{event => \{ if \(event\.key === 'Enter' \|\| event\.key === ' '\)/);
  }
});

test('채팅 하단 드롭다운 summary는 키보드 포커스 때 링이 보이고, 움직임 줄이기에서는 장식 애니메이션이 멈춘다', async () => {
  const css = await read('style.css');
  assert.match(rule(css, '.chat-foot .dropdown summary:focus-visible'), /outline: 1px solid var\(--focus\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.feedback-dot::after, \.feedback-empty-mark, \.chat-send\.stop:not\(:disabled\)::before, \.mini-main b \{ animation: none; \} \}/);
});

test('처리 상태가 바뀐 피드백이 있으면 상단 피드백 버튼에 점이 붙고, 세션 통계 닫기 버튼은 오른쪽 끝에 놓인다', async () => {
  const css = await read('style.css'), workspace = await read('Workspace.tsx');
  assert.match(workspace, /progressNews\(feedback\.items\)\.length/);
  assert.match(workspace, /newsCount > 0 && <i className="feedback-dot bar-news"/);
  assert.match(rule(css, '.bar-button .feedback-dot.bar-news'), /position: absolute/);
  assert.match(css, /dialog\.chat-stats > header \.icon-button \{ margin-left: auto; \}/);
});

test('테마를 바꾸면 Monaco 색(코드 블록의 .mtk*)도 새 테마로 맞춘다', async () => {
  const main = await read('main.tsx'), editor = await read('Editor.tsx');
  assert.match(main, /root\.dataset\.theme = theme\.id; root\.dataset\.scheme = theme\.scheme; syncMonacoTheme\(theme\.id\);/);
  assert.match(editor, /export function syncMonacoTheme\(theme: Settings\['theme'\]\) \{ if \(monacoPromise\) void monacoPromise\.then\(monaco => monaco\.editor\.setTheme\(themeName\(theme\)\)/);
});

test('상태바 접기·셸 카드 안내·ui 폼 라벨·비 Git 안내·Mermaid 키보드가 소스에 남아 있다', async () => {
  const workspace = await read('Workspace.tsx'), shell = await read('ShellCard.tsx'), forms = await read('UiBlocks.tsx'), mermaid = await read('mermaid-viewer.tsx'), chat = await read('ChatPane.tsx');
  assert.match(workspace, /<StatusSlot key=\{id\} id=\{id\}>\{statusNodes\[id\]\}<\/StatusSlot>\)\}<StatusMore ids=\{foldedStatus\}/);
  assert.match(workspace, /if \(noGit\) setGitNote\(true\); else toggleGit\(\);/);
  assert.match(shell, /note && !running && item\.status !== 'error'/);
  assert.match(forms, /'입력창에 채우기'/);
  assert.match(mermaid, /onKeyDown=\{keyView\}/);
  assert.match(chat, /이미지를 5MB 아래로 줄이는 중…/);
});
