// Minimal fake `claude -p` stream-json child: prints init, then answers every user line with one text message and a result.
import readline from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
send({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake-model', permissionMode: 'default', slash_commands: ['compact'], tools: ['Bash'] });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type !== 'user') return;
  send({ type: 'assistant', message: { id: `m${Date.now()}`, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } });
  send({ type: 'result', is_error: false, result: 'ok', session_id: 'fake-session', total_cost_usd: 0.01, duration_ms: 5, num_turns: 1 });
});
