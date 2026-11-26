// A fake `claude -p` whose total_cost_usd counts this process only (0.10 a turn from 0), like the real CLI when it did not restore the session's cost
// state: a fork (Rewind) or a resume in another folder (worktree enter/leave). Each answer carries a uuid so Rewind can pick it.
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const session = '0f0f0f0f-2222-4222-8333-555555555555';
send({ type: 'system', subtype: 'init', session_id: session, model: 'fake-model', permissionMode: 'default', slash_commands: [], tools: [], cwd: process.cwd() });
let turns = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type !== 'user') return;
  turns += 1;
  send({ type: 'assistant', uuid: randomUUID(), message: { id: 'm' + randomUUID(), content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } });
  send({ type: 'result', is_error: false, result: 'ok', session_id: session, total_cost_usd: Math.round(turns * 10) / 100, duration_ms: 5, num_turns: turns });
});
