import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ssh options that take a value; the ones an upload must not repeat (forwards, logs, control commands) are dropped.
const WITH_VALUE = new Set('BbcDEeFIiJLlmOoPpQRSWw'), DROP_VALUE = new Set('DEeLOPQRWw');
// sftp has its own letters for some ssh options (-P is its port, -l its bandwidth limit), so those go through -o.
const AS_OPTION = { b: 'BindAddress', B: 'BindInterface', I: 'PKCS11Provider', l: 'User', m: 'MACs', S: 'ControlPath' };
// The only flags sftp shares with ssh; the rest (tty, background, X11, agent forwarding…) mean nothing to an upload.
const KEEP_FLAG = new Set('46Cqv');

const unquote = value => value.replace(/^"(.*)"$|^'(.*)'$/s, (_, a, b) => a ?? b);

// Turns the command line of the terminal's ssh client into an sftp invocation of the same host: the sftp next to that ssh binary,
// with its identity, port, jump hosts and config, but no remote command, forwards or prompts. sftp needs no remote shell, so the
// upload works the same on POSIX hosts and on Windows OpenSSH (whose login shell is cmd or PowerShell).
export function sshUploadCommand(command) {
  const tokens = (command.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(unquote);
  const [binary, ...rest] = tokens, kept = [];
  let destination = null;
  for (let i = 0; i < rest.length && !destination; i++) {
    const token = rest[i];
    if (token === '--') { destination = rest[i + 1] || null; break; }
    if (!token.startsWith('-') || token === '-') { destination = token; break; }
    for (let j = 1; j < token.length; j++) {
      const flag = token[j];
      if (WITH_VALUE.has(flag)) {
        const value = token.length > j + 1 ? token.slice(j + 1) : rest[++i];
        if (value === undefined) return null;
        if (flag === 'p') kept.push('-P', value);
        else if (AS_OPTION[flag]) kept.push('-o', `${AS_OPTION[flag]}=${value}`);
        else if (!DROP_VALUE.has(flag)) kept.push(`-${flag}`, value);
        break;
      }
      if (KEEP_FLAG.has(flag)) kept.push(`-${flag}`);
    }
  }
  if (!binary || !destination) return null;
  const name = path.basename(binary.replaceAll('\\', '/')), sftp = /^ssh(\.exe)?$/i.test(name) && name !== binary
    ? binary.slice(0, -name.length) + name.replace(/^ssh/i, 'sftp') : 'sftp';
  // ssh keeps the first value it reads for an option, so these win over the user's flags and ssh_config.
  const overrides = ['BatchMode=yes', 'ConnectTimeout=10', 'RemoteCommand=none', 'RequestTTY=no', 'ClearAllForwardings=yes', 'ControlMaster=no', 'ForwardX11=no', 'PermitLocalCommand=no', 'LogLevel=ERROR'];
  return { binary: sftp, args: [...overrides.flatMap(option => ['-o', option]), ...kept, '-b', '-', destination.replace(/^ssh:\/\//, 'sftp://')] };
}

// The folder is created under the remote home (sftp starts there); `pwd` reports the home so the absolute path can be typed.
// Windows OpenSSH reports it as /C:/Users/…, which becomes C:\Users\… for a native CLI there.
function remotePath(output, name) {
  const home = /^Remote working directory: (.+?)\s*$/m.exec(output)?.[1];
  if (!home) return null;
  const file = `${home.replace(/\/$/, '')}/.mooner-ade-paste/${name}`;
  return /^\/[A-Za-z]:/.test(file) ? { path: file.slice(1).replaceAll('/', '\\'), windows: true } : { path: file, windows: false };
}

// Copies a pasted file into the remote home through sftp and returns its remote path. Needs non-interactive authentication:
// a key, an agent or a shared ControlMaster connection.
export async function uploadOverSsh(command, bytes, name, { timeoutMs = 30_000, run = spawn } = {}) {
  const upload = sshUploadCommand(command);
  if (!upload) throw new Error('ssh 명령을 해석하지 못했습니다.');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mooner-ade-upload-')), local = path.join(dir, name);
  try {
    await fs.writeFile(local, bytes);
    // sftp batch commands treat a backslash as an escape; forward slashes work for Windows paths too. A leading - ignores the
    // error when the folder already exists.
    const batch = `-mkdir .mooner-ade-paste\nput "${local.replaceAll('\\', '/')}" ".mooner-ade-paste/${name}"\npwd\n`;
    const output = await new Promise((resolve, reject) => {
      const child = run(upload.binary, upload.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim().split(/\r?\n/).pop() || `sftp 종료 코드 ${code}`));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(batch);
    });
    const remote = remotePath(output, name);
    if (!remote) throw new Error('원격 경로를 확인하지 못했습니다.');
    return remote;
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
