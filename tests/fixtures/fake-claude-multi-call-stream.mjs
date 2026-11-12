// Fake claude child whose one turn makes two API calls (a tool loop): live tokens must never go backwards.
import readline from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
send({ type: 'system', subtype: 'init', session_id: 'multi-session', model: 'fake-model', permissionMode: 'default', slash_commands: [], tools: [] });
const later = () => new Promise(resolve => setTimeout(resolve, 200)); // past the 150ms publish window
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type !== 'user') return;
  for (const [id, input, output] of [['m-1', 100, 20], ['m-2', 150, 30]]) {
    send({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: input, output_tokens: 1 } } } }); await later();
    send({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: output } } }); await later();
    send({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: input, output_tokens: output } } });
  }
  send({ type: 'result', is_error: false, result: 'ok', session_id: 'multi-session', total_cost_usd: 0.01, duration_ms: 8, num_turns: 2, usage: { input_tokens: 250, output_tokens: 50 } });
});
