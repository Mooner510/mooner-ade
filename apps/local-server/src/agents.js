import { spawn } from 'node:child_process';

// Codex has no CLI auth-status command, so ask its app server for the account over JSON-RPC (initialize + account/read, no model call).
export function codexAuthenticated(cwd, [command, ...args] = ['codex', 'app-server']) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill();
      const force = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
      force.unref();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex account check timed out')), 30000);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.stdin.on('error', finish);
    child.once('error', finish);
    child.once('exit', () => finish(new Error('Codex App Server connection closed')));
    // Drain stderr without persisting provider diagnostics that may contain credentials.
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) return finish(new Error('Codex message limit exceeded'));
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch (error) { return finish(error); }
        if (message.error) return finish(new Error(message.error.message));
        if (message.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'account/read', params: {} }); }
        else if (message.id === 2) finish(null, Boolean(message.result?.account));
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mooner_ade', title: 'Mooner ADE', version: '0.1.0' } } });
  });
}
