// Fake claude child for the idle auto-compact tests: it leaves Claude Code's own transcript lines (a request, its response with the cache usage, and a
// compact_boundary after a /compact) under $CLAUDE_CONFIG_DIR/projects/, so the chat reads a prompt cache clock from it.
// Env: FAKE_TTL (300|3600, default 3600), FAKE_TOKENS (context size, default 250000), FAKE_AGE_SEC (how long ago the request started), FAKE_COMPACTED=1 (a boundary right
// after the request), FAKE_COST (turn cost), FAKE_SLOW_MS (how long `slow` lasts). Words: `slow` holds the turn, `ask` leaves an approval waiting.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const SID = '5a1f0c2e-7b3d-4e8a-9c41-0d2b6f8a1e33';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const init = { type: 'system', subtype: 'init', session_id: SID, model: 'claude-opus-5-5', permissionMode: 'default', slash_commands: ['compact'], tools: [] };
const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), `${SID}.jsonl`);
const write = lines => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, lines.map(line => JSON.stringify(line) + '\n').join('')); };
const iso = time => new Date(time).toISOString();
send(init);
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type !== 'user') return;
  const text = message.message?.content?.find?.(part => part.type === 'text')?.text ?? '';
  if (message.uuid) send({ type: 'user', uuid: message.uuid, isReplay: true, message: message.message });
  if (text === '/compact') {
    write([{ type: 'system', subtype: 'compact_boundary', timestamp: iso(Date.now()), compactMetadata: { trigger: 'manual', preTokens: 250000, postTokens: 12000 } }]);
    send({ type: 'system', subtype: 'status', status: 'compacting', session_id: SID });
    send({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: SID });
    send(init);
    send({ type: 'system', subtype: 'compact_boundary', session_id: SID, compact_metadata: { trigger: 'manual', pre_tokens: 250000, post_tokens: 12000 } });
    send({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, session_id: SID, isReplay: true, uuid: `echo${Date.now()}` });
    send({ type: 'result', is_error: false, result: '', local_command: 'compact', user_message_uuid: message.uuid, session_id: SID, total_cost_usd: 0.01, duration_ms: 9, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    return;
  }
  const ttl = Number(process.env.FAKE_TTL || 3600), tokens = Number(process.env.FAKE_TOKENS || 250000), at = Date.now() - Number(process.env.FAKE_AGE_SEC || 0) * 1000, ref = `req_${Date.now()}`;
  write([{ type: 'api-request', id: ref, timestamp: iso(at) }, { type: 'assistant', timestamp: iso(at + 500), requestRef: ref, promptCacheRequested: ttl === 3600 ? '1h' : '5m',
    message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 10, ...(ttl === 3600 && { cache_creation: { ephemeral_1h_input_tokens: 1 } }) }, content: [{ type: 'text', text: 'ok' }] } },
    ...(process.env.FAKE_COMPACTED ? [{ type: 'system', subtype: 'compact_boundary', timestamp: iso(at + 1000), compactMetadata: { trigger: 'auto', preTokens: tokens, postTokens: 12000 } }] : [])]);
  send({ type: 'assistant', message: { id: `m${Date.now()}`, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, output_tokens: 20 } } });
  if (text === 'ask') { send({ type: 'control_request', request_id: `perm-${Date.now()}`, request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'toolu_perm', input: { command: 'npm test' } } }); return; }
  if (text === 'slow') await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_SLOW_MS || 3000)));
  send({ type: 'result', is_error: false, result: 'ok', session_id: SID, total_cost_usd: Number(process.env.FAKE_COST || 0.01), duration_ms: 5, num_turns: 1, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: tokens - 10 } });
});
