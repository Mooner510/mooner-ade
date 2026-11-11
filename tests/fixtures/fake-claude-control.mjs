// Fake `claude -p` for interrupts and approvals: 'slow' runs until interrupted (the interrupt's result comes a moment after its control answer, like the
// real CLI), 'approve' asks for a tool and then crashes while the approval is open, anything else is answered at once.
import readline from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const result = (extra = {}) => send({ type: 'result', is_error: false, result: 'ok', session_id: 'control-session', total_cost_usd: 0.01, duration_ms: 5, num_turns: 1, ...extra });
send({ type: 'system', subtype: 'init', session_id: 'control-session', model: 'fake-model', permissionMode: 'default', slash_commands: [], tools: ['Bash'] });
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    setTimeout(() => result({ is_error: true, terminal_reason: 'aborted_streaming', result: '' }), 150);
    return;
  }
  if (message.type !== 'user') return;
  const text = message.message?.content?.find?.(part => part.type === 'text')?.text ?? '';
  if (text === 'slow') return;
  if (text === 'approve') {
    send({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' } });
    setTimeout(() => process.exit(1), 150);
    return;
  }
  send({ type: 'assistant', message: { id: `m${Date.now()}`, content: [{ type: 'text', text: 'ok' }] } });
  result();
});
