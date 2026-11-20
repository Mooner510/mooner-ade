// `!command` in the chat composer: a shell command the user typed themselves, run by the server as the local user.
// It is not an agent tool call (no approval card), it needs no agent process, and it never touches a running turn. What it printed is stored in the chat's
// events whole; only the copy handed to the agent with the next message is shortened (see shellContext).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const SHELL_TIMEOUT_MS = 10 * 60_000;
// A runaway guard, not a cap on the record: a command that prints more than this is stopped (what it printed so far is kept whole and the card says why).
export const SHELL_OUTPUT_LIMIT = 16 * 1024 * 1024;
export const SHELL_MAX_COMMAND = 20_000;
// What one run may add to the agent's next message (head and tail kept); the chat's record keeps everything.
export const SHELL_CONTEXT_CHARS = 20_000;

const baseName = file => path.basename(String(file)).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');

// The program and arguments that run `command` in `shell` ({ id, path }, as shells.js lists them) once, without a terminal.
export function shellInvocation(shell, command, platform = process.platform) {
  const file = shell.path, name = baseName(file);
  if (name === 'pwsh' || name === 'powershell') {
    // -Command alone reports 1 for any failure; the tail turns a failed native program back into its own exit code.
    const head = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;$ProgressPreference="SilentlyContinue";';
    const tail = '\nif ($?) { exit 0 } elseif ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }';
    return { file, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${head}${command}${tail}`], options: {} };
  }
  if (name === 'cmd') return { file, args: ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`], options: { windowsVerbatimArguments: true } };
  // A login shell, like the terminal's, so PATH additions from the profile are there. Not interactive: that would need a terminal.
  return { file, args: ['-lc', command], options: {} };
}

// Commands that only make sense with a keyboard and a terminal. They are not started (nothing could answer them); the terminal tab is the place.
const FULL_SCREEN = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs', 'pico', 'less', 'more', 'man', 'top', 'htop', 'btop', 'tmux', 'screen']);
const REPLS = new Set(['python', 'python3', 'node', 'irb', 'ipython', 'psql', 'mysql', 'sqlite3', 'lua', 'ruby', 'php']);
const AGENT_CLIS = new Set(['claude', 'codex', 'cursor-agent']);
const LOGIN_CLIS = new Set(['claude', 'codex', 'cursor-agent', 'gh', 'npm', 'pnpm', 'yarn', 'docker', 'aws', 'gcloud', 'az', 'vercel', 'firebase', 'heroku', 'netlify', 'wrangler', 'supabase', 'fly', 'flyctl', 'railway', 'stripe', 'gt', 'glab', 'huggingface-cli', 'hf', 'op', 'bw']);
// The words of a command, ignoring leading `VAR=value`, `sudo`, and `command`/`exec`.
const words = command => {
  const parts = String(command).trim().split(/\s+/).filter(Boolean);
  while (parts.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0]) || ['sudo', 'command', 'exec', 'env'].includes(parts[0]))) parts.shift();
  return parts;
};
// A hint (Korean, ready to show) when the command needs a terminal, else ''. Only a plain single command is judged; a pipeline or a script is let run.
export function interactiveHint(command) {
  const text = String(command).trim();
  if (!text || /[|;&<>`$()\n]/.test(text)) return '';
  const parts = words(text), first = baseName(parts[0] ?? ''), rest = parts.slice(1);
  const flags = rest.filter(item => item.startsWith('-')), plain = rest.filter(item => !item.startsWith('-'));
  let why = '';
  if (FULL_SCREEN.has(first)) why = '전체 화면 프로그램';
  else if (REPLS.has(first) && !plain.length && !flags.some(flag => ['-c', '-e', '-m', '-r', '-h', '--help', '-v', '--version', '--eval', '-p'].includes(flag))) why = '대화형 프로그램';
  else if (AGENT_CLIS.has(first) && !flags.some(flag => ['-p', '--print', '-h', '--help', '-v', '--version'].includes(flag)) && !['exec', 'mcp', 'config', 'doctor', 'update', 'install', 'logout', 'status', 'about', 'ls', 'list', 'models', 'whoami', 'auth'].includes(plain[0] ?? '') && plain.length < 2) why = plain[0] === 'login' || !plain.length ? '로그인과 대화 화면' : '';
  else if (LOGIN_CLIS.has(first) && /^(login|signin|sign-in)$/.test(plain.at(-1) ?? '') && !flags.some(flag => /token|with-token|password-stdin|api-key|key/.test(flag))) why = '로그인';
  else if (first === 'ssh' && plain.length === 1) why = '원격 셸 접속';
  return why ? `이 명령(${why})은 입력을 직접 받아야 해서 채팅에서 실행하지 않았습니다. 터미널 탭에서 실행하세요.` : '';
}

// Output that says a program wanted a terminal: the card points to the terminal tab even though the command did run.
const WANTS_TERMINAL = /a terminal is required|not a tty|stdin is not a tty|stdin is not a terminal|input device is not a tty|must be run (?:in|from) a terminal|raw mode is not supported|requires an interactive|no tty present|Inappropriate ioctl for device|Please enter your password|Password:\s*$/im;
export const wantsTerminal = (stdout, stderr) => WANTS_TERMINAL.test(`${stderr}\n${stdout}`);

// Ends the process and everything it started. A shell's children keep running when only the shell is killed.
function killTree(child, platform, spawnProcess) {
  if (!child.pid) return;
  if (platform === 'win32') { try { spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch { child.kill(); } return; }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
}

/**
 * Runs `command` once and resolves (never rejects) with { status, exitCode, signal, ms, stdout, stderr }.
 * status: done (exit 0), failed (any other exit), stopped (`signal` aborted), timeout, limit (printed more than `outputLimit`), error (could not start).
 * `onOutput(stream, text)` gets output as it arrives. stdin is closed, there is no terminal.
 */
export function runShell({ command, cwd, env = process.env, shell, timeoutMs = SHELL_TIMEOUT_MS, outputLimit = SHELL_OUTPUT_LIMIT, onOutput, signal, platform = process.platform, spawnProcess = spawn }) {
  return new Promise(resolve => {
    const started = Date.now(), out = { stdout: '', stderr: '' }, decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let total = 0, reason = null, settled = false, child, timer, graceTimer;
    const finish = (extra = {}) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(graceTimer); signal?.removeEventListener('abort', onAbort);
      for (const stream of ['stdout', 'stderr']) { const rest = decoders[stream].end(); if (rest) { out[stream] += rest; onOutput?.(stream, rest); } }
      const exitCode = extra.exitCode ?? null, status = extra.status ?? reason ?? (exitCode === 0 ? 'done' : 'failed');
      resolve({ status, exitCode, signal: extra.signal ?? null, ms: Date.now() - started, stdout: out.stdout, stderr: out.stderr, ...(extra.error && { error: extra.error }) });
    };
    const stop = why => { if (reason || settled) return; reason = why; if (child) killTree(child, platform, spawnProcess); };
    function onAbort() { stop('stopped'); }
    const { file, args, options } = shellInvocation(shell, command, platform);
    // Colour, pagers and prompts make no sense without a terminal; git must not wait for a password it cannot be given.
    const launchEnv = { ...env, TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' };
    try {
      child = spawnProcess(file, args, { cwd, env: launchEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: platform !== 'win32', ...options });
    } catch (error) { finish({ status: 'error', error: error.message }); return; }
    child.on('error', error => finish({ status: 'error', error: error.message }));
    for (const stream of ['stdout', 'stderr']) child[stream]?.on('data', chunk => {
      total += chunk.length;
      const text = decoders[stream].write(chunk);
      if (text) { out[stream] += text; onOutput?.(stream, text); }
      if (total > outputLimit) stop('limit');
    });
    // `close` waits for every holder of the pipes (a background job the command started keeps them open): after the shell itself is gone only a moment more is given.
    child.on('exit', (code, sig) => { graceTimer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish({ exitCode: code, signal: sig }); }, 500); });
    child.on('close', (code, sig) => finish({ exitCode: code, signal: sig }));
    if (timeoutMs > 0) timer = setTimeout(() => stop('timeout'), timeoutMs);
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  });
}

const clipMiddle = (text, max) => text.length <= max ? text : `${text.slice(0, Math.floor(max / 2))}\n… (가운데 ${text.length - max}자는 에이전트에게 보내는 사본에서만 생략했습니다. 채팅 기록에는 전부 남아 있습니다) …\n${text.slice(-Math.floor(max / 2))}`;
const STATUS_WORDS = { done: '', failed: '', stopped: '사용자가 중단함', timeout: '시간 초과로 중단됨', limit: '출력이 너무 많아 중단됨', interrupted: '앱이 종료되어 중단됨', error: '실행하지 못함' };
/**
 * The text that goes ahead of the user's next message so the agent knows what they ran themselves.
 * `runs`: the shell events of those runs ({ command, cwd, stdout, stderr, exitCode, status }). Shaped like the tags Claude Code writes for its own `!` mode.
 */
export function shellContext(runs) {
  if (!runs.length) return '';
  const blocks = runs.map(run => {
    const note = STATUS_WORDS[run.status] ?? '', code = run.exitCode == null ? '' : ` (exit code ${run.exitCode})`;
    return [`<bash-input>${run.command}</bash-input>`, `<bash-stdout>${clipMiddle(run.stdout ?? '', SHELL_CONTEXT_CHARS)}</bash-stdout>`, `<bash-stderr>${clipMiddle(run.stderr ?? '', SHELL_CONTEXT_CHARS)}</bash-stderr>`,
      ...(note || code ? [`<bash-status>${note}${code}</bash-status>`] : [])].join('\n');
  });
  return `<local-command-caveat>The user ran the following shell commands themselves in the chat input (the "!" prefix). You did not run them and need not respond to them unless the user asks about them in their message below. Their output is for your context.</local-command-caveat>\n${blocks.join('\n')}\n\n`;
}

// Shell runs that finished but were not yet handed to the agent: from the events since the last /clear, minus the ones a later `sent` event named.
export function pendingShellRuns(events) {
  const since = events.findLastIndex(event => event.kind === 'divider'), runs = new Map(), sent = new Set(), skipped = new Set();
  for (const event of since >= 0 ? events.slice(since + 1) : events) {
    if (event.kind !== 'shell') continue;
    if (event.phase === 'start') runs.set(event.id, { command: event.command, cwd: event.cwd });
    else if (event.phase === 'end') { if (runs.has(event.id)) runs.set(event.id, { ...runs.get(event.id), ...event }); }
    else if (event.phase === 'skip') { if (event.on) skipped.add(event.id); else skipped.delete(event.id); } // the user's "이 메시지는 제외하기" toggle
    else if (event.phase === 'sent') for (const id of event.ids ?? []) sent.add(id);
  }
  return [...runs].filter(([id, run]) => run.phase === 'end' && !sent.has(id) && !skipped.has(id) && run.status !== 'error').map(([id, run]) => ({ id, ...run }));
}
