// Fake `claude -p` for interrupts and approvals: 'slow' runs until interrupted (the interrupt's result comes a moment after its control answer, like the
// real CLI), 'approve' asks for a tool and then crashes while the approval is open, anything else is answered at once.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const sessionId = process.env.ADE_TEST_CLAUDE_SESSION ?? 'control-session';
const result = (extra = {}) => send({ type: 'result', is_error: false, result: 'ok', session_id: sessionId, total_cost_usd: 0.01, duration_ms: 5, num_turns: 1, ...extra });
send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', permissionMode: 'default', slash_commands: [], tools: ['Bash'], ...(process.env.ADE_TEST_REPORT_CWD && { cwd: process.env.ADE_TEST_REPORT_CWD }) });
let running = false, askx = 0, allow = [], mcpAnswer = 'grants'; // allow: the permissions.allow the host put into the flag settings
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
    if (process.env.ADE_TEST_INTERRUPT_LOG) appendFileSync(process.env.ADE_TEST_INTERRUPT_LOG, JSON.stringify(message.request) + '\n');
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    setTimeout(() => { running = false; result({ is_error: true, terminal_reason: 'aborted_streaming', result: '' }); }, 150);
    return;
  }
  if (message.type === 'control_request' && message.request?.subtype === 'cancel_async_message') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { cancelled: true } } });
    return;
  }
  if (message.type === 'control_request' && message.request?.subtype === 'stop_task') { // the CLI reports the stopped task itself, after its control reply
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    send({ type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_bg', task_id: message.request.task_id, status: 'stopped', session_id: 'control-session' });
    return;
  }
  if (message.type === 'control_request' && message.request?.subtype === 'apply_flag_settings') {
    allow = message.request.settings?.permissions?.allow ?? allow;
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    return;
  }
  if (message.type === 'control_response' && String(message.response?.request_id).startsWith('req-x')) { // the answer to 'askx:': decision and what the host asked the CLI to remember
    send({ type: 'assistant', message: { id: `m${Date.now()}`, content: [{ type: 'text', text: `x=${message.response.response?.behavior} grants=${JSON.stringify(message.response.response?.updatedPermissions ?? [])}` }] } });
    result();
    return;
  }
  if (message.type === 'control_response' && message.response?.request_id === 'req-mcp' && mcpAnswer === 'grants') { // the host's answer to 'askmcp': what it asked the CLI to remember
    send({ type: 'assistant', message: { id: `m${Date.now()}`, content: [{ type: 'text', text: `grants=${JSON.stringify(message.response.response?.updatedPermissions ?? [])}` }] } });
    result();
    return;
  }
  if (message.type === 'control_response') { // the host's answer to a can_use_tool request: what it decided is the next assistant text
    const answer = message.response?.response;
    send({ type: 'assistant', message: { id: `a${Date.now()}`, content: [{ type: 'text', text: `${message.response?.request_id}=${answer?.behavior}` }] } });
    result();
    return;
  }
  if (message.type !== 'user') return;
  if (message.uuid && running) return; // a steering line is held behind the running turn
  if (message.uuid) send({ type: 'user', uuid: message.uuid, isReplay: true, message: message.message });
  const text = message.message?.content?.find?.(part => part.type === 'text')?.text ?? '';
  if (text === 'peer-messages' && process.env.ADE_TEST_PEER_TRANSCRIPT) {
    const timestamp = new Date().toISOString();
    const live = { type: 'user', uuid: 'a0000000-0000-4000-8000-000000000001', timestamp, origin: { kind: 'peer', from: 'uds:/tmp/live.sock', name: 'wave-3e', body: '테스트를 재실행했어요.' }, message: { role: 'user', content: 'wrapped message' } };
    const fileOnly = { type: 'user', uuid: 'a0000000-0000-4000-8000-000000000002', timestamp, message: { role: 'user', content: 'Another Claude session sent a message while you were working:\n<cross-session-message from="uds:/tmp/file.sock" from-name="wave-ac">\n남은 검수를 이어서 실행했어요.\n</cross-session-message>' } };
    send({ ...live, isReplay: true });
    appendFileSync(process.env.ADE_TEST_PEER_TRANSCRIPT, [live, fileOnly].map(row => JSON.stringify(row) + '\n').join(''));
    send({ type: 'assistant', uuid: 'a0000000-0000-4000-8000-000000000003', message: { id: 'peer-reply', content: [{ type: 'text', text: '두 세션의 답을 받았습니다.' }] } });
    result();
    return;
  }
  if (text.endsWith('whereami')) { send({ type: 'assistant', message: { id: `m${Date.now()}`, content: [{ type: 'text', text: `cwd=${process.cwd()}|note=${text.startsWith('[ADE]')}` }] } }); result(); return; }
  if (text === 'slow') { running = true; return; }
  if (text === 'bgtask') { // a background subagent that outlives its turn: it ends only by stop_task (or with the child)
    send({ type: 'system', subtype: 'task_started', tool_use_id: 'toolu_bg', task_id: 'task-bg', description: 'long', subagent_type: 'general-purpose', is_backgrounded: true, session_id: 'control-session' });
  }
  if (text === 'blocked' || text === 'blockedcompound') { // auto mode refuses the call: only the error result's text says so
    const command = text === 'blocked' ? 'git push origin main' : 'git push && echo done';
    send({ type: 'assistant', message: { id: 'm-blocked', content: [{ type: 'tool_use', id: 'toolu_blk', name: 'Bash', input: { command } }] } });
    send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_blk', is_error: true, content: "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Merge Without Review]. If you have other tasks that don't depend on this action, continue working on those." }] } });
    send({ type: 'assistant', message: { id: 'm-blocked-2', content: [{ type: 'text', text: 'blocked' }] } });
    result();
    return;
  }
  if (text.includes('다시 실행해')) { send({ type: 'assistant', message: { id: `m${Date.now()}`, content: [{ type: 'text', text: `allow=${JSON.stringify(allow)}` }] } }); result(); return; }
  if (text.startsWith('askx:')) { // server_exec-like MCP tool whose input differs every time, with the CLI's own session-rule suggestion; the CLI here never honours an allow rule (an `ask` rule in settings beats it)
    send({ type: 'control_request', request_id: `req-x${++askx}`, request: { subtype: 'can_use_tool', tool_name: 'mcp__mooner_server__server_exec', input: { command: text.slice(5) }, tool_use_id: `toolu_x${askx}`,
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'mcp__mooner_server__server_exec' }], behavior: 'allow', destination: 'session' }] } });
    return;
  }
  if (text === 'limits') { // the CLI reports a plan limit whenever its rounded share moves: 91% twice, then 96%, and a plain allowed report that is not worth a line
    const limit = (status, utilization) => send({ type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: 'five_hour', utilization, surpassedThreshold: status === 'allowed' ? undefined : 0.9, resetsAt: 1794808800 } });
    limit('allowed', 0.2); limit('allowed_warning', 0.91); limit('allowed_warning', 0.91); limit('allowed_warning', 0.96);
    send({ type: 'assistant', message: { id: `m${Date.now()}`, content: [{ type: 'text', text: 'ok' }] } }); result(); return;
  }
  if (text === 'askmcp') { // an MCP tool the CLI offers no suggestions for
    mcpAnswer = 'grants';
    send({ type: 'control_request', request_id: 'req-mcp', request: { subtype: 'can_use_tool', tool_name: 'mcp__srv__run', input: { command: 'x' }, tool_use_id: 'toolu_mcp' } });
    return;
  }
  if (text === 'bypass') { send({ type: 'system', subtype: 'status', permissionMode: 'bypassPermissions', session_id: 'control-session' }); result(); return; }
  if (text === 'mcpask') { mcpAnswer = 'behavior'; send({ type: 'control_request', request_id: 'req-mcp', request: { subtype: 'can_use_tool', tool_name: 'mcp__srv__tool', input: { a: 1 }, tool_use_id: 'toolu_m' } }); return; }
  if (text === 'plainask') { send({ type: 'control_request', request_id: 'req-ask', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q', input: { questions: [{ question: '고르세요', header: '선택', multiSelect: false, options: [{ label: 'A', description: '첫째' }, { label: 'B', description: '둘째' }] }] } } }); return; }
  if (text === 'approve') {
    send({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' } });
    setTimeout(() => process.exit(1), 150);
    return;
  }
  send({ type: 'assistant', message: { id: `m${Date.now()}`, content: [{ type: 'text', text: 'ok' }] } });
  result();
});
