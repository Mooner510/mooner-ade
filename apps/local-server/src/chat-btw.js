// /btw: a side question answered from the chat's conversation without touching it. A separate one-shot CLI run per agent (so it also works while a turn is
// running, and the question and answer never enter the chat's history), always on the cheap model:
//   claude  resumes the session as a fork (`--fork-session` + `--no-session-persistence`), no tools
//   codex   `codex exec fork --ephemeral` of the thread, read-only
//   cursor  has no fork (`--resume` would write into the real chat), so a fresh `--mode ask` run gets the conversation as text in the prompt

import { fault } from './files.js';
import { LOGIN_HINT, loginProblem } from './feedback-agent.js';
import { spawnAgent } from './agent-spawn.js';

/** What /btw runs on unless told otherwise: Haiku 5.5 · low, GPT-6 Luna · low, Composer 2.5 without Fast. */
export const BTW_DEFAULTS = {
  claude: { model: 'claude-haiku-5-5', effort: 'low' },
  codex: { model: 'gpt-6-luna', effort: 'low' },
  cursor: { model: 'composer-2.5[fast=false]', effort: '' }
};
export const BTW_AGENTS = Object.keys(BTW_DEFAULTS);

export const BTW_RULE = [
  '[/btw 곁다리 질문] 지금까지의 대화를 참고하되, 아래 질문에만 답하세요.',
  '- 도구는 쓸 수 없고 진행 중이던 작업을 이어 가지도 않습니다. 파일을 읽거나 명령을 실행하지 말고, 대화 내용과 이미 아는 지식만으로 답하세요.',
  '- 짧고 정확하게 답하고, 대화에 근거가 없으면 모른다고 말하세요.',
  '- 질문과 같은 언어로 답하세요.'
].join('\n');

const DIGEST_CHARS = 14_000;
// Cursor only: the conversation as plain text (newest end kept), from the events ADE stores for the chat. Tool calls and thinking are left out.
export function conversationDigest(events = [], max = DIGEST_CHARS) {
  const lines = [];
  for (const event of events) {
    if (event?.kind === 'divider') lines.length = 0; // /clear: what came before is no longer the conversation
    else if (event?.kind === 'user' && typeof event.text === 'string' && event.text.trim() && !event.text.trim().startsWith('/')) lines.push(`사용자: ${event.text.trim()}`);
    else if (event?.kind === 'message' && !event.parentToolUseId) {
      const text = (event.blocks ?? []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text.trim()).filter(Boolean).join('\n');
      if (text) lines.push(`에이전트: ${text}`);
    }
  }
  let out = lines.join('\n\n');
  if (out.length > max) out = `…(앞부분 생략)\n${out.slice(out.length - max)}`;
  return out;
}

export const btwPrompt = (question, digest = '') => `${BTW_RULE}\n\n${digest ? `지금까지의 대화:\n"""\n${digest}\n"""\n\n` : ''}질문:\n${String(question).trim()}`;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// { args, input }: input is what goes to stdin (null: the prompt is in the arguments).
export function buildBtwCommand({ agent, sessionId, model, effort, prompt }) {
  const base = BTW_DEFAULTS[agent];
  if (!base) throw fault('CHAT_UNSUPPORTED', '이 에이전트는 /btw를 지원하지 않습니다.', 409);
  const useModel = model || base.model, useEffort = effort === undefined ? base.effort : effort;
  if (agent === 'claude') {
    // `--strict-mcp-config` with no servers and `--disable-slash-commands` keep the start short (the run needs neither); no tools at all (`--tools ""`).
    return { input: prompt, args: [...(sessionId ? ['--resume', sessionId, '--fork-session'] : []), '--model', useModel, ...(useEffort ? ['--effort', useEffort] : []), '-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-session-persistence'] };
  }
  if (agent === 'codex') {
    const common = ['-m', useModel, ...(useEffort ? ['-c', `model_reasoning_effort="${useEffort}"`] : []), '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '--ephemeral', '--skip-git-repo-check'];
    // The prompt is read from stdin (`-`), so the question is never an option.
    return { input: prompt, args: ['exec', ...(sessionId ? ['fork', sessionId] : []), ...common, '-'] };
  }
  return { input: null, args: ['-p', '--mode', 'ask', '--trust', '--model', useModel, '--output-format', 'text', '--', prompt] };
}

const loginText = value => loginProblem(value) || /not logged in|log in|authenticat|login required/i.test(value);
export function parseBtwOutput(agent, stdout) {
  if (agent === 'claude') {
    let value = null;
    try { value = JSON.parse(stdout); } catch { return null; }
    const usage = value.usage;
    return { ok: !value.is_error && typeof value.result === 'string', text: String(value.result ?? ''), costUsd: Number.isFinite(value.total_cost_usd) ? value.total_cost_usd : null,
      ...(usage && { tokens: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheCreate: usage.cache_creation_input_tokens ?? 0 } }) };
  }
  return { ok: true, text: stdout.replace(ANSI, '').replace(/^[^\n]*cursor-retrieval:.*\n?/m, '').trim(), costUsd: null };
}

export function runBtw({ agent = 'claude', executable = agent === 'cursor' ? 'cursor-agent' : agent, executableArgs = [], sessionId, model, effort, question, digest = '', cwd, env = {}, spawnProcess = spawnAgent, timeoutMs = 120_000, signal }) {
  const { args: own, input } = buildBtwCommand({ agent, sessionId, model, effort, prompt: btwPrompt(question, agent === 'cursor' ? digest : '') });
  const args = [...executableArgs, ...own];
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', done = false, proc;
    const finish = (fn, value) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      try { proc?.kill(); } catch { /* already gone */ }
      fn(value);
    };
    const onAbort = () => finish(reject, fault('CANCELLED', '질문을 취소했습니다.', 499));
    const timer = setTimeout(() => finish(reject, fault('AGENT_TIMEOUT', '답을 기다리다 시간이 초과되었습니다.', 504)), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      proc = spawnProcess(executable, args, { cwd, env: { ...process.env, ...(typeof env === 'function' ? env() : env), NO_COLOR: '1' }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return finish(reject, fault('AGENT_UNAVAILABLE', `${executable} 명령을 시작하지 못했습니다. 설치와 로그인을 확인하세요.`, 503));
    }
    const settle = code => {
      const parsed = parseBtwOutput(agent, stdout), detail = `${parsed?.ok === false ? parsed.text : parsed ? '' : stdout.slice(0, 2000)} ${stderr}`.trim(); // a CLI error can arrive as plain text instead of the JSON
      if (!parsed || !parsed.ok || code !== 0 || !parsed.text.trim()) {
        const login = loginText(detail);
        const message = login ? (agent === 'claude' ? LOGIN_HINT : `${executable} 로그인이 필요합니다. 터미널에서 로그인한 뒤 다시 시도하세요.`)
          : /no conversation found|session.*not found|no rollout|not found.*session/i.test(detail) ? '이 대화의 기록을 찾지 못해 질문할 수 없습니다. 메시지를 한 번 보낸 뒤 다시 시도하세요.'
          : /prompt is too long|context.*(?:length|window|limit)|too many tokens/i.test(detail) ? '대화가 길어서 /btw 모델의 컨텍스트에 들어가지 않습니다. 먼저 /compact로 줄이세요.'
          : (detail || (code === 0 ? 'AI가 빈 답을 보냈습니다.' : `답을 받지 못했습니다 (${code}).`)).slice(0, 500);
        return finish(reject, fault(login ? 'AGENT_LOGIN' : 'AGENT_PROTOCOL', message, login ? 401 : 502));
      }
      finish(resolve, { answer: parsed.text.trim(), costUsd: parsed.costUsd, ...(parsed.tokens && { tokens: parsed.tokens }) });
    };
    // Claude's JSON is taken as soon as it parses (the CLI lingers ~2s after printing it); the others print plain text and are read to the end.
    proc.stdout?.on('data', chunk => {
      stdout += chunk; if (stdout.length > 2_000_000) stdout = stdout.slice(0, 2_000_000);
      if (agent === 'claude' && !done && stdout.trimEnd().endsWith('}')) { try { JSON.parse(stdout); } catch { return; } settle(0); }
    });
    proc.stderr?.on('data', chunk => { stderr += chunk; if (stderr.length > 65_536) stderr = stderr.slice(-65_536); });
    proc.on('error', error => finish(reject, fault('AGENT_UNAVAILABLE', error.code === 'ENOENT' ? `${executable} 명령을 찾지 못했습니다. 설치하세요.` : error.message, 503)));
    proc.on('close', settle);
    proc.stdin?.on('error', () => {});
    proc.stdin?.end(input ?? undefined);
  });
}
