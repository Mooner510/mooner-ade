// Chat 모드 UI 블록(```ui / ```ade-ui) 사용량을 채팅 기록(events.jsonl)에서 집계한다. 지침(chat-ui-prompt.js) 변경 전후 비교용. 가이드: GUIDE.md(같은 폴더)
// 사용: node docs/tests/261113_1356_UI블록사용기준/audit.mjs [--since 2026-11-13T15:00] [--list]
//   --since  이 시각 이전/이후로 턴을 나눠 비교한다(턴의 첫 답변 시각 기준. 재개한 채팅도 새 지침을 받으므로 채팅 생성 시각이 아니라 턴 시각으로 나눈다)
//   --list   질문으로 끝난 턴의 끝부분과 분류를 출력한다(분류는 휴리스틱이라 사람이 검토한다)
// 읽기만 한다. 데이터 위치: ADE_DATA_DIR, 없으면 앱 기본 위치.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] ?? ''; };
const since = arg('--since') ? Date.parse(arg('--since')) : undefined, list = process.argv.includes('--list');
if (since !== undefined && Number.isNaN(since)) { console.error('--since 시각을 읽지 못했습니다'); process.exit(1); }
const root = process.env.ADE_DATA_DIR || path.join(process.platform === 'win32' ? process.env.LOCALAPPDATA || os.homedir() : path.join(os.homedir(), 'Library', 'Application Support'), 'mooner-ade');
const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d => {
  const chat = path.join(root, d.name, 'chat'); return fs.existsSync(chat) ? fs.readdirSync(chat).map(id => path.join(chat, id)) : [];
});

// 한 턴 = 사용자 메시지(또는 result) 사이의 최상위 어시스턴트 텍스트. 포크는 같은 이벤트를 복사하므로 첫 메시지 uuid로 중복을 없앤다.
const seen = new Set(), turns = [];
for (const dir of dirs) {
  let meta; try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { continue; }
  if (meta.interactiveUi !== true || !fs.existsSync(path.join(dir, 'events.jsonl'))) continue;
  let cur = null;
  const flush = () => { if (cur?.text.trim() && !seen.has(cur.key)) { seen.add(cur.key); turns.push(cur); } cur = null; };
  for (const line of fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.kind === 'user' || e.kind === 'result') { flush(); continue; }
    const start = () => (cur ??= { agent: meta.agent, chat: path.basename(dir).slice(0, 8), key: e.uuid ?? `${dir}:${e.seq}`, at: e.at, text: '', asks: 0 });
    if (e.kind === 'approval' && e.phase === 'request' && e.input?.questions) start().asks++; // Codex·Cursor 질문 카드
    if (e.kind !== 'message' || e.role !== 'assistant' || e.parentToolUseId) continue;
    for (const b of e.blocks ?? []) {
      if (b.type === 'text' && b.text?.trim()) start().text += b.text + '\n';
      if (b.type === 'tool_use' && b.name === 'AskUserQuestion') start().asks++;
    }
  }
  flush();
}

// 이 기능 자체를 개발하며 형식을 예시로 든 턴은 실사용이 아니므로 뺀다.
const SELF = /ui-spec|UI_PROMPT|chat-ui-prompt|UiBlocks|parseUi/;
const fences = text => [...text.matchAll(/```(ui|ade-ui)\n([\s\S]*?)```/g)].map(([, lang, body]) => {
  if (lang === 'ade-ui') return ['ade-ui'];
  try { const j = JSON.parse(body), all = Array.isArray(j) && typeof j[0] === 'string' ? [j] : j; return all.map(c => Array.isArray(c) ? String(c[0]) : '?'); } catch { return ['깨짐']; }
}).flat();
// 끝 120자로 질문 종류를 가른다: 선택(번호·"어느 쪽"·두 질문), 제안("필요하면 말씀해"), 예/아니오(나머지 물음).
const ending = text => {
  const tail = text.trim().slice(-120);
  if (!/\?|까요|할지|원하시면|말씀해|알려 주세요/.test(tail)) return null;
  if (/어느 쪽|어느 항목|중 어느|중에서|둘 중|아니면|번호로|\d+(~\d+)?번|켬|옵트인/.test(tail) || (tail.match(/\?/g) ?? []).length >= 2) return 'choice';
  if (/필요하(면|시면)|원하시면|말씀해/.test(tail)) return 'offer';
  return 'yesno';
};

const stat = () => ({ 턴: 0, 'UI 턴': 0, form: 0, stats: 0, chart: 0, steps: 0, 'ade-ui': 0, 깨짐: 0, 표: 0, 질문도구: 0, '선택 질문': 0, '선택+form': 0, '예/아니오': 0, '예/아니오+form': 0, 제안: 0, '제안+form': 0, 제외: 0 });
// 에이전트(claude/codex)와 기간별로 나눈다. 제공자마다 다른 지침이 필요한지는 이 줄들이 갈라질 때만 판단한다.
const groups = {};
for (const t of turns) {
  const period = since === undefined ? '전체' : t.at < since ? '이전' : '이후', g = (groups[`${t.agent} ${period}`] ??= stat());
  if (SELF.test(t.text)) { g.제외++; continue; }
  const kinds = fences(t.text), form = kinds.includes('form') || kinds.includes('draft'), end = ending(t.text.replace(/```[\s\S]*?```/g, ''));
  g.턴++; if (kinds.length) g['UI 턴']++;
  for (const k of kinds) { const key = k === 'draft' ? 'form' : k; if (key in g) g[key]++; }
  if (/^\|.*\|\s*$\n^\|[-: |]+\|/m.test(t.text)) g.표++;
  g.질문도구 += t.asks;
  const label = { choice: '선택 질문', yesno: '예/아니오', offer: '제안' }[end];
  if (label) { g[label]++; if (form) g[`${label}+form`]++; }
  if (list) for (const [, body] of t.text.matchAll(/```ui\n(\["chart"[\s\S]*?|\[\["chart"[\s\S]*?)```/g)) console.log(`[chart] ${t.chat} ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
  if (list && (label || form)) console.log(`[${period}] ${t.agent} ${t.chat} ${label ?? '-'}${form ? ' +form' : ''} | ${t.text.trim().slice(-110).replace(/\s+/g, ' ')}`);
}
console.table(groups);
console.log('목표: 선택 질문은 대부분 +form, 예/아니오·제안의 +form은 0에 가깝게, 깨짐 0. chart의 단위 혼용은 --list의 [chart] 줄을 보고 사람이 판정한다.');
