// claude.ai 커넥터를 실행 중에 켤 수 있는지 확인하는 프로브. 가이드: GUIDE.md(같은 폴더)
// 사용: node docs/tests/261113_1311_커넥터토글확인/probe.mjs [--ask]   (--ask: 마지막에 haiku 턴 1회, 사용량 소모)
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const ask = process.argv.includes('--ask');
const settings = JSON.stringify({ disableClaudeAiConnectors: true });
const child = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--model', 'haiku', '--effort', 'low', '--settings', settings], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, NO_COLOR: '1' } });
const waiting = new Map(); let seq = 0;
createInterface({ input: child.stdout }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_response') waiting.get(m.response?.request_id)?.(m.response);
  else if (m.type === 'system' && m.subtype === 'init') console.log('[init] mcp_servers =', JSON.stringify(m.mcp_servers), '\n       tools(mcp__claude_ai*) =', (m.tools ?? []).filter((t) => t.startsWith('mcp__claude_ai')).length);
  else if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'text') console.log('[assistant]', b.text);
  else if (m.type === 'result') { console.log('[result] turns=%s cost=%s', m.num_turns, m.total_cost_usd); child.stdin.end(); }
});
const control = (request, ms = 15000) => new Promise((resolve) => {
  const id = `probe-${++seq}`; const t = setTimeout(() => resolve({ subtype: 'timeout' }), ms);
  waiting.set(id, (r) => { clearTimeout(t); resolve(r); });
  child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
});
const step = async (name, request) => { const r = await control(request); console.log(`\n== ${name}\n`, JSON.stringify(r, null, 1).slice(0, 1800)); };
await step('1. 시작 직후 mcp_status (커넥터가 없어야 함)', { subtype: 'mcp_status' });
await step('2a. apply_flag_settings: 커넥터 차단 해제', { subtype: 'apply_flag_settings', settings: { disableClaudeAiConnectors: false } });
await step('2b. mcp_status', { subtype: 'mcp_status' });
await step('2c. reload_plugins', { subtype: 'reload_plugins' });
await step('2d. mcp_status (여기서 claude.ai 항목이 보이면 B 가능)', { subtype: 'mcp_status' });
if (ask) {
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '사용 가능한 mcp__claude_ai_Meetings 도구 이름만 나열해. 호출은 하지 마.' } }) + '\n');
} else child.stdin.end();
