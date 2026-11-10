// Captures a real `claude -p` stream-json session into tests/fixtures/claude-stream.jsonl so chat-claude.js can be checked against it.
// It sends one prompt that makes Claude run a command (so a permission request appears) and records every stdout line.
// Run it yourself: `node scripts/record-claude-stream.mjs`. It makes one model call with your own Claude Code login.
import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import readline from 'node:readline';
import { buildClaudeArgs, userLine, approvalLine } from '../apps/local-server/src/chat-claude.js';

mkdirSync('tests/fixtures', { recursive: true });
const out = createWriteStream('tests/fixtures/claude-stream.jsonl');
const child = spawn('claude', buildClaudeArgs(), { stdio: ['pipe', 'pipe', 'inherit'] });
child.stdin.write(userLine('Run `echo hello` with the Bash tool, then say done.'));
readline.createInterface({ input: child.stdout }).on('line', line => {
  out.write(line + '\n');
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'control_request' && message.request?.subtype === 'can_use_tool') child.stdin.write(approvalLine(message.request_id, { allow: true, input: message.request.input }));
  if (message.type === 'result') { child.stdin.end(); setTimeout(() => child.kill(), 1000); }
});
child.on('exit', () => { out.end(); console.log('saved tests/fixtures/claude-stream.jsonl'); });
