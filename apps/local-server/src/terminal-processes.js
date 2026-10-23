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
  // Cursor's launcher execs its bundled node with argv[0] kept as `cursor-agent` or the `agent` alias.
  if (/^cursor-agent(\.exe)?$/.test(name)) return 'cursor';
  if (name === 'agent' && args.slice(1, 3).some(arg => /(?:^|\/)cursor-agent\/versions\/[^/]+\/index\.js$/.test(arg.replace(/^['"]|['"]$/g, '').replaceAll('\\', '/')))) return 'cursor';
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
    let agent = null, agentPid = null, ssh = false;
    const seen = new Set(), queue = [pid], underAgent = new Set();
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i]; if (seen.has(next)) continue; seen.add(next);
      // Include the root: a shell may exec the CLI and retain the PTY's original PID.
      const entry = byPid.get(next);
      let isAgent = false;
      if (entry) {
        const name = executable((entry.command.match(/^"[^"]*"|^\S+/) || [''])[0]), found = agentCommand(entry.command);
        // An ssh below a local agent or git is a tool call (e.g. git over ssh), not the user's remote session.
        const parent = byPid.get(entry.ppid), transport = underAgent.has(entry.ppid) || /^git(\.exe)?$/.test(executable((parent?.command.match(/^"[^"]*"|^\S+/) || [''])[0]));
        if ((name === 'ssh' || name === 'ssh.exe') && !transport) ssh = true;
        if (!agent && found) { agent = found; agentPid = entry.pid; }
        isAgent = Boolean(found);
      }
      const nested = isAgent || underAgent.has(next);
      for (const child of children.get(next) || []) { if (nested) underAgent.add(child.pid); queue.push(child.pid); }
    }
    return { agent, agentPid, ssh };
  };
}
