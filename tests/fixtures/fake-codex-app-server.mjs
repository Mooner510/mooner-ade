// Minimal fake `codex app-server`: JSON-RPC over stdio, enough for the readiness account check.
import readline from 'node:readline';
const noLogin = process.argv.includes('nologin');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'account/read') send({ id: message.id, result: { account: noLogin ? null : { type: 'chatgpt' } } });
  else if (message.id !== undefined) send({ id: message.id, error: { message: `unknown method ${message.method}` } });
});
