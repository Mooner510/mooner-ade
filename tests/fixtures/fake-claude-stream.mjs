// Minimal fake `claude -p` stream-json child: prints init, then answers every user line with one text message and a result.
import readline from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
send({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake-model', permissionMode: 'default', slash_commands: ['compact'], tools: ['Bash'] });
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'control_request' && message.request?.subtype === 'set_permission_mode') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { permissionMode: message.request.mode } } });
    return;
  }
  // The CLI hands a question to its host as a can_use_tool request and continues once the host's control_response comes back.
  if (message.type === 'control_response') {
    const reply = message.response?.response ?? {};
    send({ type: 'assistant', message: { id: 'ask-reply-' + Date.now(), content: [{ type: 'text', text: reply.behavior === 'allow' ? 'answers=' + JSON.stringify(reply.updatedInput?.answers) : 'denied: ' + reply.message }], usage: { input_tokens: 1, output_tokens: 1 } } });
    send({ type: 'result', is_error: false, result: 'asked', session_id: 'fake-session', total_cost_usd: 0.01, duration_ms: 5, num_turns: 1 });
    return;
  }
  if (message.type !== 'user') return;
  if (message.message?.content?.some(part => part.text === 'ask')) {
    send({ type: 'control_request', request_id: 'ask-' + Date.now(), request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q', input: { questions: [{ question: '고르세요', header: '선택', multiSelect: false, options: [{ label: 'A', description: '첫째' }, { label: 'B', description: '둘째' }] }] } } });
    return;
  }
  // Background sub-agents: the main turn ends with a result, the sub-agent keeps working, then its hand-back opens another turn (as the real CLI does).
  if (message.message?.content?.some(part => part.text === 'background')) {
    const sub = (id, content) => send({ type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { id, content, usage: { input_tokens: 1, output_tokens: 1 } } });
    send({ type: 'assistant', message: { id: 'main1', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } } });
    send({ type: 'result', is_error: false, result: 'waiting', session_id: 'fake-session', total_cost_usd: 0.01, duration_ms: 5, num_turns: 1 });
    setTimeout(() => { sub('sub1', [{ type: 'tool_use', id: 'toolu_sub', name: 'Bash', input: {} }]); send({ type: 'stream_event', parent_tool_use_id: 'toolu_agent', event: { type: 'message_start', message: { id: 'sub2' } } }); }, 150);
    setTimeout(() => send({ type: 'user', parent_tool_use_id: 'toolu_agent', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sub', content: 'done' }] } }), 300);
    setTimeout(() => { send({ type: 'assistant', message: { id: 'main2', content: [{ type: 'text', text: 'all done' }], usage: { input_tokens: 1, output_tokens: 1 } } }); send({ type: 'result', is_error: false, result: 'all done', session_id: 'fake-session', total_cost_usd: 0.02, duration_ms: 5, num_turns: 1 }); }, 450);
    return;
  }
  send({ type: 'assistant', message: { id: `m${Date.now()}`, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } });
  send({ type: 'ai-title', aiTitle: 'AI가 붙인 제목' });
  send({ type: 'result', is_error: false, result: 'ok', session_id: 'fake-session', total_cost_usd: 0.01, duration_ms: 5, num_turns: 1 });
});
