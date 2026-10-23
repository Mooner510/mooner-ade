import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { fault } from './files.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const quote = (value, windows = process.platform === 'win32') => `'${value.replaceAll("'", windows ? "''" : "'\"'\"'")}'`;
const folder = (directory, id) => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw fault('INVALID_INPUT', '잘못된 터미널 ID입니다.');
  return path.join(directory, 'terminal-sessions', id);
};

// Only root session starts count: tool output and child-agent spans can contain other thread IDs.
export function codexSession(log) {
  return [...log.matchAll(/^\S+\s+INFO session_loop\{thread_id=([a-f0-9-]{36})\}: codex_core::(?:session|codex): new\r?$/gm)]
    .map(match => match[1]).filter(id => uuid.test(id)).at(-1);
}

async function readCodexSession(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    let position = (await handle.stat()).size, suffix = '';
    while (position > 0) {
      const length = Math.min(position, 65536), buffer = Buffer.alloc(length);
      position -= length;
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      const chunk = buffer.subarray(0, bytesRead).toString('utf8') + suffix;
      const start = position ? chunk.indexOf('\n') + 1 : 0;
      const id = codexSession(chunk.slice(start));
      if (id) return id;
      suffix = chunk.slice(0, chunk.indexOf('\n') < 0 ? 1024 : chunk.indexOf('\n') + 1);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { await handle?.close(); }
}

export async function readTerminalSession(directory, id, agent) {
  const root = folder(directory, id);
  if (agent === 'codex') {
    const session = await readCodexSession(path.join(root, 'codex-tui.log'));
    if (session) return session;
  }
  try {
    const saved = JSON.parse(await fs.readFile(path.join(root, 'session.json'), 'utf8'));
    return saved?.agent === agent && uuid.test(saved.sessionId) ? saved.sessionId : undefined;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
}

export async function terminalAgentCommand(directory, id, agent, restoreId, shellTracksSessions = false) {
  if (!['claude', 'codex', 'cursor'].includes(agent)) throw fault('INVALID_INPUT', '잘못된 에이전트입니다.');
  // shortcut: Cursor CLI has no per-run hook or log option to learn its chat ID, so a restore opens its picker.
  if (agent === 'cursor') return restoreId === undefined ? 'cursor-agent' : 'cursor-agent --resume';
  const root = folder(directory, id);
  const sessionId = restoreId === undefined ? undefined : await readTerminalSession(directory, restoreId, agent);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (sessionId) await fs.writeFile(path.join(root, 'session.json'), JSON.stringify({ agent, sessionId }), { mode: 0o600 });
  const command = [agent, ...(restoreId === undefined ? [] : [agent === 'claude' ? '--resume' : 'resume', ...(sessionId ? [sessionId] : [])])].join(' ');
  if (shellTracksSessions) return command;
  if (agent === 'codex') {
    // shortcut: Codex's root session-start log is version-dependent; unknown IDs open the picker.
    return `${command} --no-daemon -c ${quote(`log_dir=${root}`)}`;
  }
  // Claude runs command hooks through a shell, including Git Bash on Windows.
  const hook = [process.execPath, import.meta.filename, path.join(root, 'session.json')]
    .map(value => quote(value.replaceAll('\\', '/'), false)).join(' ');
  const settings = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook }] }] } });
  const settingsFile = path.join(root, 'claude-settings.json');
  await fs.writeFile(settingsFile, settings, { mode: 0o600 });
  return `${command} --settings ${quote(settingsFile)}`;
}

// Source the user's normal startup first; these functions exist only in ADE's interactive shell.
export async function terminalSessionShell(directory, id, shell) {
  const name = path.basename(shell).toLowerCase().replace(/\.exe$/, '');
  if (!['bash', 'zsh', 'sh', 'dash', 'fish', 'powershell', 'pwsh'].includes(name)) return { args: [], env: {}, tracked: false };
  const root = folder(directory, id), windows = ['powershell', 'pwsh'].includes(name);
  const claude = await terminalAgentCommand(directory, id, 'claude');
  const codex = await terminalAgentCommand(directory, id, 'codex');
  const functions = windows
    ? [claude, codex].map(command => {
      const agent = command.split(' ')[0];
      return `function global:${agent} { & (Get-Command ${agent} -CommandType Application -ErrorAction Stop).Source ${command.slice(agent.length + 1)} @args }`;
    }).join('\n')
    : [claude, codex].map(command => name === 'fish'
      ? `function ${command.split(' ')[0]}\n command ${command} $argv\nend`
      : `\\${command.split(' ')[0]}() { command \\${command} "$@"; }`).join('\n');
  const init = path.join(root, windows ? 'init.ps1' : 'init.sh');
  if (windows) {
    await fs.writeFile(init, functions);
    return { args: ['-NoExit', '-Command', `. ${quote(init, true)}`], env: {}, tracked: true };
  }
  if (name === 'fish') {
    await fs.writeFile(init, functions);
    return { args: ['--init-command', `source ${quote(init, false)}`], env: {}, tracked: true };
  }
  if (name === 'zsh') {
    const original = process.env.ZDOTDIR || os.homedir();
    await fs.writeFile(path.join(root, '.zshenv'), `${process.env.ZDOTDIR === undefined ? 'unset ZDOTDIR' : `export ZDOTDIR=${quote(original, false)}`}\n[ ! -r ${quote(path.join(original, '.zshenv'), false)} ] || . ${quote(path.join(original, '.zshenv'), false)}\nADE_SESSION_ZDOTDIR=\${ZDOTDIR-$HOME}\nexport ZDOTDIR=${quote(root, false)}\n`);
    await fs.writeFile(path.join(root, '.zshrc'), `export ZDOTDIR="$ADE_SESSION_ZDOTDIR"\nunset ADE_SESSION_ZDOTDIR\n[ ! -r "$ZDOTDIR/.zshrc" ] || . "$ZDOTDIR/.zshrc"\n${functions}\n`);
    // A Finder-launched app has no login environment (Homebrew PATH, zsh plugins), so macOS terminals run as login shells like Terminal.app.
    const login = process.platform === 'darwin';
    if (login) await fs.writeFile(path.join(root, '.zprofile'), `[ ! -r "$ADE_SESSION_ZDOTDIR/.zprofile" ] || . "$ADE_SESSION_ZDOTDIR/.zprofile"\n`);
    return { args: login ? ['-l'] : [], env: { ZDOTDIR: root }, tracked: true };
  }
  const original = name === 'bash' ? path.join(os.homedir(), '.bashrc') : process.env.ENV;
  await fs.writeFile(init, `${original ? `[ ! -r ${quote(original, false)} ] || . ${quote(original, false)}\n` : ''}${functions}\n`);
  return name === 'bash' ? { args: ['--rcfile', init], env: {}, tracked: true } : { args: [], env: { ENV: init }, tracked: true };
}

// Claude keeps the live conversation ID of each running process in <config>/sessions/<pid>.json, so a terminal's ID
// stays exact even when the SessionStart hook never ran (e.g. a terminal that predates the hook).
export async function syncClaudeSession(directory, id, pid, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) {
  let live;
  try { live = JSON.parse(await fs.readFile(path.join(configDir, 'sessions', `${pid}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  if (live?.pid !== pid || !uuid.test(live.sessionId)) return false;
  if (await readTerminalSession(directory, id, 'claude') === live.sessionId) return false;
  const root = folder(directory, id);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await recordClaudeSession(path.join(root, 'session.json'), { hook_event_name: 'SessionStart', session_id: live.sessionId });
  return true;
}

export async function recordClaudeSession(file, event) {
  if (event.hook_event_name !== 'SessionStart' || event.agent_id || !uuid.test(event.session_id)) return;
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ agent: 'claude', sessionId: event.session_id }), { mode: 0o600 });
  await fs.rename(temporary, file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 1024 * 1024) throw new Error('Hook input too large'); }
    await recordClaudeSession(process.argv[2], JSON.parse(input));
  } catch (error) { console.error(`ADE 세션 ID 저장 실패: ${error.message}`); process.exitCode = 1; }
}
