import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { fault } from './files.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// PowerShell also ends a single-quoted string at the typographic quotes U+2018-U+201B (a path such as a user or folder name
// may hold one); any of them doubled stays literal.
const quote = (value, windows = process.platform === 'win32') => windows ? `'${value.replace(/['\u2018-\u201B]/g, '$&$&')}'` : `'${value.replaceAll("'", "'\"'\"'")}'`;
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

// A chat's conversation as the restore source of a new terminal: `terminalAgentCommand(..., restoreId)` then builds `claude --resume <session>`.
export async function seedTerminalSession(directory, id, sessionId, agent = 'claude') {
  if (!['claude', 'codex', 'cursor'].includes(agent)) throw fault('INVALID_INPUT', '잘못된 에이전트입니다.');
  if (!uuid.test(sessionId ?? '')) throw fault('INVALID_INPUT', '잘못된 세션 ID입니다.');
  const root = folder(directory, id);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, 'session.json'), JSON.stringify({ agent, sessionId }), { mode: 0o600 });
}

// MCP servers approved plugins give the agents started in ADE terminals (docs/PLUGINS.md). Set by the main process only.
let agentMcpServers = [];
const MCP_NAME = /^[a-z][a-z0-9_]{1,39}$/, TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
export const mcpServers = () => agentMcpServers;
// A `chatOnly` server (the built-in agent bus) is not given to terminals: it needs to know which chat it serves.
const terminalMcpServers = () => agentMcpServers.filter(server => !server.chatOnly);
// What a chat gets: every server, and a chatOnly one also learns its chat from ADE_CHAT_* variables (they exist nowhere else).
export const chatMcpServers = (context = {}) => agentMcpServers.map(server => server.chatOnly
  ? { ...server, env: { ADE_CHAT_ID: String(context.chatId ?? ''), ADE_PROJECT_ID: String(context.projectId ?? ''), ADE_CHAT_AGENT: String(context.agent ?? '') } } : server);
// Servers whose tools may run without a permission prompt. Only built-in plugins can ask for it (see pluginTerminal).
export const autoApprovedMcpServers = () => agentMcpServers.filter(server => server.autoApprove).map(server => server.name);
// `disabledTools` are the server's tools the user turned off in the plugin settings: Claude gets them as deny rules, Codex as disabled_tools.
export function setAgentMcpServers(servers) {
  agentMcpServers = (Array.isArray(servers) ? servers : []).filter(server => MCP_NAME.test(server?.name ?? '') && typeof server.command === 'string' && Array.isArray(server.args)
    // Codex gets these as TOML literal strings, which cannot hold a quote; such a server is left out of both agents.
    && [server.command, ...server.args].every(value => typeof value === 'string' && !value.includes("'") && !/[\0\r\n]/.test(value)))
    .map(server => ({ name: server.name, command: server.command, args: [...server.args],
      disabledTools: Array.isArray(server.disabledTools) ? server.disabledTools.filter(name => typeof name === 'string' && TOOL_NAME.test(name)) : [],
      ...(server.chatOnly === true && { chatOnly: true }), ...(server.autoApprove === true && { autoApprove: true }) }));
}
// Claude Code permission rules that keep the turned-off plugin tools away from the model.
export const deniedMcpTools = (servers = agentMcpServers) => servers.flatMap(server => (server.disabledTools ?? []).map(tool => `mcp__${server.name}__${tool}`));
// TOML literal strings ('...') so no shell, including Windows PowerShell 5.1, has to pass a double quote through.
const toml = value => `'${value.replaceAll('\\', '/')}'`;

export async function terminalAgentCommand(directory, id, agent, restoreId, shellTracksSessions = false) {
  if (!['claude', 'codex', 'cursor'].includes(agent)) throw fault('INVALID_INPUT', '잘못된 에이전트입니다.');
  // shortcut: Cursor CLI has no per-run hook or log option to learn its chat ID, so a restore opens its picker.
  if (agent === 'cursor') {
    const sessionId = restoreId === undefined ? undefined : await readTerminalSession(directory, restoreId, agent);
    return restoreId === undefined ? 'cursor-agent' : `cursor-agent --resume${sessionId ? ` ${sessionId}` : ''}`;
  }
  const root = folder(directory, id);
  const sessionId = restoreId === undefined ? undefined : await readTerminalSession(directory, restoreId, agent);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (sessionId) await fs.writeFile(path.join(root, 'session.json'), JSON.stringify({ agent, sessionId }), { mode: 0o600 });
  const command = [agent, ...(restoreId === undefined ? [] : [agent === 'claude' ? '--resume' : 'resume', ...(sessionId ? [sessionId] : [])])].join(' ');
  if (shellTracksSessions) return command;
  if (agent === 'codex') {
    // shortcut: Codex's root session-start log is version-dependent; unknown IDs open the picker.
    const mcp = terminalMcpServers().flatMap(server => [
      '-c', quote(`mcp_servers.${server.name}.command=${toml(server.command)}`),
      '-c', quote(`mcp_servers.${server.name}.args=[${server.args.map(toml).join(',')}]`),
      ...(server.disabledTools.length ? ['-c', quote(`mcp_servers.${server.name}.disabled_tools=[${server.disabledTools.map(toml).join(',')}]`)] : [])
    ]);
    return [command, '--no-daemon', '-c', quote(`log_dir=${root}`), ...mcp].join(' ');
  }
  // Claude runs command hooks through a shell, including Git Bash on Windows.
  const hook = [process.execPath, import.meta.filename, path.join(root, 'session.json')]
    .map(value => quote(value.replaceAll('\\', '/'), false)).join(' ');
  const denied = deniedMcpTools();
  const settings = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook }] }] }, ...(denied.length && { permissions: { deny: denied } }) });
  const settingsFile = path.join(root, 'claude-settings.json');
  await fs.writeFile(settingsFile, settings, { mode: 0o600 });
  if (!terminalMcpServers().length) return `${command} --settings ${quote(settingsFile)}`;
  // --mcp-config adds to the user's own MCP servers.
  const mcpFile = path.join(root, 'claude-mcp.json');
  const servers = Object.fromEntries(terminalMcpServers().map(server => [server.name, { type: 'stdio', command: server.command, args: server.args }]));
  await fs.writeFile(mcpFile, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  return `${command} --settings ${quote(settingsFile)} --mcp-config ${quote(mcpFile)}`;
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
      : name === 'zsh' ? `\\${command.split(' ')[0]}() { command \\${command} "$@"; }`
      // bash and POSIX sh reject `\\name()`; drop a user alias first (on its own line, since aliases expand when a line is parsed).
      : `unalias ${command.split(' ')[0]} 2>/dev/null\n${command.split(' ')[0]}() { command \\${command} "$@"; }`).join('\n');
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
