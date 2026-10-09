// Minimal fake `codex app-server`: JSON-RPC over stdio, one approval round-trip per turn.
import readline from 'node:readline';
const noLogin = process.argv.includes('nologin');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === 100) { // our approval request was answered
    send({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: `decision=${message.result.decision}` } });
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    return;
  }
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'model/list') {
    const second = message.params?.cursor === 'p2';
    send({ id: message.id, result: second
      ? { data: [{ id: 'b', hidden: false, supportedReasoningEfforts: [] }], nextCursor: null }
      : { data: [{ id: 'a', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }, { id: 'h', hidden: true }], nextCursor: 'p2' } });
  }
  else if (message.method === 'account/read') send({ id: message.id, result: { account: noLogin ? null : { type: 'chatgpt' } } });
  else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: message.params.threadId || 't1' } } });
    send({ method: 'test/params', params: { method: message.method, ...message.params } });
  } else if (message.method === 'turn/start') {
    send({ id: message.id, result: {} });
    send({ id: 100, method: 'item/commandExecution/requestApproval', params: { itemId: 'i1', command: 'ls' } });
  }
});
