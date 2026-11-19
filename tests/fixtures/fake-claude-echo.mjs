// Fake `claude -p` that answers every user line with the exact text it was given.
import readline from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
send({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake-model', permissionMode: 'default', slash_commands: ['compact'], tools: [] });
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type !== 'user') return;
  const said = message.message?.content?.find?.(part => part.type === 'text')?.text ?? '';
  send({ type: 'assistant', message: { id: 'echo-' + Date.now(), content: [{ type: 'text', text: said }], usage: { input_tokens: 1, output_tokens: 1 } } });
  send({ type: 'result', is_error: false, result: said, session_id: 'fake-session', total_cost_usd: 0.01, duration_ms: 5, num_turns: 1 });
});
