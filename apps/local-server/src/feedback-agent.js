// "AI 초안" in the feedback inbox: one `claude -p` run that looks at the draft's screenshots and the person's note and writes an
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
    (title || body.trim()) && `지금까지 쓴 초안:\n제목: ${title}\n${body}`,
    context && `ADE 상태 정보:\n${context}`,
    [
      '결과는 다른 말 없이 JSON 한 개로만 답하세요: {"title": "...", "body": "..."}',
      '- title: 120자 이하 한국어 한 줄 요약',
      '- body: 한국어 마크다운. 다음 절을 이 순서로: "## 문제", "## 기대 동작", "## 개선 제안", 필요하면 "## 재현 방법". 스크린샷은 "스크린샷 1"처럼 번호로 가리키세요.'
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
export function runFeedbackDraft({ executable = 'claude', executableArgs = [], cwd, images, title, body, note, context, env = {}, spawnProcess = spawn, timeoutMs = 300_000 }) {
  const prompt = feedbackPrompt({ images, title, body, note, context });
  return new Promise((resolve, reject) => {
    // Only Read: the run looks at the screenshots and answers; it cannot edit or run anything.
    const args = [...executableArgs, '-p', '--output-format', 'json', '--allowedTools', 'Read', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch'];
    let stdout = '', stderr = '', done = false, proc;
    const finish = (fn, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { proc?.kill(); } catch { /* already gone */ }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, fault('AGENT_TIMEOUT', 'AI 초안 시간이 초과되었습니다.', 504)), timeoutMs);
    try {
      proc = spawnProcess(executable, args, { cwd, env: { ...process.env, ...(typeof env === 'function' ? env() : env), NO_COLOR: '1' }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return finish(reject, fault('AGENT_UNAVAILABLE', 'claude 명령을 시작하지 못했습니다. Claude Code 설치와 로그인을 확인하세요.', 503));
    }
    proc.stdout?.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) stdout = stdout.slice(0, 2_000_000); });
    proc.stderr?.on('data', chunk => { stderr += chunk; if (stderr.length > 65_536) stderr = stderr.slice(-65_536); });
    proc.on('error', error => finish(reject, fault('AGENT_UNAVAILABLE', error.code === 'ENOENT' ? 'claude 명령을 찾지 못했습니다. Claude Code를 설치하세요.' : error.message, 503)));
    proc.on('close', code => {
      let result = null;
      try { const value = JSON.parse(stdout); result = value?.is_error ? null : value?.result; if (value?.is_error) stderr = String(value.result ?? stderr); } catch { /* not JSON */ }
      if (code !== 0 || typeof result !== 'string') return finish(reject, fault('AGENT_PROTOCOL', (stderr.trim() || `AI 초안을 만들지 못했습니다 (${code}).`).slice(0, 500), 502));
      try { finish(resolve, parseFeedbackDraft(result)); } catch (error) { finish(reject, error); }
    });
    // The prompt goes in on stdin: it holds the user's note, which must never be read as an option.
    proc.stdin?.on('error', () => {});
    proc.stdin?.end(prompt);
  });
}
