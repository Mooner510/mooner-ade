#!/usr/bin/env node
// Cursor ACP cannot leave a single MCP tool out, so a server with tools turned off is started through this filter.
// It speaks newline-delimited JSON-RPC, the same stdio transport ADE's own MCP servers use, and forwards everything else unchanged.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

export const hiddenToolNames = (value = process.env.ADE_MCP_HIDE) => new Set(String(value ?? '').split('\n').map(name => name.trim()).filter(Boolean));

// A tools/list answer loses the hidden names. The id is remembered from the matching request.
export function rewriteServerMessage(message, hidden, pendingLists) {
  if (!message || typeof message !== 'object' || message.id == null || !pendingLists.has(message.id)) return message;
  pendingLists.delete(message.id);
  if (!Array.isArray(message.result?.tools)) return message;
  return { ...message, result: { ...message.result, tools: message.result.tools.filter(tool => !hidden.has(tool?.name)) } };
}

// A call to a hidden tool is answered here and is not forwarded. A tools/list request is remembered so its answer can be trimmed.
export function rewriteClientMessage(message, hidden) {
  if (message?.method === 'tools/call' && hidden.has(message.params?.name)) {
    return { forward: null, reply: { jsonrpc: '2.0', id: message.id ?? null, result: { isError: true, content: [{ type: 'text', text: '이 도구는 설정에서 꺼져 있습니다.' }] } } };
  }
  return { forward: message, reply: null, listId: message?.method === 'tools/list' && message.id != null ? message.id : null };
}

export function startMcpFilter({ command, args = [], env = process.env, hidden = hiddenToolNames(env.ADE_MCP_HIDE), input = process.stdin, output = process.stdout, spawnProcess = spawn }) {
  const childEnv = { ...env };
  delete childEnv.ADE_MCP_HIDE;
  const child = spawnProcess(command, args, { env: childEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const pendingLists = new Set();
  const writeOut = line => output.write(`${line}\n`);
  const writeChild = line => child.stdin.write(`${line}\n`);
  const take = (chunk, decoder, onLine) => {
    let buffer = '';
    return data => {
      buffer += decoder.write(data);
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at).replace(/\r$/, '');
        buffer = buffer.slice(at + 1);
        if (line) onLine(line);
      }
    };
  };
  const fromClient = take(null, new StringDecoder('utf8'), line => {
    let message;
    try { message = JSON.parse(line); } catch { writeChild(line); return; }
    const next = rewriteClientMessage(message, hidden);
    if (next.listId != null) pendingLists.add(next.listId);
    if (next.reply) writeOut(JSON.stringify(next.reply));
    else writeChild(JSON.stringify(next.forward));
  });
  const fromServer = take(null, new StringDecoder('utf8'), line => {
    let message;
    try { message = JSON.parse(line); } catch { writeOut(line); return; }
    writeOut(JSON.stringify(rewriteServerMessage(message, hidden, pendingLists)));
  });
  input.on('data', fromClient);
  child.stdout.on('data', fromServer);
  input.on('end', () => child.stdin.end());
  return child;
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) { process.stderr.write('usage: mcp-filter.js <command> [args...]\n'); process.exit(2); }
  const child = startMcpFilter({ command, args });
  child.once('exit', code => process.exit(code ?? 0));
  child.once('error', () => process.exit(1));
}
