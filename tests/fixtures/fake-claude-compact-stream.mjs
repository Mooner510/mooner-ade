// Fake claude child: a normal turn fills the context; `/compact` answers like the real CLI did (status, init again, boundary, summary, stdout echo, empty result).
import readline from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const init = { type: 'system', subtype: 'init', session_id: 'compact-session', model: 'fake-model', permissionMode: 'default', slash_commands: ['compact'], tools: [] };
send(init);
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type !== 'user') return;
  const text = message.message?.content?.find?.(part => part.type === 'text')?.text ?? '';
  if (text === '/compact') {
    send({ type: 'system', subtype: 'status', status: 'compacting', session_id: 'compact-session' });
    send({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: 'compact-session' });
    send(init);
    send({ type: 'system', subtype: 'compact_boundary', session_id: 'compact-session', compact_metadata: { trigger: 'manual', pre_tokens: 231097, post_tokens: 14613 } });
    send({ type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation...' }, session_id: 'compact-session' });
    send({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, session_id: 'compact-session', isReplay: true, uuid: 'echo' });
    send({ type: 'result', is_error: false, result: '', local_command: 'compact', session_id: 'compact-session', total_cost_usd: 0.01, duration_ms: 9, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    return;
  }
  send({ type: 'assistant', message: { id: `m${Date.now()}`, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 200000, cache_read_input_tokens: 31000, output_tokens: 97 } } });
  send({ type: 'result', is_error: false, result: 'ok', session_id: 'compact-session', total_cost_usd: 0.02, duration_ms: 5, num_turns: 1, usage: { input_tokens: 200000, output_tokens: 97 } });
});
