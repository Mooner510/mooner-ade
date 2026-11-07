import { spawn } from 'node:child_process';
import path from 'node:path';
import { cacheFromText } from './claude-cache.js';
import { sshRunCommand } from './ssh-upload.js';

// A Claude Code running over ssh keeps the same files as a local one on its own host: sessions/<pid>.json (cwd, session id and
// whether it is `busy` or `idle`) and the conversation transcript the cache timer reads. They are fetched with one non-interactive
// ssh call per poll, using the terminal's own ssh setup, so neither needs the terminal to carry OSC reports (tmux drops them) and
// nothing has to be configured on the remote host.
// shortcut: reads Claude Code's own files (see claude-cache.js); POSIX hosts only, and a host that needs a password or a prompt just yields nothing.
const TAIL = 2 * 1024 * 1024;
const quote = value => `'${String(value).replaceAll("'", `'\\''`)}'`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Lists the live sessions and, when one is already followed, the new bytes of its transcript.
export function remoteScript({ dir, sessionId, cwd, offset = -1 } = {}) {
  const lines = [
    'for d in "${CLAUDE_CONFIG_DIR:-}" "$HOME/.claude" "$HOME/.config/claude"; do',
    '  [ -n "$d" ] && [ -d "$d/sessions" ] || continue',
    '  for f in "$d"/sessions/*.json; do',
    '    [ -f "$f" ] || continue',
    '    pid=$(basename "$f" .json); kill -0 "$pid" 2>/dev/null || continue',
    '    printf \'@@SESSION %s\\n\' "$d"; cat "$f"; printf \'\\n\'',
    '  done',
    'done'
  ];
  if (dir && uuid.test(sessionId ?? '')) lines.push(
    `d=${quote(dir)}; f="$d/projects/$(printf %s ${quote(cwd ?? '')} | sed 's/[^a-zA-Z0-9]/-/g')/${sessionId}.jsonl"`,
    `[ -f "$f" ] || f=$(ls "$d"/projects/*/${sessionId}.jsonl 2>/dev/null | head -n 1)`,
    'if [ -n "$f" ] && [ -f "$f" ]; then',
    '  size=$(wc -c < "$f" | tr -d " ")',
    `  offset=${Math.trunc(offset)}`,
    `  if [ "$offset" -lt 0 ] || [ "$offset" -gt "$size" ] || [ $((size - offset)) -gt ${TAIL} ]; then offset=$((size > ${TAIL} ? size - ${TAIL} : 0)); fi`,
    '  printf \'@@TRANSCRIPT %s %s\\n\' "$offset" "$size"',
    '  tail -c +$((offset + 1)) "$f"',
    'fi'
  );
  return lines.join('\n') + '\n';
}

// Splits the script's output into live sessions and the transcript bytes (kept as bytes: the offset counts bytes).
export function parseRemote(output) {
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output), marker = buffer.indexOf('@@TRANSCRIPT ');
  const head = (marker < 0 ? buffer : buffer.subarray(0, marker)).toString('utf8'), sessions = [];
  for (const block of head.split('@@SESSION ').slice(1)) {
    const newline = block.indexOf('\n');
    try { sessions.push({ dir: block.slice(0, newline).trim(), ...JSON.parse(block.slice(newline + 1)) }); } catch { /* a file being rewritten */ }
  }
  let transcript = null;
  if (marker >= 0) {
    const end = buffer.indexOf(10, marker), [offset, size] = buffer.subarray(marker + 13, end).toString().split(' ').map(Number);
    if (Number.isFinite(offset) && Number.isFinite(size)) transcript = { offset, size, bytes: buffer.subarray(end + 1) };
  }
  return { sessions, transcript };
}

// Which live session belongs to this terminal. One followed already stays; otherwise the only one, or the only one whose folder
// name is on this terminal's screen. Anything else is ambiguous and reads nothing rather than another terminal's Claude.
export function pickSession(sessions, screen, followedPid) {
  const live = sessions.filter(session => Number.isInteger(session.pid) && uuid.test(session.sessionId ?? '') && (session.kind ?? 'interactive') === 'interactive');
  const kept = live.find(session => session.pid === followedPid);
  if (kept) return kept;
  if (live.length === 1) return live[0];
  const named = live.filter(session => { const name = path.posix.basename(String(session.cwd ?? '').replaceAll('\\', '/')); return name.length >= 3 && screen.includes(name); });
  return named.length === 1 ? named[0] : null;
}

// `busy` is a turn in progress; any other word (idle, waiting for a prompt…) is not.
export const stateOf = session => typeof session.status === 'string' ? session.status === 'busy' ? 'working' : 'idle' : null;

// Follows one terminal's remote Claude between polls. `update` takes a parsed listing and returns what to show.
export function createRemoteClaude() {
  let pid = null, sessionId = null, dir = null, cwd = null, offset = -1, requests = new Map(), value = null;
  return {
    // What the next script needs to continue the transcript.
    get request() { return { dir, sessionId, cwd, offset }; },
    update({ sessions, transcript }, screen = '') {
      const session = pickSession(sessions, screen, pid);
      if (!session) { pid = sessionId = dir = cwd = null; offset = -1; requests = new Map(); value = null; return { state: null, cache: null }; }
      if (session.sessionId !== sessionId) { requests = new Map(); value = null; offset = -1; }
      pid = session.pid; sessionId = session.sessionId; dir = session.dir; cwd = session.cwd ?? null;
      if (transcript) {
        // The script resends from `offset` unless the file shrank or the unread part is large. A tail that starts mid-file begins mid-line, and the CLI
        // may be mid-write at the end, so only whole lines count and the rest is read again next time.
        const resumed = offset >= 0 && transcript.offset === offset, data = transcript.bytes;
        const from = !resumed && transcript.offset > 0 ? data.indexOf(10) + 1 : 0, end = data.lastIndexOf(10) + 1;
        if (end > from) value = cacheFromText(data.subarray(from, end).toString('utf8'), requests, value);
        offset = transcript.offset + Math.max(end, from);
      }
      return { state: stateOf(session), cache: value };
    }
  };
}

// Runs the script on the terminal's ssh host. Rejects when ssh cannot connect without a prompt.
export function runRemote(command, script, { timeoutMs = 15_000, run = spawn } = {}) {
  const target = sshRunCommand(command);
  if (!target) return Promise.reject(new Error('ssh 명령을 해석하지 못했습니다.'));
  return new Promise((resolve, reject) => {
    const child = run(target.binary, [...target.args, 'sh', '-s'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [], err = [], timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(Buffer.concat(err).toString().trim().split(/\r?\n/).pop() || `ssh 종료 코드 ${code}`)); });
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}
