// "AI로 정리" in the feedback requests: one `claude -p` run that looks at the draft's screenshots and the person's note and writes an
// improvement request for MoonerADE's developer. The result is only a draft: a person reviews it before it can be submitted.
import { spawn } from 'node:child_process';
import { fault } from './files.js';

export function feedbackPrompt({ images = [], title = '', body = '', note = '', context = '' }) {
  return [
    '당신은 MoonerADE(AI 에이전트용 데스크톱 개발 환경) 사용자의 피드백을 개발자에게 전달할 개선 요청서로 정리합니다.',
    '아래 스크린샷 파일을 Read 도구로 직접 열어 보고, 화면에서 보이는 문제와 개선 방향을 구체적으로 적으세요.',
    '스크린샷에 보이는 코드·비밀값·개인 정보는 옮겨 적지 마세요. 추측은 추측이라고 밝히세요.',
    images.length ? `스크린샷(순서대로 1번부터):\n${images.map((file, index) => `${index + 1}. ${file}`).join('\n')}` : '스크린샷은 없습니다.',
    note && `사용자 메모:\n${note}`,
    (title || body.trim()) && `사용자가 적은 요건(초안):\n${title ? `제목: ${title}\n` : ''}${body}`,
    context && `ADE 상태 정보:\n${context}`,
    [
      '결과는 다른 말 없이 JSON 한 개로만 답하세요: {"title": "...", "body": "..."}',
      '- title: 60자 이하 한국어 한 줄 요약',
      // Output length is the run's main cost (~1000 tokens took ~6s of a 9s run), so the answer is kept short on purpose.
      '- body: 한국어 마크다운, 전체 400자 이내로 짧게. 다음 절을 이 순서로: "## 문제"(1~2문장), "## 기대 동작"(1문장), "## 개선 제안"(불릿 최대 3개). 재현 순서가 분명할 때만 "## 재현 방법"(최대 3단계)을 더하세요. 스크린샷은 "스크린샷 1"처럼 번호로 가리키세요.',
      '- 서론·맺음말·같은 말의 반복은 쓰지 마세요. 사용자 메모에 없는 내용을 지어내지 마세요.'
    ].join('\n')
  ].filter(Boolean).join('\n\n');
}

// Takes the model's answer apart; a reply that is not the asked-for JSON becomes the body as it is.
export function parseFeedbackDraft(text) {
  const raw = String(text ?? '').trim();
  const candidates = [raw, /```(?:json)?\s*([\s\S]*?)```/.exec(raw)?.[1], raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value.body === 'string' && value.body.trim()) return { title: typeof value.title === 'string' ? value.title.trim() : '', body: value.body.trim() };
    } catch { /* next candidate */ }
  }
  if (!raw) throw fault('AGENT_PROTOCOL', 'AI가 빈 답을 보냈습니다.', 502);
  return { title: '', body: raw };
}

// `claude -p --output-format json` prints one object whose `result` is the final answer.
// `model` is a Claude Code model id, `effort` a `--effort` level (low or medium); the caller (index.js) falls back to Haiku 5.5 + low.
export const FEEDBACK_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'sonnet', 'opus'];
export const FEEDBACK_EFFORTS = ['low', 'medium']; // Effort stops at Medium for feedback
// Startup, not the model, is what makes a draft slow: a plain `claude -p` also boots every MCP server, skill and project setting the user has (one-line answer on a dev Mac: 10-21s
// that way, ~5-6s without them; `--bare` would be cleaner still but never reads the OAuth login, only ANTHROPIC_API_KEY, so it is not used). This run needs none of it. `--setting-sources user` still reads the user's own settings (login, proxy, env).
const ISOLATED = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'user', '--disable-slash-commands', '--no-session-persistence'];
// Only "AI로 정리" needs a Claude Code login; submitting never does (it goes anonymously when nobody is signed in), so the message says so.
export const loginProblem = text => /not logged in|please run \/login|invalid api key|authentication_error|oauth token has expired/i.test(String(text ?? ''));
export const LOGIN_HINT = 'AI 정리는 Claude Code 로그인이 필요합니다. 터미널에서 claude를 실행해 로그인한 뒤 다시 시도하세요. 제출은 로그인 없이도 할 수 있으니, 직접 쓴 내용을 그대로 제출해도 됩니다.';
export function runFeedbackDraft({ executable = 'claude', executableArgs = [], model = '', effort = '', cwd, images, title, body, note, context, env = {}, spawnProcess = spawn, timeoutMs = 120_000 }) {
  const prompt = feedbackPrompt({ images, title, body, note, context });
  return new Promise((resolve, reject) => {
    // Only Read: the run looks at the screenshots and answers; it cannot edit or run anything.
    const args = [...executableArgs, ...(FEEDBACK_MODELS.includes(model) ? ['--model', model] : []), ...(FEEDBACK_EFFORTS.includes(effort) ? ['--effort', effort] : []), '-p', '--output-format', 'json', '--allowedTools', 'Read', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch', ...ISOLATED];
    let stdout = '', stderr = '', done = false, proc;
    const finish = (fn, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { proc?.kill(); } catch { /* already gone */ }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, fault('AGENT_TIMEOUT', 'AI 정리 시간이 초과되었습니다.', 504)), timeoutMs);
    try {
      proc = spawnProcess(executable, args, { cwd, env: { ...process.env, ...(typeof env === 'function' ? env() : env), NO_COLOR: '1' }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return finish(reject, fault('AGENT_UNAVAILABLE', 'claude 명령을 시작하지 못했습니다. Claude Code 설치와 로그인을 확인하세요.', 503));
    }
    // `claude -p` prints its one JSON answer and then lingers ~2s shutting down (measured), so the answer is taken as soon as it parses instead of at exit.
    const settle = code => {
      let result = null;
      try { const value = JSON.parse(stdout); result = value?.is_error ? null : value?.result; if (value?.is_error) stderr = String(value.result ?? stderr); } catch { /* not JSON */ }
      if (code !== 0 || typeof result !== 'string') return finish(reject, fault(loginProblem(stderr) ? 'AGENT_LOGIN' : 'AGENT_PROTOCOL', loginProblem(stderr) ? LOGIN_HINT : (stderr.trim() || `AI 정리를 하지 못했습니다 (${code}).`).slice(0, 500), loginProblem(stderr) ? 401 : 502));
      try { finish(resolve, parseFeedbackDraft(result)); } catch (error) { finish(reject, error); }
    };
    proc.stdout?.on('data', chunk => {
      stdout += chunk; if (stdout.length > 2_000_000) stdout = stdout.slice(0, 2_000_000);
      if (!done && stdout.trimEnd().endsWith('}')) { try { JSON.parse(stdout); } catch { return; } settle(0); }
    });
    proc.stderr?.on('data', chunk => { stderr += chunk; if (stderr.length > 65_536) stderr = stderr.slice(-65_536); });
    proc.on('error', error => finish(reject, fault('AGENT_UNAVAILABLE', error.code === 'ENOENT' ? 'claude 명령을 찾지 못했습니다. Claude Code를 설치하세요.' : error.message, 503)));
    proc.on('close', settle);
    // The prompt goes in on stdin: it holds the user's note, which must never be read as an option.
    proc.stdin?.on('error', () => {});
    proc.stdin?.end(prompt);
  });
}
