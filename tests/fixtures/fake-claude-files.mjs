// Fake `claude -p` that changes files in its working folder the way a Bash tool would: "write <name> <text>" writes the file, "delete <name>" removes it.
// Each answer is one assistant message with a uuid (Branch and Rewind need it), then a result.
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
send({ type: 'system', subtype: 'init', session_id: 'files-session', model: 'fake-model', permissionMode: 'default', slash_commands: [], tools: ['Bash'] });
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type !== 'user') return;
  const said = message.message?.content?.find?.(part => part.type === 'text')?.text ?? '';
  // Give the chat's start snapshot time to read the folder first, as a real model's first tool call would.
  setTimeout(() => {
    for (const command of said.split(';').map(item => item.trim())) {
      const [verb, name, ...rest] = command.split(' ');
      if (verb === 'write') writeFileSync(path.join(process.cwd(), name), rest.join(' ') + '\n');
      if (verb === 'delete') rmSync(path.join(process.cwd(), name), { force: true });
    }
    send({ type: 'assistant', uuid: randomUUID(), message: { id: 'msg-' + randomUUID(), content: [{ type: 'text', text: `done: ${said}` }], usage: { input_tokens: 1, output_tokens: 1 } } });
    send({ type: 'result', is_error: false, result: 'done', session_id: 'files-session', total_cost_usd: 0.01, duration_ms: 5, num_turns: 1 });
  }, 1500);
});
