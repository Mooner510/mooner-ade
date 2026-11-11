import { spawnAgent } from './agent-spawn.js';
import { fault } from './files.js';

export const isCursorSummarizeCommand = text => /^\/(compact|compress|summarize)(?:\s|$)/.test(String(text ?? '').trim());

export function runCursorSummarize({ executable, executableArgs = [], sessionId, cwd, env = {}, spawnProcess = spawnAgent, timeoutMs = 600_000 }) {
  if (!sessionId) throw fault('CHAT_UNSUPPORTED', '세션이 없어 컨텍스트를 압축할 수 없습니다.', 409);
  return new Promise((resolve, reject) => {
    const args = [...executableArgs, '--resume', sessionId, '--print', '-p', '/summarize', '--output-format', 'text'];
    let stdout = '', stderr = '', done = false;
    let proc;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc?.kill(); } catch {}
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, fault('AGENT_TIMEOUT', '컨텍스트 압축 시간이 초과되었습니다.', 504)), timeoutMs);
    try {
      proc = spawnProcess(executable, args, {
        cwd,
        env: { ...process.env, ...(typeof env === 'function' ? env() : env), NO_COLOR: '1' },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return finish(reject, fault('AGENT_UNAVAILABLE', 'cursor-agent를 시작하지 못했습니다.', 503));
    }
    proc.stdout?.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) stdout = stdout.slice(0, 2_000_000); });
    proc.stderr?.on('data', chunk => { stderr += chunk; if (stderr.length > 65_536) stderr = stderr.slice(0, 65_536); });
    proc.on('error', error => finish(reject, fault('AGENT_UNAVAILABLE', error.message, 503)));
    proc.on('close', code => {
      if (code !== 0) finish(reject, fault('AGENT_PROTOCOL', stderr.trim() || `컨텍스트 압축이 실패했습니다 (${code}).`, 502));
      else finish(resolve, stdout);
    });
  });
}

export function cleanCursorSummarizeOutput(text) {
  return String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/^[^\n]*cursor-retrieval:.*\n?/m, '').trim();
}
