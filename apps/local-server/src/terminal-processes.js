const executable = value => value.replace(/^['"]|['"]$/g, '').split(/[\\/]/).pop().toLowerCase();

export function parseProcessTable(output) {
  return output.split(/\r?\n/).flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

function agentCommand(command) {
  const args = command.match(/"[^"]*"|'[^']*'|\S+/g) || [], name = executable(args[0] || '');
  if (/^(claude|codex)(\.exe)?$/.test(name)) return name.split('.')[0];
  // npm installations run the CLI script through node; prompt arguments are never agent evidence.
  if (!/^(node|nodejs|bun)(\.exe)?$/.test(name)) return null;
  const script = (args[1] || '').replace(/^['"]|['"]$/g, '').replaceAll('\\', '/');
  if (/(?:^|\/)@anthropic-ai\/claude-code\/(?:cli\.js|[^/]+\/claude\.exe)$/.test(script)) return 'claude';
  if (/(?:^|\/)@openai\/codex\/bin\/codex\.js$/.test(script)) return 'codex';
  return null;
}

export function terminalProcesses(table) {
  const children = new Map(), byPid = new Map(table.map(entry => [entry.pid, entry]));
  for (const entry of table) children.set(entry.ppid, [...(children.get(entry.ppid) || []), entry]);
  return pid => {
    let agent = null, ssh = false;
    const seen = new Set(), queue = [pid];
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i]; if (seen.has(next)) continue; seen.add(next);
      // Include the root: a shell may exec the CLI and retain the PTY's original PID.
      const entry = byPid.get(next);
      if (entry) {
        const name = executable((entry.command.match(/^"[^"]*"|^\S+/) || [''])[0]);
        ssh ||= name === 'ssh' || name === 'ssh.exe';
        agent ||= agentCommand(entry.command);
      }
      for (const child of children.get(next) || []) queue.push(child.pid);
    }
    return { agent, ssh };
  };
}
