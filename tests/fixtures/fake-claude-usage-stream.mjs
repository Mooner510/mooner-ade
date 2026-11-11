// Fake claude child that emits streaming usage before the final assistant + result.
import readline from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
send({ type: 'system', subtype: 'init', session_id: 'usage-session', model: 'fake-model', permissionMode: 'default', slash_commands: [], tools: [] });
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type !== 'user') return;
  send({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 80 });
  send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm-live', usage: { input_tokens: 120, output_tokens: 0 } } } });
  send({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 35 } } });
  send({ type: 'assistant', message: { id: 'm-live', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 120, output_tokens: 35 } } });
  send({ type: 'result', is_error: false, result: 'ok', session_id: 'usage-session', total_cost_usd: 0.03, duration_ms: 8, num_turns: 1, usage: { input_tokens: 120, output_tokens: 35 } });
});
